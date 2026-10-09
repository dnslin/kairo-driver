import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { createInterface, type Interface } from 'node:readline';
import { setTimeout as sleep } from 'node:timers/promises';
import { createNativeMessageKey, KK9Driver } from '../src/index.js';
import type { KK9Message, KK9Session } from '../src/types/index.js';

const [uid, login, privateId, peerId, peerLogin, groupId, groupReceiver, groupName] = process.argv.slice(2);
assert.ok(uid && login && privateId && peerId && peerLogin && groupId && groupReceiver && groupName,
  '参数：登录UID 登录账号 私聊原生ID 对端UID 对端账号 群原生ID 群接收对象 群精确名 [--listen]');
assert.equal(process.env['KK9_REAL_TEST_CONFIRM'], `${uid}:${privateId}:${groupId}`, '双目标确认门禁未通过');
assert.equal(process.env['KK9_STAGE1_CONFIRM'], `${uid}:${peerId}:${privateId}`, '私聊确认门禁未通过');
assert.notEqual(groupId, '716827', '同名716827群未经授权，禁止操作');
const cache = process.env['JSHOOKMCP_CACHE'];
assert.ok(cache, '必须指定已安装的 JSHOOKMCP_CACHE，脚本不安装依赖');
const toolRequire = createRequire(path.join(cache, 'package.json'));
interface McpClient {
  connect(transport: unknown): Promise<void>;
  callTool(request: { name: string; arguments: Record<string, unknown> }, unused?: undefined, options?: { timeout: number }): Promise<{ isError?: boolean; content: Array<{ type: string; text?: string }> }>;
  close(): Promise<void>;
}
const { Client } = toolRequire('@modelcontextprotocol/sdk/client/index.js') as {
  Client: new (identity: { name: string; version: string }) => McpClient;
};
const { StdioClientTransport } = toolRequire('@modelcontextprotocol/sdk/client/stdio.js') as {
  StdioClientTransport: new (options: Record<string, unknown>) => { stderr?: NodeJS.ReadableStream | null };
};
const transport = new StdioClientTransport({ command: process.execPath,
  args: [path.join(cache, 'node_modules/@jshookmcp/jshook/dist/index.mjs')], cwd: cache,
  env: { MCP_TRANSPORT: 'stdio', MCP_TOOL_PROFILE: 'search', SEARCH_VECTOR_ENABLED: 'false' }, stderr: 'pipe' });
transport.stderr?.on('data', () => { /* 排空工具服务诊断，不保存客户端数据。 */ });
const mcp = new Client({ name: 'kairo-t04-events', version: '1.0.0' });
const driver = new KK9Driver({ cdp: { url: process.env['CDP_URL'] || 'http://127.0.0.1:9222',
  pageMatch: process.env['PAGE_MATCH'] || 'renderer.html' }, rejectExistingBridge: true });
const runId = randomUUID();
const labels = ['sdk-private', 'sdk-group', 'sdk-absent-private', 'sdk-absent-group',
  'private-inbound', 'group-inbound', 'private-manual', 'group-manual',
  'private-absent-inbound', 'group-absent-inbound'];
const markers = Object.fromEntries(labels.map(label => [label, `T04/${runId}/${label}`]));
const operations = [privateId, groupId].map((sessionId, index) => ({ sessionId,
  label: index === 0 ? 'sdk-private' : 'sdk-group', operationId: `${runId}:${index}` }));
const absentOperations = [privateId, groupId].map((sessionId, index) => ({ sessionId,
  label: index === 0 ? 'sdk-absent-private' : 'sdk-absent-group', operationId: `${runId}:absent:${index}` }));
