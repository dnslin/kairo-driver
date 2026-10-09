import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
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
assert.equal(uid, '5761');
assert.equal(login, '0123040139');
assert.equal(privateId, '716791');
assert.equal(peerId, '3585');
assert.equal(peerLogin, 'int2024');
assert.equal(groupId, '793803', '禁止操作同名群716827');
assert.equal(groupReceiver, '29467');
assert.equal(groupName, '测试123');
const config = {
  url: process.env['CDP_URL'] || 'http://127.0.0.1:9222',
  pageMatch: process.env['PAGE_MATCH'] || 'renderer.html',
};
const driver = new KK9Driver({ cdp: config, rejectExistingBridge: true });
const verification = new CdpClient(config);
const runId = randomUUID();
const directory = await mkdtemp(path.join(os.tmpdir(), 'kairo-t07-'));
const operations = [privateId, groupId].map((id, index) => ({
  id,
  operationId: `${runId}:${index}`,
  key: createNativeMessageKey('image', `${runId}:${index}`),
  file: path.join(directory, `T07-${index}.png`),
}));
const results: Array<Record<string, unknown>> = [];
const report: Record<string, unknown> = {
  运行ID: runId,
  通过: false,
  目标: results,
  清理: [],
  未真机触发: ['上传失败-9', '服务器业务失败'],
  接收端人工展示: '未执行；当前客户端下载解码和查看器打开不等于接收端人工确认',
};
let targets: KK9Session[] = [];
let connected = false;
let captureInstalled = false;
let initialWindow: string | undefined;

async function history(id: string): Promise<Array<Record<string, unknown>>> {
  const response = await callIpcToData<Array<Record<string, unknown>>>(
    verification,
    'getMessages',
    [{ sessionID: Number(id), count: 100, endIdx: 2147483647, sendTime: 0 }]
  );
  assert.equal(response.code, 0, '原生历史失败');
  assert.ok(Array.isArray(response.data));
  return response.data;
}
async function decode(
  file: string
): Promise<{ width: number; height: number; size: number; mimetype: string; samples: number[] }> {
  return verification.evaluate(`(() => {
    const fs = window.require('fs'), bytes = fs.readFileSync(${JSON.stringify(file)});
    const image = window.require('electron').nativeImage.createFromBuffer(bytes);
    if (image.isEmpty()) throw new Error('实际图片无法解码: ' + ${JSON.stringify(file)});
    const { width, height } = image.getSize(), bitmap = image.toBitmap();
    const samples = [];
    for (const y of [Math.floor(height/4), Math.floor(height*3/4)])
      for (const x of [Math.floor(width/4), Math.floor(width*3/4)])
        samples.push(...bitmap.subarray((y*width+x)*4,(y*width+x)*4+4));
    return { width, height, size: bytes.length, mimetype: window.require('file-type')(bytes)?.mime, samples };
  })()`);
}
function fail(stage: string, error: unknown): void {
  report[stage] = String(error);
  report['通过'] = false;
  process.exitCode = 1;
}

