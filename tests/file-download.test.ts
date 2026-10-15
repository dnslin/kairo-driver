import fs, {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import * as nodeBuffer from 'node:buffer';
import * as nodeCrypto from 'node:crypto';
import * as nodeUrl from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { KK9Driver } from '../src/driver.js';
import { FakeKK9Driver } from '../src/fake-driver.js';
import { normalizeNativeMessage } from '../src/bridge/converter.js';
import { getDriverTestInternals } from './helpers/driver-internals.js';
import {
  createRendererRuntime,
  FakeIpcRenderer,
  NO_IPC_RESPONSE,
  runRendererScript,
} from './helpers/renderer-runtime.js';

const roots: string[] = [];
const targetPath = () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'kairo-file-download-'));
  roots.push(root);
  return path.join(root, '附件.bin');
};

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function nativeDriver(
  responder: ConstructorParameters<typeof FakeIpcRenderer>[0],
  cachePaths: Record<string, string> = {},
  configureFs?: (remoteFs: typeof fs) => void
) {
  const ipc = new FakeIpcRenderer(responder);
  const runtime = createRendererRuntime({ ipc });
  const remoteRoot = mkdtempSync(path.join(os.tmpdir(), 'kairo-remote-file-'));
  roots.push(remoteRoot);
  const remoteFs = {
    ...fs,
    statSync: ((file: fs.PathLike) =>
      fs.statSync(
        typeof file === 'string' ? (cachePaths[file] ?? file) : file
      )) as typeof fs.statSync,
    openSync: ((file: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) =>
      fs.openSync(
        typeof file === 'string' ? (cachePaths[file] ?? file) : file,
        flags,
        mode
      )) as typeof fs.openSync,
  };
  configureFs?.(remoteFs);
  const modules: Record<string, unknown> = {
    fs: remoteFs,
    path,
    os: { ...os, tmpdir: () => remoteRoot },
    buffer: nodeBuffer,
    crypto: nodeCrypto,
    url: nodeUrl,
    electron: { ipcRenderer: ipc },
  };
  const rendererWindow = runtime.context['window'];
  if (!rendererWindow || typeof rendererWindow !== 'object') throw new Error('测试渲染窗口缺失');
  Object.assign(rendererWindow, {
    require: (name: string) => {
      const module = modules[name.replace(/^node:/, '')];
      if (!module) throw new Error(`测试未提供远端模块：${name}`);
      return module;
    },
  });
  runtime.context['Buffer'] = Buffer;
  runtime.context['URL'] = URL;
  const driver = new KK9Driver({ cdp: { url: 'http://127.0.0.1:9222' } });
  vi.spyOn(getDriverTestInternals(driver).cdp, 'evaluate').mockImplementation(<T>(script: string) =>
    runRendererScript<T>(script, runtime.context)
  );
  return { driver, ipc, remoteRoot };
}

