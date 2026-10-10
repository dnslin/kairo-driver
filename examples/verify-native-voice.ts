import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { CdpClient, callIpcToData, createNativeMessageKey, KK9Driver } from '../src/index.js';
import type { KK9Session, KK9VoiceOptions } from '../src/types/index.js';

// 仅运行本轮明确授权的两个目标，禁止同名群716827。
const uid = '5761', privateId = '716791', groupId = '793803';
assert.equal(process.env['KK9_REAL_TEST_CONFIRM'], `${uid}:${privateId}:${groupId}`, '缺少双目标确认门禁');
assert.equal(process.env['KK9_STAGE1_CONFIRM'], `${uid}:3585:${privateId}`, '缺少私聊确认门禁');
const config = {
  url: process.env['CDP_URL'] || 'http://127.0.0.1:9222',
  pageMatch: process.env['PAGE_MATCH'] || 'renderer.html',
};
const driver = new KK9Driver({ cdp: config, rejectExistingBridge: true });
const probe = new CdpClient(config);
const runId = randomUUID();
const directory = await mkdtemp(path.join(os.tmpdir(), 'kairo-t10-'));
const sourcePath = path.join(directory, 'T10-two-tones.wav');
const operations = [privateId, groupId].map((id, index) => ({
  id, operationId: `${runId}:${index}`, key: createNativeMessageKey('voice', `${runId}:${index}`),
}));
const results: Array<Record<string, unknown>> = [];
const report: Record<string, unknown> = {
  运行ID: runId, 目标: results, 通过: false, 接收端播放: '未确认',
  未真机触发: ['编码器故障', '服务器业务失败', '上传失败-9'],
};
let targets: KK9Session[] = [];
let connected = false;
let captured = false;

async function save(): Promise<void> {
  await mkdir(new URL('../tmp/', import.meta.url), { recursive: true });
  for (const name of [`t10-${runId}.json`, 't10-live-evidence.json'])
    await writeFile(new URL(`../tmp/${name}`, import.meta.url), JSON.stringify(report, null, 2) + '\n');
}
async function history(id: string): Promise<Array<Record<string, unknown>>> {
  const response = await callIpcToData<Array<Record<string, unknown>>>(probe, 'getMessages', [
    { sessionID: Number(id), count: 100, endIdx: 2147483647, sendTime: 0 },
  ]);
  assert.equal(response.code, 0, '原生语音历史读取失败');
  assert.ok(Array.isArray(response.data));
  return response.data;
}
function fail(stage: string, error: unknown): void {
  report[stage] = String(error);
  report['通过'] = false;
  process.exitCode = 1;
}
function createAudio(): Buffer {
  // 2.013秒、16kHz双声道：低音后接高音，末尾仍有声，覆盖重采样、混音及不足一帧的结尾。
  const rate = 16000, frames = 32208, channels = 2;
  const wav = Buffer.alloc(44 + frames * channels * 2);
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(channels, 22);
  wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate * channels * 2, 28);
  wav.writeUInt16LE(channels * 2, 32); wav.writeUInt16LE(16, 34);
  wav.write('data', 36); wav.writeUInt32LE(wav.length - 44, 40);
  for (let frame = 0; frame < frames; frame++) {
    const frequency = frame < rate ? 440 : 880;
    const sample = Math.round(Math.sin(2 * Math.PI * frequency * frame / rate) * 10000);
    wav.writeInt16LE(sample, 44 + frame * 4);
    wav.writeInt16LE(Math.round(sample * 0.8), 46 + frame * 4);
  }
  return wav;
}

