import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CdpClient, KK9Driver, callIpcToData, createNativeMessageKey } from '@kairo/driver';
import type { KK9Session, SendResult } from '@kairo/driver';
import {
  createRemoteTempFile,
  releaseRemoteFile,
  REMOTE_FILE_LEASE_SCRIPT,
} from '../dist/bridge/file-transfer.js';
import { RENDERER_IPC_HELPERS_SCRIPT } from '../dist/bridge/renderer-script.js';

const [uid, login, privateId, peerId, peerLogin, groupId, groupReceiver, groupName, onlySessionId] =
  process.argv.slice(2);
assert.ok(
  uid && login && privateId && peerId && peerLogin && groupId && groupReceiver && groupName,
  '参数：登录UID 登录账号 私聊原生ID 对端UID 对端账号 群原生ID 群接收对象 群精确名'
);
assert.ok(
  !onlySessionId || onlySessionId === privateId || onlySessionId === groupId,
  '可选第九参数只能选择已授权私聊或群原生ID'
);
const selectedIds = onlySessionId ? [onlySessionId] : [privateId, groupId];
assert.equal(
  process.env['KK9_REAL_TEST_CONFIRM'],
  `${uid}:${privateId}:${groupId}`,
  '缺少双目标确认门禁'
);
assert.equal(
  process.env['KK9_STAGE1_CONFIRM'],
  `${uid}:${peerId}:${privateId}`,
  '缺少私聊确认门禁'
);
const config = {
  url: process.env['CDP_URL'] || 'http://127.0.0.1:9222',
  pageMatch: process.env['PAGE_MATCH'] || 'renderer.html',
};
const driver = new KK9Driver({ cdp: config, rejectExistingBridge: true });
const probe = new CdpClient(config);
const runId = randomUUID();
const directory = await mkdtemp(path.join(os.tmpdir(), 'kairo-remote-send-'));
const reportPath = new URL(`../tmp/remote-send-${runId}.json`, import.meta.url);
const filePath = path.join(directory, `Kairo远程验证-${runId.slice(0, 8)}.txt`);
const imagePath = path.join(directory, 'Kairo远程验证.png');
const voicePath = path.join(directory, 'Kairo远程验证.wav');
const imageBytes = await readFile(new URL('../tests/fixtures/t07-image.png', import.meta.url));
const fileBytes = Buffer.alloc(256 * 1024 + 37, 'Kairo remote CDP attachment verification.\n');
fileBytes.write(
  `Kairo 远程附件验证\n运行ID：${runId}\n此文件用于核对跨机器上传内容，无需回复。\n`,
  0,
  'utf8'
);
const operations = selectedIds.flatMap(id =>
  (['image', 'file', 'voice'] as const).map(kind => ({
    id,
    kind,
    operationId: `${runId}:${id}:${kind}`,
    key: createNativeMessageKey(kind, `${runId}:${id}:${kind}`),
  }))
);
interface CapturedRequest {
  method: string;
  key: string;
  path?: string;
  filename?: string;
  hasFilepath: boolean;
}
interface CapturedReceipt {
  key: string;
  draftId: string;
  code: number;
  businessCode: number | null;
  messageId: string;
  sessionId: string;
  msgIdx: number;
}
const results: Array<Record<string, unknown>> = [];
const report: Record<string, unknown> = {
  运行ID: runId,
  通过: false,
  Driver平台: process.platform,
  目标: results,
  运行目标: selectedIds,
  身份: { uid, login, privateId, peerId, peerLogin, groupId, groupReceiver, groupName },
  消息保留: true,
  接收端人工展示及播放: '未确认',
  文字TTS: '本轮仅验证文件语音，不重试此前403',
};
let connected = false;
let captured = false;
let failure: unknown;
const cleanupErrors: unknown[] = [];

