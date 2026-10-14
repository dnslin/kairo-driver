import { afterEach, describe, expect, it, vi } from 'vitest';
import { BridgeMessageOps } from '../src/bridge/message-ops.js';
import { KK9Driver } from '../src/driver.js';
import { FakeKK9Driver } from '../src/fake-driver.js';
import { InMemorySendOperationStore } from '../src/send-operation.js';
import type {
  IKK9Driver,
  KK9Employee,
  KK9RecalledEvent,
  SendOptions,
  SendResult,
} from '../src/types/index.js';
import { getDriverTestInternals } from './helpers/driver-internals.js';
import { createNativeSendRuntime } from './helpers/native-send-runtime.js';
import type { FakeIpcRenderer } from './helpers/renderer-runtime.js';

type CardSender = Pick<IKK9Driver, 'sendAppMessage' | 'sendUrlCard' | 'sendBizMessage'>;
type NativeConfig = NonNullable<Parameters<typeof createNativeSendRuntime>[0]>;

const cards: Array<{
  label: string;
  kind: 'app-message' | 'url-card' | 'biz-message';
  callType: 'appMessage' | 'urlCard' | 'bizMessage';
  contentType: number;
  content: Record<string, unknown>;
  send: (ops: CardSender, options: SendOptions) => Promise<SendResult>;
}> = [
  {
    label: '应用通知',
    kind: 'app-message',
    callType: 'appMessage',
    contentType: 8,
    content: { title: '应用', content: '<p>原生正文</p>', linkUrl: '/app', pcAppCode: 'real-app' },
    send: (ops, options) =>
      ops.sendAppMessage(
        { title: '应用', content: '<p>原生正文</p>', linkUrl: '/app', pcAppCode: 'real-app' },
        options
      ),
  },
  {
    label: '链接卡片',
    kind: 'url-card',
    callType: 'urlCard',
    contentType: 10,
    content: { title: '链接', summary: '原生摘要', linkUrl: 'https://example.com', picUrl: '' },
    send: (ops, options) =>
      ops.sendUrlCard(
        { title: '链接', summary: '原生摘要', linkUrl: 'https://example.com' },
        options
      ),
  },
  {
    label: '业务通知',
    kind: 'biz-message',
    callType: 'bizMessage',
    contentType: 17,
    content: {
      title: '业务',
      content: '原生正文',
      summary: ['详情'],
      bizUrl: '/task/1',
      bizType: 1,
    },
    send: (ops, options) =>
      ops.sendBizMessage(
        { title: '业务', content: '原生正文', summary: ['详情'], bizUrl: '/task/1', bizType: 1 },
        options
      ),
  },
];

const users = [
  { id: 91004, login_name: '00AbC-near', name: '00AbC' },
  { id: 91005, login_name: '00abc', name: '同名员工' },
  { id: 91003, login_name: '00AbC', name: '同名员工' },
];
const invalidTargets: Array<{ label: string; target: SendOptions }> = [
  { label: '没有目标', target: {} },
  { label: '空工号', target: { targetLoginName: '' } },
  { label: '空白工号', target: { targetLoginName: '   ' } },
  { label: '空会话', target: { targetSessionId: '' } },
  { label: '同时指定工号和会话', target: { targetLoginName: '00AbC', targetSessionId: '93001' } },
  { label: '同时指定工号和空会话', target: { targetLoginName: '00AbC', targetSessionId: '' } },
];
const nativeGates: Array<{
  label: string;
  config: NativeConfig;
  method?: string;
  reason?: string;
}> = [
  { label: '未登录', config: { identity: null } },
  { label: '前缀和显示名不能代替工号', config: { searchUsers: [users[0]!] } },
  { label: '工号区分大小写', config: { searchUsers: [users[1]!] } },
  {
    label: '同工号多UID歧义',
    config: { searchUsers: [users[2]!, { id: 91006, login_name: '00AbC', name: '另一员工' }] },
  },
  {
    label: '目标是本人',
    config: { searchUsers: [{ id: 91001, login_name: '00AbC', name: '本人' }] },
  },
  {
    label: '档案工号不符',
    config: { targetProfile: { id: 91003, login_name: '00abc', name: '对端' } },
  },
  {
    label: '档案UID不符',
    config: { targetProfile: { id: 91004, login_name: '00AbC', name: '对端' } },
  },
  { label: '搜索拒绝', config: { searchCode: 627 }, method: 'unionSearch', reason: '人员搜索拒绝' },
  {
    label: '档案查询拒绝',
    config: { targetProfileCode: 627 },
    method: 'getMemberDetail',
    reason: '目标档案拒绝',
  },
  {
    label: '权限查询拒绝',
    config: { permissionCode: 627 },
    method: 'getUsersSessionLimit',
    reason: '权限查询拒绝',
  },
  { label: '私聊权限禁止', config: { permissionDenied: true }, method: 'getUsersSessionLimit' },
];
const uncertainReceipts: Array<{ label: string; config: NativeConfig }> = [
  { label: '缺少业务回执', config: { callback: false } },
  { label: '回执接收者不符', config: { mismatchedReceiver: true } },
  { label: '回执发送者不符', config: { mismatchedSender: true } },
  { label: '回执负草稿不符', config: { mismatchedDraft: true } },
  { label: '回执正式会话为空', config: { receiptSessionId: 0 } },
  { label: '回执会话无法关联正式历史', config: { mismatchedSession: true } },
];

