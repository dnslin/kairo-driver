import fs from 'node:fs';
import path from 'node:path';
import mime from 'mime-types';
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

const MAX_IMAGE_SIZE_BYTES = 20 * 1024 * 1024; // 20MB
function imagePreflightFailure(error: unknown): SendOutcome {
  const message = error instanceof Error ? error.message : String(error);
  return {
    status: 'failed',
    error: `图片文件预检失败: ${message}`,
    isPreTrigger: true,
  };
}

function getImageDimensions(buffer: Buffer): { width: number; height: number } {
  // PNG: bytes 16-24 hold width (16..19) and height (20..23) big-endian
  if (
    buffer.length >= 24 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47
  ) {
    return {
      width: buffer.readUInt32BE(16),
      height: buffer.readUInt32BE(20),
    };
  }

  // GIF: bytes 6-10 hold width (6..7) and height (8..9) little-endian
  if (buffer.length >= 10 && buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) {
    return {
      width: buffer.readUInt16LE(6),
      height: buffer.readUInt16LE(8),
    };
  }

  // BMP: bytes 18-26 hold width (18..21) and height (22..25) little-endian
  if (buffer.length >= 26 && buffer[0] === 0x42 && buffer[1] === 0x4d) {
    return {
      width: Math.abs(buffer.readInt32LE(18)),
      height: Math.abs(buffer.readInt32LE(22)),
    };
  }

  // JPEG / JPG parse SOF markers (SOF0 = 0xC0, SOF2 = 0xC2, etc.)
  if (buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2;
    while (offset < buffer.length) {
      if (buffer[offset] !== 0xff) {
        offset++;
        continue;
      }
      const marker = buffer[offset + 1];
      // SOF0 (0xC0), SOF1 (0xC1), SOF2 (0xC2)
      if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
        if (offset + 9 <= buffer.length) {
          const height = buffer.readUInt16BE(offset + 5);
          const width = buffer.readUInt16BE(offset + 7);
          return { width, height };
        }
      }
      if (marker === 0xd9 || marker === 0xda) {
        break;
      }
      if (offset + 4 <= buffer.length) {
        const length = buffer.readUInt16BE(offset + 2);
        offset += 2 + length;
      } else {
        break;
      }
    }
  }

  return { width: 300, height: 300 };
}

