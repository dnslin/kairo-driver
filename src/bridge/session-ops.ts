import type { CdpClient } from '../cdp/client.js';
import type { KK9Session } from '../types/index.js';
import { createChildLogger } from '../utils/logger.js';
import { DriverError } from '../utils/errors.js';
import { callIpcToData } from './rpc.js';
import {
  RENDERER_IPC_HELPERS_SCRIPT,
  RENDERER_SESSION_RESOLVER_SCRIPT,
} from './renderer-script.js';

const log = createChildLogger('bridge-session-ops');

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
      const sessions: KK9Session[] = [];
      for (const item of Object.values(response.data.sessionsInfo)) {

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

        sessions.push({
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
        });
      }

      return sessions;
  }

  /**
   * 获取当前激活会话
   */
  public async getCurrentSession(): Promise<KK9Session | null> {
    const activeId = await this.cdp.evaluate<string | null>(`
      (() => {
        const editor = document.querySelector('.chat-editor, .message-editor, .chat-sendArea')?.__vue__;
        return editor?.activedSes ? String(editor.activedSes.id) : null;
      })()
    `);
    if (!activeId) return null;
    const session = (await this.getSessions()).find(item => item.id === activeId);
    return session ? { ...session, active: true } : null;
  }

  /**
   * 切换到目标会话 (通过 Vue 状态调度 + DOM 触发)
   */
  public async selectSession(sessionId: string): Promise<boolean> {
    const targetId = sessionId.trim();
    if (!targetId) return false;

    const script = `
      (async () => {
        const target = ${JSON.stringify(targetId)};
        const app = document.querySelector('#app')?.__vue__;
        const main = document.querySelector('.main-page')?.__vue__;
        const editor = document.querySelector('.chat-editor, .message-editor, .chat-sendArea')?.__vue__;
        const bus = main?.$bus || app?.$bus;
        ${RENDERER_SESSION_RESOLVER_SCRIPT}

        const targetSession = resolveRendererSession(editor?.sortedSessions, target);
        if (!targetSession) {
          return { success: false, method: 'target_not_unique' };
        }

        const active = editor?.activedSes;
        const isActive = Boolean(
          active &&
          (
            active.sesUUID === targetSession.sesUUID ||
            String(active.id) === String(targetSession.id)
          )
        );
        if (isActive) {
          return { success: true, method: 'already_active' };
        }

        if (bus) {
          bus.$emit('session-click', targetSession);
          bus.$emit('store', { type: 'commit', method: 'saveActiveSes', payload: targetSession });
        }
        if (typeof editor?.onActivedSesChanged === 'function') {
          editor.onActivedSesChanged(targetSession);
        }
        if (!editor) {
          return { success: false, method: 'editor_unavailable' };
        }
        editor.activedSes = targetSession;
        return { success: true, method: 'vue_session_switch' };
      })()
    `;

    try {
      const res = await this.cdp.evaluate<{ success: boolean; method?: string }>(script);
      log.debug({ targetId, res }, '执行 Bridge 会话切换');
      return Boolean(res?.success);
    } catch (err) {
      log.warn({ targetId, err: String(err) }, 'Bridge 切换会话异常');
      return false;
    }
  }

  /**
   * 通过原生 IPC toData('readMessage') 消除会话未读红点（真·已读同步到多端与服务端）
   */
  public async markSessionRead(sessionId: string): Promise<boolean> {
    const targetId = sessionId.trim();
    if (!targetId) return false;

    try {
      const script = `
        (async () => {
          const target = ${JSON.stringify(targetId)};
          const editor = document.querySelector('.chat-editor, .message-editor, .chat-sendArea')?.__vue__;
          const app = document.querySelector('#app')?.__vue__;
          const main = document.querySelector('.main-page')?.__vue__;
          const bus = main?.$bus || app?.$bus;
          const electron = window.require ? window.require('electron') : null;
          const ipc = window.ipcRenderer || electron?.ipcRenderer;
          ${RENDERER_SESSION_RESOLVER_SCRIPT}
          ${RENDERER_IPC_HELPERS_SCRIPT}

          const targetSession = resolveRendererSession(editor?.sortedSessions, target);

          if (targetSession) {
            const sessionID = targetSession.id;
            const maxMsgIdx = targetSession.maxMessageIndex || 0;
            const type = targetSession.type || 0;

            const readRes = await callKairoIpc('readMessage', {
              type,
              sessionID,
              maxMsgIdx
            });

            if (!readRes || readRes.code !== 0) {
              return { success: false };
            }

            // native ack 成功后再更新客户端 Vuex 与本地状态
            targetSession.userReadIndex = maxMsgIdx;
            targetSession.atState = 0;
            if (bus) {
              bus.$emit('set-message-read', targetSession);
              bus.$emit('reload-atMsg-list');
              bus.$emit('flush-unread-total');
            }
            return { success: true };
          }

          return { success: false };
        })()
      `;

      const res = await this.cdp.evaluate<{ success: boolean }>(script, 6000);
      return Boolean(res?.success);
    } catch (err) {
      log.warn({ targetId, err: String(err) }, 'Bridge 标记已读失败');
      return false;
    }
  }
}
