import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { CdpClient } from '../cdp/client.js';
import { createChildLogger } from '../utils/logger.js';

export interface RemoteFile {
  id: string;
  path: string;
  name: string;
  size: number;
}

const CHUNK_BYTES = 256 * 1024;
const REQUEST_TIMEOUT_MS = 10000;
const log = createChildLogger('file-transfer');

/**
 * 仅在KK9渲染端操作临时目录；原生实际完成之前不能删除其正在读取的文件。
 * 原生永久不回包时保留租约；客户端退出会失去Map，遗留目录不能安全自动强删。
 */
export const REMOTE_FILE_LEASE_SCRIPT = `
  function kairoFileStore() {
    return window.__kairo_file_transfers || (window.__kairo_file_transfers = new Map());
  }
  function cleanupKairoFile(entry) {
    if (!entry.releaseRequested || entry.holders || entry.readers) return;
    clearTimeout(entry.timer);
    window.require('fs').rmSync(entry.directory, { recursive: true, force: true });
    kairoFileStore().delete(entry.id);
  }
  function idleKairoFile(entry) {
    clearTimeout(entry.timer);
    if (entry.releaseRequested) { cleanupKairoFile(entry); return; }
    if (entry.holders || entry.readers) return;
    entry.timer = setTimeout(() => {
      entry.releaseRequested = true;
      try { cleanupKairoFile(entry); }
      catch (error) { console.error('Kairo远端临时文件空闲清理失败', entry.id, error); }
    }, 60000);
  }
  function requireKairoFile(id) {
    const entry = kairoFileStore().get(id);
    if (!entry || entry.releaseRequested) throw new Error('远端临时文件已释放或不存在: ' + id);
    return entry;
  }
  function touchKairoFilePath(remotePath) {
    for (const entry of kairoFileStore().values()) {
      if (entry.path === remotePath) {
        if (entry.releaseRequested) throw new Error('远端临时文件已请求释放: ' + entry.id);
        idleKairoFile(entry);
        return;
      }
    }
  }
  function takeKairoFileLease(id) {
    const entry = requireKairoFile(id);
    clearTimeout(entry.timer);
    entry.holders++;
    let released = false;
    return {
      path: entry.path, name: entry.name, size: entry.size,
      release() {
        if (released) return;
        released = true;
        entry.holders--;
        try { idleKairoFile(entry); }
        catch (error) { console.error('Kairo文件租约释放清理失败', entry.id, error); throw error; }
      },
      beginRead() {
        if (released) throw new Error('远端文件租约已经释放: ' + id);
        entry.readers++;
        let finished = false;
        return () => {
          if (finished) return;
          finished = true;
          entry.readers--;
          idleKairoFile(entry);
        };
      }
    };
  }
  function callKairoFileIpc(lease, timeoutMs, signal, channel, ...args) {
    return new Promise((resolve, reject) => {
      if (!ipc || typeof ipc.send !== 'function' || typeof ipc.once !== 'function') {
        resolve({ code: -1, error: '当前环境未找到有效的 ipcRenderer 对象: ' + channel });
        return;
      }
      if (signal?.aborted) {
        resolve({ code: -4, error: '原生文件操作已取消: ' + channel });
        return;
      }
      const requestId = nextKairoRequestId();
      const replyChannel = 'data-' + requestId;
      const context = channel + ' (requestId=' + requestId + ')';
      const endRead = lease.beginRead();
      let settled = false;
      let timer;
      const stopWaiting = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      };
      const finish = payload => {
        if (settled) return;
        settled = true;
        stopWaiting();
        resolve(payload);
      };
      const onAbort = () => finish({ code: -4, error: '原生文件操作已取消: ' + context +
        (signal?.reason ? ': ' + String(signal.reason) : '') });
      const onReply = (_event, payload) => {
        try { endRead(); }
        catch (error) {
          if (settled) console.error('Kairo原生文件完成后清理失败', context, error);
          else { settled = true; stopWaiting(); reject(error); }
          return;
        }
        finish(payload || { code: 0 });
      };
      try { ipc.once(replyChannel, onReply); }
      catch (error) {
        try { endRead(); }
        catch (cleanupError) {
          reject(new AggregateError([error, cleanupError], '原生文件监听与清理失败: ' + context));
          return;
        }
        reject(new Error('原生文件监听失败: ' + context + ': ' + String(error)));
        return;
      }
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) {
        ipc.removeListener(replyChannel, onReply);
        try { endRead(); }
        catch (error) { settled = true; stopWaiting(); reject(error); return; }
        onAbort();
        return;
      }
      timer = setTimeout(() => finish({ code: -2, error: '原生文件IPC请求超时: ' + context }), timeoutMs);
      try {
        ipc.send('data', { id: requestId, args: [channel, ...args], progress: false });
      } catch (error) {
        // send抛错不证明原生未接收；保留监听和readers，等待真实完成回包。
        finish({ code: -3, error: '原生文件ipc.send失败: ' + context + ': ' + String(error) });
      }
    });
  }
`;

