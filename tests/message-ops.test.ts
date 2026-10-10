import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CdpClient } from '../src/cdp/client.js';
import { readImageAsBase64, saveImageToFile } from '../src/utils/image.js';
import type { KK9ImageInfo } from '../src/types/index.js';
import { BridgeMessageOps } from '../src/bridge/message-ops.js';
import { FakeIpcRenderer, runRendererScript } from './helpers/renderer-runtime.js';

describe('原生历史会话与消息身份边界', () => {
  it('原生会话 ID 恰好等于当前 UID 时不能纠正成对端界面标识', async () => {
    const ipc = new FakeIpcRenderer(() => ({ code: 0, data: [{ id: 1001, msgIdx: 88, sessionID: 91001, sender: 91002, content: '历史记录' }] }));
    const cdp = { evaluate: (script: string) => runRendererScript(script, { window: { ipcRenderer: ipc }, setTimeout, clearTimeout }) } as unknown as CdpClient;
    const messages = await new BridgeMessageOps(cdp).getRecentMessages(
      { id: '91001', name: '同号会话', type: 'private', nativeType: 0, receiverId: '91002', unread: false }, 1, 91001
    );
    expect(messages).toMatchObject([{ id: '1001', msgIdx: 88, sessionId: '91001', direction: 'inbound' }]);
  });

  it('只有消息索引而没有原生消息 ID 时不得把索引作为消息身份', async () => {
    const ipc = new FakeIpcRenderer(() => ({ code: 0, data: [{ msgIdx: 88, sessionID: 93001, sender: 91002, content: '缺少原生消息 ID' }] }));
    const cdp = { evaluate: (script: string) => runRendererScript(script, { window: { ipcRenderer: ipc }, setTimeout, clearTimeout }) } as unknown as CdpClient;
    await expect(new BridgeMessageOps(cdp).getRecentMessages(
      { id: '93001', name: '员工甲', type: 'private', nativeType: 0, receiverId: '91002', unread: false }, 1
    )).resolves.toEqual([]);
  });
});

describe('图片文件工具', () => {
    it('应能正确将图片读取为 Base64 Data URL 并另存为指定路径', () => {
      const tmpSrc = path.resolve('tmp_test_src.png');
      const tmpDst = path.resolve('tmp_test_dst.png');
      fs.writeFileSync(tmpSrc, Buffer.from('fake_png_data'));

      try {
        const imageInfo: KK9ImageInfo = {
          filePath: tmpSrc,
          mimeType: 'image/png',
        };

        const base64 = readImageAsBase64(imageInfo);
        expect(base64).toBe(`data:image/png;base64,${Buffer.from('fake_png_data').toString('base64')}`);

        const saved = saveImageToFile(imageInfo, tmpDst);
        expect(saved).toBe(true);
        expect(fs.readFileSync(tmpDst)).toEqual(fs.readFileSync(tmpSrc));
      } finally {
        if (fs.existsSync(tmpSrc)) fs.unlinkSync(tmpSrc);
        if (fs.existsSync(tmpDst)) fs.unlinkSync(tmpDst);
      }
    });

    it('不存在的文件应安全返回 null / false', () => {
      const imageInfo: KK9ImageInfo = {
        filePath: './non_existent_path_xyz.png',
      };

      expect(readImageAsBase64(imageInfo)).toBeNull();
      expect(saveImageToFile(imageInfo, './anywhere.png')).toBe(false);
    });
});
