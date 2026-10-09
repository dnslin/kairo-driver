import type { CdpClient } from '../cdp/client.js';
import { DriverError } from '../utils/errors.js';
import { callIpcToData } from './rpc.js';

/** 只撤回指定原生会话中的本人消息；历史查询不产生通知。 */
export async function recallNativeMessage(
  cdp: CdpClient,
  messageId: string,
  sessionId: string
): Promise<boolean> {
  if (!/^[1-9]\d*$/.test(sessionId) || !Number.isSafeInteger(Number(sessionId)) ||
      !/^[1-9]\d*$/.test(messageId) || !Number.isSafeInteger(Number(messageId))) return false;
  let msgIdx: number | undefined;
  try {
    const sessionID = Number(sessionId);
    const session = await callIpcToData<Record<string, unknown>>(cdp, 'getSessionBySessionID', [sessionID]);
    if (session.code !== 0) {
      throw new Error(`getSessionBySessionID失败 (${session.code}): ${session.error || session.message || ''}`);
    }
    if (String(session.data?.['id']) !== sessionId) return false;
    const identity = await callIpcToData<{ id: number }>(cdp, 'getMemberDetail');
    if (identity.code !== 0 || !identity.data?.['id']) {
      throw new Error(`getMemberDetail未取得实际登录身份 (${identity.code}): ${identity.error || identity.message || ''}`);
    }

    let endIdx = 2147483647;
    let target: Record<string, unknown> | undefined;
    while (endIdx > 0) {
      const history = await callIpcToData<Array<Record<string, unknown>>>(cdp, 'getMessages', [
        { sessionID, count: 200, endIdx, sendTime: 0 },
      ]);
      if (history.code !== 0 || !Array.isArray(history.data)) {
        throw new Error(`getMessages撤回目标查询失败 (${history.code}): ${history.error || history.message || '无效数组'}`);
      }
      target = history.data.find(message => String(message['id']) === messageId &&
        String(message['sessionID']) === sessionId);
      if (target || history.data.length < 200) break;
      const nextEndIdx = Math.min(...history.data.map(message => Number(message['msgIdx']))) - 1;
      if (!Number.isSafeInteger(nextEndIdx) || nextEndIdx >= endIdx) {
        throw new Error('getMessages未取得可继续读取的原生索引');
      }
      endIdx = nextEndIdx;
    }
    if (!target) return false;
    msgIdx = Number(target['msgIdx']);
    if (!Number.isSafeInteger(msgIdx) || msgIdx <= 0) throw new Error('待撤回消息缺少准确原生索引');
    if (String(target['sender']) !== String(identity.data['id'])) return false;
    if (/^[CD]/.test(String(target['msgFlag']))) return false;

    const response = await callIpcToData(cdp, 'cancelMessage', [
      { type: 'own', sessionID, msgID: Number(target['id']), msgIdx },
    ]);
    if (response.code !== 0) {
      throw new Error(`cancelMessage原生撤回失败 (${response.code}): ${response.error || response.message || ''}`);
    }
    return true;
  } catch (error) {
    throw new DriverError(
      `原生撤回失败；会话 ${sessionId}；消息 ${messageId}；索引 ${msgIdx ?? '未取得'}：${String(error)}`,
      'RECALL_FAILED', error instanceof Error ? error : undefined
    );
  }
}