function evaluateRemote<T>(cdp: CdpClient, body: string): Promise<T> {
  return cdp.evaluate<T>(`(() => { ${REMOTE_FILE_LEASE_SCRIPT}\n${body}\n})()`, REQUEST_TIMEOUT_MS);
}

function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted)
    throw new Error('文件传输已取消' + (signal.reason ? ': ' + String(signal.reason) : ''));
}

function checkSize(size: number, maxBytes?: number, nonEmpty = false): void {
  if (!Number.isSafeInteger(size) || size < 0) throw new Error('文件长度无效: ' + size);
  if (maxBytes !== undefined && (!Number.isSafeInteger(maxBytes) || maxBytes < 0)) {
    throw new Error('文件大小限制无效: ' + maxBytes);
  }
  if (maxBytes !== undefined && size > maxBytes)
    throw new Error('文件大小超过限制: ' + size + ' > ' + maxBytes);
  if (nonEmpty && size === 0) throw new Error('文件为空');
}

function checkFilename(name: string): void {
  if (
    !name ||
    name === '.' ||
    name === '..' ||
    /[<>:"/\\|?*]/.test(name) ||
    /[. ]$/.test(name) ||
    /^(CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])(?:\.|$)/i.test(name)
  ) {
    throw new Error('Windows远端不支持此文件名: ' + name);
  }
  for (let index = 0; index < name.length; index++) {
    if (name.charCodeAt(index) < 32) throw new Error('Windows远端不支持此文件名: ' + name);
  }
}

async function failWithCleanup(
  error: unknown,
  cleanups: Array<() => Promise<void>>
): Promise<never> {
  const errors = [error];
  for (const cleanup of cleanups) {
    try {
      await cleanup();
    } catch (cleanupError) {
      errors.push(cleanupError);
    }
  }
  if (errors.length > 1) {
    throw new AggregateError(errors, '文件操作与清理均失败: ' + errors.map(String).join('; '));
  }
  throw error;
}

export async function createRemoteTempFile(cdp: CdpClient, name: string): Promise<RemoteFile> {
  checkFilename(name);
  // 宿主先确定id，创建响应丢失时仍可定位清理，不猜测远端目录。
  const file: RemoteFile = { id: randomUUID(), path: '', name, size: 0 };
  try {
    return await evaluateRemote<RemoteFile>(
      cdp,
      `
      const fs = window.require('fs');
      const path = window.require('path');
      const id = ${JSON.stringify(file.id)};
      const name = ${JSON.stringify(name)};
      const directory = fs.mkdtempSync(path.join(window.require('os').tmpdir(), 'kairo-file-'));
      const entry = { id, name, directory, path: path.join(directory, name), size: 0,
        holders: 0, readers: 0, releaseRequested: false, timer: undefined };
      kairoFileStore().set(id, entry);
      idleKairoFile(entry);
      const fd = fs.openSync(entry.path, 'wx');
      fs.closeSync(fd);
      return { id, path: entry.path, name, size: 0 };
    `
    );
  } catch (error) {
    return failWithCleanup(error, [(): Promise<void> => releaseRemoteFile(cdp, file)]);
  }
}

export async function releaseRemoteFile(cdp: CdpClient, file: RemoteFile): Promise<void> {
  try {
    await evaluateRemote(
      cdp,
      `
      const entry = kairoFileStore().get(${JSON.stringify(file.id)});
      if (entry) { entry.releaseRequested = true; cleanupKairoFile(entry); }
    `
    );
  } catch (error) {
    // 清理不是发送终态；成功发送也必须经现有日志出口暴露清理异常。
    log.warn({ event: 'Driver运行异常', errorType: 'driver', runId: file.id }, '远端临时文件清理失败');
    throw error;
  }
}

