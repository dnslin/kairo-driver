import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanupNativeUserText } from '../examples/native-user-text-cleanup.js';
import { KK9EventBridge } from '../src/bridge/event-bridge.js';
import { BridgeMessageOps } from '../src/bridge/message-ops.js';
import { createNativeMessageKey } from '../src/bridge/send-status.js';
import { CdpClient } from '../src/cdp/client.js';
import { InMemorySendOperationStore } from '../src/send-operation.js';
import { createNativeSendRuntime } from './helpers/native-send-runtime.js';

function signal() {
  // 仓库TS库目标为ES2022，使用该目标已声明的Promise构造器。
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

function createExampleRuntime() {
  const native = createNativeSendRuntime({ callback: false });
  const clientListener = vi.fn();
  native.ipc.on('message', clientListener);
  const store = new InMemorySendOperationStore();
  const config = { url: 'http://127.0.0.1:1', pageMatch: '工号示例离线回归' };

  function createDriverConnection(generationId: string, rejectExistingBridge = false) {
    const cdp = new CdpClient(config, { startupGenerationId: generationId });
    let connected = true;
    let lose!: () => void;
    const lost = new Promise<never>((_resolve, reject) => {
      lose = () => { connected = false; reject(new Error('仅Driver CDP失联')); };
    });
    vi.spyOn(cdp, 'getStatus').mockImplementation(() => connected ? 'connected' : 'disconnected');
    vi.spyOn(cdp, 'getConnectionIdentity').mockImplementation(() => connected ? {
      startupGenerationId: generationId, connectionId: generationId + '-连接', targetId: '页面',
      webSocketDebuggerUrl: 'ws://127.0.0.1:1/离线', connectedAt: 1,
    } : null);
    vi.spyOn(cdp, 'evaluate').mockImplementation(script => Promise.race([native.cdp.evaluate(script), lost]));
    vi.spyOn(cdp, 'sendCommand').mockImplementation(method => {
      if (method === 'Runtime.addBinding') native.window['__kairo_native_bridge'] = vi.fn();
      return Promise.resolve({});
    });
    vi.spyOn(cdp, 'disconnect').mockImplementation(() => { connected = false; return Promise.resolve(); });
    const bridge = new KK9EventBridge({ cdp: config, startupGenerationId: generationId, currentUserId: '91001', rejectExistingBridge }, cdp);
    return { bridge, lose, ops: new BridgeMessageOps(cdp, store) };
  }

  return { ...native, store, clientListener, createDriverConnection };
}

// 独立CDP执行真正的示例清理脚本，Hook与发送任务均来自SDK实际注入。
describe('工号专项示例跨连接资源退出', () => {
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it('Driver单独失联后取消查人并等待finally，再清本代Hook；迟到查人不能提交', async () => {
    vi.useFakeTimers();
    const native = createExampleRuntime();
    const driver = native.createDriverConnection('本代');
    await driver.bridge.connect();
    const started = signal();
    const originalSend = native.ipc.send.bind(native.ipc);
    let respond = (): void => {};
    native.ipc.send = (channel, request) => {
      if (request.args[0] === 'unionSearch') {
        respond = () => originalSend(channel, request);
        started.resolve();
      } else originalSend(channel, request);
    };
    const operationId = '示例查人失联';
    const key = createNativeMessageKey('text-to-user', operationId);
    const sending = driver.ops.sendTextToUser('int2023', '查人阶段', { operationId });
    await started.promise;
    driver.lose();
    expect(await sending).toMatchObject({ status: 'unknown', error: expect.stringContaining('仅Driver CDP失联') });
    await driver.bridge.disconnect();
    expect(native.window['__kairo_bridge_cleanup']).toBeTypeOf('function');
    expect(native.window['__kairo_native_bridge']).toBeTypeOf('function');
    const pending = native.window['__kairo_pending_sends'] as Map<string, unknown>;
    const cleanup = cleanupNativeUserText(native.cdp, key, '本代');
    expect(pending.has(key)).toBe(true);
    expect(native.window['__kairo_bridge_cleanup']).toBeTypeOf('function');
    await vi.advanceTimersByTimeAsync(20);
    await cleanup;
    expect(pending.has(key)).toBe(false);
    expect(native.window['__kairo_bridge_cleanup']).toBeUndefined();
    expect(native.window['__kairo_native_send_observer']).toBeUndefined();
    expect(native.window['__kairo_native_bridge']).toBeUndefined();
    expect(native.ipc.listenerCount('message')).toBe(1);
    respond();
    await vi.advanceTimersByTimeAsync(0);
    expect(native.drafts).toEqual([]);
    expect(native.records).toEqual([]);
    expect(await new BridgeMessageOps(native.cdp, native.store).getSendStatus(operationId)).toMatchObject({ status: 'unknown' });
    const next = native.createDriverConnection('下代', true);
    await next.bridge.connect();
    await next.bridge.disconnect();
  });

  it('提交后只取消本次key，同一Hook观察的其他发送仍能收到回执；迟到回执不能恢复本次操作', async () => {
    vi.useFakeTimers();
    const native = createExampleRuntime();
    const driver = native.createDriverConnection('本代');
    await driver.bridge.connect();
    const submitted = signal();
    const otherSubmitted = signal();
    const originalSend = native.ipc.send.bind(native.ipc);
    native.ipc.send = (channel, request) => {
      originalSend(channel, request);
      if (request.args[0] === 'sendMessageNew' && native.records.length === 2) submitted.resolve();
      if (request.args[0] === 'sendMessageNew' && native.records.length === 1) otherSubmitted.resolve();
    };
    const operationId = '示例业务失联';
    const ownKey = createNativeMessageKey('text-to-user', operationId);
    const otherOps = new BridgeMessageOps(native.cdp);
    const otherKey = createNativeMessageKey('text', '其他操作');
    const other = otherOps.sendText('其他文本', { targetSessionId: '93001', operationId: '其他操作' });
    await otherSubmitted.promise;
    const own = driver.ops.sendTextToUser('int2023', '本次文本', { operationId });
    await submitted.promise;
    driver.lose();
    expect((await own).status).toBe('unknown');
    await driver.bridge.disconnect();
    const pending = native.window['__kairo_pending_sends'] as Map<string, unknown>;
    const otherCancel = pending.get(otherKey);
    const cleanup = cleanupNativeUserText(native.cdp, ownKey, '本代');
    await vi.advanceTimersByTimeAsync(20);
    await cleanup;
    expect(pending.has(ownKey)).toBe(false);
    expect(pending.get(otherKey)).toBe(otherCancel);
    expect(native.ipc.listenerCount('0-91003-sendMsgCallback')).toBe(0);
    expect(native.ipc.listenerCount('0-91002-sendMsgCallback')).toBe(1);
    const ownDraft = native.drafts.find(item => item['msgFlag'] === ownKey)!;
    const ownRecord = native.records.find(item => item['msgFlag'] === ownKey)!;
    native.ipc.emit('0-91003-sendMsgCallback', { args: { msgID: ownDraft['id'], code: 0, data: ownRecord } });
    expect(await new BridgeMessageOps(native.cdp, native.store).getSendStatus(operationId)).toMatchObject({ status: 'unknown' });
    const otherDraft = native.drafts.find(item => item['msgFlag'] === otherKey)!;
    const otherRecord = native.records.find(item => item['msgFlag'] === otherKey)!;
    native.ipc.emit('0-91002-sendMsgCallback', { args: { msgID: otherDraft['id'], code: 0, data: otherRecord } });
    expect(await other).toMatchObject({ status: 'sent', messageId: String(otherRecord['id']) });
    expect(pending.size).toBe(0);
    expect(native.records).toHaveLength(2);
    expect(native.ipc.listenerCount('message')).toBe(1);
  });

  it('旧示例退出不能清掉另一代已接管的Hook和监听', async () => {
    const native = createExampleRuntime();
    const old = native.createDriverConnection('旧代');
    await old.bridge.connect();
    old.lose();
    await old.bridge.disconnect();
    const current = native.createDriverConnection('其他代');
    await current.bridge.connect();
    const cleanup = native.window['__kairo_bridge_cleanup'];
    const observer = native.window['__kairo_native_send_observer'];
    const binding = native.window['__kairo_native_bridge'];
    await cleanupNativeUserText(native.cdp, '不存在的本次key', '旧代');
    expect(native.window['__kairo_bridge_cleanup']).toBe(cleanup);
    expect(native.window['__kairo_native_send_observer']).toBe(observer);
    expect(native.window['__kairo_native_bridge']).toBe(binding);
    expect(native.ipc.listenerCount('message')).toBe(2);
    await current.bridge.disconnect();
  });

  it('取消等待与本代Hook清理同时失败时保留两项错误，不扫其他key', async () => {
    vi.useFakeTimers();
    const native = createExampleRuntime();
    const pending = new Map<string, () => void>();
    const ownCancel = vi.fn();
    const otherCancel = vi.fn();
    pending.set('本次key', ownCancel);
    pending.set('其他key', otherCancel);
    native.window['__kairo_pending_sends'] = pending;
    native.window['__kairo_bridge_cleanup'] = Object.assign(() => { throw new Error('本代Hook退出失败'); }, { generationId: '本代' });
    native.window['__kairo_native_bridge'] = vi.fn();
    const result = cleanupNativeUserText(native.cdp, '本次key', '本代').then(() => '', error => String(error));
    await vi.advanceTimersByTimeAsync(8000);
    const error = await result;
    expect(error).toContain('本次发送任务取消后未退出');
    expect(error).toContain('本代Hook退出失败');
    expect(ownCancel).toHaveBeenCalledTimes(1);
    expect(otherCancel).not.toHaveBeenCalled();
    expect(pending.get('其他key')).toBe(otherCancel);
    expect(native.window['__kairo_native_bridge']).toBeUndefined();
  });
});
