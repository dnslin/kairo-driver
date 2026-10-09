import { describe, expect, it, vi } from 'vitest';
import { BridgeMessageOps } from '../src/bridge/message-ops.js';
import { extractRecalledEventsFromPayload } from '../src/bridge/converter.js';
import { KK9Driver } from '../src/driver.js';
import { FakeKK9Driver } from '../src/fake-driver.js';
import type { KK9Message, KK9RecalledEvent } from '../src/types/index.js';
import { getDriverTestInternals } from './helpers/driver-internals.js';
import { createNativeSendRuntime } from './helpers/native-send-runtime.js';
import { verifyNativeRecallEvidence } from '../examples/native-recall-evidence.js';

const session = { id: '93001', name: '员工甲', type: 'private' as const,
  nativeType: 0, receiverId: '91002', unread: false };

function setup(config: Parameters<typeof createNativeSendRuntime>[0] = {}) {
  const native = createNativeSendRuntime(config);
  const driver = new KK9Driver({ cdp: { url: 'http://127.0.0.1:1', pageMatch: '离线撤回' } });
  const internals = getDriverTestInternals(driver);
  internals.bridgeMessageOps = new BridgeMessageOps(native.cdp);
  const events: KK9RecalledEvent[] = [];
  driver.on('recalled', event => events.push(event));
  function remote(messageId: string, sessionID = 93001) {
    const [event] = extractRecalledEventsFromPayload({ sessionID, message: [
      { id: 99999, contentType: 6, content: { event: 'CancelMessage', msgID: messageId } },
    ] });
    internals.eventBridge.emit('recalled', event!);
  }
  return { native, driver, internals, events, remote };
}

function record(id: number, msgIdx: number, sessionID = 93001) {
  return { id, msgIdx, sessionID, sender: 91001, contentType: 4, content: '本轮文本', msgFlag: '1' };
}

