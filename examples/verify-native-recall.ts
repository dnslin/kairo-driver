import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { createInterface, type Interface } from 'node:readline';
import { setTimeout as sleep } from 'node:timers/promises';
import { CdpClient, KK9Driver, callIpcToData } from '../src/index.js';
import type { KK9Session } from '../src/types/index.js';
import { verifyNativeRecallEvidence } from './native-recall-evidence.js';

const [uid, login, privateId, peerId, peerLogin, groupId, groupReceiver, groupName] = process.argv.slice(2);
assert.ok(uid && login && privateId && peerId && peerLogin && groupId && groupReceiver && groupName,
  '参数：登录UID 登录账号 私聊原生ID 对端UID 对端账号 群原生ID 群接收对象 群精确名');
assert.equal(process.env['KK9_REAL_TEST_CONFIRM'], `${uid}:${privateId}:${groupId}`, '双目标确认门禁未通过');
assert.equal(process.env['KK9_STAGE1_CONFIRM'], `${uid}:${peerId}:${privateId}`, '私聊确认门禁未通过');
assert.notEqual(groupId, '716827', '同名716827群禁止操作');
const config = { url: process.env['CDP_URL'] || 'http://127.0.0.1:9222', pageMatch: process.env['PAGE_MATCH'] || 'renderer.html' };
const verification = new CdpClient(config);
const driver = new KK9Driver({ cdp: config, rejectExistingBridge: true });
const runId = randomUUID();
type Row = Record<string, unknown>;
interface Surface { active: string | null; chats: Array<{ uid: number; sessionId: string }>; listeners: number }
interface Capture { requests: Row[]; notices: Row[]; messages: Row[]; baseline: Surface; current: Surface }
const own: Array<{ id: string; sessionId: string; kind: string; operationId: string }> = [];
const events: Array<{ messageId: string; sessionId: string; phase: string }> = [];
const report: Row = { 运行ID: runId, 全部验收成立: false, 保存聊天正文或凭据: false };
let phase = 'SDK';
let targets: KK9Session[] = [];
let installed = false;
let connected = false;
let input: Interface | undefined;
driver.on('recalled', event => {
  if (![privateId, groupId].includes(event.sessionId)) return;
  const metadata = { messageId: event.messageId, sessionId: event.sessionId, phase };
  events.push(metadata);
  console.log('SDK撤回通知', JSON.stringify(metadata));
});
driver.on('error', error => { report['Driver错误'] = error.message; process.exitCode = 1; });

async function query<T>(method: string, args: unknown[] = []): Promise<T> {
  const response = await callIpcToData<T>(verification, method, args);
  assert.equal(response.code, 0, `${method}: ${response.code} ${response.error || response.message || ''}`);
  return response.data!;
}
async function nativeHistory(sessionId: string): Promise<Row[]> {
  return query('getMessages', [{ sessionID: Number(sessionId), count: 100, endIdx: 2147483647, sendTime: 0 }]);
}
async function surface(): Promise<Surface> {
  return verification.evaluate('window.__kairo_t05_capture.surface()');
}
async function setPhase(value: string): Promise<void> {
  phase = value;
  await verification.evaluate(`window.__kairo_t05_capture.phase = ${JSON.stringify(value)}`);
}
async function save(): Promise<void> {
  if (installed) report['独立原生采集'] = await verification.evaluate<Capture>('window.__kairo_t05_capture.snapshot()');
  report['本轮本人消息'] = own;
  report['SDK撤回通知'] = events;
  await mkdir(new URL('../tmp/', import.meta.url), { recursive: true });
  const json = JSON.stringify(report, null, 2) + '\n';
  await writeFile(new URL('../tmp/t05-live-evidence.json', import.meta.url), json);
  await writeFile(new URL(`../tmp/t05-${runId}.json`, import.meta.url), json);
}
async function snapshot(): Promise<void> {
  const before = events.length;
  const historical: Row[] = [];
  for (const target of targets) {
    const sdk = await driver.getRecentMessages(target, 100);
    const native = await nativeHistory(target.id);
    for (const message of sdk) {
      const observed = own.some(item => item.sessionId === target.id && item.id === message.id) ||
        events.some(item => item.sessionId === target.id && item.messageId === message.id);
      if (!observed) continue;
      const original = native.find(item => String(item['id']) === message.id);
      assert.ok(original, '原生历史缺少本轮记录');
      assert.equal(message.msgIdx, original['msgIdx']);
      assert.equal(message.isRecalled, /^[CD]/.test(String(original['msgFlag'])));
      historical.push({ id: message.id, sessionId: target.id, msgIdx: message.msgIdx,
        senderId: message.senderId, isRecalled: message.isRecalled, msgFlag: original['msgFlag'] });
    }
  }
  await sleep(150);
  assert.equal(events.length, before, '历史查询重放了撤回通知');
  report['正式历史'] = historical;
  report['历史不重放'] = true;
  const capture = await verification.evaluate<Capture>('window.__kairo_t05_capture.snapshot()');
  const checks = verifyNativeRecallEvidence({ targetIds: targets.map(target => target.id), uid, peerId,
    capture, history: historical, owned: own, events });
  report['三类撤回'] = checks;
  report['缺项'] = checks.filter(item => !item['通过']).map(item => `${String(item['sessionId'])}/${String(item['kind'])}`);
  await save();
  console.log('当前验收', JSON.stringify(checks));
}

