import path from 'node:path';
import type { CdpClient } from '../cdp/client.js';
import type { SendOptions, SendOutcome } from '../types/index.js';
import {
  encodeRendererPayload,
  RENDERER_IPC_HELPERS_SCRIPT,
  NATIVE_SEND_CONTEXT_SCRIPT,
  CONFIRM_SENT_MESSAGE_SCRIPT,
  SUBMIT_NATIVE_MESSAGE_SCRIPT,
} from './renderer-script.js';
import { createNativeMessageKey, isCdpUnavailableBeforeSend } from './send-status.js';

export async function sendNativeImage(
  cdp: CdpClient,
  imagePath: string,
  options: SendOptions = {},
  nativeKey?: string
): Promise<SendOutcome> {
  const startTime = Date.now();
  const cdpWasUnavailable = isCdpUnavailableBeforeSend(cdp);
  if (cdpWasUnavailable)
    return { status: 'failed', error: '图片发送前CDP未连接', isPreTrigger: true };
  const encoded = encodeRendererPayload({
    target: options.targetSessionId || '',
    msgFlag: nativeKey ?? createNativeMessageKey('image', options.operationId),
    fullPath: path.resolve(imagePath),
    timeout: options.verifyTimeoutMs ?? 8000,
  });
  const script = `
    (async () => {
      const electron = window.require ? window.require('electron') : null;
      const ipc = window.ipcRenderer || electron?.ipcRenderer;
      ${RENDERER_IPC_HELPERS_SCRIPT}
      ${NATIVE_SEND_CONTEXT_SCRIPT}
      ${CONFIRM_SENT_MESSAGE_SCRIPT}
      ${SUBMIT_NATIVE_MESSAGE_SCRIPT}
      const data = JSON.parse(decodeURIComponent(${encoded}));
      const cancellation = beginNativeSend(data.msgFlag);
      const callIpc = (channel, ...args) => callKairoIpcWithSignal(cancellation.signal, channel, ...args);
      try {
        let context, artwork, thumbPath, artworkPath;
        try {
          context = await readNativeSendContext(data.target);
          const fs = window.require('fs');
          const fileType = window.require('file-type');
          const nativeImage = electron.nativeImage;
          const decode = (bytes, file) => {
            const format = fileType(bytes);
            if (!format?.mime?.startsWith('image/')) throw new Error('不支持的图片格式: ' + file);
            const image = nativeImage.createFromBuffer(bytes);
            if (image.isEmpty()) throw new Error('图片无法解码: ' + file + ' (' + format.mime + ')');
            const { width, height } = image.getSize();
            if (!(width > 0 && height > 0)) throw new Error('图片尺寸无效: ' + file);
            return { image, width, height, size: bytes.length, mimetype: format.mime };
          };
          const stats = fs.statSync(data.fullPath);
          if (!stats.isFile()) throw new Error('不能发送非普通文件作为图片: ' + data.fullPath);
          if (stats.size > 20 * 1024 * 1024) throw new Error('图片大小超出限制 (20MB): ' + stats.size + ' bytes');
          const source = decode(fs.readFileSync(data.fullPath), data.fullPath);
          // 与KK9原版一致：最长边300像素、PNG缩略图，原图保持真实文件来源。
          const scale = Math.min(1, 300 / Math.max(source.width, source.height));
          const width = Math.max(1, Math.floor(source.width * scale));
          const height = Math.max(1, Math.floor(source.height * scale));
          const thumbnail = source.image.resize({ width, height, quality: 'best' }).toPNG();
          const handleRes = await callIpc('sendingImgBeforeHandle', thumbnail.toString('base64'), data.fullPath);
          if (handleRes?.code !== 0 || !handleRes.data) {
            throw new Error('sendingImgBeforeHandle失败 (' + handleRes?.code + '): ' + (handleRes?.error || handleRes?.message || JSON.stringify(handleRes)));
          }
          ({ thumbPath, artworkPath } = handleRes.data);
          // 原版会吞掉写入/复制异常；返回路径不能证明资源已生成。
          const thumb = decode(fs.readFileSync(thumbPath), thumbPath);
          artwork = decode(fs.readFileSync(artworkPath), artworkPath);
          if (thumb.mimetype !== 'image/png' || thumb.width !== width || thumb.height !== height)
            throw new Error('缩略图生成结果不符: ' + thumbPath);
          if (artwork.width !== source.width || artwork.height !== source.height || artwork.mimetype !== source.mimetype || artwork.size !== source.size)
            throw new Error('原图复制结果不符: ' + artworkPath);
          if (cancellation.signal.aborted) throw new Error('本轮图片发送已取消');
        } catch (error) {
          return { status: 'failed', error: '图片准备失败: ' + data.fullPath + '；' + String(error), isPreTrigger: true };
        }
        const { identity, session: targetSes, receiver } = context;
        const imgNode = {
          type: 1,
          height: artwork.height,
          width: artwork.width,
          size: artwork.size,
          isValid: true,
          filepath: thumbPath,
          filepath_h: artworkPath,
          mimetype: artwork.mimetype
        };
        const msgObj = {
          contentType: 4,
          content: {
            content: [imgNode],
            font: {
              fontFamily: 'Microsoft YaHei', fontSize: 14, fontColor: '#000000',
              fontBold: false, fontItalic: false, fontUnderline: false
            }
          },
          sender: identity.id,
          senderName: identity.name,
          senderNameEN: identity.name_en || '',
          senderNameTC: identity.name_tc || '',
          receiver,
          sendTime: Math.floor(Date.now() / 1000),
          sessionType: targetSes.type,
          sessionID: targetSes.id,
          atState: 1,
          atMemberIDList: [],
          status: 'sending',
          type: 0,
          msgFlag: data.msgFlag
        };
        const submission = await submitNativeMessage(msgObj, targetSes, data.timeout, cancellation.signal);
        if (submission.failure) return submission.failure;
        return { status: 'sent', messageId: String(submission.confirmedMessage.id), receipt: submission.receipt, isPreTrigger: false };
      } finally { cancellation.finish(); }
    })()
  `;
  try {
    const result = await cdp.evaluate<SendOutcome>(
      script,
      (options.verifyTimeoutMs ?? 8000) + 12000
    );
    if (!result || !['sent', 'failed', 'unknown'].includes(result.status))
      return { status: 'unknown', error: '底层图片IPC未返回有效结果', isPreTrigger: false };
    return { ...result, verifyLatencyMs: Date.now() - startTime };
  } catch (error) {
    return {
      status: 'unknown',
      error: `底层图片IPC发送异常: ${error instanceof Error ? error.message : String(error)}`,
      isPreTrigger: false,
      verifyLatencyMs: Date.now() - startTime,
    };
  }
}
