import { describe, expect, it, vi } from 'vitest';
import type { CdpClient } from '../src/cdp/client.js';
import { BridgeSessionOps } from '../src/bridge/session-ops.js';
import {
  createRendererRuntime,
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
    expect(sessions[0]?.active).toBeUndefined();
  });

  it('空列表正常返回，原生失败保留错误而不是空列表', async () => {
    await expect(nativeOps({}).getSessions()).resolves.toEqual([]);
    await expect(nativeOps({}, 627).getSessions()).rejects.toThrow(/getConversations.*627.*原生会话查询失败/);
  });

  describe('当前活动窗口的原生单会话读取', () => {
    function currentSessionOps(activeSession: { id: number | string } | null, response: unknown) {
      const ipc = new FakeIpcRenderer(request => {
        if (request.args[0] === 'getMemberDetail') return { code: 0, data: { id: 91001 } };
        if (request.args[0] === 'getConversations') return { code: 0, data: { sessionsInfo: {} } };
        if (request.args[0] === 'getSessionBySessionID') return response;
        throw new Error('非预期的原生查询');
      });
      const runtime = createRendererRuntime({ ipc, sessions: [], activeSession });
      const cdp = {
        evaluate: (script: string) => runRendererScript(script, runtime.context),
      } as unknown as CdpClient;
      return { ops: new BridgeSessionOps(cdp), ipc, runtime };
    }

    it('可见列表缺席但活动原生 ID 有效时仍返回当前会话', async () => {
      const rawSession = {
        id: 93001, type: 0, creater: 91001, typeID: 91002, typeName: '员工甲',
        maxMessageIndex: 10, userReadIndex: 8, atState: 2,
        lastMessage: JSON.stringify({ content: [{ text: '最近消息' }] }),
      };
      const { ops, ipc, runtime } = currentSessionOps({ id: 93001 }, { code: 0, data: rawSession });

      expect(await ops.getSessions()).toEqual([]);
      ipc.sent.length = 0;
      expect(await ops.getCurrentSession()).toEqual({
        id: '93001', name: '员工甲', type: 'private', nativeType: 0, receiverId: '91002',
        active: true, unread: true, unreadCount: 2, unreadAt: true,
        lastMessage: '最近消息', lastMessageTime: '',
      });
      expect(ipc.sent.map(request => request.args)).toEqual([
        ['getMemberDetail'], ['getSessionBySessionID', '93001'],
      ]);
      expect(rawSession.userReadIndex).toBe(8);
      expect(rawSession.atState).toBe(2);
      expect(runtime.events).toEqual([]);
      expect(runtime.commits).toEqual([]);
    });

    it.each([
      { creater: 91001, typeID: 91002 },
      { creater: 91002, typeID: 91001 },
    ])('私聊创建方向 $creater → $typeID 不影响原生 ID 与对端 UID', async fields => {
      const { ops } = currentSessionOps({ id: '93001' }, {
        code: 0,
        data: { id: 93001, type: 0, ...fields, maxMessageIndex: 10, userReadIndex: 10, atState: 0 },
      });

      expect(await ops.getCurrentSession()).toMatchObject({
        id: '93001', type: 'private', nativeType: 0, receiverId: '91002',
        active: true, unread: false, unreadCount: 0, unreadAt: false,
      });
    });

    it.each([
      { nativeType: 1, type: 'group' },
      { nativeType: 2, type: 'discussion' },
      { nativeType: 3, type: 'service' },
      { nativeType: 6, type: 'unknown' },
    ])('单会话保留原生类型 $nativeType 与接收对象', async ({ nativeType, type }) => {
      const { ops } = currentSessionOps({ id: 93003 }, {
        code: 0,
        data: { id: 93003, type: nativeType, creater: 91001, typeID: 92001, maxMessageIndex: 9, userReadIndex: 12 },
      });

      expect(await ops.getCurrentSession()).toMatchObject({
        id: '93003', type, nativeType, receiverId: '92001', active: true,
        unread: false, unreadCount: 0, unreadAt: false,
      });
    });

    it('没有活动会话时返回 null 且不调用任何原生查询', async () => {
      const { ops, ipc } = currentSessionOps(null, { code: 627, error: '不得触发查询' });

      await expect(ops.getCurrentSession()).resolves.toBeNull();
      expect(ipc.sent).toEqual([]);
    });

    it('没有聊天组件时返回 null 且不调用任何原生查询', async () => {
      const { ops, ipc, runtime } = currentSessionOps({ id: 93001 }, { code: 627, error: '不得触发查询' });
      runtime.context['document'] = { querySelector: () => null };

      await expect(ops.getCurrentSession()).resolves.toBeNull();
      expect(ipc.sent).toEqual([]);
    });

    it.each([{ code: 0 }, { code: 0, data: null }])('原生单会话缺席时返回 null：%j', async response => {
      const { ops } = currentSessionOps({ id: 93001 }, response);

      await expect(ops.getCurrentSession()).resolves.toBeNull();
    });

    it.each([
      { code: 627, error: '原生单会话查询失败' },
      { code: 627, message: '原生单会话查询失败' },
    ])('原生非零响应保留方法名、错误码与诊断：%j', async response => {
      const { ops } = currentSessionOps({ id: 93001 }, response);

      await expect(ops.getCurrentSession()).rejects.toMatchObject({
        code: 'IPC_QUERY_FAILED',
        message: 'getSessionBySessionID 失败 (627): 原生单会话查询失败',
      });
    });

    it('单会话 IPC 发送异常继续向调用方暴露诊断', async () => {
      const ipc = new FakeIpcRenderer(request => {
        if (request.args[0] === 'getMemberDetail') return { code: 0, data: { id: 91001 } };
        throw new Error('原生单会话发送失败');
      });
      const runtime = createRendererRuntime({ ipc, activeSession: { id: 93001 } });
      const cdp = {
        evaluate: (script: string) => runRendererScript(script, runtime.context),
      } as unknown as CdpClient;

      await expect(new BridgeSessionOps(cdp).getCurrentSession()).rejects.toThrow(/getSessionBySessionID.*原生单会话发送失败/);
    });
  });

  it('selectSession 应支持切换到私聊会话 test-employee 与群聊会话 test-group', async () => {
    const mockCdp = {
      evaluate: vi.fn().mockImplementation((script: string) => {
        if (script.includes('test-employee') || script.includes('test-group')) {
          return Promise.resolve({ success: true, method: 'vue_session_switch' });
        }
        return Promise.resolve({ success: false });
      }),
    } as unknown as CdpClient;

    const ops = new BridgeSessionOps(mockCdp);

    const privateSwitch = await ops.selectSession('test-employee');
    expect(privateSwitch).toBe(true);

    const groupSwitch = await ops.selectSession('test-group');
    expect(groupSwitch).toBe(true);

    const unknownSwitch = await ops.selectSession('不存在的会话');
    expect(unknownSwitch).toBe(false);
  });

  it('selectSession 对同名会话必须 Fail-Closed，精确 ID 仍可切换', async () => {
    const privateSession = {
      id: 93001,
      sesUUID: '0-91002',
      typeName: 'test-employee',
      type: 0,
    };
    const firstGroup = {
      id: 93002,
      sesUUID: '1-92001',
      typeName: 'test-group',
      name: 'test-group',
      type: 1,
    };
    const secondGroup = {
      id: 765432,
      sesUUID: '1-92002',
      typeName: 'test-group',
      name: 'test-group',
      type: 1,
    };
    const runtime = createRendererRuntime({
      sessions: [privateSession, firstGroup, secondGroup],
      activeSession: privateSession,
    });
    const mockCdp = {
      evaluate: vi.fn((script: string) => runRendererScript(script, runtime.context)),
    } as unknown as CdpClient;
    const ops = new BridgeSessionOps(mockCdp);

    expect(await ops.selectSession('test-group')).toBe(false);
    expect(runtime.editor.activedSes?.sesUUID).toBe('0-91002');

    expect(await ops.selectSession('1-92001')).toBe(true);
    expect(runtime.editor.activedSes?.sesUUID).toBe('1-92001');
  });

  it('markSessionRead 对同名名称必须拒绝且不得调用 native IPC', async () => {
    const firstGroup = {
      id: 93002,
      sesUUID: '1-92001',
      typeName: 'test-group',
      name: 'test-group',
      type: 1,
      maxMessageIndex: 20,
      userReadIndex: 10,
      atState: 2,
    };
    const secondGroup = {
      id: 765432,
      sesUUID: '1-92002',
      typeName: 'test-group',
      name: 'test-group',
      type: 1,
      maxMessageIndex: 30,
      userReadIndex: 15,
      atState: 2,
    };
    const ipc = new FakeIpcRenderer(() => ({ code: 0 }));
    const runtime = createRendererRuntime({
      ipc,
      sessions: [firstGroup, secondGroup],
      activeSession: firstGroup,
    });
    const mockCdp = {
      evaluate: vi.fn((script: string) => runRendererScript(script, runtime.context)),
    } as unknown as CdpClient;

    const result = await new BridgeSessionOps(mockCdp).markSessionRead('test-group');

    expect(result).toBe(false);
    expect(ipc.sent).toHaveLength(0);
    expect(firstGroup.userReadIndex).toBe(10);
    expect(secondGroup.userReadIndex).toBe(15);
  });

  it('markSessionRead 仅在 native ack 成功后更新本地未读状态', async () => {
    const session = {
      id: 93001,
      sesUUID: '0-91002',
      typeName: 'test-employee',
      type: 0,
      maxMessageIndex: 10,
      userReadIndex: 4,
      atState: 2,
    };
    const ipc = new FakeIpcRenderer(() => ({ code: 0 }));
    const runtime = createRendererRuntime({ ipc, sessions: [session], activeSession: session });
    const mockCdp = {
      evaluate: vi.fn((script: string) => runRendererScript(script, runtime.context)),
    } as unknown as CdpClient;

    const result = await new BridgeSessionOps(mockCdp).markSessionRead('0-91002');

    expect(result).toBe(true);
    expect(session.userReadIndex).toBe(10);
    expect(session.atState).toBe(0);
  });

  it('markSessionRead 缺少 ipcRenderer 时不得伪造本地已读成功', async () => {
    const session = {
      id: 93001,
      sesUUID: '0-91002',
      typeName: 'test-employee',
      type: 0,
      maxMessageIndex: 10,
      userReadIndex: 4,
      atState: 2,
    };
    const runtime = createRendererRuntime({ sessions: [session], activeSession: session });
    const mockCdp = {
      evaluate: vi.fn((script: string) => runRendererScript(script, runtime.context)),
    } as unknown as CdpClient;

    const result = await new BridgeSessionOps(mockCdp).markSessionRead('0-91002');

    expect(result).toBe(false);
    expect(session.userReadIndex).toBe(4);
    expect(session.atState).toBe(2);
    expect(runtime.events).toHaveLength(0);
  });

  it('markSessionRead 收到业务失败 ack 时不得更新本地状态', async () => {
    const session = {
      id: 93001,
      sesUUID: '0-91002',
      typeName: 'test-employee',
      type: 0,
      maxMessageIndex: 10,
      userReadIndex: 4,
      atState: 2,
    };
    const ipc = new FakeIpcRenderer(() => ({ code: 1, message: 'read rejected' }));
    const runtime = createRendererRuntime({ ipc, sessions: [session], activeSession: session });
    const mockCdp = {
      evaluate: vi.fn((script: string) => runRendererScript(script, runtime.context)),
    } as unknown as CdpClient;

    const result = await new BridgeSessionOps(mockCdp).markSessionRead('0-91002');

    expect(result).toBe(false);
    expect(session.userReadIndex).toBe(4);
    expect(session.atState).toBe(2);
    expect(runtime.events).toHaveLength(0);
  });

  it('markSessionRead 的 ipc.send 抛错后必须移除本次 listener', async () => {
    const session = {
      id: 93001,
      sesUUID: '0-91002',
      typeName: 'test-employee',
      type: 0,
      maxMessageIndex: 10,
      userReadIndex: 4,
      atState: 2,
    };
    const ipc = new FakeIpcRenderer(() => {
      throw new Error('read send failed');
    });
    const runtime = createRendererRuntime({ ipc, sessions: [session], activeSession: session });
    const mockCdp = {
      evaluate: vi.fn((script: string) => runRendererScript(script, runtime.context)),
    } as unknown as CdpClient;

    const result = await new BridgeSessionOps(mockCdp).markSessionRead('0-91002');
    const request = ipc.sent[0];

    expect(result).toBe(false);
    expect(request).toBeDefined();
    expect(ipc.listenerCount(`data-${request?.id}`)).toBe(0);
  });
});
