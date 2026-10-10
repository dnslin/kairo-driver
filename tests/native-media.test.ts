import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createNativeSendRuntime } from './helpers/native-send-runtime.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CdpClient } from '../src/cdp/client.js';
import { BridgeMessageOps } from '../src/bridge/message-ops.js';
import { normalizeNativeMessage } from '../src/bridge/converter.js';
import { createNativeMessageKey } from '../src/bridge/send-status.js';
import { prepareVoice } from '../src/bridge/voice-ops.js';
import { KK9Driver } from '../src/driver.js';
import { InMemorySendOperationStore } from '../src/send-operation.js';
import { getDriverTestInternals } from './helpers/driver-internals.js';
import {
  createRendererRuntime,
  FakeIpcRenderer,
  NO_IPC_RESPONSE,
  runRendererScript,
  type RendererMessage,
  type RendererRuntime,
} from './helpers/renderer-runtime.js';

vi.mock('../src/bridge/voice-ops.js', () => ({
  prepareVoice: vi.fn(),
}));

const session = {
  id: 93001,
  sesUUID: '0-91002',
  typeName: 'test-employee',
  name: 'test-employee',
  type: 0,
  typeID: 91002,
};

interface SuccessfulNativeRuntime {
  cdp: CdpClient;
  ipc: FakeIpcRenderer;
  runtime: RendererRuntime;
  inserted: Array<Record<string, unknown>>;
  sent: Array<Record<string, unknown>>;
  confirmed: RendererMessage[];
}

function createSuccessfulNativeRuntime(): SuccessfulNativeRuntime {
  const inserted: Array<Record<string, unknown>> = [];
  const sent: Array<Record<string, unknown>> = [];
  const confirmed: RendererMessage[] = [];
  let nextMessageId = 135_700_000;
  const ipc = new FakeIpcRenderer(request => {
    const method = request.args[0];
    if (method === 'getMemberDetail') return { code: 0, data: { id: 91001, name: '我' } };
    if (method === 'getSessionBySessionID') return { code: 0, data: session };
    if (method === 'insertSendBefoeMsg') {
      const message = request.args[1] as Record<string, unknown>;
      inserted.push(message);
      const persisted = {
        ...message,
        id: nextMessageId,
        msgIdx: nextMessageId - 135_699_900,
        sessionID: session.id,
      };
      nextMessageId += 1;
      confirmed.push(persisted);
      return { code: 0, data: { ...message, id: -22, msgIdx: persisted.msgIdx } };
    }
    if (method === 'cancelMessage') {
      const requestMessage = request.args[1] as { sessionID: number; msgID: number };
      const record = confirmed.find(
        message =>
          message['sessionID'] === requestMessage.sessionID &&
          Number(message['id']) === requestMessage.msgID
      );
      if (!record) return { code: 627 };
      record['msgFlag'] = 'C';
      return { code: 0 };
    }
    if (method === 'sendMessageNew') {
      sent.push(request.args[1] as Record<string, unknown>);
      const message = request.args[1] as Record<string, unknown>;
      ipc.emit('0-91002-sendMsgCallback', {
        args: {
          msgID: message['id'],
          code: 0,
          data: confirmed.find(record => record['msgFlag'] === message['msgFlag']),
        },
      });
      return { code: 0 };
    }
    if (method === 'getMessages') return { code: 0, data: confirmed };
    return { code: 1 };
  });
  const runtime = createRendererRuntime({ ipc, sessions: [session] });
  const cdp = {
    evaluate: vi.fn((script: string) => runRendererScript(script, runtime.context)),
  } as unknown as CdpClient;
  return { cdp, ipc, runtime, inserted, sent, confirmed };
}

afterEach(() => {
  vi.useRealTimers();
  vi.mocked(prepareVoice).mockReset();
});

