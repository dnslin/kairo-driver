import { describe, expect, it, vi } from 'vitest';
import { FakeKK9Driver } from '../src/fake-driver.js';
import { KK9Driver } from '../src/driver.js';
import type { KK9EventBridge } from '../src/bridge/event-bridge.js';
import type {
  IKK9Driver,
  KK9Employee,
  KK9Message,
  KK9Session,
  SendResult,
} from '../src/types/index.js';
import { InMemorySendOperationStore } from '../src/send-operation.js';
import { getDriverTestInternals } from './helpers/driver-internals.js';
import { FakeIpcRenderer, runRendererScript } from './helpers/renderer-runtime.js';
import { CdpError } from '../src/utils/errors.js';

describe('KK9Driver 顶层契约离线测试 (IKK9Driver)', () => {
  it('初始化时状态应为 disconnected 且生成唯一 startupGenerationId', () => {
    const driver = new KK9Driver({
      cdp: {
        url: 'http://127.0.0.1:9222',
        pageMatch: 'renderer.html',
      },
    });

    expect(driver.getStatus()).toBe('disconnected');
    expect(driver.getStartupGenerationId()).toBeDefined();
    const health = driver.getHealthSnapshot();
    expect(health.cdpStatus).toBe('disconnected');
    expect(health.eventBridgeAttached).toBe(false);
  });

  describe('getCurrentUserId 当前原生登录身份', () => {
    function createIdentityDriver(data: unknown, code = 0): KK9Driver {
      const driver = new KK9Driver({
        cdp: { url: 'http://localhost:9222', pageMatch: 'test' },
        currentUserId: '配置身份不能冒充实际账号',
      });
      const ipc = new FakeIpcRenderer(() => ({ code, data, error: '身份查询失败' }));
      getDriverTestInternals(driver).cdp.evaluate = (script: string) => runRendererScript(script, {
        window: { ipcRenderer: ipc }, setTimeout, clearTimeout,
      });
      return driver;
    }

    it('原生无登录档案返回 null，不使用配置身份', async () => {
      await expect(createIdentityDriver(null).getCurrentUserId()).resolves.toBeNull();
    });

    it('原生档案 UID 不依赖页面组件且转为字符串', async () => {
      await expect(createIdentityDriver({ id: 91001 }).getCurrentUserId()).resolves.toBe('91001');
    });

    it('原生失败与 CDP 断线不伪装成未登录', async () => {
      await expect(createIdentityDriver(null, 627).getCurrentUserId()).rejects.toThrow(/getMemberDetail.*627/);
      const driver = createIdentityDriver({ id: 91001 });
      const error = new CdpError('连接已失效');
      getDriverTestInternals(driver).cdp.evaluate = vi.fn().mockRejectedValue(error);
      await expect(driver.getCurrentUserId()).rejects.toThrow('连接已失效');
    });
  });

  it('未配置UID时连接真实身份，原生事件与历史消息均能区分员工和本人', async () => {
    const driver = new KK9Driver({ cdp: { url: 'http://localhost:9222', pageMatch: 'test' } });
    const { cdp, eventBridge } = getDriverTestInternals<{ eventBridge: KK9EventBridge }>(driver);
    vi.spyOn(cdp, 'connect').mockResolvedValue();
    vi.spyOn(cdp, 'getStatus').mockReturnValue('connected');
    vi.spyOn(driver, 'getCurrentUserId').mockResolvedValue('91001');
    vi.spyOn(eventBridge, 'reattach').mockResolvedValue(true);
    const raw = [
      { id: '员工消息', fromUID: 91002, sesUUID: '0-91002', content: '采购订单如何创建' },
      { id: '本人消息', fromUID: 91001, sesUUID: '0-91002', content: '人工发送' },
      { id: '未知消息', sesUUID: '0-91002', content: '没有发送人' },
    ];
    await driver.connect();
    expect(
      eventBridge
        .parseRawMessage(raw, { id: '0-91002', name: '员工', type: 'private' })
        .map(message => message.direction)
    ).toEqual(['inbound', 'outbound', 'unknown']);
    vi.spyOn(cdp, 'evaluate').mockResolvedValueOnce({ code: 0, data: raw });
    const history = await driver.getRecentMessages({
      id: '93001', name: '员工', type: 'private', nativeType: 0, receiverId: '91002', unread: false,
    }, 3);
    expect(history.map(message => message.direction)).toEqual(['inbound', 'outbound', 'unknown']);
  });

  it('startPolling 与 stopPolling 应正确切换轮询状态', () => {
    const driver = new KK9Driver({
      cdp: {
        url: 'http://127.0.0.1:9222',
        pageMatch: 'renderer.html',
      },
      polling: {
        intervalMs: 100,
      },
    });

    driver.startPolling();
    // 重复调用不应抛错
    driver.startPolling();
    driver.stopPolling();
    expect(driver.getStatus()).toBe('disconnected');
  });

  it('collectAndEmitMessages 应触发 message 与专用的 at 事件', async () => {
    const driver = new KK9Driver({
      cdp: {
        url: 'http://127.0.0.1:9222',
        pageMatch: 'renderer.html',
      },
    });
    const internals = getDriverTestInternals(driver);

    const receivedMessages: KK9Message[] = [];
    const receivedAtMessages: KK9Message[] = [];

    driver.on('message', msg => {
      receivedMessages.push(msg);
    });

    driver.on('at', msg => {
      receivedAtMessages.push(msg);
    });

    const mockMessages: KK9Message[] = [
      {
        id: 'fp_1',
        sessionId: '0-91002',
        sessionName: 'test-employee',
        sessionType: 'private',
        sender: 'test-employee',
        content: '私聊咨询',
        time: '12:01',
        isMe: false,
        direction: 'inbound',
        atMe: false,
        timestamp: Date.now(),
      },
      {
        id: 'fp_2',
        sessionId: '1-92001',
        sessionName: 'test-group',
        sessionType: 'group',
        sender: '群员B',
        content: '@机器人 请查一下数据',
        time: '12:02',
        isMe: false,
        direction: 'inbound',
        atMe: true,
        mentions: {
          isAtMe: true,
          isAtAll: false,
          mentionedUsers: ['机器人'],
        },
        timestamp: Date.now() + 1000,
      },
    ];

    Object.assign(internals.bridgeMessageOps, {
      getRecentMessages: vi.fn().mockResolvedValue(mockMessages),
    });

    await internals.collectAndEmitMessages(
      { id: '1-92001', name: 'test-group', type: 'group', unread: true },
      10
    );

    expect(receivedMessages).toHaveLength(2);
    expect(receivedAtMessages).toHaveLength(1);
    expect(receivedAtMessages[0]?.content).toContain('@机器人');
    expect(receivedAtMessages[0]?.sessionName).toBe('test-group');
  });

  it('私聊场景(test-employee)与群聊场景(test-group)的消息发送转发与 Bot 消息标记', async () => {
    const driver = new KK9Driver({
      cdp: {
        url: 'http://127.0.0.1:9222',
        pageMatch: 'renderer.html',
      },
    });
    const internals = getDriverTestInternals(driver);

    const mockSendResult: SendResult = {
      success: true,
      messageId: 'msg_ack_1001',
      verifyLatencyMs: 12,
    };

    internals.bridgeMessageOps.sendText = vi.fn().mockResolvedValue(mockSendResult);
    internals.bridgeMessageOps.sendRichText = vi.fn().mockResolvedValue(mockSendResult);
    internals.bridgeMessageOps.sendReply = vi.fn().mockResolvedValue(mockSendResult);
    internals.bridgeMessageOps.sendFile = vi.fn().mockResolvedValue(mockSendResult);
    internals.bridgeMessageOps.sendImage = vi.fn().mockResolvedValue(mockSendResult);
    driver.getSessions = vi.fn().mockResolvedValue([
      { id: 'test-employee', name: 'test-employee', type: 'private', unread: false },
      { id: '1-92001', name: 'test-group', type: 'group', unread: false },
    ]);
    driver.selectSession = vi.fn().mockResolvedValue(true);
    driver.getCurrentSession = vi.fn().mockResolvedValue({
      id: 'test-employee',
      name: 'test-employee',
      type: 'private',
      unread: false,
      active: true,
    });

    // 1. 私聊发送文本
    const resText = await driver.sendText('私聊测试', { targetSessionId: 'test-employee' });
    expect(resText.success).toBe(true);
    expect(driver.isBotSentMessageId('test-employee', 'msg_ack_1001')).toBe(true);

    // 2. 群聊发送富文本与 @提及
    const resRich = await driver.sendRichText('**群聊公告**', {
      targetSessionId: 'test-group',
      mentions: ['all'],
    });
    expect(resRich.success).toBe(true);

    // 3. 群聊发送引用回复
    const resReply = await driver.sendReply('orig_msg_1', '回复内容', {
      targetSessionId: 'test-group',
    });
    expect(resReply.success).toBe(true);

    // 4. 发送文件
    const resFile = await driver.sendFile('test.pdf', { targetSessionId: 'test-employee' });
    expect(resFile.success).toBe(true);

    // 5. 发送图片
    const resImg = await driver.sendImage('test.png', { targetSessionId: 'test-employee' });
    expect(resImg.success).toBe(true);
  });

  it('历史查询返回历史撤回状态，不重放 message、at 或 recalled 事件', async () => {
    const driver = new KK9Driver({ cdp: { url: 'http://localhost:9222', pageMatch: 'test' } });
    const ipc = new FakeIpcRenderer(() => ({ code: 0, data: [
      { id: 1001, msgIdx: 8, sessionID: 93001, sender: 91002, contentType: 4, msgState: 1, content: '历史撤回消息' },
      { id: 1002, msgIdx: 9, sessionID: 93001, sender: 91002, contentType: 6, content: { event: 'CancelMessage', msgID: '1001' } },
    ] }));
    getDriverTestInternals(driver).cdp.evaluate = (script: string) => runRendererScript(script, {
      window: { ipcRenderer: ipc }, setTimeout, clearTimeout,
    });
    const events: unknown[] = [];
    driver.on('message', message => events.push(message));
    driver.on('at', message => events.push(message));
    driver.on('recalled', event => events.push(event));
    const messages = await driver.getRecentMessages({ id: '93001', name: '员工甲', type: 'private', nativeType: 0, receiverId: '91002', unread: false }, 10);
    expect(messages.map(message => message.id)).toEqual(['1001', '1002']);
    expect(messages[0]?.isRecalled).toBe(true);
    expect(events).toEqual([]);
  });

  it('指定目标的 Bridge pre-trigger 拒绝不得被 DOM fallback 绕过', async () => {
    const driver = new KK9Driver({
      cdp: { url: 'http://127.0.0.1:9222', pageMatch: 'renderer.html' },
    });
    const internals = getDriverTestInternals(driver);
    const bridgeFailure: SendResult = {
      success: false,
      error: '目标会话不唯一',
      isPreTrigger: true,
    };
    const domSuccess: SendResult = { success: true, messageId: 'wrong-session' };
    internals.bridgeMessageOps.sendText = vi.fn().mockResolvedValue(bridgeFailure);
    internals.bridgeMessageOps.sendRichText = vi.fn().mockResolvedValue(bridgeFailure);
    internals.bridgeMessageOps.sendReply = vi.fn().mockResolvedValue(bridgeFailure);
    internals.bridgeMessageOps.sendFile = vi.fn().mockResolvedValue(bridgeFailure);
    internals.bridgeMessageOps.sendImage = vi.fn().mockResolvedValue(bridgeFailure);
    driver.getSessions = vi.fn().mockResolvedValue([
      { id: 'first', name: '重复会话', type: 'group', unread: false },
      { id: 'second', name: '重复会话', type: 'group', unread: false },
    ]);
    internals.domSendOps.sendText = vi.fn().mockResolvedValue(domSuccess);
    internals.domSendOps.sendRichText = vi.fn().mockResolvedValue(domSuccess);
    internals.domSendOps.sendReply = vi.fn().mockResolvedValue(domSuccess);
    internals.domSendOps.sendFile = vi.fn().mockResolvedValue(domSuccess);
    internals.domSendOps.sendImage = vi.fn().mockResolvedValue(domSuccess);

    const results = await Promise.all([
      driver.sendText('文本', { targetSessionId: '重复会话' }),
      driver.sendRichText('富文本', { targetSessionId: '重复会话' }),
      driver.sendReply('msg-1', '回复', { targetSessionId: '重复会话' }),
      driver.sendFile('file.txt', { targetSessionId: '重复会话' }),
      driver.sendImage('image.png', { targetSessionId: '重复会话' }),
    ]);

    expect(results.every(result => result.success === false)).toBe(true);
    expect(internals.domSendOps.sendText).not.toHaveBeenCalled();
    expect(internals.domSendOps.sendRichText).not.toHaveBeenCalled();
    expect(internals.domSendOps.sendReply).not.toHaveBeenCalled();
    expect(internals.domSendOps.sendFile).not.toHaveBeenCalled();
    expect(internals.domSendOps.sendImage).not.toHaveBeenCalled();
  });

  it('未指定目标的 pre-trigger 失败仍可回退当前 DOM 会话', async () => {
    const driver = new KK9Driver({
      cdp: { url: 'http://127.0.0.1:9222', pageMatch: 'renderer.html' },
    });
    const internals = getDriverTestInternals(driver);
    internals.bridgeMessageOps.sendText = vi.fn().mockResolvedValue({
      success: false,
      isPreTrigger: true,
    });
    internals.domSendOps.sendText = vi.fn().mockResolvedValue({ success: true });

    const result = await driver.sendText('当前会话文本');

    expect(result.success).toBe(true);
    expect(internals.domSendOps.sendText).toHaveBeenCalledOnce();
  });

  it('向指定会话发送图片时应直接通过 Bridge IPC 发送 (无需切换 UI 会话)', async () => {
    const driver = new KK9Driver({
      cdp: { url: 'http://127.0.0.1:9222', pageMatch: 'renderer.html' },
    });
    const internals = getDriverTestInternals(driver);
    driver.getSessions = vi
      .fn()
      .mockResolvedValue([{ id: '0-91002', name: 'test-employee', type: 'private', unread: false }]);
    driver.selectSession = vi.fn().mockResolvedValue(true);
    driver.getCurrentSession = vi.fn().mockResolvedValue({
      id: '0-91002',
      name: 'test-employee',
      type: 'private',
      unread: false,
      active: true,
    });
    internals.bridgeMessageOps.sendImage = vi
      .fn()
      .mockResolvedValue({ success: true, messageId: '1001' });

    const result = await driver.sendImage('image.png', { targetSessionId: '0-91002' });

    expect(result.success).toBe(true);
    expect(driver.selectSession).not.toHaveBeenCalled();
    expect(internals.bridgeMessageOps.sendImage).toHaveBeenCalledWith('image.png', {
      targetSessionId: '0-91002',
    });
  });

  it('Driver 顶层必须拒绝全局重名会话的 select 与 markRead', async () => {
    const driver = new KK9Driver({
      cdp: { url: 'http://localhost:9222', pageMatch: 'test' },
    });
    const internals = getDriverTestInternals(driver);
    driver.getSessions = vi.fn().mockResolvedValue([
      { id: '1-92001', name: 'test-group', type: 'group', unread: false },
      { id: '1-92002', name: 'test-group', type: 'group', unread: false },
    ]);
    internals.bridgeSessionOps.selectSession = vi.fn().mockResolvedValue(true);
    internals.domSessionOps.selectSession = vi.fn().mockResolvedValue(true);
    internals.bridgeSessionOps.markSessionRead = vi.fn().mockResolvedValue(true);

    expect(await driver.selectSession('test-group')).toBe(false);
    expect(await driver.markSessionRead('test-group')).toBe(false);
    expect(internals.bridgeSessionOps.selectSession).not.toHaveBeenCalled();
    expect(internals.domSessionOps.selectSession).not.toHaveBeenCalled();
    expect(internals.bridgeSessionOps.markSessionRead).not.toHaveBeenCalled();
  });

  it('会话管理应优先调用 Bridge 会话服务', async () => {
    const driver = new KK9Driver({
      cdp: { url: 'http://localhost:9222', pageMatch: 'test' },
    });
    const internals = getDriverTestInternals(driver);

    const mockSessions: KK9Session[] = [
      { id: '0-91002', name: 'test-employee', type: 'private', unread: false },
      { id: '1-92001', name: 'test-group', type: 'group', unread: true, unreadCount: 3 },
    ];

    internals.bridgeSessionOps.getSessions = vi.fn().mockResolvedValue(mockSessions);
    internals.bridgeSessionOps.getCurrentSession = vi.fn().mockResolvedValue(mockSessions[0]);
    internals.bridgeSessionOps.selectSession = vi.fn().mockResolvedValue(true);
    internals.bridgeSessionOps.markSessionRead = vi.fn().mockResolvedValue(true);

    const sessions = await driver.getSessions();
    expect(sessions).toHaveLength(2);

    const current = await driver.getCurrentSession();
    expect(current?.name).toBe('test-employee');

    const switched = await driver.selectSession('test-group');
    expect(switched).toBe(true);
    expect(internals.bridgeSessionOps.selectSession).toHaveBeenCalledWith('1-92001');

    const markRes = await driver.markSessionRead('test-group');
    expect(markRes).toBe(true);
  });

  it('Bridge 已读失败时不得通过 DOM 隐藏红点并伪报成功', async () => {
    const driver = new KK9Driver({
      cdp: { url: 'http://localhost:9222', pageMatch: 'test' },
    });
    const internals = getDriverTestInternals(driver);
    driver.getSessions = vi
      .fn()
      .mockResolvedValue([{ id: '0-91002', name: 'test-employee', type: 'private', unread: false }]);
    internals.bridgeSessionOps.markSessionRead = vi.fn().mockResolvedValue(false);
    internals.domSessionOps.markSessionRead = vi.fn().mockResolvedValue(true);

    const result = await driver.markSessionRead('0-91002');

    expect(result).toBe(false);
    expect(internals.domSessionOps.markSessionRead).not.toHaveBeenCalled();
  });

  it('组织架构查询应优先调用 Bridge 组织架构服务', async () => {
    const driver = new KK9Driver({
      cdp: { url: 'http://localhost:9222', pageMatch: 'test' },
    });
    const internals = getDriverTestInternals(driver);

    const mockEmployee: KK9Employee = {
      id: 91001,
      loginName: 'TEST-EMP-001',
      name: '测试员工',
      position: 'IT开发工程师',
      deptPaths: [
        { id: 15, name: '测试公司' },
        { id: 29, name: 'IT组' },
      ],
      updatedAt: Date.now(),
    };

    internals.bridgeOrgOps.getOrgEmployees = vi.fn().mockResolvedValue([mockEmployee]);
    internals.bridgeOrgOps.getUserProfile = vi.fn().mockResolvedValue(mockEmployee);

    const employees = await driver.getOrgEmployees(5000);
    expect(employees).toHaveLength(1);
    expect(employees[0]?.name).toBe('测试员工');

    const profile = await driver.getUserProfile(91001);
    expect(profile).not.toBeNull();
    expect(profile?.loginName).toBe('TEST-EMP-001');
  });

  it('消息撤回与撤回事件监听', async () => {
    const driver = new KK9Driver({
      cdp: { url: 'http://localhost:9222', pageMatch: 'test' },
    });
    const internals = getDriverTestInternals(driver);

    driver.getSessions = vi
      .fn()
      .mockResolvedValue([{ id: '0-91002', name: 'test-employee', type: 'private', unread: false }]);
    internals.bridgeMessageOps.recallMessage = vi.fn().mockResolvedValue(true);

    const ok = await driver.recallMessage('msg_1001', 'test-employee');
    expect(ok).toBe(true);
    expect(internals.bridgeMessageOps.recallMessage).toHaveBeenCalledWith('msg_1001', '0-91002');

    const recalledEvents: unknown[] = [];
    driver.on('recalled', evt => recalledEvents.push(evt));

    internals.handleRecalledEvent({
      messageId: 'msg_1001',
      sessionId: 'test-employee',
      sender: '我',
      time: '12:00',
    });

    // 重复相同 messageKey 自动去重
    internals.handleRecalledEvent({
      messageId: 'msg_1001',
      sessionId: 'test-employee',
      sender: '我',
      time: '12:00',
    });

    expect(recalledEvents).toHaveLength(1);
  });

  describe('getEmployeeBySession 原生会话与员工 UID 分离', () => {
    const privateSession: KK9Session = {
      id: '93001', name: '员工甲', type: 'private', nativeType: 0, receiverId: '91003', unread: false,
    };
    const groupSession: KK9Session = {
      id: '93002', name: '群聊', type: 'group', nativeType: 1, receiverId: '92001', unread: false,
    };
    function employeeDriver() {
      const driver = new KK9Driver({ cdp: { url: 'http://localhost:9222', pageMatch: 'test' } });
      const ipc = new FakeIpcRenderer(request => {
        if (request.args[0] === 'getConversations') return { code: 0, data: { sessionsInfo: {
          '93001': { id: 93001, type: 0, typeID: 91003, creater: 91001, typeName: '员工甲' },
          '93002': { id: 93002, type: 1, typeID: 92001, creater: 91001, typeName: '群聊' },
        } } };
        if (request.args.length === 1) return { code: 0, data: { id: 91001 } };
        return { code: 0, data: Number(request.args[1]) === 91003
          ? { id: 91003, name: '员工甲', login_name: '员工账号' }
          : { id: 93001, name: '不是会话对端', login_name: '错误账号' } };
      });
      getDriverTestInternals(driver).cdp.evaluate = (script: string) => runRendererScript(script, {
        window: { ipcRenderer: ipc }, setTimeout, clearTimeout,
      });
      return driver;
    }

    it('会话原生 ID 和实体都查询对端 UID，不把会话 ID 当员工 UID', async () => {
      const driver = employeeDriver();
      expect((await driver.getEmployeeBySession('93001'))?.id).toBe(91003);
      expect((await driver.getEmployeeBySession(privateSession))?.loginName).toBe('员工账号');
    });

    it('群聊、未知 ID、用户 UID、界面标识及名称不冒充原生私聊', async () => {
      const driver = employeeDriver();
      for (const input of ['93002', '91003', '0-91003', '员工甲']) {
        expect(await driver.getEmployeeBySession(input)).toBeNull();
      }
      expect(await driver.getEmployeeBySession(groupSession)).toBeNull();
    });

    it('空输入不查询客户端', async () => {
      const driver = new KK9Driver({ cdp: { url: 'http://localhost:9222', pageMatch: 'test' } });
      expect(await driver.getEmployeeBySession('')).toBeNull();
      expect(await driver.getEmployeeBySession('   ')).toBeNull();
    });
  });
  it('带发送操作 ID 的发送前置失败不会退回无法关联的 DOM 双发路径', async () => {
    const store = new InMemorySendOperationStore();
    const driver = new KK9Driver(
      { cdp: { url: 'http://127.0.0.1:9222', pageMatch: 'renderer.html' } },
      store
    );
    const internals = getDriverTestInternals(driver);
    const bridgeFailure: SendResult = {
      success: false,
      operationId: 'op-no-dom-fallback',
      status: 'failed',
      isPreTrigger: true,
    };
    internals.bridgeMessageOps.sendText = vi.fn().mockResolvedValue(bridgeFailure);
    internals.domSendOps.sendText = vi
      .fn()
      .mockResolvedValue({ success: true, messageId: 'dom-duplicate' });

    const result = await driver.sendText('禁止 DOM 双发', { operationId: 'op-no-dom-fallback' });

    expect(result).toEqual(bridgeFailure);
    expect(internals.bridgeMessageOps.sendText).toHaveBeenCalledWith('禁止 DOM 双发', {
      operationId: 'op-no-dom-fallback',
    });
    expect(internals.domSendOps.sendText).not.toHaveBeenCalled();
  });
  it('带发送操作 ID 的图片前置失败不会退回无法关联的 DOM 双发路径', async () => {
    const store = new InMemorySendOperationStore();
    const driver = new KK9Driver(
      { cdp: { url: 'http://127.0.0.1:9222', pageMatch: 'renderer.html' } },
      store
    );
    const internals = getDriverTestInternals(driver);
    const bridgeFailure: SendResult = {
      success: false,
      operationId: 'op-image-no-dom-fallback',
      status: 'failed',
      isPreTrigger: true,
    };
    internals.bridgeMessageOps.sendImage = vi.fn().mockResolvedValue(bridgeFailure);
    internals.domSendOps.sendImage = vi
      .fn()
      .mockResolvedValue({ success: false, status: 'unknown', isPreTrigger: false });

    const result = await driver.sendImage('image.png', { operationId: 'op-image-no-dom-fallback' });

    expect(result).toEqual(bridgeFailure);
    expect(internals.bridgeMessageOps.sendImage).toHaveBeenCalledWith('image.png', {
      operationId: 'op-image-no-dom-fallback',
    });
    expect(internals.domSendOps.sendImage).not.toHaveBeenCalled();
  });

  it('Driver 抽象与模拟 Driver 都支持无记录状态查询', async () => {
    const driver: IKK9Driver = new FakeKK9Driver();

    await expect(driver.getSendStatus('missing-operation')).resolves.toEqual({
      success: false,
      operationId: 'missing-operation',
      status: 'unknown',
      isPreTrigger: false,
    });
  });
});
