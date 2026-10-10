import EventEmitter from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CdpClient } from '../src/cdp/client.js';
import { KK9EventBridge } from '../src/bridge/event-bridge.js';
import { KK9Driver } from '../src/driver.js';
import { setDriverLogSink, type DriverLogEntry } from '../src/utils/logger.js';
import { getDriverTestInternals } from './helpers/driver-internals.js';
import {
  createRendererRuntime,
  runRendererScript,
} from './helpers/renderer-runtime.js';
import { createNativeSendRuntime } from './helpers/native-send-runtime.js';

const config = {
  cdp: { url: 'http://127.0.0.1:1', pageMatch: '离线测试' },
  startupGenerationId: '日志回归代次',
};

afterEach(() => {
  setDriverLogSink(undefined);
  vi.restoreAllMocks();
});

describe('Driver日志真实行为回归', () => {
  it('原生超时、响应丢失和前置拒绝分别记录最终状态，不输出正文', async () => {
    vi.useFakeTimers();
    const entries: DriverLogEntry[] = [];
    setDriverLogSink(entry => entries.push(entry));
    const native = createNativeSendRuntime({ callback: false });
    const driver = new KK9Driver(config);
    const { cdp } = getDriverTestInternals(driver);
    vi.spyOn(cdp, 'getStatus').mockReturnValue('connected');
    vi.spyOn(cdp, 'evaluate').mockImplementation(script =>
      runRendererScript(script, native.context)
    );
    try {
      const work = driver.sendText('测试秘密消息正文', {
        targetSessionId: '93001',
        verifyTimeoutMs: 50,
      });
      await vi.runAllTimersAsync();
      expect(await work).toMatchObject({ status: 'unknown', isPreTrigger: false });
      vi.mocked(cdp.evaluate).mockRejectedValueOnce(new Error('测试秘密响应丢失'));
      expect(
        await driver.sendText('第二条测试秘密正文', { targetSessionId: '93001' })
      ).toMatchObject({ status: 'unknown', isPreTrigger: false });
      expect(await driver.sendText('第三条测试秘密正文')).toMatchObject({
        status: 'failed',
        isPreTrigger: true,
      });
      expect(
        entries
          .filter(entry => entry.event === 'Driver发送结果')
          .map(entry => ({
            level: entry.level,
            status: entry.status,
            errorType: entry.errorType,
            runId: entry.runId,
          }))
      ).toEqual([
        {
          level: 'warn',
          status: 'unknown',
          errorType: 'send_unknown',
          runId: config.startupGenerationId,
        },
        {
          level: 'warn',
          status: 'unknown',
          errorType: 'send_unknown',
          runId: config.startupGenerationId,
        },
        { level: 'warn', status: 'failed', errorType: 'driver', runId: config.startupGenerationId },
      ]);
      expect(native.records).toHaveLength(1);
      expect(JSON.stringify(entries)).not.toContain('测试秘密');
    } finally {
      vi.useRealTimers();
    }
  });


  it('Hook清理和binding错误只产生固定诊断，事件订阅保持可用', async () => {
    const runtime = createRendererRuntime();
    const diagnostics: unknown[][] = [];
    runtime.context['console'] = {
      warn: (...args: unknown[]) => diagnostics.push(args),
      error: (...args: unknown[]) => diagnostics.push(args),
    };
    const windowObject = runtime.context['window'] as Record<string, unknown>;
    const ipc = new EventEmitter();
    windowObject['ipcRenderer'] = ipc;
    const handlers: Record<string, (payload: unknown) => void> = {};
    Object.assign(windowObject['vueBus'] as object, {
      $on: (event: string, handler: (payload: unknown) => void) => {
        handlers[event] = handler;
      },
      $off: (event: string) => {
        delete handlers[event];
      },
    });
    windowObject['__kairo_bridge_cleanup'] = () => {
      throw new Error('测试秘密前序Hook');
    };
    windowObject['__kairo_native_bridge'] = () => {
      throw new Error('测试秘密binding');
    };
    const cdp = new CdpClient(config.cdp);
    vi.spyOn(cdp, 'getStatus').mockReturnValue('connected');
    vi.spyOn(cdp, 'sendCommand').mockResolvedValue({});
    vi.spyOn(cdp, 'evaluate').mockImplementation(script =>
      runRendererScript(script, runtime.context)
    );
    const bridge = new KK9EventBridge(config, cdp);
    await bridge.connect();
    expect(bridge.isAttached()).toBe(true);
    ipc.emit(
      'message',
      {},
      {
        args: {
          sessionID: '0-91002',
          message: [{ id: 'msg-1', content: '测试秘密正文' }],
        },
      }
    );
    expect(diagnostics).toEqual([
      ['[KairoDriver] 前序Hook清理异常'],
      ['[KairoDriver] 事件派发到CDP binding失败'],
    ]);
    (windowObject['__kairo_bridge_cleanup'] as () => void)();
    expect(handlers['receive-message']).toBeUndefined();
    expect(ipc.listenerCount('message')).toBe(0);
  });

});