function holdNativeRequest(ipc: FakeIpcRenderer, method: string) {
  const send = ipc.send.bind(ipc);
  let started!: () => void;
  let release!: () => void;
  const pending = new Promise<void>(resolve => {
    started = resolve;
  });
  ipc.send = (channel, request) => {
    if (request.args[0] === method) {
      release = () => send(channel, request);
      started();
    } else send(channel, request);
  };
  return { started: pending, release: () => release() };
}

function fakeCardRuntime(store = new InMemorySendOperationStore()) {
  const driver = new FakeKK9Driver(store);
  driver.setCurrentUserId('91001');
  driver.setEmployees([
    ...users.map(user => ({
      id: user.id,
      loginName: user.login_name,
      name: user.name,
      updatedAt: 1,
    })),
    { id: '91003', loginName: '00AbC', name: '同名员工', updatedAt: 1 },
  ]);
  return driver;
}

// 只替换原生IPC边界，实际执行SDK生成的渲染脚本、回执关联及Store登记。
describe.each(cards)('$label按准确工号发送', card => {
  afterEach(() => vi.useRealTimers());

  it('首次发送仅提交原生卡片，准确工号去空白且正式会话由回执确认', async () => {
    const native = createNativeSendRuntime({ searchUsers: users });
    const store = new InMemorySendOperationStore();
    const ops = new BridgeMessageOps(native.cdp, store);
    const options = { operationId: `card-first-${card.kind}`, targetLoginName: '  00AbC  ' };
    native.sessions.splice(0);
    expect(native.context['document']).toBeUndefined();
    const result = await card.send(ops, options);
    expect(result).toMatchObject({
      status: 'sent',
      operationId: options.operationId,
      sessionId: '94001',
      messageId: '135700000',
      receipt: { draftId: '-1', code: 0, sessionId: '94001', messageId: '135700000', msgIdx: 1 },
    });
    expect(native.drafts).toMatchObject([
      {
        sessionID: 0,
        sessionType: 0,
        sender: 91001,
        receiver: 91003,
        contentType: card.contentType,
      },
    ]);
    expect(native.drafts).toHaveLength(1);
    expect(native.records).toHaveLength(1);
    expect(native.records[0]).toMatchObject({
      sessionID: 94001,
      receiver: 91003,
      contentType: card.contentType,
    });
    expect(native.records[0]?.['content']).toEqual(card.content);
    expect(native.ipc.sent.filter(request => request.args[0] === 'sendMessageNew')).toHaveLength(1);
    expect(
      native.ipc.sent
        .filter(request => request.args[0] === 'unionSearch')
        .map(request => request.args[1])
    ).toEqual([{ type: 'user', kwd: '00AbC', pageNo: 1, pageSize: 200 }]);
    expect(
      native.ipc.sent
        .filter(request => request.args[0] === 'getSessionBySessionID')
        .map(request => request.args[1])
    ).toEqual([94001]);
    const methods = native.ipc.sent.map(request => request.args[0]);
    expect(methods).not.toContain('getSessionInfo6');
    expect(methods).not.toContain('getUsersByLoginNames');
    expect(methods).not.toContain('getConversations');
    expect(await store.get(options.operationId)).toMatchObject({
      status: 'sent',
      sessionId: '94001',
      fingerprint: { targetSessionId: '', targetLoginName: '00AbC', messageType: card.kind },
    });
    const requestCount = native.ipc.sent.length;
    expect(await card.send(ops, { ...options, targetLoginName: '00AbC' })).toEqual(result);
    expect(
      await new BridgeMessageOps(native.cdp, store).getSendStatus(options.operationId)
    ).toEqual(result);
    await expect(card.send(ops, { ...options, targetLoginName: '00abc' })).rejects.toThrow(
      'fingerprint'
    );
    await expect(
      card.send(ops, { operationId: options.operationId, targetSessionId: '94001' })
    ).rejects.toThrow('fingerprint');
    expect(native.ipc.sent).toHaveLength(requestCount);
    expect(native.ipc.listenerCount('0-91003-sendMsgCallback')).toBe(0);
    expect((native.window['__kairo_pending_sends'] as Map<string, unknown>).size).toBe(0);
  });

  it.each([
    { label: '已有正向私聊', config: { existingUserSessionId: 93003 } },
    { label: '已有反向私聊', config: { reverseUserSession: true } },
  ])('$label由原生复用，不依赖最近窗口或另建私聊', async ({ config }) => {
    const native = createNativeSendRuntime({ ...config, searchUsers: users });
    const sessionCount = native.sessions.length;
    const result = await card.send(new BridgeMessageOps(native.cdp), { targetLoginName: '00AbC' });
    expect(result).toMatchObject({
      status: 'sent',
      sessionId: '93003',
      receipt: { sessionId: '93003' },
    });
    expect(native.drafts).toMatchObject([
      { sessionID: 0, receiver: 91003, contentType: card.contentType },
    ]);
    expect(native.records).toMatchObject([{ sessionID: 93003, receiver: 91003 }]);
    expect(native.records).toHaveLength(1);
    expect(native.sessions).toHaveLength(sessionCount);
  });

  it('显式原生会话发送保持原样，不搜索工号', async () => {
    const native = createNativeSendRuntime();
    const result = await card.send(new BridgeMessageOps(native.cdp), { targetSessionId: '93001' });
    expect(result).toMatchObject({
      status: 'sent',
      messageId: '135700000',
      receipt: { sessionId: '93001' },
    });
    expect(native.drafts).toMatchObject([
      { sessionID: 93001, receiver: 91002, contentType: card.contentType },
    ]);
    expect(native.records[0]?.['content']).toEqual(card.content);
    expect(native.ipc.sent.map(request => request.args[0])).not.toContain('unionSearch');
  });

  it.each(invalidTargets)('$label在原生IPC前失败', async ({ target }) => {
    const native = createNativeSendRuntime();
    const store = new InMemorySendOperationStore();
    const result = await card.send(new BridgeMessageOps(native.cdp, store), {
      ...target,
      operationId: 'card-invalid',
    });
    expect(result).toMatchObject({ status: 'failed', isPreTrigger: true });
    expect(await store.get(result.operationId)).toMatchObject({
      status: 'failed',
      isPreTrigger: true,
    });
    expect(native.ipc.sent).toEqual([]);
    expect(native.drafts).toEqual([]);
    expect(native.records).toEqual([]);
  });

  it.each(nativeGates)(
    '$label阻止草稿创建，保留原生失败原因且重放只读',
    async ({ config, method, reason }) => {
      const native = createNativeSendRuntime({ searchUsers: users, ...config });
      const ops = new BridgeMessageOps(native.cdp);
      const options = { operationId: 'card-gate', targetLoginName: '00AbC' };
      const result = await card.send(ops, options);
      expect(result).toMatchObject({ status: 'failed', isPreTrigger: true });
      if (method) expect(result.error).toContain(method);
      if (reason) expect(result.error).toContain(reason);
      const requestCount = native.ipc.sent.length;
      expect(await card.send(ops, options)).toEqual(result);
      expect(await ops.getSendStatus(options.operationId)).toEqual(result);
      expect(native.ipc.sent).toHaveLength(requestCount);
      expect(native.drafts).toEqual([]);
      expect(native.records).toEqual([]);
    }
  );

  it.each([
    { label: '服务器拒绝', config: { code: 627 }, code: 627 },
    { label: '正ID伴随禁发业务码', config: { businessCode: 617 }, code: 617 },
  ])('$label不能把正式正ID当成功，重放和查询不重发', async ({ config, code }) => {
    const native = createNativeSendRuntime({ searchUsers: users, ...config });
    const ops = new BridgeMessageOps(native.cdp);
    const options = { operationId: 'card-business-failed', targetLoginName: '00AbC' };
    const result = await card.send(ops, options);
    expect(result).toMatchObject({
      status: 'failed',
      nativeCode: code,
      isPreTrigger: false,
      receipt: { sessionId: '94001' },
    });
    expect(await card.send(ops, options)).toEqual(result);
    expect(await ops.getSendStatus(options.operationId)).toEqual(result);
    expect(native.records).toHaveLength(1);
  });

  it.each(uncertainReceipts)('$label保持未知，存在正式历史也不补判或重发', async ({ config }) => {
    vi.useFakeTimers();
    const native = createNativeSendRuntime({ searchUsers: users, ...config });
    const store = new InMemorySendOperationStore();
    const ops = new BridgeMessageOps(native.cdp, store);
    const options = { operationId: 'card-unknown', targetLoginName: '00AbC', verifyTimeoutMs: 50 };
    const pending = card.send(ops, options);
    const concurrent = card.send(ops, options);
    await vi.runAllTimersAsync();
    expect(await pending).toMatchObject({ status: 'unknown', isPreTrigger: false });
    expect((await concurrent).status).toBe('unknown');
    expect(native.records).toHaveLength(1);
    const lookups = native.ipc.sent.filter(request => request.args[0] === 'unionSearch').length;
    expect((await card.send(ops, options)).status).toBe('unknown');
    expect(
      (await new BridgeMessageOps(native.cdp, store).getSendStatus(options.operationId)).status
    ).toBe('unknown');
    await expect(card.send(ops, { ...options, targetLoginName: 'other-login' })).rejects.toThrow(
      'fingerprint'
    );
    expect(await store.get(options.operationId)).toMatchObject({ status: 'unknown' });
    expect(native.ipc.sent.filter(request => request.args[0] === 'unionSearch')).toHaveLength(
      lookups
    );
    expect(native.ipc.sent.filter(request => request.args[0] === 'sendMessageNew')).toHaveLength(1);
    expect(native.drafts).toHaveLength(1);
    expect(native.ipc.listenerCount('0-91003-sendMsgCallback')).toBe(0);
    expect((native.window['__kairo_pending_sends'] as Map<string, unknown>).size).toBe(0);
  });

  it('人员搜索中取消在草稿前结束，迟到原生回复不能恢复发送', async () => {
    vi.useFakeTimers();
    const native = createNativeSendRuntime({ searchUsers: users });
    const gate = holdNativeRequest(native.ipc, 'unionSearch');
    const ops = new BridgeMessageOps(native.cdp);
    const options = { operationId: 'card-cancel', targetLoginName: '00AbC' };
    const pending = card.send(ops, options);
    await gate.started;
    const cancelling = ops.cancelPendingSends();
    gate.release();
    await cancelling;
    await vi.runAllTimersAsync();
    const result = await pending;
    expect(result).toMatchObject({ status: 'failed', isPreTrigger: true });
    expect(await card.send(ops, options)).toEqual(result);
    expect(await ops.getSendStatus(options.operationId)).toEqual(result);
    expect(native.drafts).toEqual([]);
    expect(native.records).toEqual([]);
    expect(native.ipc.listenerCount('0-91003-sendMsgCallback')).toBe(0);
    expect((native.window['__kairo_pending_sends'] as Map<string, unknown>).size).toBe(0);
  });

  it('替身精确匹配工号、首次分配正式私聊并复用，发送不制造历史', async () => {
    const store = new InMemorySendOperationStore();
    const driver = fakeCardRuntime(store);
    driver.setSessions([
      {
        id: '1',
        name: '已占用群聊',
        type: 'group',
        nativeType: 1,
        receiverId: '91003',
        unread: false,
      },
    ]);
    driver.setSendBehavior({ mode: 'success', messageId: '135700000' });
    const options = { operationId: 'fake-card-first', targetLoginName: ' 00AbC ' };
    const result = await card.send(driver, options);
    expect(result).toMatchObject({ status: 'sent', messageId: '135700000', isPreTrigger: false });
    expect(result.sessionId).toMatch(/^[1-9]\d*$/);
    expect(result.sessionId).not.toBe('1');
    const session = (await driver.getSessions()).find(item => item.id === result.sessionId);
    expect(session).toMatchObject({
      type: 'private',
      nativeType: 0,
      receiverId: '91003',
      name: '同名员工',
    });
    if (!session) throw new Error('成功发送缺少正式私聊');
    expect(await driver.getRecentMessages(session)).toEqual([]);
    expect(await driver.scanCompensationWindow({ fromTimestamp: 0 })).toEqual([]);
    expect(driver.recordedCalls).toHaveLength(1);
    expect(driver.recordedCalls[0]).toMatchObject({
      type: card.callType,
      targetLoginName: '00AbC',
    });
    expect(await store.get(options.operationId)).toMatchObject({
      status: 'sent',
      sessionId: result.sessionId,
      fingerprint: { targetSessionId: '', targetLoginName: '00AbC', messageType: card.kind },
    });
    const second = await card.send(driver, {
      operationId: 'fake-card-second',
      targetLoginName: '00AbC',
    });
    expect(second).toMatchObject({ status: 'sent', sessionId: result.sessionId });
    expect(await driver.getSessions()).toHaveLength(2);
    expect(driver.recordedCalls).toHaveLength(2);
    driver.setEmployees([]);
    driver.setCurrentUserId(null);
    expect(await card.send(driver, { ...options, targetLoginName: '00AbC' })).toEqual(result);
    const observer = new FakeKK9Driver(store);
    expect(await card.send(observer, { ...options, targetLoginName: '00AbC' })).toEqual(result);
    expect(await observer.getSendStatus(options.operationId)).toEqual(result);
    await expect(card.send(observer, { ...options, targetLoginName: '00abc' })).rejects.toThrow(
      'fingerprint'
    );
    await expect(
      card.send(observer, { operationId: options.operationId, targetSessionId: result.sessionId })
    ).rejects.toThrow('fingerprint');
    expect(observer.recordedCalls).toEqual([]);
    expect(await observer.getSessions()).toEqual([]);
    expect(driver.recordedCalls).toHaveLength(2);
  });

  it.each(invalidTargets)('替身对$label同样在记录发送前拒绝', async ({ target }) => {
    const driver = fakeCardRuntime();
    expect(await card.send(driver, target)).toMatchObject({ status: 'failed', isPreTrigger: true });
    expect(driver.recordedCalls).toEqual([]);
    expect(await driver.getSessions()).toEqual([]);
  });

  it.each([
    {
      label: '未登录',
      identity: null,
      employees: [{ id: 91003, loginName: '00AbC', name: '员工', updatedAt: 1 }],
    },
    {
      label: '不存在准确工号',
      identity: '91001',
      employees: [{ id: 91004, loginName: '00AbC-near', name: '00AbC', updatedAt: 1 }],
    },
    {
      label: '大小写不符',
      identity: '91001',
      employees: [{ id: 91004, loginName: '00abc', name: '员工', updatedAt: 1 }],
    },
    {
      label: '多个UID歧义',
      identity: '91001',
      employees: [
        { id: 91003, loginName: '00AbC', name: '甲', updatedAt: 1 },
        { id: 91004, loginName: '00AbC', name: '乙', updatedAt: 1 },
      ],
    },
    {
      label: '目标是本人',
      identity: '91001',
      employees: [{ id: 91001, loginName: '00AbC', name: '本人', updatedAt: 1 }],
    },
  ] satisfies Array<{ label: string; identity: string | null; employees: KK9Employee[] }>)(
    '替身对$label不建立私聊',
    async ({ identity, employees }) => {
      const driver = fakeCardRuntime();
      driver.setCurrentUserId(identity);
      driver.setEmployees(employees);
      const result = await card.send(driver, {
        operationId: 'fake-card-gate',
        targetLoginName: '00AbC',
      });
      expect(result).toMatchObject({ status: 'failed', isPreTrigger: true });
      expect(result.sessionId).toBeUndefined();
      expect(await driver.getSendStatus(result.operationId)).toEqual(result);
      expect(driver.recordedCalls).toEqual([]);
      expect(await driver.getSessions()).toEqual([]);
    }
  );

  it('替身未知结果共享Store重放不再发送，也不虚构首次私聊', async () => {
    vi.useFakeTimers();
    const store = new InMemorySendOperationStore();
    const driver = fakeCardRuntime(store);
    driver.setSendBehavior({ mode: 'post_trigger_timeout', error: '缺少业务回执' });
    const options = { operationId: 'fake-card-unknown', targetLoginName: '00AbC' };
    const first = await card.send(driver, options);
    expect(first).toMatchObject({ status: 'unknown', isPreTrigger: false });
    expect(first.sessionId).toBeUndefined();
    driver.setSendBehavior({ mode: 'success' });
    expect(await card.send(driver, options)).toEqual(first);
    const observer = new FakeKK9Driver(store);
    expect(await card.send(observer, options)).toEqual(first);
    expect(await observer.getSendStatus(options.operationId)).toEqual(first);
    await expect(card.send(driver, { ...options, targetLoginName: 'other-login' })).rejects.toThrow(
      'fingerprint'
    );
    expect(driver.recordedCalls).toHaveLength(1);
    expect(observer.recordedCalls).toEqual([]);
    expect(await driver.getSessions()).toEqual([]);
    expect(await observer.getSessions()).toEqual([]);
  });
});

