import type { CdpClient } from '@kairo/driver';

/** 独立CDP只取消本次消息键，并清理仍属于本次Driver启动代的Hook。 */
export async function cleanupNativeUserText(
  cdp: Pick<CdpClient, 'evaluate'>,
  key: string,
  generationId: string
): Promise<void> {
  await cdp.evaluate(`(async () => {
    const errors = [];
    try {
      const pending = window.__kairo_pending_sends;
      const cancel = pending?.get(${JSON.stringify(key)});
      if (cancel) {
        cancel();
        // abort只发出取消信号；必须等异步任务finally释放自己的登记。
        for (let attempt = 0; pending.get(${JSON.stringify(key)}) === cancel; attempt++) {
          if (attempt >= 400) throw new Error('本次发送任务取消后未退出');
          // KK9使用Chromium108，不支持Promise.withResolvers；渲染脚本保留构造器写法。
          await new Promise(resolve => setTimeout(resolve, 20));
        }
      }
    } catch (error) { errors.push(String(error)); }
    try {
      const cleanup = window.__kairo_bridge_cleanup;
      if (typeof cleanup === 'function' && cleanup.generationId === ${JSON.stringify(generationId)}) {
        const binding = window.__kairo_native_bridge;
        try { cleanup(); }
        finally {
          if (window.__kairo_native_bridge === binding) delete window.__kairo_native_bridge;
        }
      }
    } catch (error) { errors.push(String(error)); }
    if (errors.length) throw new Error('本次工号发送资源清理失败：' + errors.join('；'));
  })()`, 10000);
}
