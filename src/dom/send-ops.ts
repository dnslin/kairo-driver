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

}
