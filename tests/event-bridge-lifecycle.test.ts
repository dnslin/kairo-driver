import EventEmitter from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { KK9EventBridge } from '../src/bridge/event-bridge.js';
import { extractRecalledEventsFromPayload } from '../src/bridge/converter.js';
import { SUBMIT_NATIVE_MESSAGE_SCRIPT } from '../src/bridge/renderer-script.js';
import { CdpClient } from '../src/cdp/client.js';
import type {
  CdpConnectionIdentity,
  ConnectionStatus,
  KK9Message,
  KK9RecalledEvent,
} from '../src/types/index.js';
import { createRendererRuntime, runRendererScript } from './helpers/renderer-runtime.js';

const bindingName = '__kairo_native_bridge';
const cdpConfig = { url: 'http://127.0.0.1:1', pageMatch: '离线生命周期' };

function createPage(sessionId = '会话', nativeSessionId: string | number = sessionId) {
  const bus = new EventEmitter();
  const rendererBus = { $on: bus.on.bind(bus), $off: bus.off.bind(bus) };
  const runtime = createRendererRuntime({
    main: { $bus: rendererBus },
    sessions: [{ id: nativeSessionId, sesUUID: sessionId }],
  });
  const windowObject = runtime.context['window'] as Record<string, unknown>;
  const ipc = new EventEmitter();
  windowObject['ipcRenderer'] = ipc;
  const originalRevoke = vi.fn(() => '原撤回方法结果');
  const chat: {
    addRevokeMsg: (data: unknown) => unknown;
    sesInfo: { sesUUID?: string; id?: string | number; type?: number; typeID?: number };
    __kairo_revoke_active?: boolean;
  } = {
    addRevokeMsg: originalRevoke,
    sesInfo: { sesUUID: sessionId },
  };
  const observers = new Set<{ notify: () => void }>();
  runtime.context['MutationObserver'] = class {
    constructor(public readonly notify: () => void) {}
    observe() {
      observers.add(this);
    }
    disconnect() {
      observers.delete(this);
    }
  };
  Object.assign(runtime.context['document'] as object, {
    body: {},
    querySelectorAll: () => [{ __vue__: chat }],
  });

  function createBridge(generationId: string, connectionId: string, currentUserId?: string) {
    const cdp = new CdpClient(cdpConfig, { startupGenerationId: generationId });
    let status: ConnectionStatus = 'disconnected';
    const identity: CdpConnectionIdentity = {
      startupGenerationId: generationId,
      connectionId,
      targetId: '页面',
      webSocketDebuggerUrl: 'ws://127.0.0.1:1/离线',
      connectedAt: 1,
    };
    vi.spyOn(cdp, 'getStatus').mockImplementation(() => status);
    vi.spyOn(cdp, 'getConnectionIdentity').mockImplementation(() =>
      status === 'connected' ? identity : null
    );
    vi.spyOn(cdp, 'connect').mockImplementation(() => {
      status = 'connected';
      cdp.emit('status', status);
      return Promise.resolve();
    });
    vi.spyOn(cdp, 'disconnect').mockImplementation(() => {
      status = 'disconnected';
      cdp.emit('status', status);
      return Promise.resolve();
    });
    vi.spyOn(cdp, 'sendCommand').mockImplementation(method => {
      if (method === 'Runtime.addBinding') {
        windowObject[bindingName] = (payload: string) =>
          cdp.emit('Runtime.bindingCalled', { name: bindingName, payload });
      }
      if (method === 'Runtime.removeBinding') delete windowObject[bindingName];
      return Promise.resolve({});
    });
    vi.spyOn(cdp, 'evaluate').mockImplementation(script =>
      runRendererScript(script, runtime.context)
    );
    const bridge = new KK9EventBridge(
      { cdp: cdpConfig, startupGenerationId: generationId, currentUserId },
      cdp
    );
    return { cdp, bridge };
  }
  return {
    bus,
    ipc,
    rendererBus,
    runtime,
    windowObject,
    originalRevoke,
    chat,
    observers,
    createBridge,
  };
}

const nativeSubmissionScript = `(async () => {
  const ipc = window.ipcRenderer;
  ${SUBMIT_NATIVE_MESSAGE_SCRIPT}
  const callIpc = window.nativeSubmitIpc;
  const waitForPersistedMessage = window.confirmNativeSend;
  if (window.beforeNativeSubmit) await window.beforeNativeSubmit();
  return submitNativeMessage({ sessionID: 716791, sender: 91001, receiver: 91002,
    sessionType: 0, contentType: 4, content: '请求正文', msgFlag: '本次原生标识' },
    { id: 716791, sesUUID: '0-91002', type: 0, typeID: 91002 });
})()`;

function configureNativeSubmission(windowObject: Record<string, unknown>) {
  const confirmed = {
    id: '136000001',
    sessionID: 716791,
    sender: 91001,
    contentType: 4,
    content: { content: [{ type: 0, text: '原生确认正文' }] },
    msgIdx: 10,
  };
  windowObject['nativeSubmitIpc'] = (channel: string) => {
    if (channel === 'insertSendBefoeMsg')
      return Promise.resolve({ code: 0, data: { id: -1, msgIdx: 9 } });
    (windowObject['ipcRenderer'] as EventEmitter).emit(
      '0-91002-sendMsgCallback',
      {},
      { args: { msgID: -1, code: 0, data: { sessionID: 716791 } } }
    );
    return Promise.resolve({ code: 0 });
  };
  windowObject['confirmNativeSend'] = () => Promise.resolve(confirmed);
  return confirmed;
}

