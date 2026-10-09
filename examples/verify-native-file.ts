import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CdpClient, callIpcToData, createNativeMessageKey, KK9Driver } from '../src/index.js';
import type { KK9Session } from '../src/types/index.js';

const [uid, login, privateId, peerId, peerLogin, groupId, groupReceiver, groupName] =
  process.argv.slice(2);
assert.ok(
  uid && login && privateId && peerId && peerLogin && groupId && groupReceiver && groupName,
  '参数：登录UID 登录账号 私聊原生ID 对端UID 对端账号 群原生ID 群接收对象 群精确名'
);
assert.equal(
  process.env['KK9_REAL_TEST_CONFIRM'],
  `${uid}:${privateId}:${groupId}`,
  '必须保留双目标确认门禁'
);
assert.equal(
  process.env['KK9_STAGE1_CONFIRM'],
  `${uid}:${peerId}:${privateId}`,
  '必须保留私聊确认门禁'
);
assert.equal(privateId, '716791');
assert.equal(groupId, '793803', '禁止操作同名群716827');
const config = {
  url: process.env['CDP_URL'] || 'http://127.0.0.1:9222',
  pageMatch: process.env['PAGE_MATCH'] || 'renderer.html',
};
const driver = new KK9Driver({ cdp: config, rejectExistingBridge: true });
const verification = new CdpClient(config);
const runId = randomUUID();
const directory = await mkdtemp(path.join(os.tmpdir(), 'kairo-t06-'));
const operations = [privateId, groupId].map((id, index) => ({
  id,
  operationId: `${runId}:${index}`,
  key: createNativeMessageKey('file', `${runId}:${index}`),
  file: path.join(directory, `T06-${runId}-${index}.txt`),
  bytes: Buffer.from(`Kairo T06 native file ${runId}\n目标 ${id}\n`, 'utf8'),
}));
const report: Record<string, unknown> = {
  运行ID: runId,
  通过: false,
  目标: [],
  清理: [],
  未真机触发: ['上传失败-9', '服务器业务失败'],
  边界: '当前登录客户端按本轮服务器附件URI重新下载并逐字节核对；未操作接收端设备或证明接收端人工打开。',
};
let targets: KK9Session[] = [];
let captureInstalled = false;
let verificationConnected = false;
let initialWindow: string | undefined;

async function history(id: string): Promise<Array<Record<string, unknown>>> {
  const response = await callIpcToData<Array<Record<string, unknown>>>(
    verification,
    'getMessages',
    [{ sessionID: Number(id), count: 100, endIdx: 2147483647, sendTime: 0 }]
  );
  assert.equal(response.code, 0, '原生历史失败');
  assert.ok(Array.isArray(response.data), '原生历史无效');
  return response.data;
}
async function snapshot(): Promise<{
  requests: Array<{ method: string; key: string }>;
  receipts: Array<Record<string, unknown>>;
}> {
  return verification.evaluate(
    '({ requests: window.__kairo_t06_capture.requests, receipts: window.__kairo_t06_capture.receipts })'
  );
}
function failure(stage: string, error: unknown): void {
  report[stage] = String(error);
  report['通过'] = false;
  process.exitCode = 1;
}

