import EventEmitter from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import {
  normalizeNativeMessage,
  type InboundNormalizationDiagnostic,
  type NormalizeNativeMessageContext,
} from '../src/bridge/converter.js';

import { KK9EventBridge } from '../src/bridge/event-bridge.js';
import type { CdpClient } from '../src/cdp/client.js';
import { KK9Driver } from '../src/driver.js';
import type { ConnectionStatus, KK9Message } from '../src/types/index.js';
import { getDriverTestInternals } from './helpers/driver-internals.js';
import { MessageOps } from '../src/dom/message-ops.js';
import { DEFAULT_SELECTORS } from '../src/dom/selectors.js';

class MockCdpClient extends EventEmitter {
  private status: ConnectionStatus = 'connected';
  public evaluateResult: unknown = { ok: true, busFound: true, nativeAttached: true };
  public sendCommandMock = vi.fn().mockImplementation(() => Promise.resolve({}));
  public evaluateMock = vi.fn().mockImplementation(() => Promise.resolve(this.evaluateResult));

  public getStatus(): ConnectionStatus {
    return this.status;
  }
  public async connect(): Promise<void> {}
  public async disconnect(): Promise<void> {}
  public async sendCommand<T = unknown>(
    method: string,
    params?: Record<string, unknown>
  ): Promise<T> {
    return this.sendCommandMock(method, params) as Promise<T>;
  }
  public async evaluate<T = unknown>(script: string): Promise<T> {
    return this.evaluateMock(script) as Promise<T>;
  }
  public triggerBinding(name: string, payload: unknown): void {
    const payloadStr = typeof payload === 'string' ? payload : JSON.stringify(payload);
    this.emit('Runtime.bindingCalled', { name, payload: payloadStr });
  }
}
describe('Driver 入站消息标准化与身份收敛测试 (TDD Red -> Green)', () => {
  const currentUserId = 'emp_bot_001';

  describe('1. 稳定身份与 EventBridge / Polling 同构测试', () => {
    it('EventBridge 与 Polling 缺少 sessionId 或 native messageId 时拒绝入站并报告事实诊断', () => {
      const diagnostics: InboundNormalizationDiagnostic[] = [];
      const contextFor = (source: 'event_bridge' | 'polling'): NormalizeNativeMessageContext => ({
        currentUserId,
        source,
        onDiagnostic: diagnostic => diagnostics.push(diagnostic),
      });

      const eventMessages = normalizeNativeMessage(
        {
          sessionId: 'group_project_room',
          sessionName: '项目周报大群',
          sessionType: 'group',
          sender: '张工',
          content: '这是今天下午的项目周报文档，请查收。',
          time: '14:30:00',
          timestamp: 1787640000000,
          isMe: false,
        },
        contextFor('event_bridge')
      );
      const pollingMessages = normalizeNativeMessage(
        {
          sessionId: 'group_project_room',
          sessionName: '项目周报大群',
          sessionType: 'group',
          sender: '张工',
          content: '这是今天下午的项目周报文档，请查收。',
          time: '',
          timestamp: 1787640000000,
          isMe: false,
        },
        contextFor('polling')
      );
      const missingSessionMessages = normalizeNativeMessage(
        {
          msgID: 'native-no-session',
          sender: '张工',
          content: '缺少会话归属的消息',
          time: '14:31:00',
          timestamp: 1787640060000,
          isMe: false,
        },
        contextFor('event_bridge')
      );

      expect(eventMessages).toHaveLength(0);
      expect(pollingMessages).toHaveLength(0);
      expect(missingSessionMessages).toHaveLength(0);
      expect(diagnostics).toHaveLength(3);
      expect(diagnostics[0]).toMatchObject({
        kind: 'missing_inbound_identity',
        missingFields: ['nativeMessageId'],
        sessionId: 'group_project_room',
        source: 'event_bridge',
        observedAt: expect.any(Number),
      });
      expect(diagnostics[1]).toMatchObject({
        kind: 'missing_inbound_identity',
        missingFields: ['nativeMessageId'],
        sessionId: 'group_project_room',
        source: 'polling',
        observedAt: expect.any(Number),
      });
      expect(diagnostics[2]).toMatchObject({
        kind: 'missing_inbound_identity',
        missingFields: ['sessionId'],
        sessionId: '',
        source: 'event_bridge',
        observedAt: expect.any(Number),
      });
    });

    it('当原生 payload 包含 native msgID / msgId / messageId 时，优先提取为 native messageId', () => {
      const nativePayload = {
        sessionId: 'session_private_001',
        sessionName: '王经理',
        sessionType: 'private',
        msgID: 'kk_native_msg_987654321',
        sender: '王经理',
        senderId: 'user_wang',
        content: '请批准下周的请假申请。',
        time: '15:00:00',
        timestamp: 1787641000000,
        isMe: false,
      };

      const messages = normalizeNativeMessage(nativePayload, { currentUserId });
      expect(messages).toHaveLength(1);
      const msg = messages[0];

      expect(msg.id).toBe('kk_native_msg_987654321');
      expect(msg.messageId).toBe('kk_native_msg_987654321');
      expect(msg.sessionId).toBe('session_private_001');
      expect(msg.sessionType).toBe('private');
      expect(msg.origin).toBe('external');
      expect(msg.direction).toBe('inbound');
    });
    it('相同原生输入在 EventBridge 与 Polling 来源下产生相同 direction', () => {
      const payload = {
        sessionId: 'session-source-parity',
        id: 'native-source-parity',
        sender: 'Bot',
        senderId: currentUserId,
        isFromSelf: true,
        origin: 'external',
        content: '自身消息',
      };

      const eventMessage = normalizeNativeMessage(payload, {
        currentUserId,
        source: 'event_bridge',
      })[0];
      const pollingMessage = normalizeNativeMessage(payload, {
        currentUserId,
        source: 'polling',
      })[0];

      expect(eventMessage?.direction).toBe('outbound');
      expect(pollingMessage?.direction).toBe(eventMessage?.direction);
    });
  });

  describe('2. 原生发送者与系统消息来源', () => {
    it('外部普通成员发言应判定为 external', () => {
      const payload = {
        sessionId: 'group_room_1',
        sessionType: 'group',
        sender: '李四',
        id: 'native-external-1',
        senderId: 'user_lisi',
        content: '大家好！',
        time: '10:00:00',
        isMe: false,
      };
      const [msg] = normalizeNativeMessage(payload, { currentUserId });
      expect(msg.origin).toBe('external');
      expect(msg.direction).toBe('inbound');
      expect(msg.isMe).toBe(false);
    });

    it('本机人工消息只确认本人方向，不推断业务角色', () => {
      const payload = {
        sessionId: 'session_user_002',
        sessionType: 'private',
        sender: '我',
        senderId: currentUserId,
        id: 'native-operator-1',
        content: '收到，我这就处理。',
        time: '10:05:00',
        isMe: true,
      };
      const [msg] = normalizeNativeMessage(payload, { currentUserId });
      expect(msg.origin).toBe('unknown');
      expect(msg?.sdkSendKey).toBeUndefined();
      expect(msg.direction).toBe('outbound');
      expect(msg.isMe).toBe(true);
    });

    it('本人普通原生消息不因正文或昵称被当作 SDK 确认回显', () => {
      const botMsgId = 'bot_sent_uuid_001';
      const payload = {
        id: botMsgId,
        sessionId: 'session_user_002',
        sessionType: 'private',
        sender: 'Kairo 助手',
        senderId: currentUserId,
        content: '您好，我是智能助手，很高兴为您服务。',
        time: '10:06:00',
        isMe: true,
      };
      const [msg] = normalizeNativeMessage(payload, { currentUserId });
      expect(msg.origin).toBe('unknown');
      expect(msg?.sdkSendKey).toBeUndefined();
      expect(msg.direction).toBe('outbound');
      expect(msg.isMe).toBe(true);
    });
    it('其他设备本人消息仍为 outbound，但不建立 SDK 关联', () => {
      const payload = {
        id: 'unregistered_msg_999',
        sessionId: 'session_user_003',
        sessionType: 'private',
        sender: '我',
        senderId: currentUserId,
        content: '其他设备本人新消息',
        time: '10:07:00',
        isMe: true,
        deviceID: 12345,
      };
      const [msg] = normalizeNativeMessage(payload, { currentUserId });
      expect(msg.origin).toBe('unknown');
      expect(msg.direction).toBe('outbound');
      expect(msg.isMe).toBe(true);
    });

    it('系统消息与提示应判定为 system', () => {
      const payload = {
        sessionId: 'group_room_1',
        sessionType: 'group',
        sender: '系统消息',
        id: 'native-system-1',
        content: '张三 邀请了 李四 加入群聊',
        time: '10:10:00',
        isSystem: true,
        messageType: 'system',
      };
      const [msg] = normalizeNativeMessage(payload, { currentUserId });
      expect(msg.origin).toBe('system');
      expect(msg.direction).toBe('unknown');
    });
  });

  describe('3. 会话类型 (sessionType) 判定测试', () => {
    it('一对一私聊应准确解析为 private', () => {
      const payload = {
        sessionId: 'user_123',
        sessionType: 'private',
        content: '私聊测试',
        sender: '员工A',
        id: 'native-private-1',
      };
      const [msg] = normalizeNativeMessage(payload);
      expect(msg.sessionType).toBe('private');
    });

    it('群聊消息 (sessionType: group 或 type: 1) 应准确解析为 group', () => {
      const payload1 = {
        sessionId: 'group_456',
        sessionType: 'group',
        content: '群聊测试 1',
        sender: '员工B',
        id: 'native-group-1',
      };
      const [msg1] = normalizeNativeMessage(payload1);
      expect(msg1.sessionType).toBe('group');

      const payload2 = {
        session: { id: 'group_789', type: 1, name: '技术攻坚群' },
        content: '群聊测试 2',
        sender: '员工C',
        id: 'native-group-2',
      };
      const [msg2] = normalizeNativeMessage(payload2);
      expect(msg2.sessionType).toBe('group');
    });
  });

  describe('4. 群聊 @ 提及、引用、附件与原始诊断信息无损保留测试', () => {
    it('普通 atState=1 消息不得被误判为 @我', () => {
      const [message] = normalizeNativeMessage(
        {
          sessionId: 'group-normal',
          sessionType: 'group',
          id: 'native-normal-at-state',
          sender: '普通成员',
          content: '普通群聊消息',
          atState: 1,
          atMemberIDList: [],
        },
        { currentUserId }
      );

      expect(message.atMe).toBe(false);
      expect(message.mentions).toBeUndefined();
    });

    it('普通文本包含“@全体”字样时不得伪造原生 @全体 状态', () => {
      const [message] = normalizeNativeMessage(
        {
          sessionId: 'group-plain-text',
          sessionType: 'group',
          id: 'native-plain-at-all-text',
          sender: '普通成员',
          content: '说明：本消息不使用@全体功能',
          atState: 1,
          atMemberIDList: [],
        },
        { currentUserId }
      );

      expect(message.atAll).toBe(false);
      expect(message.mentions).toBeUndefined();
    });

    it('应完整保留群聊 @我 与 @全体 元数据', () => {
      const payload = {
        sessionId: 'group_dev',
        sessionType: 'group',
        sender: '测试员',
        id: 'native-mentions-1',
        senderId: 'user_tester',
        content: '@智能助手 请查收测试报告 @所有人',
        atMe: true,
        atAll: true,
        atMemberIDList: [currentUserId, 'all'],
      };
      const [msg] = normalizeNativeMessage(payload, { currentUserId });
      expect(msg.atMe).toBe(true);
      expect(msg.atAll).toBe(true);
      expect(msg.mentions).toBeDefined();
      expect(msg.mentions?.isAtMe).toBe(true);
      expect(msg.mentions?.isAtAll).toBe(true);
      expect(msg.mentions?.mentionedUsers).toContain(currentUserId);
    });

    it('应完整保留引用回复 (replyTo) 元数据', () => {
      const payload = {
        sessionId: 'group_dev',
        sessionType: 'group',
        sender: '开发A',
        id: 'native-reply-1',
        content: '这个Bug已修复。',
        replyMsg: {
          id: 'msg_orig_001',
          sender: '测试员',
          content: '登录按钮点击无响应。',
        },
      };
      const [msg] = normalizeNativeMessage(payload);
      expect(msg.replyTo).toBeDefined();
      expect(msg.replyTo?.replyToSender).toBe('测试员');
      expect(msg.replyTo?.replyToContent).toBe('登录按钮点击无响应。');
      expect(msg.replyTo?.replyToId).toBe('msg_orig_001');
    });

    it('应完整保留文件与图片附件元数据', () => {
      const payload = {
        sessionId: 'group_dev',
        sessionType: 'group',
        sender: '设计B',
        id: 'native-attachment-1',
        content: '[文件: UI规范.pdf]',
        fileName: 'UI规范.pdf',
        fileSize: '5.2MB',
        filePath: 'C:\\cache\\UI规范.pdf',
        images: [
          {
            filePath: 'C:\\cache\\preview.png',
            url: 'file:///C:/cache/preview.png',
            width: 800,
            height: 600,
          },
        ],
      };
      const [msg] = normalizeNativeMessage(payload);
      expect(msg.fileInfo).toBeDefined();
      expect(msg.fileInfo?.fileName).toBe('UI规范.pdf');
      expect(msg.fileInfo?.fileSize).toBe('5.2MB');
      expect(msg.images).toHaveLength(1);
      expect(msg.images?.[0].width).toBe(800);
      expect(msg.raw).toBeDefined();
    });
  });

  describe('5. EventBridge 与 Polling 离线 emit 派发与全身份覆盖测试', () => {
    it('EventBridge 派发他人、本人、系统消息，不推断业务角色', async () => {
      const mockCdp = new MockCdpClient();
      const bridge = new KK9EventBridge(
        { cdp: { url: 'http://127.0.0.1:9222', pageMatch: 'renderer.html' }, currentUserId },
        mockCdp as unknown as CdpClient
      );
      await bridge.connect();


      const emittedMessages: KK9Message[] = [];
      bridge.on('message', msg => emittedMessages.push(msg));

      // 1. external
      mockCdp.triggerBinding('__kairo_native_bridge', {
        type: 'receive-message',
        data: {
          id: 'eb_ext_1',
          sessionId: 'group_eb',
          sessionType: 'group',
          sender: '外部用户',
          senderId: 'user_other',
          content: '大家好',
          isMe: false,
        },
      });

      // 本机本人消息。
      mockCdp.triggerBinding('__kairo_native_bridge', {
        type: 'receive-message',
        data: {
          id: 'eb_op_1',
          sessionId: 'group_eb',
          sessionType: 'group',
          sender: '操作员',
          senderId: currentUserId,
          content: '操作员在客户端打字',
          isMe: true,
        },
      });

      // 其他设备本人消息。

      mockCdp.triggerBinding('__kairo_native_bridge', {
        type: 'receive-message',
        data: {
          id: 'eb_bot_echo_1',
          sessionId: 'group_eb',
          sessionType: 'group',
          sender: 'Kairo 机器人',
          senderId: currentUserId,
          content: '机器人自身发出的回复',
          deviceID: 12345,
          isMe: true,
        },
      });

      // 4. system
      mockCdp.triggerBinding('__kairo_native_bridge', {
        type: 'receive-message',
        data: {
          id: 'eb_sys_1',
          sessionId: 'group_eb',
          sessionType: 'group',
          sender: '系统通知',
          content: '群公告已更新',
          messageType: 'system',
        },
      });

      expect(emittedMessages).toHaveLength(4);
      expect(emittedMessages[0].id).toBe('eb_ext_1');
      expect(emittedMessages[0].origin).toBe('external');
      expect(emittedMessages[0].direction).toBe('inbound');
      expect(emittedMessages[1].id).toBe('eb_op_1');
      expect(emittedMessages[1].origin).toBe('unknown');
      expect(emittedMessages[1]?.sdkSendKey).toBeUndefined();
      expect(emittedMessages[1].direction).toBe('outbound');
      expect(emittedMessages[2].id).toBe('eb_bot_echo_1');
      expect(emittedMessages[2].origin).toBe('unknown');
      expect(emittedMessages[2]?.sdkSendKey).toBeUndefined();
      expect(emittedMessages[2].direction).toBe('outbound');
      expect(emittedMessages[3].id).toBe('eb_sys_1');
      expect(emittedMessages[3].origin).toBe('system');
      expect(emittedMessages[3].direction).toBe('unknown');
    });

    it('旧窗口轮询保留他人、本人、系统消息，不推断 SDK 关联', async () => {
      const mockCdp = new MockCdpClient();
      const driver = new KK9Driver({
        cdp: { url: 'http://127.0.0.1:9222', pageMatch: 'renderer.html' },
        currentUserId,
      });
      const internals = getDriverTestInternals<{ cdp: MockCdpClient }>(driver);
      const domMessageOps = new MessageOps(mockCdp as unknown as CdpClient, DEFAULT_SELECTORS);

      // 将 driver 内部的 cdpClient 替换为 MockCdpClient 进行底层 evaluate 拦截
      internals.cdp = mockCdp;

      const emittedMessages: KK9Message[] = [];
      driver.on('message', msg => emittedMessages.push(msg));

      // 模拟 MessageOps 内部 CDP evaluate 返回的原生消息列表
      const rawMessagesList = [
        {
          sender: '外部员工',
          senderId: 'user_other',
          time: '12:00',
          content: '请协助处理单据',
          isMe: false,
          messageType: 'text',
          raw: { msgID: 'poll-ext-1' },
        },
        {
          sender: '我',
          senderId: currentUserId,
          time: '12:01',
          content: '我正在看',
          isMe: true,
          messageType: 'text',
          raw: { msgID: 'poll-op-1' },
        },
        {
          sender: 'Kairo 助手',
          senderId: currentUserId,
          time: '12:02',
          content: '单据已生成',
          isMe: true,
          messageType: 'text',
          raw: {
            msgID: 'poll_bot_echo_1',
          },
        },
        {
          sender: '系统通知',
          time: '12:03',
          content: '系统例行维护提醒',
          isMe: false,
          messageType: 'system',
          raw: { msgID: 'poll-system-1' },
        },
      ];
      mockCdp.evaluateMock.mockImplementation((script: string) => {
        if (script.includes('extractContent')) {
          return Promise.resolve(rawMessagesList);
        }
        return Promise.resolve([]);
      });

      const pollingSession = {
        id: 'ses_poll_all',
        name: '轮询综合会话',
        type: 'private' as const,
        nativeType: 0,
        receiverId: '91002',
        unread: true,
      };
      const parsedMessages = await domMessageOps.getRecentMessages(
        10,
        pollingSession,
        currentUserId
      );
      Object.assign(internals.bridgeMessageOps, {
        getRecentMessages: vi.fn().mockResolvedValue(parsedMessages),
      });

      await internals.collectAndEmitMessages(pollingSession, 10);

      expect(emittedMessages).toHaveLength(4);
      expect(emittedMessages[0].origin).toBe('external');
      expect(emittedMessages[0].direction).toBe('inbound');
      expect(emittedMessages[0].messageId).toBeDefined();
      expect(emittedMessages[0].id).toBe(emittedMessages[0].messageId);

      expect(emittedMessages[1].origin).toBe('unknown');
      expect(emittedMessages[1].direction).toBe('outbound');
      expect(emittedMessages[1].messageId).toBeDefined();

      // 原生 ID 验证
      expect(emittedMessages[2].id).toBe('poll_bot_echo_1');
      expect(emittedMessages[2].messageId).toBe('poll_bot_echo_1');
      expect(emittedMessages[2].origin).toBe('unknown');
      expect(emittedMessages[2]?.sdkSendKey).toBeUndefined();
      expect(emittedMessages[2].direction).toBe('outbound');

      expect(emittedMessages[3].origin).toBe('system');
      expect(emittedMessages[3].direction).toBe('unknown');
      expect(emittedMessages[3].messageId).toBeDefined();
    });
    it('Polling 按 sessionId 隔离相同 native messageId', async () => {
      const mockCdp = new MockCdpClient();
      const driver = new KK9Driver({
        cdp: { url: 'http://127.0.0.1:9222', pageMatch: 'renderer.html' },
        currentUserId,
      });
      const internals = getDriverTestInternals<{ cdp: MockCdpClient }>(driver);
      const domMessageOps = new MessageOps(mockCdp as unknown as CdpClient, DEFAULT_SELECTORS);

      internals.cdp = mockCdp;

      mockCdp.evaluateMock.mockImplementation((script: string) =>
        script.includes('extractContent')
          ? Promise.resolve([
              {
                sender: '员工',
                time: '12:30',
                content: '同一 native ID 的消息',
                isMe: false,
                messageType: 'text',
                raw: { msgID: 'shared-native-id' },
              },
            ])
          : Promise.resolve([])
      );

      const emittedMessages: KK9Message[] = [];
      driver.on('message', message => emittedMessages.push(message));
      const sessionA = { id: 'session-a', name: '会话 A', type: 'private' as const, nativeType: 0, receiverId: '91002', unread: true };
      const sessionB = { id: 'session-b', name: '会话 B', type: 'private' as const, nativeType: 0, receiverId: '91003', unread: true };
      const messagesA = await domMessageOps.getRecentMessages(
        10,
        sessionA,
        currentUserId
      );
      const messagesB = await domMessageOps.getRecentMessages(
        10,
        sessionB,
        currentUserId
      );
      Object.assign(internals.bridgeMessageOps, {
        getRecentMessages: vi
          .fn()
          .mockResolvedValueOnce(messagesA)
          .mockResolvedValueOnce(messagesB),
      });

      await internals.collectAndEmitMessages(sessionA, 10);
      await internals.collectAndEmitMessages(sessionB, 10);

      expect(emittedMessages).toHaveLength(2);
      expect(emittedMessages.map(message => message.sessionId)).toEqual(['session-a', 'session-b']);
      expect(emittedMessages.every(message => message.messageId === 'shared-native-id')).toBe(true);
    });
  });

  describe('6. 私聊会话 ID 归一化与防指向 Bot 自身测试', () => {
    const botUid = '5761';
    const peerUid = '7783';

    it('当原生私聊载荷的 typeID 指向 Bot 自身时，必须收敛为对方成员 ID (0-senderId)', () => {
      const payload = {
        session: {
          type: 0,
          typeID: botUid,
          creater: peerUid,
          createrName: '陈鹏',
        },
        message: {
          id: 'kk-msg-001',
          sender: '陈鹏',
          senderId: peerUid,
          content: '你好',
          time: '14:20:12',
          isMe: false,
        },
      };

      const [msg] = normalizeNativeMessage(payload, { currentUserId: botUid });
      expect(msg).toBeDefined();
      expect(msg.sessionId).toBe(`0-${peerUid}`);
      expect(msg.sessionName).toBe('陈鹏');
      expect(msg.sessionType).toBe('private');
      expect(msg.senderId).toBe(peerUid);
      expect(msg.direction).toBe('inbound');
    });

    it('当原生私聊载荷顶层 sessionId 错误写为 0-botUid 时，入站消息自动纠正为 0-senderId', () => {
      const payload = {
        sessionId: `0-${botUid}`,
        sessionType: 'private',
        sender: '陈鹏',
        senderId: peerUid,
        id: 'kk-msg-002',
        content: '在吗',
        isMe: false,
      };

      const [msg] = normalizeNativeMessage(payload, { currentUserId: botUid });
      expect(msg).toBeDefined();
      expect(msg.sessionId).toBe(`0-${peerUid}`);
    });

    it('当原生载荷带有明确且正确的 sesUUID 时，优先采纳 sesUUID', () => {
      const payload = {
        session: {
          sesUUID: `0-${peerUid}`,
          type: 0,
          typeID: botUid,
        },
        message: {
          id: 'kk-msg-003',
          sender: '陈鹏',
          senderId: peerUid,
          content: '测试明确 sesUUID',
          isMe: false,
        },
      };

      const [msg] = normalizeNativeMessage(payload, { currentUserId: botUid });
      expect(msg).toBeDefined();
      expect(msg.sessionId).toBe(`0-${peerUid}`);
    });

    it('群聊消息不应受私聊规则影响', () => {
      const groupId = '92001';
      const payload = {
        session: {
          type: 1,
          typeID: groupId,
          name: '技术攻坚群',
        },
        message: {
          id: 'kk-msg-group-1',
          sender: '陈鹏',
          senderId: peerUid,
          content: '大家好',
          isMe: false,
        },
      };

      const [msg] = normalizeNativeMessage(payload, { currentUserId: botUid });
      expect(msg).toBeDefined();
      expect(msg.sessionId).toBe(`1-${groupId}`);
      expect(msg.sessionType).toBe('group');
    });
  });
});
