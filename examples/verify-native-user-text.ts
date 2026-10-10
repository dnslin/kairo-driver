import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { CdpClient, KK9Driver, callIpcToData, createNativeMessageKey } from '@kairo/driver';

const [uid, login, peerUid, peerLogin] = process.argv.slice(2);
assert.ok(uid && login && peerUid && peerLogin,
  '参数：登录UID 登录账号 对端UID 对端准确工号；仅向已授权目标发送一条文本');
assert.equal(process.env['KK9_USER_TEXT_CONFIRM'], `${uid}:${peerUid}:${peerLogin}`,
  '必须设置KK9_USER_TEXT_CONFIRM=登录UID:对端UID:对端工号');
const config = {
  url: process.env['CDP_URL'] || 'http://127.0.0.1:9222',
  pageMatch: process.env['PAGE_MATCH'] || 'renderer.html',
};
const driver = new KK9Driver({ cdp: config, rejectExistingBridge: true });
const cdp = new CdpClient(config);
const runId = randomUUID();
const operationId = `${runId}:user-text:${peerLogin}`;
const key = createNativeMessageKey('text-to-user', operationId);
const text = `按工号通知功能验证 ${runId}，无需回复。`;
const report: Record<string, unknown> = {
  运行ID: runId,
  登录: { uid, login },
  目标: { uid: peerUid, login: peerLogin },
  操作ID: operationId,
  通过: false,
  接收端展示与通知: '未验证，不能用sent代替',
  测试消息: '保留供查看，不自动撤回',
  保存正文或凭据: false,
};
let connected = false;
let probeInstalled = false;

driver.on('error', error => {
  report['Driver错误'] = error.message;
  process.exitCode = 1;
});

async function surface() {
  return cdp.evaluate<{
    windowId: string | null;
    messageListeners: number;
    callbackListeners: number;
    driverHook: boolean;
    observer: boolean;
    pendingSends: number;
  }>(`(() => {
    const ipc = window.ipcRenderer || window.require('electron').ipcRenderer;
    const editor = document.querySelector('.chat-editor, .message-editor, .chat-sendArea')?.__vue__;
    return {
      windowId: editor?.activedSes ? String(editor.activedSes.id) : null,
      messageListeners: ipc.listenerCount('message'),
      callbackListeners: ipc.listenerCount('0-' + ${JSON.stringify(peerUid)} + '-sendMsgCallback'),
      driverHook: typeof window.__kairo_bridge_cleanup === 'function',
      observer: typeof window.__kairo_native_send_observer === 'function',
      pendingSends: window.__kairo_pending_sends?.size || 0,
    };
  })()`);
}

try {
  await cdp.connect();
  connected = true;
  const before = await surface();
  report['初始资源'] = before;
  await driver.connect();
  assert.equal(await driver.getCurrentUserId(), uid, '实际登录UID不符');
  assert.equal((await driver.getUserProfile(uid))?.loginName, login, '实际登录账号不符');
  assert.equal((await driver.getUserProfile(peerUid))?.loginName, peerLogin, '目标UID与工号不符');

  await cdp.evaluate(`(() => {
    if (window.__kairo_user_text_probe) throw new Error('已有工号发送采集，未覆盖');
    const ipc = window.ipcRenderer || window.require('electron').ipcRenderer;
    const originalSend = ipc.send;
    const counts = { insert: 0, send: 0 };
    const observedSend = function(channel, request, ...args) {
      const message = request?.args?.[1];
      if (channel === 'data' && message?.msgFlag === ${JSON.stringify(key)} &&
          String(message.receiver) === ${JSON.stringify(peerUid)}) {
        if (request.args[0] === 'insertSendBefoeMsg') counts.insert++;
        if (request.args[0] === 'sendMessageNew') counts.send++;
      }
      return originalSend.call(this, channel, request, ...args);
    };
    ipc.send = observedSend;
    window.__kairo_user_text_probe = {
      counts,
      cleanup() {
        if (ipc.send !== observedSend) throw new Error('采集send被替换，未覆盖其他调用方');
        ipc.send = originalSend;
        delete window.__kairo_user_text_probe;
      },
    };
  })()`);
  probeInstalled = true;

  const result = await driver.sendTextToUser(peerLogin, text, { operationId });
  report['发送结果'] = result;
  assert.equal(result.status, 'sent', '本次发送未确认成功，不重发未知结果');
  assert.ok(result.sessionId && /^[1-9]\d*$/.test(result.sessionId), '成功结果缺正式会话ID');
  assert.equal(result.receipt?.sessionId, result.sessionId, '业务回执会话不符');
  const repeated = await driver.sendTextToUser(peerLogin, text, { operationId });
  const queried = await driver.getSendStatus(operationId);
  for (const observed of [repeated, queried]) {
    assert.equal(observed.status, 'sent');
    assert.equal(observed.messageId, result.messageId);
    assert.equal(observed.sessionId, result.sessionId);
  }
  const session = (await driver.getSessions()).find(item => item.id === result.sessionId);
  assert.ok(session, '新发送会话不在原生列表');
  assert.equal(session.nativeType, 0);
  assert.equal(session.receiverId, peerUid);
  const native = await callIpcToData<Array<{
    id: number; sessionID: number; msgIdx: number; sender: number; receiver: number;
    msgFlag: string; content: string | { content: Array<{ type: number; text?: string }> };
  }>>(cdp, 'getMessages', [{ sessionID: Number(result.sessionId), count: 20, endIdx: 2147483647, sendTime: 0 }]);
  assert.equal(native.code, 0);
  assert.ok(Array.isArray(native.data));
  const matching = native.data.filter(message => message.msgFlag === key);
  assert.equal(matching.length, 1, '本次意图正式记录不唯一');
  const message = matching[0]!;
  assert.equal(String(message.id), result.messageId);
  assert.equal(String(message.sessionID), result.sessionId);
  assert.equal(String(message.sender), uid);
  assert.equal(String(message.receiver), peerUid);
  const content = typeof message.content === 'string' ? JSON.parse(message.content) as { content: Array<{ type: number; text?: string }> } : message.content;
  assert.equal(content.content.filter(node => node.type === 0).map(node => node.text).join(''), text);
  const counts = await cdp.evaluate<{ insert: number; send: number }>('window.__kairo_user_text_probe.counts');
  assert.deepEqual(counts, { insert: 1, send: 1 }, '重复意图或状态查询增加原生提交');
  report['原生提交次数'] = counts;
  report['正式记录'] = { sessionId: result.sessionId, messageId: result.messageId, msgIdx: message.msgIdx, sender: message.sender, receiver: message.receiver };
  report['重复与查询'] = '返回相同正式会话和消息，未新增提交';
  assert.equal((await surface()).windowId, before.windowId, '发送改变当前窗口');
  report['通过'] = true;
} catch (error) {
  report['错误'] = String(error);
  process.exitCode = 1;
} finally {
  try { await driver.disconnect(); }
  catch (error) { report['Driver退出错误'] = String(error); report['通过'] = false; process.exitCode = 1; }
  if (connected) {
    try {
      if (probeInstalled) await cdp.evaluate('window.__kairo_user_text_probe.cleanup()');
      const after = await surface();
      report['退出资源'] = after;
      assert.deepEqual(after, report['初始资源'], '退出资源或窗口没有回到初始状态');
    } catch (error) { report['采集退出错误'] = String(error); report['通过'] = false; process.exitCode = 1; }
    await cdp.disconnect();
  }
  await mkdir('tmp', { recursive: true });
  await writeFile('tmp/native-user-text-evidence.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
