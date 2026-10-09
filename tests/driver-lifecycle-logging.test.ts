import EventEmitter from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CdpClient } from '../src/cdp/client.js';
import { KK9EventBridge } from '../src/bridge/event-bridge.js';
import { KK9Driver } from '../src/driver.js';
import { SessionOps } from '../src/dom/session-ops.js';
import { DEFAULT_SELECTORS } from '../src/dom/selectors.js';
import { setDriverLogSink, type DriverLogEntry } from '../src/utils/logger.js';
import { getDriverTestInternals } from './helpers/driver-internals.js';
import {
  createRendererRuntime,
  FakeIpcRenderer,
  runRendererScript,
  type RendererMessage,
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

  it('业务确认后媒体显示失败仍sent，诊断不输出错误对象', async () => {
    const entries: DriverLogEntry[] = [];
    setDriverLogSink(entry => entries.push(entry));
    const session = { id: 93001, sesUUID: '0-91002', typeName: '会话', type: 0, typeID: 91002 };
    const confirmed: RendererMessage[] = [];
    let nativeSendCount = 0;
    const ipc = new FakeIpcRenderer(request => {
      if (request.args[0] === 'getMemberDetail')
        return { code: 0, data: { id: 91001, name: '我' } };
      if (request.args[0] === 'getSessionBySessionID') return { code: 0, data: session };
      if (request.args[0] === 'insertSendBefoeMsg') {
        const message = request.args[1] as Record<string, unknown>;
        confirmed.push({ ...message, id: 135700000, msgIdx: 100, sessionID: session.id });
        return { code: 0, data: { ...message, id: -22, msgIdx: 100 } };
      }
      if (request.args[0] === 'sendMessageNew') {
        nativeSendCount += 1;
        const message = request.args[1] as Record<string, unknown>;
        ipc.emit('0-91002-sendMsgCallback', {
          args: { msgID: message['id'], code: 0, data: confirmed[0] },
        });
        return { code: 0 };
      }
      if (request.args[0] === 'getMessages') return { code: 0, data: confirmed };
      return { code: 1 };
    });
    const runtime = createRendererRuntime({ ipc, sessions: [session] });
    const windowObject = runtime.context['window'] as Record<string, unknown>;
    const fail = (): never => {
      throw new Error('测试秘密界面异常');
    };
    Object.assign(windowObject['$store'] as object, { commit: fail });
    Object.assign(windowObject['vueBus'] as object, { $emit: fail });
    const warnings: unknown[][] = [];
    runtime.context['console'] = { warn: (...args: unknown[]) => warnings.push(args) };
    const driver = new KK9Driver(config);
    const { cdp } = getDriverTestInternals(driver);
    vi.spyOn(cdp, 'getStatus').mockReturnValue('connected');
    vi.spyOn(cdp, 'evaluate').mockImplementation(script =>
      runRendererScript(script, runtime.context)
    );
    vi.spyOn(driver, 'getSessions').mockResolvedValue([
      {
        id: String(session.id),
        name: '会话',
        type: 'private',
        nativeType: 0,
        receiverId: '91002',
        unread: false,
      },
    ]);

    const result = await driver.sendUrlCard(
      {
        title: '测试秘密标题',
        summary: '测试秘密摘要',
        linkUrl: 'https://example.invalid/测试秘密',
      },
      { targetSessionId: String(session.id) }
    );
    expect(result).toMatchObject({ status: 'sent', messageId: '135700000' });
    expect(nativeSendCount).toBe(1);
    expect(result.receipt).toMatchObject({ sessionId: String(session.id), messageId: '135700000' });
    expect(typeof result.recall).toBe('function');
    expect(warnings).toEqual([
      ['[KairoDriver] 会话摘要更新失败'],
      ['[KairoDriver] 聊天窗口推送失败'],
    ]);
    expect(entries.filter(entry => entry.event === 'Driver发送结果')).toEqual([
      expect.objectContaining({
        level: 'info',
        status: 'sent',
        messageId: '135700000',
        sessionId: String(session.id),
        runId: config.startupGenerationId,
      }),
    ]);
    const rejected = await driver.sendText('测试秘密正文');
    expect(rejected).toMatchObject({ status: 'failed', isPreTrigger: true });
    expect(entries.filter(entry => entry.event === 'Driver发送结果').at(-1)).toMatchObject({
      status: 'failed',
      errorType: 'driver',
    });
    expect(JSON.stringify(entries)).not.toContain('测试秘密');
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

  it('Vue会话读取失败保留DOM降级并仅打印固定诊断', async () => {
    const diagnostics: unknown[][] = [];
    const document = {
      querySelector: () => {
        throw new Error('测试秘密滚动列表');
      },
      querySelectorAll: () => [],
    };
    const cdp = new CdpClient(config.cdp);
    vi.spyOn(cdp, 'evaluate').mockImplementation(script =>
      runRendererScript(script, {
        document,
        console: { warn: (...args: unknown[]) => diagnostics.push(args) },
      })
    );
    expect(await new SessionOps(cdp, DEFAULT_SELECTORS).getSessions()).toEqual([]);
    expect(diagnostics).toEqual([['[KairoDriver] Vue滚动列表检查失败']]);
  });
});
