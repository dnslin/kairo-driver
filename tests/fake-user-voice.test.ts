import { describe, expect, it } from 'vitest';
import { FakeKK9Driver } from '../src/fake-driver.js';
import { createNativeMessageKey } from '../src/bridge/send-status.js';
import { InMemorySendOperationStore } from '../src/send-operation.js';
import type {
  KK9Employee,
  KK9Message,
  KK9Session,
  KK9VoiceOptions,
  SendOptions,
} from '../src/types/index.js';

const voice: KK9VoiceOptions = { text: '定向语音' };
const targetSession: KK9Session = {
  id: '93003',
  name: '同名员工',
  type: 'private',
  nativeType: 0,
  receiverId: '91003',
  unread: false,
};
const otherSession: KK9Session = { ...targetSession, id: '93002', receiverId: '91002' };

function fakeVoiceRuntime(store = new InMemorySendOperationStore()) {
  const driver = new FakeKK9Driver(store);
  driver.setCurrentUserId('91001');
  driver.setEmployees([
    { id: 91002, loginName: '00abc', name: '同名员工', updatedAt: 1 },
    { id: 91004, loginName: 'AbC', name: '同名员工', updatedAt: 1 },
    { id: 91003, loginName: '00AbC', name: '同名员工', updatedAt: 1 },
    { id: '91003', loginName: '00AbC', name: '同名员工', updatedAt: 1 },
  ]);
  return driver;
}

