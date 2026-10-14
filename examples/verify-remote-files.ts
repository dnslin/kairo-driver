import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, open, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CdpClient } from '@kairo/driver';
import {
  uploadLocalFile,
  releaseRemoteFile,
  type RemoteFile,
} from '../dist/bridge/file-transfer.js';
import { downloadNativeImage, saveNativeFile } from '../dist/bridge/attachment-ops.js';

// 只验证本轮自建文件，不读聊天、不安装 Hook、不发送或撤回消息。
const cdp = new CdpClient({
  url: process.env['CDP_URL'] || 'http://172.16.0.18:9222',
  pageMatch: process.env['PAGE_MATCH'] || 'renderer.html',
});
const directory = await mkdtemp(path.join(os.tmpdir(), 'kairo-remote-files-'));
const remoteFiles: RemoteFile[] = [];
let failure: unknown;
const cleanupErrors: unknown[] = [];
try {
  await cdp.connect();
  const remote = await cdp.evaluate<{ platform: string; hostname: string }>(
    `({ platform: window.process.platform, hostname: window.require('os').hostname() })`
  );
  assert.equal(remote.platform, 'win32');
  const length = process.argv.includes('--large') ? 100 * 1024 * 1024 : 3 * 256 * 1024 + 37;
  const source = path.join(directory, '中文附件.bin');
  const file = await open(source, 'wx');
  const block = Buffer.alloc(256 * 1024);
  for (let index = 0; index < block.length; index++) block[index] = index % 251;
  const digest = createHash('sha256');
  try {
    for (let offset = 0; offset < length; offset += block.length) {
      const bytes = block.subarray(0, Math.min(block.length, length - offset));
      let written = 0;
      while (written < bytes.length) {
        const result = await file.write(bytes, written, bytes.length - written);
        assert.ok(result.bytesWritten > 0);
        written += result.bytesWritten;
      }
      digest.update(bytes);
    }
  } finally {
    await file.close();
  }
  const expectedHash = digest.digest('hex');
  const staged = await uploadLocalFile(cdp, source, 100 * 1024 * 1024);
  remoteFiles.push(staged);
  assert.ok(path.win32.isAbsolute(staged.path));
  assert.equal(path.win32.basename(staged.path), '中文附件.bin');
  assert.notEqual(staged.path, source);
  const destination = path.join(directory, '已保存附件.bin');
  assert.equal(
    await saveNativeFile(cdp, { fileName: '中文附件.bin', filePath: staged.path }, destination),
    destination
  );
  const received = await readFile(destination);
  assert.equal(received.length, length);
  assert.equal(createHash('sha256').update(received).digest('hex'), expectedHash);

  const originalBytes = await readFile(new URL('../tests/fixtures/t07-image.png', import.meta.url));
  const thumbnailBytes = await readFile(
    new URL('../tests/fixtures/t07-thumb.png', import.meta.url)
  );
  const imagePath = path.join(directory, '原图.png');
  const thumbPath = path.join(directory, '缩略图.png');
  await writeFile(imagePath, originalBytes);
  await writeFile(thumbPath, thumbnailBytes);
  const image = await uploadLocalFile(cdp, imagePath, 20 * 1024 * 1024);
  remoteFiles.push(image);
  const thumb = await uploadLocalFile(cdp, thumbPath, 20 * 1024 * 1024);
  remoteFiles.push(thumb);
  const decoded = await cdp.evaluate<{ width: number; height: number }>(`(() => {
    const bytes = window.require('fs').readFileSync(${JSON.stringify(image.path)});
    const image = window.require('electron').nativeImage.createFromBuffer(bytes);
    if (image.isEmpty()) throw new Error('远端图片无法解码');
    return image.getSize();
  })()`);
  assert.deepEqual(decoded, { width: 640, height: 360 });
  const savedImage = path.join(directory, '已保存原图.png');
  await downloadNativeImage(
    cdp,
    { originalFilePath: image.path, filePath: thumb.path },
    savedImage
  );
  assert.deepEqual(await readFile(savedImage), originalBytes);
  assert.notDeepEqual(await readFile(savedImage), thumbnailBytes);

  await assert.rejects(saveNativeFile(cdp, { fileName: '未缓存.bin' }, destination), /缓存/);
  assert.equal(
    createHash('sha256')
      .update(await readFile(destination))
      .digest('hex'),
    expectedHash
  );
  assert.equal(
    (await readdir(directory)).some(name => name.endsWith('.part')),
    false
  );
  const paths = remoteFiles.map(item => item.path);
  for (const item of remoteFiles) await releaseRemoteFile(cdp, item);
  remoteFiles.length = 0;
  assert.deepEqual(
    await cdp.evaluate<boolean[]>(
      `${JSON.stringify(paths)}.map(file => window.require('fs').existsSync(file))`
    ),
    [false, false, false]
  );
  console.log(
    JSON.stringify(
      {
        driverPlatform: process.platform,
        driverHost: os.hostname(),
        kkPlatform: remote.platform,
        kkHost: remote.hostname,
        fileBytes: length,
        fileSha256: expectedHash,
        cachedFileSaved: true,
        originalImageSaved: true,
        remoteImageSize: decoded,
        remoteFilesReleased: true,
        messageOperations: 0,
      },
      null,
      2
    )
  );
} catch (error) {
  failure = error;
} finally {
  for (const item of remoteFiles) {
    try {
      await releaseRemoteFile(cdp, item);
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  try {
    await cdp.disconnect();
  } catch (error) {
    cleanupErrors.push(error);
  }
  try {
    await rm(directory, { recursive: true, force: true });
  } catch (error) {
    cleanupErrors.push(error);
  }
}
if (failure !== undefined || cleanupErrors.length) {
  throw new AggregateError(
    failure === undefined ? cleanupErrors : [failure, ...cleanupErrors],
    '远程文件验收或清理失败'
  );
}