describe('T05 显式原生撤回', () => {
  it('无聊天组件时从指定会话翻页取得精确索引，不能用另一会话同号记录', async () => {
    const { native, driver, events } = setup();
    native.records.push(record(123, 7), record(123, 888, 93002));
    for (let index = 8; index < 208; index++) native.records.push(record(1000 + index, index));
    expect(await driver.recallMessage('123', session)).toBe(true);
    expect(native.records[0]?.['msgFlag']).toBe('C');
    expect(native.records[1]?.['msgFlag']).toBe('1');
    expect(events.map(event => [event.sessionId, event.messageId])).toEqual([['93001', '123']]);
  });

  it('缺省会话、名称或界面ID不能代替原生目标；错会话、目标不存在、他人消息不撤回', async () => {
    const { native, driver, events } = setup();
    native.records.push(record(123, 7), { ...record(124, 8), sender: 91002 });
    for (const target of [undefined, '员工甲', '0-91002', '93002']) {
      expect(await driver.recallMessage('123', target as string)).toBe(false);
    }
    expect(await driver.recallMessage('23', session)).toBe(false);
    expect(await driver.recallMessage('124', session)).toBe(false);
    expect(native.records.map(item => item['msgFlag'])).toEqual(['1', '1']);
    expect(native.ipc.sent.filter(request => request.args[0] === 'cancelMessage')).toEqual([]);
    expect(events).toEqual([]);
  });

  it('撤回请求发送抛错不派发通知，只释放自身请求监听', async () => {
    const { native, driver, events } = setup();
    native.records.push(record(123, 7));
    const send = native.ipc.send.bind(native.ipc);
    const clientListener = vi.fn();
    native.ipc.on('message', clientListener);
    let failedRequestId = 0;
    native.ipc.send = (channel, request) => {
      if (request.args[0] === 'cancelMessage') {
        failedRequestId = request.id;
        throw new Error('本次原生撤回失败');
      }
      send(channel, request);
    };
    await expect(driver.recallMessage('123', session)).rejects.toMatchObject({
      code: 'RECALL_FAILED', message: expect.stringMatching(/93001.*123.*7.*本次原生撤回失败/),
    });
    expect(events).toEqual([]);
    expect(native.records[0]?.['msgFlag']).toBe('1');
    for (const request of native.ipc.sent) expect(native.ipc.listenerCount(`data-${request.id}`)).toBe(0);
    expect(failedRequestId).toBeGreaterThan(0);
    expect(native.ipc.listenerCount(`data-${failedRequestId}`)).toBe(0);
    native.ipc.emit('message', {});
    expect(clientListener).toHaveBeenCalledOnce();
  });

  it('原生业务失败不能改变目标或派发成功通知', async () => {
    const { native, driver, events } = setup({ cancelCode: 627 });
    native.records.push(record(123, 7));
    await expect(driver.recallMessage('123', session)).rejects.toMatchObject({
      code: 'RECALL_FAILED', message: expect.stringMatching(/93001.*123.*7.*cancelMessage.*627/),
    });
    expect(native.records[0]?.['msgFlag']).toBe('1');
    expect(events).toEqual([]);
  });

  it('服务器通知先到及本地确认先到均只通知一次，跨会话同号不误去重，历史不重放', async () => {
    const { native, driver, events, remote } = setup();
    native.records.push(record(123, 7), record(124, 8), record(123, 9, 93002));
    const send = native.ipc.send.bind(native.ipc);
    native.ipc.send = (channel, request) => {
      const target = request.args[1];
      if (request.args[0] === 'cancelMessage' && target && typeof target === 'object' &&
          'msgID' in target && target.msgID === 123 && 'sessionID' in target)
        remote('123', Number(target.sessionID));
      send(channel, request);
    };
    expect(await driver.recallMessage('123', '93001')).toBe(true);
    expect(await driver.recallMessage('124', '93001')).toBe(true);
    remote('124'); remote('123');
    expect(await driver.recallMessage('123', '93002')).toBe(true);
    expect(events.map(event => [event.sessionId, event.messageId])).toEqual([
      ['93001', '123'], ['93001', '124'], ['93002', '123'],
    ]);
    const history = await driver.getRecentMessages(session);
    expect(history.map(message => [message.id, message.isRecalled])).toEqual([['123', true], ['124', true]]);
    expect(await driver.recallMessage('123', session)).toBe(false);
    expect(events).toHaveLength(3);
  });

  it('快捷撤回固定本次发送目标并派发通知，不随窗口或调用方选项变化', async () => {
    const { native, driver, events } = setup();
    const options = { targetSessionId: '93001' };
    const result = await driver.sendText('本轮快捷撤回', options);
    options.targetSessionId = '93002';
    expect(result.status).toBe('sent');
    expect(await result.recall!()).toBe(true);
    expect(native.records[0]?.['msgFlag']).toBe('C');
    expect(events.map(event => [event.sessionId, event.messageId])).toEqual([['93001', result.messageId]]);
  });

  it('失效连接的晚到原生结果不派发新通知', async () => {
    const { native, driver, internals, events } = setup();
    native.records.push(record(123, 7));
    const send = native.ipc.send.bind(native.ipc);
    native.ipc.send = (channel, request) => {
      if (request.args[0] === 'cancelMessage')
        internals.cdp.emit('connection_lost', { cause: new Error('撤回完成前连接失效') });
      send(channel, request);
    };
    await driver.recallMessage('123', '93001');
    expect(events).toEqual([]);
  });

  it('Fake 按会话修改已注入历史并统一去重，不能无目标宣称撤回成功', async () => {
    const driver = new FakeKK9Driver();
    driver.setCurrentUserId('91001');
    driver.setSessions([session]);
    const messages = [record(123, 7), record(123, 8, 93002)].map(item => ({
      id: String(item.id), messageId: String(item.id), msgIdx: item.msgIdx, sessionId: String(item.sessionID),
      senderId: '91001', sender: '我', content: '本轮文本', direction: 'outbound', messageType: 'text',
    })) as KK9Message[];
    driver.setMessages(messages);
    const events: KK9RecalledEvent[] = [];
    driver.on('recalled', event => events.push(event));
    expect(await driver.recallMessage('123', '员工甲')).toBe(false);
    expect(await driver.recallMessage('999', session)).toBe(false);
    expect(await driver.recallMessage('123', session)).toBe(true);
    driver.emitRecalled({ messageId: '123', sessionId: session.id, sender: '我', time: '现在' });
    expect((await driver.getRecentMessages(session))[0]?.isRecalled).toBe(true);
    expect(messages[1]?.isRecalled).not.toBe(true);
    expect(events.map(event => [event.sessionId, event.messageId])).toEqual([['93001', '123']]);
  });
});

it('人工撤回按本轮实际原生消息认定，不限定预备ID，旧记录和重复通知不能混入', () => {
  const capture = { requests: [
    { sessionId: '93001', messageId: '100', msgIdx: 7, phase: 'SDK', type: 'own', code: 0 },
    { sessionId: '93001', messageId: '101', msgIdx: 8, phase: '监听', type: 'own', code: 0 },
    { sessionId: '93001', messageId: '99', msgIdx: 6, phase: '监听', type: 'own', code: 0 },
    { sessionId: '93001', messageId: '102', msgIdx: 9, phase: '监听', type: 'own', code: 0 },
  ], messages: [], notices: [] };
  const checks = verifyNativeRecallEvidence({ targetIds: ['93001'], uid: '91001', peerId: '91002', capture,
    owned: [{ id: '100', sessionId: '93001', kind: 'SDK' }, { id: '103', sessionId: '93001', kind: '人工' }],
    history: ['100', '101', '99', '102'].map(id => ({ id, sessionId: '93001', senderId: '91001', isRecalled: true })),
    events: ['100', '101', '99', '102', '102'].map(messageId => ({ messageId, sessionId: '93001' })),
  });
  expect(checks.find(item => item.kind === '人工')).toEqual({ sessionId: '93001', kind: '人工', 通过: true, messageIds: ['101'] });
});
