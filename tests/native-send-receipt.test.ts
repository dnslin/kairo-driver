import { EventEmitter } from 'node:events';
import { runInNewContext } from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CONFIRM_SENT_MESSAGE_SCRIPT,
  SUBMIT_NATIVE_MESSAGE_SCRIPT,
} from '../src/bridge/renderer-script.js';

// 回执形状来自 KK9 9.0.1 原版 sendMessageNew/T/A，不把外层请求完成当业务成功。
function harness(
  callback: Record<string, unknown> | null,
  options: {
    wrongDraft?: boolean;
    wrongSession?: boolean;
    delayedId?: boolean;
    sendError?: boolean;
  } = {}
) {
  const ipc = new EventEmitter();
  const channel = '0-91002-sendMsgCallback';
  const other = vi.fn();
  ipc.on(channel, other);
  const confirmed = {
    id: 42,
    msgIdx: 8,
    sessionID: 31,
    sender: 91001,
    receiver: 91002,
    msgFlag: 'k:op:receipt',
    status: 'success',
  };
  let submitted = 0;
  let historyReads = 0;
  const callIpc = (method: string) =>
    Promise.resolve().then(() => {
      if (method === 'insertSendBefoeMsg') return { code: 0, data: { id: -1, msgIdx: 7.001 } };
      if (method === 'sendMessageNew') {
        submitted++;
        if (options.wrongDraft) ipc.emit(channel, {}, { args: { msgID: -2, code: 627 } });
        if (options.wrongSession)
          ipc.emit('0-91003-sendMsgCallback', {}, { args: { msgID: -1, code: 627 } });
        if (callback)
          ipc.emit(
            channel,
            {},
            {
              args: {
                msgID: -1,
                ...callback,
                data: options.delayedId
                  ? { ...confirmed, id: undefined }
                  : (callback['data'] ?? confirmed),
              },
            }
          );
        if (options.sendError) throw new Error('提交后连接失联');
        return { code: 0 };
      }
      if (method === 'getMessages') {
        historyReads++;
        return { code: 0, data: [confirmed] };
      }
      throw new Error('未声明原生方法 ' + method);
    });
  const context = {
    window: {},
    ipc,
    callIpc,
    setTimeout,
    clearTimeout,
    message: {
      id: 0,
      content: { content: [{ type: 0, text: '受控边界' }] },
      contentType: 4,
      sender: 91001,
      receiver: 91002,
      sessionType: 0,
      sessionID: 31,
      msgFlag: confirmed.msgFlag,
    },
    session: { id: 31, type: 0, receiverId: 91002, sesUUID: '0-91002' },
  };
  const run = () =>
    runInNewContext(
      '(async()=>{' +
        CONFIRM_SENT_MESSAGE_SCRIPT +
        SUBMIT_NATIVE_MESSAGE_SCRIPT +
        '\nreturn submitNativeMessage(message,session,50);})()',
      context
    ) as Promise<Record<string, unknown>>;
  return {
    ipc,
    channel,
    other,
    confirmed,
    run,
    get submitted() {
      return submitted;
    },
    get historyReads() {
      return historyReads;
    },
  };
}

describe('原生业务回执与本次草稿关联', () => {
  afterEach(() => vi.useRealTimers());
  it('本次成功回执关联正式ID，不误接错草稿或错会话', async () => {
    const h = harness({ code: 0 }, { wrongDraft: true, wrongSession: true });
    const result = await h.run();
    expect(result).toMatchObject({
      confirmedMessage: { id: 42, sessionID: 31 },
      receipt: { draftId: '-1', code: 0, messageId: '42' },
    });
    expect(h.ipc.listenerCount(h.channel)).toBe(1);
    expect(h.other).toHaveBeenCalled();
  });
  it.each([627, -9])('外层code0但业务码%s必须failed并保留上下文', async code => {
    const h = harness({ code });
    expect(await h.run()).toMatchObject({
      failure: { status: 'failed', isPreTrigger: false, nativeCode: code },
      receipt: { draftId: '-1', code },
    });
    expect(h.historyReads).toBe(0);
    expect(h.ipc.listenerCount(h.channel)).toBe(1);
  });
  it('617即使回执code0且正式正ID也不能sent', async () => {
    const h = harness({
      code: 0,
      data: { id: 42, sessionID: 31, msgIdx: 8, ext: JSON.stringify({ status: 617 }) },
    });
    expect(await h.run()).toMatchObject({
      failure: { status: 'failed', nativeCode: 617 },
      receipt: { code: 0, businessCode: 617 },
    });
    expect(h.historyReads).toBe(0);
  });
  it('回执先于sendMessageNew请求回包仍可确认', async () => {
    const h = harness({ code: 0 });
    expect(await h.run()).toMatchObject({ confirmedMessage: { id: 42 } });
    expect(h.submitted).toBe(1);
  });
  it('只有正ID历史、没有本次回执，超时仍unknown并只清自己的监听', async () => {
    vi.useFakeTimers();
    const h = harness(null);
    const pending = h.run();
    await vi.runAllTimersAsync();
    expect(await pending).toMatchObject({ failure: { status: 'unknown', isPreTrigger: false } });
    expect(h.historyReads).toBe(0);
    expect(h.ipc.listenerCount(h.channel)).toBe(1);
  });
  it('成功回执缺正式ID时，只在已有成功证据后关联本次正式记录', async () => {
    const h = harness({ code: 0 }, { delayedId: true });
    expect(await h.run()).toMatchObject({ confirmedMessage: { id: 42 } });
    expect(h.historyReads).toBeGreaterThan(0);
  });
  it('提交后失联且无回执保持unknown，不再次提交', async () => {
    const h = harness(null, { sendError: true });
    expect(await h.run()).toMatchObject({ failure: { status: 'unknown', isPreTrigger: false } });
    expect(h.submitted).toBe(1);
    expect(h.ipc.listenerCount(h.channel)).toBe(1);
  });
});
