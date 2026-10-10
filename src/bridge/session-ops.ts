import type { CdpClient } from '../cdp/client.js';
import type { KK9Session } from '../types/index.js';
import { DriverError } from '../utils/errors.js';
import { callIpcToData } from './rpc.js';

interface RawConversationData {
  sessionsInfo?: Record<string, RawSessionItem>;
  usersInfo?: Record<string, Record<string, unknown>>;
  groupsInfo?: Record<string, Record<string, unknown>>;
}

interface RawSessionItem {
  id: number | string;
  type: number; // 0: 私聊，1: 群聊，2: 讨论组，3: 服务号，其余保留原始类型
  creater: number | string;
  createrName?: string;
  typeID: number | string;
  typeName?: string;
  maxMessageIndex?: number;
  userReadIndex?: number;
  lastMessage?: string;
  lastMsgTime?: number;
  atState?: number;
}

/** 列表查询与单会话查询使用同一套原生身份和已读状态映射。 */
function toKK9Session(item: RawSessionItem, currentUserId: string | null): KK9Session {
  let lastMsg = '';
  if (item.lastMessage) {
    try {
      const rawMsg: unknown =
        typeof item.lastMessage === 'string'
          ? JSON.parse(item.lastMessage)
          : item.lastMessage;
      if (rawMsg && typeof rawMsg === 'object') {
        const record = rawMsg as Record<string, unknown>;
        if (Array.isArray(record.content)) {
          lastMsg = record.content
            .map((c: unknown) => {
              if (c && typeof c === 'object') {
                const itemObj = c as Record<string, unknown>;
                return (
                  (typeof itemObj.text === 'string' ? itemObj.text : '') ||
                  (itemObj.type === 1 ? '[图片]' : '')
                );
              }
              return '';
            })
            .filter(Boolean)
            .join('');
        } else if (typeof record.content === 'string') {
          lastMsg = record.content;
        } else if (typeof record.text === 'string') {
          lastMsg = record.text;
        } else {
          lastMsg = String(item.lastMessage);
        }
      } else {
        lastMsg = String(item.lastMessage);
      }
    } catch {
      lastMsg = String(item.lastMessage);
    }
  }

  let lastTime = '';
  if (item.lastMsgTime) {
    try {
      const ts = item.lastMsgTime < 10000000000 ? item.lastMsgTime * 1000 : item.lastMsgTime;
      lastTime = new Date(ts).toLocaleTimeString();
    } catch {
      lastTime = '';
    }
  }

  const sessionType = item.type === 0 ? 'private' : item.type === 1 ? 'group' : item.type === 2 ? 'discussion' : item.type === 3 ? 'service' : 'unknown';
  const receiverId = item.type === 0 && String(item.typeID) === currentUserId
    ? String(item.creater)
    : String(item.typeID);

  // 判定未读数与未读状态
  const maxIdx = item.maxMessageIndex ?? 0;
  const readIdx = item.userReadIndex ?? 0;
  const unreadCount = Math.max(0, maxIdx - readIdx);
  const unread = unreadCount > 0;

  // 判定未读 @ 状态 (atState > 1 表示有未读 @ 提醒)
  const unreadAt = Boolean((item.atState && item.atState > 1) || lastMsg.includes('[@有人@我]') || lastMsg.includes('[@全体成员]'));

  const sessionName = item.typeName || item.createrName || `会话_${String(item.id)}`;

  return {
    id: String(item.id),
    name: sessionName,
    type: sessionType,
    nativeType: item.type,
    receiverId,
    unread,
    unreadCount,
    unreadAt,
    lastMessage: lastMsg,
    lastMessageTime: lastTime,
  };
}

export class BridgeSessionOps {
  constructor(private readonly cdp: CdpClient) {}

  /** 无参数档案查询由主进程使用当前登录 UID。 */
  public async getCurrentUserId(): Promise<string | null> {
    const response = await callIpcToData<{ id?: number | string } | null>(this.cdp, 'getMemberDetail');
    if (response.code !== 0) {
      throw new DriverError(`getMemberDetail 失败 (${response.code}): ${response.error || response.message || ''}`, 'IPC_QUERY_FAILED');
    }
    return String(response.data?.id ?? '').trim() || null;
  }

  /** 原生会话 ID 与接收对象独立于当前窗口。 */
  public async getSessions(): Promise<KK9Session[]> {
    const currentUserId = await this.getCurrentUserId();
    const response = await callIpcToData<RawConversationData>(this.cdp, 'getConversations');
    if (response.code !== 0) {
      throw new DriverError(`getConversations 失败 (${response.code}): ${response.error || response.message || ''}`, 'IPC_QUERY_FAILED');
    }
    if (!response.data?.sessionsInfo || typeof response.data.sessionsInfo !== 'object') {
      throw new DriverError('getConversations 缺少 sessionsInfo', 'IPC_INVALID_RESPONSE');
    }
    return Object.values(response.data.sessionsInfo).map(item => toKK9Session(item, currentUserId));
  }

  /** 按原生 ID 读取会话，不受当前窗口和可见会话列表影响。 */
  public async getSessionById(sessionId: string): Promise<KK9Session | null> {
    if (!/^-?[0-9]+$/.test(sessionId) || !Number.isSafeInteger(Number(sessionId))) throw new DriverError(`原生会话 ID 无效: ${sessionId}`, 'INVALID_SESSION_ID');
    const currentUserId = await this.getCurrentUserId();
    const response = await callIpcToData<RawSessionItem | null>(this.cdp, 'getSessionBySessionID', [sessionId]);
    if (response.code !== 0) throw new DriverError(`getSessionBySessionID 会话 ${sessionId} 失败 (${response.code}): ${response.error || response.message || ''}`, 'IPC_QUERY_FAILED');
    if (!response.data) return null;
    if (String(response.data.id) !== sessionId) throw new DriverError(`getSessionBySessionID 会话 ${sessionId} 返回其他会话`, 'IPC_INVALID_RESPONSE');
    return toKK9Session(response.data, currentUserId);
  }


  /** 仅接受原生会话 ID；使用原生行的类型和最大索引，不改窗口/Vue状态。 */
  public async markSessionRead(sessionId: string): Promise<boolean> {
    const targetId = sessionId.trim();
    if (!/^[0-9]+$/.test(targetId) || !Number.isSafeInteger(Number(targetId)) || Number(targetId) <= 0) return false;
    try {
      const response = await callIpcToData<RawSessionItem | null>(this.cdp, 'getSessionBySessionID', [Number(targetId)]);
      if (response.code !== 0) throw new Error(`getSessionBySessionID 失败 (${response.code}): ${response.error || response.message || ''}`);
      if (!response.data) return false;
      const row = response.data;
      if (String(row.id) !== targetId || !Number.isInteger(row.type) || row.type < 0 || row.type > 6 ||
          !Number.isSafeInteger(row.maxMessageIndex) || row.maxMessageIndex! < 0) {
        throw new Error('getSessionBySessionID 未返回匹配的会话、真实类型或最大索引');
      }
      const read = await callIpcToData(this.cdp, 'readMessage', [{ type: row.type, sessionID: row.id, maxMsgIdx: row.maxMessageIndex }]);
      if (read.code !== 0) throw new Error(`失败 (${read.code}): ${read.error || read.message || ''}`);
      return true;
    } catch (err) {
      throw new DriverError(`readMessage 会话 ${targetId}: ${String(err)}`, 'IPC_QUERY_FAILED', err instanceof Error ? err : undefined);
    }
  }
}
