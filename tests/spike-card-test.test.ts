import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CdpClient } from '../src/cdp/client.js';
import { runSpikeCardTest } from '../examples/spike-card-test.js';
import {
  createRendererRuntime,
  FakeIpcRenderer,
  runRendererScript,
  type RendererSession,
} from './helpers/renderer-runtime.js';

const targetSession: RendererSession = {
  id: 10001,
  sesUUID: '0-1001',
  typeName: '测试员工',
  name: '测试员工',
  type: 0,
  typeID: 1001,
};

interface SpikeHarness {
  cdp: CdpClient;
  ipc: FakeIpcRenderer;
  inserted: Array<Record<string, unknown>>;
  sent: Array<Record<string, unknown>>;
  cancelled: Array<Record<string, unknown>>;
  logger: { log(...args: unknown[]): void; error(...args: unknown[]): void };
}

function createSpikeHarness(
  sessions: RendererSession[],
  persistence: 'empty' | 'persisted'
): SpikeHarness {
  const inserted: Array<Record<string, unknown>> = [];
  const sent: Array<Record<string, unknown>> = [];
  const cancelled: Array<Record<string, unknown>> = [];
  const confirmed: Array<Record<string, unknown>> = [];
  let nextMessageId = 135_800_000;
  const ipc = new FakeIpcRenderer(request => {
    const method = request.args[0];
    if (method === 'insertSendBefoeMsg') {
      const message = request.args[1] as Record<string, unknown>;
      inserted.push(message);
      return { code: 0, data: { id: -22, msgIdx: inserted.length } };
    }
    if (method === 'sendMessageNew') {
      const message = request.args[1] as Record<string, unknown>;
      sent.push(message);
      if (persistence === 'persisted') {
        confirmed.push({
          ...message,
          id: nextMessageId++,
          msgIdx: sent.length,
          sessionID: targetSession.id,
        });
        ipc.emit('0-1001-sendMsgCallback', {
          args: { msgID: message['id'], code: 0, data: confirmed.at(-1) },
        });
      }
      return { code: 0 };
    }
    if (method === 'getMessages') return { code: 0, data: confirmed };
    if (method === 'cancelMessage') {
      cancelled.push(request.args[1] as Record<string, unknown>);
      return { code: 0 };
    }
    return { code: 1, error: `unexpected IPC method: ${String(method)}` };
  });
  const runtime = createRendererRuntime({
    ipc,
    sessions,
    main: { userID: 1000, userName: '测试操作者' },
  });
  const realSetTimeout = setTimeout;
  runtime.context['setTimeout'] = (
    callback: (...args: unknown[]) => void,
    milliseconds = 0,
    ...args: unknown[]
  ) => {
    if (milliseconds === 200) {
      callback(...args);
      return 0;
    }
    return realSetTimeout(callback, milliseconds, ...args);
  };
  const cdp = {
    connect: vi.fn(() => Promise.resolve()),
    disconnect: vi.fn(() => Promise.resolve()),
    evaluate: vi.fn((script: string) => runRendererScript(script, runtime.context)),
  } as unknown as CdpClient;
  return {
    cdp,
    ipc,
    inserted,
    sent,
    cancelled,
    logger: { log: vi.fn(), error: vi.fn() },
  };
}

const confirmedEnvironment: NodeJS.ProcessEnv = {
  KK9_MEDIA_TARGET_ID: '0-1001',
  KK9_MEDIA_TARGET_NAME: '测试员工',
  KK9_TEST_GROUP_ID: '1-2001',
  KK9_TEST_GROUP_NAME: '测试群',
  KK9_MEDIA_CONFIRM: '1000:0-1001:测试员工',
};

