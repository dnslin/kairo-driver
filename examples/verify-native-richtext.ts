import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { CdpClient, callIpcToData, createNativeMessageKey, KK9Driver } from '../src/index.js';
import type { FormattedText, KK9Session, SendOptions, SendResult } from '../src/types/index.js';

const [uid, login, privateId, peerId, peerLogin, groupId, groupReceiver, groupName] = process.argv.slice(2);
assert.deepEqual([uid, login, privateId, peerId, peerLogin, groupId, groupReceiver, groupName],
  ['5761', '0123040139', '716791', '3585', 'int2024', '793803', '29467', '测试123'], '只允许既定授权范围，禁止同名群716827');
assert.equal(process.env['KK9_REAL_TEST_CONFIRM'], `${uid}:${privateId}:${groupId}`);
assert.equal(process.env['KK9_STAGE1_CONFIRM'], `${uid}:${peerId}:${privateId}`);
const config = { url: process.env['CDP_URL'] || 'http://127.0.0.1:9222', pageMatch: process.env['PAGE_MATCH'] || 'renderer.html' };
const driver = new KK9Driver({ cdp: config, rejectExistingBridge: true });
const verification = new CdpClient(config);
const runId = randomUUID();
const operations = ['格式', '引用', '普通提及', '引用提及'].map((kind, i) => ({
  kind, id: i < 2 ? privateId! : groupId!, operationId: `${runId}:${i}`,
  key: createNativeMessageKey(i === 0 ? 'rich-text' : i === 2 ? 'text' : 'reply', `${runId}:${i}`),
}));
const results: Array<Record<string, unknown>> = [];
const report: Record<string, unknown> = { 运行ID: runId, 协议通过: false, 目标: results, 接收端展示通知: '等待接收端实际确认，sent不代替验收' };
let targets: KK9Session[] = [];
let captureInstalled = false;
let connected = false;
function fail(stage: string, error: unknown): void { report[stage] = String(error); process.exitCode = 1; }
async function history(id: string): Promise<Array<Record<string, unknown>>> {
  const response = await callIpcToData<Array<Record<string, unknown>>>(verification, 'getMessages', [{ sessionID: Number(id), count: 100, endIdx: 2147483647, sendTime: 0 }]);
  assert.equal(response.code, 0, '原生历史查询失败');
  assert.ok(Array.isArray(response.data));
  return response.data;
}
function contentOf(record: Record<string, unknown>): Record<string, unknown> {
  return (typeof record['content'] === 'string' ? JSON.parse(record['content']) : record['content']) as Record<string, unknown>;
}
try {
  await driver.connect();
  await verification.connect();
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
  const members = await callIpcToData<Array<Record<string, unknown>>>(verification, 'getGroupsAllMembers', [Number(groupReceiver)]);
  assert.equal(members.code, 0, '原生成员查询失败');
  assert.ok(Array.isArray(members.data));
  const peer = members.data.find(member => String(member['id']) === peerId);
  const peerProfile = await driver.getUserProfile(peerId!);
  assert.equal(peerProfile?.loginName, peerLogin);
  report['身份目标'] = { uid, login, privateId, peerId, peerLogin, groupId, groupReceiver, groupName, 群成员已确认: !!peer };
  await verification.evaluate(`(() => {
    const ipc = window.ipcRenderer || window.require('electron').ipcRenderer;
    const keys = ${JSON.stringify(operations.map(item => item.key))};
    const capture = { requests: [], receipts: [], drafts: new Set() };
    const send = ipc.send, emit = ipc.emit;
    ipc.send = function(channel, request, ...rest) {
      const method = request?.args?.[0], message = request?.args?.[1];
      if (channel === 'data' && keys.includes(message?.msgFlag) && ['insertSendBefoeMsg','sendMessageNew'].includes(method)) {
        capture.requests.push({ method, key: message.msgFlag, atState: message.atState, atMemberIDList: [...message.atMemberIDList] });
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
          atState: value.data?.atState, atMemberIDList: value.data?.atMemberIDList,
          ...(parseError ? { parseError } : {}) });
      }
      return emit.call(this, channel, event, payload, ...rest);
    };
    capture.cleanup = () => { ipc.send = send; ipc.emit = emit; delete window.__kairo_t08_capture; };
    window.__kairo_t08_capture = capture;
  })()`);
  captureInstalled = true;
  const sources = new Map<string, Record<string, unknown>>();
  for (const operation of operations) {
    if (operation.id === groupId && !peer) { report['群验证缺项'] = 'int2024不在既定群内，不更换被提及者'; continue; }
    const target = targets.find(item => item.id === operation.id)!;
    const source = sources.get(operation.id);
    const input: FormattedText = operation.kind === '格式'
      ? { text: `T08 格式 ${runId.slice(0, 8)}\n换行与字面 **标记**`, font: { bold: true, italic: true, underline: true, fontSize: 14, color: '#1890ff' } }
      : `T08 ${operation.kind} ${runId.slice(0, 8)}`;
    const options: SendOptions = { targetSessionId: target.id, operationId: operation.operationId, verifyTimeoutMs: 20000,
      ...(operation.id === groupId ? { mentions: { uid: peerId!, name: String(peer!['name']) } } : {}) };
    const send = (): Promise<SendResult> => operation.kind === '格式' ? driver.sendRichText(input, options)
      : operation.kind === '普通提及' ? driver.sendText(input as string, options)
      : driver.sendReply({ messageId: String(source!['id']), msgIdx: Number(source!['msgIdx']) }, input, options);
    let result = await send();
    if (result.status === 'unknown') result = await driver.getSendStatus(operation.operationId);
    assert.equal(result.status, 'sent', result.error || '无本次确认，禁止重发');
    const record = (await history(target.id)).find(item => item['msgFlag'] === operation.key);
    assert.ok(record, '原生正式记录不存在');
    assert.equal(String(record['id']), result.messageId);
    assert.equal(String(record['sender']), uid);
    assert.equal(String(record['sessionID']), target.id);
    assert.equal(String(record['receiver']), target.receiverId);
    const content = contentOf(record);
    const replying = operation.kind === '引用' || operation.kind === '引用提及';
    const body = replying ? content['replyContent'] as Record<string, unknown> : content;
    const nodes = body['content'] as Array<Record<string, unknown>>;
    const expectedText = typeof input === 'string' ? input : input.text;
    assert.equal(nodes.filter(node => node['type'] === 0).map(node => node['text']).join(''), `${operation.id === groupId ? ' ' : ''}${expectedText}`);
    const membersList = typeof record['atMemberIDList'] === 'string' ? JSON.parse(record['atMemberIDList']) : record['atMemberIDList'];
    if (operation.kind === '格式') assert.deepEqual(content['font'], { bold: 1, italic: 1, underline: 1, size: 14, fontfamily: '微软雅黑', color: 16748568 });
    if (operation.id === groupId) assert.deepEqual(nodes.filter(node => node['type'] === 2).map(node => node['replyMemberID']), [Number(peerId)]);
    if (replying) {
      assert.equal(content['replyedMsgId'], source!['id']);
      assert.equal(content['replyedMsgIndex'], source!['msgIdx']);
      assert.equal(content['replyedID'], source!['sender']);
      assert.deepEqual(content['replyedContent'], contentOf(source!));
      assert.ok(!Object.hasOwn(body, 'font'), '引用字体只能在顶层');
    } else sources.set(target.id, record);
    const repeated = await send();
    const queried = await driver.getSendStatus(operation.operationId);
    assert.equal(repeated.messageId, result.messageId);
    assert.equal(queried.messageId, result.messageId);
    const capture = await verification.evaluate<{ requests: Array<{ key: string; method: string; atState: number; atMemberIDList: number[] }>; receipts: Array<Record<string, unknown>> }>('({requests:window.__kairo_t08_capture.requests,receipts:window.__kairo_t08_capture.receipts})');
    const submissions = capture.requests.filter(item => item.key === operation.key && item.method === 'sendMessageNew');
    assert.equal(submissions.length, 1);
    const submitted = submissions[0]!;
    assert.deepEqual(submitted.atMemberIDList, replying ? [Number(uid), ...(operation.id === groupId ? [Number(peerId)] : [])] : operation.id === groupId ? [Number(peerId)] : []);
    assert.equal(submitted.atState, replying ? 2 : operation.id === groupId ? 0 : 1);
    const receipt = capture.receipts.find(item => item['messageId'] === result.messageId && item['sessionId'] === target.id);
    assert.ok(receipt);
    assert.equal(receipt['code'], 0);
    assert.ok(receipt['businessCode'] === null || receipt['businessCode'] === 0);
    assert.equal(receipt['draftId'], result.receipt?.draftId);
    assert.equal(receipt['msgIdx'], record['msgIdx']);
    results.push({ 场景: operation.kind, 会话: target.id, 正式ID: result.messageId, 索引: record['msgIdx'], font: content['font'], atState: record['atState'], atMemberIDList: membersList,
      引用ID: content['replyedMsgId'], 引用索引: content['replyedMsgIndex'], 引用作者: content['replyedID'], 提交元数据: submitted, receipt, 原生提交次数: 1 });
  }
  report['协议通过'] = results.length === 4;
  if (process.argv.includes('--inspect')) {
    console.log('T08_READY：四条本轮消息已发送；请接收端核对私聊格式/引用、群普通/引用提及及各自通知。finish仅清理本轮本人消息。');
    console.log(JSON.stringify(report, null, 2));
    const input = createInterface({ input: process.stdin, output: process.stdout });
    for await (const line of input) { if (line.trim() === 'finish') break; }
    input.close();
  }
} catch (error) { fail('错误', error); }
finally {
  if (connected) {
    const cleaned: Array<Record<string, unknown>> = [];
    for (const target of targets) {
      try {
        const records = (await history(target.id)).filter(item => operations.some(operation => operation.id === target.id && item['msgFlag'] === operation.key) && String(item['sender']) === uid);
        for (const record of records) {
          const id = String(record['id']);
          assert.equal(await driver.recallMessage(id, target), true);
          const recalled = (await history(target.id)).find(item => String(item['id']) === id);
          assert.ok(recalled && /^[CD]/.test(String(recalled['msgFlag'])));
          cleaned.push({ 会话: target.id, 正式ID: id, 已撤回: true });
        }
      } catch (error) { fail('本人消息清理错误', error); }
    }
    report['清理'] = cleaned;
    if (captureInstalled) {
      try { await verification.evaluate('window.__kairo_t08_capture.cleanup()'); }
      catch (error) { fail('自有采集退出错误', error); }
    }
  }
  try { await driver.disconnect(); } catch (error) { fail('Driver退出错误', error); }
  if (connected) report['退出后'] = await verification.evaluate('({采集残留:!!window.__kairo_t08_capture,DriverHook残留:!!window.__kairo_bridge_cleanup,在途发送:window.__kairo_pending_sends?.size||0})');
  await verification.disconnect();
  await mkdir(new URL('../tmp/', import.meta.url), { recursive: true });
  for (const name of [`t08-${runId}.json`, 't08-live-evidence.json'])
    await writeFile(new URL(`../tmp/${name}`, import.meta.url), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
}