describe('原生卡片与语音发送集成', () => {
  it('卡片按显式业务等待期限结束，不使用固定八秒', async () => {
    vi.useFakeTimers();
    const native = createSuccessfulNativeRuntime();
    const send = native.ipc.send.bind(native.ipc);
    native.ipc.send = (channel, request) => {
      if (request.args[0] === 'sendMessageNew') setTimeout(() => send(channel, request), 200);
      else send(channel, request);
    };
    const pending = new BridgeMessageOps(native.cdp).sendUrlCard(
      { title: '等待期限', summary: '受控回执', linkUrl: 'https://example.test' },
      { targetSessionId: '93001', operationId: 'op-card-deadline', verifyTimeoutMs: 100 }
    );
    await vi.advanceTimersByTimeAsync(250);
    expect(await pending).toMatchObject({ status: 'unknown', isPreTrigger: false });
    expect(native.ipc.listenerCount('0-91002-sendMsgCallback')).toBe(0);
  });
  it('语音准备期间取消，不在准备完成后提交', async () => {
    const native = createSuccessfulNativeRuntime();
    const ops = new BridgeMessageOps(native.cdp);
    let ready = (): void => {};
    let release = (): void => {};
    const started = new Promise<void>(resolve => {
      ready = resolve;
    });
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    vi.mocked(prepareVoice).mockImplementation(async () => {
      ready();
      await gate;
      return { duration: 2, data: 'IyFBTVIK' };
    });
    const pending = ops.sendVoice(
      { text: '受控准备' },
      { targetSessionId: '93001', operationId: 'op-cancel-voice' }
    );
    await started;
    const cancelling = ops.cancelPendingSends();
    release();
    await cancelling;
    expect(await pending).toMatchObject({ status: 'failed', isPreTrigger: true });
    expect(native.confirmed).toEqual([]);
    expect(native.sent).toEqual([]);
  });
  it('链接和应用通知在无界面环境使用各自原生字段，不伪造图片资源或应用编号', async () => {
    const native = createNativeSendRuntime();
    const ops = new BridgeMessageOps(native.cdp);
    const url = await ops.sendUrlCard({ title: '测试链接', summary: '无图片测试', linkUrl: 'https://example.com' }, { targetSessionId: '93001' });
    const app = await ops.sendAppMessage({ title: '测试通知', content: '<p><b>仅测试</b></p>', linkUrl: 'https://example.com' }, { targetSessionId: '93002' });
    expect(url.status).toBe('sent');
    expect(app.status).toBe('sent');
    expect(native.drafts[0]).toMatchObject({ contentType: 10, sessionID: 93001, content: { title: '测试链接', summary: '无图片测试', linkUrl: 'https://example.com' } });
    expect(native.drafts[0]?.['content']).not.toHaveProperty('isValid');
    expect(native.drafts[1]).toMatchObject({ contentType: 8, sessionID: 93002, content: { title: '测试通知', content: '<p><b>仅测试</b></p>', linkUrl: 'https://example.com' } });
    expect(native.drafts[1]?.['content']).not.toHaveProperty('pcAppCode');
  });

  it('业务通知必须明确原生类型与相对详情路径，不把外部网址拼到业务域名后', async () => {
    const native = createNativeSendRuntime();
    const ops = new BridgeMessageOps(native.cdp);
    const invalid = await ops.sendBizMessage({ title: '测试', content: '不创建任务', bizType: 1, bizUrl: 'https://example.com' }, { targetSessionId: '93001' });
    expect(invalid).toMatchObject({ status: 'failed', isPreTrigger: true, error: expect.stringContaining('ekp_outer_domain') });
    expect(native.drafts).toEqual([]);
    const valid = await ops.sendBizMessage({ title: '测试', content: '不创建任务', summary: ['仅展示通知'], bizType: 1, bizUrl: '/' }, { targetSessionId: '93001' });
    expect(valid.status).toBe('sent');
    expect(native.drafts[0]).toMatchObject({ contentType: 17, content: { bizType: 1, bizUrl: '/', summary: ['仅展示通知'] } });
  });

  it('合并从来源会话读取真实正文、作者、ID和索引，按原顺序生成详情条目', async () => {
    const native = createNativeSendRuntime();
    native.records.push(
      { id: 81, msgIdx: 7, sessionID: 93001, sender: 91001, senderName: '原作者甲', sendTime: 1700000001, contentType: 0, content: '第一条原文', msgFlag: '' },
      { id: 82, msgIdx: 8, sessionID: 93001, sender: 91002, senderName: '原作者乙', sendTime: 1700000002, contentType: 4, content: JSON.stringify({ content: [{ type: 0, text: '第二条原文' }] }), msgFlag: '' }
    );
    const result = await new BridgeMessageOps(native.cdp).sendChatRecord({ sourceSessionId: '93001', msgArray: [{ messageId: '82', msgIdx: 8 }, { messageId: '81', msgIdx: 7 }] }, { targetSessionId: '93002' });
    expect(result.status).toBe('sent');
    const merged = native.drafts[0]?.['content'] as { sessionID: number; sessionType: number; typeID: number; msgArray: Array<Record<string, unknown>> };
    expect(merged).toMatchObject({ sessionID: 93001, sessionType: 0, typeID: 91002 });
    expect(merged.msgArray.map(item => [item['id'], item['msgIdx'], item['senderID'], item['senderName'], item['sendTime']])).toEqual([[81, 7, 91001, '原作者甲', '1700000001'], [82, 8, 91002, '原作者乙', '1700000002']]);
    const bodies = merged.msgArray.map(item => {
      const content = item['content'];
      if (!content || typeof content !== 'object' || !('content' in content) || !Array.isArray(content.content)) throw new Error('详情正文不是原生节点');
      const node: unknown = content.content[0];
      return node && typeof node === 'object' && 'text' in node ? node.text : undefined;
    });
    expect(bodies).toEqual(['第一条原文', '第二条原文']);
    expect(merged.msgArray.map(item => item['contentType'])).toEqual([4, 4]);
  });

  it('合并引用回复时隐藏已撤回的引用正文，保留正常引用和回复正文', async () => {
    const native = createNativeSendRuntime();
    const reply = (messageId: number) => ({
      replyedMsgId: messageId,
      replyedContentType: 4,
      replyedContent: { content: [{ type: 0, text: '引用原文' }] },
      replyContent: { content: [{ type: 0, text: '回复正文' }] },
    });
    native.records.push(
      { id: 80, msgIdx: 6, sessionID: 93001, msgFlag: 'C:op:原操作' },
      { id: 81, msgIdx: 7, sessionID: 93001, sender: 91001, senderName: '原生账号', sendTime: 1700000001, contentType: 13, content: JSON.stringify(reply(80)), msgFlag: '' },
      { id: 82, msgIdx: 8, sessionID: 93001, msgFlag: '' },
      { id: 83, msgIdx: 9, sessionID: 93001, sender: 91002, senderName: '员工甲', sendTime: 1700000002, contentType: 13, content: JSON.stringify(reply(82)), msgFlag: '' }
    );
    const result = await new BridgeMessageOps(native.cdp).sendChatRecord(
      { sourceSessionId: '93001', msgArray: [{ messageId: '81', msgIdx: 7 }, { messageId: '83', msgIdx: 9 }] },
      { targetSessionId: '93002' }
    );
    expect(result.status).toBe('sent');
    const merged = native.drafts[0]?.['content'] as { msgArray: Array<{ content: { replyedContent: unknown; replyedContentType: number; replyContent: unknown } }> };
    expect(merged.msgArray.map(item => item.content.replyedContent)).toEqual([
      { content: [{ type: 0, text: '消息已被撤回' }] },
      { content: [{ type: 0, text: '引用原文' }] },
    ]);
    expect(merged.msgArray.map(item => item.content.replyedContentType)).toEqual([4, 4]);
    expect(merged.msgArray.map(item => item.content.replyContent)).toEqual([
      { content: [{ type: 0, text: '回复正文' }] },
      { content: [{ type: 0, text: '回复正文' }] },
    ]);
  });

  it('合并引用目标查询失败时保留错误且不提交旧引用正文', async () => {
    const native = createNativeSendRuntime({ queryCode: 627 });
    native.records.push({ id: 81, msgIdx: 7, sessionID: 93001, sender: 91001, senderName: '原生账号', sendTime: 1700000001, contentType: 13,
      content: { replyedMsgId: 80, replyedContentType: 4, replyedContent: { content: [{ type: 0, text: '旧引用正文' }] }, replyContent: { content: [{ type: 0, text: '回复正文' }] } }, msgFlag: '' });
    const result = await new BridgeMessageOps(native.cdp).sendChatRecord(
      { sourceSessionId: '93001', msgArray: [{ messageId: '81', msgIdx: 7 }] },
      { targetSessionId: '93002' }
    );
    expect(result).toMatchObject({ status: 'failed', isPreTrigger: true, error: expect.stringMatching(/getMessageByMsgId.*627/) });
    expect(native.drafts).toEqual([]);
  });

  it('对端创建私聊的合并标题使用与对端UID对应的创建者名称', async () => {
    const native = createNativeSendRuntime();
    Object.assign(native.sessions[0]!, { typeID: 91001, typeName: '原生账号', creater: 91002, createrName: '实际对端' });
    native.records.push({ id: 81, msgIdx: 7, sessionID: 93001, sender: 91002, senderName: '实际对端', sendTime: 1700000001, contentType: 0, content: '测试正文', msgFlag: '' });
    const result = await new BridgeMessageOps(native.cdp).sendChatRecord(
      { sourceSessionId: '93001', msgArray: [{ messageId: '81', msgIdx: 7 }] },
      { targetSessionId: '93002' }
    );
    expect(result.status).toBe('sent');
    expect(native.drafts[0]?.['content']).toMatchObject({ typeID: 91002, typeName: '实际对端' });
    expect(normalizeNativeMessage(native.drafts[0])[0]?.content).toBe('原生账号与实际对端的聊天记录');
  });

  it('合并索引指向另一消息时在创建草稿前失败，不借另一会话或假ID补齐', async () => {
    const native = createNativeSendRuntime();
    native.records.push({ id: 82, msgIdx: 8, sessionID: 93001, sender: 91001, senderName: '本人', sendTime: 1700000000, contentType: 0, content: '不是请求的消息' });
    const result = await new BridgeMessageOps(native.cdp).sendChatRecord({ sourceSessionId: '93001', msgArray: [{ messageId: '81', msgIdx: 8 }] }, { targetSessionId: '93002' });
    expect(result).toMatchObject({ status: 'failed', isPreTrigger: true, error: expect.stringContaining('81') });
    expect(native.drafts).toEqual([]);
  });

  it('合并来源UID0不能冒充真实作者，也不创建草稿', async () => {
    const native = createNativeSendRuntime();
    native.records.push({ id: 81, msgIdx: 7, sessionID: 93001, sender: 0, senderName: '未知用户', sendTime: 1700000000, contentType: 0, content: '缺少作者' });
    const result = await new BridgeMessageOps(native.cdp).sendChatRecord({ sourceSessionId: '93001', msgArray: [{ messageId: '81', msgIdx: 7 }] }, { targetSessionId: '93002' });
    expect(result).toMatchObject({ status: 'failed', isPreTrigger: true, error: expect.stringContaining('真实作者') });
    expect(native.drafts).toEqual([]);
  });

  it('卡片原生617业务失败即使有正ID也不能判sent', async () => {
    const native = createNativeSendRuntime({ businessCode: 617 });
    const result = await new BridgeMessageOps(native.cdp).sendAppMessage({ title: '测试拒绝', content: '不伪造成功' }, { targetSessionId: '93001' });
    expect(result).toMatchObject({ status: 'failed', isPreTrigger: false, error: expect.stringContaining('617') });
  });

  it('卡片显式传入 replyTo 或 mentions 时触发前失败并写入操作状态', async () => {
    const native = createSuccessfulNativeRuntime();
    const store = new InMemorySendOperationStore();
    const operations = new BridgeMessageOps(native.cdp, store);

    const mentionsResult = await operations.sendUrlCard(
      { title: '链接', summary: '摘要', linkUrl: 'https://example.com' },
      {
        targetSessionId: String(session.id),
        operationId: 'op-card-mentions',
        mentions: [{ uid: 91002, name: '员工甲' }],
      }
    );
    const replyResult = await operations.sendAppMessage(
      { title: '应用', content: '<p>正文</p>' },
      {
        targetSessionId: String(session.id),
        operationId: 'op-card-reply',
        replyTo: 'native-message-1',
      }
    );

    expect(mentionsResult).toMatchObject({ status: 'failed', isPreTrigger: true });
    expect(mentionsResult.error).toContain('mentions');
    expect(replyResult).toMatchObject({ status: 'failed', isPreTrigger: true });
    expect(replyResult.error).toContain('replyTo');
    expect(await store.get('op-card-mentions')).toMatchObject({
      status: 'failed',
      isPreTrigger: true,
    });
    expect(await store.get('op-card-reply')).toMatchObject({
      status: 'failed',
      isPreTrigger: true,
    });
    expect(native.ipc.sent).toHaveLength(0);
  });

  it('卡片触发后响应丢失保持 unknown，重放不再次触发 native 发送', async () => {
    vi.useFakeTimers();
    const store = new InMemorySendOperationStore();
    const ipc = new FakeIpcRenderer(request => {
      if (request.args[0] === 'getMemberDetail')
        return { code: 0, data: { id: 91001, name: '我' } };
      if (request.args[0] === 'getSessionBySessionID') return { code: 0, data: session };
      if (request.args[0] === 'insertSendBefoeMsg') {
        return { code: 0, data: { id: -22, msgIdx: 12 } };
      }
      if (request.args[0] === 'sendMessageNew') return NO_IPC_RESPONSE;
      if (request.args[0] === 'getMessages') return { code: 0, data: [] };
      return { code: 1 };
    });
    const runtime = createRendererRuntime({ ipc, sessions: [session] });
    const cdp = {
      evaluate: vi.fn((script: string) => runRendererScript(script, runtime.context)),
    } as unknown as CdpClient;
    const operations = new BridgeMessageOps(cdp, store);
    const input = { title: '未知结果', content: '发送动作已触发', bizType: 1 as const, bizUrl: '/' };
    const options = {
      targetSessionId: String(session.id),
      operationId: 'op-card-unknown',
    };

    const pending = operations.sendBizMessage(input, options);
    await Promise.resolve();
    await vi.runAllTimersAsync();
    const first = await pending;
    const replay = await operations.sendBizMessage(input, options);

    expect(first).toMatchObject({
      status: 'unknown',
      isPreTrigger: false,
    });
    expect(replay).toMatchObject({
      status: 'unknown',
      isPreTrigger: false,
    });
    expect(await store.get(options.operationId)).toMatchObject({ status: 'unknown' });
    expect(ipc.sent.filter(request => request.args[0] === 'insertSendBefoeMsg')).toHaveLength(1);
    expect(ipc.sent.filter(request => request.args[0] === 'sendMessageNew')).toHaveLength(1);
  });

  it('语音准备失败属于 claim 后的 pre-trigger failed，且不会访问 native IPC', async () => {
    const native = createSuccessfulNativeRuntime();
    const store = new InMemorySendOperationStore();
    vi.mocked(prepareVoice).mockRejectedValue(new Error('TTS 服务不可用'));

    const result = await new BridgeMessageOps(native.cdp, store).sendVoice(
      { text: '合成失败' },
      { targetSessionId: String(session.id), operationId: 'op-voice-prepare-failed' }
    );

    expect(result).toMatchObject({
      operationId: 'op-voice-prepare-failed',
      status: 'failed',
      isPreTrigger: true,
      error: expect.stringContaining('TTS 服务不可用'),
    });
    expect(await store.get('op-voice-prepare-failed')).toMatchObject({
      status: 'failed',
      isPreTrigger: true,
    });
    expect(native.ipc.sent).toHaveLength(0);
  });

  it('同一语音 operationId 重放直接复用 sent，不重复准备音频', async () => {
    const native = createSuccessfulNativeRuntime();
    vi.mocked(prepareVoice).mockResolvedValue({ duration: 2, data: 'IyFBTVIK' });
    const operations = new BridgeMessageOps(native.cdp, new InMemorySendOperationStore());
    const input = { text: '只合成一次' } as const;
    const options = { targetSessionId: String(session.id), operationId: 'op-voice-deduplicate' };

    const first = await operations.sendVoice(input, options);
    const replay = await operations.sendVoice(input, options);

    expect(first).toMatchObject({ status: 'sent', messageId: '135700000' });
    expect(replay).toEqual(first);
    expect(prepareVoice).toHaveBeenCalledOnce();
    expect(
      native.ipc.sent.filter(request => request.args[0] === 'insertSendBefoeMsg')
    ).toHaveLength(1);
  });

  it('明确原生目标在语音准备前绑定，窗口变化不改投', async () => {
    const native = createSuccessfulNativeRuntime();
    const other = {
      ...session,
      id: 700001,
      sesUUID: '0-9999',
      typeID: 9999,
      name: '另一会话',
      typeName: '另一会话',
    };
    native.runtime.editor.sortedSessions.push(other);
    vi.mocked(prepareVoice).mockImplementation(() => {
      native.runtime.editor.activedSes = other;
      return Promise.resolve({ duration: 1, data: 'IyFBTVIK' });
    });

    const result = await new BridgeMessageOps(native.cdp).sendVoice(
      { text: '只发给指定目标' },
      { targetSessionId: String(session.id) }
    );

    expect(result).toMatchObject({ status: 'sent', messageId: '135700000' });
    expect(native.sent[0]?.['sessionID']).toBe(session.id);
    expect(native.runtime.events[0]?.event).toBe(`${session.sesUUID}-msg`);
  });

  it('直接 Bridge 无 operationId 且无当前会话时不准备音频并明确触发前失败', async () => {
    const native = createSuccessfulNativeRuntime();
    native.runtime.editor.activedSes = null;
    vi.mocked(prepareVoice).mockResolvedValue({ duration: 1, data: 'IyFBTVIK' });

    const result = await new BridgeMessageOps(native.cdp).sendVoice({ text: '没有发送目标' });

    expect(result).toMatchObject({
      status: 'failed',
      isPreTrigger: true,
      error: expect.stringContaining('原生会话ID'),
    });
    expect(prepareVoice).not.toHaveBeenCalled();
    expect(native.ipc.sent).toHaveLength(0);
  });

  it('跳过缺失或无效的消息 ID，只确认正式正整数 ID', async () => {
    const native = createSuccessfulNativeRuntime();
    const operationId = 'op-invalid-native-id';
    const msgFlag = createNativeMessageKey('url-card', operationId);
    native.confirmed.push({ msgFlag }, { msgFlag, id: 'invalid' }, { msgFlag, id: -22 });
    const result = await new BridgeMessageOps(native.cdp).sendUrlCard(
      { title: '正式 ID', summary: '等待服务端确认', linkUrl: 'https://example.com' },
      { targetSessionId: String(session.id), operationId }
    );
    expect(result).toMatchObject({ status: 'sent', messageId: '135700000' });
  });


  it('不支持的语音选项在调用 TTS 前失败', async () => {
    const native = createSuccessfulNativeRuntime();
    const result = await new BridgeMessageOps(native.cdp).sendVoice(
      { text: '不应上传到语音服务' },
      { targetSessionId: String(session.id), mentions: [{ uid: 91002, name: '员工甲' }] }
    );
    expect(result).toMatchObject({ status: 'failed', isPreTrigger: true });
    expect(prepareVoice).not.toHaveBeenCalled();
    expect(native.ipc.sent).toHaveLength(0);
  });
});