afterEach(() => vi.restoreAllMocks());

describe('T04 原生实时独立链路', () => {
  it('没有实际聊天组件与 Vue 总线仍能连接、接收及关闭原生事件', async () => {
    const page = createPage();
    Object.assign(page.runtime.context['document'] as object, {
      querySelector: () => null, querySelectorAll: () => [],
    });
    delete page.windowObject['vueBus'];
    const { bridge } = page.createBridge('无组件', '连接', '91001');
    const messages: KK9Message[] = [];
    bridge.on('message', message => messages.push(message));
    await bridge.connect();
    try {
      page.ipc.emit('message', {}, { args: { sessionID: 716791, message: [
        { id: 1001, sender: 91002, contentType: 4, content: '新入站' },
      ] } });
      expect(messages).toMatchObject([{ id: '1001', direction: 'inbound', senderId: '91002' }]);
    } finally { await bridge.disconnect(); }
    expect(page.ipc.listenerCount('message')).toBe(0);
  });

  it.each(['原生先到', '确认先到'])('%s与重复包只派发一次已确认 SDK 回显及提及', async order => {
    const page = createPage();
    const { bridge } = page.createBridge(order, '连接', '91001');
    const confirmed = { id: 1001, sessionID: 716791, sender: 91001,
      contentType: 4, content: 'SDK回显', msgFlag: '本次意图', atMemberIDList: [91001] };
    const envelope = { sessionID: 716791, message: [confirmed] };
    const messages: KK9Message[] = [];
    const ats: KK9Message[] = [];
    bridge.on('message', message => messages.push(message));
    bridge.on('at', message => ats.push(message));
    await bridge.connect();
    try {
      const observer = page.windowObject['__kairo_native_send_observer'] as (data: unknown) => void;
      observer({ stage: 'pending', key: '本次意图', sessionID: 716791 });
      if (order === '原生先到') {
        page.ipc.emit('message', {}, { args: envelope });
        expect(messages).toEqual([]);
      }
      observer({ stage: 'confirmed', key: '本次意图', ...envelope });
      page.ipc.emit('message', {}, { args: envelope });
      observer({ stage: 'settled', key: '本次意图' });
      page.ipc.emit('message', {}, { args: envelope });
      expect(messages).toMatchObject([{ id: '1001', sessionId: '716791', direction: 'outbound', sdkSendKey: '本次意图' }]);
      expect(messages).toHaveLength(1);
      expect(ats).toEqual(messages);
    } finally { await bridge.disconnect(); }
  });

  it.each(['原生先到', '确认先到'])('首次会话%s只延迟匹配本人、接收对象和类型的回显', async order => {
    const page = createPage();
    const { bridge } = page.createBridge('首次会话' + order, '连接', '91001');
    const key = '首次工号发送';
    const confirmed = { id: 1001, sessionID: 94001, sender: 91001, receiver: 91003,
      sessionType: 0, contentType: 4, content: '首次文本', msgFlag: key, msgIdx: 1 };
    const unrelated = [
      { ...confirmed, id: 1002, sender: 91004 },
      { ...confirmed, id: 1003, sessionID: 94002, receiver: 91004 },
      { ...confirmed, id: 1004, sessionID: 94003, sessionType: 1 },
    ];
    const messages: KK9Message[] = [];
    bridge.on('message', message => messages.push(message));
    await bridge.connect();
    try {
      page.windowObject['nativeSubmitIpc'] = (method: string) => {
        if (method === 'getSessionBySessionID') return Promise.resolve({ code: 0, data: {
          id: 94001, type: 0, typeID: 91003, creater: 91001, typeName: '准确接收者',
        } });
        if (method === 'insertSendBefoeMsg') return Promise.resolve({ code: 0, data: { id: -1, msgIdx: 1.001 } });
        for (const message of unrelated) page.ipc.emit('message', {}, { args: {
          sessionID: message.sessionID, message: [message],
        } });
        expect(messages.map(message => message.id)).toEqual(['1002', '1003', '1004']);
        if (order === '原生先到') {
          page.ipc.emit('message', {}, { args: { sessionID: 94001, message: [confirmed] } });
          expect(messages).toHaveLength(3);
        }
        page.ipc.emit('0-91003-sendMsgCallback', {}, {
          args: { msgID: -1, code: 0, data: confirmed },
        });
        return Promise.resolve({ code: 0 });
      };
      page.windowObject['confirmNativeSend'] = () => Promise.resolve(confirmed);
      const result = await runRendererScript<{ confirmedMessage?: unknown }>(`(async () => {
        const ipc = window.ipcRenderer;
        ${SUBMIT_NATIVE_MESSAGE_SCRIPT}
        const callIpc = window.nativeSubmitIpc;
        const waitForPersistedMessage = window.confirmNativeSend;
        return submitNativeMessage({ sessionID: 0, sender: 91001, receiver: 91003,
          sessionType: 0, contentType: 4, content: '首次文本', msgFlag: ${JSON.stringify(key)} },
          { id: 0, type: 0, typeID: 91003 }, 50, undefined, 'int2023');
      })()`, page.runtime.context);
      expect(result).toMatchObject({ confirmedMessage: confirmed });
      page.ipc.emit('message', {}, { args: { sessionID: 94001, message: [confirmed] } });
      page.ipc.emit('message', {}, { args: { sessionID: 94001, message: [confirmed] } });
      expect(messages).toHaveLength(4);
      expect(messages[3]).toMatchObject({ id: '1001', sessionId: '94001', direction: 'outbound', sdkSendKey: key });
      expect(messages.slice(0, 3).map(message => message.sdkSendKey)).toEqual([undefined, undefined, undefined]);
      expect(messages[0]).toMatchObject({ direction: 'inbound' });
      expect(messages.slice(1, 3).map(message => message.sessionId)).toEqual(['94002', '94003']);
      expect(page.ipc.listenerCount('0-91003-sendMsgCallback')).toBe(0);
    } finally { await bridge.disconnect(); }
  });

  it.each(['failed', 'unknown'])('%s释放真实本人消息，不伪造 SDK 确认', async status => {
    const page = createPage();
    const { bridge } = page.createBridge(status, '连接', '91001');
    const messages: KK9Message[] = [];
    bridge.on('message', message => messages.push(message));
    await bridge.connect();
    try {
      const observer = page.windowObject['__kairo_native_send_observer'] as (data: unknown) => void;
      observer({ stage: 'pending', key: '未确认意图', sessionID: 716791 });
      page.ipc.emit('message', {}, { args: { sessionID: 716791, message: [
        { id: 1001, sender: 91001, content: '真实本人消息', msgFlag: '未确认意图' },
      ] } });
      expect(messages).toEqual([]);
      observer({ stage: 'settled', key: '未确认意图' });
      expect(messages).toMatchObject([{ id: '1001', direction: 'outbound' }]);
      expect(messages[0]?.sdkSendKey).toBeUndefined();
    } finally { await bridge.disconnect(); }
  });

  it('真实组件清空会话回调后只处理本 SDK 等待，不恢复其他监听', async () => {
    vi.useFakeTimers();
    const page = createPage('0-91002');
    const { bridge } = page.createBridge('组件清理', '连接', '91001');
    const confirmed = { ...configureNativeSubmission(page.windowObject), msgFlag: '本次原生标识' };
    const channel = '0-91002-sendMsgCallback';
    const other = vi.fn();
    page.ipc.on(channel, other);
    page.windowObject['nativeSubmitIpc'] = (method: string) => {
      if (method === 'insertSendBefoeMsg') return Promise.resolve({ code: 0, data: { id: -1 } });
      page.ipc.removeAllListeners(channel);
      page.ipc.emit(channel, {}, { args: { msgID: -1, code: 0, data: confirmed } });
      return Promise.resolve({ code: 0 });
    };
    const originalEmit = page.ipc.emit;
    const messages: KK9Message[] = [];
    bridge.on('message', message => messages.push(message));
    await bridge.connect();
    try {
      const pending = runRendererScript<{ confirmedMessage?: unknown; failure?: unknown }>(nativeSubmissionScript, page.runtime.context);
      await vi.runAllTimersAsync();
      expect(await pending).toMatchObject({ confirmedMessage: confirmed });
      expect(messages).toMatchObject([{ id: confirmed.id, sdkSendKey: '本次原生标识', direction: 'outbound' }]);
      expect(messages).toHaveLength(1);
      expect(page.ipc.listeners(channel)).toEqual([]);
      expect(other).not.toHaveBeenCalled();
    } finally {
      await bridge.disconnect();
      vi.useRealTimers();
    }
    expect(page.ipc.emit).toBe(originalEmit);
  });

  it('session-only 状态不制造 message/at/recalled，原生系统通知保留，历史回包不重放', async () => {
    const page = createPage();
    const { bridge } = page.createBridge('状态分流', '连接', '91001');
    const messages: KK9Message[] = [];
    const ats: KK9Message[] = [];
    const recalls: KK9RecalledEvent[] = [];
    bridge.on('message', message => messages.push(message));
    bridge.on('at', message => ats.push(message));
    bridge.on('recalled', event => recalls.push(event));
    await bridge.connect();
    try {
      page.ipc.emit('message', {}, { args: { sessionID: 716791, session: { id: 716791, userReadIndex: 1001, atState: 2 } } });
      page.ipc.emit('data-100', {}, { code: 0, data: [{ id: 2001, sessionID: 716791, contentType: 6, content: { event: 'CancelMessage', msgID: 1001 } }] });
      expect(messages).toEqual([]);
      expect(ats).toEqual([]);
      expect(recalls).toEqual([]);
      page.ipc.emit('message', {}, { args: { sessionID: 716791, message: [
        { id: 2002, sender: 91002, contentType: 6, content: { event: 'ModifyGroupName', data: '普通通知' } },
      ] } });
      expect(messages).toMatchObject([{ id: '2002', messageType: 'system', origin: 'system', direction: 'unknown' }]);
      expect(ats).toEqual([]);
      expect(recalls).toEqual([]);
    } finally { await bridge.disconnect(); }
  });

  it('本机人工业务回调和他设备本人原生消息均 outbound，不标记 SDK；跨会话同号不丢失', async () => {
    const page = createPage();
    const { bridge } = page.createBridge('本人来源', '连接', '91001');
    const messages: KK9Message[] = [];
    bridge.on('message', message => messages.push(message));
    await bridge.connect();
    try {
      const manual = { id: 1001, sessionID: 716791, sender: 91001, sessionType: 0, content: '本机人工文本', deviceID: 1 };
      page.ipc.emit('0-91002-sendMsgCallback', {}, { args: { code: 0, msgID: -1, data: manual } });
      page.ipc.emit('message', {}, { args: { sessionID: 716791, message: [manual] } });
      page.ipc.emit('message', {}, { args: { sessionID: 793803, message: [{ ...manual, sessionID: 793803, sessionType: 1, deviceID: 2 }] } });
      page.ipc.emit('0-91002-sendMsgCallback', {}, { args: { code: 0, msgID: -2, data: { ...manual, id: 1002, ext: { status: 617 } } } });
      expect(messages.map(message => ({ id: message.id, session: message.sessionId, type: message.sessionType, direction: message.direction, key: message.sdkSendKey }))).toEqual([
        { id: '1001', session: '716791', type: 'private', direction: 'outbound', key: undefined },
        { id: '1001', session: '793803', type: 'group', direction: 'outbound', key: undefined },
      ]);
    } finally { await bridge.disconnect(); }
  });

  it('待确认意图只暂存本次本人会话，不暂存他会话同号或同意图键', async () => {
    const page = createPage();
    const { bridge } = page.createBridge('范围竞态', '连接', '91001');
    const messages: KK9Message[] = [];
    bridge.on('message', message => messages.push(message));
    await bridge.connect();
    try {
      const observer = page.windowObject['__kairo_native_send_observer'] as (data: unknown) => void;
      observer({ stage: 'pending', key: '当前意图', sessionID: 716791 });
      const native = { id: 1001, sender: 91001, msgFlag: '当前意图', content: '正式文本' };
      page.ipc.emit('message', {}, { args: { sessionID: 793803, message: [native] } });
      page.ipc.emit('message', {}, { args: { sessionID: 716791, message: [native] } });
      expect(messages.map(message => message.sessionId)).toEqual(['793803']);
      observer({ stage: 'confirmed', key: '当前意图', sessionID: 716791, message: [native] });
      observer({ stage: 'settled', key: '当前意图' });
      expect(messages.map(message => ({ session: message.sessionId, key: message.sdkSendKey }))).toEqual([
        { session: '793803', key: undefined }, { session: '716791', key: '当前意图' },
      ]);
    } finally { await bridge.disconnect(); }
  });

  it('组件清空监听后异常业务ext仍立即结束unknown，不等待超时或伪造回显', async () => {
    vi.useFakeTimers();
    const page = createPage('0-91002');
    const { bridge } = page.createBridge('异常回执', '连接', '91001');
    const confirmed = { ...configureNativeSubmission(page.windowObject), msgFlag: '本次原生标识', ext: '{无效JSON' };
    page.windowObject['nativeSubmitIpc'] = (method: string) => {
      if (method === 'insertSendBefoeMsg') return Promise.resolve({ code: 0, data: { id: -1 } });
      page.ipc.removeAllListeners('0-91002-sendMsgCallback');
      page.ipc.emit('0-91002-sendMsgCallback', {}, { args: { msgID: -1, code: 0, data: confirmed } });
      return Promise.resolve({ code: 0 });
    };
    const messages: KK9Message[] = [];
    bridge.on('message', message => messages.push(message));
    await bridge.connect();
    let result: { failure: { status: string } } | undefined;
    const pending = runRendererScript<{ failure: { status: string } }>(nativeSubmissionScript, page.runtime.context)
      .then(value => { result = value; });
    try {
      await vi.advanceTimersByTimeAsync(1);
      expect(result).toMatchObject({ failure: { status: 'unknown' } });
      expect(messages).toEqual([]);
    } finally {
      await vi.runAllTimersAsync(); await pending;
      await bridge.disconnect(); vi.useRealTimers();
    }
  });
});

