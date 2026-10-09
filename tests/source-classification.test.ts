import { describe, expect, it } from 'vitest';
import { normalizeNativeMessage } from '../src/bridge/converter.js';

const currentUserId = '5761';
function message(sender: unknown, extra: Record<string, unknown> = {}) {
  return { sessionID: 716791, message: [{ id: 1001, sender, contentType: 4, content: '测试', ...extra }] };
}

describe('原生发送者方向与本次 SDK 关联', () => {
  it.each([
    [5761, 'outbound', 'unknown', true],
    ['5761', 'outbound', 'unknown', true],
    [3585, 'inbound', 'external', false],
    ['3585', 'inbound', 'external', false],
    [undefined, 'unknown', 'unknown', false],
    ['昵称', 'unknown', 'unknown', false],
  ])('发送者 %s 按当前 UID 比较，不按业务角色', (sender, direction, origin, isMe) => {
    const [result] = normalizeNativeMessage(message(sender), { currentUserId });
    expect(result).toMatchObject({ direction, origin, isMe });
    expect(result?.sdkSendKey).toBeUndefined();
  });

  it('只有昵称、旧业务来源或 self 标志，不能代替原生发送者', () => {
    const [result] = normalizeNativeMessage(message(undefined, {
      senderName: '我', origin: 'operator', isMe: true, fromMe: true,
    }), { currentUserId });
    expect(result).toMatchObject({ direction: 'unknown', origin: 'unknown', isMe: false });
  });

  it('原生发送者优先于互相矛盾的旧角色和 self 标志', () => {
    const [result] = normalizeNativeMessage(message(3585, { isMe: true, origin: 'bot_echo' }), { currentUserId });
    expect(result).toMatchObject({ senderId: '3585', direction: 'inbound', origin: 'external', isMe: false });
  });

  it('实际登录身份缺席时不沿用 self 标志判断方向', () => {
    const [result] = normalizeNativeMessage(message(5761, { isMe: true }));
    expect(result).toMatchObject({ senderId: '5761', direction: 'unknown', origin: 'unknown', isMe: false });
  });

  it('session-only 已读更新和空 message 不产生聊天记录', () => {
    const session = { id: 716791, userReadIndex: 100, lastSender: 3585 };
    expect(normalizeNativeMessage({ sessionID: 716791, session }, { currentUserId })).toEqual([]);
    expect(normalizeNativeMessage({ sessionID: 716791, session, message: [] }, { currentUserId })).toEqual([]);
  });

  it('普通原生系统通知保留记录和身份，但不强行指定方向', () => {
    const [result] = normalizeNativeMessage(message(5761, {
      contentType: 6, content: { event: 'ModifyGroupName', data: '测试名称' },
    }), { currentUserId });
    expect(result).toMatchObject({ id: '1001', senderId: '5761', messageType: 'system', origin: 'system', direction: 'unknown' });
  });
});
