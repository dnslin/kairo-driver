import { describe, expect, it, vi } from 'vitest';
import { FakeKK9Driver } from '../src/fake-driver.js';
import { KK9Driver } from '../src/driver.js';
import type { KK9EventBridge } from '../src/bridge/event-bridge.js';
import type { IKK9Driver, KK9Session } from '../src/types/index.js';
import { getDriverTestInternals } from './helpers/driver-internals.js';
import { FakeIpcRenderer, runRendererScript } from './helpers/renderer-runtime.js';
import { CdpError } from '../src/utils/errors.js';
import { BridgeMessageOps } from '../src/bridge/message-ops.js';
import { createNativeSendRuntime } from './helpers/native-send-runtime.js';

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
      getDriverTestInternals(driver).cdp.evaluate = (script: string) =>
        runRendererScript(script, {
          window: { ipcRenderer: ipc },
          setTimeout,
          clearTimeout,
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
      await expect(createIdentityDriver(null, 627).getCurrentUserId()).rejects.toThrow(
        /getMemberDetail.*627/
      );
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
    const history = await driver.getRecentMessages(
      {
        id: '93001',
        name: '员工',
        type: 'private',
        nativeType: 0,
        receiverId: '91002',
        unread: false,
      },
      3
    );
    expect(history.map(message => message.direction)).toEqual(['inbound', 'outbound', 'unknown']);
  });

  it('原生身份为空时，实时与历史均不得沿用配置 UID 判断本人', async () => {
    const driver = new KK9Driver({
      cdp: { url: 'http://localhost:9222', pageMatch: 'test' },
      currentUserId: '91001',
    });
    const { cdp, eventBridge } = getDriverTestInternals<{ eventBridge: KK9EventBridge }>(driver);
    vi.spyOn(cdp, 'connect').mockResolvedValue();
    vi.spyOn(cdp, 'getStatus').mockReturnValue('connected');
    vi.spyOn(driver, 'getCurrentUserId').mockResolvedValue(null);
    vi.spyOn(eventBridge, 'reattach').mockResolvedValue(true);
    const session: KK9Session = {
      id: '93001',
      name: '员工',
      type: 'private',
      nativeType: 0,
      receiverId: '91002',
      unread: false,
    };
    const raw = [
      { id: 1001, sessionID: 93001, sender: 91001, contentType: 4, content: '合成消息' },
    ];
    await driver.connect();
    try {
      expect(eventBridge.parseRawMessage(raw, session).map(message => message.direction)).toEqual([
        'unknown',
      ]);
      vi.spyOn(cdp, 'evaluate').mockResolvedValueOnce({ code: 0, data: raw });
      expect(
        (await driver.getRecentMessages(session, 1)).map(message => message.direction)
      ).toEqual(['unknown']);
    } finally {
      await driver.disconnect();
    }
  });

  it('历史保留撤回记录与通知及普通系统记录，但不派发实时事件', async () => {
    const driver = new KK9Driver({ cdp: { url: 'http://localhost:9222', pageMatch: 'test' } });
    const internals = getDriverTestInternals(driver);
    const session: KK9Session = {
      id: '93001',
      name: '员工',
      type: 'private',
      nativeType: 0,
      receiverId: '91002',
      unread: false,
    };
    const raw = [
      {
        id: 1001,
        sessionID: 93001,
        sender: 91002,
        contentType: 4,
        msgFlag: 'C1',
        content: '已撤回原文本',
      },
      {
        id: 1002,
        sessionID: 93001,
        sender: 91002,
        contentType: 6,
        content: { event: 'CancelMessage', msgID: 1001 },
      },
      { id: 1003, sessionID: 93001, sender: 91002, contentType: 4, content: '正常文本' },
      {
        id: 1004,
        sessionID: 93001,
        sender: 91002,
        contentType: 6,
        content: { event: 'OtherNotice', text: '普通系统通知' },
      },
    ];
    const ipc = new FakeIpcRenderer(() => ({ code: 0, data: raw }));
    internals.cdp.evaluate = (script: string) =>
      runRendererScript(script, {
        window: { ipcRenderer: ipc },
        setTimeout,
        clearTimeout,
      });
    const events: string[] = [];
    driver.on('message', message => events.push(`消息:${message.id}`));
    driver.on('at', message => events.push(`提及:${message.id}`));
    driver.on('recalled', event => events.push(`撤回:${event.messageId}`));
    const history = await driver.getRecentMessages(session, 10);
    expect(history.map(message => message.id)).toEqual(['1001', '1002', '1003', '1004']);
    expect(events).toEqual([]);
  });


  it('确认发送提供正式回执和快捷撤回，unknown不提供成功标记', async () => {
    const driver = new KK9Driver({ cdp: { url: 'http://127.0.0.1:1', pageMatch: '离线' } });
    const internals = getDriverTestInternals(driver);
    const native = createNativeSendRuntime();
    internals.bridgeMessageOps = new BridgeMessageOps(native.cdp);
    const result = await driver.sendText('私聊测试', {
      targetSessionId: '93001',
      operationId: 'driver-sent',
    });
    expect(result.status).toBe('sent');
    expect(result.receipt).toMatchObject({ sessionId: '93001', messageId: '135700000' });
    expect(result.recall).toBeTypeOf('function');
    const missing = await driver.getSendStatus('missing');
    expect(missing.status).toBe('unknown');
    expect(missing.recall).toBeUndefined();
  });
  it('复用 options 并发发送仍按各自实际会话关联正式回执', async () => {
    const driver = new KK9Driver({ cdp: { url: 'http://127.0.0.1:1', pageMatch: '离线' } });
    const native = createNativeSendRuntime();
    getDriverTestInternals(driver).bridgeMessageOps = new BridgeMessageOps(native.cdp);
    const options = { targetSessionId: '93001', operationId: 'driver-target-a' };
    const firstPending = driver.sendText('第一会话', options);
    options.targetSessionId = '93002';
    options.operationId = 'driver-target-b';
    const secondPending = driver.sendText('第二会话', options);
    const [first, second] = await Promise.all([firstPending, secondPending]);
    expect(first).toMatchObject({ status: 'sent', messageId: '135700000' });
    expect(second).toMatchObject({ status: 'sent', messageId: '135700001' });
    expect(native.records.map(record => record['sessionID'])).toEqual([93001, 93002]);
    expect(first.receipt).toMatchObject({ sessionId: '93001', messageId: '135700000' });
    expect(second.receipt).toMatchObject({ sessionId: '93002', messageId: '135700001' });
  });

  it('历史查询返回历史撤回状态，不重放 message、at 或 recalled 事件', async () => {
    const driver = new KK9Driver({ cdp: { url: 'http://localhost:9222', pageMatch: 'test' } });
    const ipc = new FakeIpcRenderer(() => ({
      code: 0,
      data: [
        {
          id: 1001,
          msgIdx: 8,
          sessionID: 93001,
          sender: 91002,
          contentType: 4,
          msgState: 1,
          content: '历史撤回消息',
        },
        {
          id: 1002,
          msgIdx: 9,
          sessionID: 93001,
          sender: 91002,
          contentType: 6,
          content: { event: 'CancelMessage', msgID: '1001' },
        },
      ],
    }));
    getDriverTestInternals(driver).cdp.evaluate = (script: string) =>
      runRendererScript(script, {
        window: { ipcRenderer: ipc },
        setTimeout,
        clearTimeout,
      });
    const events: unknown[] = [];
    driver.on('message', message => events.push(message));
    driver.on('at', message => events.push(message));
    driver.on('recalled', event => events.push(event));
    const messages = await driver.getRecentMessages(
      {
        id: '93001',
        name: '员工甲',
        type: 'private',
        nativeType: 0,
        receiverId: '91002',
        unread: false,
      },
      10
    );
    expect(messages.map(message => message.id)).toEqual(['1001', '1002']);
    expect(messages[0]?.isRecalled).toBe(true);
    expect(events).toEqual([]);
  });

  it.each([undefined, '重复会话', '0-91002'])(
    '目标%s不得改投当前聊天窗口，拒绝后没有草稿',
    async targetSessionId => {
      const driver = new KK9Driver({ cdp: { url: 'http://127.0.0.1:1', pageMatch: '离线' } });
      const internals = getDriverTestInternals(driver);
      const native = createNativeSendRuntime();
      internals.bridgeMessageOps = new BridgeMessageOps(native.cdp);
      const result = await driver.sendText('拒绝发送', { targetSessionId });
      expect(result).toMatchObject({ status: 'failed', isPreTrigger: true });
      expect(native.drafts).toEqual([]);
      expect(native.records).toEqual([]);
    }
  );


  it('已读名称不解析为原生目标，原生失败保留错误', async () => {
    const driver = new KK9Driver({ cdp: { url: 'http://localhost:9222', pageMatch: 'test' } });
    const ipc = new FakeIpcRenderer(({ args: [method] }) => method === 'getSessionBySessionID'
      ? { code: 0, data: { id: 93001, type: 0, maxMessageIndex: 12 } }
      : { code: 627, error: '已读失败' });
    getDriverTestInternals(driver).cdp.evaluate = (script: string) => runRendererScript(script, { window: { ipcRenderer: ipc }, setTimeout, clearTimeout });
    expect(await driver.markSessionRead('test-group')).toBe(false);
    await expect(driver.markSessionRead('93001')).rejects.toThrow(/readMessage.*93001.*627.*已读失败/);
  });

  it('原生正常空组织与缺席档案不触发窗口回退', async () => {
    const driver = new KK9Driver({ cdp: { url: 'http://localhost:9222', pageMatch: 'test' } });
    const ipc = new FakeIpcRenderer(({ args: [method] }) => {
      if (method === 'getDepartmentVisible') return { code: 0, data: [] };
      if (method === 'getMemberDetail') return { code: 0, data: null };
      throw new Error('不应降级查询');
    });
    getDriverTestInternals(driver).cdp.evaluate = (script: string) =>
      runRendererScript(script, { window: { ipcRenderer: ipc }, setTimeout, clearTimeout });
    await expect(driver.getOrgEmployees()).resolves.toEqual([]);
    await expect(driver.getUserProfile(9999)).resolves.toBeNull();
  });


  describe('getEmployeeBySession 原生会话与员工 UID 分离', () => {
    const privateSession: KK9Session = {
      id: '93001',
      name: '员工甲',
      type: 'private',
      nativeType: 0,
      receiverId: '91003',
      unread: false,
    };
    const groupSession: KK9Session = {
      id: '93002',
      name: '群聊',
      type: 'group',
      nativeType: 1,
      receiverId: '92001',
      unread: false,
    };
    function employeeDriver() {
      const driver = new KK9Driver({ cdp: { url: 'http://localhost:9222', pageMatch: 'test' } });
      const ipc = new FakeIpcRenderer(request => {
        if (request.args[0] === 'getConversations')
          return {
            code: 0,
            data: {
              sessionsInfo: {
                '93001': { id: 93001, type: 0, typeID: 91003, creater: 91001, typeName: '员工甲' },
                '93002': { id: 93002, type: 1, typeID: 92001, creater: 91001, typeName: '群聊' },
              },
            },
          };
        if (request.args.length === 1) return { code: 0, data: { id: 91001 } };
        return {
          code: 0,
          data:
            Number(request.args[1]) === 91003
              ? { id: 91003, name: '员工甲', login_name: '员工账号' }
              : { id: 93001, name: '不是会话对端', login_name: '错误账号' },
        };
      });
      getDriverTestInternals(driver).cdp.evaluate = (script: string) =>
        runRendererScript(script, {
          window: { ipcRenderer: ipc },
          setTimeout,
          clearTimeout,
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
  it('相同操作前置失败不重复提交或绕过为窗口发送', async () => {
    const driver = new KK9Driver({ cdp: { url: 'http://127.0.0.1:1', pageMatch: '离线' } });
    const native = createNativeSendRuntime({ insertCode: 627 });
    getDriverTestInternals(driver).bridgeMessageOps = new BridgeMessageOps(native.cdp);
    const options = { targetSessionId: '93001', operationId: 'driver-failed' };
    const first = await driver.sendText('拒绝重复', options);
    expect(first).toMatchObject({ status: 'failed', isPreTrigger: true });
    expect(await driver.sendText('拒绝重复', options)).toEqual(first);
    expect(
      native.ipc.sent.filter(request => request.args[0] === 'insertSendBefoeMsg')
    ).toHaveLength(1);
    expect(native.records).toEqual([]);
  });

  it('Driver 抽象与模拟 Driver 都支持无记录状态查询', async () => {
    const driver: IKK9Driver = new FakeKK9Driver();

    await expect(driver.getSendStatus('missing-operation')).resolves.toEqual({
      operationId: 'missing-operation',
      status: 'unknown',
      isPreTrigger: false,
    });
  });
});
