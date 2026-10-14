import { describe, it, expect, beforeEach } from 'vitest';
import { FakeKK9Driver } from '../src/fake-driver.js';
import { InMemorySendOperationStore } from '../src/send-operation.js';
import type { KK9Employee, KK9EmployeeSearchItem, KK9Message, KK9Session } from '../src/types/index.js';
import { createNativeMessageKey } from '../src/bridge/send-status.js';

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
      mentions: [{ uid: 91002, name: '员工甲' }],
    });
    expect(resGroup.status).toBe('sent');
    expect(driver.recordedCalls).toHaveLength(2);
    driver.setMessages([{ id: '1001', sessionId: 'test-group', sessionName: '群甲', sessionType: 'group', sender: '员工甲', senderId: '91002', msgIdx: 7, content: '原文', time: '', isMe: false, direction: 'inbound', timestamp: 1 }]);

    const resReply = await driver.sendReply('1001', '回复内容', {
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


    expect(await driver.markSessionRead('test-group')).toBe(false);
    expect(await driver.markSessionRead('93002')).toBe(true);
    expect((await driver.getSessions()).find(s => s.id === '93002')).toMatchObject({ unread: false, unreadCount: 0, unreadAt: false });

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

  it('员工搜索保留同名不同 UID，并按 UID 合并全部部门路径与缺失档案字段', async () => {
    driver.setSearchEmployees([
      { id: '91002', name: null, loginName: null, departmentPaths: ['总部 / 研发', '', '   '] },
      { id: '91003', name: '同名员工', loginName: 'EMP-003', departmentPaths: ['总部 / 财务'] },
      { id: '091002', name: '同名员工', loginName: 'EMP-002', departmentPaths: ['总部 / 研发', '总部 / 测试'] },
      { id: '91002', name: '', loginName: '', departmentPaths: null },
    ]);

    const employees: KK9EmployeeSearchItem[] = [
      { id: '91002', name: '同名员工', loginName: 'EMP-002', departmentPaths: ['总部 / 研发', '总部 / 测试'] },
      { id: '91003', name: '同名员工', loginName: 'EMP-003', departmentPaths: ['总部 / 财务'] },
    ];
    await expect(driver.searchEmployees(' 同名员工 ')).resolves.toEqual({ employees, hasMore: false });
    await expect(driver.searchEmployees('EMP-002')).resolves.toEqual({ employees: [employees[0]], hasMore: false });
  });

  it('员工搜索仅使用独立注入的姓名或真实工号，空字段不以 UID 或展示档案回退', async () => {
    driver.setEmployees([{ id: 91001, name: '展示姓名', loginName: '展示工号', updatedAt: 1 }]);
    await expect(driver.searchEmployees('展示')).resolves.toEqual({ employees: [], hasMore: false });
    driver.setSearchEmployees([
      { id: '91001', name: null, loginName: null, departmentPaths: null },
      { id: '91002', name: '只有姓名', loginName: '', departmentPaths: [] },
      { id: '91003', name: '  ', loginName: 'EMP-003', departmentPaths: ['', '  '] },
    ]);

    await expect(driver.searchEmployees('91001')).resolves.toEqual({ employees: [], hasMore: false });
    await expect(driver.searchEmployees('只有姓名')).resolves.toEqual({
      employees: [{ id: '91002', name: '只有姓名', loginName: null, departmentPaths: null }],
      hasMore: false,
    });
    await expect(driver.searchEmployees('EMP-003')).resolves.toEqual({
      employees: [{ id: '91003', name: null, loginName: 'EMP-003', departmentPaths: null }],
      hasMore: false,
    });
  });

  it('员工搜索按字面子串过滤并返回空结果，不扩展拼音、正则或部门关键词', async () => {
    const employee: KK9EmployeeSearchItem = {
      id: '91002', name: ' 董仕林 ', loginName: ' EMP.002 ', departmentPaths: [' 总部 / 研发 '],
    };
    driver.setSearchEmployees([
      employee,
      { id: '91003', name: '其他员工', loginName: 'EMPX003', departmentPaths: null },
    ]);

    await expect(driver.searchEmployees('  仕林\t', 1000)).resolves.toEqual({ employees: [employee], hasMore: false });
    await expect(driver.searchEmployees('EMP.')).resolves.toEqual({ employees: [employee], hasMore: false });
    for (const keyword of ['dongshilin', '.*', '研发', '不存在']) {
      await expect(driver.searchEmployees(keyword)).resolves.toEqual({ employees: [], hasMore: false });
    }
  });

  it.each(['', '0', '-1', '1.5', 'NaN', 'Infinity', '9007199254740992'])(
    '员工搜索档案拒绝无效 UID（%j）', id => {
      expect(() => driver.setSearchEmployees([{ id, name: '员工', loginName: null, departmentPaths: null }]))
        .toThrow('UID 必须为正安全整数');
    }
  );

  it.each(['', ' \t\n '])('员工搜索拒绝空白关键词（%j）', async keyword => {
    await expect(driver.searchEmployees(keyword)).rejects.toMatchObject({
      name: 'DriverError', code: 'IPC_QUERY_FAILED', message: expect.stringMatching(/关键词/),
    });
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    '员工搜索拒绝无效总期限（%s）并提供期限诊断', async timeoutMs => {
      await expect(driver.searchEmployees('员工', timeoutMs)).rejects.toMatchObject({
        name: 'DriverError', code: 'IPC_QUERY_FAILED', message: expect.stringMatching(/期限|超时/),
      });
    }
  );

  it('员工搜索隔离注入对象与每次返回的对象和路径数组', async () => {
    const employee: KK9EmployeeSearchItem = {
      id: '91002', name: '原始员工', loginName: 'EMP-002', departmentPaths: ['总部 / 研发'],
    };
    const injected = [employee];
    driver.setSearchEmployees(injected);
    employee.name = '篡改注入姓名';
    employee.departmentPaths!.push('篡改注入路径');
    injected.length = 0;

    const first = await driver.searchEmployees('原始员工');
    expect(first).toEqual({
      employees: [{ id: '91002', name: '原始员工', loginName: 'EMP-002', departmentPaths: ['总部 / 研发'] }],
      hasMore: false,
    });
    first.employees[0]!.id = '篡改返回UID';
    first.employees[0]!.name = '篡改返回姓名';
    first.employees[0]!.loginName = '篡改返回工号';
    first.employees[0]!.departmentPaths!.push('篡改返回路径');
    first.employees.push({ id: '额外候选', name: '原始员工', loginName: null, departmentPaths: null });

    await expect(driver.searchEmployees('EMP-002')).resolves.toEqual({
      employees: [{ id: '91002', name: '原始员工', loginName: 'EMP-002', departmentPaths: ['总部 / 研发'] }],
      hasMore: false,
    });
    driver.setSearchEmployees([]);
    await expect(driver.searchEmployees('原始员工')).resolves.toEqual({ employees: [], hasMore: false });
  });

  it('员工搜索不修改会话、历史、发送记录或已读状态，也不派发事件', async () => {
    const session: KK9Session = {
      id: '93001', name: '已有会话', type: 'private', nativeType: 0, receiverId: '91002',
      unread: true, unreadCount: 2, unreadAt: true,
    };
    const message: KK9Message = {
      id: '1001', messageId: '1001', msgIdx: 1, sessionId: session.id, sessionName: session.name,
      sessionType: session.type, sender: '历史发送人', content: '已有历史', time: '12:00',
      isMe: false, direction: 'inbound', timestamp: 100,
    };
    driver.setSessions([session]);
    driver.setMessages([message]);
    driver.setSearchEmployees([{ id: '91002', name: '待查员工', loginName: 'EMP-002', departmentPaths: null }]);
    await driver.sendText('已有发送记录', { operationId: '搜索前发送', targetSessionId: session.id });
    const sessionsBefore = globalThis.structuredClone(await driver.getSessions());
    const historyBefore = globalThis.structuredClone(await driver.getRecentMessages(session));
    const callsBefore = globalThis.structuredClone(driver.recordedCalls);
    const events: string[] = [];
    driver.on('status', () => events.push('status'));
    driver.on('message', () => events.push('message'));
    driver.on('at', () => events.push('at'));
    driver.on('recalled', () => events.push('recalled'));
    driver.on('error', () => events.push('error'));
    driver.on('heartbeat', () => events.push('heartbeat'));
    driver.on('health', () => events.push('health'));

    await driver.searchEmployees('待查员工');
    await driver.searchEmployees('没有匹配');
    await expect(driver.searchEmployees(' ')).rejects.toMatchObject({ code: 'IPC_QUERY_FAILED' });
    await expect(driver.searchEmployees('待查员工', 0)).rejects.toMatchObject({ code: 'IPC_QUERY_FAILED' });

    expect(await driver.getSessions()).toEqual(sessionsBefore);
    expect(await driver.getRecentMessages(session)).toEqual(historyBefore);
    expect(driver.recordedCalls).toEqual(callsBefore);
    expect(driver.markSessionReadCallsCount).toBe(0);
    expect(events).toEqual([]);
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
    const events: unknown[] = [];
    driver.on('message', item => events.push(item));
    const history = await driver.getRecentMessages(first, 1);
    expect(
      history.map(item => ({ id: item.id, sessionId: item.sessionId, content: item.content }))
    ).toEqual([{ id: '1001', sessionId: '93001', content: '甲的历史' }]);
    expect(events).toEqual([]);
    await expect(driver.getRecentMessages({ ...first, id: '93003' }, 1)).resolves.toEqual([]);
  });

  it('Fake 只关联已确认的本次本人发送，跨会话同号与未知结果仍独立派发', async () => {
    driver.setCurrentUserId('91001');
    driver.setSendBehavior({ mode: 'success', messageId: '1001' });
    await driver.sendText('本人SDK文本', { targetSessionId: '93001', operationId: 'fake-confirmed' });
    const events: KK9Message[] = [];
    const ats: KK9Message[] = [];
    driver.on('message', message => events.push(message));
    driver.on('at', message => ats.push(message));
    const message: KK9Message = { id: '1001', sessionId: '93001', sessionName: '测试', sessionType: 'private',
      sender: '我', senderId: '91001', direction: 'unknown', isMe: false,
      content: '本人SDK文本', time: '12:00', timestamp: 100, atMe: true };
    driver.emitMessage(message);
    driver.emitMessage(message);
    driver.emitMessage({ ...message, sessionId: '93002' });
    driver.setSendBehavior({ mode: 'post_trigger_timeout' });
    await driver.sendText('未知文本', { targetSessionId: '93001', operationId: 'fake-unknown' });
    driver.emitMessage({ ...message, id: '1002', content: '未知后真实消息' });
    expect(events.map(item => ({ id: item.id, session: item.sessionId, direction: item.direction, key: item.sdkSendKey }))).toEqual([
      { id: '1001', session: '93001', direction: 'outbound', key: createNativeMessageKey('text', 'fake-confirmed') },
      { id: '1001', session: '93002', direction: 'outbound', key: undefined },
      { id: '1002', session: '93001', direction: 'outbound', key: undefined },
    ]);
    expect(ats).toEqual(events);
  });
  it('按工号精确匹配而非同名，成功分配不冲突的数字私聊并复用', async () => {
    driver.setCurrentUserId('91001');
    driver.setEmployees([
      { id: 91002, loginName: '员工甲', name: '同名员工', updatedAt: 1 },
      { id: 91003, loginName: 'EMP-003', name: '同名员工', updatedAt: 1 },
      { id: '91003', loginName: 'EMP-003', name: '同名员工', updatedAt: 1 },
    ]);
    driver.setSessions([{ id: '1', name: '已占用', type: 'group', nativeType: 1, receiverId: '92001', unread: false }]);
    driver.setSendBehavior({ mode: 'success', messageId: '1001' });

    const first = await driver.sendTextToUser(' EMP-003 ', '准确目标', { operationId: '按工号首次' });
    expect(first).toMatchObject({ status: 'sent', messageId: '1001', isPreTrigger: false });
    expect(first.sessionId).toMatch(/^[1-9]\d*$/);
    expect(first.sessionId).not.toBe('1');
    expect(first.receipt).toBeUndefined();
    const sessions = await driver.getSessions();
    expect(sessions).toHaveLength(2);
    expect(sessions[1]).toMatchObject({ id: first.sessionId, type: 'private', nativeType: 0, receiverId: '91003', name: '同名员工' });
    expect(driver.recordedCalls[0]).toMatchObject({ type: 'textToUser', targetLoginName: 'EMP-003', payload: '准确目标', options: { operationId: '按工号首次' } });
    expect(driver.recordedCalls[0]?.options?.targetSessionId).toBeUndefined();

    const second = await driver.sendTextToUser('EMP-003', '再次发送', { operationId: '按工号再次' });
    expect(second).toMatchObject({ status: 'sent', sessionId: first.sessionId });
    expect(await driver.getSessions()).toHaveLength(2);
    expect(driver.recordedCalls).toHaveLength(2);
  });

  it('按工号复用相同接收人的既有私聊，不复用同接收人群聊或其他私聊', async () => {
    driver.setCurrentUserId('91001');
    driver.setEmployees([{ id: 91003, loginName: 'EMP-003', name: '目标员工', updatedAt: 1 }]);
    driver.setSessions([
      { id: '93001', name: '同接收人群聊', type: 'group', nativeType: 1, receiverId: '91003', unread: false },
      { id: '93002', name: '其他人', type: 'private', nativeType: 0, receiverId: '91002', unread: false },
      { id: '93003', name: '目标员工', type: 'private', nativeType: 0, receiverId: '91003', unread: false },
    ]);
    const result = await driver.sendTextToUser('EMP-003', '复用已有私聊');
    expect(result).toMatchObject({ status: 'sent', sessionId: '93003' });
    expect(await driver.getSessions()).toHaveLength(3);
  });

  it.each([false, true])('自定义成功保留正式会话和回执，准确定位注入历史与撤回目标（已有私聊：%s）', async hasSession => {
    const store = new InMemorySendOperationStore();
    const sender = new FakeKK9Driver(store);
    sender.setCurrentUserId('91001');
    sender.setEmployees([{ id: 91003, loginName: 'EMP-003', name: '目标员工', updatedAt: 1 }]);
    const session: KK9Session = { id: '93003', name: '目标员工', type: 'private', nativeType: 0, receiverId: '91003', unread: false };
    const otherSession: KK9Session = { ...session, id: '93002', name: '其他人', receiverId: '91002' };
    sender.setSessions(hasSession ? [otherSession, session] : [otherSession]);
    const message: KK9Message = { id: '1001', sessionId: session.id, sessionName: session.name, sessionType: 'private', sender: '本人', senderId: '91001', direction: 'outbound', isMe: true, content: '注入的正式历史', time: '12:00', timestamp: 100 };
    const otherMessage: KK9Message = { ...message, sessionId: otherSession.id, sessionName: otherSession.name, content: '另一会话同号历史' };
    sender.setMessages([message, otherMessage]);
    const receipt = { draftId: '-1', sessionId: '93003', code: 0, messageId: '1001' };
    sender.setSendBehavior({ mode: 'custom', handler: () => ({ status: 'sent', sessionId: '93003', messageId: '1001', receipt, isPreTrigger: false }) });
    const events: KK9Message[] = [];
    const recalled: Array<{ messageId: string; sessionId: string }> = [];
    sender.on('message', item => events.push(item));
    sender.on('recalled', item => recalled.push(item));

    const result = await sender.sendTextToUser('EMP-003', '发送请求不生成历史', { operationId: '自定义正式会话' });

    expect(result).toMatchObject({ status: 'sent', sessionId: '93003', messageId: '1001', receipt });
    expect(await store.get(result.operationId)).toMatchObject({ status: 'sent', sessionId: '93003', messageId: '1001', receipt });
    expect(await sender.getSendStatus(result.operationId)).toEqual(result);
    expect(await sender.getSessions()).toEqual([otherSession, session]);
    const resolvedSession = (await sender.getSessions()).find(item => item.id === result.sessionId)!;
    expect(await sender.getRecentMessages(resolvedSession)).toEqual([message]);
    expect(await sender.scanCompensationWindow({ fromTimestamp: 0 })).toHaveLength(2);
    expect(events).toEqual([]);
    expect(await sender.recallMessage(result.messageId!, result.sessionId!)).toBe(true);
    expect(message.isRecalled).toBe(true);
    expect(otherMessage.isRecalled).toBeUndefined();
    expect(recalled).toMatchObject([{ messageId: '1001', sessionId: '93003' }]);
    expect(events).toEqual([]);
  });

  it.each(['unknown', 'failed'] as const)('自定义%s即使注入会话号与回执也不建立私聊', async status => {
    driver.setCurrentUserId('91001');
    driver.setEmployees([{ id: 91003, loginName: 'EMP-003', name: '目标员工', updatedAt: 1 }]);
    const receipt = { draftId: '-1', sessionId: '93003', code: status === 'failed' ? 617 : 0, messageId: '1001' };
    driver.setSendBehavior({ mode: 'custom', handler: () => ({ status, sessionId: '93003', receipt, error: '注入未成功结果', isPreTrigger: false }) });

    const result = await driver.sendTextToUser('EMP-003', '未成功的请求');

    expect(result).toMatchObject({ status, receipt, error: '注入未成功结果', isPreTrigger: false });
    expect(result.sessionId).toBeUndefined();
    expect(await driver.getSessions()).toEqual([]);
    expect(await driver.getSendStatus(result.operationId)).toEqual(result);
  });

  it.each([
    ['空工号', '   ', '91001', []],
    ['不存在工号', 'EMP-404', '91001', [{ id: 91003, loginName: 'EMP-003', name: '员工乙', updatedAt: 1 }]],
    ['显示名不是工号', '同名员工', '91001', [{ id: 91003, loginName: 'EMP-003', name: '同名员工', updatedAt: 1 }]],
    ['工号区分大小写', 'emp-003', '91001', [{ id: 91003, loginName: 'EMP-003', name: '同名员工', updatedAt: 1 }]],
    ['多UID歧义', 'EMP-003', '91001', [{ id: 91002, loginName: 'EMP-003', name: '员工甲', updatedAt: 1 }, { id: 91003, loginName: 'EMP-003', name: '员工乙', updatedAt: 1 }]],
    ['无当前身份', 'EMP-003', null, [{ id: 91003, loginName: 'EMP-003', name: '员工乙', updatedAt: 1 }]],
    ['本人账号', 'EMP-001', '91001', [{ id: 91001, loginName: 'EMP-001', name: '本人', updatedAt: 1 }]],
  ] as Array<[string, string, string | null, KK9Employee[]]>)('%s时触发前失败，不建立会话或记录发送', async (_label, loginName, currentUserId, employees) => {
    driver.setCurrentUserId(currentUserId);
    driver.setEmployees(employees);
    const result = await driver.sendTextToUser(loginName, '不能发送');
    expect(result).toMatchObject({ status: 'failed', isPreTrigger: true });
    expect(result.sessionId).toBeUndefined();
    expect(await driver.getSessions()).toEqual([]);
    expect(driver.recordedCalls).toEqual([]);
    expect(await driver.getSendStatus(result.operationId)).toEqual(result);
  });

  it('空文本在找人前失败且不消耗故障序列', async () => {
    driver.setCurrentUserId('91001');
    driver.setEmployees([{ id: 91003, loginName: 'EMP-003', name: '目标员工', updatedAt: 1 }]);
    driver.setSendBehavior({ mode: 'sequence', behaviors: [
      { mode: 'pre_trigger_failure', error: '原定首个故障' },
      { mode: 'success', messageId: '1002' },
    ] });
    expect(await driver.sendTextToUser('EMP-003', '   ')).toMatchObject({ status: 'failed', isPreTrigger: true });
    expect(await driver.sendTextToUser('EMP-003', '第一条')).toMatchObject({ status: 'failed', error: '原定首个故障' });
    expect(await driver.getSessions()).toEqual([]);
    expect(await driver.sendTextToUser('EMP-003', '第二条')).toMatchObject({ status: 'sent', messageId: '1002' });
    expect(driver.recordedCalls).toHaveLength(2);
  });

  it.each(['pre_trigger_failure', 'post_trigger_timeout', 'post_trigger_disconnect', 'post_trigger_lost_response'] as const)('%s按工号不声称创建会话，重复与查询不重发', async mode => {
    driver.setCurrentUserId('91001');
    driver.setEmployees([{ id: 91003, loginName: 'EMP-003', name: '目标员工', updatedAt: 1 }]);
    driver.setSendBehavior({ mode, error: '注入故障' });
    const first = await driver.sendTextToUser('EMP-003', '故障文本', { operationId: '工号故障' });
    expect(first).toMatchObject({ status: mode === 'pre_trigger_failure' ? 'failed' : 'unknown', isPreTrigger: mode === 'pre_trigger_failure' });
    expect(first.sessionId).toBeUndefined();
    expect(await driver.getSessions()).toEqual([]);
    driver.setEmployees([]);
    driver.setSendBehavior({ mode: 'success' });
    expect(await driver.sendTextToUser('EMP-003', '故障文本', { operationId: '工号故障' })).toEqual(first);
    expect(await driver.getSendStatus('工号故障')).toEqual(first);
    expect(await driver.getSessions()).toEqual([]);
    expect(driver.recordedCalls).toHaveLength(1);
  });

  it('同操作重复及共享Store新实例只读已有正式会话，不重复查人、建会话或记录', async () => {
    const store = new InMemorySendOperationStore();
    const sender = new FakeKK9Driver(store);
    sender.setCurrentUserId('91001');
    sender.setEmployees([{ id: 91003, loginName: 'EMP-003', name: '目标员工', updatedAt: 1 }]);
    const first = await sender.sendTextToUser('EMP-003', '一次意图', { operationId: '共享工号操作' });
    sender.setEmployees([]);
    sender.setCurrentUserId(null);
    expect(await sender.sendTextToUser(' EMP-003 ', '一次意图', { operationId: '共享工号操作' })).toEqual(first);
    expect(await sender.getSessions()).toHaveLength(1);
    expect(sender.recordedCalls).toHaveLength(1);

    const observer = new FakeKK9Driver(store);
    expect(await observer.sendTextToUser('EMP-003', '一次意图', { operationId: '共享工号操作' })).toEqual(first);
    expect(await observer.getSendStatus('共享工号操作')).toEqual(first);
    expect(await observer.getSessions()).toEqual([]);
    expect(observer.recordedCalls).toEqual([]);
    expect((await store.get('共享工号操作'))?.fingerprint).toMatchObject({ targetSessionId: '', targetLoginName: 'EMP-003', messageType: 'text-to-user' });
  });

  it('同操作并发工号发送只有声明者执行，冲突工号或内容拒绝复用', async () => {
    driver.setCurrentUserId('91001');
    driver.setEmployees([{ id: 91003, loginName: 'EMP-003', name: '目标员工', updatedAt: 1 }]);
    const results = await Promise.all([
      driver.sendTextToUser('EMP-003', '并发意图', { operationId: '并发工号操作' }),
      driver.sendTextToUser('EMP-003', '并发意图', { operationId: '并发工号操作' }),
    ]);
    expect(results.some(result => result.status === 'sent')).toBe(true);
    expect(driver.recordedCalls).toHaveLength(1);
    expect(await driver.getSessions()).toHaveLength(1);
    await expect(driver.sendTextToUser('EMP-004', '并发意图', { operationId: '并发工号操作' })).rejects.toThrow('fingerprint');
    await expect(driver.sendTextToUser('EMP-003', '冲突内容', { operationId: '并发工号操作' })).rejects.toThrow('fingerprint');
    expect(driver.recordedCalls).toHaveLength(1);
  });

  it('按工号请求不制造历史或实时回声，真实本人回显只在正式会话关联发送键', async () => {
    driver.setCurrentUserId('91001');
    driver.setEmployees([{ id: 91003, loginName: 'EMP-003', name: '目标员工', updatedAt: 1 }]);
    driver.setSendBehavior({ mode: 'success', messageId: '1001' });
    const events: KK9Message[] = [];
    driver.on('message', message => events.push(message));
    const result = await driver.sendTextToUser('EMP-003', '实际文本', { operationId: '工号确认' });
    const session = (await driver.getSessions())[0]!;
    expect(await driver.getRecentMessages(session)).toEqual([]);
    expect(await driver.scanCompensationWindow({ fromTimestamp: 0 })).toEqual([]);
    expect(events).toEqual([]);
    const actualMessage: KK9Message = { id: '1001', sessionId: result.sessionId!, sessionName: '目标员工', sessionType: 'private', sender: '本人', senderId: '91001', direction: 'unknown', isMe: false, content: '实际文本', time: '12:00', timestamp: 100 };
    driver.emitMessage(actualMessage);
    driver.emitMessage(actualMessage);
    driver.emitMessage({ ...actualMessage, sessionId: '93002' });
    driver.emitMessage({ ...actualMessage, id: '1002', senderId: '91003' });
    driver.setSendBehavior({ mode: 'post_trigger_timeout' });
    const unknown = await driver.sendTextToUser('EMP-003', '未知结果文本', { operationId: '工号未知' });
    expect(unknown).toMatchObject({ status: 'unknown', isPreTrigger: false });
    expect(unknown.sessionId).toBeUndefined();
    expect(events).toHaveLength(3);
    expect(await driver.getSessions()).toHaveLength(1);
    driver.emitMessage({ ...actualMessage, id: '1003', content: '未知结果后的真实消息' });
    expect(events.map(message => ({ sessionId: message.sessionId, direction: message.direction, key: message.sdkSendKey }))).toEqual([
      { sessionId: result.sessionId, direction: 'outbound', key: createNativeMessageKey('text-to-user', '工号确认') },
      { sessionId: '93002', direction: 'outbound', key: undefined },
      { sessionId: result.sessionId, direction: 'inbound', key: undefined },
      { sessionId: result.sessionId, direction: 'outbound', key: undefined },
    ]);
    expect(await driver.getRecentMessages(session)).toEqual([]);
  });
});