it('公开应用通知门面在等待原生提交时固定工号模式，选项变更后仍撤回正式私聊', async () => {
  const native = createNativeSendRuntime({ searchUsers: users });
  const gate = holdNativeRequest(native.ipc, 'sendMessageNew');
  const driver = new KK9Driver({ cdp: { url: 'http://127.0.0.1:1', pageMatch: '离线卡片撤回' } });
  getDriverTestInternals(driver).bridgeMessageOps = new BridgeMessageOps(native.cdp);
  const recalled: KK9RecalledEvent[] = [];
  driver.on('recalled', event => recalled.push(event));
  const options: SendOptions = { operationId: 'facade-card-recall', targetLoginName: '00AbC' };
  const pending = driver.sendAppMessage({ title: '应用', content: '<p>固定首次私聊</p>' }, options);
  await gate.started;
  options.targetLoginName = undefined;
  options.targetSessionId = '93002';
  gate.release();
  const result = await pending;
  expect(result).toMatchObject({
    status: 'sent',
    sessionId: '94001',
    receipt: { sessionId: '94001' },
  });
  expect(native.records).toHaveLength(1);
  expect(native.records[0]).toMatchObject({ sessionID: 94001, receiver: 91003, contentType: 8 });
  if (!result.recall) throw new Error('已确认卡片缺少快捷撤回');
  expect(await result.recall()).toBe(true);
  expect(native.records[0]?.['msgFlag']).toBe('C');
  expect(
    native.ipc.sent
      .filter(request => request.args[0] === 'cancelMessage')
      .map(request => request.args[1])
  ).toMatchObject([{ sessionID: 94001, msgID: 135700000, msgIdx: 1 }]);
  expect(recalled).toMatchObject([{ sessionId: '94001', messageId: '135700000' }]);
});