try {
  await driver.connect();
  await verification.connect();
  verificationConnected = true;
  assert.equal(await driver.getCurrentUserId(), uid, '实际登录UID不符');
  assert.equal((await driver.getUserProfile(uid))?.loginName, login, '实际登录账号不符');
  const sessions = await driver.getSessions();
  const privateSession = sessions.find(session => session.id === privateId);
  const groupSession = sessions.find(session => session.id === groupId);
  assert.ok(privateSession && groupSession, '授权原生会话不存在');
  assert.equal(privateSession.nativeType, 0);
  assert.equal(privateSession.receiverId, peerId);
  assert.equal((await driver.getEmployeeBySession(privateSession))?.loginName, peerLogin);
  assert.equal(groupSession.name, groupName);
  assert.equal(groupSession.type, 'group');
  assert.equal(groupSession.nativeType, 1);
  assert.equal(groupSession.receiverId, groupReceiver);
  targets = [privateSession, groupSession];
  report['身份'] = { uid, login, privateId, peerId, peerLogin, groupId, groupReceiver, groupName };
  initialWindow = (await driver.getCurrentSession())?.id;
  await verification.evaluate(`(() => {
    const ipc = window.ipcRenderer || window.require('electron').ipcRenderer;
    const keys = ${JSON.stringify(operations.map(operation => operation.key))};
    const capture = { requests: [], receipts: [], drafts: new Set() };
    const send = ipc.send;
    const emit = ipc.emit;
    const wrappedSend = function(channel, request, ...rest) {
      const method = request?.args?.[0], message = request?.args?.[1];
      if (channel === 'data' && keys.includes(message?.msgFlag) && ['insertSendBefoeMsg','sendMessageNew'].includes(method)) {
        capture.requests.push({ method, key: message.msgFlag });
        if (method === 'sendMessageNew') capture.drafts.add(String(message.id));
      }
      return send.call(this, channel, request, ...rest);
    };
    const wrappedEmit = function(channel, event, payload, ...rest) {
      const value = payload?.args;
      if (String(channel).endsWith('-sendMsgCallback') && capture.drafts.has(String(value?.msgID))) {
        let ext = value.data?.ext;
        if (typeof ext === 'string') ext = JSON.parse(ext);
        capture.receipts.push({ draftId: String(value.msgID), code: value.code, businessCode: ext?.status ?? null,
          messageId: String(value.data?.id), sessionId: String(value.data?.sessionID), msgIdx: value.data?.msgIdx });
      }
      return emit.call(this, channel, event, payload, ...rest);
    };
    capture.cleanup = () => { ipc.send = send; ipc.emit = emit; delete window.__kairo_t06_capture; };
    ipc.send = wrappedSend; ipc.emit = wrappedEmit;
    window.__kairo_t06_capture = capture;
  })()`);
  captureInstalled = true;
  const results: Array<Record<string, unknown>> = [];
  for (const operation of operations) {
    const target = targets.find(session => session.id === operation.id)!;
    const other = targets.find(session => session.id !== operation.id)!;
    assert.equal(await driver.selectSession(other.id), true, '显示另一授权窗口失败');
    const before = (await driver.getCurrentSession())?.id;
    assert.equal(before, other.id);
    await writeFile(operation.file, operation.bytes);
    const options = {
      targetSessionId: target.id,
      operationId: operation.operationId,
      verifyTimeoutMs: 20000,
    };
    let result = await driver.sendFile(operation.file, options);
    if (result.status === 'unknown') result = await driver.getSendStatus(operation.operationId);
    assert.equal(result.status, 'sent', result.error || '无本次业务确认，禁止重发');
    const record = (await history(target.id)).find(message => message['msgFlag'] === operation.key);
    assert.ok(record, '本轮正式记录不存在');
    assert.equal(String(record['id']), result.messageId);
    assert.equal(String(record['sender']), uid);
    assert.equal(String(record['sessionID']), target.id);
    assert.equal(String(record['receiver']), target.receiverId);
    assert.equal(record['sessionType'], target.nativeType);
    assert.equal(record['contentType'], 3);
    const content =
      typeof record['content'] === 'string'
        ? (JSON.parse(record['content']) as Record<string, unknown>)
        : (record['content'] as Record<string, unknown>);
    assert.equal(content['filename'], path.basename(operation.file));
    assert.equal(Number(content['size']), operation.bytes.length);
    assert.equal(content['mimetype'], 'text/plain');
    const repeated = await driver.sendFile(operation.file, options);
    const queried = await driver.getSendStatus(operation.operationId);
    assert.equal(repeated.status, 'sent');
    assert.equal(repeated.messageId, result.messageId);
    assert.equal(queried.status, 'sent');
    assert.equal(queried.messageId, result.messageId);
    const capture = await snapshot();
    assert.equal(
      capture.requests.filter(
        request => request.key === operation.key && request.method === 'sendMessageNew'
      ).length,
      1
    );
    const receipt = capture.receipts.find(
      value => value['messageId'] === result.messageId && value['sessionId'] === target.id
    );
    assert.ok(receipt, '独立原生派发采集缺少本次回执');
    assert.equal(receipt['code'], 0);
    assert.ok(receipt['businessCode'] === null || receipt['businessCode'] === 0);
    assert.equal(receipt['draftId'], result.receipt?.draftId);
    assert.equal(receipt['msgIdx'], record['msgIdx']);
    const after = (await driver.getCurrentSession())?.id;
    assert.equal(after, before, '发送或只读查询改变了窗口');
    const versions = await callIpcToData<Array<Record<string, unknown>>>(
      verification,
      'getIMFileHis',
      [{ fileId: Number(result.messageId), lastUpdate: 0 }]
    );
    assert.equal(versions.code, 0);
    const attachment = versions.data?.[0];
    assert.ok(attachment, '服务器未返回附件版本');
    assert.equal(attachment['fileName'], path.basename(operation.file));
    assert.equal(Number(attachment['fileSize']), operation.bytes.length);
    const downloadedPath = path.join(directory, `download-${path.basename(operation.file)}`);
    // 不传type：原版download跳过资源缓存，从服务器URI下载到本轮独立路径。
    const download = await callIpcToData<{ path: string; downloaded?: boolean }>(
      verification,
      'download',
      [{ uri: attachment['fileUri'], fullPath: downloadedPath, override: true }],
      30000
    );
    assert.equal(download.code, 0, '原生附件下载失败');
    assert.equal(download.data?.path, downloadedPath);
    assert.notEqual(download.data?.downloaded, true, '不能用已缓存源文件替代下载');
    assert.deepEqual(await readFile(downloadedPath), operation.bytes, '下载附件与测试内容不一致');
    results.push({
      原生会话: target.id,
      nativeType: target.nativeType,
      接收对象: target.receiverId,
      operationId: operation.operationId,
      正式ID: result.messageId,
      索引: record['msgIdx'],
      deviceID: record['deviceID'],
      文件名: content['filename'],
      字节数: operation.bytes.length,
      mimetype: content['mimetype'],
      uri: content['uri'],
      回执: receipt,
      原生提交次数: 1,
      重复及查询无新增: true,
      发送前窗口: before,
      发送后窗口: after,
      附件下载: {
        code: download.code,
        path: downloadedPath,
        缓存命中: false,
        逐字节内容相同: true,
      },
    });
    report['目标'] = results;
  }
  report['通过'] = true;
} catch (error) {
  failure('错误', error);
} finally {
  if (verificationConnected) {
    const cleaned: Array<Record<string, unknown>> = [];
    for (const operation of operations) {
      const target = targets.find(session => session.id === operation.id);
      if (!target) continue;
      try {
        const records = (await history(target.id)).filter(
          message => message['msgFlag'] === operation.key && String(message['sender']) === uid
        );
        for (const record of records) {
          const id = String(record['id']);
          assert.equal(await driver.recallMessage(id, target), true, '本轮本人文件清理失败');
          const recalled = (await history(target.id)).find(message => String(message['id']) === id);
          assert.ok(recalled && /^[CD]/.test(String(recalled['msgFlag'])), '未确认本轮文件撤回');
          cleaned.push({ 原生会话: target.id, 正式ID: id, 已撤回: true });
        }
      } catch (error) {
        failure('文件清理错误', error);
      }
    }
    report['清理'] = cleaned;
    if (initialWindow && targets.some(target => target.id === initialWindow)) {
      try {
        assert.equal(await driver.selectSession(initialWindow), true);
      } catch (error) {
        failure('窗口恢复错误', error);
      }
    }
    if (captureInstalled) {
      try {
        report['独立采集'] = await snapshot();
        await verification.evaluate('window.__kairo_t06_capture.cleanup()');
      } catch (error) {
        failure('采集清理错误', error);
      }
    }
  }
  try {
    await driver.disconnect();
  } catch (error) {
    failure('Driver退出错误', error);
  }
  if (verificationConnected) {
    try {
      report['退出后'] = await verification.evaluate(
        '({ 采集残留: !!window.__kairo_t06_capture, DriverHook残留: !!window.__kairo_bridge_cleanup, 在途发送: window.__kairo_pending_sends?.size || 0 })'
      );
    } catch (error) {
      failure('退出核对错误', error);
    }
  }
  await verification.disconnect();
  await rm(directory, { recursive: true, force: true });
  await mkdir(new URL('../tmp/', import.meta.url), { recursive: true });
  await writeFile(
    new URL(`../tmp/t06-${runId}.json`, import.meta.url),
    JSON.stringify(report, null, 2) + '\n'
  );
  await writeFile(
    new URL('../tmp/t06-live-evidence.json', import.meta.url),
    JSON.stringify(report, null, 2) + '\n'
  );
  console.log(JSON.stringify(report, null, 2));
}
