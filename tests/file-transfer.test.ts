import * as fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  copyRemoteFileToLocal,
  createRemoteTempFile,
  releaseRemoteFile,
  REMOTE_FILE_LEASE_SCRIPT,
  uploadLocalFile,
} from '../src/bridge/file-transfer.js';
import { RENDERER_IPC_HELPERS_SCRIPT } from '../src/bridge/renderer-script.js';
import { createRemoteFilesystem } from './helpers/remote-filesystem.js';

const cleanups: Array<() => void> = [];
function setup() {
  const remote = createRemoteFilesystem();
  const local = fs.mkdtempSync(path.join(os.tmpdir(), 'kairo-local-test-'));
  cleanups.push(() => {
    remote.dispose();
    fs.rmSync(local, { recursive: true, force: true });
  });
  return { remote, local };
}
const bytes = () =>
  Buffer.from(Array.from({ length: 256 * 1024 * 2 + 417 }, (_, index) => index % 256));
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  for (const cleanup of cleanups.splice(0)) cleanup();
});

describe('跨机器实际文件分块传输', () => {
  it('Windows远端与Driver不同根，三块二进制往返且保留原名', async () => {
    const { remote, local } = setup();
    const source = path.join(local, '原始 附件.bin');
    const payload = bytes();
    fs.writeFileSync(source, payload);
    const file = await uploadLocalFile(remote.cdp, source, 100 * 1024 * 1024);
    expect(file.name).toBe('原始 附件.bin');
    expect(path.win32.basename(file.path)).toBe(file.name);
    expect(file.path.startsWith(remote.remoteRoot)).toBe(true);
    expect(fs.readFileSync(remote.toLocal(file.path))).toEqual(payload);
    const target = path.join(local, '接收.bin');
    expect(await copyRemoteFileToLocal(remote.cdp, file.path, target)).toBe(target);
    expect(fs.readFileSync(target)).toEqual(payload);
    expect(remote.timeouts.every(timeout => timeout === 10000)).toBe(true);
    expect(remote.scripts.every(script => script.length < 400000)).toBe(true);
    await releaseRemoteFile(remote.cdp, file);
    expect(fs.existsSync(remote.toLocal(file.path))).toBe(false);
    expect(remote.handles.size).toBe(0);
  });

  it('远端短写和短读仍完整传输，每次请求关闭描述符', async () => {
    const { remote, local } = setup();
    remote.controls.writeLimit = 701;
    remote.controls.readLimit = 997;
    const source = path.join(local, '短读写.bin');
    fs.writeFileSync(source, bytes());
    const file = await uploadLocalFile(remote.cdp, source, 1000000);
    const target = path.join(local, '结果.bin');
    await copyRemoteFileToLocal(remote.cdp, file.path, target);
    expect(fs.readFileSync(target)).toEqual(bytes());
    expect(remote.handles.size).toBe(0);
    await releaseRemoteFile(remote.cdp, file);
  });

  it('Driver短读与短写也按实际进度完成全部字节', async () => {
    const { remote, local } = setup();
    const open = fsp.open;
    vi.spyOn(fsp, 'open').mockImplementation(async (...args: Parameters<typeof fsp.open>) => {
      const handle = await open(...args);
      const read = handle.read.bind(handle);
      const write = handle.write.bind(handle);
      Object.defineProperty(handle, 'read', {
        value: (buffer: Buffer, offset: number, length: number, position: number) =>
          read(buffer, offset, Math.min(length, 1103), position),
      });
      Object.defineProperty(handle, 'write', {
        value: (buffer: Buffer, offset: number, length: number, position: number) =>
          write(buffer, offset, Math.min(length, 1301), position),
      });
      return handle;
    });
    const source = path.join(local, '宿主短读.bin');
    fs.writeFileSync(source, bytes());
    const file = await uploadLocalFile(remote.cdp, source, 1000000);
    const target = path.join(local, '宿主短写.bin');
    await copyRemoteFileToLocal(remote.cdp, file.path, target);
    expect(fs.readFileSync(target)).toEqual(bytes());
    await releaseRemoteFile(remote.cdp, file);
  });

  it('空普通文件可往返，非空和大小限制显式失败', async () => {
    const { remote, local } = setup();
    const source = path.join(local, '空.txt');
    fs.writeFileSync(source, '');
    const file = await uploadLocalFile(remote.cdp, source, 0);
    const target = path.join(local, '目标.txt');
    await copyRemoteFileToLocal(remote.cdp, file.path, target);
    expect(fs.statSync(target).size).toBe(0);
    await expect(
      copyRemoteFileToLocal(remote.cdp, file.path, target, { nonEmpty: true })
    ).rejects.toThrow(/空/);
    fs.writeFileSync(source, bytes());
    await expect(uploadLocalFile(remote.cdp, source, 20)).rejects.toThrow(/限制/);
    await releaseRemoteFile(remote.cdp, file);
  });

  it('独占目录不互相删除，非法Windows文件名明确拒绝', async () => {
    const { remote } = setup();
    const first = await createRemoteTempFile(remote.cdp, '原名.txt');
    const second = await createRemoteTempFile(remote.cdp, '原名.txt');
    expect(path.win32.dirname(first.path)).not.toBe(path.win32.dirname(second.path));
    await releaseRemoteFile(remote.cdp, first);
    expect(fs.existsSync(remote.toLocal(second.path))).toBe(true);
    await expect(createRemoteTempFile(remote.cdp, '非法:名称.txt')).rejects.toThrow(/文件名/);
    await expect(createRemoteTempFile(remote.cdp, 'CON.txt')).rejects.toThrow(/文件名/);
    await releaseRemoteFile(remote.cdp, second);
  });

  it('未进入渲染任务的临时文件60秒清理，分块读取刷新空闲期限', async () => {
    vi.useFakeTimers();
    const { remote, local } = setup();
    const file = await createRemoteTempFile(remote.cdp, '空闲.bin');
    fs.writeFileSync(remote.toLocal(file.path), bytes());
    await vi.advanceTimersByTimeAsync(59000);
    await copyRemoteFileToLocal(remote.cdp, file.path, path.join(local, '完整.bin'));
    await vi.advanceTimersByTimeAsync(59000);
    expect(fs.existsSync(remote.toLocal(file.path))).toBe(true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(fs.existsSync(remote.toLocal(file.path))).toBe(false);
  });

  it('上传中断清理本次目录；丢失创建响应仍能按宿主id清理', async () => {
    const { remote, local } = setup();
    const source = path.join(local, '失败.bin');
    fs.writeFileSync(source, bytes());
    remote.controls.failWriteAfter = 1;
    await expect(uploadLocalFile(remote.cdp, source, 1000000)).rejects.toThrow(/写入失败/);
    expect(fs.readdirSync(remote.root)).toEqual([]);
    const evaluate = remote.cdp.evaluate.bind(remote.cdp);
    let loseResponse = true;
    vi.spyOn(remote.cdp, 'evaluate').mockImplementation(
      async <T>(script: string, timeout?: number) => {
        const result = await evaluate<T>(script, timeout);
        if (loseResponse) {
          loseResponse = false;
          throw new Error('创建响应丢失');
        }
        return result;
      }
    );
    await expect(createRemoteTempFile(remote.cdp, '丢响应.txt')).rejects.toThrow(/创建响应丢失/);
    expect(fs.readdirSync(remote.root)).toEqual([]);
  });

  it('上传已写第一块后取消，清理远端独占目录并关闭Driver源文件', async () => {
    const { remote, local } = setup();
    const source = path.join(local, '上传取消.bin');
    fs.writeFileSync(source, bytes());
    let closed = false;
    const open = fsp.open;
    vi.spyOn(fsp, 'open').mockImplementation(async (...args: Parameters<typeof fsp.open>) => {
      const handle = await open(...args);
      const close = handle.close.bind(handle);
      Object.defineProperty(handle, 'close', {
        value: async () => {
          await close();
          closed = true;
        },
      });
      return handle;
    });
    const controller = new AbortController();
    const evaluate = remote.cdp.evaluate.bind(remote.cdp);
    vi.spyOn(remote.cdp, 'evaluate').mockImplementation(
      async <T>(script: string, timeout?: number) => {
        const result = await evaluate<T>(script, timeout);
        if (remote.controls.writes > 0) controller.abort('上传取消');
        return result;
      }
    );
    await expect(uploadLocalFile(remote.cdp, source, 1000000, controller.signal)).rejects.toThrow(
      /取消/
    );
    expect(remote.controls.writes).toBe(1);
    expect(fs.readdirSync(remote.root)).toEqual([]);
    expect(remote.handles.size).toBe(0);
    expect(closed).toBe(true);
  });

  it('下载中途失败或取消不发布part，不覆盖完整目标也不删原生缓存', async () => {
    const { remote, local } = setup();
    const cache = path.win32.join(remote.remoteRoot, '原生缓存.bin');
    fs.writeFileSync(remote.toLocal(cache), bytes());
    const target = path.join(local, '目标.bin');
    fs.writeFileSync(target, '原完整目标');
    await expect(
      copyRemoteFileToLocal(remote.cdp, cache, target, { maxBytes: 20 })
    ).rejects.toThrow(/限制/);
    remote.controls.failReadAfter = 1;
    await expect(copyRemoteFileToLocal(remote.cdp, cache, target)).rejects.toThrow(/读取失败/);
    expect(fs.readFileSync(target, 'utf8')).toBe('原完整目标');
    expect(fs.readdirSync(local)).toEqual(['目标.bin']);
    remote.controls.failReadAfter = Infinity;
    remote.controls.reads = 0;
    const controller = new AbortController();
    const evaluate = remote.cdp.evaluate.bind(remote.cdp);
    let partialBytes = 0;
    vi.spyOn(remote.cdp, 'evaluate').mockImplementation(
      async <T>(script: string, timeout?: number) => {
        const result = await evaluate<T>(script, timeout);
        if (remote.controls.reads === 2) {
          const partial = fs.readdirSync(local).find(name => name.endsWith('.part'));
          partialBytes = partial ? fs.statSync(path.join(local, partial)).size : 0;
          controller.abort('已取消');
        }
        return result;
      }
    );
    await expect(
      copyRemoteFileToLocal(remote.cdp, cache, target, { signal: controller.signal })
    ).rejects.toThrow(/取消/);
    expect(partialBytes).toBe(256 * 1024);
    expect(fs.readFileSync(target, 'utf8')).toBe('原完整目标');
    expect(fs.readdirSync(local)).toEqual(['目标.bin']);
    expect(fs.readFileSync(remote.toLocal(cache))).toEqual(bytes());
    expect(remote.handles.size).toBe(0);
  });

  it('宿主磁盘写失败不伪成功且保留原完整目标', async () => {
    const { remote, local } = setup();
    const cache = path.win32.join(remote.remoteRoot, '缓存.bin');
    fs.writeFileSync(remote.toLocal(cache), bytes());
    const target = path.join(local, '目标.bin');
    fs.writeFileSync(target, '完整');
    const open = fsp.open;
    vi.spyOn(fsp, 'open').mockImplementation(async (...args: Parameters<typeof fsp.open>) => {
      const handle = await open(...args);
      if (String(args[0]).endsWith('.part'))
        vi.spyOn(handle, 'write').mockRejectedValue(new Error('宿主磁盘满'));
      return handle;
    });
    await expect(copyRemoteFileToLocal(remote.cdp, cache, target)).rejects.toThrow(/宿主磁盘满/);
    expect(fs.readFileSync(target, 'utf8')).toBe('完整');
    expect(fs.readdirSync(local)).toEqual(['目标.bin']);
  });
});

describe('原生文件读取租约', () => {
  it.each(['timeout', 'abort', 'sendThrow'] as const)(
    '%s之后保留真实监听和文件，原生迟到完成后删除',
    async mode => {
      const { remote } = setup();
      const file = await createRemoteTempFile(remote.cdp, '原生仍在读.bin');
      const ipc = new EventEmitter() as EventEmitter & {
        send: (channel: string, request: { id: number }) => void;
      };
      let requestId = 0;
      ipc.send = (_channel, request) => {
        requestId = request.id;
        if (mode === 'sendThrow') throw new Error('send异常但无法证明原生未开始');
      };
      const controller = new AbortController();
      remote.context.ipc = ipc;
      remote.context.controller = controller;
      const pending = remote.evaluate<{ code: number }>(`(async () => {
      ${RENDERER_IPC_HELPERS_SCRIPT}
      ${REMOTE_FILE_LEASE_SCRIPT}
      const lease = takeKairoFileLease(${JSON.stringify(file.id)});
      try { return await callKairoFileIpc(lease, 5, controller.signal, 'sendMessageNew', { filePath: lease.path }); }
      finally { lease.release(); }
    })()`);
      if (mode === 'abort') controller.abort('取消发送');
      expect((await pending).code).toBe(mode === 'timeout' ? -2 : mode === 'abort' ? -4 : -3);
      await releaseRemoteFile(remote.cdp, file);
      expect(fs.existsSync(remote.toLocal(file.path))).toBe(true);
      expect(ipc.listenerCount('data-' + requestId)).toBe(1);
      ipc.emit('data-' + requestId, undefined, { code: 0 });
      expect(ipc.listenerCount('data-' + requestId)).toBe(0);
      expect(fs.existsSync(remote.toLocal(file.path))).toBe(false);
    }
  );

  it('宿主请求释放时所有holder释放之前保留独占目录', async () => {
    const { remote } = setup();
    const file = await createRemoteTempFile(remote.cdp, '双租约.bin');
    await remote.evaluate(`(() => {
      ${REMOTE_FILE_LEASE_SCRIPT}
      window.first = takeKairoFileLease(${JSON.stringify(file.id)});
      window.second = takeKairoFileLease(${JSON.stringify(file.id)});
    })()`);
    await releaseRemoteFile(remote.cdp, file);
    await remote.evaluate('window.first.release()');
    expect(fs.existsSync(remote.toLocal(file.path))).toBe(true);
    await remote.evaluate('window.second.release()');
    expect(fs.existsSync(remote.toLocal(file.path))).toBe(false);
    await remote.evaluate('window.second.release()');
  });

  it('清理失败立即暴露，不删除Map上下文，后续可重试', async () => {
    const { remote } = setup();
    const file = await createRemoteTempFile(remote.cdp, '清理.bin');
    remote.controls.failRemove = true;
    await expect(releaseRemoteFile(remote.cdp, file)).rejects.toThrow(/清理失败/);
    expect(fs.existsSync(remote.toLocal(file.path))).toBe(true);
    remote.controls.failRemove = false;
    await releaseRemoteFile(remote.cdp, file);
    expect(fs.existsSync(remote.toLocal(file.path))).toBe(false);
  });
});
