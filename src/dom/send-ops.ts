import type { CdpClient } from '../cdp/client.js';
import type { PreSendCheckResult, SelectorsConfig } from '../types/index.js';
import { createChildLogger } from '../utils/logger.js';
import { VUE_SCROLLER_HELPERS_SCRIPT } from './helpers.js';
const log = createChildLogger('send-ops');

export class SendOps {
  constructor(
    private readonly cdp: CdpClient,
    private readonly selectors: SelectorsConfig
  ) {}

  /**
   * 发送前原子状态安全校验（防串线）
   */
  public async checkPreSendState(expectedSessionId: string): Promise<PreSendCheckResult> {
    const script = `
      (() => {
        ${VUE_SCROLLER_HELPERS_SCRIPT}
        const expected = ${JSON.stringify(expectedSessionId)};

        // 1. 检查当前活跃节点
        const activeItem = document.querySelector('.chat-item.chat-selected') ||
          document.querySelector('${this.selectors.activeSession}');
        const activeTitle = activeItem?.querySelector('${this.selectors.sessionTitle}')?.textContent?.trim() || '';
        const activeId = activeItem?.getAttribute('data-sesuuid') ||
          activeItem?.getAttribute('data-session-id') ||
          activeItem?.getAttribute('id') ||
          '';

        // 2. 从 Vue 会话列表唯一解析目标身份
        const scrollerItems = getVueScrollerItems('${this.selectors.virtualScroller || '.vue-recycle-scroller'}');
        const { item: matchedItem } = findVueSessionItem(scrollerItems, expected);
        if (!matchedItem) {
          return {
            canSend: false,
            reason: 'target_ambiguous_or_missing',
            details: '目标会话 [' + expected + '] 无法唯一解析',
          };
        }

        // 3. 当前 DOM 必须暴露与目标一致的原生身份，标题不能替代身份
        const expectedIds = [matchedItem.sesUUID, matchedItem.id]
          .filter(value => value !== undefined && value !== null)
          .map(value => String(value));
        const isMatch = Boolean(activeId && expectedIds.includes(String(activeId)));

        if (!isMatch) {
          return {
            canSend: false,
            reason: 'session_switched',
            details: '当前活跃会话 [' + (activeTitle || activeId || '未知') + '] 与目标会话 [' + expected + '] 不一致',
          };
        }

        return { canSend: true };
      })()
    `;
    try {
      const res = await this.cdp.evaluate<PreSendCheckResult>(script);
      if (!res) {
        return {
          canSend: false,
          reason: 'unknown',
          details: '发送前状态校验未获得有效返回结果 (Fail-Closed)',
        };
      }
      return res;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log.warn(
        { event: 'Driver运行异常', errorType: 'driver' },
        '发送前校验脚本执行异常，执行 Fail-Closed 拦截'
      );
      return {
        canSend: false,
        reason: 'unknown',
        details: `发送前状态校验异常: ${errMsg} (Fail-Closed)`,
      };
    }
  }