describe('EventBridge 渲染资源所有权关闭', () => {
  it('只有原生确认后才在调用返回前回显真实记录，其他来源重复与Vue历史不再派发', async () => {
    const page = createPage('0-91002');
    const { bridge } = page.createBridge('发送代次', '连接', '91001');
    const confirmed = configureNativeSubmission(page.windowObject);
    let release!: (value: typeof confirmed) => void;
    let entered!: () => void;
    const started = new Promise<void>(resolve => {
      entered = resolve;
    });
    const gate = new Promise<typeof confirmed>(resolve => {
      release = resolve;
    });
    page.windowObject['confirmNativeSend'] = () => {
      entered();
      return gate;
    };
    const messages: KK9Message[] = [];
    let returned = false;
    const beforeReturn: boolean[] = [];
    bridge.on('message', message => {
      beforeReturn.push(!returned);
      messages.push(message);
    });
    await bridge.connect();
    try {
      const work = runRendererScript(nativeSubmissionScript, page.runtime.context);
      await started;
      expect(messages).toEqual([]);
      release(confirmed);
      await work;
      returned = true;
      const envelope = { session: { id: 716791, type: 0, typeID: 91002 }, message: [confirmed] };
      page.ipc.emit('message', {}, { args: envelope });
      page.bus.emit('receive-message', envelope);
      page.bus.emit('0-91002-msg', [confirmed]);
      expect(
        messages.map(message => ({
          id: message.id,
          sessionId: message.sessionId,
          content: message.content,
          direction: message.direction,
        }))
      ).toEqual([
        { id: confirmed.id, sessionId: '716791', content: '原生确认正文', direction: 'outbound' },
      ]);
      expect(beforeReturn).toEqual([true]);
    } finally {
      release(confirmed);
      await bridge.disconnect();
    }
  });

  it.each(['发送ack失败', '没有确认记录'])('%s不得根据请求正文伪造成功回显', async failure => {
    vi.useFakeTimers();
    const page = createPage('0-91002');
    const { bridge } = page.createBridge('发送失败', '连接', '91001');
    configureNativeSubmission(page.windowObject);
    if (failure === '发送ack失败')
      page.windowObject['nativeSubmitIpc'] = (channel: string) =>
        Promise.resolve(
          channel === 'insertSendBefoeMsg' ? { code: 0, data: { id: -1 } } : { code: 1 }
        );
    else page.windowObject['confirmNativeSend'] = () => Promise.resolve(null);
    const messages: KK9Message[] = [];
    bridge.on('message', message => messages.push(message));
    await bridge.connect();
    try {
      const pending = runRendererScript<{ failure: { status: string } }>(
        nativeSubmissionScript,
        page.runtime.context
      );
      await vi.runAllTimersAsync();
      const result = await pending;
      expect(result.failure.status).toBe('unknown');
      expect(messages).toEqual([]);
    } finally {
      await bridge.disconnect();
    }
  });

  it('发送脚本预处理跨越换代也只能持有旧回调，旧实例关闭不破坏新回显', async () => {
    const page = createPage('0-91002');
    configureNativeSubmission(page.windowObject);
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>(resolve => {
      entered = resolve;
    });
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    page.windowObject['beforeNativeSubmit'] = () => {
      entered();
      return gate;
    };
    const older = page.createBridge('旧发送代次', '旧连接', '91001');
    await older.bridge.connect();
    const oldWork = runRendererScript(nativeSubmissionScript, page.runtime.context);
    await started;
    await older.cdp.disconnect();
    const newer = page.createBridge('新发送代次', '新连接', '91001');
    const messages: KK9Message[] = [];
    newer.bridge.on('message', message => messages.push(message));
    try {
      await newer.bridge.connect();
      await older.bridge.disconnect();
      delete page.windowObject['beforeNativeSubmit'];
      release();
      await oldWork;
      expect(messages).toEqual([]);
      await runRendererScript(nativeSubmissionScript, page.runtime.context);
      expect(messages.map(message => message.id)).toEqual(['136000001']);
    } finally {
      release();
      await oldWork;
      await newer.bridge.disconnect();
    }
  });

  it('关闭释放本实例订阅、撤回方法、观察器和binding，重复关闭不再清理', async () => {
    const page = createPage();
    const { bridge } = page.createBridge('当前代', '当前连接');
    await bridge.connect();
    expect(page.chat.addRevokeMsg).not.toBe(page.originalRevoke);
    expect(page.bus.listenerCount('会话-msg')).toBe(1);
    expect(page.observers.size).toBe(1);

    const closing = bridge.disconnect();
    expect(bridge.disconnect()).toBe(closing);
    await closing;
    expect(page.bus.eventNames()).toEqual([]);
    expect(page.chat.addRevokeMsg).toBe(page.originalRevoke);
    expect(page.chat.__kairo_revoke_active).toBeUndefined();
    expect(page.observers.size).toBe(0);
    expect(page.windowObject[bindingName]).toBeUndefined();
    expect(page.windowObject['__kairo_bridge_cleanup']).toBeUndefined();
    expect(bridge.getStatus()).toBe('disconnected');
    expect(bridge.isAttached()).toBe(false);
    await bridge.disconnect();
  });

  it.each([
    ['新代', '新连接'],
    ['原代', '新连接'],
  ])('旧实例关闭不破坏已接管页面的%s/%s', async (generationId, connectionId) => {
    const page = createPage();
    const older = page.createBridge('原代', '原连接');
    const newer = page.createBridge(generationId, connectionId);
    await older.bridge.connect();
    await newer.bridge.connect();
    const newHook = page.chat.addRevokeMsg;
    const newCleanup = page.windowObject['__kairo_bridge_cleanup'];
    const received: KK9Message[] = [];
    newer.bridge.on('message', message => received.push(message));

    await older.bridge.disconnect();
    expect(page.chat.addRevokeMsg).toBe(newHook);
    expect(page.windowObject['__kairo_bridge_cleanup']).toBe(newCleanup);
    expect(page.observers.size).toBe(1);
    expect(page.bus.listenerCount('receive-message')).toBe(1);
    page.ipc.emit(
      'message',
      {},
      {
        args: {
          id: '消息',
          sessionID: '会话',
          sender: '员工',
          content: '接管后消息',
        },
      }
    );
    expect(received.map(message => message.id)).toEqual(['消息']);
    await newer.bridge.disconnect();
    expect(page.chat.addRevokeMsg).toBe(page.originalRevoke);
    expect(page.bus.eventNames()).toEqual([]);
  });

  it('渲染清理异常仍关闭本机CDP，并向调用方保留失败', async () => {
    const page = createPage();
    const { bridge } = page.createBridge('清理异常代', '连接');
    await bridge.connect();
    const originalOff = page.bus.off.bind(page.bus);
    // 修改已注入清理调用的真实总线方法，而非模拟脚本结果。
    page.rendererBus.$off = (event, handler) => {
      originalOff(event, handler);
      if (event === 'receive-message') throw new Error('取消订阅失败');
      return page.bus;
    };

    await expect(bridge.disconnect()).rejects.toThrow('清理');
    expect(bridge.getStatus()).toBe('disconnected');
    expect(page.bus.eventNames()).toEqual([]);
    expect(page.chat.addRevokeMsg).toBe(page.originalRevoke);
    expect(page.observers.size).toBe(0);
    expect(page.windowObject[bindingName]).toBeUndefined();
  });

  it('失去连接后不伪造远端已清理，仍释放本机连接', async () => {
    const page = createPage();
    const { cdp, bridge } = page.createBridge('失联代', '连接');
    await bridge.connect();
    const cleanup = page.windowObject['__kairo_bridge_cleanup'];
    await cdp.disconnect();
    await bridge.disconnect();
    expect(bridge.getStatus()).toBe('disconnected');
    expect(page.windowObject['__kairo_bridge_cleanup']).toBe(cleanup);
    expect(page.bus.listenerCount('receive-message')).toBe(1);
    // 新实例仍能按既有接管语义清理不可达前代。
    const next = page.createBridge('恢复代', '新连接');
    await next.bridge.connect();
    await next.bridge.disconnect();
    expect(page.bus.eventNames()).toEqual([]);
  });

  it('清理脚本执行失败仍关闭本机CDP且不宣称远端释放成功', async () => {
    const page = createPage();
    const { cdp, bridge } = page.createBridge('脚本异常代', '连接');
    await bridge.connect();
    const cause = new Error('渲染执行失败');
    vi.mocked(cdp.evaluate).mockRejectedValueOnce(cause);
    await expect(bridge.disconnect()).rejects.toBe(cause);
    expect(bridge.getStatus()).toBe('disconnected');
    expect(page.bus.listenerCount('receive-message')).toBe(1);
    const next = page.createBridge('恢复代', '新连接');
    await next.bridge.connect();
    await next.bridge.disconnect();
    expect(page.bus.eventNames()).toEqual([]);
  });

  it('注入中途失败也清理已安装的订阅和binding并断开CDP', async () => {
    const page = createPage();
    const { bridge } = page.createBridge('失败代', '连接');
    const originalOn = page.rendererBus.$on;
    page.rendererBus.$on = (event, handler) => {
      if (event === 'CancelMessage') throw new Error('订阅初始化失败');
      return originalOn(event, handler);
    };
    await expect(bridge.connect()).rejects.toThrow('注入失败');
    expect(bridge.getStatus()).toBe('disconnected');
    expect(page.bus.eventNames()).toEqual([]);
    expect(page.windowObject[bindingName]).toBeUndefined();
    expect(page.windowObject['__kairo_bridge_cleanup']).toBeUndefined();
    await bridge.disconnect();
  });

  it.each([0, 1])('原生IPC会话类型%d使用原生会话ID而非用户UID，保留正文与入站身份', async type => {
    const page = createPage();
    const { bridge } = page.createBridge('原生载荷', '连接', '91001');
    const received: KK9Message[] = [];
    bridge.on('message', message => received.push(message));
    await bridge.connect();
    page.ipc.emit(
      'message',
      {},
      {
        args: {
          sessionID: 716791,
          session: { id: 716791, type, typeID: 91002, typeName: '测试员工' },
          message: [
            {
              id: 136018959,
              sessionID: 716791,
              sessionType: type,
              sender: 91002,
              senderName: '测试员工',
              contentType: 4,
              content: { content: [{ type: 0, text: 'T26-开始' }] },
            },
          ],
        },
      }
    );
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      id: '136018959',
      sessionId: '716791',
      sessionType: type === 0 ? 'private' : 'group',
      content: 'T26-开始',
      senderId: '91002',
      direction: 'inbound',
    });
    await bridge.disconnect();
  });

  it.each([
    { name: '顶层事件', data: { event: 'CancelMessage', msgID: '待撤回' } },
    {
      name: '正文内事件',
      data: {
        message: [
          {
            sessionID: 716791,
            contentType: 6,
            content: { event: 'CancelMessage', msgID: '待撤回' },
          },
        ],
      },
    },
    {
      name: '消息内事件',
      data: { message: [{ sessionID: 716791, event: 'CancelMessage', msgID: '待撤回' }] },
    },
  ])('原生撤回$name沿用普通消息会话，与Vue来源重复事件只派发一次', async ({ data }) => {
    const page = createPage();
    const { bridge } = page.createBridge('撤回载荷', '连接', '91001');
    const messages: KK9Message[] = [];
    const recalls: KK9RecalledEvent[] = [];
    bridge.on('message', message => messages.push(message));
    bridge.on('recalled', event => recalls.push(event));
    await bridge.connect();
    try {
      const envelope = { sessionID: 716791, session: { id: 716791, type: 0, typeID: 91002 } };
      page.ipc.emit(
        'message',
        {},
        { args: { ...envelope, message: [{ id: '待撤回', sender: 91002, content: '测试问题' }] } }
      );
      expect(messages[0]?.sessionId).toBe('716791');
      page.ipc.emit('message', {}, { args: { ...envelope, ...data } });
      page.bus.emit('receive-message', { ...envelope, ...data });
      page.bus.emit('CancelMessage', { ...envelope, msgID: '待撤回' });
      page.bus.emit('CancelMessage', { msgID: '待撤回', sessionID: 716791 });
      expect(
        recalls.map(event => ({ messageId: event.messageId, sessionId: event.sessionId }))
      ).toEqual([{ messageId: messages[0]?.id, sessionId: messages[0]?.sessionId }]);
    } finally {
      await bridge.disconnect();
    }
  });

  it.each(['msg', 'revokeMsg'])('会话%s通道使用消息内原生编号而非界面事件名', async channel => {
    const page = createPage('0-91002');
    const { bridge } = page.createBridge('会话撤回', '连接');
    const recalls: KK9RecalledEvent[] = [];
    bridge.on('recalled', event => recalls.push(event));
    await bridge.connect();
    try {
      const payload = { sessionID: 716791, event: 'CancelMessage', msgID: '待撤回' };
      page.bus.emit(`0-91002-${channel}`, channel === 'msg' ? [payload] : payload);
      expect(
        recalls.map(event => ({ messageId: event.messageId, sessionId: event.sessionId }))
      ).toEqual([{ messageId: '待撤回', sessionId: '716791' }]);
    } finally {
      await bridge.disconnect();
    }
  });

  it.each(['预挂已知会话', '动态新增会话', '补齐已监听会话'])(
    '%s的本机撤回仅有msgID/msgIdx时沿用已知原生身份，与组件和原生通知只派发一次',
    async source => {
      const dynamic = source !== '预挂已知会话';
      const page = createPage(dynamic ? '已有界面会话' : '0-91002', dynamic ? 800001 : 716791);
      if (source === '补齐已监听会话') {
        page.runtime.editor.sortedSessions.push({ id: '', sesUUID: '0-91002' });
      }
      page.chat.sesInfo = { sesUUID: '0-91002' };
      const { bridge } = page.createBridge('本机撤回', '连接');
      const recalls: KK9RecalledEvent[] = [];
      bridge.on('recalled', event => recalls.push(event));
      await bridge.connect();
      try {
        if (dynamic) {
          const session = { id: 716791, sesUUID: '0-91002', type: 0, typeID: 91002 };
          page.runtime.editor.sortedSessions.push(session);
          page.bus.emit('receive-message', { session, message: [] });
        }
        expect(page.bus.listenerCount('0-91002-revokeMsg')).toBe(1);
        const localNotice = { msgID: 136018959, msgIdx: 651 };
        page.bus.emit('0-91002-revokeMsg', localNotice);
        page.bus.emit('CancelMessage', { ...localNotice, sesUUID: '0-91002' });
        expect(page.chat.addRevokeMsg(localNotice)).toBe('原撤回方法结果');
        page.ipc.emit(
          'message',
          {},
          {
            args: {
              sessionID: 716791,
              message: [
                {
                  id: 136018960,
                  contentType: 6,
                  content: { event: 'CancelMessage', msgID: 136018959 },
                },
              ],
            },
          }
        );
        expect(
          recalls.map(event => ({ messageId: event.messageId, sessionId: event.sessionId }))
        ).toEqual([{ messageId: '136018959', sessionId: '716791' }]);
        expect(page.originalRevoke).toHaveBeenCalledOnce();
        expect(page.originalRevoke).toHaveBeenCalledWith(localNotice);
      } finally {
        await bridge.disconnect();
      }
      expect(page.bus.listenerCount('0-91002-revokeMsg')).toBe(0);
      expect(page.chat.addRevokeMsg).toBe(page.originalRevoke);
      expect(page.ipc.listenerCount('message')).toBe(0);
    }
  );

  it('仅有界面会话标识的本机与组件撤回不合成原生身份', async () => {
    const page = createPage('0-91002', '');
    const { bridge } = page.createBridge('身份缺失', '连接');
    const recalls: KK9RecalledEvent[] = [];
    bridge.on('recalled', event => recalls.push(event));
    await bridge.connect();
    try {
      const notice = { msgID: 136018959, msgIdx: 651 };
      page.bus.emit('0-91002-revokeMsg', notice);
      page.bus.emit('CancelMessage', { ...notice, sesUUID: '0-91002' });
      expect(page.chat.addRevokeMsg(notice)).toBe('原撤回方法结果');
      expect(recalls).toEqual([]);
      expect(page.originalRevoke).toHaveBeenCalledOnce();
      expect(page.originalRevoke).toHaveBeenCalledWith(notice);
    } finally {
      await bridge.disconnect();
    }
  });

  it('单条历史撤回通知只提取正文目标，不使用通知自身ID或普通原记录的msgID', () => {
    const session = { id: '716791' };
    expect(
      extractRecalledEventsFromPayload(
        {
          id: 136018960,
          contentType: 6,
          content: JSON.stringify({ event: 'CancelMessage', msgID: 136018959 }),
        },
        session
      )
    ).toMatchObject([{ messageId: '136018959', sessionId: '716791' }]);
    for (const msgFlag of ['C', 'D', 'C后缀', 'D后缀']) {
      expect(
        extractRecalledEventsFromPayload(
          {
            msgID: 136018959,
            contentType: 4,
            msgFlag,
            content: { event: 'CancelMessage', msgID: '错误目标' },
          },
          session
        )
      ).toEqual([]);
    }
    expect(
      extractRecalledEventsFromPayload(
        { msgID: 136018959, contentType: 4, content: '普通正文' },
        session
      )
    ).toEqual([]);
    expect(
      extractRecalledEventsFromPayload(
        {
          msgID: 136018959,
          contentType: 4,
          content: { event: 'CancelMessage', msgID: '正文伪目标' },
        },
        session
      )
    ).toEqual([]);
    expect(
      extractRecalledEventsFromPayload(
        { id: 136018960, contentType: 6, content: { event: 'MemberJoin', msgID: 136018959 } },
        session
      )
    ).toEqual([]);
    expect(
      extractRecalledEventsFromPayload(
        { id: 136018960, contentType: 6, content: { event: 'CancelMessage' } },
        session
      )
    ).toEqual([]);
  });

  it('组件重建后捕获新原生会话的人工撤回，重复服务器通知不重放，退出保留其他监听', async () => {
    const page = createPage('0-91002', 716791);
    const { bridge } = page.createBridge('重建撤回', '连接');
    const events: KK9RecalledEvent[] = [];
    bridge.on('recalled', event => events.push(event));
    const other = vi.fn();
    page.ipc.on('message', other);
    const rebuiltOriginal = vi.fn((_data: unknown) => '重建原方法结果');
    const rebuilt = { sesInfo: { id: 793803, sesUUID: '1-29467' }, addRevokeMsg: rebuiltOriginal };
    await bridge.connect();
    try {
      Object.assign(page.runtime.context['document'] as object, {
        querySelectorAll: () => [{ __vue__: rebuilt }],
      });
      for (const observer of page.observers) observer.notify();
      expect(rebuilt.addRevokeMsg({ msgID: 123, msgIdx: 9 })).toBe('重建原方法结果');
      page.ipc.emit('message', {}, { args: { sessionID: 793803, message: [
        { id: 456, contentType: 6, content: { event: 'CancelMessage', msgID: 123 } },
      ] } });
      expect(events.map(event => [event.sessionId, event.messageId])).toEqual([['793803', '123']]);
    } finally { await bridge.disconnect(); }
    expect(rebuilt.addRevokeMsg).toBe(rebuiltOriginal);
    expect(page.chat.addRevokeMsg).toBe(page.originalRevoke);
    expect(page.observers.size).toBe(0);
    expect(page.ipc.listeners('message')).toEqual([other]);
  });

  it('聊天组件保留原生会话范围供统一解析，仍调用原撤回方法', async () => {
    const page = createPage();
    page.chat.sesInfo = { id: 716791, type: 0, typeID: 91002 };
    const { bridge } = page.createBridge('聊天撤回', '连接');
    const recalls: KK9RecalledEvent[] = [];
    bridge.on('recalled', event => recalls.push(event));
    await bridge.connect();
    try {
      page.chat.addRevokeMsg({ sessionID: 716791, msgID: '待撤回' });
      expect(
        recalls.map(event => ({ messageId: event.messageId, sessionId: event.sessionId }))
      ).toEqual([{ messageId: '待撤回', sessionId: '716791' }]);
      expect(page.originalRevoke).toHaveBeenCalledOnce();
    } finally {
      await bridge.disconnect();
    }
  });

  it('携带msgID的普通Vue历史消息不会误派发为撤回或新入站', async () => {
    const page = createPage('0-91002');
    const { bridge } = page.createBridge('普通历史', '连接');
    const messages: KK9Message[] = [];
    const recalls: KK9RecalledEvent[] = [];
    bridge.on('message', message => messages.push(message));
    bridge.on('recalled', event => recalls.push(event));
    await bridge.connect();
    try {
      const payload = {
        sessionID: 716791,
        session: { id: 716791, type: 0, typeID: 91002 },
        msgID: '普通历史',
        sender: 91002,
        content: '普通问题',
      };
      page.bus.emit('receive-message', payload);
      page.bus.emit('0-91002-msg', [payload]);
      expect(messages).toEqual([]);
      expect(recalls).toEqual([]);
    } finally {
      await bridge.disconnect();
    }
  });

  it('撤回消息内原生编号优先于外层界面标识', () => {
    const events = extractRecalledEventsFromPayload({
      sessionId: '0-91002',
      message: [
        { sessionID: 716791, contentType: 6, content: { event: 'CancelMessage', msgID: '待撤回' } },
      ],
    });
    expect(events.map(event => event.sessionId)).toEqual(['716791']);
  });

  it('撤回消息内原生编号优先于调用方界面范围', () => {
    const events = extractRecalledEventsFromPayload(
      { message: [{ sessionID: 716791, event: 'CancelMessage', msgID: '待撤回' }] },
      { id: '0-91002' }
    );
    expect(events.map(event => event.sessionId)).toEqual(['716791']);
  });

  it('无外层范围的撤回数组保留各条会话，相同消息ID不跨会话误去重', async () => {
    const page = createPage();
    const { bridge } = page.createBridge('多会话撤回', '连接');
    const recalls: KK9RecalledEvent[] = [];
    bridge.on('recalled', event => recalls.push(event));
    await bridge.connect();
    try {
      page.ipc.emit(
        'message',
        {},
        {
          args: [
            { event: 'CancelMessage', msgID: '相同编号', sessionId: '0-91002', sessionID: 716791 },
            { event: 'CancelMessage', msgID: '相同编号', sessionID: '1-91004' },
          ],
        }
      );
      expect(
        recalls.map(event => ({ messageId: event.messageId, sessionId: event.sessionId }))
      ).toEqual([
        { messageId: '相同编号', sessionId: '716791' },
        { messageId: '相同编号', sessionId: '1-91004' },
      ]);
    } finally {
      await bridge.disconnect();
    }
  });

  it('新代只接收原生IPC新事件，断线旧消息的迟到总线转发不补做', async () => {
    const page = createPage();
    const older = page.createBridge('旧代', '旧连接');
    await older.bridge.connect();
    await older.cdp.disconnect();
    // KK9断线期间已收到该消息；随后UI异步工作完成才转发到总线。
    page.ipc.emit(
      'message',
      {},
      { args: { id: '断线旧消息', sessionID: '会话', sender: '员工', content: '旧问题' } }
    );
    const newer = page.createBridge('新代', '新连接');
    await newer.bridge.connect();
    const received: string[] = [];
    newer.bridge.on('message', message => received.push(message.id));
    page.bus.emit('receive-message', {
      id: '断线旧消息',
      sessionID: '会话',
      sender: '员工',
      content: '旧问题',
    });
    page.bus.emit('会话-msg', [
      { id: '历史消息', sessionID: '会话', sender: '员工', content: '历史' },
    ]);
    expect(received).toEqual([]);
    page.ipc.emit(
      'message',
      {},
      { args: { id: '新收到消息', sessionID: '会话', sender: '员工', content: '新问题' } }
    );
    expect(received).toEqual(['新收到消息']);
    await older.bridge.disconnect();
    await newer.bridge.disconnect();
    expect(page.ipc.listenerCount('message')).toBe(0);
  });
});