afterEach(() => vi.useRealTimers());
describe('卡片 Spike 安全门禁与落库确认', () => {
  it('未指定目标时在连接之前停止，不使用默认员工会话', async () => {
    const harness = createSpikeHarness([targetSession], 'persisted');

    const summary = await runSpikeCardTest({
      cdp: harness.cdp,
      env: { ...confirmedEnvironment, KK9_MEDIA_TARGET_ID: '' },
      logger: harness.logger,
      delay: async () => {},
    });

    expect(summary).toMatchObject({ exitCode: 1, results: [], recalledMessageIds: [] });
    expect(harness.cdp.connect).not.toHaveBeenCalled();
    expect(harness.ipc.sent).toHaveLength(0);
  });

  it('同名会话的 ID 不匹配时必须停止且不访问发送 IPC', async () => {
    const sameNameWrongId: RendererSession = {
      ...targetSession,
      id: 10002,
      sesUUID: '1-2001',
    };
    const harness = createSpikeHarness([sameNameWrongId], 'persisted');

    const summary = await runSpikeCardTest({
      cdp: harness.cdp,
      env: confirmedEnvironment,
      logger: harness.logger,
      delay: async () => {},
    });

    expect(summary).toMatchObject({ exitCode: 1, results: [], recalledMessageIds: [] });
    expect(harness.ipc.sent).toHaveLength(0);
  });

  it('配置 ID 命中但名称不匹配时必须停止且不访问发送 IPC', async () => {
    const wrongName: RendererSession = {
      ...targetSession,
      typeName: '另一个会话',
      name: '另一个会话',
    };
    const harness = createSpikeHarness([wrongName], 'persisted');

    const summary = await runSpikeCardTest({
      cdp: harness.cdp,
      env: confirmedEnvironment,
      logger: harness.logger,
      delay: async () => {},
    });

    expect(summary).toMatchObject({ exitCode: 1, results: [], recalledMessageIds: [] });
    expect(harness.ipc.sent).toHaveLength(0);
  });

  it('未提供操作者确认时必须停止且不访问发送 IPC', async () => {
    const harness = createSpikeHarness([targetSession], 'persisted');

    const summary = await runSpikeCardTest({
      cdp: harness.cdp,
      env: { ...confirmedEnvironment, KK9_MEDIA_CONFIRM: '' },
      logger: harness.logger,
      delay: async () => {},
    });

    expect(summary).toMatchObject({ exitCode: 1, results: [], recalledMessageIds: [] });
    expect(harness.ipc.sent).toHaveLength(0);
  });

  it('sendMessageNew 返回 ack 0 但历史为空时必须为 unknown 且每类只发送一次', async () => {
    vi.useFakeTimers();
    const harness = createSpikeHarness([targetSession], 'empty');

    const pending = runSpikeCardTest({
      cdp: harness.cdp,
      env: confirmedEnvironment,
      logger: harness.logger,
      delay: async () => {},
    });
    await vi.runAllTimersAsync();
    const summary = await pending;

    expect(summary.exitCode).toBe(1);
    expect(summary.results).toHaveLength(4);
    expect(summary.results.every(result => result.status === 'unknown')).toBe(true);
    expect(summary.results.every(result => result.messageId === undefined)).toBe(true);
    expect(harness.inserted).toHaveLength(4);
    expect(harness.sent.map(message => message['contentType'])).toEqual([10, 17, 8, 14]);
    expect(new Set(harness.sent.map(message => message['msgFlag'])).size).toBe(4);
    expect(harness.cancelled).toHaveLength(0);
  });

  it('四类消息业务确认后报告sent，并通过正式ID撤回', async () => {
    const harness = createSpikeHarness([targetSession], 'persisted');

    const summary = await runSpikeCardTest({
      cdp: harness.cdp,
      env: confirmedEnvironment,
      logger: harness.logger,
      delay: async () => {},
    });

    expect(summary.exitCode).toBe(0);
    expect(summary.results.map(result => result.status)).toEqual(['sent', 'sent', 'sent', 'sent']);
    expect(summary.results.map(result => result.contentType)).toEqual([10, 17, 8, 14]);
    expect(summary.results.every(result => /^[1-9]\d*$/.test(result.messageId || ''))).toBe(true);
    expect(harness.sent.map(message => message['contentType'])).toEqual([10, 17, 8, 14]);
    expect(harness.sent[3]?.['content']).toEqual({
      groupId: 2001,
      groupName: '测试群',
      ownerName: '管理员',
    });
    expect(harness.cancelled.map(message => String(message['msgID']))).toEqual(
      summary.results.map(result => result.messageId)
    );
    expect(summary.recalledMessageIds).toEqual(summary.results.map(result => result.messageId));
  });
});
