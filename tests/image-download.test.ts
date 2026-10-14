import fs, { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
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
import { createRendererRuntime, FakeIpcRenderer, NO_IPC_RESPONSE, runRendererScript } from './helpers/renderer-runtime.js';

const roots: string[] = [];
const targetPath = () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'kairo-image-download-'));
  roots.push(root);
  return path.join(root, '原图.png');
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
  const remoteRoot = mkdtempSync(path.join(os.tmpdir(), 'kairo-remote-kk-'));
  roots.push(remoteRoot);
  const remoteFs = {
    ...fs,
    statSync: ((file: fs.PathLike) => fs.statSync(typeof file === 'string' ? cachePaths[file] ?? file : file)) as typeof fs.statSync,
    openSync: ((file: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) => fs.openSync(
      typeof file === 'string' ? cachePaths[file] ?? file : file, flags, mode
    )) as typeof fs.openSync,
  };
  configureFs?.(remoteFs);
  const modules: Record<string, unknown> = {
    fs: remoteFs, path, os: { ...os, tmpdir: () => remoteRoot },
    buffer: nodeBuffer, crypto: nodeCrypto, url: nodeUrl,
    electron: { ipcRenderer: ipc },
  };
  const rendererWindow = runtime.context['window'];
  if (!rendererWindow || typeof rendererWindow !== 'object') throw new Error('测试渲染窗口缺失');
  Object.assign(rendererWindow, { require: (name: string) => {
    const module = modules[name.replace(/^node:/, '')];
    if (!module) throw new Error(`测试未提供远端模块：${name}`);
    return module;
  } });
  runtime.context['Buffer'] = Buffer;
  runtime.context['URL'] = URL;
  const driver = new KK9Driver({ cdp: { url: 'http://127.0.0.1:9222' } });
  vi.spyOn(getDriverTestInternals(driver).cdp, 'evaluate').mockImplementation(
    <T>(script: string) => runRendererScript<T>(script, runtime.context)
  );
  return { driver, ipc, remoteRoot };
}

