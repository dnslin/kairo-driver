import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import fsp from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { KK9Driver } from '../src/driver.js';
import { getDriverTestInternals } from './helpers/driver-internals.js';
import { setDriverLogSink, type DriverLogEntry } from '../src/utils/logger.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BridgeMessageOps } from '../src/bridge/message-ops.js';
import { createNativeSendRuntime } from './helpers/native-send-runtime.js';

const require = createRequire(import.meta.url);
const roots: string[] = [];
function directory(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

function remoteRuntime() {
  const remoteRoot = directory('kairo-remote-send-');
  const sourceRoot = directory('kairo-driver-source-');
  const native = createNativeSendRuntime();
  native.window['require'] = (name: string) => {
    if (name === 'os') return { ...os, tmpdir: () => remoteRoot };
    if (name === 'electron') return { ipcRenderer: native.ipc };
    return require(name) as unknown;
  };
  const file = path.join(sourceRoot, '中文附件.bin');
  const bytes = Buffer.alloc(256 * 1024 * 2 + 19);
  for (let index = 0; index < bytes.length; index++) bytes[index] = index % 251;
  fs.writeFileSync(file, bytes);
  return { ...native, remoteRoot, sourceRoot, file, bytes, ops: new BridgeMessageOps(native.cdp) };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('跨机器普通文件发送', () => {
  it('从 Driver 本地读多分块内容，KK 使用独立临时路径且原文件名不变', async () => {
    const runtime = remoteRuntime();
    let sentPath = '';
    let sentBytes: Buffer | undefined;
    const send = runtime.ipc.send.bind(runtime.ipc);
    runtime.ipc.send = (channel, request) => {
      if (request.args[0] === 'sendMessageNew') {
        const message = request.args[1] as { content: { filepath: string } };
        sentPath = message.content.filepath;
        sentBytes = fs.readFileSync(sentPath);
      }
      send(channel, request);
    };
    const options = { targetSessionId: '93001', operationId: 'remote-file-bytes' };
    const result = await runtime.ops.sendFile(runtime.file, options);
    expect(result.status).toBe('sent');
    expect(sentPath).not.toBe(runtime.file);
    expect(path.relative(runtime.remoteRoot, sentPath)).not.toMatch(/^\.\./);
    expect(sentBytes).toEqual(runtime.bytes);
    expect(runtime.drafts[0]?.['content']).toMatchObject({
      filename: '中文附件.bin',
      size: String(runtime.bytes.length),
    });
    expect(fs.existsSync(sentPath)).toBe(false);
    expect(fs.readFileSync(runtime.file)).toEqual(runtime.bytes);
    expect(await runtime.ops.sendFile(runtime.file, options)).toEqual(result);
    expect(runtime.records).toHaveLength(1);
  });

  it('公开文件发送成功后清理失败仍告警，重复操作与状态查询不重发', async () => {
    const runtime = remoteRuntime();
    const logs: DriverLogEntry[] = [];
    const nativeFs = { ...fs, rmSync: () => {
      throw Object.assign(new Error('测试远端删除失败'), { code: 'EPERM' });
    } };
    const requireNative = runtime.window['require'] as (name: string) => unknown;
    runtime.window['require'] = (name: string) => name === 'fs' ? nativeFs : requireNative(name);
    const driver = new KK9Driver({ cdp: { url: 'http://127.0.0.1:1' } });
    getDriverTestInternals(driver).bridgeMessageOps = runtime.ops;
    const options = { targetSessionId: '93001', operationId: 'cleanup-failure-file' };
    setDriverLogSink(entry => logs.push(entry));
    try {
      const result = await driver.sendFile(runtime.file, options);
      expect(result.status).toBe('sent');
      expect(logs).toContainEqual(expect.objectContaining({
        level: 'warn', event: 'Driver运行异常', errorType: 'driver', runId: expect.any(String),
      }));
      expect(await driver.sendFile(runtime.file, options)).toMatchObject({ status: 'sent', messageId: result.messageId });
      expect(await driver.getSendStatus(options.operationId)).toMatchObject({ status: 'sent', messageId: result.messageId });
      expect(runtime.records).toHaveLength(1);
      expect(runtime.drafts).toHaveLength(1);
      expect(fs.readdirSync(runtime.remoteRoot)).toHaveLength(1);
    } finally { setDriverLogSink(undefined); }
  });

  it.runIf(process.platform === 'linux')('Linux无写端FIFO及时前置失败，断开不等待写端', async () => {
    const runtime = remoteRuntime();
    const fifo = path.join(runtime.sourceRoot, '命名管道.png');
    execFileSync('mkfifo', [fifo]);
    const opening = new EventEmitter();
    const started = once(opening, 'opening');
    const open = fsp.open;
    vi.spyOn(fsp, 'open').mockImplementation((...args: Parameters<typeof fsp.open>) => {
      if (args[0] === fifo) opening.emit('opening');
      return open(...args);
    });
    const driver = new KK9Driver({ cdp: { url: 'http://127.0.0.1:1' } });
    getDriverTestInternals(driver).bridgeMessageOps = runtime.ops;
    let settled = false;
    const pending = driver.sendImage(fifo, { targetSessionId: '93001' }).finally(() => { settled = true; });
    await Promise.race([started, pending]);
    const disconnect = driver.disconnect();
    const deadline = new AbortController();
    try {
      const [result] = await Promise.race([
        Promise.all([pending, disconnect]),
        delay(2000, undefined, { signal: deadline.signal }).then((): never => { throw new Error('FIFO发送或断开仍在等待写端'); }),
      ]);
      expect(result).toMatchObject({ status: 'failed', isPreTrigger: true });
      expect(runtime.drafts).toEqual([]);
      expect(runtime.records).toEqual([]);
      expect(fs.readdirSync(runtime.remoteRoot)).toEqual([]);
    } finally {
      deadline.abort();
      if (!settled) {
        const writer = fs.openSync(fifo, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK);
        fs.closeSync(writer);
      }
      await pending;
      await disconnect;
      opening.removeAllListeners();
    }
  });

  it.each(['超时', '取消'] as const)(
    '%s等待不能删除 KK 尚未读取的临时文件，迟到完成后释放且不重发',
    async mode => {
      vi.useFakeTimers();
      const runtime = remoteRuntime();
      let sentPath = '';
      let release!: () => void;
      let ready!: () => void;
      const started = new Promise<void>(resolve => {
        ready = resolve;
      });
      let sentBytes: Buffer | undefined;
      const send = runtime.ipc.send.bind(runtime.ipc);
      runtime.ipc.send = (channel, request) => {
        if (request.args[0] !== 'sendMessageNew') {
          send(channel, request);
          return;
        }
        const message = request.args[1] as { content: { filepath: string } };
        sentPath = message.content.filepath;
        release = () => {
          sentBytes = fs.readFileSync(sentPath);
          send(channel, request);
        };
        ready();
      };
      const options = {
        targetSessionId: '93001',
        operationId: `remote-file-${mode}`,
        verifyTimeoutMs: 100,
      };
      const pending = runtime.ops.sendFile(runtime.file, options);
      await started;
      if (mode === '取消') await runtime.ops.cancelPendingSends();
      else await vi.advanceTimersByTimeAsync(101);
      const result = await pending;
      expect(result).toMatchObject({ status: 'unknown', isPreTrigger: false });
      expect(sentPath).not.toBe(runtime.file);
      expect(fs.existsSync(sentPath)).toBe(true);
      expect(await runtime.ops.sendFile(runtime.file, options)).toMatchObject({
        status: 'unknown',
      });
      expect(runtime.records).toEqual([]);
      release();
      await Promise.resolve();
      await Promise.resolve();
      expect(sentBytes).toEqual(runtime.bytes);
      expect(fs.existsSync(sentPath)).toBe(false);
      expect(runtime.records).toHaveLength(1);
      expect(runtime.ipc.listenerCount('0-91002-sendMsgCallback')).toBe(0);
    }
  );

  it('首块已传输时取消，清理本轮临时文件且不触发原生发送', async () => {
    const runtime = remoteRuntime();
    let ready!: () => void;
    let release!: () => void;
    const started = new Promise<void>(resolve => {
      ready = resolve;
    });
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const evaluate = runtime.cdp.evaluate.bind(runtime.cdp);
    let requests = 0;
    runtime.cdp.evaluate = async <T>(script: string, timeout?: number): Promise<T> => {
      const result = await evaluate<T>(script, timeout);
      if (++requests === 2) {
        ready();
        await gate;
      }
      return result;
    };
    const pending = runtime.ops.sendFile(runtime.file, { targetSessionId: '93001' });
    await started;
    const cancellation = runtime.ops.cancelPendingSends();
    release();
    await cancellation;
    expect(await pending).toMatchObject({ status: 'failed', isPreTrigger: true });
    expect(runtime.drafts).toEqual([]);
    expect(runtime.records).toEqual([]);
    expect(fs.readdirSync(runtime.remoteRoot)).toEqual([]);
    expect(fs.readFileSync(runtime.file)).toEqual(runtime.bytes);
  });

  it('分块传输失败必须是前置失败，不产生草稿或原生发送', async () => {
    const runtime = remoteRuntime();
    const evaluate = runtime.cdp.evaluate.bind(runtime.cdp);
    let completed = 0;
    runtime.cdp.evaluate = async <T>(script: string, timeout?: number): Promise<T> => {
      completed++;
      if (completed === 3) throw new Error('测试中的 CDP 分块中断');
      return evaluate<T>(script, timeout);
    };
    const result = await runtime.ops.sendFile(runtime.file, { targetSessionId: '93001' });
    expect(result).toMatchObject({ status: 'failed', isPreTrigger: true });
    expect(result.error).toContain('CDP 分块中断');
    expect(runtime.drafts).toEqual([]);
    expect(runtime.records).toEqual([]);
    expect(fs.readdirSync(runtime.remoteRoot)).toEqual([]);
  });
});