const events: Array<Record<string, unknown>> = [];
const ats: Array<Record<string, unknown>> = [];
let messageCount = 0;
let atCount = 0;
let recalledCount = 0;
let statusBaseline: { messages: number; ats: number; recalls: number; states: number } | undefined;
const owned = new Map<string, { id: string; sessionId: string; label: string; recalled: boolean }>();
const report: Record<string, unknown> = { 运行ID: runId, 全部验收成立: false, 实测: [],
  缺项: ['私聊真实新入站', '群成员真实新入站', '双目标本机人工发送', '实际组件缺席时双目标接收与回显'],
  SDK事件: events, 提及事件: ats, 保存聊天正文或凭据: false };
let targets: KK9Session[] = [];
let captureInstalled = false;
let connected = false;
let phase = '自动双目标';
let initialWindow: string | null = null;
let queue = Promise.resolve();
const evidenceDirectory = new URL('../tmp/', import.meta.url);
let interrupted = false;
let input: Interface | undefined;
const onInterrupt = (): void => { interrupted = true; input?.close(); };
process.once('SIGINT', onInterrupt);
process.once('SIGTERM', onInterrupt);

function updateAcceptance(): void {
  const protocol = report['原生独立采集'] as { records: Array<Record<string, unknown>>; baseline: { chats: Array<{ uid: number }> } } | undefined;
  if (!protocol) return;
  const checks: Array<{ 场景: string; 通过: boolean; 消息: unknown[] }> = [];
  for (const label of labels.filter(label => !label.startsWith('sdk-'))) {
    const sessionId = label.startsWith('private-') ? privateId : groupId;
    const incoming = label.endsWith('inbound');
    const observed = events.filter(row => row['label'] === label && row['sessionId'] === sessionId);
    const matched = observed.map(event => {
      const rows = protocol.records.filter(row => row['id'] === event['id'] && row['sessionId'] === sessionId &&
        row['msgIdx'] === event['msgIdx'] && row['sender'] === event['senderId']);
      const raw = rows.find(row => row['source'] === (label.endsWith('manual') ? 'sendMsgCallback' : 'message'));
      const surface = raw?.['surface'] as { active: string | null; chats: Array<{ uid: number }> } | undefined;
      const sameIdentityCount = events.filter(row => row['id'] === event['id'] && row['sessionId'] === sessionId).length;
      const expectedSender = incoming ? (sessionId === privateId ? event['senderId'] === peerId : event['senderId'] !== uid) : event['senderId'] === uid;
      const absent = !label.includes('absent') || surface?.chats.length === 0;
      return { ...event, 原生: raw, 通过: Boolean(raw && expectedSender && absent &&
        sameIdentityCount === 1 && event['direction'] === (incoming ? 'inbound' : 'outbound') && !event['sdkSendKey']) };
    });
    checks.push({ 场景: label, 通过: matched.length > 0 && matched.every(row => row.通过), 消息: matched });
  }
  for (const sessionId of [privateId, groupId]) {
    const label = sessionId === privateId ? 'private-inbound' : 'group-inbound';
    const rows = protocol.records.filter(row => row['label'] === label && row['source'] === 'message');
    const hidden = rows.some(row => {
      const surface = row['surface'] as { active: string | null };
      return surface.active === (sessionId === privateId ? groupId : privateId);
    });
    const rebuilt = rows.some(row => {
      const surface = row['surface'] as { chats: Array<{ uid: number }> };
      const chats = surface.chats;
      return chats.length > 0 && protocol.baseline.chats.length > 0 && chats[0]!.uid !== protocol.baseline.chats[0]!.uid;
    });
    checks.push({ 场景: `${sessionId}目标未显示时接收`, 通过: hidden, 消息: rows });
    checks.push({ 场景: `${sessionId}实际组件重建后接收`, 通过: rebuilt, 消息: rows });
  }
  const auto = report['自动双目标'] as Array<Record<string, unknown>> | undefined;
  checks.push({ 场景: '双目标自动SDK回显、历史和操作防重', 通过: auto?.length === 2, 消息: auto || [] });
  const absent = report['组件缺席SDK'] as Array<Record<string, unknown>> | undefined;
  checks.push({ 场景: '实际组件缺席时双目标SDK回显', 通过: absent?.length === 2, 消息: absent || [] });
  const states = protocol.records.filter(row => row['source'] === 'session-only');
  if (statusBaseline && states.length > statusBaseline.states && messageCount === statusBaseline.messages && atCount === statusBaseline.ats && recalledCount === statusBaseline.recalls)
    report['状态分流实测'] = { 原生状态数量: states.length - statusBaseline.states, message新增: 0, at新增: 0, recalled新增: 0 };
  checks.push({ 场景: '实际session-only状态包分流', 通过: Boolean(report['状态分流实测']), 消息: states });
  report['来源与场景对照'] = checks;
  report['缺项'] = checks.filter(check => !check.通过).map(check => check.场景);
  const exit = report['退出后'] as { captureRemaining: boolean; driverHookRemaining: boolean; nativeObserverRemaining: boolean; pendingSends: number } | undefined;
  report['全部验收成立'] = checks.every(check => check.通过) && [...owned.values()].every(message => message.recalled) &&
    Boolean(exit && !exit.captureRemaining && !exit.driverHookRemaining && !exit.nativeObserverRemaining && exit.pendingSends === 0) && !process.exitCode;
}

