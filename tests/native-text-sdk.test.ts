import { afterEach, describe, expect, it, vi } from 'vitest';
import { BridgeMessageOps } from '../src/bridge/message-ops.js';
import { InMemorySendOperationStore } from '../src/send-operation.js';
import { createNativeSendRuntime } from './helpers/native-send-runtime.js';

// 实际执行SDK生成的渲染脚本；环境没有document/Vue，原生IPC边界为受控服务。
describe('明确原生会话的文本SDK', () => {
  afterEach(() => vi.useRealTimers());
  it.each([
    ['93001', 0, 91002],
    ['93002', 1, 92001],
  ])(
    '原生会话%s按身份与接收对象发送且重复/查询不增加记录',
    async (sessionId, nativeType, receiver) => {
      const native = createNativeSendRuntime();
      const store = new InMemorySendOperationStore();
      const ops = new BridgeMessageOps(native.cdp, store);
      const options = { targetSessionId: String(sessionId), operationId: 'op-target' };
      const sent = await ops.sendText('唯一意图', options);
      const repeated = await ops.sendText('唯一意图', options);
      const queried = await ops.getSendStatus('op-target');
      expect(sent).toMatchObject({
        status: 'sent',
        operationId: 'op-target',
        messageId: '135700000',
        receipt: { draftId: '-1', code: 0, sessionId: String(sessionId), messageId: '135700000' },
      });
      expect(repeated).toEqual(sent);
      expect(queried).toEqual(sent);
      expect(native.records).toMatchObject([
        {
          sessionID: Number(sessionId),
          sessionType: nativeType,
          sender: 91001,
          receiver,
          deviceID: 88001,
          content: { content: [{ type: 0, text: '唯一意图' }] },
        },
      ]);
      expect(native.records).toHaveLength(1);
      expect(native.drafts[0]).not.toHaveProperty('deviceID');
      expect(native.ipc.listenerCount(`${nativeType}-${receiver}-sendMsgCallback`)).toBe(0);
    }
  );
  it.each([627, -9, 617])('真实协议业务码%s失败保持失败，查询不改判且重复不提交', async code => {
    const native = createNativeSendRuntime(code === 617 ? { businessCode: code } : { code });
    const ops = new BridgeMessageOps(native.cdp);
    const options = { targetSessionId: '93001', operationId: 'op-failure' };
    const result = await ops.sendText('受控业务失败', options);
    expect(result).toMatchObject({ status: 'failed', nativeCode: code, isPreTrigger: false });
    expect(result.error).toContain(String(code));
    expect(await ops.getSendStatus('op-failure')).toEqual(result);
    expect(await ops.sendText('受控业务失败', options)).toEqual(result);
    expect(native.records).toHaveLength(1);
  });
  it.each([0, 617, 627, -9])('原生处理超过四秒仍在业务期限内保留%s回执', async code => {
    vi.useFakeTimers();
    const native = createNativeSendRuntime({
      sendDelayMs: 4500,
      ...(code === 617 ? { businessCode: code } : { code }),
    });
    const ops = new BridgeMessageOps(native.cdp);
    const options = { targetSessionId: '93001', operationId: 'op-slow', verifyTimeoutMs: 6000 };
    const pending = ops.sendText('慢原生处理', options);
    await vi.advanceTimersByTimeAsync(4500);
    const result = await pending;
    expect(result).toMatchObject(
      code === 0
        ? { status: 'sent', messageId: '135700000', receipt: { code: 0 } }
        : { status: 'failed', nativeCode: code }
    );
    expect(await ops.getSendStatus('op-slow')).toEqual(result);
    expect(await ops.sendText('慢原生处理', options)).toEqual(result);
    expect(native.records).toHaveLength(1);
    expect(native.ipc.listenerCount('0-91002-sendMsgCallback')).toBe(0);
  });
  it('成功回执已收到但CDP响应丢失，查询恢复业务证据且不提交', async () => {
    const native = createNativeSendRuntime({ responseLost: true });
    const store = new InMemorySendOperationStore();
    const ops = new BridgeMessageOps(native.cdp, store);
    const first = await ops.sendText('提交后失联', {
      targetSessionId: '93001',
      operationId: 'op-lost',
    });
    expect(first.status).toBe('unknown');
    expect(await new BridgeMessageOps(native.cdp, store).getSendStatus('op-lost')).toMatchObject({
      status: 'sent',
      messageId: '135700000',
      receipt: { draftId: '-1', code: 0 },
    });
    expect(native.records).toHaveLength(1);
  });
  it.each([0, 617])('查询先确认业务码%s，后到响应丢失不降低已确认状态', async businessCode => {
    let ready = (): void => {};
    let release = (): void => {};
    const started = new Promise<void>(resolve => {
      ready = resolve;
    });
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const native = createNativeSendRuntime({
      responseLost: true,
      businessCode,
      responseGate: gate,
      responseStarted: ready,
    });
    const store = new InMemorySendOperationStore();
    const ops = new BridgeMessageOps(native.cdp, store);
    const pending = ops.sendText('终态竞态', {
      targetSessionId: '93001',
      operationId: 'op-query-first',
    });
    await started;
    const confirmed = await new BridgeMessageOps(native.cdp, store).getSendStatus('op-query-first');
    expect(confirmed).toMatchObject(
      businessCode === 0
        ? { status: 'sent', messageId: '135700000' }
        : { status: 'failed', nativeCode: 617 }
    );
    native.disconnect();
    release();
    expect(await pending).toEqual(confirmed);
    expect(await ops.getSendStatus('op-query-first')).toEqual(confirmed);
    expect((await store.get('op-query-first'))?.receipt).toEqual(confirmed.receipt);
    expect(native.records).toHaveLength(1);
  });
  it.each([{ callback: false }, { mismatchedSession: true }])(
    '没有可用本次业务回执时，正式正ID记录也不能确认',
    async config => {
      vi.useFakeTimers();
      const native = createNativeSendRuntime(config);
      const ops = new BridgeMessageOps(native.cdp);
      const pending = ops.sendText('无业务证据', {
        targetSessionId: '93001',
        operationId: 'op-no-receipt',
        verifyTimeoutMs: 50,
      });
      await vi.runAllTimersAsync();
      expect((await pending).status).toBe('unknown');
      expect((await ops.getSendStatus('op-no-receipt')).status).toBe('unknown');
      expect(
        (
          await ops.sendText('无业务证据', {
            targetSessionId: '93001',
            operationId: 'op-no-receipt',
          })
        ).status
      ).toBe('unknown');
      expect(native.records).toHaveLength(1);
      expect(native.ipc.listenerCount('0-91002-sendMsgCallback')).toBe(0);
    }
  );
  it.each([undefined, '', '员工甲', '0-91002', '99999'])(
    '无效或未知目标%s不触发草稿或发送',
    async targetSessionId => {
      const native = createNativeSendRuntime();
      const result = await new BridgeMessageOps(native.cdp).sendText('不可路由', {
        targetSessionId,
      });
      expect(result).toMatchObject({ status: 'failed', isPreTrigger: true });
      expect(result.operationId).toMatch(/^[0-9a-f-]{36}$/);
      expect(native.drafts).toEqual([]);
      expect(native.records).toEqual([]);
    }
  );
  it.each([null, 0])('原生登录身份%s无效不借用配置或编辑器', async identity => {
    const native = createNativeSendRuntime({ identity });
    const result = await new BridgeMessageOps(native.cdp).sendText('身份缺失', {
      targetSessionId: '93001',
    });
    expect(result).toMatchObject({ status: 'failed', isPreTrigger: true });
    expect(native.drafts).toEqual([]);
  });
  it('同一operationId改内容/目标/类型拒绝，不再次提交', async () => {
    const native = createNativeSendRuntime();
    const ops = new BridgeMessageOps(native.cdp);
    await ops.sendText('初始', { targetSessionId: '93001', operationId: 'op-conflict' });
    await expect(
      ops.sendText('修改', { targetSessionId: '93001', operationId: 'op-conflict' })
    ).rejects.toThrow(/fingerprint/);
    await expect(
      ops.sendText('初始', { targetSessionId: '93002', operationId: 'op-conflict' })
    ).rejects.toThrow(/fingerprint/);
    await expect(
      ops.sendRichText('初始', { targetSessionId: '93001', operationId: 'op-conflict' })
    ).rejects.toThrow(/fingerprint/);
    expect(native.records).toHaveLength(1);
  });
  it('明确前置失败同一意图只重放失败，不自动重试', async () => {
    const native = createNativeSendRuntime({ insertCode: 627 });
    const ops = new BridgeMessageOps(native.cdp);
    const options = { targetSessionId: '93001', operationId: 'op-insert' };
    const first = await ops.sendText('预插入拒绝', options);
    expect(first).toMatchObject({ status: 'failed', isPreTrigger: true });
    expect(await ops.sendText('预插入拒绝', options)).toEqual(first);
    expect(
      native.ipc.sent.filter(request => request.args[0] === 'insertSendBefoeMsg')
    ).toHaveLength(1);
  });
  it('只取消本实例的在途草稿监听，等待结束后可安全退出', async () => {
    const native = createNativeSendRuntime({ callback: false });
    const ops = new BridgeMessageOps(native.cdp);
    const pending = ops.sendText('取消等待', {
      targetSessionId: '93001',
      operationId: 'op-cancel',
    });
    // 等到真实生成脚本提交后才取消，不依赖固定睡眠。
    for (let i = 0; i < 50 && native.records.length === 0; i++) await Promise.resolve();
    expect(native.records).toHaveLength(1);
    await ops.cancelPendingSends();
    expect((await pending).status).toBe('unknown');
    expect(native.ipc.listenerCount('0-91002-sendMsgCallback')).toBe(0);
    expect((native.window['__kairo_pending_sends'] as Map<string, unknown>).size).toBe(0);
  });
  it('发送后立即取消，声明阶段不得在取消返回后提交', async () => {
    const native = createNativeSendRuntime();
    const ops = new BridgeMessageOps(native.cdp);
    const pending = ops.sendText('立即取消', {
      targetSessionId: '93001',
      operationId: 'op-cancel-now',
    });
    await ops.cancelPendingSends();
    expect(await pending).toMatchObject({ status: 'failed', isPreTrigger: true });
    expect(native.drafts).toEqual([]);
    expect(native.records).toEqual([]);
    expect(await ops.getSendStatus('op-cancel-now')).toMatchObject({
      status: 'failed',
      isPreTrigger: true,
    });
  });
  it.each(['getMemberDetail', 'insertSendBefoeMsg'])(
    '取消等待中的%s后不再提交或新增监听',
    async method => {
      const native = createNativeSendRuntime();
      const send = native.ipc.send.bind(native.ipc);
      let ready = (): void => {};
      const started = new Promise<void>(resolve => {
        ready = resolve;
      });
      let respond = (): void => {};
      native.ipc.send = (channel, request) => {
        if (request.args[0] === method) {
          respond = () => send(channel, request);
          ready();
        } else send(channel, request);
      };
      const ops = new BridgeMessageOps(native.cdp);
      const pending = ops.sendText('准备阶段取消', {
        targetSessionId: '93001',
        operationId: 'op-cancel-prep',
      });
      await started;
      const cancelling = ops.cancelPendingSends();
      respond();
      await cancelling;
      expect(await pending).toMatchObject({ status: 'failed', isPreTrigger: true });
      expect(native.records).toEqual([]);
      expect(native.ipc.listenerCount('0-91002-sendMsgCallback')).toBe(0);
      expect((native.window['__kairo_pending_sends'] as Map<string, unknown>).size).toBe(0);
    }
  );
  it('取消等待异步 Store 声明完成后才返回，且不触发发送', async () => {
    const native = createNativeSendRuntime();
    const store = new InMemorySendOperationStore();
    const claim = store.claim.bind(store);
    let ready = (): void => {};
    let release = (): void => {};
    const started = new Promise<void>(resolve => {
      ready = resolve;
    });
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    store.claim = async input => {
      ready();
      await gate;
      return claim(input);
    };
    const ops = new BridgeMessageOps(native.cdp, store);
    const pending = ops.sendText('等待声明取消', {
      targetSessionId: '93001',
      operationId: 'op-cancel-claim',
    });
    await started;
    const cancelling = ops.cancelPendingSends();
    release();
    await cancelling;
    expect(await pending).toMatchObject({ status: 'failed', isPreTrigger: true });
    expect(native.drafts).toEqual([]);
    expect(native.records).toEqual([]);
  });
  it('取消一个 SDK 不影响另一 SDK 的在途发送监听', async () => {
    const native = createNativeSendRuntime({ callback: false });
    const first = new BridgeMessageOps(native.cdp);
    const second = new BridgeMessageOps(native.cdp);
    const a = first.sendText('甲', { targetSessionId: '93001', operationId: 'cancel-owner-a' });
    const b = second.sendText('乙', { targetSessionId: '93001', operationId: 'cancel-owner-b' });
    for (let i = 0; i < 100 && native.records.length < 2; i++) await Promise.resolve();
    expect(native.records).toHaveLength(2);
    await first.cancelPendingSends();
    expect((await a).status).toBe('unknown');
    expect(native.ipc.listenerCount('0-91002-sendMsgCallback')).toBe(1);
    expect((native.window['__kairo_pending_sends'] as Map<string, unknown>).size).toBe(1);
    await second.cancelPendingSends();
    expect((await b).status).toBe('unknown');
    expect(native.ipc.listenerCount('0-91002-sendMsgCallback')).toBe(0);
    expect((native.window['__kairo_pending_sends'] as Map<string, unknown>).size).toBe(0);
  });
  it('未知意图在CDP未连接时仍unknown，查询不提交也不改成前置失败', async () => {
    const native = createNativeSendRuntime({ responseLost: true });
    const ops = new BridgeMessageOps(native.cdp);
    expect(
      (
        await ops.sendText('失联意图', {
          targetSessionId: '93001',
          operationId: 'op-offline-query',
        })
      ).status
    ).toBe('unknown');
    native.disconnect();
    const result = await ops.getSendStatus('op-offline-query');
    expect(result).toMatchObject({
      status: 'unknown',
      isPreTrigger: false,
      error: expect.stringContaining('CDP未连接'),
    });
    expect(native.records).toHaveLength(1);
  });
});