  public async recallMessage(messageId: string, sessionId?: string): Promise<boolean> {
    if (!messageId) return false;

    try {
      const checkScript = `
        (() => {
          const targetId = ${JSON.stringify(messageId)};
          const items = document.querySelectorAll('${this.selectors.messageItem}');
          for (let i = items.length - 1; i >= 0; i--) {
            const item = items[i];
            const vueMsg = item.__vue__?.msgitem || item.__vue__?.message;
            const rawId = vueMsg?.id || vueMsg?.msgID || item.getAttribute('id') || item.getAttribute('data-msg-id') || item.getAttribute('data-id');

            const isMe = item.matches('${this.selectors.messageIsMe}') ||
              item.classList.contains('rcd-msg-right') ||
              item.classList.contains('rcd-msg-me') ||
              item.classList.contains('is-me') ||
              item.querySelector('${this.selectors.messageIsMe}') !== null ||
              Boolean(vueMsg?.isMe) ||
              Boolean(vueMsg?.isFromSelf);

            const sender = item.querySelector('${this.selectors.messageSender}')?.textContent?.trim() || vueMsg?.senderName || '';
            const time = item.querySelector('${this.selectors.messageTime}')?.textContent?.trim() || '';
            let sendTime = 0;
            if (vueMsg && vueMsg.sendTime) {
              const n = Number(vueMsg.sendTime);
              sendTime = n < 10000000000 ? n * 1000 : n;
            } else if (vueMsg && vueMsg.time) {
              const p = new Date(vueMsg.time).getTime();
              if (!isNaN(p)) sendTime = p;
            }

            const cleanRawId = rawId ? String(rawId).replace(/^msg-/, '') : '';
            const cleanTargetId = String(targetId).replace(/^msg-/, '');
            if (targetId && cleanRawId && cleanRawId === cleanTargetId) {
              return {
                isMe,
                sender,
                time,
                timestamp: sendTime || Date.now(),
              };
            }
          }
          return null;
        })()
      `;

      const msgInfo = await this.cdp.evaluate<{
        isMe: boolean;
        sender?: string;
        time?: string;
        timestamp?: number;
      } | null>(checkScript);

      if (!msgInfo) {
        log.warn({ messageId, sessionId }, '未找到待撤回的目标消息，取消撤回');
        return false;
      }

      if (!msgInfo.isMe) {
        log.warn({ messageId, sender: msgInfo.sender }, '尝试撤回非自己发出的消息，安全拦截');
        return false;
      }

      if (msgInfo.timestamp) {
        let ts = msgInfo.timestamp;
        if (ts < 10_000_000_000) {
          ts *= 1000;
        }
        const elapsedMs = Date.now() - ts;
        if (elapsedMs > 120_000) {
          log.warn({ messageId, elapsedMs }, '消息已超过 2 分钟时效限制，拒绝撤回');
          return false;
        }
      }

      const recallScript = `
        (async () => {
          ${VUE_SCROLLER_HELPERS_SCRIPT}
          const targetId = ${JSON.stringify(messageId)};
          const targetSessionId = ${JSON.stringify(sessionId || '')};

          const items = document.querySelectorAll('${this.selectors.messageItem}');
          let matchedItem = null;
          let matchedVueMsg = null;

          for (let i = items.length - 1; i >= 0; i--) {
            const item = items[i];
            const vueMsg = item.__vue__?.msgitem || item.__vue__?.message;
            const rawId = vueMsg?.id || vueMsg?.msgID || item.getAttribute('id') || item.getAttribute('data-msg-id') || item.getAttribute('data-id');
            const cleanRawId = rawId ? String(rawId).replace(/^msg-/, '') : '';
            const cleanTargetId = String(targetId).replace(/^msg-/, '');

            if (targetId && (rawId === targetId || cleanRawId === cleanTargetId || item.id === targetId || item.id === ('msg-' + targetId))) {
              matchedItem = item;
              matchedVueMsg = vueMsg;
              break;
            }
          }

          if (!matchedItem || !matchedVueMsg || matchedVueMsg.sessionID === undefined) {
            return { success: false, error: '未找到具有原生身份的目标消息' };
          }

          const app = document.querySelector('#app')?.__vue__;
          const main = document.querySelector('.main-page')?.__vue__;
          const bus = main?.$bus || app?.$bus;
          const editor = document.querySelector('.chat-editor, .message-editor, .chat-sendArea')?.__vue__;
          let targetSession = editor?.activedSes || null;
          if (targetSessionId) {
            if (!Array.isArray(editor?.sortedSessions)) {
              return { success: false, error: '当前会话列表不可用' };
            }
            targetSession = findVueSessionItem(editor.sortedSessions, targetSessionId).item;
          }
          if (!targetSession || String(matchedVueMsg.sessionID) !== String(targetSession.id)) {
            return { success: false, error: '目标消息不属于指定会话' };
          }

          const sesUUID = targetSession.sesUUID || targetSessionId;
          const sessionID = targetSession.id;
          const msgID = matchedVueMsg.id || matchedVueMsg.msgID;
          const msgIdx = matchedVueMsg.msgIdx || 0;
          const ipc = window.ipcRenderer || (window.require ? window.require('electron')?.ipcRenderer : null);
          if (!ipc || typeof ipc.send !== 'function' || typeof ipc.once !== 'function') {
            return { success: false, error: '未找到 native IPC 撤回通道' };
          }

          const key = '__kairo_rpc_id';
          const current = typeof window[key] === 'number' ? window[key] : 800000;
          window[key] = current + 1;
          const requestId = current + 1;
          const replyChannel = 'data-' + requestId;
          const ipcRes = await new Promise(resolve => {
            const onReply = (_event, payload) => {
              clearTimeout(timer);
              try { ipc.removeListener(replyChannel, onReply); } catch (e) {}
              resolve(payload);
            };
            const timer = setTimeout(() => {
              try { ipc.removeListener(replyChannel, onReply); } catch (e) {}
              resolve({ code: -2 });
            }, 4000);
            ipc.once(replyChannel, onReply);
            try {
              ipc.send('data', {
                id: requestId,
                args: ['cancelMessage', {
                  type: 'own',
                  sessionID,
                  msgID,
                  msgIdx
                }],
                progress: false
              });
            } catch (sendErr) {
              clearTimeout(timer);
              try { ipc.removeListener(replyChannel, onReply); } catch (e) {}
              resolve({ code: -3 });
            }
          });

          if (!ipcRes || ipcRes.code !== 0) {
            return { success: false, error: 'native 撤回未返回成功 ack' };
          }
          if (bus && sesUUID) {
            try {
              bus.$emit(sesUUID + '-revokeMsg', { msgID, msgIdx });
            } catch (eventErr) {}
          }
          return { success: true, method: 'ipc_cancelMessage' };
        })()
      `;

      const res = await this.cdp.evaluate<{ success: boolean; error?: string }>(recallScript, 6000);
      return Boolean(res?.success);
    } catch (err) {
      log.error({ err: String(err), messageId }, '执行消息撤回异常');
      return false;
    }
  }
}