async function evaluate<T>(expression: string): Promise<T> {
  const result = await mcp.callTool({ name: 'call_tool', arguments: { name: 'electron_attach', args: {
    port: Number(new URL(process.env['CDP_URL'] || 'http://127.0.0.1:9222').port || 9222),
    pageUrl: process.env['PAGE_MATCH'] || 'renderer.html', evaluate: expression,
  } } }, undefined, { timeout: 60000 });
  const text = result.content.find(item => item.type === 'text')?.text;
  assert.ok(text, 'jshookmcp 未返回取证结果');
  const parsed = JSON.parse(text) as { success?: boolean; error?: string; result?: T };
  assert.notEqual(result.isError, true, parsed.error || 'jshookmcp 调用错误');
  assert.equal(parsed.success, true, parsed.error || 'jshookmcp 原生观察失败');
  return parsed.result as T;
}
async function save(): Promise<void> {
  if (captureInstalled) report['原生独立采集'] = await evaluate('window.__kairo_t04_capture.snapshot()');
  report['清理'] = [...owned.values()];
  updateAcceptance();
  await mkdir(evidenceDirectory, { recursive: true });
  const data = JSON.stringify(report, null, 2) + '\n';
  await writeFile(new URL('t04-live-evidence.json', evidenceDirectory), data);
  await writeFile(new URL(`t04-${runId}.json`, evidenceDirectory), data);
}
function labelOf(content: string): string | undefined {
  return labels.find(label => content.includes(markers[label]!));
}
function metadata(message: KK9Message): Record<string, unknown> {
  return { label: labelOf(message.content), id: message.id, sessionId: message.sessionId, msgIdx: message.msgIdx,
    senderId: message.senderId, direction: message.direction, origin: message.origin,
    sdkSendKey: message.sdkSendKey, messageType: message.messageType, deviceID: message.raw?.['deviceID'], phase };
}
driver.on('error', error => { report['Driver错误'] = error.message; console.error('Driver错误', error.message); });
driver.on('message', message => {
  if (![privateId, groupId].includes(message.sessionId)) return;
  messageCount += 1;
  const label = labelOf(message.content);
  if (!label) return;
  events.push(metadata(message));
  if (message.senderId === uid) owned.set(`${message.sessionId}:${message.id}`,
    { id: message.id, sessionId: message.sessionId, label, recalled: false });
  console.log('SDK真实消息', JSON.stringify(metadata(message)));
  queue = queue.then(save).catch((error: unknown) => {
    report['证据保存错误'] = String(error); console.error('证据保存错误', error); process.exitCode = 1;
  });
});
driver.on('at', message => {
  if (![privateId, groupId].includes(message.sessionId)) return;
  atCount += 1;
  if (labelOf(message.content)) ats.push(metadata(message));
});
driver.on('recalled', event => { if ([privateId, groupId].includes(event.sessionId)) recalledCount += 1; });

