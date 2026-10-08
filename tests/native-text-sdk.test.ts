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
