import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CdpClient } from '../src/cdp/client.js';
import { DEFAULT_SELECTORS } from '../src/dom/selectors.js';
import { SendOps } from '../src/dom/send-ops.js';
import { BridgeMessageOps } from '../src/bridge/message-ops.js';
import { runRendererScript } from './helpers/renderer-runtime.js';
import { createNativeSendRuntime } from './helpers/native-send-runtime.js';

// 尚未切换的UI预检保留；已替代的输入框/按钮发送断言改为实际原生行为。
describe('未切换的窗口预检', () => {
  describe('checkPreSendState 会话身份校验', () => {
    const runCheck = async (
      target: string,
      activeId: string,
      activeTitle: string,
      scrollerItems: Array<Record<string, unknown>>
    ) => {
      const activeItem = {
        querySelector: () => ({ textContent: activeTitle }),
        getAttribute: (name: string) =>
          name === 'data-sesuuid' || name === 'data-session-id' || name === 'id' ? activeId : null,
      };
      const document = {
        querySelector(selector: string): unknown {
          if (selector.includes('.chat-item.chat-selected')) return activeItem;
          if (selector.includes('.vue-recycle-scroller')) {
            return { __vue__: { items: scrollerItems } };
          }
          if (selector.includes('.chat-header') || selector.includes('.head-title')) {
            return { textContent: activeTitle };
          }
          return null;
        },
      };
      const mockCdp = {
        evaluate: vi.fn((script: string) => runRendererScript(script, { document })),
      } as unknown as CdpClient;

      return new SendOps(mockCdp, DEFAULT_SELECTORS).checkPreSendState(target);
    };

    it('重名会话无法唯一解析时必须 Fail-Closed', async () => {
      const result = await runCheck('重复会话', '7', '重复会话', [
        { id: 7, sesUUID: 'first', typeName: '重复会话', name: '重复会话' },
        { id: 8, sesUUID: 'second', typeName: '重复会话', name: '重复会话' },
      ]);

      expect(result.canSend).toBe(false);
    });

    it('真实 ID 被更早会话名称遮蔽时不得放行错误 active 会话', async () => {
      const result = await runCheck('1-92001', '7', '1-92001', [
        { id: 7, sesUUID: 'shadow', typeName: '1-92001', name: '1-92001' },
        { id: 8, sesUUID: '1-92001', typeName: '真实目标', name: '真实目标' },
      ]);

      expect(result.canSend).toBe(false);
    });

    it('唯一 ID 命中且 active ID 一致时允许发送', async () => {
      const result = await runCheck('1-92001', '1-92001', '真实目标', [
        { id: 8, sesUUID: '1-92001', typeName: '真实目标', name: '真实目标' },
      ]);

      expect(result.canSend).toBe(true);
    });
  });
});

describe('原生发送保留的内容准备与失败边界', () => {
  afterEach(() => vi.useRealTimers());
  it.each(['text', 'rich-text', 'reply'])('空%s内容不触发草稿', async kind => {
    const native = createNativeSendRuntime();
    const ops = new BridgeMessageOps(native.cdp);
    const options = { targetSessionId: '93001' };
    const result =
      kind === 'text'
        ? await ops.sendText(' ', options)
        : kind === 'rich-text'
          ? await ops.sendRichText('', options)
          : await ops.sendReply('10', ' ', options);
    expect(result).toMatchObject({ status: 'failed', isPreTrigger: true });
    expect(result.error).toContain('不能为空');
    expect(native.drafts).toEqual([]);
  });
  it('富文本与群提及内容准备保持可用，业务回执确认正式ID', async () => {
    const native = createNativeSendRuntime();
    const result = await new BridgeMessageOps(native.cdp).sendRichText(
      [{ text: '提醒', style: { bold: true } }, { text: '完成' }],
      { targetSessionId: '93002', mentions: ['all'] }
    );
    expect(result).toMatchObject({ status: 'sent', messageId: '135700000' });
    expect(native.records[0]?.['content']).toMatchObject({
      content: [
        { type: 2, replyMemberType: 1, replyMemberName: '全体成员' },
        { type: 0, text: ' ' },
        { type: 0, text: '提醒完成' },
      ],
    });
  });
  it('引用只按指定会话正式消息ID查找，未找到不会退成普通文本', async () => {
    const native = createNativeSendRuntime();
    const ops = new BridgeMessageOps(native.cdp);
    const failed = await ops.sendReply('999', '回复', { targetSessionId: '93001' });
    expect(failed).toMatchObject({ status: 'failed', isPreTrigger: true });
    expect(native.drafts).toEqual([]);
    native.records.push({
      id: 999,
      msgIdx: 8,
      sessionID: 93001,
      sender: 91002,
      senderName: '员工甲',
      contentType: 4,
      content: { content: [{ type: 0, text: '原消息' }] },
    });
    const result = await ops.sendText('回复', { targetSessionId: '93001', replyTo: '999' });
    expect(result.status).toBe('sent');
    expect(native.records[1]?.['content']).toMatchObject({
      type: 'Reply',
      replyedMsgId: 999,
      replyedMsgIndex: 8,
      replyedID: 91002,
      replyContent: { content: [{ type: 0, text: '回复' }] },
    });
  });
  it.each(['不存在', '目录'])('文件%s在提交前明确失败', async kind => {
    const native = createNativeSendRuntime();
    const result = await new BridgeMessageOps(native.cdp).sendFile(
      kind === '目录' ? '.' : '不存在的原生测试文件.txt',
      { targetSessionId: '93001' }
    );
    expect(result).toMatchObject({ status: 'failed', isPreTrigger: true });
    expect(native.drafts).toEqual([]);
  });
  it.each([0, -9])('文件业务码%s独立于外层code0分类', async code => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kairo-t03-file-'));
    const file = path.join(directory, '附件.txt');
    fs.writeFileSync(file, '文件协议回归');
    try {
      const native = createNativeSendRuntime({ code });
      const result = await new BridgeMessageOps(native.cdp).sendFile(file, {
        targetSessionId: '93001',
      });
      expect(result.status).toBe(code === 0 ? 'sent' : 'failed');
      expect(native.drafts[0]?.['content']).toMatchObject({
        type: 'File',
        filename: '附件.txt',
        filepath: file,
        size: String(fs.statSync(file).size),
      });
      if (code !== 0) expect(result.nativeCode).toBe(code);
    } finally {
      fs.rmSync(directory, { recursive: true });
    }
  });
  it('发送前已失联是failed，不能读取窗口或触发原生草稿', async () => {
    const native = createNativeSendRuntime();
    native.disconnect();
    const result = await new BridgeMessageOps(native.cdp).sendText('未触发', {
      targetSessionId: '93001',
    });
    expect(result).toMatchObject({ status: 'failed', isPreTrigger: true });
    expect(native.ipc.sent).toEqual([]);
  });
});
