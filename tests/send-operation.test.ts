import { describe, expect, it } from 'vitest';
import {
  FakeKK9Driver,
  InMemorySendOperationStore,
  createSendOperationFingerprint,
} from '../src/index.js';

describe('发送操作 Store port 与 FakeDriver', () => {
  it('规范化目标并以发送类型和内容摘要组成 fingerprint', () => {
    const base = createSendOperationFingerprint({
      targetSessionId: 'session-1',
      messageType: 'text',
      content: '回答内容',
    });
    const normalized = createSendOperationFingerprint({
      targetSessionId: '  session-1  ',
      messageType: 'text',
      content: '回答内容',
    });

    expect(normalized).toEqual(base);
    expect(base.contentDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(
      createSendOperationFingerprint({
        targetSessionId: 'session-1',
        messageType: 'rich-text',
        content: '回答内容',
      })
    ).not.toEqual(base);
    expect(
      createSendOperationFingerprint({
        targetSessionId: 'session-1',
        messageType: 'text',
        content: '不同内容',
      })
    ).not.toEqual(base);
    expect(
      createSendOperationFingerprint({
        targetSessionId: undefined,
        messageType: 'text',
        content: '回答内容',
      })
    ).toEqual(
      createSendOperationFingerprint({
        targetSessionId: '   ',
        messageType: 'text',
        content: '回答内容',
      })
    );
  });

  it('claim 首次记录 unknown，update 后可查询最终 sent', async () => {
    const store = new InMemorySendOperationStore();
    const fingerprint = createSendOperationFingerprint({
      targetSessionId: 'session-1',
      messageType: 'text',
      content: '回答内容',
    });

    const claim = await store.claim({ operationId: 'op-1', fingerprint });
    expect(claim.claimed).toBe(true);
    expect(claim.operation.status).toBe('unknown');

    const sent = await store.update('op-1', {
      status: 'sent',
      messageId: 'native-1',
      isPreTrigger: false,
    });

    expect(sent).toMatchObject({
      operationId: 'op-1',
      fingerprint,
      status: 'sent',
      messageId: 'native-1',
    });
    expect(await store.get('op-1')).toEqual(sent);
  });
  it.each(['sent', 'failed'] as const)(
    '并发后到 unknown 不清除已确认的%s及业务证据',
    async status => {
      const store = new InMemorySendOperationStore();
      await store.claim({
        operationId: 'op-final',
        fingerprint: createSendOperationFingerprint({
          targetSessionId: '93001',
          messageType: 'text',
          content: '终态保护',
        }),
      });
      const receipt = {
        draftId: '-1',
        sessionId: '93001',
        code: 0,
        messageId: '135700000',
        ...(status === 'failed' ? { businessCode: 617 } : {}),
      };
      const confirmed = store.update(
        'op-final',
        status === 'sent'
          ? { status, messageId: '135700000', receipt, isPreTrigger: false }
          : { status, error: '业务失败617', nativeCode: 617, receipt, isPreTrigger: false }
      );
      const weaker = store.update('op-final', { status: 'unknown', error: '较晚的CDP响应丢失' });
      const [final, late] = await Promise.all([confirmed, weaker]);
      expect(late).toEqual(final);
      expect(await store.get('op-final')).toEqual(final);
      expect(final.receipt).toEqual(receipt);
    }
  );

  it('同一 operationId 同内容重放只发送一次并复用 sent', async () => {
    const store = new InMemorySendOperationStore();
    const driver = new FakeKK9Driver(store);
    driver.setSendBehavior({ mode: 'success', messageId: 'native-1' });

    const first = await driver.sendText('回答内容', {
      targetSessionId: '  session-1  ',
      operationId: 'op-1',
    });
    const replay = await driver.sendText('回答内容', {
      targetSessionId: 'session-1',
      operationId: 'op-1',
    });

    expect(first).toMatchObject({
      operationId: 'op-1',
      status: 'sent',
      messageId: 'native-1',
    });
    expect(replay).toEqual(first);
    expect(driver.recordedCalls).toHaveLength(1);
  });

  it('SendFileOptions 的 operationId 同样参与发送防重', async () => {
    const driver = new FakeKK9Driver();
    driver.setSendBehavior({ mode: 'success', messageId: 'native-file' });

    const first = await driver.sendFile('report.pdf', {
      targetSessionId: 'session-1',
      operationId: 'op-file',
    });
    const replay = await driver.sendFile('report.pdf', {
      targetSessionId: 'session-1',
      operationId: 'op-file',
    });

    expect(first).toMatchObject({
      operationId: 'op-file',
      status: 'sent',
      messageId: 'native-file',
    });
    expect(replay).toEqual(first);
    expect(driver.recordedCalls).toHaveLength(1);
  });

  it('空白 operationId 在发送前拒绝且不记录调用', async () => {
    const driver = new FakeKK9Driver();

    await expect(
      driver.sendText('回答内容', {
        targetSessionId: 'session-1',
        operationId: '   ',
      })
    ).rejects.toThrow();
    expect(driver.recordedCalls).toHaveLength(0);
  });

  it('同一 operationId 更换回复或提及参数时在发送前拒绝', async () => {
    const driver = new FakeKK9Driver();
    await driver.sendText('回答内容', {
      targetSessionId: 'session-1',
      operationId: 'op-reply',
      replyTo: 'message-1',
    });

    await expect(
      driver.sendText('回答内容', {
        targetSessionId: 'session-1',
        operationId: 'op-reply',
        replyTo: 'message-2',
      })
    ).rejects.toThrow();

    await driver.sendRichText('回答内容', {
      targetSessionId: 'session-1',
      operationId: 'op-mentions',
      mentions: ['employee-1'],
    });
    await expect(
      driver.sendRichText('回答内容', {
        targetSessionId: 'session-1',
        operationId: 'op-mentions',
        mentions: ['employee-2'],
      })
    ).rejects.toThrow();
    expect(driver.recordedCalls).toHaveLength(2);
  });

  it('同一 operationId 更换目标会话时在发送前拒绝', async () => {
    const driver = new FakeKK9Driver();
    await driver.sendText('回答内容', {
      targetSessionId: 'session-1',
      operationId: 'op-1',
    });

    await expect(
      driver.sendText('回答内容', {
        targetSessionId: 'session-2',
        operationId: 'op-1',
      })
    ).rejects.toThrow();
    expect(driver.recordedCalls).toHaveLength(1);
  });

  it('同一 operationId 更换消息类型时在发送前拒绝', async () => {
    const driver = new FakeKK9Driver();
    await driver.sendText('回答内容', {
      targetSessionId: 'session-1',
      operationId: 'op-1',
    });

    await expect(
      driver.sendRichText('回答内容', {
        targetSessionId: 'session-1',
        operationId: 'op-1',
      })
    ).rejects.toThrow();
    expect(driver.recordedCalls).toHaveLength(1);
  });

  it('同一 operationId 更换内容时在发送前拒绝', async () => {
    const driver = new FakeKK9Driver();
    await driver.sendText('回答内容', {
      targetSessionId: 'session-1',
      operationId: 'op-1',
    });

    await expect(
      driver.sendText('不同内容', {
        targetSessionId: 'session-1',
        operationId: 'op-1',
      })
    ).rejects.toThrow();
    expect(driver.recordedCalls).toHaveLength(1);
  });

  it('unknown 重放不盲目再次发送', async () => {
    const driver = new FakeKK9Driver();
    driver.setSendBehavior({ mode: 'post_trigger_timeout', error: '回执丢失' });

    const first = await driver.sendText('回答内容', {
      targetSessionId: 'session-1',
      operationId: 'op-1',
    });
    const replay = await driver.sendText('回答内容', {
      targetSessionId: 'session-1',
      operationId: 'op-1',
    });

    expect(first).toMatchObject({
      operationId: 'op-1',
      status: 'unknown',
      isPreTrigger: false,
    });
    expect(replay).toEqual(first);
    expect(driver.recordedCalls).toHaveLength(1);
  });

  it('确定前置失败同一意图重放失败，新意图才允许发送', async () => {
    const driver = new FakeKK9Driver();
    driver.setSendBehavior({
      mode: 'sequence',
      behaviors: [
        { mode: 'pre_trigger_failure', error: '会话切换失败' },
        { mode: 'success', messageId: 'native-2' },
      ],
    });

    const failed = await driver.sendText('回答内容', {
      targetSessionId: 'session-1',
      operationId: 'op-1',
    });
    const retried = await driver.sendText('回答内容', {
      targetSessionId: 'session-1',
      operationId: 'op-1',
    });

    expect(failed).toMatchObject({
      operationId: 'op-1',
      status: 'failed',
      isPreTrigger: true,
    });
    expect(retried).toMatchObject({
      operationId: 'op-1',
      status: 'failed',
      isPreTrigger: true,
    });
    const next = await driver.sendText('回答内容', {
      targetSessionId: 'session-1',
      operationId: 'op-next',
    });
    expect(next).toMatchObject({ status: 'sent', messageId: 'native-2' });
    expect(driver.recordedCalls).toHaveLength(2);
  });

  it('共享 Store 的并发调用只允许一个发送者触发动作', async () => {
    const store = new InMemorySendOperationStore();
    const firstDriver = new FakeKK9Driver(store);
    const secondDriver = new FakeKK9Driver(store);
    let markStarted = (): void => {};
    let release = (): void => {};
    const started = new Promise<void>(resolve => {
      markStarted = resolve;
    });
    const released = new Promise<void>(resolve => {
      release = resolve;
    });

    firstDriver.setSendBehavior({
      mode: 'custom',
      handler: async () => {
        markStarted();
        await released;
        return { status: 'sent', messageId: 'native-concurrent' };
      },
    });

    const firstPromise = firstDriver.sendText('回答内容', {
      targetSessionId: 'session-1',
      operationId: 'op-concurrent',
    });
    await started;

    const concurrent = await secondDriver.sendText('回答内容', {
      targetSessionId: 'session-1',
      operationId: 'op-concurrent',
    });
    release();
    const first = await firstPromise;

    expect(concurrent).toMatchObject({
      operationId: 'op-concurrent',
      status: 'unknown',
    });
    expect(first).toMatchObject({
      operationId: 'op-concurrent',
      status: 'sent',
      messageId: 'native-concurrent',
    });
    expect(firstDriver.recordedCalls).toHaveLength(1);
    expect(secondDriver.recordedCalls).toHaveLength(0);
  });

  it('没有operationId仍登记独立意图并可按返回ID查询', async () => {
    const driver = new FakeKK9Driver();
    driver.setSendBehavior({ mode: 'success', messageId: 'legacy-1' });

    const result = await driver.sendText('自动意图内容', { targetSessionId: 'session-1' });

    expect(result).toMatchObject({ messageId: 'legacy-1', status: 'sent', isPreTrigger: false });
    expect(result.operationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(await driver.getSendStatus(result.operationId)).toEqual(result);
    expect(driver.recordedCalls).toHaveLength(1);
  });

  it('FakeDriver 五类原生媒体门面共享 operationId 防重合同', async () => {
    const driver = new FakeKK9Driver();
    driver.setSendBehavior({ mode: 'success', messageId: 'native-media' });
    const sends = [
      () =>
        driver.sendUrlCard(
          { title: '链接', summary: '摘要', linkUrl: 'https://example.com' },
          { targetSessionId: 'session-1', operationId: 'op-fake-url' }
        ),
      () =>
        driver.sendBizMessage(
          { title: '业务', content: '正文' },
          { targetSessionId: 'session-1', operationId: 'op-fake-biz' }
        ),
      () =>
        driver.sendAppMessage(
          { title: '应用', content: '<p>正文</p>' },
          { targetSessionId: 'session-1', operationId: 'op-fake-app' }
        ),
      () =>
        driver.sendChatRecord(
          { title: '记录', msgArray: [{ senderName: '甲', contentType: 0, content: '内容' }] },
          { targetSessionId: 'session-1', operationId: 'op-fake-record' }
        ),
      () =>
        driver.sendVoice(
          { text: '语音' },
          { targetSessionId: 'session-1', operationId: 'op-fake-voice' }
        ),
    ];

    for (const send of sends) {
      const first = await send();
      const replay = await send();
      expect(first).toMatchObject({ status: 'sent', messageId: 'native-media' });
      expect(replay).toEqual(first);
    }
    expect(driver.recordedCalls.map(call => call.type)).toEqual([
      'urlCard',
      'bizMessage',
      'appMessage',
      'chatRecord',
      'voice',
    ]);
  });
});
