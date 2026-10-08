import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CdpClient } from '../src/cdp/client.js';
import { BridgeMessageOps } from '../src/bridge/message-ops.js';
import {
  createRendererRuntime,
  FakeIpcRenderer,
  runRendererScript,
} from './helpers/renderer-runtime.js';
import { createNativeSendRuntime } from './helpers/native-send-runtime.js';
import { createNativeMessageKey } from '../src/bridge/send-status.js';

describe('BridgeMessageOps 原生消息操作', () => {
  afterEach(() => vi.useRealTimers());
  it('中文、长操作ID与含C/c的操作ID均稳定关联，不与撤回标记冲突', () => {
    for (const operationId of ['中文任务/'.repeat(100), 'a'.repeat(64), 'task-complete-001']) {
      const key = createNativeMessageKey('text', operationId);
      expect(Buffer.byteLength(key)).toBeLessThanOrEqual(64);
      expect(key).not.toMatch(/[Cc]/);
      expect(createNativeMessageKey('text', ' ' + operationId + ' ')).toBe(key);
      expect(createNativeMessageKey('text', operationId + '甲')).not.toBe(key);
    }
  });
  describe('指定原生会话读取历史', () => {
    const session = {
      id: '93001',
      name: '员工甲',
      type: 'private' as const,
      nativeType: 0,
      receiverId: '91002',
      unread: false,
    };
    function historyOps(data: unknown, code = 0, activeWindow = false) {
      const ipc = new FakeIpcRenderer(request => {
        const query = request.args[1] as { sessionID: number; count: number; endIdx: number };
        if (request.args[0] !== 'getMessages') throw new Error('历史只能调用 getMessages');
        return query.sessionID === 93001 && query.count === 10 && query.endIdx === 2147483647
          ? { code, data, error: code ? '原生历史查询失败' : undefined }
          : { code: 0, data: [{ id: 9999, sessionID: 93002, sender: 91003, content: '其他会话' }] };
      });
      const context = activeWindow
        ? createRendererRuntime({ ipc, sessions: [{ id: 93002, sesUUID: '0-91003', type: 0 }] })
            .context
        : { window: { ipcRenderer: ipc }, setTimeout, clearTimeout };
      return new BridgeMessageOps({
        evaluate: (script: string) => runRendererScript(script, context),
      } as unknown as CdpClient);
    }

    it.each([false, true])(
      '聊天组件存在=%s，仍按明确原生会话读取且区分消息 ID 与索引',
      async activeWindow => {
        const data = [
          {
            id: 1001,
            msgIdx: 9,
            sessionID: 93001,
            sender: 91002,
            senderName: '员工甲',
            contentType: 4,
            content: { content: [{ type: 0, text: '历史正文' }] },
            sendTime: 1788142780,
          },
        ];
        const messages = await historyOps(data, 0, activeWindow).getRecentMessages(
          session,
          10,
          undefined,
          91001
        );
        expect(messages).toMatchObject([
          {
            id: '1001',
            messageId: '1001',
            msgIdx: 9,
            sessionId: '93001',
            sessionName: '员工甲',
            sessionType: 'private',
            content: '历史正文',
            direction: 'inbound',
          },
        ]);
      }
    );

    it.each(['C', 'D', 'C原生后缀', 'D原生后缀'])(
      '历史保留%s已撤回原消息的正文、类型、ID和索引',
      async msgFlag => {
        const data = [
          {
            id: 1001,
            msgIdx: 9,
            sessionID: 93001,
            sender: 91002,
            contentType: 4,
            content: '原文本',
            msgFlag,
          },
          {
            id: 1002,
            msgIdx: 10,
            sessionID: 93001,
            sender: 91002,
            contentType: 1,
            content: {},
            msgFlag,
          },
          {
            id: 1003,
            msgIdx: 11,
            sessionID: 93001,
            sender: 91002,
            contentType: 3,
            content: { filename: '原附件.txt' },
            msgFlag,
          },
        ];
        const messages = await historyOps(data).getRecentMessages(session, 10, undefined, 91001);
        expect(messages).toMatchObject([
          {
            id: '1001',
            msgIdx: 9,
            sessionId: '93001',
            content: '原文本',
            messageType: 'text',
            isRecalled: true,
            direction: 'inbound',
          },
          { id: '1002', msgIdx: 10, messageType: 'image', isRecalled: true },
          { id: '1003', msgIdx: 11, messageType: 'file', isRecalled: true },
        ]);
      }
    );

    it('历史保留普通系统通知与撤回通知自身身份，不把通知当已撤回原消息', async () => {
      const data = [
        {
          id: 1004,
          msgIdx: 12,
          sessionID: 93001,
          contentType: 6,
          content: { event: 'MemberJoin', msgID: 1001 },
        },
        {
          id: 1005,
          msgIdx: 13,
          sessionID: 93001,
          contentType: 6,
          content: JSON.stringify({ event: 'CancelMessage', msgID: 1001 }),
        },
      ];
      const messages = await historyOps(data).getRecentMessages(session, 10);
      expect(messages).toMatchObject([
        {
          id: '1004',
          msgIdx: 12,
          sessionId: '93001',
          messageType: 'system',
          origin: 'system',
          direction: 'unknown',
          isRecalled: false,
        },
        {
          id: '1005',
          msgIdx: 13,
          sessionId: '93001',
          messageType: 'system',
          origin: 'system',
          direction: 'unknown',
          isRecalled: false,
        },
      ]);
    });

    it('原生缺页不猜测补页，空页与失败可区分', async () => {
      const page = [
        { id: 1001, msgIdx: 5, sessionID: 93001, sender: 91002, content: '前一条' },
        { id: 1002, msgIdx: 9, sessionID: 93001, sender: 91002, content: '后一条' },
      ];
      expect(
        (await historyOps(page).getRecentMessages(session, 10)).map(message => message.msgIdx)
      ).toEqual([5, 9]);
      await expect(historyOps([]).getRecentMessages(session, 10)).resolves.toEqual([]);
      await expect(historyOps([], 627).getRecentMessages(session, 10)).rejects.toThrow(
        /getMessages.*93001.*627.*原生历史查询失败/
      );
      await expect(historyOps(null).getRecentMessages(session, 10)).rejects.toThrow(
        /getMessages.*数组/
      );
    });

    it('缺少明确会话或传入界面标识时拒绝，不改读当前窗口', async () => {
      const ops = historyOps([]);
      await expect(
        ops.getRecentMessages(undefined as unknown as typeof session, 10)
      ).rejects.toThrow(/会话/);
      await expect(ops.getRecentMessages({ ...session, id: '0-91002' }, 10)).rejects.toThrow(
        /原生会话/
      );
    });
  });
  describe('recallMessage 消息撤回', () => {
    it('通过 IPC cancelMessage 撤回目标消息并派发 revokeMsg', async () => {
      const mockCdp = {
        evaluate: vi.fn().mockResolvedValue({ success: true }),
      } as unknown as CdpClient;

      const ops = new BridgeMessageOps(mockCdp);
      const ok = await ops.recallMessage('1002', '0-91002');

      expect(ok).toBe(true);
      expect(mockCdp.evaluate).toHaveBeenCalledOnce();
    });

    it('撤回目标会话必须让 sesUUID/id 命中优先于更早出现的同名会话', async () => {
      const targetSessionId = '1-92001';
      const ipc = new FakeIpcRenderer(() => ({ code: 0 }));
      const runtime = createRendererRuntime({
        ipc,
        sessions: [
          { id: 7, sesUUID: 'shadow', typeName: targetSessionId, name: targetSessionId, type: 1 },
          { id: 8, sesUUID: targetSessionId, typeName: '真实目标', name: '真实目标', type: 1 },
        ],
        messages: [{ id: 123, msgIdx: 8, sessionID: 8 }],
      });
      const mockCdp = {
        evaluate: vi.fn((script: string) => runRendererScript(script, runtime.context)),
      } as unknown as CdpClient;

      const ok = await new BridgeMessageOps(mockCdp).recallMessage('123', targetSessionId);
      const cancelRequest = ipc.sent.find(request => request.args[0] === 'cancelMessage');

      expect(ok).toBe(true);
      expect(cancelRequest?.args[1]).toMatchObject({ sessionID: 8, msgID: 123 });
    });

    it('目标 123 不得被可见消息 23 子串劫持', async () => {
      const ipc = new FakeIpcRenderer(() => ({ code: 0 }));
      const runtime = createRendererRuntime({
        ipc,
        sessions: [
          { id: 93001, sesUUID: '0-91002', typeName: 'test-employee', type: 0, typeID: 91002 },
        ],
        messages: [{ id: 23, msgIdx: 7, sessionID: 93001 }],
      });
      const mockCdp = {
        evaluate: vi.fn((script: string) => runRendererScript(script, runtime.context)),
      } as unknown as CdpClient;

      const ok = await new BridgeMessageOps(mockCdp).recallMessage('123', '0-91002');
      const cancelRequest = ipc.sent.find(request => request.args[0] === 'cancelMessage');

      expect(ok).toBe(true);
      expect(cancelRequest?.args[1]).toMatchObject({
        sessionID: 93001,
        msgID: 123,
      });
    });

    it('native 撤回未返回成功 ack 时不得仅靠本地事件宣称成功', async () => {
      const ipc = new FakeIpcRenderer(() => ({}));
      const runtime = createRendererRuntime({
        ipc,
        sessions: [
          { id: 93001, sesUUID: '0-91002', typeName: 'test-employee', type: 0, typeID: 91002 },
        ],
        messages: [{ id: 123, msgIdx: 8, sessionID: 93001 }],
      });
      const mockCdp = {
        evaluate: vi.fn((script: string) => runRendererScript(script, runtime.context)),
      } as unknown as CdpClient;

      const ok = await new BridgeMessageOps(mockCdp).recallMessage('123', '0-91002');

      expect(ok).toBe(false);
      expect(runtime.events).toHaveLength(0);
    });

    it('Bridge 撤回 ipc.send 抛错后必须移除本次 listener', async () => {
      const ipc = new FakeIpcRenderer(() => {
        throw new Error('recall send failed');
      });
      const runtime = createRendererRuntime({
        ipc,
        sessions: [
          { id: 93001, sesUUID: '0-91002', typeName: 'test-employee', type: 0, typeID: 91002 },
        ],
        messages: [{ id: 123, msgIdx: 8, sessionID: 93001 }],
      });
      const mockCdp = {
        evaluate: vi.fn((script: string) => runRendererScript(script, runtime.context)),
      } as unknown as CdpClient;

      const ok = await new BridgeMessageOps(mockCdp).recallMessage('123', '0-91002');
      const request = ipc.sent[0];

      expect(ok).toBe(false);
      expect(request).toBeDefined();
      expect(ipc.listenerCount(`data-${request?.id}`)).toBe(0);
    });

    it('缺少 ipcRenderer 时不得以 bus-only 撤回作为成功', async () => {
      const runtime = createRendererRuntime({
        sessions: [
          { id: 93001, sesUUID: '0-91002', typeName: 'test-employee', type: 0, typeID: 91002 },
        ],
        messages: [{ id: 123, msgIdx: 8, sessionID: 93001 }],
      });
      const mockCdp = {
        evaluate: vi.fn((script: string) => runRendererScript(script, runtime.context)),
      } as unknown as CdpClient;

      const ok = await new BridgeMessageOps(mockCdp).recallMessage('123', '0-91002');

      expect(ok).toBe(false);
      expect(runtime.events).toHaveLength(0);
    });
  });
  it.each([false, true])('私聊创建方向=%s，原生会话ID不与UID或同名会话混淆', async reversed => {
    const native = createNativeSendRuntime();
    native.sessions[0]!.typeID = reversed ? 91001 : 91002;
    native.sessions[0]!.creater = reversed ? 91002 : 91001;
    native.sessions.push({ id: 91002, type: 0, typeID: 91003, creater: 91001, typeName: '93001' });
    const result = await new BridgeMessageOps(native.cdp).sendText('精确目标', {
      targetSessionId: '93001',
    });
    expect(result).toMatchObject({ status: 'sent', messageId: '135700000' });
    expect(native.records).toMatchObject([{ sessionID: 93001, receiver: 91002, sender: 91001 }]);
  });
  it('插入code0但缺少负草稿保持unknown，不提交也不靠历史改判', async () => {
    const native = createNativeSendRuntime({ insertWithoutData: true });
    const ops = new BridgeMessageOps(native.cdp);
    const result = await ops.sendText('无草稿', {
      targetSessionId: '93001',
      operationId: 'op-draft',
    });
    expect(result).toMatchObject({ status: 'unknown', isPreTrigger: false });
    expect((await ops.getSendStatus('op-draft')).status).toBe('unknown');
    expect(native.records).toEqual([]);
  });
  it('空白操作ID在原生查询前拒绝', async () => {
    const native = createNativeSendRuntime();
    await expect(
      new BridgeMessageOps(native.cdp).sendText('拒绝', {
        targetSessionId: '93001',
        operationId: ' ',
      })
    ).rejects.toThrow();
    expect(native.ipc.sent).toEqual([]);
  });
  it('查询不存在操作不访问发送接口', async () => {
    const native = createNativeSendRuntime();
    expect(await new BridgeMessageOps(native.cdp).getSendStatus('missing')).toEqual({
      operationId: 'missing',
      status: 'unknown',
      isPreTrigger: false,
    });
    expect(native.ipc.sent).toEqual([]);
  });
  it.each([true, false])(
    '引用提供索引=%s，精确取得窗口外原消息而非当前窗口记录',
    async withIndex => {
      const native = createNativeSendRuntime();
      native.records.push(
        ...Array.from({ length: 250 }, (_, i) => ({
          id: 1000 + i,
          msgIdx: i + 1,
          sessionID: 93001,
          sender: 91002,
          contentType: 4,
          content: JSON.stringify({ content: [{ type: 0, text: '历史' + i }] }),
        }))
      );
      const result = await new BridgeMessageOps(native.cdp).sendReply(
        { messageId: '1000', ...(withIndex ? { msgIdx: 1 } : {}) },
        '引用旧记录',
        { targetSessionId: '93001' }
      );
      expect(result.status).toBe('sent');
      expect(native.drafts[0]?.['content']).toMatchObject({
        replyedMsgId: 1000,
        replyedMsgIndex: 1,
        replyedContent: { content: [{ type: 0, text: '历史0' }] },
      });
    }
  );
  it('并发发送不会让两次原生请求或正式消息身份互相覆盖', async () => {
    const native = createNativeSendRuntime();
    const ops = new BridgeMessageOps(native.cdp);
    const results = await Promise.all(
      ['甲', '乙'].map(text => ops.sendText(text, { targetSessionId: '93001' }))
    );
    expect(results.map(result => result.status)).toEqual(['sent', 'sent']);
    expect(new Set(results.map(result => result.messageId)).size).toBe(2);
    const ids = native.ipc.sent.map(request => request.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(native.records.map(record => record['content'])).toEqual(
      expect.arrayContaining([
        { content: [{ type: 0, text: '甲' }], font: expect.anything() },
        { content: [{ type: 0, text: '乙' }], font: expect.anything() },
      ])
    );
  });
  it.each([0, 627])('图片保留尺寸与资源准备，业务码%s决定结果', async code => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kairo-t03-img-'));
    const file = path.join(dir, '图片.png');
    fs.writeFileSync(
      file,
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
        'base64'
      )
    );
    try {
      const native = createNativeSendRuntime({ code });
      native.context['document'] = { querySelector: () => null };
      const result = await new BridgeMessageOps(native.cdp).sendImage(file, {
        targetSessionId: '93001',
      });
      expect(result.status).toBe(code === 0 ? 'sent' : 'failed');
      expect(native.drafts[0]?.['content']).toMatchObject({
        content: [{ type: 1, width: 1, height: 1, filepath: '原生缩略图', filepath_h: '原生原图' }],
      });
      if (code !== 0) expect(result.nativeCode).toBe(code);
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });
});
