import assert from 'node:assert/strict';
import os from 'node:os';
import { CdpClient } from '@kairo/driver';
import { prepareVoice } from '../dist/bridge/voice-ops.js';

// 只调用真实合成和 KK9 编解码器；不创建 Driver、不安装 Hook、不调用聊天 IPC。
const cdp = new CdpClient({
  url: process.env['CDP_URL'] || 'http://172.16.0.18:9222',
  pageMatch: process.env['PAGE_MATCH'] || 'renderer.html',
});
const errors: unknown[] = [];
cdp.on('error', error => errors.push(error));
let evidence: Record<string, unknown> | undefined;
try {
  await cdp.connect();
  const hookBefore = await cdp.evaluate<boolean>('!!window.__kairo_bridge_cleanup');
  const started = Date.now();
  const prepared = await prepareVoice(cdp, { text: '这是独立语音合成验证，不发送聊天消息。' });
  const bytes = Buffer.from(prepared.data, 'base64');
  assert.equal(bytes.subarray(0, 6).toString('ascii'), '#!AMR\n');
  const decoded = await cdp.evaluate<{
    samples: number;
    seconds: number;
    rms: number;
    finite: boolean;
    hookPresent: boolean;
  }>(`(() => {
    const path = window.require('path');
    const amr = window.require(path.join(
      window.process.resourcesPath, 'app.asar/dist/electron/lib/amrnb'
    ));
    const bytes = window.require('buffer').Buffer.from(${JSON.stringify(prepared.data)}, 'base64');
    const audio = amr.decode(bytes);
    let energy = 0;
    let finite = true;
    for (const sample of audio) {
      finite = finite && Number.isFinite(sample);
      energy += sample * sample;
    }
    return {
      samples: audio.length, seconds: audio.length / 8000,
      rms: Math.sqrt(energy / audio.length), finite,
      hookPresent: !!window.__kairo_bridge_cleanup
    };
  })()`);
  assert.equal(decoded.finite, true, 'AMR 回解包含无效采样');
  assert.ok(decoded.seconds > 1, '未得到有效时长');
  assert.ok(decoded.rms > 0.001, '合成音频没有有效声音');
  assert.equal(prepared.duration, Math.ceil(decoded.seconds));
  assert.equal(decoded.hookPresent, hookBefore, '现有 Hook 状态发生变化');
  evidence = {
    驱动主机: os.hostname(),
    代理: process.env['HTTPS_PROXY']?.trim() || process.env['HTTP_PROXY']?.trim() || '直连',
    AMR字节: bytes.length,
    显示秒数: prepared.duration,
    回解采样数: decoded.samples,
    实际秒数: decoded.seconds,
    RMS: decoded.rms,
    耗时毫秒: Date.now() - started,
    原有Hook存在: hookBefore,
    Hook状态不变: true,
    聊天操作: 0,
  };
} catch (error) {
  errors.push(error);
} finally {
  try {
    await cdp.disconnect();
  } catch (error) {
    errors.push(error);
  }
}
if (errors.length) throw new AggregateError(errors, '独立语音验收或退出失败');
assert.equal(cdp.getStatus(), 'disconnected');
console.log(JSON.stringify({ ...evidence, 独立CDP已断开: true }, null, 2));