try {
  await driver.connect();
  await probe.connect();
  connected = true;
  assert.equal(await driver.getCurrentUserId(), uid);
  assert.equal((await driver.getUserProfile(uid))?.loginName, '0123040139');
  const sessions = await driver.getSessions();
  const privateSession = sessions.find(session => session.id === privateId);
  const groupSession = sessions.find(session => session.id === groupId);
  assert.ok(privateSession && groupSession, '授权原生会话不存在');
  assert.equal(privateSession.nativeType, 0);
  assert.equal(privateSession.receiverId, '3585');
  assert.equal((await driver.getEmployeeBySession(privateSession))?.loginName, 'int2024');
  assert.equal(groupSession.name, '测试123');
  assert.equal(groupSession.nativeType, 1);
  assert.equal(groupSession.receiverId, '29467');
  targets = [privateSession, groupSession];
  report['身份'] = { uid, login: '0123040139', privateId, peerId: '3585', peerLogin: 'int2024', groupId, groupReceiver: '29467', groupName: '测试123' };
  await writeFile(sourcePath, createAudio());
  await probe.evaluate(`(() => {
    const ipc = window.ipcRenderer || window.require('electron').ipcRenderer;
    const keys = ${JSON.stringify(operations.map(operation => operation.key))};
    const capture = { requests: [], receipts: [], drafts: new Set() };
    const send = ipc.send, emit = ipc.emit;
    ipc.send = function(channel, request, ...rest) {
      const method = request?.args?.[0], message = request?.args?.[1];
      if (channel === 'data' && keys.includes(message?.msgFlag) && ['insertSendBefoeMsg','sendMessageNew'].includes(method)) {
        capture.requests.push({ method, key: message.msgFlag, sessionId: String(message.sessionID),
          duration: message.content.duration, dataBytes: window.require('buffer').Buffer.from(message.content.data, 'base64').length,
          hasFilepath: Object.prototype.hasOwnProperty.call(message.content, 'filepath') });
        if (method === 'sendMessageNew') capture.drafts.add(String(message.id));
      }
      return send.call(this, channel, request, ...rest);
    };
    ipc.emit = function(channel, event, payload, ...rest) {
      const value = payload?.args;
      if (String(channel).endsWith('-sendMsgCallback') && capture.drafts.has(String(value?.msgID))) {
        let ext = value.data?.ext, parseError;
        try { if (typeof ext === 'string') ext = JSON.parse(ext); }
        catch (error) { parseError = String(error); ext = undefined; }
        capture.receipts.push({ draftId: String(value.msgID), code: value.code, businessCode: ext?.status ?? null,
          messageId: String(value.data?.id), sessionId: String(value.data?.sessionID), msgIdx: value.data?.msgIdx,
          ...(parseError ? { parseError } : {}) });
      }
      return emit.call(this, channel, event, payload, ...rest);
    };
    capture.cleanup = () => { ipc.send = send; ipc.emit = emit; delete window.__kairo_t10_capture; };
    window.__kairo_t10_capture = capture;
  })()`);
  captured = true;
  for (const operation of operations) {
    const target = targets.find(session => session.id === operation.id)!;
    const input: KK9VoiceOptions = operation.id === privateId
      ? { text: '这是语音测试，春风送暖，测试结束。' }
      : { filePath: sourcePath };
    const options = { targetSessionId: target.id, operationId: operation.operationId, verifyTimeoutMs: 20000 };
    let result = await driver.sendVoice(input, options);
    if (result.status === 'unknown') result = await driver.getSendStatus(operation.operationId);
    if (result.status === 'failed' && result.isPreTrigger && result.error?.includes('Edge TTS')) {
      fail('真实TTS错误', result.error);
      results.push({ 原生会话: target.id, 输入: '真实外部TTS', 结果: result });
      continue;
    }
    assert.equal(result.status, 'sent', result.error || '无本次业务确认，禁止重发');
    const record = (await history(target.id)).find(message => message['msgFlag'] === operation.key);
    assert.ok(record, '本轮正式语音记录不存在');
    assert.equal(String(record['id']), result.messageId);
    assert.equal(String(record['sender']), uid);
    assert.equal(String(record['receiver']), target.receiverId);
    assert.equal(String(record['sessionID']), target.id);
    assert.equal(record['sessionType'], target.nativeType);
    assert.equal(record['contentType'], 2);
    // 实际正式记录携带的AMR与KK9生成的WAV逐采样对照；不把这些当作接收端听感。
    const resource = await probe.evaluate<{ duration: number; dataBytes: number; decodedSamples: number; seconds: number; filepath: string; wavBytes: number; tailRms: number }>(`(() => {
      const fs = window.require('fs'), path = window.require('path'), Buffer = window.require('buffer').Buffer;
      const content = ${JSON.stringify(typeof record['content'] === 'string' ? JSON.parse(record['content']) : record['content'])};
      const amr = window.require(path.join(window.process.resourcesPath, 'app.asar/dist/electron/lib/amrnb'));
      const bytes = Buffer.from(content.data, 'base64'), decoded = amr.decode(bytes), expected = Buffer.from(amr.toWAV(bytes));
      const actual = fs.readFileSync(content.filepath);
      if (!actual.equals(expected)) throw new Error('正式播放WAV与正式AMR回解不一致');
      let energy = 0; const start = Math.max(0, decoded.length - 1200);
      for (let i = start; i < decoded.length; i++) energy += decoded[i] * decoded[i];
      return { duration: content.duration, dataBytes: bytes.length, decodedSamples: decoded.length,
        seconds: decoded.length / 8000, filepath: content.filepath, wavBytes: actual.length,
        tailRms: Math.sqrt(energy / (decoded.length - start)) };
    })()`);
    assert.equal(resource.duration, Math.ceil(resource.seconds), '显示秒数与实际编码时长不符');
    assert.notEqual(resource.filepath, sourcePath, '不能用原始输入路径冒充正式播放资源');
    if (operation.id === groupId) {
      assert.equal(resource.decodedSamples, 16160, '不足一帧的有效结尾被丢弃');
      assert.ok(resource.tailRms > 0.05, '本地音频末尾高音丢失');
    }
    const repeated = await driver.sendVoice(input, options);
    const queried = await driver.getSendStatus(operation.operationId);
    assert.equal(repeated.messageId, result.messageId);
    assert.equal(queried.messageId, result.messageId);
    const capture = await probe.evaluate<{ requests: Array<{ method: string; key: string; hasFilepath: boolean }>; receipts: Array<Record<string, unknown>> }>(
      '({ requests: window.__kairo_t10_capture.requests, receipts: window.__kairo_t10_capture.receipts })'
    );
    for (const method of ['insertSendBefoeMsg', 'sendMessageNew']) {
      const requests = capture.requests.filter(request => request.key === operation.key && request.method === method);
      assert.equal(requests.length, 1, '防重或只读查询产生额外提交');
      assert.equal(requests[0]!.hasFilepath, false, '准备内容不能携带原始输入路径');
    }
    const receipt = capture.receipts.find(value => value['messageId'] === result.messageId && value['sessionId'] === target.id);
    assert.ok(receipt, '缺少本次独立原生业务回执');
    assert.equal(receipt['code'], 0);
    assert.ok(receipt['businessCode'] === null || receipt['businessCode'] === 0);
    assert.equal(receipt['draftId'], result.receipt?.draftId);
    assert.equal(receipt['msgIdx'], record['msgIdx']);
    results.push({ 原生会话: target.id, 输入: operation.id === privateId ? '真实外部TTS' : '自建双音WAV',
      正式ID: result.messageId, 索引: record['msgIdx'], operationId: operation.operationId,
      回执: receipt, 资源: resource, 重复及查询无新增: true });
  }
  await save();
  if (process.argv.includes('--inspect')) {
    const input = createInterface({ input: process.stdin, output: process.stdout });
    console.log('T10_READY：保留已发送语音供接收端播放。confirmed表示接收端确认现有两条均有声、内容正确且结尾完整；finish仅清理，不代表播放通过。');
    console.log(JSON.stringify(report, null, 2));
    for await (const line of input) {
      if (line.trim() === 'confirmed') {
        report['接收端播放'] = '用户确认现有两条均有声、内容正确且结尾完整';
        report['通过'] = !process.exitCode && results.length === 2;
        break;
      }
      if (line.trim() === 'finish') break;
    }
    input.close();
  }
} catch (error) {
  fail('错误', error);
} finally {
  const cleaned: Array<Record<string, unknown>> = [];
  if (connected) {
    for (const operation of operations) {
      const target = targets.find(session => session.id === operation.id);
      if (!target) continue;
      try {
        const records = (await history(target.id)).filter(message => message['msgFlag'] === operation.key && String(message['sender']) === uid);
        for (const record of records) {
          const id = String(record['id']);
          assert.equal(await driver.recallMessage(id, target), true, '本轮本人语音清理失败');
          const recalled = (await history(target.id)).find(message => String(message['id']) === id);
          assert.ok(recalled && /^[CD]/.test(String(recalled['msgFlag'])));
          cleaned.push({ 原生会话: target.id, 正式ID: id, 已撤回: true });
        }
      } catch (error) { fail('语音清理错误', error); }
    }
    if (captured) {
      try {
        report['独立采集'] = await probe.evaluate('({ requests: window.__kairo_t10_capture.requests, receipts: window.__kairo_t10_capture.receipts })');
        await probe.evaluate('window.__kairo_t10_capture.cleanup()');
      } catch (error) { fail('采集清理错误', error); }
    }
  }
  report['清理'] = cleaned;
  try { await driver.disconnect(); } catch (error) { fail('Driver退出错误', error); }
  if (connected) {
    try {
      report['退出后'] = await probe.evaluate('({ 采集残留: !!window.__kairo_t10_capture, DriverHook残留: !!window.__kairo_bridge_cleanup, 在途发送: window.__kairo_pending_sends?.size || 0 })');
    } catch (error) { fail('退出核对错误', error); }
  }
  await probe.disconnect();
  await rm(directory, { recursive: true, force: true });
  report['自建临时文件已删除'] = true;
  await save();
  console.log(JSON.stringify(report, null, 2));
}