try {
  await verification.connect();
  const me = await query<Row>('getMemberDetail');
  const peer = await query<Row>('getMemberDetail', [Number(peerId)]);
  assert.equal(String(me['id']), uid); assert.equal(me['login_name'], login);
  assert.equal(String(peer['id']), peerId); assert.equal(peer['login_name'], peerLogin);
  const sessions = await query<{ sessionsInfo: Record<string, Row> }>('getConversations');
  const privateSession = Object.values(sessions.sessionsInfo).find(item => String(item['id']) === privateId);
  const groupSession = Object.values(sessions.sessionsInfo).find(item => String(item['id']) === groupId);
  assert.equal(privateSession?.['type'], 0);
  assert.equal(String(privateSession?.['typeID']) === uid ? String(privateSession?.['creater']) : String(privateSession?.['typeID']), peerId);
  assert.equal(groupSession?.['type'], 1); assert.equal(String(groupSession?.['typeID']), groupReceiver);
  assert.equal(groupSession?.['typeName'], groupName);
  report['身份与目标核对'] = { uid, login, privateId, peerId, peerLogin, groupId, groupReceiver, groupName };
  await verification.evaluate(`(() => {
    if (window.__kairo_t05_capture || window.__kairo_bridge_cleanup) throw new Error('已有采集或Driver Hook，拒绝覆盖');
    const scope = ${JSON.stringify({ privateId, groupId })};
    const ipc = window.ipcRenderer || window.require('electron').ipcRenderer;
    const capture = { phase: 'SDK', requests: [], notices: [], messages: [] };
    capture.surface = () => {
      const root = document.querySelector('.main-page')?.__vue__, seen = new Set(), chats = [];
      function visit(vm) { if (!vm || seen.has(vm)) return; seen.add(vm);
        if (vm.$options?.name === 'chat-content') chats.push({ uid: vm._uid, sessionId: String(vm.sesInfo?.id) });
        for (const child of vm.$children || []) visit(child); }
      visit(root);
      return { active: root?.activedSes ? String(root.activedSes.id) : null, chats, listeners: ipc.listenerCount('message') };
    };
    capture.baseline = capture.surface();
    const onMessage = (_event, packet) => {
      const payload = packet?.args, sessionId = String(payload?.sessionID);
      if (![scope.privateId, scope.groupId].includes(sessionId)) return;
      for (const message of payload.message || []) {
        capture.messages.push({ id: String(message.id), sessionId, msgIdx: message.msgIdx,
          senderId: String(message.sender), contentType: message.contentType, phase: capture.phase });
        let content = message.content;
        if (typeof content === 'string') { try { content = JSON.parse(content); } catch { continue; } }
        if (message.contentType === 6 && content?.event === 'CancelMessage')
          capture.notices.push({ id: String(message.id), messageId: String(content.msgID), sessionId,
            byAdmin: content.byAdmin, surface: capture.surface() });
      }
    };
    ipc.on('message', onMessage);
    const originalSend = ipc.send, pending = new Map();
    const send = function(channel, request, ...rest) {
      const target = request?.args?.[1];
      if (channel === 'data' && request?.args?.[0] === 'cancelMessage' && [scope.privateId, scope.groupId].includes(String(target?.sessionID))) {
        const row = { messageId: String(target.msgID), sessionId: String(target.sessionID), msgIdx: target.msgIdx,
          type: target.type, phase: capture.phase, surface: capture.surface() };
        capture.requests.push(row);
        const reply = 'data-' + request.id;
        const onReply = (_event, result) => { row.code = result?.code; pending.delete(reply); ipc.removeListener(reply, onReply); };
        pending.set(reply, onReply); ipc.on(reply, onReply);
      }
      return originalSend.call(this, channel, request, ...rest);
    };
    ipc.send = send;
    capture.snapshot = () => ({ requests: capture.requests, notices: capture.notices, messages: capture.messages,
      baseline: capture.baseline, current: capture.surface() });
    capture.cleanup = () => {
      ipc.removeListener('message', onMessage);
      for (const [channel, listener] of pending) ipc.removeListener(channel, listener);
      if (ipc.send !== send) throw new Error('本轮采集发送Hook已被替换');
      ipc.send = originalSend; delete window.__kairo_t05_capture;
      return { surface: capture.surface(), driverHookRemaining: !!window.__kairo_bridge_cleanup,
        observerRemaining: !!window.__kairo_native_send_observer, captureRemaining: !!window.__kairo_t05_capture,
        pendingSends: window.__kairo_pending_sends?.size || 0 };
    };
    window.__kairo_t05_capture = capture;
  })()`);
  installed = true;
  await driver.connect(); connected = true;
  assert.equal(await driver.getCurrentUserId(), uid);
  const sdkSessions = await driver.getSessions();
  targets = [privateId, groupId].map(id => { const target = sdkSessions.find(item => item.id === id); assert.ok(target); return target; });
  const automatic: Row[] = [];
  report['SDK撤回实测'] = automatic;
  for (const target of targets) {
    for (const kind of ['SDK', '人工']) {
      const operationId = `${runId}:${target.id}:${kind}`;
      const result = await driver.sendText(`T05 撤回测试 ${kind} ${runId.slice(0, 8)}`, { targetSessionId: target.id, operationId });
      assert.equal(result.status, 'sent', result.error || '发送未确认，不重发');
      own.push({ id: result.messageId, sessionId: target.id, kind, operationId });
      if (kind === '人工') continue;
      const before = await surface();
      assert.equal(await driver.recallMessage(result.messageId, target), true);
      const after = await surface(); assert.equal(after.active, before.active);
      automatic.push({ sessionId: target.id, messageId: result.messageId, before, after });
    }
  }
  await setPhase('监听');
  await save();
  console.log('T05监听就绪', JSON.stringify({ runId, 人工撤回目标: own.filter(item => item.kind === '人工'), 当前窗口: await surface() }));
  console.log('仅需：本机在私聊716791和群793803各用菜单撤回本轮“人工”文本；int2024在两目标各发一条新测试文本并自行撤回。禁止716827和旧消息。请在KK9内人工打开授权窗口；snapshot核对结果，finish清理本人消息并退出。');
  input = createInterface({ input: process.stdin, output: process.stdout });
  process.once('SIGINT', () => input?.close());
  process.once('SIGTERM', () => input?.close());
  for await (const line of input) {
    const command = line.trim();
    if (command === 'finish') break;
    if (command === 'snapshot') await snapshot();
    else console.log('请在KK9内人工打开716791或793803；命令：snapshot/finish');
  }
  await snapshot();
} catch (error) {
  report['错误'] = String(error); console.error(error); process.exitCode = 1;
} finally {
  input?.close();
  if (installed && connected) {
    try {
      await setPhase('清理');
      assert.equal(await driver.getCurrentUserId(), uid, '清理时登录身份改变');
      for (const message of own) {
        const target = targets.find(item => item.id === message.sessionId); assert.ok(target);
        const record = (await nativeHistory(target.id)).find(item => String(item['id']) === message.id);
        assert.ok(record && String(record['sender']) === uid, '未核对本轮本人正式记录');
        if (!/^[CD]/.test(String(record['msgFlag']))) assert.equal(await driver.recallMessage(message.id, target), true, '本轮消息清理失败');
      }
      report['清理确认'] = await Promise.all(own.map(async message => {
        const record = (await nativeHistory(message.sessionId)).find(item => String(item['id']) === message.id);
        assert.ok(record && /^[CD]/.test(String(record['msgFlag'])), '清理后缺少正式撤回标记');
        return { id: message.id, sessionId: message.sessionId, msgFlag: record['msgFlag'], 已撤回: true };
      }));
    } catch (error) { report['清理错误'] = String(error); process.exitCode = 1; }
  }
  try { await driver.disconnect(); } catch (error) { report['Driver退出错误'] = String(error); process.exitCode = 1; }
  if (installed) {
    try {
      await save();
      report['退出后'] = await verification.evaluate('window.__kairo_t05_capture.cleanup()');
      installed = false;
    } catch (error) { report['采集退出错误'] = String(error); process.exitCode = 1; }
  }
  const checks = report['三类撤回'];
  report['全部验收成立'] = Array.isArray(checks) && checks.length === 6 && checks.every(item => item['通过']) && !process.exitCode;
  await save();
  await verification.disconnect();
  console.log('T05退出', JSON.stringify({ 全部验收成立: report['全部验收成立'], 缺项: report['缺项'], 退出后: report['退出后'] }));
}
