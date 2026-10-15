import path from 'node:path';
import type { CdpClient } from '../cdp/client.js';
import type { KK9FileInfo, KK9ImageInfo } from '../types/index.js';
import { DriverError } from '../utils/errors.js';
import { getOriginalImageUri, hasOriginalImageSource } from '../utils/image.js';
import { encodeRendererPayload, RENDERER_IPC_HELPERS_SCRIPT } from './renderer-script.js';
import {
  copyRemoteFileToLocal,
  createRemoteTempFile,
  releaseRemoteFile,
  REMOTE_FILE_LEASE_SCRIPT,
} from './file-transfer.js';

async function downloadNativeResource(
  cdp: CdpClient,
  uri: string,
  target: string,
  name: string,
  nonEmpty = false
): Promise<string> {
  const remote = await createRemoteTempFile(cdp, name);
  let operationError: Error | undefined;
  try {
    const encoded = encodeRendererPayload({ id: remote.id, uri });
    await cdp.evaluate(
      `
      (async () => {
        const electron = window.require('electron');
        const ipc = window.ipcRenderer || electron?.ipcRenderer;
        ${RENDERER_IPC_HELPERS_SCRIPT}
        ${REMOTE_FILE_LEASE_SCRIPT}
        const data = JSON.parse(decodeURIComponent(${encoded}));
        const lease = takeKairoFileLease(data.id);
        try {
          const response = await callKairoFileIpc(lease, 30000, undefined, 'download', {
            uri: data.uri, fullPath: lease.path, override: true
          });
          if (response?.code !== 0) {
            throw new Error('download (' + response?.code + '): ' + (response?.error || response?.message || '原生下载失败'));
          }
          const path = window.require('path');
          if (typeof response.data?.path !== 'string' || path.resolve(response.data.path) !== path.resolve(lease.path)) {
            throw new Error('download 未返回指定的 KK9 临时文件路径');
          }
        } finally {
          await lease.release();
        }
      })()
    `,
      35000
    );
    await copyRemoteFileToLocal(cdp, remote.path, target, { nonEmpty });
  } catch (error) {
    operationError = error instanceof Error ? error : new Error(String(error));
  }
  try {
    await releaseRemoteFile(cdp, remote);
  } catch (cleanupError) {
    if (operationError) {
      const message = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
      throw new AggregateError(
        [operationError, cleanupError],
        `${operationError.message}；清理 KK9 临时文件失败：${message}`
      );
    }
    throw cleanupError;
  }
  if (operationError) throw operationError;
  return target;
}

/** 原图缓存只在 KK9 机器检查；仅 ENOENT 表示允许改用原图 URI 下载。 */
export async function downloadNativeImage(
  cdp: CdpClient,
  image: KK9ImageInfo,
  fullPath: string
): Promise<string> {
  const target = path.resolve(fullPath);
  const uri = getOriginalImageUri(image);
  const cache = hasOriginalImageSource(image)
    ? image.originalFilePath
    : image.filePath || (image.url?.startsWith('file:') ? image.url : undefined);
  try {
    if (cache) {
      const encodedCache = encodeRendererPayload(cache);
      const cachedPath = await cdp.evaluate<string | null>(`
        (() => {
          const fs = window.require('fs');
          const path = window.require('path');
          const source = JSON.parse(decodeURIComponent(${encodedCache}));
          const file = source.startsWith('file:') ? window.require('url').fileURLToPath(source) : source;
          try {
            const stats = fs.statSync(file);
            if (!stats.isFile() || stats.size < 1) throw new Error('原图缓存不是非空普通文件：' + file);
            return path.resolve(file);
          } catch (error) {
            if (error?.code === 'ENOENT') return null;
            throw error;
          }
        })()
      `);
      if (cachedPath)
        return await copyRemoteFileToLocal(cdp, cachedPath, target, { nonEmpty: true });
    }
    if (!uri) throw new Error('图片缺少可下载的原图 URI');
    return await downloadNativeResource(cdp, uri, target, 'original-image', true);
  } catch (error) {
    throw new DriverError(
      `下载原图 ${uri || cache || '未知资源'} 到 ${target} 失败：${error instanceof Error ? error.message : String(error)}`,
      'IMAGE_DOWNLOAD_FAILED',
      error instanceof Error ? error : undefined
    );
  }
}

/** 普通附件优先使用 KK9 缓存；仅 ENOENT 或缺少缓存路径时通过 URI 原生下载。 */
export async function saveNativeFile(
  cdp: CdpClient,
  file: KK9FileInfo,
  fullPath: string
): Promise<string> {
  const target = path.resolve(fullPath);
  try {
    if (file.filePath) {
      const encodedCache = encodeRendererPayload(file.filePath);
      const cachedPath = await cdp.evaluate<string | null>(`
        (() => {
          const fs = window.require('fs');
          const path = window.require('path');
          const source = JSON.parse(decodeURIComponent(${encodedCache}));
          const file = source.startsWith('file:') ? window.require('url').fileURLToPath(source) : source;
          try {
            if (!fs.statSync(file).isFile()) throw new Error('普通文件缓存不是普通文件：' + file);
            return path.resolve(file);
          } catch (error) {
            if (error?.code === 'ENOENT') return null;
            throw error;
          }
        })()
      `);
      if (cachedPath) return await copyRemoteFileToLocal(cdp, cachedPath, target);
    }
    if (!file.uri) {
      if (file.filePath) throw new Error(`ENOENT：KK9 缓存不存在：${file.filePath}，缺少可下载的 URI`);
      throw new Error('普通文件缺少可用的 KK9 缓存和可下载的 URI');
    }
    return await downloadNativeResource(cdp, file.uri, target, 'attachment-file');
  } catch (error) {
    throw new DriverError(
      `保存文件 ${file.fileName}（KK9 缓存 ${file.filePath || '未缓存'}，URI ${file.uri || '无'}）到 ${target} 失败：${error instanceof Error ? error.message : String(error)}`,
      'FILE_SAVE_FAILED',
      error instanceof Error ? error : undefined
    );
  }
}
