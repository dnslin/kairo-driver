import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createContext, runInContext } from 'node:vm';
import { Buffer } from 'node:buffer';
import type { CdpClient } from '../../src/cdp/client.js';

/** 渲染端使用Windows路径，真实文件落在与Driver独立的目录中。 */
export function createRemoteFilesystem() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kairo-remote-test-'));
  const remoteRoot = 'R:\\KK9临时';
  const handles = new Set<number>();
  const controls = {
    readLimit: Infinity,
    writeLimit: Infinity,
    failWriteAfter: Infinity,
    failReadAfter: Infinity,
    failRemove: false,
    reads: 0,
    writes: 0,
  };
  const toLocal = (remote: string): string => {
    const relative = path.win32.relative(remoteRoot, remote);
    if (relative.startsWith('..') || path.win32.isAbsolute(relative)) {
      throw new Error('测试拒绝访问远端根目录以外的路径: ' + remote);
    }
    return path.join(root, ...relative.split('\\'));
  };
  const remoteFs = {
    mkdtempSync: (prefix: string) => {
      const directory = fs.mkdtempSync(toLocal(prefix));
      return path.win32.join(remoteRoot, path.basename(directory));
    },
    openSync: (file: string, flags: string) => {
      const fd = fs.openSync(toLocal(file), flags);
      handles.add(fd);
      return fd;
    },
    closeSync: (fd: number) => {
      fs.closeSync(fd);
      handles.delete(fd);
    },
    readSync: (fd: number, buffer: Buffer, offset: number, length: number, position: number) => {
      if (++controls.reads > controls.failReadAfter) throw new Error('远端磁盘读取失败');
      return fs.readSync(fd, buffer, offset, Math.min(length, controls.readLimit), position);
    },
    writeSync: (fd: number, buffer: Buffer, offset: number, length: number, position: number) => {
      if (++controls.writes > controls.failWriteAfter) throw new Error('远端磁盘写入失败');
      return fs.writeSync(fd, buffer, offset, Math.min(length, controls.writeLimit), position);
    },
    statSync: (file: string) => fs.statSync(toLocal(file)),
    fstatSync: (fd: number) => fs.fstatSync(fd),
    rmSync: (file: string, options: fs.RmOptions) => {
      if (controls.failRemove) throw new Error('远端临时目录清理失败');
      fs.rmSync(toLocal(file), options);
    },
  };
  const timers = new Set<NodeJS.Timeout>();
  const window: Record<string, unknown> = {
    require: (name: string) => {
      if (name === 'fs') return remoteFs;
      if (name === 'path') return path.win32;
      if (name === 'os') return { tmpdir: () => remoteRoot };
      if (name === 'buffer') return { Buffer };
      throw new Error('未提供远端模块: ' + name);
    },
  };
  const context = createContext({
    window,
    console,
    Buffer,
    AbortController,
    setTimeout: (callback: () => void, milliseconds: number) => {
      const timer = setTimeout(() => {
        timers.delete(timer);
        callback();
      }, milliseconds);
      timer.unref();
      timers.add(timer);
      return timer;
    },
    clearTimeout: (timer: NodeJS.Timeout) => {
      timers.delete(timer);
      clearTimeout(timer);
    },
  });
  const scripts: string[] = [];
  const timeouts: Array<number | undefined> = [];
  const evaluate = async <T>(script: string, timeout?: number): Promise<T> => {
    scripts.push(script);
    timeouts.push(timeout);
    return (await runInContext(script, context)) as T;
  };
  return {
    root,
    remoteRoot,
    controls,
    handles,
    window,
    context,
    scripts,
    timeouts,
    toLocal,
    evaluate,
    cdp: { evaluate } as unknown as CdpClient,
    dispose() {
      for (const timer of timers) clearTimeout(timer);
      for (const fd of handles) fs.closeSync(fd);
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}
