import { describe, expect, it, vi } from 'vitest';
import { KK9Driver } from '../src/driver.js';
import { FakeKK9Driver } from '../src/fake-driver.js';
import { FakeIpcRenderer, runRendererScript } from './helpers/renderer-runtime.js';
import { getDriverTestInternals } from './helpers/driver-internals.js';

function rangeDriver(failOlderPage = false, sendTimes?: readonly number[]) {
  const driver = new KK9Driver({ cdp: { url: 'http://localhost:9222', pageMatch: 'test' } });
  const pages: Array<{ sessionID: number; endIdx: number; count: number }> = [];
  const ipc = new FakeIpcRenderer(({ args: [method, value] }) => {
    if (method === 'getMemberDetail') return { code: 0, data: { id: 5761 } };
    if (method === 'getSessionBySessionID') return { code: 0, data: ['716791', '793803'].includes(String(value)) ? { id: Number(value), type: Number(value) === 716791 ? 0 : 1, creater: 5761, typeID: Number(value) === 716791 ? 3585 : 29467 } : null };
    if (method === 'getConversations') return { code: 0, data: { sessionsInfo: {
      a: { id: 716791, type: 0, creater: 5761, typeID: 3585 },
      b: { id: 793803, type: 1, creater: 5761, typeID: 29467 },
    } } };
    if (method !== 'getMessages') throw new Error('历史范围查询不得操作窗口或标已读');
    const query = value as { sessionID: number; endIdx: number; count: number };
    pages.push(query);
    if (failOlderPage && query.endIdx < 2147483647) return { code: 627, error: '历史第二页失败' };
    const rows = Array.from({ length: sendTimes?.length ?? 405 }, (_, i) => ({
      id: i + 1000, msgIdx: i + 1, sessionID: query.sessionID,
      sender: 3585, contentType: 0, content: '测试范围', sendTime: sendTimes?.[i] ?? 1700000000 + i,
    }));
    return { code: 0, data: rows.filter(r => r.msgIdx <= query.endIdx).slice(-query.count) };
  });
  const internals = getDriverTestInternals(driver);
  vi.spyOn(internals.cdp, 'getStatus').mockReturnValue('connected');
  internals.cdp.evaluate = (script: string) => runRendererScript(script, { window: { ipcRenderer: ipc }, setTimeout, clearTimeout });
  return { driver, pages };
}

describe('主动原生历史范围读取', () => {
  it('跳过晚于上界的整页，包含时间边界并按每会话上限返回最近记录，不重放事件', async () => {
    const { driver, pages } = rangeDriver();
    const events: string[] = [];
    for (const name of ['message', 'at', 'recalled'] as const) driver.on(name, () => events.push(name));
    const result = await driver.scanCompensationWindow({ fromTimestamp: 1700000198000, toTimestamp: 1700000199000, maxMessagesPerSession: 2, sessionIds: ['716791', '793803'] });
    expect(result.map(m => [m.sessionId, m.id, m.msgIdx])).toEqual([
      ['716791', '1198', 199], ['716791', '1199', 200],
      ['793803', '1198', 199], ['793803', '1199', 200],
    ]);
    expect(pages.filter(p => p.sessionID === 716791).map(p => p.endIdx)).toEqual([2147483647, 205]);
    expect(events).toEqual([]);
  });

  it('页内消息时间倒序不阻止读取下一页仍在范围内的记录', async () => {
    const sendTimes = Array.from({ length: 201 }, (_, i) => 1700000000 + i);
    sendTimes[1] = 1699999999;
    const { driver } = rangeDriver(false, sendTimes);
    const result = await driver.scanCompensationWindow({ fromTimestamp: 1700000000000, toTimestamp: 1700000200000, maxMessagesPerSession: 200, sessionIds: ['716791'] });
    expect(result.map(m => m.msgIdx)).toEqual([1, ...Array.from({ length: 199 }, (_, i) => i + 3)]);
  });

  it('后页失败不返回已收集部分，保留会话、页索引和原生错误', async () => {
    const { driver } = rangeDriver(true);
    await expect(driver.scanCompensationWindow({ fromTimestamp: 1700000000000, maxMessagesPerSession: 300, sessionIds: ['716791'] })).rejects.toThrow(/getMessages.*716791.*205.*627.*历史第二页失败/);
  });

  it('正常空范围返回空数组，无效数量不变成默认最近记录', async () => {
    const { driver } = rangeDriver();
    await expect(driver.scanCompensationWindow({ fromTimestamp: 1800000000000, toTimestamp: 1800000001000, sessionIds: ['716791'] })).resolves.toEqual([]);
    await expect(driver.scanCompensationWindow({ fromTimestamp: 0, maxMessagesPerSession: 0, sessionIds: ['716791'] })).rejects.toThrow(/数量/);
    await expect(driver.scanCompensationWindow({ fromTimestamp: 0, sessionIds: ['99999'] })).rejects.toThrow(/会话不存在.*99999/);
  });

  it('Fake保留相同原生身份的跨会话历史、范围和数量限制，不改当前窗口/未读或重放', async () => {
    const fake = new FakeKK9Driver();
    fake.setSessions([{ id: '716791', name: '私聊', type: 'private', nativeType: 0, receiverId: '3585', unread: true }, { id: '793803', name: '群', type: 'group', nativeType: 1, receiverId: '29467', unread: true }]);
    await fake.selectSession('793803');
    const base = { sessionName: '私聊', sessionType: 'private' as const, sender: '对端', content: '历史', time: '', isMe: false, direction: 'inbound' as const, timestamp: 1000 };
    fake.setMessages([{ ...base, id: '1', sessionId: '716791', msgIdx: 1 }, { ...base, id: '2', sessionId: '716791', msgIdx: 2, timestamp: 2000 }, { ...base, id: '1', sessionId: '793803', msgIdx: 1 }]);
    const events: string[] = [];
    fake.on('message', m => events.push(m.id));
    expect((await fake.scanCompensationWindow({ fromTimestamp: 1000, toTimestamp: 2000, maxMessagesPerSession: 1 })).map(m => [m.sessionId, m.id])).toEqual([['716791', '2'], ['793803', '1']]);
    expect((await fake.getCurrentSession())?.id).toBe('793803');
    expect((await fake.getSessions()).map(s => s.unread)).toEqual([true, true]);
    expect(events).toEqual([]);
  });
});
