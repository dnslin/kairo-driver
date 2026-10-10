import { createHash, randomUUID } from 'node:crypto';
import type { SendOperationRecord, SendOperationStore } from '../send-operation.js';
import type { SendOutcome, SendResult } from '../types/index.js';
import type { CdpClient } from '../cdp/client.js';
import { encodeRendererPayload, RENDERER_IPC_HELPERS_SCRIPT } from './renderer-script.js';
import { DriverError } from '../utils/errors.js';

export function isCdpUnavailableBeforeSend(cdp: CdpClient): boolean {
  const getStatus = (cdp as Partial<CdpClient>).getStatus;
  return typeof getStatus === 'function' && getStatus.call(cdp) !== 'connected';
}

/** 原生历史把C/D开头作为撤回标记，并过滤C；所有新意图统一使用无C/c的稳定摘要。 */
export function createNativeMessageKey(kind: string, operationId?: string): string {
  const digest = createHash('sha256')
    .update(operationId?.trim() || `${kind}:${randomUUID()}`)
    .digest('base64url')
    .replaceAll('C', '.')
    .replaceAll('c', '~');
  return `k:op:${digest}`;
}

export function sendOperationRecordToResult(operation: SendOperationRecord): SendResult {
  const common = {
    operationId: operation.operationId,
    ...(operation.sessionId ? { sessionId: operation.sessionId } : {}),
    isPreTrigger: operation.isPreTrigger,
    verifyLatencyMs: operation.verifyLatencyMs,
    nativeCode: operation.nativeCode,
    receipt: operation.receipt,
  };
  if (operation.status === 'sent') {
    if (!operation.messageId)
      throw new DriverError(
        `发送操作 ${operation.operationId} 的sent记录缺messageId`,
        'INVALID_SEND_RECORD'
      );
    return { ...common, status: 'sent', messageId: operation.messageId };
  }
  if (operation.status === 'failed') {
    if (!operation.error)
      throw new DriverError(
        `发送操作 ${operation.operationId} 的failed记录缺error`,
        'INVALID_SEND_RECORD'
      );
    return { ...common, status: 'failed', error: operation.error };
  }
  return { ...common, status: 'unknown', ...(operation.error ? { error: operation.error } : {}) };
}

export class BridgeSendStatus {
  constructor(
    private readonly cdp: CdpClient,
    private readonly store: SendOperationStore
  ) {}

  public async getSendStatus(operationId: string): Promise<SendResult> {
    const id = operationId.trim();
    const operation = await this.store.get(id);
    if (!operation) return { operationId: id, status: 'unknown', isPreTrigger: false };
    return this.resolve(operation);
  }

  public async resolve(operation: SendOperationRecord): Promise<SendResult> {
    if (operation.status !== 'unknown') return sendOperationRecordToResult(operation);
    const target = operation.fingerprint.targetSessionId;
    const targetLoginName = operation.fingerprint.targetLoginName;
    if (!target && !targetLoginName) return sendOperationRecordToResult(operation);
    if (isCdpUnavailableBeforeSend(this.cdp))
      return {
        operationId: operation.operationId,
        status: 'unknown',
        isPreTrigger: operation.isPreTrigger,
        error: '原生发送状态查询时CDP未连接',
      };
    const nativeKey = createNativeMessageKey(
      operation.fingerprint.messageType,
      operation.operationId
    );
    const encoded = encodeRendererPayload({ nativeKey, target, targetLoginName });
    // 只读本次采集的业务证据；没有回执时，任意正ID历史也不能变成sent。
    const observation = await this.cdp.evaluate<SendOutcome | null>(
      `(async () => {
      const electron = window.require ? window.require('electron') : null;
      const ipc = window.ipcRenderer || electron?.ipcRenderer;
      ${RENDERER_IPC_HELPERS_SCRIPT}
      const data = JSON.parse(decodeURIComponent(${encoded}));
      const entry = window.__kairo_send_receipts?.get(data.nativeKey);
      if (!entry || (data.targetLoginName ? entry.targetLoginName !== data.targetLoginName : entry.receipt?.sessionId !== data.target)) return null;
      if (entry.failure) return entry.failure;
      const receipt = entry.receipt;
      if (receipt.code !== 0 || (receipt.businessCode !== undefined && receipt.businessCode !== 0)) return null;
      const sessionId = data.targetLoginName ? receipt.sessionId : data.target;
      if (!/^[1-9]\\d*$/.test(String(sessionId))) return null;
      let messageId = receipt.messageId;
      if (data.targetLoginName || !/^[1-9]\\d*$/.test(String(messageId))) {
        const response = await callKairoIpc('getMessages', { sessionID: Number(sessionId), count: 100, endIdx: 2147483647, sendTime: 0 });
        if (response?.code !== 0 || !Array.isArray(response.data)) throw new Error('getMessages状态查询失败 (' + response?.code + '): ' + (response?.error || response?.message || '无效数组'));
        const found = response.data.find(message => message.msgFlag === data.nativeKey && String(message.sessionID) === String(sessionId) && /^[1-9]\\d*$/.test(String(message.id)) &&
          (!data.targetLoginName || (String(message.id) === String(messageId) && String(message.sender) === entry.senderId && String(message.receiver) === entry.receiverId)));
        if (!found) return null;
        messageId = String(found.id);
        receipt.msgIdx = Number(found.msgIdx);
      }
      return { status: 'sent', messageId: String(messageId), ...(data.targetLoginName ? { sessionId: String(sessionId) } : {}), receipt: { ...receipt, messageId: String(messageId) }, isPreTrigger: false };
    })()`,
      6000
    );
    if (!observation) return sendOperationRecordToResult(operation);
    return sendOperationRecordToResult(await this.store.update(operation.operationId, observation));
  }
}
