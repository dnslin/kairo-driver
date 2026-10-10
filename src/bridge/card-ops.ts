import type { CdpClient } from '../cdp/client.js';
import type { KK9UrlCardOptions, KK9BizMsgOptions, KK9AppMsgOptions, KK9ChatRecordOptions, SendOptions, SendOutcome } from '../types/index.js';
import { createNativeMessageKey, isCdpUnavailableBeforeSend } from './send-status.js';
import {
  CONFIRM_SENT_MESSAGE_SCRIPT,
  encodeRendererPayload,
  RENDERER_IPC_HELPERS_SCRIPT,
  NATIVE_SEND_CONTEXT_SCRIPT,
  SUBMIT_NATIVE_MESSAGE_SCRIPT,
} from './renderer-script.js';

type NativeStructuredMessage =
  | { kind: 'voice'; contentType: 2; content: unknown }
  | { kind: 'app-message'; contentType: 8; content: unknown }
  | { kind: 'url-card'; contentType: 10; content: unknown }
  | { kind: 'chat-record'; contentType: 15; content: unknown }
  | { kind: 'biz-message'; contentType: 17; content: unknown };

/** 真实 Driver 与 Fake 共用提交前的卡片输入边界。 */
export function getCardInputError(
  kind: 'url-card' | 'biz-message' | 'app-message' | 'chat-record',
  input: KK9UrlCardOptions | KK9BizMsgOptions | KK9AppMsgOptions | KK9ChatRecordOptions
): string | undefined {
  const nonempty = (value: unknown): value is string => typeof value === 'string' && !!value.trim();
  if (kind === 'chat-record') {
    const record = input as KK9ChatRecordOptions;
    if (!/^[1-9]\d*$/.test(record.sourceSessionId) || !Number.isSafeInteger(Number(record.sourceSessionId)) ||
        !Array.isArray(record.msgArray) || record.msgArray.length === 0 || record.msgArray.some(item =>
          !/^[1-9]\d*$/.test(item.messageId) || !Number.isSafeInteger(Number(item.messageId)) ||
          !Number.isSafeInteger(item.msgIdx) || item.msgIdx <= 0)) return '合并转发需要来源原生会话ID及准确消息ID/索引';
    if (new Set(record.msgArray.map(item => item.messageId)).size !== record.msgArray.length) return '合并转发不能重复选择同一消息';
    return;
  }
  if (!('title' in input) || !nonempty(input.title)) return '卡片标题不能为空';
  if (kind === 'url-card') {
    const card = input as KK9UrlCardOptions;
    if (!nonempty(card.summary) || !nonempty(card.linkUrl)) return 'UrlCard 的 summary 与 linkUrl 不能为空';
  } else {
    const card = input as KK9BizMsgOptions | KK9AppMsgOptions;
    if (!nonempty(card.content)) return '卡片正文不能为空';
    if (kind === 'biz-message') {
      const biz = input as KK9BizMsgOptions;
      if (biz.bizType !== 1 && biz.bizType !== 2) return 'BizMsg 必须指定原生 bizType 1 或 2';
      if (!nonempty(biz.bizUrl) || !biz.bizUrl.startsWith('/') || biz.bizUrl.startsWith('//')) return 'BizMsg 的 bizUrl 必须是相对于 ekp_outer_domain 的路径';
    }
  }
  return undefined;
}

function unsupportedOptionsResult(options: SendOptions): SendOutcome | null {
  const unsupported: string[] = [];
  if (options.replyTo !== undefined) unsupported.push('replyTo');
  if (options.mentions !== undefined) unsupported.push('mentions');
  if (unsupported.length === 0) return null;

  return {
    status: 'failed',
    error: `原生卡片与语音消息不支持参数: ${unsupported.join(', ')}`,
    isPreTrigger: true,
  };
}

/**
 * 卡片与语音共用的原生结构化消息发送路径。
 * 只负责一次 native 发送；operationId 的声明、状态写入与重放由 BridgeMessageOps 统一管理。
 */
