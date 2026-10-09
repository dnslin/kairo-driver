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
import { InMemorySendOperationStore, type SendOperationStore } from '../src/send-operation.js';
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
  it('真实执行 renderer 脚本并序列化五类 payload，确认后推送同一 confirmedMessage', async () => {
    const native = createSuccessfulNativeRuntime();
    vi.mocked(prepareVoice).mockResolvedValue({
      duration: 3,
      data: 'IyFBTVIK',
      filepath: 'C:\\tmp\\voice.amr',
    });
    const operations = new BridgeMessageOps(native.cdp, new InMemorySendOperationStore());

    const results = [
      await operations.sendUrlCard(
        { title: '部署报告', summary: '构建成功', linkUrl: 'https://example.com/report' },
        { targetSessionId: String(session.id), operationId: 'op-url-card' }
      ),
      await operations.sendBizMessage(
        { title: '任务完成', content: '审批已完成', summary: ['状态: 完成'] },
        { targetSessionId: String(session.id), operationId: 'op-biz-message' }
      ),
      await operations.sendAppMessage(
        { title: '应用通知', content: '<p>正文</p>', linkUrl: 'https://example.com/app' },
        { targetSessionId: String(session.id), operationId: 'op-app-message' }
      ),
      await operations.sendChatRecord(
        {
          title: '甲与乙的聊天记录',
          msgArray: [{ senderName: '甲', contentType: 0, content: '请确认方案' }],
        },
        { targetSessionId: String(session.id), operationId: 'op-chat-record' }
      ),
      await operations.sendVoice(
        { text: '请确认语音' },
        { targetSessionId: String(session.id), operationId: 'op-voice' }
      ),
    ];
    const queried = await Promise.all(
      ['op-url-card', 'op-biz-message', 'op-app-message', 'op-chat-record', 'op-voice'].map(
        operationId => operations.getSendStatus(operationId)
      )
    );

    expect(results.map(result => result.status)).toEqual(['sent', 'sent', 'sent', 'sent', 'sent']);
    expect(queried.map(result => result.messageId)).toEqual(
      results.map(result => result.messageId)
    );
    expect(queried.every(result => result.status === 'sent')).toBe(true);
    expect(native.inserted.map(message => message['contentType'])).toEqual([10, 17, 8, 15, 2]);
    expect(native.inserted.map(message => message['msgFlag'])).toEqual([
      createNativeMessageKey('url-card', 'op-url-card'),
      createNativeMessageKey('biz-message', 'op-biz-message'),
      createNativeMessageKey('app-message', 'op-app-message'),
      createNativeMessageKey('chat-record', 'op-chat-record'),
      createNativeMessageKey('voice', 'op-voice'),
    ]);
    expect(native.sent.map(message => message['contentType'])).toEqual([10, 17, 8, 15, 2]);
    expect(native.sent.map(message => message['content'])).toEqual(
      native.inserted.map(message => message['content'])
    );
    expect(native.inserted[0]?.['content']).toEqual({
      title: '部署报告',
      summary: '构建成功',
      linkUrl: 'https://example.com/report',
      picUrl: '',
      isValid: true,
      filepath: '',
    });
    expect(native.inserted[1]?.['content']).toEqual({
      title: '任务完成',
      content: '审批已完成',
      summary: ['状态: 完成'],
      bizUrl: '',
      bizType: 1,
    });
    expect(native.inserted[2]?.['content']).toEqual({
      title: '应用通知',
      content: '<p>正文</p>',
      linkUrl: 'https://example.com/app',
      pcAppCode: '',
    });
    expect(native.inserted[3]?.['content']).toMatchObject({
      title: '甲与乙的聊天记录',
      sessionType: 0,
      sessionID: session.id,
      senderID: 91001,
      senderName: '我',
      typeID: session.typeID,
      typeName: '甲与乙的聊天记录',
      msgArray: [
        {
          id: 1,
          msgIdx: 1,
          senderID: 0,
          senderName: '甲',
          contentType: 4,
          content: { content: [{ type: 0, text: '请确认方案' }] },
          sessionType: 0,
          sessionID: session.id,
        },
      ],
    });
    expect(native.inserted[4]?.['content']).toEqual({
      duration: 3,
      data: 'IyFBTVIK',
      filepath: 'C:\\tmp\\voice.amr',
    });
    expect(prepareVoice).toHaveBeenCalledOnce();

    expect(native.runtime.commits).toHaveLength(5);
    expect(native.runtime.events).toHaveLength(5);
    native.confirmed.forEach((confirmedMessage, index) => {
      expect(native.runtime.commits[index]).toEqual({
        type: 'updateSesLastMsg',
        payload: { sesUUID: session.sesUUID, message: confirmedMessage },
      });
      expect(native.runtime.events[index]).toEqual({
        event: `${session.sesUUID}-msg`,
        args: [[confirmedMessage]],
      });
    });
  });

  it('ChatRecord 在 claim 等待期间保持调用时的嵌套内容快照，并允许原始内容安全重放', async () => {
    const native = createSuccessfulNativeRuntime();
    const innerStore = new InMemorySendOperationStore();
    let markStarted = (): void => {};
    let release = (): void => {};
    const claimStarted = new Promise<void>(resolve => {
      markStarted = resolve;
    });
    const releaseClaim = new Promise<void>(resolve => {
      release = resolve;
    });
    const store: SendOperationStore = {
      claim: vi.fn(async input => {
        markStarted();
        await releaseClaim;
        return innerStore.claim(input);
      }),
      get: operationId => innerStore.get(operationId),
      update: (operationId, update) => innerStore.update(operationId, update),
    };
    const operations = new BridgeMessageOps(native.cdp, store);
    const nestedContent = { content: [{ type: 0, text: 'A' }] };
    const options = {
      targetSessionId: String(session.id),
      operationId: 'op-chat-record-snapshot',
    };

    const pending = operations.sendChatRecord(
      {
        title: '嵌套内容快照',
        msgArray: [{ senderName: '甲', contentType: 4, content: nestedContent }],
      },
      options
    );
    await claimStarted;
    nestedContent.content[0]!.text = 'B';
    release();

    const first = await pending;
    const replay = await operations.sendChatRecord(
      {
        title: '嵌套内容快照',
        msgArray: [
          {
            senderName: '甲',
            contentType: 4,
            content: { content: [{ type: 0, text: 'A' }] },
          },
        ],
      },
      options
    );

    expect(first).toMatchObject({ status: 'sent', messageId: '135700000' });
    expect(replay).toEqual(first);
    expect(native.inserted[0]?.['content']).toMatchObject({
      msgArray: [{ content: { content: [{ type: 0, text: 'A' }] } }],
    });
    expect(
      native.ipc.sent.filter(request => request.args[0] === 'insertSendBefoeMsg')
    ).toHaveLength(1);
    expect(native.ipc.sent.filter(request => request.args[0] === 'sendMessageNew')).toHaveLength(1);
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
        mentions: ['all'],
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
    const input = { title: '未知结果', content: '发送动作已触发' };
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
    expect(native.runtime.events[0]?.args).toEqual([[native.confirmed[3]]]);
  });

  it('会话摘要更新异常不阻断已送达消息的聊天窗口推送', async () => {
    const native = createSuccessfulNativeRuntime();
    await runRendererScript(
      `(() => {
      document.querySelector('#app').__vue__.$store.commit = () => { throw new Error('摘要更新失败'); };
    })()`,
      native.runtime.context
    );
    const result = await new BridgeMessageOps(native.cdp).sendAppMessage(
      { title: '应用通知', content: '<p>已送达</p>' },
      { targetSessionId: String(session.id) }
    );
    expect(result).toMatchObject({ status: 'sent', messageId: '135700000' });
    expect(native.runtime.events[0]?.args).toEqual([[native.confirmed[0]]]);
  });

  it('不支持的语音选项在调用 TTS 前失败', async () => {
    const native = createSuccessfulNativeRuntime();
    const result = await new BridgeMessageOps(native.cdp).sendVoice(
      { text: '不应上传到语音服务' },
      { targetSessionId: String(session.id), mentions: ['all'] }
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
        content: { title: '聊天记录', msgArray: [] },
        messageType: 'chat-record',
        summary: '聊天记录',
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

describe('KK9Driver 五类原生媒体门面', () => {
  it('五类发送关联指定会话的正式ID，快捷撤回清理对应原生记录', async () => {
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
      driver.sendBizMessage({ title: '业务', content: '正文' }, options),
      driver.sendAppMessage({ title: '应用', content: '<p>正文</p>' }, options),
      driver.sendChatRecord(
        { title: '记录', msgArray: [{ senderName: '甲', contentType: 0, content: '内容' }] },
        options
      ),
      driver.sendVoice({ filePath: 'C:\\tmp\\voice.wav' }, options),
    ]);
    options.targetSessionId = '700001';
    const results = await pending;
    expect(results.map(result => result.status)).toEqual(['sent', 'sent', 'sent', 'sent', 'sent']);
    for (const result of results) {
      expect(result.receipt).toMatchObject({ sessionId: String(session.id), messageId: result.messageId });
      if (!result.recall) throw new Error('已确认发送缺少快捷撤回');
      await expect(result.recall()).resolves.toBe(true);
    }
    expect(native.confirmed.map(message => message['msgFlag'])).toEqual(['C', 'C', 'C', 'C', 'C']);
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
      preparation?: '缺失原图' | '损坏缩略图' | '原生失败';
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
        fs.writeFileSync(
          thumbPath,
          config.preparation === '损坏缩略图'
            ? '损坏图片'
            : Buffer.from(thumb.replace('data:image/png;base64,', ''), 'base64')
        );
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