try {
  await driver.connect();
  await verification.connect();
  connected = true;
  assert.equal(await driver.getCurrentUserId(), uid);
  assert.equal((await driver.getUserProfile(uid))?.loginName, login);
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
    const capture = { requests: [], receipts: [], drafts: new Set(), preparations: 0 };
    const send = ipc.send, emit = ipc.emit;
    ipc.send = function(channel, request, ...rest) {
      const method = request?.args?.[0], message = request?.args?.[1];
      if (channel === 'data' && method === 'sendingImgBeforeHandle') capture.preparations++;
      if (channel === 'data' && keys.includes(message?.msgFlag) && ['insertSendBefoeMsg','sendMessageNew'].includes(method)) {
        capture.requests.push({ method, key: message.msgFlag });
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
    capture.cleanup = () => { ipc.send = send; ipc.emit = emit; delete window.__kairo_t07_capture; };
    window.__kairo_t07_capture = capture;
  })()`);
  captureInstalled = true;
  for (const operation of operations) {
    const target = targets.find(session => session.id === operation.id)!;
    const other = targets.find(session => session.id !== operation.id)!;
    assert.equal(await driver.selectSession(other.id), true);
    const before = (await driver.getCurrentSession())?.id;
    await copyFile(new URL('../tests/fixtures/t07-image.png', import.meta.url), operation.file);
    const source = await decode(operation.file);
    assert.deepEqual([source.width, source.height], [640, 360]);
    const options = {
      targetSessionId: target.id,
      operationId: operation.operationId,
      verifyTimeoutMs: 20000,
    };
    let result = await driver.sendImage(operation.file, options);
    if (result.status === 'unknown') result = await driver.getSendStatus(operation.operationId);
    assert.equal(result.status, 'sent', result.error || '无本次业务确认，禁止重发');
    const record = (await history(target.id)).find(message => message['msgFlag'] === operation.key);
    assert.ok(record, '本轮正式图像记录不存在');
    assert.equal(String(record['id']), result.messageId);
    assert.equal(String(record['sender']), uid);
    assert.equal(String(record['receiver']), target.receiverId);
    assert.equal(String(record['sessionID']), target.id);
    assert.equal(record['sessionType'], target.nativeType);
    assert.equal(record['contentType'], 4);
    const content = (
      typeof record['content'] === 'string' ? JSON.parse(record['content']) : record['content']
    ) as { content: Array<Record<string, unknown>> };
    const image = content.content.find(node => node['type'] === 1);
    assert.ok(image, '正式消息缺少图片节点');
    assert.deepEqual(
      [image['width'], image['height'], Number(image['size']), image['mimetype']],
      [640, 360, source.size, 'image/png']
    );
    const thumbnail = await decode(String(image['filepath']));
    const artwork = await decode(String(image['filepath_h']));
    assert.deepEqual(
      [thumbnail.width, thumbnail.height, thumbnail.mimetype],
      [300, 168, 'image/png']
    );
    assert.deepEqual([artwork.width, artwork.height, artwork.size], [640, 360, source.size]);
    const downloaded: Array<Record<string, unknown>> = [];
    for (const kind of ['缩略图', '原图'] as const) {
      const uri = image[kind === '缩略图' ? 'uri' : 'uri_h'];
      const file = path.join(directory, `${target.id}-${kind}.png`);
      const response = await callIpcToData<{ path: string; downloaded?: boolean }>(
        verification,
        'download',
        [{ uri, fullPath: file, override: true }],
        30000
      );
      assert.equal(response.code, 0, `${kind}服务器下载失败`);
      assert.equal(response.data?.path, file);
      assert.notEqual(response.data?.downloaded, true, '不能用源图缓存代替服务器下载');
      const actual = await decode(file);
      const expected = kind === '缩略图' ? thumbnail : artwork;
      assert.deepEqual(
        [actual.width, actual.height, actual.mimetype],
        [expected.width, expected.height, expected.mimetype]
      );
      assert.deepEqual(actual.samples, source.samples, `${kind}四个色块与测试图不符`);
      downloaded.push({ 类型: kind, uri, 路径: file, 缓存命中: false, ...actual });
    }
    const repeated = await driver.sendImage(operation.file, options);
    const queried = await driver.getSendStatus(operation.operationId);
    assert.equal(repeated.messageId, result.messageId);
    assert.equal(queried.messageId, result.messageId);
    const capture = await verification.evaluate<{
      preparations: number;
      requests: Array<{ key: string; method: string }>;
      receipts: Array<Record<string, unknown>>;
    }>(
      '({ preparations: window.__kairo_t07_capture.preparations, requests: window.__kairo_t07_capture.requests, receipts: window.__kairo_t07_capture.receipts })'
    );
    assert.equal(capture.preparations, results.length + 1, '重复操作或查询不得重新准备图片');
    assert.equal(
      capture.requests.filter(
        request => request.key === operation.key && request.method === 'sendMessageNew'
      ).length,
      1
    );
    const receipt = capture.receipts.find(
      value => value['messageId'] === result.messageId && value['sessionId'] === target.id
    );
    assert.ok(receipt, '独立采集缺少本次原生业务回执');
    assert.equal(receipt['code'], 0);
    assert.ok(receipt['businessCode'] === null || receipt['businessCode'] === 0);
    assert.equal(receipt['draftId'], result.receipt?.draftId);
    assert.equal(receipt['msgIdx'], record['msgIdx']);
    const after = (await driver.getCurrentSession())?.id;
    assert.equal(after, before, '发送或只读查询改变了窗口');
    results.push({
      原生会话: target.id,
      正式ID: result.messageId,
      索引: record['msgIdx'],
      operationId: operation.operationId,
      发送前窗口: before,
      发送后窗口: after,
      回执: receipt,
      图片: image,
      本地缩略图: thumbnail,
      本地原图: artwork,
      服务器资源: downloaded,
      原生准备及提交次数: 1,
      重复及查询无新增: true,
    });
  }
  // 留住本轮消息供当前客户端与接收端查看，不要求补发。finish只清理本轮本人图片。
  if (process.argv.includes('--inspect')) {
    const input = createInterface({ input: process.stdin, output: process.stdout });
    console.log(
      'T07_READY：双目标已发送并重新下载解码；private/group切换查看本轮图片，finish清理退出。'
    );
    console.log(JSON.stringify({ 运行ID: runId, 目标: results }, null, 2));
    for await (const line of input) {
      if (line.trim() === 'finish') break;
      if (line.trim() === 'private') await driver.selectSession(privateId);
      if (line.trim() === 'group') await driver.selectSession(groupId);
    }
    input.close();
  }
  report['通过'] = true;
} catch (error) {
  fail('错误', error);
} finally {
  if (connected) {
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
          assert.equal(await driver.recallMessage(id, target), true, '本轮本人图片清理失败');
          const recalled = (await history(target.id)).find(message => String(message['id']) === id);
          assert.ok(recalled && /^[CD]/.test(String(recalled['msgFlag'])));
          cleaned.push({ 原生会话: target.id, 正式ID: id, 已撤回: true });
        }
      } catch (error) {
        fail('图片清理错误', error);
      }
    }
    report['清理'] = cleaned;
    if (initialWindow && targets.some(target => target.id === initialWindow)) {
      try {
        assert.equal(await driver.selectSession(initialWindow), true);
      } catch (error) {
        fail('窗口恢复错误', error);
      }
    }
    if (captureInstalled) {
      try {
        report['独立采集'] = await verification.evaluate(
          '({ requests: window.__kairo_t07_capture.requests, receipts: window.__kairo_t07_capture.receipts, preparations: window.__kairo_t07_capture.preparations })'
        );
        await verification.evaluate('window.__kairo_t07_capture.cleanup()');
      } catch (error) {
        fail('采集清理错误', error);
      }
    }
  }
  try {
    await driver.disconnect();
  } catch (error) {
    fail('Driver退出错误', error);
  }
  if (connected) {
    try {
      report['退出后'] = await verification.evaluate(
        '({ 采集残留: !!window.__kairo_t07_capture, DriverHook残留: !!window.__kairo_bridge_cleanup, 在途发送: window.__kairo_pending_sends?.size || 0 })'
      );
    } catch (error) {
      fail('退出核对错误', error);
    }
  }
  await verification.disconnect();
  await rm(directory, { recursive: true, force: true });
  await mkdir(new URL('../tmp/', import.meta.url), { recursive: true });
  for (const name of [`t07-${runId}.json`, 't07-live-evidence.json'])
    await writeFile(
      new URL(`../tmp/${name}`, import.meta.url),
      JSON.stringify(report, null, 2) + '\n'
    );
  console.log(JSON.stringify(report, null, 2));
}
