import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BridgeMessageOps } from '../src/bridge/message-ops.js';
import { createNativeSendRuntime } from './helpers/native-send-runtime.js';


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
  it.each([
    { code: -9, businessCode: undefined, expected: -9, label: '上传失败' },
    { code: 0, businessCode: 617, expected: 617, label: '正ID业务禁发' },
  ])('文件$label不能被外层code0或正ID判为sent', async ({ code, businessCode, expected }) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kairo-t06-file-'));
    const file = path.join(directory, '附件.txt');
    fs.writeFileSync(file, '文件协议回归');
    try {
      const native = createNativeSendRuntime({ code, businessCode });
      const ops = new BridgeMessageOps(native.cdp);
      const options = { targetSessionId: '93001', operationId: 't06-file-failure' };
      const result = await ops.sendFile(file, options);
      expect(result).toMatchObject({
        status: 'failed', nativeCode: expected, isPreTrigger: false,
        receipt: { draftId: '-1', sessionId: '93001', code },
      });
      expect(result.error).toContain(String(expected));
      expect(await ops.sendFile(file, options)).toEqual(result);
      expect(await ops.getSendStatus(options.operationId)).toEqual(result);
      expect(native.ipc.sent.filter(request => request.args[0] === 'sendMessageNew')).toHaveLength(1);
    } finally {
      fs.rmSync(directory, { recursive: true });
    }
  });
  it('文件实际读取失败保留本地错误，不登记原生草稿或提交', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kairo-t06-read-'));
    const file = path.join(directory, '不可读.txt');
    fs.writeFileSync(file, '本地读取边界');
    const native = createNativeSendRuntime();
    const ops = new BridgeMessageOps(native.cdp);
    const read = vi.spyOn(fs, 'readSync').mockImplementation(() => {
      throw Object.assign(new Error('EIO: 本地文件读取失败'), { code: 'EIO' });
    });
    try {
      const result = await ops.sendFile(file, {
        targetSessionId: '93001', operationId: 't06-read-error',
      });
      expect(result).toMatchObject({ status: 'failed', isPreTrigger: true });
      expect(result.error).toContain(file);
      expect(result.error).toContain('EIO');
      expect(await ops.getSendStatus('t06-read-error')).toEqual(result);
      expect(native.ipc.sent).toEqual([]);
    } finally {
      read.mockRestore();
      fs.rmSync(directory, { recursive: true });
    }
  });
  it('文件超过现有100MB限制时不进入原生发送', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kairo-t06-size-'));
    const file = path.join(directory, '超限.txt');
    fs.writeFileSync(file, '');
    fs.truncateSync(file, 100 * 1024 * 1024 + 1);
    try {
      const native = createNativeSendRuntime();
      const result = await new BridgeMessageOps(native.cdp).sendFile(file, { targetSessionId: '93001' });
      expect(result).toMatchObject({ status: 'failed', isPreTrigger: true, error: '文件大小超出限制(100MB)' });
      expect(native.ipc.sent).toEqual([]);
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