async function snapshot(): Promise<{ active: string | null; chats: Array<{ uid: number; sessionId: string }>; listeners: Record<string, number> }> {
  return evaluate('window.__kairo_t04_capture.surface()');
}
async function nativeHistory(sessionId: string): Promise<Array<Record<string, unknown>>> {
  return evaluate(`window.__kairo_t04_capture.history(${JSON.stringify(sessionId)})`);
}
async function cleanupMessages(): Promise<void> {
  if (!connected) return;
  assert.equal(await driver.getCurrentUserId(), uid, '清理前实际登录身份已改变');
  for (const target of targets) {
    const history = await driver.getRecentMessages(target, 100);
    for (const message of history) {
      const label = labelOf(message.content);
      if (!label || message.senderId !== uid || message.isRecalled) continue;
      const key = `${target.id}:${message.id}`;
      if (!owned.has(key)) owned.set(key, { id: message.id, sessionId: target.id, label, recalled: false });
    }
  }
  for (const message of owned.values()) {
    if (message.recalled) continue;
    const target = targets.find(item => item.id === message.sessionId);
    assert.ok(target, '清理目标必须属于本轮精确授权范围');
    const record = (await nativeHistory(target.id)).find(item => String(item['id']) === message.id);
    assert.ok(record && String(record['sender']) === uid && record['label'] === message.label, '未核对本轮本人正式记录，拒绝撤回');
    if (/^[CD]/.test(String(record['msgFlag']))) { message.recalled = true; continue; }
    assert.equal(await driver.recallMessage(message.id, target), true, '本轮本人消息撤回失败');
    const recalled = (await nativeHistory(target.id)).find(item => String(item['id']) === message.id);
    assert.ok(recalled && /^[CD]/.test(String(recalled['msgFlag'])), '正式撤回标记未确认');
    message.recalled = true;
  }
}