export async function uploadLocalFile(
  cdp: CdpClient,
  localPath: string,
  maxBytes: number,
  signal?: AbortSignal
): Promise<RemoteFile> {
  checkAbort(signal);
  const name = path.basename(localPath);
  checkFilename(name);
  // Linux FIFO只读打开会等待写端；非阻塞打开后按描述符拒绝非普通文件。
  const source = await fs.open(
    localPath,
    process.platform === 'linux' ? constants.O_RDONLY | constants.O_NONBLOCK : 'r'
  );
  let file: RemoteFile | undefined;
  let closed = false;
  try {
    const stat = await source.stat();
    if (!stat.isFile()) throw new Error('发送附件为非普通文件: ' + localPath);
    checkSize(stat.size, maxBytes);
    checkAbort(signal);
    file = await createRemoteTempFile(cdp, name);
    const buffer = Buffer.allocUnsafe(Math.min(CHUNK_BYTES, stat.size));
    for (let position = 0; position < stat.size; ) {
      checkAbort(signal);
      const length = Math.min(buffer.length, stat.size - position);
      let read = 0;
      while (read < length) {
        checkAbort(signal);
        const result = await source.read(buffer, read, length - read, position + read);
        if (!result.bytesRead) throw new Error('本机文件提前结束: ' + localPath);
        read += result.bytesRead;
      }
      const expected = position + read;
      const written = await evaluateRemote<number>(
        cdp,
        `
        const entry = requireKairoFile(${JSON.stringify(file.id)});
        idleKairoFile(entry);
        if (entry.size !== ${position}) throw new Error('远端上传位置不一致');
        const fs = window.require('fs');
        const buffer = window.require('buffer').Buffer.from(${JSON.stringify(buffer.toString('base64', 0, read))}, 'base64');
        const fd = fs.openSync(entry.path, 'r+');
        try {
          let written = 0;
          while (written < buffer.length) {
            const count = fs.writeSync(fd, buffer, written, buffer.length - written, ${position} + written);
            if (!Number.isInteger(count) || count <= 0) throw new Error('远端文件短写且没有进展');
            written += count;
          }
          entry.size += written;
          return entry.size;
        } finally { fs.closeSync(fd); }
      `
      );
      if (written !== expected) throw new Error('远端上传长度不一致');
      position = expected;
      checkAbort(signal);
    }
    if ((await source.stat()).size !== stat.size) throw new Error('上传过程中本机文件长度发生变化');
    const size = await evaluateRemote<number>(
      cdp,
      `
      const entry = requireKairoFile(${JSON.stringify(file.id)});
      idleKairoFile(entry);
      return window.require('fs').statSync(entry.path).size;
    `
    );
    checkAbort(signal);
    if (size !== stat.size) throw new Error('远端上传文件长度校验失败');
    await source.close();
    closed = true;
    return { ...file, size };
  } catch (error) {
    const cleanups: Array<() => Promise<void>> = [];
    if (!closed) cleanups.push(() => source.close());
    if (file) {
      const remote = file;
      cleanups.push(() => releaseRemoteFile(cdp, remote));
    }
    return failWithCleanup(error, cleanups);
  }
}

export async function copyRemoteFileToLocal(
  cdp: CdpClient,
  remotePath: string,
  fullPath: string,
  options: { maxBytes?: number; nonEmpty?: boolean; signal?: AbortSignal } = {}
): Promise<string> {
  const { maxBytes, nonEmpty, signal } = options;
  checkAbort(signal);
  // 只有Driver目标可在宿主resolve；KK9路径始终在渲染端解释。
  const target = path.resolve(fullPath);
  const part = path.join(path.dirname(target), '.' + randomUUID() + '.part');
  const size = await evaluateRemote<number>(
    cdp,
    `
    touchKairoFilePath(${JSON.stringify(remotePath)});
    const stat = window.require('fs').statSync(${JSON.stringify(remotePath)});
    if (!stat.isFile()) throw new Error('远端资源不是普通文件');
    return stat.size;
  `
  );
  checkAbort(signal);
  checkSize(size, maxBytes, nonEmpty);
  const destination = await fs.open(part, 'wx');
  let closed = false;
  try {
    for (let position = 0; position < size; ) {
      checkAbort(signal);
      const length = Math.min(CHUNK_BYTES, size - position);
      const encoded = await evaluateRemote<string>(
        cdp,
        `
        touchKairoFilePath(${JSON.stringify(remotePath)});
        const fs = window.require('fs');
        const fd = fs.openSync(${JSON.stringify(remotePath)}, 'r');
        try {
          if (fs.fstatSync(fd).size !== ${size}) throw new Error('远端文件长度发生变化');
          const buffer = window.require('buffer').Buffer.allocUnsafe(${length});
          let read = 0;
          while (read < buffer.length) {
            const count = fs.readSync(fd, buffer, read, buffer.length - read, ${position} + read);
            if (!Number.isInteger(count) || count <= 0) throw new Error('远端文件提前结束');
            read += count;
          }
          return buffer.toString('base64');
        } finally { fs.closeSync(fd); }
      `
      );
      checkAbort(signal);
      const buffer = Buffer.from(encoded, 'base64');
      if (buffer.length !== length) throw new Error('远端下载分块长度不一致');
      let written = 0;
      while (written < buffer.length) {
        checkAbort(signal);
        const result = await destination.write(
          buffer,
          written,
          buffer.length - written,
          position + written
        );
        if (!result.bytesWritten) throw new Error('本机文件短写且没有进展');
        written += result.bytesWritten;
      }
      position += written;
    }
    const finalSize = await evaluateRemote<number>(
      cdp,
      `touchKairoFilePath(${JSON.stringify(remotePath)}); return window.require('fs').statSync(${JSON.stringify(remotePath)}).size;`
    );
    checkAbort(signal);
    if (finalSize !== size || (await destination.stat()).size !== size)
      throw new Error('下载文件长度校验失败');
    await destination.close();
    closed = true;
    checkAbort(signal);
    await fs.rename(part, target);
    return target;
  } catch (error) {
    const cleanups: Array<() => Promise<void>> = [];
    if (!closed) cleanups.push(() => destination.close());
    cleanups.push(() => fs.rm(part, { force: true }));
    return failWithCleanup(error, cleanups);
  }
}
