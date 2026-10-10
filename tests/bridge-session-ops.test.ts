import { describe, expect, it } from 'vitest';
import type { CdpClient } from '../src/cdp/client.js';
import { BridgeSessionOps } from '../src/bridge/session-ops.js';
import {
  FakeIpcRenderer,
  runRendererScript,
} from './helpers/renderer-runtime.js';

describe('BridgeSessionOps 纯数据会话管理测试', () => {
  function nativeOps(sessionsInfo: Record<string, unknown>, code = 0) {
    const ipc = new FakeIpcRenderer(request => {
      if (request.args[0] === 'getMemberDetail') return { code: 0, data: { id: 91001 } };
      return { code, data: { sessionsInfo }, error: code ? '原生会话查询失败' : undefined };
    });
    const cdp = {
      evaluate: (script: string) => runRendererScript(script, {
        window: { ipcRenderer: ipc }, setTimeout, clearTimeout,
      }),
    } as unknown as CdpClient;
    return new BridgeSessionOps(cdp);
  }

  it('没有聊天组件也能读取原生会话身份、接收对象及未读数', async () => {
    const sessions = await nativeOps({
      '93001': { id: 93001, type: 0, creater: 91001, typeID: 91002, typeName: '员工甲', maxMessageIndex: 10, userReadIndex: 8 },
      '93002': { id: 93002, type: 0, creater: 91003, typeID: 91001, typeName: '员工乙' },
      '93003': { id: 93003, type: 1, creater: 91001, typeID: 92001, typeName: '群聊', maxMessageIndex: 12, userReadIndex: 9, atState: 2 },
      '93004': { id: 93004, type: 2, creater: 91001, typeID: 92002, typeName: '讨论组' },
      '93005': { id: 93005, type: 3, creater: 91001, typeID: 92003, typeName: '服务号' },
      '93006': { id: 93006, type: 6, creater: 91001, typeID: 92004, typeName: '其他' },
    }).getSessions();
    expect(sessions.map(({ id, type, nativeType, receiverId }) => ({ id, type, nativeType, receiverId }))).toEqual([
      { id: '93001', type: 'private', nativeType: 0, receiverId: '91002' },
      { id: '93002', type: 'private', nativeType: 0, receiverId: '91003' },
      { id: '93003', type: 'group', nativeType: 1, receiverId: '92001' },
      { id: '93004', type: 'discussion', nativeType: 2, receiverId: '92002' },
      { id: '93005', type: 'service', nativeType: 3, receiverId: '92003' },
      { id: '93006', type: 'unknown', nativeType: 6, receiverId: '92004' },
    ]);
    expect(sessions[0]?.unreadCount).toBe(2);
    expect(sessions[2]?.unreadAt).toBe(true);
  });

  it('空列表正常返回，原生失败保留错误而不是空列表', async () => {
    await expect(nativeOps({}).getSessions()).resolves.toEqual([]);
    await expect(nativeOps({}, 627).getSessions()).rejects.toThrow(/getConversations.*627.*原生会话查询失败/);
  });

  describe('指定原生ID的单会话读取', () => {
    function sessionOps(response: unknown) {
      const ipc = new FakeIpcRenderer(request => {
        if (request.args[0] === 'getMemberDetail') return { code: 0, data: { id: 91001 } };
        if (request.args[0] === 'getConversations') return { code: 0, data: { sessionsInfo: {} } };
        if (request.args[0] === 'getSessionBySessionID') return response;
        throw new Error('非预期的原生查询');
      });
      const cdp = {
        evaluate: (script: string) => runRendererScript(script, { window: { ipcRenderer: ipc }, setTimeout, clearTimeout }),
      } as unknown as CdpClient;
      return { ops: new BridgeSessionOps(cdp), ipc };
    }

    it('可见列表缺席仍按指定原生ID读取，不改已读索引', async () => {
      const row = { id: 93001, type: 0, creater: 91002, typeID: 91001, typeName: '员工甲', maxMessageIndex: 10, userReadIndex: 8, atState: 2 };
      const { ops, ipc } = sessionOps({ code: 0, data: row });
      expect(await ops.getSessions()).toEqual([]);
      ipc.sent.length = 0;
      expect(await ops.getSessionById('93001')).toMatchObject({
        id: '93001', type: 'private', nativeType: 0, receiverId: '91002', unreadCount: 2, unreadAt: true,
      });
      expect(ipc.sent.map(request => request.args)).toEqual([['getMemberDetail'], ['getSessionBySessionID', '93001']]);
      expect(row.userReadIndex).toBe(8);
      expect(row.atState).toBe(2);
    });

    it('原生单会话缺席正常返回null，失败保留方法/会话/错误码', async () => {
      await expect(sessionOps({ code: 0, data: null }).ops.getSessionById('93001')).resolves.toBeNull();
      await expect(sessionOps({ code: 627, error: '原生单会话查询失败' }).ops.getSessionById('93001')).rejects.toThrow(/getSessionBySessionID.*93001.*627.*原生单会话查询失败/);
    });
  });

  describe('指定原生会话已读', () => {
    function readOps(code = 0, missing = false) {
      const row = { id: 93001, type: 1, maxMessageIndex: 10, userReadIndex: 4 };
      const ipc = new FakeIpcRenderer(({ args: [method, value] }) => {
        if (method === 'getSessionBySessionID') return { code: 0, data: missing || String(value) !== '93001' ? null : row };
        if (method === 'readMessage') {
          if (!code) row.userReadIndex = 10;
          return { code, error: code ? '原生拒绝已读' : undefined };
        }
        throw new Error('错误原生入口');
      });
      const cdp = { evaluate: (script: string) => runRendererScript(script, { window: { ipcRenderer: ipc }, setTimeout, clearTimeout }) } as unknown as CdpClient;
      return { ops: new BridgeSessionOps(cdp), ipc, row };
    }

    it('无窗口按指定原生 ID、真实类型与最大索引标已读，已读目标可幂等', async () => {
      const { ops, ipc, row } = readOps();
      expect(await ops.markSessionRead('93001')).toBe(true);
      expect(row.userReadIndex).toBe(10);
      expect(ipc.sent.find(r => r.args[0] === 'readMessage')?.args).toEqual(['readMessage', { sessionID: 93001, type: 1, maxMsgIdx: 10 }]);
      expect(await ops.markSessionRead('93001')).toBe(true);
      expect(row.userReadIndex).toBe(10);
    });

    it('名称和不存在 ID 不能作用到其他会话', async () => {
      const { ops, ipc, row } = readOps();
      expect(await ops.markSessionRead('群名')).toBe(false);
      expect(await ops.markSessionRead('99999')).toBe(false);
      expect(ipc.sent.filter(r => r.args[0] === 'readMessage')).toEqual([]);
      expect(row.userReadIndex).toBe(4);
    });

    it('原生失败保留会话、方法与错误码，不返回假成功', async () => {
      const { ops, row } = readOps(627);
      await expect(ops.markSessionRead('93001')).rejects.toThrow(/readMessage.*93001.*627.*原生拒绝已读/);
      expect(row.userReadIndex).toBe(4);
    });
  });
});
