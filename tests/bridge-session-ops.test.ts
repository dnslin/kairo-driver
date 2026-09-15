import { describe, expect, it, vi } from 'vitest';
import type { CdpClient } from '../src/cdp/client.js';
import { BridgeSessionOps } from '../src/bridge/session-ops.js';
import {
  createRendererRuntime,
  FakeIpcRenderer,
  runRendererScript,
} from './helpers/renderer-runtime.js';

describe('BridgeSessionOps 纯数据会话管理测试', () => {
  it('getSessions 应通过 IPC getConversations 解析私聊(test-employee)与群聊(test-group)会话列表与未读数', async () => {
    const mockCdp = {
      evaluate: vi.fn().mockImplementation((script: string) => {
        if (script.includes('sortedSessions')) {
          return Promise.resolve({
            activeUuid: '0-91002',
            activeId: 93001,
            sortedSessions: [
              { id: 93001, sesUUID: '0-91002', name: 'test-employee', type: 0 },
              { id: 93002, sesUUID: '1-92001', name: 'test-group', type: 1 },
            ],
          });
        }
        if (script.includes('getConversations')) {
          return Promise.resolve({
            code: 0,
            data: {
              sessionsInfo: {
                '93001': {
                  id: 93001,
                  type: 0,
                  creater: 91006,
                  createrName: 'test-employee',
                  typeID: 91002,
                  typeName: 'test-employee',
                  maxMessageIndex: 10,
                  userReadIndex: 8,
                  lastMessage: JSON.stringify({ content: [{ type: 0, text: '你好，私聊测试' }] }),
                  lastMsgTime: 1788142783,
                  atState: 0,
                },
                '93002': {
                  id: 93002,
                  type: 1,
                  creater: 92001,
                  createrName: '群管理员',
                  typeID: 92001,
                  typeName: 'test-group',
                  maxMessageIndex: 55,
                  userReadIndex: 50,
                  lastMessage: JSON.stringify({ content: [{ type: 0, text: '群聊讨论' }] }),
                  lastMsgTime: 1788142900,
                  atState: 2, // 未读 @ 我
                },
              },
            },
          });
        }
        return Promise.resolve(null);
      }),
    } as unknown as CdpClient;

    const ops = new BridgeSessionOps(mockCdp);
    const sessions = await ops.getSessions();

    expect(sessions).toHaveLength(2);

    // 私聊会话 test-employee
    const privateSes = sessions.find(s => s.name === 'test-employee');
    expect(privateSes).toBeDefined();
    expect(privateSes?.type).toBe('private');
    expect(privateSes?.unread).toBe(true);
    expect(privateSes?.unreadCount).toBe(2); // 10 - 8
    expect(privateSes?.active).toBe(true);
    expect(privateSes?.lastMessage).toBe('你好，私聊测试');

    // 群聊会话 test-group
    const groupSes = sessions.find(s => s.name === 'test-group');
    expect(groupSes).toBeDefined();
    expect(groupSes?.type).toBe('group');
    expect(groupSes?.unread).toBe(true);
    expect(groupSes?.unreadCount).toBe(5); // 55 - 50
    expect(groupSes?.unreadAt).toBe(true); // atState = 2
  });

  it('getCurrentSession 应从 Vue editor 提取当前活跃会话', async () => {
    const mockCdp = {
      evaluate: vi.fn().mockResolvedValue({
        id: '1-92001',
        name: 'test-group',
        type: 'group',
        unread: false,
        active: true,
      }),
    } as unknown as CdpClient;

    const ops = new BridgeSessionOps(mockCdp);
    const current = await ops.getCurrentSession();

    expect(current).not.toBeNull();
    expect(current?.name).toBe('test-group');
    expect(current?.type).toBe('group');
    expect(current?.active).toBe(true);
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