describe('原生媒体历史规范化', () => {
  it('按 KK9 contentType 映射五类公开 messageType 与可读摘要', () => {
    const cases = [
      {
        contentType: 10,
        content: { title: '链接标题', summary: '链接摘要' },
        messageType: 'url-card',
        summary: '链接标题\n链接摘要',
      },
      {
        contentType: 17,
        content: { title: '业务标题', content: '业务正文' },
        messageType: 'biz-message',
        summary: '业务标题\n业务正文',
      },
      {
        contentType: 8,
        content: { title: '应用标题', content: '<p>应用正文</p>' },
        messageType: 'app-message',
        summary: '应用标题\n<p>应用正文</p>',
      },
      {
        contentType: 15,
        content: { senderName: '原生作者', typeName: '原生对端', sessionType: 0, msgArray: [] },
        messageType: 'chat-record',
        summary: '原生作者与原生对端的聊天记录',
      },
      {
        contentType: 2,
        content: { duration: 3, data: 'IyFBTVIK', filepath: 'C:\\KK9\\voice.wav' },
        messageType: 'voice',
        summary: '[语音: 3秒]',
      },
    ] as const;

    const messages = cases.map(
      (testCase, index) =>
        normalizeNativeMessage({
          id: `native-media-${index}`,
          sessionId: session.sesUUID,
          sessionName: session.name,
          sessionType: 'private',
          sender: '我',
          isFromSelf: true,
          contentType: testCase.contentType,
          content: testCase.content,
        })[0]
    );

    expect(messages.map(message => message?.messageType)).toEqual(
      cases.map(testCase => testCase.messageType)
    );
    expect(messages.map(message => message?.content)).toEqual(
      cases.map(testCase => testCase.summary)
    );
    expect(messages[4]?.fileInfo).toBeUndefined();
  });
});