describe('接收普通文件与原生下载', () => {
  it('仅有 URI 时原生和 Fake 保存真实字节，包含合法零字节文件', async () => {
    for (const bytes of [Buffer.from([0, 255, 1, 128, 10]), Buffer.alloc(0)]) {
      const target = targetPath();
      writeFileSync(target, '已有成功文件');
      const uri = 'group/files/仅服务端资源';
      const {
        driver: native,
        ipc,
        remoteRoot,
      } = nativeDriver(request => {
        const [method, input] = request.args as [
          string,
          { uri: string; fullPath: string; override: boolean },
        ];
        expect(method).toBe('download');
        expect(input).toEqual({ uri, fullPath: expect.any(String), override: true });
        expect(path.dirname(input.fullPath)).not.toBe(path.dirname(target));
        expect(readFileSync(target, 'utf8')).toBe('已有成功文件');
        writeFileSync(input.fullPath, bytes);
        return { code: 0, data: { path: input.fullPath } };
      });
      const fake = new FakeKK9Driver();
      fake.setFileResource(uri, bytes);
      for (const driver of [native, fake]) {
        expect(await driver.saveFile({ fileName: '附件.bin', uri }, target)).toBe(target);
        expect(readFileSync(target)).toEqual(bytes);
        expect(readdirSync(path.dirname(target))).toEqual([path.basename(target)]);
      }
      expect(ipc.sent).toHaveLength(1);
      expect(readdirSync(remoteRoot)).toEqual([]);
    }
  });

  it('缓存路径 ENOENT 时按该文件 URI 下载而不是直接失败', async () => {
    const target = targetPath();
    const missing = path.join(path.dirname(targetPath()), '已过期缓存.bin');
    const uri = 'group/files/缓存已过期';
    const bytes = Buffer.from('从服务器恢复的文件字节');
    const {
      driver: native,
      ipc,
      remoteRoot,
    } = nativeDriver(request => {
      const input = request.args[1] as { uri: string; fullPath: string };
      expect(input.uri).toBe(uri);
      writeFileSync(input.fullPath, bytes);
      return { code: 0, data: { path: input.fullPath } };
    });
    const fake = new FakeKK9Driver();
    fake.setFileResource(uri, bytes);
    for (const driver of [native, fake]) {
      await driver.saveFile({ fileName: '附件.bin', filePath: missing, uri }, target);
      expect(readFileSync(target)).toEqual(bytes);
    }
    expect(existsSync(missing)).toBe(false);
    expect(ipc.sent).toHaveLength(1);
    expect(readdirSync(remoteRoot)).toEqual([]);
  });

  it('Windows 路径和 file URL 的有效缓存优先于同一文件的服务端 URI', async () => {
    const target = targetPath();
    const cache = targetPath();
    const windowsPath = 'C:\\KK9\\cache\\中文 附件.bin';
    const cachedBytes = Buffer.from('缓存版本');
    writeFileSync(cache, cachedBytes);
    const {
      driver: native,
      ipc,
      remoteRoot,
    } = nativeDriver(
      () => {
        throw new Error('有效缓存不应下载');
      },
      {
        [windowsPath]: cache,
        [path.resolve(windowsPath)]: cache,
      }
    );
    const fake = new FakeKK9Driver();
    fake.setCachedFile(windowsPath, cachedBytes);
    fake.setCachedFile(cache, cachedBytes);
    fake.setFileResource('group/files/已有缓存', Buffer.from('不同的服务端版本'));
    for (const filePath of [windowsPath, nodeUrl.pathToFileURL(cache).href]) {
      for (const driver of [native, fake]) {
        await driver.saveFile(
          { fileName: '附件.bin', filePath, uri: 'group/files/已有缓存' },
          target
        );
        expect(readFileSync(target)).toEqual(cachedBytes);
      }
    }
    expect(readFileSync(cache)).toEqual(cachedBytes);
    expect(ipc.sent).toEqual([]);
    expect(readdirSync(remoteRoot)).toEqual([]);
  });

  it('对象和 JSON 字符串正文规范化保留 URI，并可直接保存完整文件字节', async () => {
    const target = targetPath();
    const content = { filename: '规范化附件.bin', uri: 'group/files/normalized', size: 17 };
    const bytes = Buffer.from('规范化后实际下载的字节');
    const { driver: native, remoteRoot } = nativeDriver(request => {
      const input = request.args[1] as { uri: string; fullPath: string };
      expect(input.uri).toBe(content.uri);
      writeFileSync(input.fullPath, bytes);
      return { code: 0, data: { path: input.fullPath } };
    });
    const fake = new FakeKK9Driver();
    fake.setFileResource(content.uri, bytes);
    for (const body of [content, JSON.stringify(content)]) {
      const [message] = normalizeNativeMessage(
        {
          id: 301,
          sessionID: 93001,
          sender: 91002,
          contentType: 3,
          content: body,
        },
        { currentUserId: 91001 }
      );
      expect(message).toMatchObject({
        direction: 'inbound',
        messageType: 'file',
        fileInfo: { fileName: content.filename, uri: content.uri },
      });
      const file = message?.fileInfo;
      if (!file) throw new Error('规范化后缺少普通文件');
      for (const driver of [native, fake]) {
        await driver.saveFile(file, target);
        expect(readFileSync(target)).toEqual(bytes);
      }
    }
    expect(readdirSync(remoteRoot)).toEqual([]);
  });

  it('同名文件根据不同 URI 保存各自字节，不复用其他消息资源', async () => {
    const resources: Record<string, Buffer> = {
      'group/files/first': Buffer.from('第一份同名附件'),
      'group/files/second': Buffer.from('第二份不同字节'),
    };
    const { driver: native, remoteRoot } = nativeDriver(request => {
      const input = request.args[1] as { uri: string; fullPath: string };
      const bytes = resources[input.uri];
      if (!bytes) throw new Error('意外普通文件 URI');
      writeFileSync(input.fullPath, bytes);
      return { code: 0, data: { path: input.fullPath } };
    });
    const fake = new FakeKK9Driver();
    for (const [uri, bytes] of Object.entries(resources)) fake.setFileResource(uri, bytes);
    const targets = Object.keys(resources).map(() => targetPath());
    for (const driver of [native, fake]) {
      for (const [index, [uri, bytes]] of Object.entries(resources).entries()) {
        const target = targets[index];
        if (!target) throw new Error('测试保存目标缺失');
        await driver.saveFile({ fileName: '附件.bin', uri }, target);
        expect(readFileSync(target)).toEqual(bytes);
      }
      expect(readFileSync(targets[0]!)).not.toEqual(readFileSync(targets[1]!));
    }
    expect(readdirSync(remoteRoot)).toEqual([]);
  });

  it('原生失败保留 code 和具体原因，不发布部分下载或损坏旧目标', async () => {
    const target = targetPath();
    writeFileSync(target, '已有成功文件');
    const { driver, remoteRoot } = nativeDriver(request => {
      const input = request.args[1] as { fullPath: string };
      writeFileSync(input.fullPath, '下载到一半');
      return { code: 403, error: '普通文件资源已过期' };
    });
    await expect(
      driver.saveFile({ fileName: '附件.bin', uri: 'group/files/expired' }, target)
    ).rejects.toMatchObject({
      code: 'FILE_SAVE_FAILED',
      message: expect.stringMatching(/group\/files\/expired.*403.*普通文件资源已过期/),
      originalCause: { message: expect.stringMatching(/403.*普通文件资源已过期/) },
    });
    expect(readFileSync(target, 'utf8')).toBe('已有成功文件');
    expect(readdirSync(path.dirname(target))).toEqual([path.basename(target)]);
    expect(readdirSync(remoteRoot)).toEqual([]);
  });

  it('原生 code0 但没有落地文件时失败并保留旧目标', async () => {
    const target = targetPath();
    writeFileSync(target, '已有成功文件');
    const { driver, remoteRoot } = nativeDriver(request => {
      const input = request.args[1] as { fullPath: string };
      rmSync(input.fullPath);
      return { code: 0, data: { path: input.fullPath } };
    });
    await expect(
      driver.saveFile({ fileName: '附件.bin', uri: 'group/files/missing' }, target)
    ).rejects.toMatchObject({
      code: 'FILE_SAVE_FAILED',
      message: expect.stringMatching(/ENOENT/),
    });
    expect(readFileSync(target, 'utf8')).toBe('已有成功文件');
    expect(readdirSync(path.dirname(target))).toEqual([path.basename(target)]);
    expect(readdirSync(remoteRoot)).toEqual([]);
  });

  it('原生 code0 返回其他路径时不能将其当作指定下载文件', async () => {
    const target = targetPath();
    writeFileSync(target, '已有成功文件');
    const { driver, remoteRoot } = nativeDriver(request => {
      const input = request.args[1] as { fullPath: string };
      writeFileSync(input.fullPath, '原生实际下载');
      return { code: 0, data: { path: target } };
    });
    await expect(
      driver.saveFile({ fileName: '附件.bin', uri: 'group/files/wrong-path' }, target)
    ).rejects.toMatchObject({
      code: 'FILE_SAVE_FAILED',
      message: expect.stringMatching(/KK9.*路径/),
    });
    expect(readFileSync(target, 'utf8')).toBe('已有成功文件');
    expect(readdirSync(path.dirname(target))).toEqual([path.basename(target)]);
    expect(readdirSync(remoteRoot)).toEqual([]);
  });

  it('缓存 EACCES 不能降级原生下载，失败原因和旧目标均保留', async () => {
    const target = targetPath();
    writeFileSync(target, '已有成功文件');
    const { driver, ipc, remoteRoot } = nativeDriver(
      () => {
        throw new Error('缓存拒绝访问不应下载');
      },
      {},
      remoteFs => {
        remoteFs.statSync = () => {
          throw Object.assign(new Error('EACCES：普通文件缓存拒绝访问'), { code: 'EACCES' });
        };
      }
    );
    await expect(
      driver.saveFile(
        { fileName: '附件.bin', filePath: 'C:\\private\\附件.bin', uri: 'group/files/private' },
        target
      )
    ).rejects.toMatchObject({
      code: 'FILE_SAVE_FAILED',
      message: expect.stringMatching(/EACCES.*缓存拒绝访问/),
    });
    expect(readFileSync(target, 'utf8')).toBe('已有成功文件');
    expect(ipc.sent).toEqual([]);
    expect(readdirSync(remoteRoot)).toEqual([]);
  });

  it('缓存实际为目录时明确失败，不将非 ENOENT 错误误当缓存过期', async () => {
    const target = targetPath();
    const cache = targetPath();
    mkdirSync(cache);
    writeFileSync(target, '已有成功文件');
    const { driver, ipc, remoteRoot } = nativeDriver(() => {
      throw new Error('缓存目录不应下载');
    });
    await expect(
      driver.saveFile(
        { fileName: '附件.bin', filePath: cache, uri: 'group/files/directory' },
        target
      )
    ).rejects.toMatchObject({
      code: 'FILE_SAVE_FAILED',
      message: expect.stringMatching(/缓存不是普通文件/),
    });
    expect(readFileSync(target, 'utf8')).toBe('已有成功文件');
    expect(ipc.sent).toEqual([]);
    expect(readdirSync(remoteRoot)).toEqual([]);
  });

  it('Fake 未注入普通文件资源时失败，不能借用同 URI 图片或覆盖旧目标', async () => {
    const target = targetPath();
    writeFileSync(target, '已有成功文件');
    const fake = new FakeKK9Driver();
    const uri = 'group/files/not-found';
    fake.setImageResource(uri, Buffer.from('同 URI 的图片并非普通文件资源'));
    await expect(fake.saveFile({ fileName: '附件.bin', uri }, target)).rejects.toMatchObject({
      code: 'FILE_SAVE_FAILED',
      message: expect.stringMatching(/普通文件资源不存在.*group\/files\/not-found/),
    });
    expect(readFileSync(target, 'utf8')).toBe('已有成功文件');
    expect(readdirSync(path.dirname(target))).toEqual([path.basename(target)]);
  });

  it('原生超时保留下载中的租约，迟到完成后清理且不覆盖旧目标', async () => {
    vi.useFakeTimers();
    const target = targetPath();
    writeFileSync(target, '已有成功文件');
    let remotePath = '';
    const { driver, ipc, remoteRoot } = nativeDriver(request => {
      const input = request.args[1] as { fullPath: string };
      remotePath = input.fullPath;
      writeFileSync(remotePath, '普通文件下载中');
      return NO_IPC_RESPONSE;
    });
    vi.spyOn(ipc, 'once').mockImplementation((channel, listener) => {
      const onReply = (event: unknown, payload: unknown) => {
        ipc.removeListener(channel, onReply);
        listener(event, payload);
      };
      ipc.on(channel, onReply);
    });
    const operation = driver.saveFile({ fileName: '附件.bin', uri: 'group/files/slow' }, target);
    const failure = expect(operation).rejects.toMatchObject({ code: 'FILE_SAVE_FAILED' });
    await vi.advanceTimersByTimeAsync(30001);
    await failure;
    expect(existsSync(remotePath)).toBe(true);
    expect(readFileSync(target, 'utf8')).toBe('已有成功文件');
    const request = ipc.sent[0];
    if (!request) throw new Error('测试普通文件下载请求缺失');
    writeFileSync(remotePath, '原生最终完成');
    ipc.emit(`data-${request.id}`, { code: 0, data: { path: remotePath } });
    await vi.advanceTimersByTimeAsync(0);
    expect(ipc.listenerCount(`data-${request.id}`)).toBe(0);
    expect(readdirSync(remoteRoot)).toEqual([]);
    expect(readFileSync(target, 'utf8')).toBe('已有成功文件');
    expect(readdirSync(path.dirname(target))).toEqual([path.basename(target)]);
  });
});
