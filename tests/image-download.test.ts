import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { KK9Driver } from '../src/driver.js';
import { FakeKK9Driver } from '../src/fake-driver.js';
import { normalizeNativeMessage } from '../src/bridge/converter.js';
import { getDriverTestInternals } from './helpers/driver-internals.js';
import { createRendererRuntime, FakeIpcRenderer, runRendererScript } from './helpers/renderer-runtime.js';

const roots: string[] = [];
const targetPath = () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'kairo-image-download-'));
  roots.push(root);
  return path.join(root, '原图.png');
};

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function nativeDriver(responder: ConstructorParameters<typeof FakeIpcRenderer>[0]) {
  const ipc = new FakeIpcRenderer(responder);
  const runtime = createRendererRuntime({ ipc });
  const driver = new KK9Driver({ cdp: { url: 'http://127.0.0.1:9222' } });
  vi.spyOn(getDriverTestInternals(driver).cdp, 'evaluate').mockImplementation(
    <T>(script: string) => runRendererScript<T>(script, runtime.context)
  );
  return driver;
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

  it('原生下载选择原图 URI 并落地真实字节，不把缩略图当原图', async () => {
    const target = targetPath();
    const original = Buffer.from('原图真实字节');
    const driver = nativeDriver(request => {
      const [method, input] = request.args as [string, { uri: string; fullPath: string }];
      if (method !== 'download') throw new Error('意外原生操作');
      writeFileSync(input.fullPath, input.uri === 'group/original' ? original : '缩略图');
      return { code: 0, data: { path: input.fullPath } };
    });
    expect(await driver.downloadImage({ originalUri: 'group/original', uri: 'group/thumb' }, target)).toBe(target);
    expect(readFileSync(target)).toEqual(original);
  });

  it('只有单一资源 URI 时仍可原生下载', async () => {
    const target = targetPath();
    const driver = nativeDriver(request => {
      const input = request.args[1] as { fullPath: string };
      writeFileSync(input.fullPath, '单一原图资源');
      return { code: 0, data: { path: input.fullPath } };
    });
    await driver.downloadImage({ uri: 'group/single' }, target);
    expect(readFileSync(target, 'utf8')).toBe('单一原图资源');
  });

  it('原生业务失败保留资源、目标路径和具体错误', async () => {
    const target = targetPath();
    const driver = nativeDriver(() => ({ code: 403, error: '原图已过期' }));
    await expect(driver.downloadImage({ originalUri: 'group/expired' }, target)).rejects.toThrow(/group\/expired.*403.*原图已过期/);
    await expect(driver.downloadImage({ originalUri: 'group/expired' }, target)).rejects.toThrow(target);
  });

  it('code0 但没有落地文件不能算下载成功', async () => {
    const target = targetPath();
    const driver = nativeDriver(() => ({ code: 0, data: { path: target } }));
    await expect(driver.downloadImage({ uri: 'group/missing' }, target)).rejects.toThrow(/ENOENT/);
  });

  it('明确有原图但缺少原图 URI 时拒绝下载缩略图', async () => {
    const target = targetPath();
    const driver = nativeDriver(() => { throw new Error('不应调用下载'); });
    await expect(driver.downloadImage({ originalFilePath: 'C:/expired/original.png', uri: 'group/thumb' }, target)).rejects.toThrow(/原图.*URI/);
  });

  for (const image of [{ originalUri: '', uri: 'group/thumb' }, { originalFilePath: '', uri: 'group/thumb' }]) {
    it(`原图字段显式为空时原生和 Fake 都不能下载缩略图：${JSON.stringify(image)}`, async () => {
      const target = targetPath();
      const native = nativeDriver(request => {
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
});