// 只验证Fake的目标、状态与历史契约，不把替身发送当作真实合成、上传或播放证据。
describe('Fake语音按准确工号发送', () => {
  it.each([
    { label: '文本合成', input: voice },
    { label: '本地文件', input: { filePath: 'C:\\tmp\\voice.wav' } satisfies KK9VoiceOptions },
  ])('$label保留大小写和前导零，首次分配私聊并复用，不制造消息历史', async ({ input }) => {
    const driver = fakeVoiceRuntime();
    const occupied: KK9Session = {
      id: '1',
      name: '已占用会话',
      type: 'group',
      nativeType: 1,
      receiverId: '92001',
      unread: false,
    };
    driver.setSessions([occupied]);
    const messages: KK9Message[] = [];
    driver.on('message', message => messages.push(message));

    const first = await driver.sendVoice(input, {
      operationId: 'fake-voice-first',
      targetLoginName: ' 00AbC ',
    });

    expect(first).toMatchObject({ status: 'sent', isPreTrigger: false });
    expect(first.sessionId).toMatch(/^[1-9]\d*$/);
    expect(first.sessionId).not.toBe(occupied.id);
    const sessions = await driver.getSessions();
    expect(sessions).toHaveLength(2);
    const session = sessions.find(item => item.id === first.sessionId);
    expect(session).toMatchObject({ ...targetSession, id: first.sessionId });
    if (!session) throw new Error('成功发送缺少正式私聊');
    expect(await driver.getEmployeeBySession(session)).toMatchObject({
      id: 91003,
      loginName: '00AbC',
    });
    expect(await driver.getRecentMessages(session)).toEqual([]);
    expect(await driver.scanCompensationWindow({ fromTimestamp: 0 })).toEqual([]);
    expect(messages).toEqual([]);

    const second = await driver.sendVoice(input, {
      operationId: 'fake-voice-second',
      targetLoginName: '00AbC',
    });
    expect(second).toMatchObject({ status: 'sent', sessionId: first.sessionId });
    expect(await driver.getSessions()).toHaveLength(2);
    expect(driver.recordedCalls).toHaveLength(2);
    expect(driver.recordedCalls[0]).toMatchObject({ type: 'voice', targetLoginName: '00AbC' });
    expect(driver.recordedCalls[0]?.options?.targetSessionId).toBeUndefined();
  });

  it('已有私聊按接收人复用，同操作跨实例重放只读，改变准确目标拒绝复用', async () => {
    const store = new InMemorySendOperationStore();
    const driver = fakeVoiceRuntime(store);
    const group: KK9Session = { ...targetSession, id: '93001', type: 'group', nativeType: 1 };
    driver.setSessions([group, otherSession, targetSession]);
    const options = { operationId: 'fake-voice-replay', targetLoginName: ' 00AbC ' };
    const first = await driver.sendVoice(voice, options);
    expect(first).toMatchObject({ status: 'sent', sessionId: targetSession.id });
    expect(await driver.getSessions()).toEqual([group, otherSession, targetSession]);

    driver.setEmployees([]);
    driver.setCurrentUserId(null);
    expect(await driver.sendVoice(voice, { ...options, targetLoginName: '00AbC' })).toEqual(first);
    expect(await driver.getSendStatus(options.operationId)).toEqual(first);
    const observer = new FakeKK9Driver(store);
    expect(await observer.sendVoice(voice, options)).toEqual(first);
    expect(await observer.getSendStatus(options.operationId)).toEqual(first);
    for (const target of [
      { targetLoginName: '00abc' },
      { targetLoginName: 'AbC' },
      { targetSessionId: targetSession.id },
    ]) {
      await expect(
        observer.sendVoice(voice, { operationId: options.operationId, ...target })
      ).rejects.toThrow('fingerprint');
    }
    expect(driver.recordedCalls).toHaveLength(1);
    expect(observer.recordedCalls).toEqual([]);
    expect(await observer.getSessions()).toEqual([]);
  });

  it.each([false, true])(
    '正式会话结果关联准确历史、本人事件及撤回，不影响跨会话同号（已有私聊：%s）',
    async hasSession => {
      const driver = fakeVoiceRuntime();
      driver.setSessions(hasSession ? [otherSession, targetSession] : [otherSession]);
      const message: KK9Message = {
        id: '1001',
        sessionId: targetSession.id,
        sessionName: targetSession.name,
        sessionType: 'private',
        sender: '本人',
        senderId: '91001',
        direction: 'outbound',
        isMe: true,
        messageType: 'voice',
        content: '已注入的正式语音',
        time: '12:00',
        timestamp: 100,
      };
      const otherMessage = { ...message, sessionId: otherSession.id };
      driver.setMessages([message, otherMessage]);
      const receipt = {
        draftId: '-1',
        sessionId: targetSession.id,
        code: 0,
        messageId: message.id,
      };
      driver.setSendBehavior({
        mode: 'custom',
        handler: () => ({
          status: 'sent',
          sessionId: targetSession.id,
          messageId: message.id,
          receipt,
          isPreTrigger: false,
        }),
      });
      const events: KK9Message[] = [];
      const recalled: Array<{ messageId: string; sessionId: string }> = [];
      driver.on('message', event => events.push(event));
      driver.on('recalled', event => recalled.push(event));
      const options = { operationId: 'fake-voice-formal', targetLoginName: '00AbC' };

      const result = await driver.sendVoice(voice, options);

      expect(await driver.getSendStatus(options.operationId)).toEqual(result);
      expect(await driver.getSessions()).toEqual([otherSession, targetSession]);
      const session = (await driver.getSessions()).find(item => item.id === result.sessionId);
      if (!session || !result.messageId) throw new Error('正式结果缺少准确会话或消息ID');
      expect(await driver.getRecentMessages(session)).toEqual([message]);
      expect(events).toEqual([]);
      driver.emitMessage(message);
      driver.emitMessage(otherMessage);
      expect(events.map(event => ({ sessionId: event.sessionId, key: event.sdkSendKey }))).toEqual([
        { sessionId: targetSession.id, key: createNativeMessageKey('voice', options.operationId) },
        { sessionId: otherSession.id, key: undefined },
      ]);
      expect(await driver.recallMessage(result.messageId, result.sessionId!)).toBe(true);
      expect(message.isRecalled).toBe(true);
      expect(otherMessage.isRecalled).toBeUndefined();
      expect(recalled).toMatchObject([{ messageId: message.id, sessionId: targetSession.id }]);
    }
  );

  it('未知结果即使携带会话和回执也不建立私聊，共享Store查询或重放不重发', async () => {
    const store = new InMemorySendOperationStore();
    const driver = fakeVoiceRuntime(store);
    const options = { operationId: 'fake-voice-unknown', targetLoginName: '00AbC' };
    const receipt = { draftId: '-1', sessionId: targetSession.id, code: 0, messageId: '1001' };
    driver.setSendBehavior({
      mode: 'custom',
      handler: () => ({
        status: 'unknown',
        sessionId: targetSession.id,
        receipt,
        isPreTrigger: false,
      }),
    });
    const first = await driver.sendVoice(voice, options);
    expect(first).toMatchObject({ status: 'unknown', isPreTrigger: false });
    expect(first.sessionId).toBeUndefined();
    expect(first.messageId).toBeUndefined();
    expect(await driver.getSessions()).toEqual([]);
    driver.setSendBehavior({ mode: 'success' });
    driver.setEmployees([]);
    driver.setCurrentUserId(null);
    expect(await driver.sendVoice(voice, options)).toEqual(first);
    expect(await driver.getSendStatus(options.operationId)).toEqual(first);
    const observer = new FakeKK9Driver(store);
    expect(await observer.sendVoice(voice, options)).toEqual(first);
    expect(await observer.getSendStatus(options.operationId)).toEqual(first);
    await expect(
      observer.sendVoice(voice, { ...options, targetLoginName: '00abc' })
    ).rejects.toThrow('fingerprint');
    expect(driver.recordedCalls).toHaveLength(1);
    expect(observer.recordedCalls).toEqual([]);
    expect(await driver.getSessions()).toEqual([]);
    expect(await observer.getSessions()).toEqual([]);
  });

  it.each([
    { label: '没有目标', target: {} },
    { label: '空工号', target: { targetLoginName: '' } },
    { label: '空白工号', target: { targetLoginName: '   ' } },
    { label: '同时指定会话', target: { targetLoginName: '00AbC', targetSessionId: '93003' } },
    { label: '同时指定空会话', target: { targetLoginName: '00AbC', targetSessionId: '' } },
    { label: '显示名不是工号', target: { targetLoginName: '同名员工' } },
  ] satisfies Array<{ label: string; target: SendOptions }>)(
    '$label在记录发送或创建会话前失败',
    async ({ target }) => {
      const driver = fakeVoiceRuntime();
      const result = await driver.sendVoice(voice, target);
      expect(result).toMatchObject({ status: 'failed', isPreTrigger: true });
      expect(result.sessionId).toBeUndefined();
      expect(await driver.getSendStatus(result.operationId)).toEqual(result);
      expect(driver.recordedCalls).toEqual([]);
      expect(await driver.getSessions()).toEqual([]);
    }
  );

  it.each([
    {
      label: '大小写不符',
      identity: '91001',
      employees: [{ id: 91003, loginName: '00abc', name: '员工', updatedAt: 1 }],
    },
    {
      label: '缺少前导零',
      identity: '91001',
      employees: [{ id: 91003, loginName: 'AbC', name: '员工', updatedAt: 1 }],
    },
    {
      label: '没有登录身份',
      identity: null,
      employees: [{ id: 91003, loginName: '00AbC', name: '员工', updatedAt: 1 }],
    },
    {
      label: '目标是本人',
      identity: '91003',
      employees: [{ id: 91003, loginName: '00AbC', name: '本人', updatedAt: 1 }],
    },
    {
      label: '多个UID歧义',
      identity: '91001',
      employees: [
        { id: 91003, loginName: '00AbC', name: '甲', updatedAt: 1 },
        { id: 91004, loginName: '00AbC', name: '乙', updatedAt: 1 },
      ],
    },
  ] satisfies Array<{ label: string; identity: string | null; employees: KK9Employee[] }>)(
    '$label不产生私聊或发送记录',
    async ({ identity, employees }) => {
      const driver = fakeVoiceRuntime();
      driver.setCurrentUserId(identity);
      driver.setEmployees(employees);
      const result = await driver.sendVoice(voice, { targetLoginName: '00AbC' });
      expect(result).toMatchObject({ status: 'failed', isPreTrigger: true });
      expect(result.sessionId).toBeUndefined();
      expect(await driver.getSendStatus(result.operationId)).toEqual(result);
      expect(driver.recordedCalls).toEqual([]);
      expect(await driver.getSessions()).toEqual([]);
    }
  );

  describe.each([
    { label: '工号目标', target: { targetLoginName: '00AbC' } },
    { label: '会话目标', target: { targetSessionId: '93003' } },
  ])('$label', ({ target }) => {
    it.each([
      { label: '引用', extra: { replyTo: '1001' } },
      { label: '提及', extra: { mentions: [{ uid: 91003, name: '员工' }] } },
    ] satisfies Array<{ label: string; extra: SendOptions }>)(
      '拒绝$label且不消耗发送故障序列',
      async ({ extra }) => {
        const driver = fakeVoiceRuntime();
        driver.setSendBehavior({
          mode: 'sequence',
          behaviors: [{ mode: 'pre_trigger_failure', error: '原定首个故障' }, { mode: 'success' }],
        });
        const invalid = await driver.sendVoice(voice, { ...target, ...extra });
        expect(invalid).toMatchObject({ status: 'failed', isPreTrigger: true });
        expect(invalid.error).toContain('语音消息不支持replyTo或mentions');
        expect(await driver.getSendStatus(invalid.operationId)).toEqual(invalid);
        expect(driver.recordedCalls).toEqual([]);
        expect(await driver.getSessions()).toEqual([]);
        expect(await driver.sendVoice(voice, target)).toMatchObject({
          status: 'failed',
          error: '原定首个故障',
        });
        expect(await driver.getSessions()).toEqual([]);
        expect(driver.recordedCalls).toHaveLength(1);
      }
    );
  });
});