describe('KK9Driver 原生媒体固定目标', () => {
  it('共享结构化发送的快捷撤回固定调用时目标', async () => {
    const native = createSuccessfulNativeRuntime();
    vi.mocked(prepareVoice).mockResolvedValue({ duration: 1, data: 'IyFBTVIK' });
    const driver = new KK9Driver({ cdp: { url: 'http://127.0.0.1:1', pageMatch: '离线' } });
    getDriverTestInternals(driver).bridgeMessageOps = new BridgeMessageOps(native.cdp);
    const options = { targetSessionId: String(session.id) };
    const pending = Promise.all([
      driver.sendUrlCard(
        { title: '链接', summary: '摘要', linkUrl: 'https://example.com' },
        options
      ),
      driver.sendBizMessage({ title: '业务', content: '正文', bizType: 1, bizUrl: '/' }, options),
      driver.sendAppMessage({ title: '应用', content: '<p>正文</p>' }, options),
      driver.sendVoice({ filePath: 'C:\\tmp\\voice.wav' }, options),
    ]);
    options.targetSessionId = '700001';
    const results = await pending;
    expect(results.map(result => result.status)).toEqual(['sent', 'sent', 'sent', 'sent']);
    for (const result of results) {
      expect(result.receipt).toMatchObject({ sessionId: String(session.id), messageId: result.messageId });
      if (!result.recall) throw new Error('已确认发送缺少快捷撤回');
      await expect(result.recall()).resolves.toBe(true);
    }
    expect(native.confirmed.map(message => message['msgFlag'])).toEqual(['C', 'C', 'C', 'C']);
  });

  it('明确目标在语音准备前绑定，窗口变化不改投', async () => {
    const native = createSuccessfulNativeRuntime();
    const other = {
      ...session,
      id: 700001,
      sesUUID: '0-9999',
      typeID: 9999,
      name: '另一会话',
      typeName: '另一会话',
    };
    native.runtime.editor.sortedSessions.push(other);
    const driver = new KK9Driver({
      cdp: { url: 'http://127.0.0.1:9222', pageMatch: 'renderer.html' },
    });
    const internals = getDriverTestInternals(driver);
    internals.cdp = native.cdp;
    internals.bridgeMessageOps = new BridgeMessageOps(native.cdp);
    internals.bridgeSessionOps.getSessions = vi.fn().mockResolvedValue([
      {
        id: String(session.id),
        name: session.name,
        type: 'private',
        nativeType: 0,
        receiverId: String(session.typeID),
        unread: false,
      },
      {
        id: String(other.id),
        name: other.name,
        type: 'private',
        nativeType: 0,
        receiverId: String(other.typeID),
        unread: false,
      },
    ]);
    vi.mocked(prepareVoice).mockImplementation(() => {
      native.runtime.editor.activedSes = other;
      return Promise.resolve({ duration: 1, data: 'IyFBTVIK' });
    });
    const result = await driver.sendVoice(
      { text: '只发给指定目标' },
      { targetSessionId: String(session.id) }
    );
    expect(result.status).toBe('sent');
    expect(native.sent[0]?.['sessionID']).toBe(session.id);
    expect(result.receipt).toMatchObject({ sessionId: String(session.id), messageId: result.messageId });
  });
});