export async function sendNativeImage(
  cdp: CdpClient,
  imagePath: string,
  options: SendOptions = {},
  nativeKey?: string
): Promise<SendOutcome> {
  const fullPath = path.resolve(imagePath);
  if (!fs.existsSync(fullPath)) {
    return {
      status: 'failed',
      error: `图片文件不存在: ${fullPath}`,
      isPreTrigger: true,
    };
  }

  let stats: fs.Stats;
  try {
    stats = fs.statSync(fullPath);
  } catch (error) {
    return imagePreflightFailure(error);
  }
  if (stats.isDirectory()) {
    return {
      status: 'failed',
      error: `不能发送目录作为图片: ${fullPath}`,
      isPreTrigger: true,
    };
  }
  if (stats.size > MAX_IMAGE_SIZE_BYTES) {
    return {
      status: 'failed',
      error: `图片大小超出限制 (20MB): ${stats.size} bytes`,
      isPreTrigger: true,
    };
  }

  const mimeType = mime.lookup(fullPath) || 'image/png';
  if (!mimeType.startsWith('image/')) {
    return {
      status: 'failed',
      error: `不支持的图片格式: ${mimeType}`,
      isPreTrigger: true,
    };
  }

  let buffer: Buffer;
  try {
    buffer = fs.readFileSync(fullPath);
  } catch (error) {
    return imagePreflightFailure(error);
  }
  const { width, height } = getImageDimensions(buffer);
  const base64Thumb = buffer.toString('base64');
  const startTime = Date.now();
  const cdpWasUnavailable = isCdpUnavailableBeforeSend(cdp);

  const payloadData = {
    target: options.targetSessionId || '',
    msgFlag: nativeKey ?? createNativeMessageKey('image', options.operationId),
    fullPath,
    base64Thumb,
    mimeType,
    width,
    height,
    timeout: options.verifyTimeoutMs ?? 8000,
  };

  const encoded = encodeRendererPayload(payloadData);

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
      let context;
      try { context = await readNativeSendContext(data.target); }
      catch (error) { return { status: 'failed', error: String(error), isPreTrigger: true }; }
      const { identity, session: targetSes, receiver } = context;
      const myUid = identity.id;
      const myName = identity.name;

      // 1. 调用 Native 预处理图片与缩略图
      const handleRes = await callIpc('sendingImgBeforeHandle', data.base64Thumb, data.fullPath);
      if (!handleRes || handleRes.code !== 0 || !handleRes.data) {
        return {
          status: 'failed',
          error: 'sendingImgBeforeHandle 失败: ' + (handleRes?.message || JSON.stringify(handleRes)),
          isPreTrigger: true
        };
      }

      const thumbPath = handleRes.data.thumbPath;
      const artworkPath = handleRes.data.artworkPath;

      // 2. 构造 PicText 图片消息对象
      const imgNode = {
        type: 1,
        height: data.height,
        width: data.width,
        isValid: true,
        filepath: thumbPath,
        filepath_h: artworkPath,
        mimetype: data.mimeType
      };

      const msgObj = {
        contentType: 4, // PicText
        content: {
          content: [imgNode],
          font: {
            fontFamily: 'Microsoft YaHei',
            fontSize: 14,
            fontColor: '#000000',
            fontBold: false,
            fontItalic: false,
            fontUnderline: false
          }
        },
        sender: myUid,
        senderName: myName,
        senderNameEN: myName,
        senderNameTC: myName,
        receiver,
        sendTime: Math.floor(Date.now() / 1000),
        sessionType: targetSes.type,
        sessionID: targetSes.id,
        atState: 1,
        atMemberIDList: [],
        status: 'sending',
        type: 0,
        msgFlag: data.msgFlag,
        filepath: artworkPath
      };

      const submission = await submitNativeMessage(msgObj, targetSes, data.timeout, cancellation.signal);
      if (submission.failure) return submission.failure;
      // 未切换的图片显示通知保持可用；只在业务确认后执行。
      const app = document.querySelector('#app')?.__vue__;
      const main = document.querySelector('.main-page')?.__vue__;
      const bus = main?.$bus || app?.$bus || window.vueBus;
      const store = app?.$store || window.$store;
      try {
        store?.commit('updateSesLastMsg', { sesUUID: targetSes.sesUUID, message: submission.confirmedMessage });
        bus?.$emit(targetSes.sesUUID + '-msg', [submission.confirmedMessage]);
      } catch (error) { console.warn('[KairoDriver] 图片显示通知失败: ' + String(error)); }
      return { status: 'sent', messageId: String(submission.confirmedMessage.id), receipt: submission.receipt, isPreTrigger: false };
      } finally { cancellation.finish(); }
    })()
  `;

  try {
    const result = await cdp.evaluate<SendOutcome>(
      script,
      (options.verifyTimeoutMs ?? 8000) + 12000
    );
    if (!result || !['sent', 'failed', 'unknown'].includes(result.status)) {
      return { status: 'unknown', error: '底层图片IPC未返回有效结果', isPreTrigger: false };
    }
    return { ...result, verifyLatencyMs: Date.now() - startTime };
  } catch (err) {
    const isPreTrigger = cdpWasUnavailable;
    return {
      status: isPreTrigger ? 'failed' : 'unknown',
      error: `底层图片 IPC 发送异常: ${err instanceof Error ? err.message : String(err)}`,
      isPreTrigger,
      verifyLatencyMs: Date.now() - startTime,
    };
  }
}
