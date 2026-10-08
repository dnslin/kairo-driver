import { describe, it, expect, beforeEach } from 'vitest';
import { FakeKK9Driver } from '../src/fake-driver.js';
import { InMemorySendOperationStore } from '../src/send-operation.js';
import type { KK9Employee, KK9Message, KK9Session } from '../src/types/index.js';

describe('FakeKK9Driver 故障注入与契约实现测试 (IKK9Driver)', () => {
  let driver: FakeKK9Driver;

  beforeEach(() => {
    driver = new FakeKK9Driver();
  });

  it('当前身份可从未登录切换账号并再次退出登录', async () => {
    await expect(driver.getCurrentUserId()).resolves.toBeNull();

    driver.setCurrentUserId('91001');
    await expect(driver.getCurrentUserId()).resolves.toBe('91001');

    driver.setCurrentUserId('91003');
    await expect(driver.getCurrentUserId()).resolves.toBe('91003');

    driver.setCurrentUserId(null);
    await expect(driver.getCurrentUserId()).resolves.toBeNull();
  });

  it('私聊场景(test-employee)与群聊场景(test-group)发送记录与返回原生消息 ID', async () => {
    const resPrivate = await driver.sendText('私聊测试', { targetSessionId: 'test-employee' });
    expect(resPrivate).toMatchObject({ status: 'sent', isPreTrigger: false });
    expect(resPrivate.messageId).toBeDefined();
    expect(driver.recordedCalls).toHaveLength(1);
    expect(driver.recordedCalls[0]?.payload).toBe('私聊测试');
    expect(driver.recordedCalls[0]?.options?.targetSessionId).toBe('test-employee');

    const resGroup = await driver.sendRichText('群聊测试', {
      targetSessionId: 'test-group',
      mentions: ['all'],
    });
    expect(resGroup.status).toBe('sent');
    expect(driver.recordedCalls).toHaveLength(2);

    const resReply = await driver.sendReply('msg_1001', '回复内容', {
      targetSessionId: 'test-group',
    });
    expect(resReply.status).toBe('sent');
    expect(driver.recordedCalls[2]?.type).toBe('reply');
  });

  it('pre_trigger_failure: 正确标识为 isPreTrigger = true', async () => {
    driver.setSendBehavior({
      mode: 'pre_trigger_failure',
      error: '参数校验失败，发送未触发',
    });

    const res = await driver.sendText('测试内容', { targetSessionId: 'test-employee' });
    expect(res).toMatchObject({ status: 'failed', isPreTrigger: true });
    expect(res.isPreTrigger).toBe(true);
    expect(res.error).toBe('参数校验失败，发送未触发');
  });

  it('post_trigger_timeout: 正确标识为 isPreTrigger = false', async () => {
    driver.setSendBehavior({
      mode: 'post_trigger_timeout',
      error: 'CDP 超时未收到回执',
    });

    const res = await driver.sendText('超时内容', { targetSessionId: '93001' });
    expect(res).toMatchObject({ status: 'unknown', isPreTrigger: false });
    expect(res.isPreTrigger).toBe(false);
    expect(res.error).toBe('CDP 超时未收到回执');
  });

  it('触发后断开连接返回未知', async () => {
    driver.setSendBehavior({
      mode: 'post_trigger_disconnect',
      error: '发送过程中断开',
    });

    const res = await driver.sendText('断连内容', { targetSessionId: '93001' });

    expect(res).toMatchObject({
      status: 'unknown',
      isPreTrigger: false,
      error: '发送过程中断开',
    });
  });

  it('触发后丢失响应返回未知', async () => {
    driver.setSendBehavior({
      mode: 'post_trigger_lost_response',
      error: '发送响应丢失',
    });

    const res = await driver.sendText('丢失响应内容', { targetSessionId: '93001' });

    expect(res).toMatchObject({
      status: 'unknown',
      isPreTrigger: false,
      error: '发送响应丢失',
    });
  });

  it('自定义处理器明确unknown，查询不会把暂有回执改判成功', async () => {
    const receipt = { draftId: '-1', sessionId: '93001', code: 0, messageId: '135700001' };
    driver.setSendBehavior({
      mode: 'custom',
      handler: () => ({ status: 'unknown', receipt, isPreTrigger: false }),
    });
    const result = await driver.sendText('证据不足', { targetSessionId: '93001' });
    expect(result).toMatchObject({ status: 'unknown', receipt, isPreTrigger: false });
    expect(result.messageId).toBeUndefined();
    expect(await driver.getSendStatus(result.operationId)).toEqual(result);
    expect(driver.recordedCalls).toHaveLength(1);
  });

  it('共享 Store 的新 FakeDriver 可以查询已有发送操作', async () => {
    const store = new InMemorySendOperationStore();
    const sender = new FakeKK9Driver(store);
    sender.setSendBehavior({ mode: 'success', messageId: 'shared-native-1' });

    const sent = await sender.sendText('共享查询内容', {
      targetSessionId: 'session-shared',
      operationId: 'op-shared',
    });
    const observer = new FakeKK9Driver(store);
    const status = await observer.getSendStatus('op-shared');

    expect(sent).toMatchObject({ status: 'sent', messageId: 'shared-native-1' });
    expect(status).toEqual(sent);
    expect(observer.recordedCalls).toHaveLength(0);
  });

  it('同一 operationId 的 fingerprint 冲突仍在发送前拒绝', async () => {
    await driver.sendText('原始内容', {
      targetSessionId: 'session-conflict',
      operationId: 'op-conflict',
    });

    await expect(
      driver.sendText('冲突内容', {
        targetSessionId: 'session-conflict',
        operationId: 'op-conflict',
      })
    ).rejects.toThrow('fingerprint');
    expect(driver.recordedCalls).toHaveLength(1);
  });

  it('sequence: 支持模拟顺序执行 (前置失败 -> 成功)', async () => {
    driver.setSendBehavior({
      mode: 'sequence',
      behaviors: [
        { mode: 'pre_trigger_failure', error: '瞬时切换失败' },
        { mode: 'success', messageId: 'kk_seq_success' },
      ],
    });

    const res1 = await driver.sendText('重试第1次', { targetSessionId: '93001' });
    expect(res1.status).toBe('failed');
    expect(res1.isPreTrigger).toBe(true);

    const res2 = await driver.sendText('重试第2次', { targetSessionId: '93001' });
    expect(res2.status).toBe('sent');
    expect(res2.messageId).toBe('kk_seq_success');
    expect(driver.recordedCalls.length).toBe(2);
  });

  it('会话管理与组织架构模拟数据装载', async () => {
    const mockSessions: KK9Session[] = [
      {
        id: '93001',
        name: 'test-employee',
        type: 'private',
        nativeType: 0,
        receiverId: '91001',
        unread: false,
      },
      {
        id: '93002',
        name: 'test-group',
        type: 'group',
        nativeType: 1,
        receiverId: '92001',
        unread: true,
        unreadCount: 1,
      },
    ];
    driver.setSessions(mockSessions);

    const sessions = await driver.getSessions();
    expect(sessions).toHaveLength(2);

    const switched = await driver.selectSession('test-employee');
    expect(switched).toBe(true);
    expect(driver.selectSessionCallsCount).toBe(1);

    const markRead = await driver.markSessionRead('test-group');
    expect(markRead).toBe(true);
    expect(driver.markSessionReadCallsCount).toBe(1);

    const mockEmployees: KK9Employee[] = [
      {
        id: 91001,
        name: '测试员工',
        loginName: 'TEST-EMP-001',
        position: 'IT开发工程师',
        updatedAt: Date.now(),
      },
    ];
    driver.setEmployees(mockEmployees);

    const emps = await driver.getOrgEmployees();
    expect(emps).toHaveLength(1);

    const user = await driver.getUserProfile(91001);
    expect(user?.name).toBe('测试员工');

    const fromSesId = await driver.getEmployeeBySession('93001');
    expect(fromSesId?.loginName).toBe('TEST-EMP-001');

    const fromGroup = await driver.getEmployeeBySession('93002');
    expect(fromGroup).toBeNull();
  });
  it('历史按原生会话隔离且不重放实时事件，不以当前窗口选择目标', async () => {
    const first: KK9Session = {
      id: '93001',
      name: '甲',
      type: 'private',
      nativeType: 0,
      receiverId: '91002',
      unread: false,
    };
    const second: KK9Session = { ...first, id: '93002', name: '乙', receiverId: '91003' };
    const message: KK9Message = {
      id: '1001',
      messageId: '1001',
      msgIdx: 5,
      sessionId: first.id,
      sessionName: first.name,
      sessionType: first.type,
      sender: '甲',
      content: '甲的历史',
      time: '12:00',
      isMe: false,
      direction: 'inbound',
      timestamp: 100,
    };
    driver.setSessions([first, second]);
    driver.setMessages([
      message,
      { ...message, id: '1002', sessionId: second.id, content: '乙的历史' },
    ]);
    await driver.selectSession(second.id);
    const events: unknown[] = [];
    driver.on('message', item => events.push(item));
    const history = await driver.getRecentMessages(first, 1);
    expect(
      history.map(item => ({ id: item.id, sessionId: item.sessionId, content: item.content }))
    ).toEqual([{ id: '1001', sessionId: '93001', content: '甲的历史' }]);
    expect(events).toEqual([]);
    await expect(driver.getRecentMessages({ ...first, id: '93003' }, 1)).resolves.toEqual([]);
  });
});