describe('接收原图资源与原生下载', () => {
  it('规范化同时保留缩略图和独立原图，不丢失 uri_h/filepath_h', () => {
    const [message] = normalizeNativeMessage({
      id: 101, sessionID: 93001, sender: 91002, contentType: 4,
      content: { content: [{ type: 1, filepath: 'C:/cache/thumb.png', filepath_h: 'C:/cache/original.png', uri: 'group/thumb', uri_h: 'group/original', width: 580, height: 180, size: 138182 }] },
    });
    expect(message?.images?.[0]).toMatchObject({
      filePath: 'C:/cache/thumb.png', uri: 'group/thumb',
      originalFilePath: 'C:/cache/original.png', originalUri: 'group/original',
      width: 580, height: 180, size: 138182,
    });
  });

  it.each(['filepath_h', 'uri_h'])('原生显式空%s经规范化后仍拒绝已缓存缩略图', async emptyField => {
    const thumbnail = targetPath();
    const target = targetPath();
    const remoteThumbnail = 'C:\\KK9\\cache\\仅缩略图.png';
    writeFileSync(thumbnail, '缩略图字节');
    writeFileSync(target, '原成功目标');
    const [message] = normalizeNativeMessage({
      id: 102, sessionID: 93001, sender: 91002, contentType: 4,
      content: { content: [{ type: 1, filepath: remoteThumbnail, [emptyField]: '' }] },
    });
    const image = message?.images?.[0];
    expect(image).toBeDefined();
    const { driver: native, ipc } = nativeDriver(() => { throw new Error('不能下载缩略图'); }, {
      [remoteThumbnail]: thumbnail, [path.resolve(remoteThumbnail)]: thumbnail,
    });
    const fake = new FakeKK9Driver();
    fake.setCachedFile(remoteThumbnail, Buffer.from('缩略图字节'));
    for (const driver of [native, fake]) {
      await expect(driver.downloadImage(image!, target)).rejects.toMatchObject({ code: 'IMAGE_DOWNLOAD_FAILED' });
      expect(readFileSync(target, 'utf8')).toBe('原成功目标');
    }
    expect(ipc.sent).toEqual([]);
    expect(readFileSync(thumbnail, 'utf8')).toBe('缩略图字节');
  });

  it('原生下载选择原图 URI 并落地真实字节，不把缩略图当原图', async () => {
    const target = targetPath();
    const original = Buffer.from('原图真实字节');
    const { driver } = nativeDriver(request => {
      const [method, input] = request.args as [string, { uri: string; fullPath: string }];
      if (method !== 'download') throw new Error('意外原生操作');
      expect(input.fullPath).not.toBe(target);
      expect(path.dirname(input.fullPath)).not.toBe(path.dirname(target));
      writeFileSync(input.fullPath, input.uri === 'group/original' ? original : '缩略图');
      return { code: 0, data: { path: input.fullPath } };
    });
    expect(await driver.downloadImage({ originalUri: 'group/original', uri: 'group/thumb' }, target)).toBe(target);
    expect(readFileSync(target)).toEqual(original);
  });

  it('只有单一资源 URI 时仍可原生下载', async () => {
    const target = targetPath();
    const { driver } = nativeDriver(request => {
      const input = request.args[1] as { fullPath: string };
      writeFileSync(input.fullPath, '单一原图资源');
      return { code: 0, data: { path: input.fullPath } };
    });
    await driver.downloadImage({ uri: 'group/single' }, target);
    expect(readFileSync(target, 'utf8')).toBe('单一原图资源');
  });

  it('原生业务失败保留资源、目标路径和具体错误', async () => {
    const target = targetPath();
    const { driver } = nativeDriver(() => ({ code: 403, error: '原图已过期' }));
    await expect(driver.downloadImage({ originalUri: 'group/expired' }, target)).rejects.toThrow(/group\/expired.*403.*原图已过期/);
    await expect(driver.downloadImage({ originalUri: 'group/expired' }, target)).rejects.toThrow(target);
  });

  it('code0 但没有落地文件不能算下载成功', async () => {
    const target = targetPath();
    const { driver } = nativeDriver(request => {
      const input = request.args[1] as { fullPath: string };
      rmSync(input.fullPath);
      return { code: 0, data: { path: input.fullPath } };
    });
    await expect(driver.downloadImage({ uri: 'group/missing' }, target)).rejects.toThrow(/ENOENT/);
  });

  it('明确有原图但缺少原图 URI 时拒绝下载缩略图', async () => {
    const target = targetPath();
    const { driver } = nativeDriver(() => { throw new Error('不应调用下载'); });
    await expect(driver.downloadImage({ originalFilePath: 'C:/expired/original.png', uri: 'group/thumb' }, target)).rejects.toThrow(/原图.*URI/);
  });

  for (const image of [{ originalUri: '', uri: 'group/thumb' }, { originalFilePath: '', uri: 'group/thumb' }]) {
    it(`原图字段显式为空时原生和 Fake 都不能下载缩略图：${JSON.stringify(image)}`, async () => {
      const target = targetPath();
      const { driver: native } = nativeDriver(request => {
        const input = request.args[1] as { fullPath: string };
        writeFileSync(input.fullPath, '缩略图');
        return { code: 0, data: { path: input.fullPath } };
      });
      const fake = new FakeKK9Driver();
      fake.setImageResource('group/thumb', Buffer.from('缩略图'));
      for (const driver of [native, fake]) {
        await expect(driver.downloadImage(image, target)).rejects.toMatchObject({ code: 'IMAGE_DOWNLOAD_FAILED' });
      }
    });
  }

  it('Fake 也保存原图实际字节，未注入资源必须报错', async () => {
    const target = targetPath();
    const driver = new FakeKK9Driver();
    driver.setImageResource('group/original', Buffer.from('注入原图'));
    driver.setImageResource('group/thumb', Buffer.from('注入缩略图'));
    await driver.downloadImage({ originalUri: 'group/original', uri: 'group/thumb' }, target);
    expect(readFileSync(target, 'utf8')).toBe('注入原图');
    await expect(driver.downloadImage({ uri: 'group/not-found' }, target)).rejects.toThrow(/group\/not-found/);
  });
  it('优先保存 Windows 原图缓存，不读取缩略图且不发送下载 IPC', async () => {
    const target = targetPath();
    const original = targetPath();
    const thumbnail = targetPath();
    const remoteOriginal = 'C:\\KK9\\cache\\原图.png';
    const remoteThumbnail = 'C:\\KK9\\cache\\缩略图.png';
    writeFileSync(original, '缓存原图字节');
    writeFileSync(thumbnail, '缓存缩略图字节');
    const { driver, ipc } = nativeDriver(() => { throw new Error('不应下载已有缓存'); }, {
      [remoteOriginal]: original, [path.resolve(remoteOriginal)]: original,
      [remoteThumbnail]: thumbnail, [path.resolve(remoteThumbnail)]: thumbnail,
    });
    const image = { originalFilePath: remoteOriginal, filePath: remoteThumbnail, originalUri: 'group/original', uri: 'group/thumb' };
    expect(await driver.downloadImage(image, target)).toBe(target);
    expect(readFileSync(target, 'utf8')).toBe('缓存原图字节');
    expect(ipc.sent).toEqual([]);
    const fake = new FakeKK9Driver();
    fake.setCachedFile(remoteOriginal, Buffer.from('缓存原图字节'));
    fake.setCachedFile(remoteThumbnail, Buffer.from('缓存缩略图字节'));
    await fake.downloadImage(image, target);
    expect(readFileSync(target, 'utf8')).toBe('缓存原图字节');
  });

  it('独立原图缓存 ENOENT 时仅下载准确原图 URI', async () => {
    const target = targetPath();
    const { driver } = nativeDriver(request => {
      const input = request.args[1] as { uri: string; fullPath: string };
      expect(input.uri).toBe('group/original');
      expect(input.fullPath).not.toBe(target);
      writeFileSync(input.fullPath, '新下载原图');
      return { code: 0, data: { path: input.fullPath } };
    });
    await driver.downloadImage({ originalFilePath: 'C:\\missing\\original.png', originalUri: 'group/original', uri: 'group/thumb' }, target);
    expect(readFileSync(target, 'utf8')).toBe('新下载原图');
  });

  it('原图缓存 EACCES 不得静默降级下载或覆盖成功目标', async () => {
    const target = targetPath();
    writeFileSync(target, '已有成功文件');
    const { driver, ipc } = nativeDriver(() => { throw new Error('不应下载'); }, {}, remoteFs => {
      remoteFs.statSync = () => { throw Object.assign(new Error('EACCES：缓存拒绝访问'), { code: 'EACCES' }); };
    });
    await expect(driver.downloadImage({ originalFilePath: 'C:\\private\\original.png', originalUri: 'group/original' }, target)).rejects.toThrow(/EACCES/);
    expect(readFileSync(target, 'utf8')).toBe('已有成功文件');
    expect(ipc.sent).toEqual([]);
  });

  for (const source of ['filePath', 'url'] as const) {
    it(`无独立原图时支持唯一缓存来源 ${source}`, async () => {
      const target = targetPath();
      const cache = targetPath();
      writeFileSync(cache, '唯一缓存原图');
      const image = source === 'url' ? { url: nodeUrl.pathToFileURL(cache).href } : { filePath: cache };
      const { driver, ipc } = nativeDriver(() => { throw new Error('不应下载'); });
      await driver.downloadImage(image, target);
      expect(readFileSync(target, 'utf8')).toBe('唯一缓存原图');
      expect(ipc.sent).toEqual([]);
      const fake = new FakeKK9Driver();
      fake.setCachedFile(cache, Buffer.from('唯一缓存原图'));
      await fake.downloadImage(image, target);
      expect(readFileSync(target, 'utf8')).toBe('唯一缓存原图');
    });
  }

  it('原生返回 Driver 目标而非 KK9 临时目标必须拒绝', async () => {
    const target = targetPath();
    writeFileSync(target, '已有成功文件');
    const { driver, remoteRoot } = nativeDriver(() => ({ code: 0, data: { path: target } }));
    await expect(driver.downloadImage({ uri: 'group/original' }, target)).rejects.toThrow(/KK9.*路径/);
    expect(readFileSync(target, 'utf8')).toBe('已有成功文件');
    expect(readdirSync(remoteRoot)).toEqual([]);
  });

  it('原生失败或空原图不能覆盖成功文件，也不遗留部分文件', async () => {
    const target = targetPath();
    writeFileSync(target, '已有成功文件');
    for (const fail of [true, false]) {
      const { driver, remoteRoot } = nativeDriver(request => {
        const input = request.args[1] as { fullPath: string };
        writeFileSync(input.fullPath, fail ? '部分下载' : '');
        return fail ? { code: 500, error: '下载中断' } : { code: 0, data: { path: input.fullPath } };
      });
      await expect(driver.downloadImage({ uri: 'group/original' }, target)).rejects.toMatchObject({ code: 'IMAGE_DOWNLOAD_FAILED' });
      expect(readFileSync(target, 'utf8')).toBe('已有成功文件');
      expect(readdirSync(path.dirname(target))).toEqual([path.basename(target)]);
      expect(readdirSync(remoteRoot)).toEqual([]);
    }
  });

  it('下载超时保留原生写入依赖，迟到真实完成后释放临时目录', async () => {
    vi.useFakeTimers();
    const target = targetPath();
    writeFileSync(target, '已有成功文件');
    let remotePath = '';
    const { driver, ipc, remoteRoot } = nativeDriver(request => {
      const input = request.args[1] as { fullPath: string };
      remotePath = input.fullPath;
      writeFileSync(remotePath, '下载进行中');
      return NO_IPC_RESPONSE;
    });
    vi.spyOn(ipc, 'once').mockImplementation((channel, listener) => {
      const onReply = (event: unknown, payload: unknown) => {
        ipc.removeListener(channel, onReply);
        listener(event, payload);
      };
      ipc.on(channel, onReply);
    });
    const operation = driver.downloadImage({ uri: 'group/slow-original' }, target);
    const failure = expect(operation).rejects.toMatchObject({ code: 'IMAGE_DOWNLOAD_FAILED' });
    await vi.advanceTimersByTimeAsync(30001);
    await failure;
    expect(existsSync(remotePath)).toBe(true);
    expect(readFileSync(target, 'utf8')).toBe('已有成功文件');
    const request = ipc.sent[0];
    expect(request).toBeDefined();
    if (!request) throw new Error('测试原生下载请求缺失');
    writeFileSync(remotePath, '原生最终完成');
    ipc.emit(`data-${request.id}`, { code: 0, data: { path: remotePath } });
    await vi.advanceTimersByTimeAsync(0);
    expect(readdirSync(remoteRoot)).toEqual([]);
    expect(readFileSync(target, 'utf8')).toBe('已有成功文件');
  });

  it('本地发布失败不会把部分下载当成功，原生和 Fake 都清理临时文件', async () => {
    const target = targetPath();
    mkdirSync(target);
    const marker = path.join(target, '已有成功内容');
    writeFileSync(marker, '保留内容');
    const { driver: native, remoteRoot } = nativeDriver(request => {
      const input = request.args[1] as { fullPath: string };
      writeFileSync(input.fullPath, '下载实际字节');
      return { code: 0, data: { path: input.fullPath } };
    });
    const fake = new FakeKK9Driver();
    fake.setImageResource('group/original', Buffer.from('下载实际字节'));
    for (const driver of [native, fake]) {
      await expect(driver.downloadImage({ uri: 'group/original' }, target)).rejects.toMatchObject({ code: 'IMAGE_DOWNLOAD_FAILED' });
      expect(readFileSync(marker, 'utf8')).toBe('保留内容');
      expect(readdirSync(path.dirname(target))).toEqual([path.basename(target)]);
    }
    expect(readdirSync(remoteRoot)).toEqual([]);
  });

  it('普通文件保存支持 Windows 缓存路径和真实零字节，公开 API 与 Fake 一致', async () => {
    const target = targetPath();
    const cache = targetPath();
    const remotePath = 'C:\\KK9\\cache\\附件.bin';
    const { driver: native, ipc } = nativeDriver(() => { throw new Error('普通文件不应调用下载'); }, {
      [remotePath]: cache, [path.resolve(remotePath)]: cache,
    });
    const fake = new FakeKK9Driver();
    for (const bytes of [Buffer.from('附件真实字节'), Buffer.alloc(0)]) {
      writeFileSync(cache, bytes);
      fake.setCachedFile(remotePath, bytes);
      for (const driver of [native, fake]) {
        expect(await driver.saveFile({ fileName: '附件.bin', filePath: remotePath }, target)).toBe(target);
        expect(readFileSync(target)).toEqual(bytes);
        expect(readdirSync(path.dirname(target))).toEqual([path.basename(target)]);
      }
    }
    expect(ipc.sent).toEqual([]);
  });

  it('普通文件未缓存或缓存不存在明确失败，不下载且保留已有成功目标', async () => {
    const target = targetPath();
    writeFileSync(target, '已有成功文件');
    const { driver: native, ipc } = nativeDriver(() => { throw new Error('普通文件不应下载'); });
    const fake = new FakeKK9Driver();
    for (const file of [{ fileName: '附件.bin' }, { fileName: '附件.bin', filePath: 'C:\\missing\\attachment.bin' }]) {
      for (const driver of [native, fake]) {
        await expect(driver.saveFile(file, target)).rejects.toMatchObject({ code: 'FILE_SAVE_FAILED' });
        expect(readFileSync(target, 'utf8')).toBe('已有成功文件');
      }
    }
    expect(ipc.sent).toEqual([]);
  });

  it('Fake 空原图不得伪造成功或覆盖原目标', async () => {
    const target = targetPath();
    writeFileSync(target, '已有成功文件');
    const fake = new FakeKK9Driver();
    fake.setImageResource('group/empty', Buffer.alloc(0));
    await expect(fake.downloadImage({ uri: 'group/empty' }, target)).rejects.toMatchObject({ code: 'IMAGE_DOWNLOAD_FAILED' });
    expect(readFileSync(target, 'utf8')).toBe('已有成功文件');
  });

  it('远端读取第二块时中断保留已有文件并删除宿主部分文件', async () => {
    const target = targetPath();
    const cache = targetPath();
    writeFileSync(target, '已有成功文件');
    writeFileSync(cache, Buffer.alloc(512 * 1024, 7));
    let reads = 0;
    const { driver } = nativeDriver(() => { throw new Error('缓存传输不应调用下载'); }, {}, remoteFs => {
      remoteFs.readSync = ((...args: Parameters<typeof fs.readSync>) => {
        if (++reads === 2) throw new Error('远端读取中断');
        return fs.readSync(...args);
      }) as typeof fs.readSync;
    });
    await expect(driver.downloadImage({ originalFilePath: cache }, target)).rejects.toThrow(/远端读取中断/);
    expect(reads).toBe(2);
    expect(readFileSync(target, 'utf8')).toBe('已有成功文件');
    expect(readdirSync(path.dirname(target))).toEqual([path.basename(target)]);
  });

  it('原生失败叠加临时目录清理失败时保留两个具体错误', async () => {
    const target = targetPath();
    const { driver } = nativeDriver(() => ({ code: 403, error: '原图已过期' }), {}, remoteFs => {
      remoteFs.rmSync = () => { throw new Error('EACCES：临时目录清理失败'); };
    });
    await expect(driver.downloadImage({ originalUri: 'group/expired' }, target)).rejects.toThrow(/403.*原图已过期.*清理.*EACCES/);
    expect(existsSync(target)).toBe(false);
  });

  it('独立原图 URI 存在时不能读取已缓存缩略图', async () => {
    const target = targetPath();
    const thumbnail = targetPath();
    writeFileSync(thumbnail, '已缓存缩略图');
    const { driver: native } = nativeDriver(request => {
      const input = request.args[1] as { uri: string; fullPath: string };
      expect(input.uri).toBe('group/original');
      writeFileSync(input.fullPath, '准确原图');
      return { code: 0, data: { path: input.fullPath } };
    });
    const fake = new FakeKK9Driver();
    fake.setCachedFile(thumbnail, Buffer.from('已缓存缩略图'));
    fake.setImageResource('group/original', Buffer.from('准确原图'));
    for (const driver of [native, fake]) {
      await driver.downloadImage({ originalUri: 'group/original', filePath: thumbnail, uri: 'group/thumb' }, target);
      expect(readFileSync(target, 'utf8')).toBe('准确原图');
    }
  });
});