export async function sendNativeStructuredMessage(
  cdp: CdpClient,
  message: NativeStructuredMessage,
  options: SendOptions,
  nativeKey?: string
): Promise<SendOutcome> {
  const unsupported = unsupportedOptionsResult(options);
  if (unsupported) return unsupported;

  const startTime = Date.now();
  const cdpWasUnavailable = isCdpUnavailableBeforeSend(cdp);
  const payloadData = {
    target: options.targetSessionId || '',
    msgFlag: nativeKey ?? createNativeMessageKey(message.kind),
    contentType: message.contentType,
    content: message.content,
    timeout: options.verifyTimeoutMs ?? 8000,
  };
  const encoded = encodeRendererPayload(payloadData);

  const script = `
    (async () => {
      const electron = window.require ? window.require('electron') : null;
      const ipc = window.ipcRenderer || electron?.ipcRenderer;
      ${RENDERER_IPC_HELPERS_SCRIPT}
      ${NATIVE_SEND_CONTEXT_SCRIPT}
      ${CONFIRM_SENT_MESSAGE_SCRIPT}
      ${SUBMIT_NATIVE_MESSAGE_SCRIPT}
      const data = JSON.parse(decodeURIComponent(${encoded}));
      const cancellation = beginNativeSend(data.msgFlag);
      const callIpc = (channel, ...args) => callKairoIpcWithSignal(cancellation.signal, channel, ...args);
      try {
      let context;
      try { context = await readNativeSendContext(data.target); }
      catch (error) { return { status: 'failed', error: String(error), isPreTrigger: true }; }
      const { identity, session: targetSes, receiver } = context;
      const myUid = identity.id;
      const myName = identity.name;
      const sendTime = Math.floor(Date.now() / 1000);
      let messageContent = data.content;

      if (data.contentType === 15) {
        try {
          const record = data.content;
          const source = await readNativeSendContext(record.sourceSessionId);
          const msgArray = [];
          for (const ref of record.msgArray) {
            const response = await callIpc('getMessageBySessionIDAndMsgIdx', source.session.id, ref.msgIdx);
            if (response?.code !== 0) throw new Error('getMessageBySessionIDAndMsgIdx 会话 ' + record.sourceSessionId + ' 失败 (' + response?.code + '): ' + (response?.error || response?.message || ''));
            const rows = Array.isArray(response.data) ? response.data : response.data ? [response.data] : [];
            const item = rows.find(row => String(row.id) === ref.messageId && row.msgIdx === ref.msgIdx && String(row.sessionID) === record.sourceSessionId);
            if (!item || /^[CDE]/.test(String(item.msgFlag))) throw new Error('合并来源消息不存在、索引不符或已撤回: ' + ref.messageId);
            if (!Number.isSafeInteger(Number(item.sender)) || Number(item.sender) <= 0 || !item.senderName?.trim() || !Number.isFinite(Number(item.sendTime))) throw new Error('合并来源消息缺少真实作者或发送时间: ' + ref.messageId);
            const content = item.contentType === 0 ? item.content : typeof item.content === 'string' ? JSON.parse(item.content) : item.content;
            if (item.contentType === 0 ? typeof content !== 'string' : !content || typeof content !== 'object') throw new Error('合并来源消息内容无效: ' + ref.messageId);
            msgArray.push({
              id: item.id, msgIdx: item.msgIdx, senderID: item.sender,
              senderName: item.senderName,
              ...(item.senderNameEN ? { senderNameEN: item.senderNameEN } : {}),
              ...(item.senderNameTC ? { senderNameTC: item.senderNameTC } : {}),
              // 预览的 Text 分支只读 lastMessage；转为原生结构化正文供预览和详情共同消费。
              sendTime: String(item.sendTime), contentType: item.contentType === 0 ? 4 : item.contentType,
              content: item.contentType === 0 ? { content: [{ type: 0, text: content }] } : content
            });
          }
          msgArray.sort((a, b) => a.msgIdx - b.msgIdx);
          messageContent = {
            msgArray, sessionType: source.session.type, sessionID: source.session.id,
            senderID: myUid, senderName: myName,
            typeID: source.receiver, typeName: source.session.typeName || source.session.name
          };
        } catch (error) {
          return { status: 'failed', error: '合并记录准备失败: ' + String(error), isPreTrigger: true };
        }
      }

      const msgObj = {
        contentType: data.contentType,
        content: messageContent,
        sender: myUid,
        senderName: myName,
        senderNameEN: myName,
        senderNameTC: myName,
        receiver,
        sendTime,
        sessionType: targetSes.type,
        sessionID: targetSes.id,
        atState: 1,
        atMemberIDList: [],
        status: 'sending',
        type: 0,
        msgFlag: data.msgFlag
      };

      const submission = await submitNativeMessage(msgObj, targetSes, data.timeout, cancellation.signal);
      if (submission.failure) return submission.failure;
      const confirmedMessage = submission.confirmedMessage;
      // 未切换的语音仍保留原有通知；四类卡片不读取界面，也不补气泡。
      if (data.contentType === 2) {
        const app = document.querySelector('#app')?.__vue__;
        const main = document.querySelector('.main-page')?.__vue__;
        const bus = main?.$bus || app?.$bus || window.vueBus;
        const store = app?.$store || window.$store;
        try { store?.commit('updateSesLastMsg', { sesUUID: targetSes.sesUUID, message: confirmedMessage }); }
        catch { console.warn('[KairoDriver] 会话摘要更新失败'); }
        try { bus?.$emit(targetSes.sesUUID + '-msg', [confirmedMessage]); }
        catch { console.warn('[KairoDriver] 聊天窗口推送失败'); }
      }

      return { status: 'sent', messageId: String(confirmedMessage.id), receipt: submission.receipt, isPreTrigger: false };
      } finally { cancellation.finish(); }
    })()
  `;

  try {
    const result = await cdp.evaluate<SendOutcome>(
      script,
      (options.verifyTimeoutMs ?? 8000) + 12000
    );
    if (!result || !['sent', 'failed', 'unknown'].includes(result.status)) {
      return { status: 'unknown', error: '原生结构化消息未返回有效结果', isPreTrigger: false };
    }
    return { ...result, verifyLatencyMs: Date.now() - startTime };
  } catch (error) {
    return {
      status: cdpWasUnavailable ? 'failed' : 'unknown',
      error: `原生结构化消息发送异常: ${error instanceof Error ? error.message : String(error)}`,
      isPreTrigger: cdpWasUnavailable,
      verifyLatencyMs: Date.now() - startTime,
    };
  }
}