describe('原生图片准备与提交', () => {
  const source = fs.readFileSync(new URL('./fixtures/t07-image.png', import.meta.url));
  const thumbnail = fs.readFileSync(new URL('./fixtures/t07-thumb.png', import.meta.url));
  const directories: string[] = [];

  afterEach(() => {
    for (const directory of directories.splice(0))
      fs.rmSync(directory, { recursive: true, force: true });
  });

  function imageRuntime(
    config: {
      code?: number;
      businessCode?: number;
      callback?: boolean;
      sendDelayMs?: number;
      preparation?: '缺失原图' | '损坏缩略图' | '尺寸错误缩略图' | '原生失败';
    } = {}
  ) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kairo-t07-'));
    directories.push(directory);
    const file = path.join(directory, '实际PNG.jpg');
    fs.writeFileSync(file, source);
    const thumbPath = path.join(directory, 'thumb');
    const artworkPath = path.join(directory, 'artwork');
    const native = createNativeSendRuntime({
      ...config,
      prepareImage: (thumb, original) => {
        if (config.preparation === '原生失败') return { code: 627, error: '图片准备拒绝' };
        if (config.preparation === '尺寸错误缩略图') {
          fs.copyFileSync(original, thumbPath);
        } else {
          fs.writeFileSync(
            thumbPath,
            config.preparation === '损坏缩略图'
              ? '损坏图片'
              : Buffer.from(thumb.replace('data:image/png;base64,', ''), 'base64')
          );
        }
        if (config.preparation !== '缺失原图') fs.copyFileSync(original, artworkPath);
        return { code: 0, data: { thumbPath, artworkPath } };
      },
    });
    // Electron是外部运行时边界；固定素材的真实解码结果由KK9生成，发送脚本实际执行。
    const resized = vi.fn(() => ({ toPNG: () => thumbnail }));
    native.window['require'] = (name: string) => {
      if (name === 'fs') return fs;
      if (name === 'file-type')
        return (bytes: Buffer) =>
          bytes.subarray(0, 8).equals(source.subarray(0, 8)) ? { mime: 'image/png' } : undefined;
      if (name === 'electron')
        return {
          nativeImage: {
            createFromBuffer: (bytes: Buffer) => ({
              isEmpty: () => !bytes.equals(source) && !bytes.equals(thumbnail),
              getSize: () =>
                bytes.equals(source) ? { width: 640, height: 360 } : { width: 300, height: 168 },
              resize: resized,
            }),
          },
        };
      throw new Error('未声明的原生依赖 ' + name);
    };
    return {
      ...native,
      file,
      resized,
      thumbPath,
      artworkPath,
      ops: new BridgeMessageOps(native.cdp),
    };
  }

  it('真实解码尺寸和格式入草稿，缩略图独立缩小，重复及查询不再准备', async () => {
    const native = imageRuntime();
    const options = { targetSessionId: '93001', operationId: 't07-image' };
    const result = await native.ops.sendImage(native.file, options);
    expect(native.drafts[0]?.['content']).toMatchObject({
      content: [
        {
          type: 1,
          width: 640,
          height: 360,
          size: source.length,
          mimetype: 'image/png',
          filepath: native.thumbPath,
          filepath_h: native.artworkPath,
        },
      ],
    });
    expect(native.resized).toHaveBeenCalledWith({ width: 300, height: 168, quality: 'best' });
    expect(fs.readFileSync(native.thumbPath)).toEqual(thumbnail);
    expect(fs.readFileSync(native.artworkPath)).toEqual(source);
    await native.ops.sendImage(native.file, options);
    await native.ops.getSendStatus(options.operationId);
    expect(native.resized).toHaveBeenCalledTimes(1);
    expect(native.drafts).toHaveLength(1);
    expect(result.receipt?.draftId).toBe('-1');
  });

  it('有PNG头但无法解码的损坏图片不准备或提交', async () => {
    const native = imageRuntime();
    fs.writeFileSync(native.file, source.subarray(0, 32));
    const result = await native.ops.sendImage(native.file, { targetSessionId: '93001' });
    expect(result).toMatchObject({ status: 'failed', isPreTrigger: true });
    expect(result.error).toContain('解码');
    expect(native.ipc.sent.filter(request => request.args[0] === 'sendingImgBeforeHandle')).toEqual(
      []
    );
    expect(native.drafts).toEqual([]);
  });

  it('不存在、目录、超过20MB及非图片各在提交前失败', async () => {
    const native = imageRuntime();
    const options = { targetSessionId: '93001' };
    fs.unlinkSync(native.file);
    expect(await native.ops.sendImage(native.file, options)).toMatchObject({
      status: 'failed',
      isPreTrigger: true,
      error: expect.stringContaining('ENOENT'),
    });
    expect(await native.ops.sendImage(path.dirname(native.file), options)).toMatchObject({
      status: 'failed',
      isPreTrigger: true,
      error: expect.stringContaining('非普通文件'),
    });
    fs.writeFileSync(native.file, '');
    fs.truncateSync(native.file, 20 * 1024 * 1024 + 1);
    expect(await native.ops.sendImage(native.file, options)).toMatchObject({
      status: 'failed',
      isPreTrigger: true,
      error: expect.stringContaining('20MB'),
    });
    fs.writeFileSync(native.file, '不是图片');
    expect(await native.ops.sendImage(native.file, options)).toMatchObject({
      status: 'failed',
      isPreTrigger: true,
      error: expect.stringContaining('不支持的图片格式'),
    });
    expect(native.drafts).toEqual([]);
  });

  it('实际读取错误保留路径和EIO，不提交图片', async () => {
    const native = imageRuntime();
    const read = vi.spyOn(fs, 'readFileSync').mockImplementation(() => {
      throw new Error('EIO: 图片读取失败');
    });
    try {
      const result = await native.ops.sendImage(native.file, { targetSessionId: '93001' });
      expect(result).toMatchObject({ status: 'failed', isPreTrigger: true });
      expect(result.error).toContain(native.file);
      expect(result.error).toContain('EIO');
      expect(native.drafts).toEqual([]);
    } finally {
      read.mockRestore();
    }
  });

  it('原生准备等待期间取消，不在迟到准备结果后提交', async () => {
    const native = imageRuntime();
    const send = native.ipc.send.bind(native.ipc);
    let prepared!: () => void;
    const started = new Promise<void>(resolve => {
      prepared = resolve;
    });
    let release!: () => void;
    native.ipc.send = (channel, request) => {
      if (request.args[0] === 'sendingImgBeforeHandle') {
        release = () => send(channel, request);
        prepared();
      } else send(channel, request);
    };
    const pending = native.ops.sendImage(native.file, { targetSessionId: '93001' });
    await started;
    await native.ops.cancelPendingSends();
    release();
    expect(await pending).toMatchObject({ status: 'failed', isPreTrigger: true });
    expect(native.drafts).toEqual([]);
    expect(native.window['__kairo_pending_sends']).toHaveProperty('size', 0);
  });

  it.each(['缺失原图', '损坏缩略图', '原生失败'] as const)(
    '%s不能凭返回路径继续正式提交',
    async preparation => {
      const native = imageRuntime({ preparation });
      const result = await native.ops.sendImage(native.file, { targetSessionId: '93001' });
      expect(result).toMatchObject({ status: 'failed', isPreTrigger: true });
      expect(result.error).toContain(
        preparation === '缺失原图'
          ? native.artworkPath
          : preparation === '损坏缩略图'
            ? native.thumbPath
            : '627'
      );
      expect(native.drafts).toEqual([]);
    }
  );

  it('可解码但尺寸错误的缩略图在创建草稿前失败', async () => {
    const native = imageRuntime({ preparation: '尺寸错误缩略图' });
    const result = await native.ops.sendImage(native.file, { targetSessionId: '93001' });
    expect(result).toMatchObject({ status: 'failed', isPreTrigger: true });
    expect(result.error).toContain('缩略图生成结果不符');
    expect(result.error).toContain(native.thumbPath);
    expect(native.drafts).toEqual([]);
  });

  it.each([
    { code: -9, expected: -9 },
    { code: 0, businessCode: 617, expected: 617 },
  ])('图片上传/业务错误$expected保留失败，重复操作不重新准备', async config => {
    const native = imageRuntime(config);
    const options = { targetSessionId: '93001', operationId: 't07-image-failure' };
    const result = await native.ops.sendImage(native.file, options);
    expect(result).toMatchObject({
      status: 'failed',
      nativeCode: config.expected,
      isPreTrigger: false,
    });
    expect(await native.ops.sendImage(native.file, options)).toEqual(result);
    expect(await native.ops.getSendStatus(options.operationId)).toEqual(result);
    expect(native.resized).toHaveBeenCalledTimes(1);
    expect(native.drafts).toHaveLength(1);
  });

  it('图片业务等待可超过四秒；无回执的unknown不重新准备或提交', async () => {
    vi.useFakeTimers();
    const native = imageRuntime({ sendDelayMs: 4500 });
    const pending = native.ops.sendImage(native.file, {
      targetSessionId: '93001',
      verifyTimeoutMs: 6000,
    });
    await vi.advanceTimersByTimeAsync(4500);
    expect(await pending).toMatchObject({ status: 'sent' });
    const unknown = imageRuntime({ callback: false });
    const options = {
      targetSessionId: '93001',
      operationId: 't07-image-unknown',
      verifyTimeoutMs: 100,
    };
    const waiting = unknown.ops.sendImage(unknown.file, options);
    await vi.advanceTimersByTimeAsync(101);
    expect(await waiting).toMatchObject({ status: 'unknown', isPreTrigger: false });
    expect(await unknown.ops.sendImage(unknown.file, options)).toMatchObject({ status: 'unknown' });
    expect(await unknown.ops.getSendStatus(options.operationId)).toMatchObject({
      status: 'unknown',
    });
    expect(unknown.resized).toHaveBeenCalledTimes(1);
    expect(unknown.drafts).toHaveLength(1);
  });
});