async function saveReport(): Promise<void> {
  await mkdir(new URL('../tmp/', import.meta.url), { recursive: true });
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
}
function createAudio(): Buffer {
  const rate = 16000,
    frames = 32208,
    channels = 2;
  const wav = Buffer.alloc(44 + frames * channels * 2);
  wav.write('RIFF');
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(channels, 22);
  wav.writeUInt32LE(rate, 24);
  wav.writeUInt32LE(rate * channels * 2, 28);
  wav.writeUInt16LE(channels * 2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(wav.length - 44, 40);
  for (let frame = 0; frame < frames; frame++) {
    const frequency = frame < rate ? 440 : 880;
    const sample = Math.round(Math.sin((2 * Math.PI * frequency * frame) / rate) * 10000);
    wav.writeInt16LE(sample, 44 + frame * 4);
    wav.writeInt16LE(Math.round(sample * 0.8), 46 + frame * 4);
  }
  return wav;
}

try {
  await probe.connect();
  connected = true;
  await probe.evaluate(`(() => {
    if (window.__kairo_remote_send_check) throw new Error('存在其他远程发送验收，拒绝覆盖');
    const ipc = window.ipcRenderer || window.require('electron').ipcRenderer;
    const editor = document.querySelector('.chat-editor, .message-editor, .chat-sendArea')?.__vue__;
    window.__kairo_remote_send_check = { baseline: { send: ipc.send, emit: ipc.emit,
      message: ipc.listenerCount('message'), privateCallback: ipc.listenerCount('0-${peerId}-sendMsgCallback'),
      groupCallback: ipc.listenerCount('1-${groupReceiver}-sendMsgCallback'),
      active: editor?.activedSes ? String(editor.activedSes.id) : null,
      transfers: window.__kairo_file_transfers?.size || 0 }, requests: [], receipts: [], drafts: new Map() };
  })()`);
  await driver.connect();
  assert.equal(await driver.getCurrentUserId(), uid, '实际登录UID不符');
  assert.equal((await driver.getUserProfile(uid))?.loginName, login, '实际登录账号不符');
  const sessions = await driver.getSessions();
  const privateSession = sessions.find(session => session.id === privateId);
  const groupSession = sessions.find(session => session.id === groupId);
  assert.ok(privateSession && groupSession, '授权会话不存在');
  assert.equal(privateSession.nativeType, 0);
  assert.equal(privateSession.receiverId, peerId);
  const peer = await driver.getEmployeeBySession(privateSession);
  assert.equal(peer?.loginName, peerLogin, '私聊对端账号不符');
  assert.equal(peer?.name, '董仕林', '私聊对端姓名不符');
  assert.equal(groupSession.name, groupName);
  assert.equal(groupSession.nativeType, 1);
  assert.equal(groupSession.receiverId, groupReceiver);
  const targets: KK9Session[] = [privateSession, groupSession];
  await writeFile(filePath, fileBytes);
  await writeFile(imagePath, imageBytes);
  await writeFile(voicePath, createAudio());
  await probe.evaluate(`(() => {
    const ipc = window.ipcRenderer || window.require('electron').ipcRenderer;
    const capture = window.__kairo_remote_send_check;
    const keys = ${JSON.stringify(operations.map(operation => operation.key))};
    const send = ipc.send, emit = ipc.emit;
    ipc.send = function(channel, request, ...rest) {
      const method = request?.args?.[0], message = request?.args?.[1];
      if (channel === 'data' && keys.includes(message?.msgFlag) && ['insertSendBefoeMsg','sendMessageNew'].includes(method)) {
        const content = message.content;
        capture.requests.push({ method, key: message.msgFlag, path: content?.filepath,
          filename: content?.filename, hasFilepath: Object.prototype.hasOwnProperty.call(content || {}, 'filepath') });
        if (method === 'sendMessageNew') capture.drafts.set(String(message.id), message.msgFlag);
      }
      return send.call(this, channel, request, ...rest);
    };
    ipc.emit = function(channel, event, payload, ...rest) {
      const value = payload?.args, key = capture.drafts.get(String(value?.msgID));
      if (String(channel).endsWith('-sendMsgCallback') && key) {
        let ext = value.data?.ext, parseError;
        try { if (typeof ext === 'string') ext = JSON.parse(ext); }
        catch (error) { parseError = String(error); }
        capture.receipts.push({ key, draftId: String(value.msgID), code: value.code, businessCode: ext?.status ?? null,
          messageId: String(value.data?.id), sessionId: String(value.data?.sessionID), msgIdx: value.data?.msgIdx,
          ...(parseError ? { parseError } : {}) });
      }
      return emit.call(this, channel, event, payload, ...rest);
    };
    capture.cleanup = () => { ipc.send = send; ipc.emit = emit; delete capture.cleanup; };
  })()`);
  captured = true;
  for (const operation of operations) {
    const target = targets.find(session => session.id === operation.id)!;
    assert.equal(await driver.getCurrentUserId(), uid, '发送前登录身份发生变化');
    const options = {
      targetSessionId: target.id,
      operationId: operation.operationId,
      verifyTimeoutMs: 20000,
    };
    const inputPath =
      operation.kind === 'image' ? imagePath : operation.kind === 'file' ? filePath : voicePath;
    const evidence: Record<string, unknown> = {
      原生会话: target.id,
      类型: operation.kind,
      operationId: operation.operationId,
      状态: '准备发送',
    };
    results.push(evidence);
    await saveReport();
    let result: SendResult =
      operation.kind === 'image'
        ? await driver.sendImage(inputPath, options)
        : operation.kind === 'file'
          ? await driver.sendFile(inputPath, options)
          : await driver.sendVoice({ filePath: inputPath }, options);
    evidence['发送结果'] = result;
    await saveReport();
    if (result.status === 'unknown') result = await driver.getSendStatus(operation.operationId);
    assert.equal(result.status, 'sent', result.error || '结果未知或失败，禁止重发');
    const response = await callIpcToData<Record<string, unknown>>(probe, 'getMessageByMsgId', [
      Number(result.messageId),
    ]);
    assert.equal(response.code, 0);
    const record = response.data;
    assert.ok(record, '缺少本次准确正式记录');
    assert.equal(String(record['id']), result.messageId);
    assert.equal(String(record['sessionID']), target.id);
    assert.equal(String(record['sender']), uid);
    assert.equal(String(record['receiver']), target.receiverId);
    assert.equal(record['sessionType'], target.nativeType);
    assert.equal(record['msgFlag'], operation.key);
    assert.equal(
      record['contentType'],
      operation.kind === 'image' ? 4 : operation.kind === 'file' ? 3 : 2
    );
    const content = (
      typeof record['content'] === 'string' ? JSON.parse(record['content']) : record['content']
    ) as Record<string, unknown>;
    Object.assign(evidence, {
      正式ID: result.messageId,
      索引: record['msgIdx'],
      deviceID: record['deviceID'],
      状态: result.status,
      回执: result.receipt,
    });
    await saveReport();
    if (operation.kind === 'image') {
      const image = (content['content'] as Array<Record<string, unknown>>).find(
        node => node['type'] === 1
      );
      assert.ok(image && typeof image['uri_h'] === 'string' && image['uri_h'], '缺少服务器原图URI');
      assert.deepEqual([image['width'], image['height']], [640, 360]);
      const localImage = path.join(directory, `${target.id}-服务器原图.png`);
      await driver.downloadImage({ originalUri: image['uri_h'] }, localImage);
      assert.deepEqual(await readFile(localImage), imageBytes, '服务器原图与Linux输入不一致');
      evidence['服务器原图下载到Linux'] = {
        逐字节相同: true,
        字节数: imageBytes.length,
        宽: 640,
        高: 360,
      };
    } else if (operation.kind === 'file') {
      assert.equal(content['filename'], path.basename(filePath));
      assert.equal(Number(content['size']), fileBytes.length);
      const versions = await callIpcToData<Array<Record<string, unknown>>>(probe, 'getIMFileHis', [
        { fileId: Number(result.messageId), lastUpdate: 0 },
      ]);
      assert.equal(versions.code, 0);
      const resource = versions.data?.find(item => item['fileName'] === path.basename(filePath));
      assert.ok(resource && typeof resource['fileUri'] === 'string', '缺少服务器文件资源');
      assert.equal(Number(resource['fileSize']), fileBytes.length);
      const remote = await createRemoteTempFile(probe, path.basename(filePath));
      try {
        await probe.evaluate(
          `(async () => {
          const ipc = window.ipcRenderer || window.require('electron').ipcRenderer;
          ${RENDERER_IPC_HELPERS_SCRIPT}
          ${REMOTE_FILE_LEASE_SCRIPT}
          const lease = takeKairoFileLease(${JSON.stringify(remote.id)});
          try {
            const response = await callKairoFileIpc(lease, 30000, undefined, 'download', {
              uri: ${JSON.stringify(resource['fileUri'])}, fullPath: lease.path, override: true
            });
            if (response?.code !== 0) throw new Error('原生文件下载失败: ' + JSON.stringify(response));
            if (response.data?.path !== lease.path || response.data?.downloaded === true) throw new Error('不能以缓存源文件冒充服务器下载');
          } finally { lease.release(); }
        })()`,
          35000
        );
        const downloaded = await driver.saveFile(
          { fileName: path.basename(filePath), filePath: remote.path },
          path.join(directory, `${target.id}-服务器文件.txt`)
        );
        assert.deepEqual(await readFile(downloaded), fileBytes, '服务器文件与Linux输入不一致');
      } finally {
        await releaseRemoteFile(probe, remote);
      }
      evidence['服务器文件下载并保存到Linux'] = {
        逐字节相同: true,
        字节数: fileBytes.length,
        文件名: content['filename'],
        SHA256: createHash('sha256').update(fileBytes).digest('hex'),
      };
    } else {
      // 普通数据库查询可能尚无播放路径；原生历史读取会执行正常服务器同步并生成播放WAV。
      const history = await callIpcToData<Array<Record<string, unknown>>>(probe, 'getMessages', [
        { sessionID: Number(target.id), count: 100, endIdx: 2147483647, sendTime: 0 },
      ]);
      assert.equal(history.code, 0);
      const voiceRecord = history.data?.find(message => String(message['id']) === result.messageId);
      assert.ok(voiceRecord, '原生历史缺少本次正式语音');
      const voiceContent = (
        typeof voiceRecord['content'] === 'string'
          ? JSON.parse(voiceRecord['content'])
          : voiceRecord['content']
      ) as Record<string, unknown>;
      assert.equal(voiceContent['data'], content['data'], '同步后正式AMR发生变化');
      assert.equal(voiceContent['duration'], content['duration']);
      const resource = await probe.evaluate<{
        duration: number;
        decodedSamples: number;
        amrBytes: number;
        wavBytes: number;
        tailRms: number;
      }>(`(() => {
        const content = ${JSON.stringify(voiceContent)};
        const fs = window.require('fs'), path = window.require('path'), Buffer = window.require('buffer').Buffer;
        if (typeof content.filepath !== 'string') throw new Error('原生历史未生成正式播放路径');
        const amr = window.require(path.join(window.process.resourcesPath, 'app.asar/dist/electron/lib/amrnb'));
        const bytes = Buffer.from(content.data, 'base64');
        if (bytes.subarray(0,6).toString('ascii') !== '#!AMR\\n') throw new Error('正式语音缺少AMR头');
        const decoded = amr.decode(bytes), expected = Buffer.from(amr.toWAV(bytes)), actual = fs.readFileSync(content.filepath);
        if (!actual.equals(expected)) throw new Error('正式播放WAV与AMR回解不一致');
        let energy = 0; const start = Math.max(0, decoded.length - 1200);
        for (let i = start; i < decoded.length; i++) energy += decoded[i] * decoded[i];
        return { duration: content.duration, decodedSamples: decoded.length, amrBytes: bytes.length,
          wavBytes: actual.length, tailRms: Math.sqrt(energy / (decoded.length - start)) };
      })()`);
      assert.equal(resource.decodedSamples, 16160);
      assert.equal(resource.duration, Math.ceil(resource.decodedSamples / 8000));
      assert.ok(resource.tailRms > 0.05, '有效结尾丢失');
      evidence['语音资源'] = resource;
    }
    const repeated =
      operation.kind === 'image'
        ? await driver.sendImage(inputPath, options)
        : operation.kind === 'file'
          ? await driver.sendFile(inputPath, options)
          : await driver.sendVoice({ filePath: inputPath }, options);
    assert.equal(repeated.messageId, result.messageId);
    assert.equal((await driver.getSendStatus(operation.operationId)).messageId, result.messageId);
    const capture = await probe.evaluate<{
      requests: CapturedRequest[];
      receipts: CapturedReceipt[];
    }>(
      '({ requests: window.__kairo_remote_send_check.requests, receipts: window.__kairo_remote_send_check.receipts })'
    );
    for (const method of ['insertSendBefoeMsg', 'sendMessageNew']) {
      const requests = capture.requests.filter(
        request => request.key === operation.key && request.method === method
      );
      assert.equal(requests.length, 1, '重复操作或查询产生额外提交');
      if (method === 'sendMessageNew' && operation.kind === 'file') {
        assert.ok(requests[0]?.path && path.win32.isAbsolute(requests[0].path));
        assert.notEqual(requests[0].path, inputPath);
        evidence['Windows临时文件'] = requests[0].path;
      }
      if (operation.kind === 'voice')
        assert.equal(requests[0]?.hasFilepath, false, '语音不能携带Linux源路径');
    }
    const receipt = capture.receipts.find(
      item => item.key === operation.key && item.messageId === result.messageId
    );
    assert.ok(receipt, '独立采集缺少本次业务回执');
    assert.equal(receipt.code, 0);
    assert.ok(receipt.businessCode === null || receipt.businessCode === 0);
    assert.equal(receipt.sessionId, target.id);
    assert.equal(receipt.draftId, result.receipt?.draftId);
    evidence['独立回执'] = receipt;
    evidence['重复及查询无新增'] = true;
    await saveReport();
    console.log(
      JSON.stringify({
        原生会话: target.id,
        类型: operation.kind,
        状态: result.status,
        正式ID: result.messageId,
        索引: record['msgIdx'],
      })
    );
  }
  report['通过'] = true;
} catch (error) {
  failure = error;
  report['错误'] = error instanceof Error ? error.stack || error.message : String(error);
  process.exitCode = 1;
} finally {
  if (connected && captured) {
    try {
      await probe.evaluate('window.__kairo_remote_send_check.cleanup()');
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  try {
    await driver.disconnect();
  } catch (error) {
    cleanupErrors.push(error);
  }
  if (connected) {
    try {
      const exit = await probe.evaluate<{
        functionsRestored: boolean;
        listenersRestored: boolean;
        activeUnchanged: boolean;
        transfersRestored: boolean;
        pending: number;
        hook: boolean;
        filesReleased: boolean;
      }>(`(() => {
        const ipc = window.ipcRenderer || window.require('electron').ipcRenderer;
        const capture = window.__kairo_remote_send_check;
        if (!capture) throw new Error('验收基线不存在');
        const baseline = capture.baseline;
        const editor = document.querySelector('.chat-editor, .message-editor, .chat-sendArea')?.__vue__;
        const files = capture.requests.filter(r => r.method === 'sendMessageNew' && r.path).map(r => r.path);
        const result = { functionsRestored: ipc.send === baseline.send && ipc.emit === baseline.emit,
          listenersRestored: ipc.listenerCount('message') === baseline.message && ipc.listenerCount('0-${peerId}-sendMsgCallback') === baseline.privateCallback && ipc.listenerCount('1-${groupReceiver}-sendMsgCallback') === baseline.groupCallback,
          activeUnchanged: (editor?.activedSes ? String(editor.activedSes.id) : null) === baseline.active,
          transfersRestored: (window.__kairo_file_transfers?.size || 0) === baseline.transfers,
          pending: window.__kairo_pending_sends?.size || 0, hook: !!window.__kairo_bridge_cleanup,
          filesReleased: files.every(file => !window.require('fs').existsSync(file)) };
        delete window.__kairo_remote_send_check;
        return result;
      })()`);
      report['退出核对'] = exit;
      assert.deepEqual(exit, {
        functionsRestored: true,
        listenersRestored: true,
        activeUnchanged: true,
        transfersRestored: true,
        pending: 0,
        hook: false,
        filesReleased: true,
      });
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      await probe.disconnect();
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  try {
    await rm(directory, { recursive: true, force: true });
    report['Linux临时文件已清理'] = true;
  } catch (error) {
    cleanupErrors.push(error);
  }
  if (cleanupErrors.length) {
    report['清理错误'] = cleanupErrors.map(String);
    report['通过'] = false;
    process.exitCode = 1;
  }
  if (failure !== undefined) report['通过'] = false;
  await saveReport();
  console.log(
    JSON.stringify(
      {
        报告: reportPath.href,
        通过: report['通过'],
        运行ID: runId,
        发送记录数: results.length,
        消息保留: true,
        退出核对: report['退出核对'],
        错误: report['错误'],
        清理错误: report['清理错误'],
      },
      null,
      2
    )
  );
}