try {
  await mcp.connect(transport);
  const described = await mcp.callTool({ name: 'describe_tool', arguments: { name: 'electron_attach' } });
  assert.ok(described.content.some(item => item.text?.includes('evaluate')), '当前 MCP 未提供原生页面观察接口');
  await mcp.callTool({ name: 'activate_tools', arguments: { names: ['electron_attach'] } });
  const scope = { uid, login, privateId, peerId, peerLogin, groupId, groupReceiver, groupName, markers,
    keys: [...operations, ...absentOperations].map(operation => createNativeMessageKey('text', operation.operationId)) };
  report['原生身份与协议前提'] = await evaluate(`(async () => {
    if (window.__kairo_t04_capture || window.__kairo_bridge_cleanup) throw new Error('已有采集或 Driver Hook，拒绝覆盖');
    const scope = ${JSON.stringify(scope)};
    const ipc = window.ipcRenderer || window.require('electron').ipcRenderer;
    // 当前 KK9 的 Electron 22 没有 Promise.withResolvers，使用其现有 Promise 构造接口。
    const query = (method, ...args) => new Promise((resolve, reject) => {
      const id = Date.now() + Math.floor(Math.random()*10000), channel = 'data-' + id;
      const listener = (_event, response) => { clearTimeout(timer); ipc.removeListener(channel, listener);
        response?.code === 0 ? resolve(response.data) : reject(new Error(method + ':' + response?.code)); };
      const timer = setTimeout(() => { ipc.removeListener(channel, listener); reject(new Error(method + '超时')); }, 5000);
      ipc.on(channel, listener); ipc.send('data', { id, args: [method, ...args], progress: false });
    });
    const me = await query('getMemberDetail'), peer = await query('getMemberDetail', Number(scope.peerId));
    const conversations = await query('getConversations');
    const privateSession = Object.values(conversations.sessionsInfo || {}).find(s => String(s.id) === scope.privateId);
    const groupSession = Object.values(conversations.sessionsInfo || {}).find(s => String(s.id) === scope.groupId);
    const privateReceiver = String(privateSession?.typeID) === scope.uid ? String(privateSession?.creater) : String(privateSession?.typeID);
    if (String(me.id) !== scope.uid || me.login_name !== scope.login || String(peer.id) !== scope.peerId || peer.login_name !== scope.peerLogin ||
        privateSession?.type !== 0 || privateReceiver !== scope.peerId || groupSession?.type !== 1 ||
        String(groupSession.typeID) !== scope.groupReceiver || groupSession.typeName !== scope.groupName) throw new Error('原生身份或精确目标不符');
    const capture = { records: [], requests: [], ipc };
    const labels = Object.keys(scope.markers);
    function textOf(message) { let content = message?.content; if (typeof content === 'string') { try { content = JSON.parse(content); } catch { return content; } }
      return Array.isArray(content?.content) ? content.content.map(n => n.text || '').join('') : ''; }
    function meta(message, sessionID, source) {
      const label = labels.find(label => textOf(message).includes(scope.markers[label]));
      return { id: String(message.id ?? message.msgID), sessionId: String(sessionID ?? message.sessionID), msgIdx: message.msgIdx,
        sender: String(message.sender), deviceID: message.deviceID, sessionType: message.sessionType,
        contentType: message.contentType, event: message.content?.event, msgFlag: message.msgFlag, label, source };
    }
    capture.surface = () => {
      const root = document.querySelector('.main-page')?.__vue__, seen = new Set(), chats = [];
      function visit(vm) { if (!vm || seen.has(vm)) return; seen.add(vm);
        if (vm.$options?.name === 'chat-content') chats.push({ uid: vm._uid, sessionId: String(vm.sesInfo?.id), destroyed: vm._isDestroyed });
        for (const child of vm.$children || []) visit(child); }
      visit(root);
      return { active: root?.activedSes ? String(root.activedSes.id) : null, chats,
        listeners: { message: ipc.listenerCount('message'), private: ipc.listenerCount('0-' + scope.peerId + '-sendMsgCallback'), group: ipc.listenerCount('1-' + scope.groupReceiver + '-sendMsgCallback') } };
    };
    const baseline = capture.surface();
    const onNative = (_event, packet) => {
      const payload = packet?.args;
      if (![scope.privateId, scope.groupId].includes(String(payload?.sessionID))) return;
      const surface = capture.surface();
      if (!payload.message) capture.records.push({ source: 'session-only', sessionId: String(payload.sessionID), userReadIndex: payload.session?.userReadIndex, surface });
      for (const message of payload.message || []) { const row = meta(message, payload.sessionID, 'message');
        if (row.label || message.contentType === 6) capture.records.push({ ...row, surface }); }
    };
    ipc.on('message', onNative);
    const originalEmit = ipc.emit;
    const emit = function(channel, ...args) {
      if (['0-' + scope.peerId + '-sendMsgCallback', '1-' + scope.groupReceiver + '-sendMsgCallback'].includes(channel)) {
        const receipt = args[1]?.args, message = receipt?.data;
        if (message) { const row = meta(message, message.sessionID, 'sendMsgCallback');
          if (row.label) capture.records.push({ ...row, code: receipt.code, draftId: String(receipt.msgID), surface: capture.surface() }); }
      }
      return originalEmit.call(this, channel, ...args);
    };
    const originalSend = ipc.send;
    const send = function(channel, request, ...args) {
      const method = request?.args?.[0], message = request?.args?.[1];
      if (channel === 'data' && ['insertSendBefoeMsg', 'sendMessageNew'].includes(method) && scope.keys.includes(message?.msgFlag))
        capture.requests.push({ method, key: message.msgFlag, sessionId: String(message.sessionID), sender: String(message.sender) });
      return originalSend.call(this, channel, request, ...args);
    };
    ipc.emit = emit; ipc.send = send;
    capture.history = async sessionId => { if (![scope.privateId, scope.groupId].includes(sessionId)) throw new Error('越界历史请求');
      const rows = await query('getMessages', { sessionID: Number(sessionId), count: 100, endIdx: 2147483647, sendTime: 0 });
      if (!Array.isArray(rows)) throw new Error('原生历史不是数组');
      return rows.map(message => meta(message, sessionId, 'history'));
    };
    capture.snapshot = () => ({ records: capture.records, requests: capture.requests, baseline, current: capture.surface() });
    capture.cleanup = () => { ipc.removeListener('message', onNative);
      if (ipc.emit !== emit || ipc.send !== send) throw new Error('本轮 Hook 所有权不符，拒绝覆盖他人 Hook');
      ipc.emit = originalEmit; ipc.send = originalSend; delete window.__kairo_t04_capture;
      return { surface: capture.surface(), emitRestored: ipc.emit === originalEmit, sendRestored: ipc.send === originalSend }; };
    window.__kairo_t04_capture = capture;
    return { identity: { uid: String(me.id), login: me.login_name },
      targets: [{ id: scope.privateId, receiver: privateReceiver, nativeType: privateSession.type },
        { id: scope.groupId, receiver: String(groupSession.typeID), name: groupSession.typeName, nativeType: groupSession.type }], baseline };
  })()`);
  captureInstalled = true;
  initialWindow = (await snapshot()).active;
  await driver.connect(); connected = true;
  assert.equal(await driver.getCurrentUserId(), uid);
  assert.equal((await driver.getUserProfile(uid))?.loginName, login);
  const sessions = await driver.getSessions();
  targets = [privateId, groupId].map(id => { const session = sessions.find(item => item.id === id); assert.ok(session); return session; });
  assert.equal(targets[0]!.receiverId, peerId); assert.equal(targets[0]!.nativeType, 0);
  assert.equal((await driver.getEmployeeBySession(targets[0]!))?.loginName, peerLogin);
  assert.equal(targets[1]!.receiverId, groupReceiver); assert.equal(targets[1]!.nativeType, 1); assert.equal(targets[1]!.name, groupName);
  const automatic: Array<Record<string, unknown>> = [];
  report['自动双目标'] = automatic;
  for (const operation of operations) {
    if (interrupted) break;
    const target = targets.find(item => item.id === operation.sessionId)!;
    const other = targets.find(item => item.id !== target.id)!;
    const previous = await snapshot();
    assert.equal(await driver.selectSession(other.id), true, '只在授权两目标内切换');
    await sleep(300);
    const before = await snapshot();
    assert.equal(before.active, other.id, '发送时必须显示另一个授权目标');
    const historyBefore = messageCount, atBefore = atCount, recallBefore = recalledCount;
    const history = await driver.getRecentMessages(target, 100);
    const native = await nativeHistory(target.id);
    assert.deepEqual(history.map(message => [message.id, message.msgIdx]), native.map(message => [message['id'], message['msgIdx']]));
    assert.equal(messageCount, historyBefore, '历史读取新增实时消息'); assert.equal(atCount, atBefore, '历史读取新增提及');
    assert.equal(recalledCount, recallBefore, '历史读取新增撤回');
    const options = { targetSessionId: target.id, operationId: operation.operationId };
    let result = await driver.sendText(markers[operation.label]!, options);
    if (result.status === 'unknown') result = await driver.getSendStatus(operation.operationId);
    assert.equal(result.status, 'sent', '没有本次业务确认，不把存在历史记录当作sent，也不重发');
    assert.ok(result.messageId);
    for (let attempt = 0; attempt < 100 && !events.some(row => row['id'] === result.messageId && row['sessionId'] === target.id); attempt++) await sleep(50);
    const echo = events.filter(row => row['id'] === result.messageId && row['sessionId'] === target.id);
    assert.equal(echo.length, 1, 'SDK自身回显必须且仅一次');
    assert.equal(echo[0]!['direction'], 'outbound'); assert.equal(echo[0]!['senderId'], uid);
    assert.equal(echo[0]!['sdkSendKey'], createNativeMessageKey('text', operation.operationId));
    const protocol = await evaluate<{ records: Array<Record<string, unknown>>; requests: Array<Record<string, unknown>> }>('window.__kairo_t04_capture.snapshot()');
    const receipt = protocol.records.find(row => row['id'] === result.messageId && row['sessionId'] === target.id && row['source'] === 'sendMsgCallback');
    assert.ok(receipt, '独立 jshookmcp 没有观察到本次原生回执');
    assert.equal(receipt['sender'], uid); assert.equal(receipt['code'], 0); assert.equal(receipt['msgIdx'], echo[0]!['msgIdx']);
    const requestsBefore = protocol.requests.length, eventsBefore = messageCount;
    assert.equal((await driver.sendText(markers[operation.label]!, options)).status, 'sent');
    assert.equal((await driver.getSendStatus(operation.operationId)).status, 'sent');
    await driver.getRecentMessages(target, 100); await sleep(100);
    const after = await snapshot();
    const repeated = await evaluate<{ requests: unknown[] }>('window.__kairo_t04_capture.snapshot()');
    assert.equal(repeated.requests.length, requestsBefore, '重复操作或只读查询增加原生提交');
    assert.equal(messageCount, eventsBefore, '重复操作或历史查询增加消息');
    assert.equal(after.active, other.id, '原生发送擅自切窗口');
    automatic.push({ target: target.id, operationId: operation.operationId, result, echo: echo[0], receipt,
      previous, before, after, 历史不重放: true, 重复与查询不提交不回显: true,
      实际重建: previous.chats.length > 0 && before.chats.length > 0 && previous.chats[0]!.uid !== before.chats[0]!.uid });
  }
  if (automatic.length === 2) {
    report['实测'] = ['双目标 SDK sent 与原生回执逐条关联', '双目标 outbound 自身回显一次', '目标未显示时发送与回显', '读取前后历史不重放', '重复 operationId 与只读状态查询不增加提交或回显'];
    if (automatic.every(row => row['实际重建'] === true)) (report['实测'] as string[]).push('授权会话切换后的实际组件重建');
  } else report['中断'] = '自动双目标尚未全部执行，保留实际已执行记录';
  await cleanupMessages();
  await save();
  if (process.argv.includes('--listen') && !interrupted) {
    phase = '协助真实来源';
    assert.equal(await driver.selectSession(groupId), true);
    console.log('T04监听就绪', JSON.stringify({ runId, privateId, peerLogin, groupId, groupName }));
    for (const label of labels.filter(label => !label.startsWith('sdk-'))) console.log('协助标记', label, markers[label]);
    console.log('控制命令：snapshot 记录现场；private/group 切到另一授权会话；status 准备只读状态分流观察；absent 仅在实际组件不存在时发送双目标缺席测试；cleanup 只清理本轮本人文本；finish 清理并退出。禁止删除组件或伪造IPC。');
    input = createInterface({ input: process.stdin });
    try {
      for await (const command of input) {
        if (command.trim() === 'finish') break;
        if (['private', 'group'].includes(command.trim())) {
          phase = command.trim() === 'private' ? '私聊目标未显示' : '群目标未显示';
          assert.equal(await driver.selectSession(command.trim() === 'private' ? groupId : privateId), true);
        } else if (command.trim() === 'cleanup') await cleanupMessages();
        else if (command.trim() === 'absent') {
          phase = '实际组件缺席';
          const before = await snapshot();
          if (before.chats.length !== 0) {
            report['缺席场景不可达'] = { 事实: '实际聊天组件仍存在，未发送缺席测试', surface: before };
            console.log('实际聊天组件仍存在，未发送缺席测试；监听保持运行。');
            await save();
            continue;
          }
          assert.equal(await driver.getCurrentUserId(), uid);
          const absentRows: Array<Record<string, unknown>> = [];
          report['组件缺席SDK'] = absentRows;
          for (const operation of absentOperations) {
            const result = await driver.sendText(markers[operation.label]!, { targetSessionId: operation.sessionId, operationId: operation.operationId });
            const confirmed = result.status === 'unknown' ? await driver.getSendStatus(operation.operationId) : result;
            assert.equal(confirmed.status, 'sent', '缺席场景无业务确认，不重发unknown');
            for (let attempt = 0; attempt < 100 && !events.some(row => row['id'] === confirmed.messageId && row['sessionId'] === operation.sessionId); attempt++) await sleep(50);
            const echo = events.filter(row => row['id'] === confirmed.messageId && row['sessionId'] === operation.sessionId);
            assert.equal(echo.length, 1); assert.equal(echo[0]!['sdkSendKey'], createNativeMessageKey('text', operation.operationId));
            assert.equal(echo[0]!['direction'], 'outbound'); assert.equal(echo[0]!['senderId'], uid);
            const after = await snapshot(); assert.equal(after.chats.length, 0, '发送后组件已出现，缺席场景不能记作通过');
            const native = await evaluate<{ records: Array<Record<string, unknown>> }>('window.__kairo_t04_capture.snapshot()');
            const receipt = native.records.find(row => row['id'] === confirmed.messageId && row['sessionId'] === operation.sessionId && row['source'] === 'sendMsgCallback');
            assert.ok(receipt); assert.equal(receipt['code'], 0); assert.equal(receipt['sender'], uid);
            absentRows.push({ target: operation.sessionId, result: confirmed, echo: echo[0], receipt, before, after });
          }
        }
        else if (command.trim() === 'status') {
          const protocol = await evaluate<{ records: Array<Record<string, unknown>> }>('window.__kairo_t04_capture.snapshot()');
          statusBaseline = { messages: messageCount, ats: atCount, recalls: recalledCount, states: protocol.records.filter(row => row['source'] === 'session-only').length };
          console.log('状态观察已就绪：请在其他设备阅读授权目标的新消息，暂不发文本；随后输入 snapshot 核对无聊天事件。');
        }
        report['协助现场'] = await snapshot();
        await queue; await save();
        console.log('监听现场', JSON.stringify(report['协助现场']));
      }
    } finally { input.close(); }
  }
} catch (error) {
  report['失败尝试'] = error instanceof Error ? error.message : String(error);
  console.error('T04真机验证失败', report['失败尝试']); process.exitCode = 1;
} finally {
  await queue;
  try { await cleanupMessages(); } catch (error) { report['清理错误'] = String(error); process.exitCode = 1; }
  if (captureInstalled) {
    try {
      if (initialWindow && [privateId, groupId].includes(initialWindow) && connected) await driver.selectSession(initialWindow);
      await sleep(300); await save();
    } catch (error) { report['末次采集错误'] = String(error); process.exitCode = 1; }
  }
  try { await driver.disconnect(); } catch (error) { report['Driver退出错误'] = String(error); process.exitCode = 1; }
  if (captureInstalled) {
    try {
      report['退出后'] = await evaluate(`(() => { const result = window.__kairo_t04_capture.cleanup(); return { ...result,
        captureRemaining: !!window.__kairo_t04_capture, driverHookRemaining: typeof window.__kairo_bridge_cleanup === 'function',
        nativeObserverRemaining: typeof window.__kairo_native_send_observer === 'function', pendingSends: window.__kairo_pending_sends?.size || 0 }; })()`);
      captureInstalled = false;
    } catch (error) { report['采集退出错误'] = String(error); process.exitCode = 1; }
  }
  await save(); await mcp.close();
  process.removeListener('SIGINT', onInterrupt); process.removeListener('SIGTERM', onInterrupt);
  console.log('T04本轮结果', JSON.stringify(report, null, 2));
}
