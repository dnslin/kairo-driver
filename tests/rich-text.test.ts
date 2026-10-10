import { describe, expect, it } from 'vitest';
import { BridgeMessageOps } from '../src/bridge/message-ops.js';
import type { FormattedText, SendOptions } from '../src/types/index.js';
import { createNativeSendRuntime } from './helpers/native-send-runtime.js';

describe('T08 原生文本、提及与引用', () => {
  it('保留文字和换行，整条消息使用明确字体而不解析HTML或Markdown', async () => {
    const native = createNativeSendRuntime();
    const result = await new BridgeMessageOps(native.cdp).sendRichText({
      text: '**字面** <b>原文</b>\n路径 C:\\new\\notes',
      font: { bold: true, italic: true, underline: true, fontSize: 14, fontFamily: '微软雅黑', color: '#1890ff' },
    }, { targetSessionId: '93001' });
    expect(result.status).toBe('sent');
    expect(native.drafts[0]?.['content']).toEqual({
      content: [{ type: 0, text: '**字面** <b>原文</b>\n路径 C:\\new\\notes' }],
      font: { bold: 1, italic: 1, underline: 1, size: 14, fontfamily: '微软雅黑', color: 16748568 },
    });
  });

  it('普通提及用真实UID而非昵称，节点与消息级元数据一致', async () => {
    const native = createNativeSendRuntime();
    await new BridgeMessageOps(native.cdp).sendText('提醒', {
      targetSessionId: '93002', mentions: { uid: '91002', name: '员工甲' },
    });
    expect(native.drafts[0]).toMatchObject({ atState: 0, atMemberIDList: [91002], content: {
      content: [{ type: 2, replyMemberID: 91002, replyMemberType: 0, replyMemberName: '员工甲', replyMemberNameEN: '员工甲', replyMemberNameTC: '员工甲' }, { type: 0, text: ' ' }, { type: 0, text: '提醒' }],
    } });
  });

  it('引用提及保留原生身份索引正文，字体在顶层且UID列表包含引用作者和正文成员', async () => {
    const native = createNativeSendRuntime();
    native.records.push({ id: 88, msgIdx: 7, sessionID: 93002, sender: 91003, senderName: '作者', contentType: 4,
      content: JSON.stringify({ content: [{ type: 0, text: '原生正文' }] }) });
    const result = await new BridgeMessageOps(native.cdp).sendReply({ messageId: '88', msgIdx: 7 },
      { text: '答复', font: { bold: true } }, { targetSessionId: '93002', mentions: { uid: 91002, name: '员工甲' } });
    expect(result.status).toBe('sent');
    expect(native.drafts[0]).toMatchObject({ atState: 2, atMemberIDList: [91003, 91002], content: {
      replyedID: 91003, replyedName: '作者', replyedMsgId: 88, replyedMsgIndex: 7,
      replyedContent: { content: [{ type: 0, text: '原生正文' }] }, font: { bold: 1 },
      replyContent: { content: [{ type: 2, replyMemberID: 91002 }, { type: 0, text: ' ' }, { type: 0, text: '答复' }] },
    } });
    const content = native.drafts[0]?.['content'] as Record<string, unknown>;
    expect(content['replyContent']).not.toHaveProperty('font');
    native.records[native.records.length - 1]!['atMemberIDList'] = '[91003,91002]';
    const messages = await new BridgeMessageOps(native.cdp).getRecentMessages({ id: '93002', name: '群甲', type: 'group', nativeType: 1, receiverId: '92001', unread: false }, 1, 91002);
    expect(messages[0]).toMatchObject({ content: '@员工甲 答复', atMe: true,
      mentions: { mentionedUsers: ['91003', '91002'] }, replyTo: { replyToSender: '作者', replyToContent: '原生正文', replyToId: '88', replyToSenderId: '91003', replyToMsgIdx: 7 } });
  });

  it('拒绝旧HTML、逐段样式及不支持字体，不静默丢弃后发送', async () => {
    const native = createNativeSendRuntime();
    const ops = new BridgeMessageOps(native.cdp);
    for (const input of [{ html: '<b>文字</b>' }, [{ text: '文字', style: { bold: true } }], { text: '文字', font: { strikethrough: true } }, { text: '文字', font: { color: '无效色' } }]) {
      const result = await ops.sendRichText(input as unknown as FormattedText, { targetSessionId: '93001' });
      expect(result).toMatchObject({ status: 'failed', isPreTrigger: true });
    }
    expect(native.drafts).toEqual([]);
  });

  it('拒绝无UID的昵称提及，不构造UID0', async () => {
    const native = createNativeSendRuntime();
    const result = await new BridgeMessageOps(native.cdp).sendText('提醒', { targetSessionId: '93002', mentions: ['员工甲'] } as unknown as SendOptions);
    expect(result).toMatchObject({ status: 'failed', isPreTrigger: true });
    expect(native.drafts).toEqual([]);
  });

  it('其他会话同号消息和原生历史错误不能构造假引用', async () => {
    const native = createNativeSendRuntime();
    native.records.push({ id: 88, msgIdx: 7, sessionID: 93002, sender: 91003, contentType: 4, content: { content: [{ type: 0, text: '别处' }] } });
    const result = await new BridgeMessageOps(native.cdp).sendReply({ messageId: '88', msgIdx: 7 }, '答复', { targetSessionId: '93001' });
    expect(result).toMatchObject({ status: 'failed', isPreTrigger: true });
    expect(native.drafts).toEqual([]);
    const wrongIndex = await new BridgeMessageOps(native.cdp).sendReply({ messageId: '88', msgIdx: 8 }, '答复', { targetSessionId: '93002' });
    expect(wrongIndex).toMatchObject({ status: 'failed', isPreTrigger: true });
    expect(native.drafts).toEqual([]);
    const broken = createNativeSendRuntime({ queryCode: 627 });
    const failure = await new BridgeMessageOps(broken.cdp).sendReply('88', '答复', { targetSessionId: '93001' });
    expect(failure).toMatchObject({ status: 'failed', isPreTrigger: true });
    expect(failure.error).toMatch(/getMessages.*627/);
    expect(broken.drafts).toEqual([]);
  });
});
