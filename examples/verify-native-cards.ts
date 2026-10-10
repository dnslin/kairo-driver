import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { CdpClient, callIpcToData, createNativeMessageKey, KK9Driver } from '../src/index.js';
import type { KK9ChatRecordOptions, KK9Session, SendResult } from '../src/types/index.js';

const [uid, login, privateId, peerId, peerLogin, groupId, groupReceiver, groupName] =
  process.argv.slice(2);
assert.deepEqual(
  [uid, login, privateId, peerId, peerLogin, groupId, groupReceiver, groupName],
  ['5761', '0123040139', '716791', '3585', 'int2024', '793803', '29467', '测试123'],
  '只允许既定授权范围，禁止同名群716827'
);
assert.equal(process.env['KK9_REAL_TEST_CONFIRM'], `${uid}:${privateId}:${groupId}`);
assert.equal(process.env['KK9_STAGE1_CONFIRM'], `${uid}:${peerId}:${privateId}`);
const config = {
  url: process.env['CDP_URL'] || 'http://127.0.0.1:9222',
  pageMatch: process.env['PAGE_MATCH'] || 'renderer.html',
};
const driver = new KK9Driver({ cdp: config, rejectExistingBridge: true });
const probe = new CdpClient(config);
const runId = randomUUID();
const operations = [
  { kind: 'url-card' as const, id: privateId!, contentType: 10 },
  { kind: 'app-message' as const, id: privateId!, contentType: 8 },
  { kind: 'biz-message' as const, id: groupId!, contentType: 17 },
  { kind: 'chat-record' as const, id: groupId!, contentType: 15 },
].map((operation, index) => ({
  ...operation,
  operationId: `${runId}:${index}`,
  key: createNativeMessageKey(operation.kind, `${runId}:${index}`),
}));
const evidence: Array<Record<string, unknown>> = [];
const report: Record<string, unknown> = {
  运行ID: runId,
  协议通过: false,
  卡片: evidence,
  展示: '待实际核对；sent和正式记录不替代展示',
};
const originals: Array<{ messageId: string; msgIdx: number }> = [];
let targets: KK9Session[] = [];
let captureInstalled = false;
let connected = false;
function fail(stage: string, error: unknown): void {
  report[stage] = String(error);
  process.exitCode = 1;
}
async function save(): Promise<void> {
  await mkdir(new URL('../tmp/', import.meta.url), { recursive: true });
  for (const name of [`t09-${runId}.json`, 't09-live-evidence.json'])
    await writeFile(
      new URL(`../tmp/${name}`, import.meta.url),
      JSON.stringify(report, null, 2) + '\n'
    );
}
async function history(id: string): Promise<Array<Record<string, unknown>>> {
  const response = await callIpcToData<Array<Record<string, unknown>>>(probe, 'getMessages', [
    { sessionID: Number(id), count: 100, endIdx: 2147483647, sendTime: 0 },
  ]);
  assert.equal(response.code, 0, `原生历史 ${id} 失败`);
  assert.ok(Array.isArray(response.data));
  return response.data;
}
function contentOf(record: Record<string, unknown>): Record<string, unknown> {
  const value: unknown =
    typeof record['content'] === 'string' ? JSON.parse(record['content']) : record['content'];
  assert.ok(
    value && typeof value === 'object' && !Array.isArray(value),
    '卡片必须有原生结构化内容'
  );
  return value as Record<string, unknown>;
}
try {
  await driver.connect();
  await probe.connect();
  connected = true;
  assert.equal(await driver.getCurrentUserId(), uid);
  assert.equal((await driver.getUserProfile(uid!))?.loginName, login);
  const sessions = await driver.getSessions();
  const privateSession = sessions.find(item => item.id === privateId);
  const groupSession = sessions.find(item => item.id === groupId);
  assert.ok(privateSession && groupSession);
  assert.equal(privateSession.nativeType, 0);
  assert.equal(privateSession.receiverId, peerId);
  assert.equal((await driver.getEmployeeBySession(privateSession))?.loginName, peerLogin);
  assert.equal(groupSession.nativeType, 1);
  assert.equal(groupSession.receiverId, groupReceiver);
  assert.equal(groupSession.name, groupName);
  targets = [privateSession, groupSession];
  report['身份目标'] = {
    uid,
    login,
    privateId,
    peerId,
    peerLogin,
    groupId,
    groupReceiver,
    groupName,
  };
  await probe.evaluate(`(() => {
    const ipc = window.ipcRenderer || window.require('electron').ipcRenderer;
    const keys = ${JSON.stringify(operations.map(operation => operation.key))};
    const capture = { requests: [], receipts: [], drafts: new Set() };
    const send = ipc.send, emit = ipc.emit;
    ipc.send = function(channel, request, ...rest) {
      const method = request?.args?.[0], message = request?.args?.[1];
      if (channel === 'data' && keys.includes(message?.msgFlag) && ['insertSendBefoeMsg', 'sendMessageNew'].includes(method)) {
        capture.requests.push({ method, key: message.msgFlag, contentType: message.contentType, sessionID: message.sessionID });
        if (method === 'sendMessageNew') capture.drafts.add(String(message.id));
      }
      return send.call(this, channel, request, ...rest);
    };
    ipc.emit = function(channel, event, payload, ...rest) {
      const value = payload?.args;
      if (String(channel).endsWith('-sendMsgCallback') && capture.drafts.has(String(value?.msgID))) {
        let ext = value.data?.ext, parseError;
        try { if (typeof ext === 'string') ext = JSON.parse(ext); } catch (error) { parseError = String(error); ext = undefined; }
        capture.receipts.push({ draftId: String(value.msgID), code: value.code, businessCode: ext?.status ?? null,
          messageId: String(value.data?.id), sessionId: String(value.data?.sessionID), msgIdx: value.data?.msgIdx,
          ...(parseError ? { parseError } : {}) });
      }
      return emit.call(this, channel, event, payload, ...rest);
    };
    capture.cleanup = () => { ipc.send = send; ipc.emit = emit; delete window.__kairo_t09_capture; };
    window.__kairo_t09_capture = capture;
  })()`);
  captureInstalled = true;
  const marker = `T09 测试 ${runId.slice(0, 8)}`;
  const link = {
    title: `${marker} 链接`,
    summary: '安全测试链接，仅展示，无业务动作',
    linkUrl: 'https://example.com',
  };
  const app = {
    title: `${marker} 应用`,
    content: '<p>应用测试通知：<b>仅测试</b>，不创建审批或任务。</p>',
    linkUrl: 'https://example.com',
  };
  const biz = {
    title: `${marker} 业务`,
    content: '业务测试通知，不对应真实任务、审批或订单。',
    summary: ['仅展示通知', '详情链接只到已查证业务站点首页'],
    bizType: 1 as const,
    bizUrl: '/',
  };
  for (const operation of operations) {
    const target = targets.find(item => item.id === operation.id)!;
    const options = {
      targetSessionId: target.id,
      operationId: operation.operationId,
      verifyTimeoutMs: 20000,
    };
    const merge: KK9ChatRecordOptions = { sourceSessionId: privateId!, msgArray: [...originals] };
    const send = (): Promise<SendResult> =>
      operation.kind === 'url-card'
        ? driver.sendUrlCard(link, options)
        : operation.kind === 'app-message'
          ? driver.sendAppMessage(app, options)
          : operation.kind === 'biz-message'
            ? driver.sendBizMessage(biz, options)
            : driver.sendChatRecord(merge, options);
    let result = await send();
    if (result.status === 'unknown') result = await driver.getSendStatus(operation.operationId);
    assert.equal(result.status, 'sent', result.error || '没有本次业务成功证据，禁止重发');
    const record = (await history(target.id)).find(row => row['msgFlag'] === operation.key);
    assert.ok(record);
    assert.equal(String(record['id']), result.messageId);
    assert.equal(String(record['sender']), uid);
    assert.equal(String(record['sessionID']), target.id);
    assert.equal(String(record['receiver']), target.receiverId);
    assert.equal(record['contentType'], operation.contentType);
    const sdkRecord = (await driver.getRecentMessages(target, 100)).find(
      row => row.id === result.messageId
    );
    assert.equal(sdkRecord?.messageType, operation.kind);
    const content = contentOf(record);
    if (operation.kind === 'url-card') assert.equal(content['linkUrl'], link.linkUrl);
    if (operation.kind === 'app-message') {
      assert.equal(content['content'], app.content);
      assert.ok(!content['pcAppCode'], '不编造应用编号');
    }
    if (operation.kind === 'biz-message') {
      assert.equal(content['bizType'], 1);
      assert.equal(content['bizUrl'], '/');
      assert.deepEqual(content['summary'], biz.summary);
    }
    if (operation.kind === 'chat-record') {
      assert.equal(String(content['sessionID']), privateId);
      const items = content['msgArray'];
      assert.ok(Array.isArray(items));
      assert.deepEqual(
        items.map((item: Record<string, unknown>) => ({
          messageId: String(item['id']),
          msgIdx: item['msgIdx'],
        })),
        originals
      );
      assert.ok(
        items.every(
          (item: Record<string, unknown>) =>
            String(item['senderID']) === uid && item['senderName'] === record['senderName']
        )
      );
      assert.deepEqual(
        items.map((item: Record<string, unknown>) => item['contentType']),
        [10, 8]
      );
    } else if (target.id === privateId)
      originals.push({ messageId: result.messageId, msgIdx: Number(record['msgIdx']) });
    if (operation.kind === 'chat-record') {
      assert.equal((await send()).messageId, result.messageId);
      assert.equal((await driver.getSendStatus(operation.operationId)).messageId, result.messageId);
    }
    const capture = await probe.evaluate<{
      requests: Array<{ key: string; method: string }>;
      receipts: Array<Record<string, unknown>>;
    }>(
      '({requests:window.__kairo_t09_capture.requests,receipts:window.__kairo_t09_capture.receipts})'
    );
    assert.equal(
      capture.requests.filter(
        request => request.key === operation.key && request.method === 'sendMessageNew'
      ).length,
      1
    );
    const receipt = capture.receipts.find(
      row => row['messageId'] === result.messageId && row['sessionId'] === target.id
    );
    assert.ok(receipt);
    assert.equal(receipt['code'], 0);
    assert.ok(receipt['businessCode'] === null || receipt['businessCode'] === 0);
    assert.equal(receipt['draftId'], result.receipt?.draftId);
    evidence.push({
      类型: operation.kind,
      会话: target.id,
      正式ID: result.messageId,
      索引: record['msgIdx'],
      操作ID: operation.operationId,
      业务回执: receipt,
      ...(operation.kind === 'chat-record'
        ? {
            来源会话: privateId,
            子条目: originals,
            作者UID: uid,
            作者名: record['senderName'],
            防重查询: true,
          }
        : {}),
    });
  }
  report['协议通过'] = evidence.length === 4;
  await save();
  if (process.argv.includes('--inspect')) {
    console.log(
      'T09_READY：私聊链接/应用、群业务/合并均已发送。只查看这四条已有卡片，合并应包含私聊两条本人测试卡片。finish清理本轮消息和监听。'
    );
    console.log(JSON.stringify(report, null, 2));
    const input = createInterface({ input: process.stdin, output: process.stdout });
    for await (const line of input) {
      if (line.trim() === 'finish') break;
    }
    input.close();
  }
} catch (error) {
  fail('错误', error);
} finally {
  if (connected) {
    const cleaned: Array<Record<string, unknown>> = [];
    for (const target of targets) {
      try {
        const records = (await history(target.id)).filter(
          row =>
            operations.some(
              operation => operation.id === target.id && row['msgFlag'] === operation.key
            ) && String(row['sender']) === uid
        );
        for (const record of records) {
          const id = String(record['id']);
          assert.equal(await driver.recallMessage(id, target), true);
          assert.ok(
            (await history(target.id)).some(
              row => String(row['id']) === id && /^[CD]/.test(String(row['msgFlag']))
            )
          );
          cleaned.push({ 会话: target.id, 正式ID: id, 已撤回: true });
        }
      } catch (error) {
        fail('本人消息清理错误', error);
      }
    }
    report['清理'] = cleaned;
    if (captureInstalled) {
      try {
        await probe.evaluate('window.__kairo_t09_capture.cleanup()');
      } catch (error) {
        fail('采集退出错误', error);
      }
    }
  }
  try {
    await driver.disconnect();
  } catch (error) {
    fail('Driver退出错误', error);
  }
  if (connected)
    report['退出后'] = await probe.evaluate(
      '({采集残留:!!window.__kairo_t09_capture,DriverHook残留:!!window.__kairo_bridge_cleanup,在途发送:window.__kairo_pending_sends?.size||0})'
    );
  await probe.disconnect();
  await save();
  console.log(JSON.stringify(report, null, 2));
}
