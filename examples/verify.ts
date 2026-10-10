import assert from 'node:assert/strict';
import { CdpClient, callIpcToData, KK9Driver } from '@kairo/driver';

async function main(): Promise<void> {
  const privateId = process.env['KK9_TEST_PRIVATE_ID']?.trim();
  const groupId = process.env['KK9_TEST_GROUP_ID']?.trim();
  const peerId = process.env['KK9_TEST_USER_ID']?.trim();
  assert.equal(privateId, '716791', '只允许已授权私聊716791');
  assert.equal(groupId, '793803', '只允许已授权群793803，禁止同名716827');
  assert.equal(peerId, '3585', '只允许已授权员工int2024/3585');
  const config = {
    url: process.env['CDP_URL'] || 'http://127.0.0.1:9222',
    pageMatch: process.env['PAGE_MATCH'] || 'renderer.html',
  };
  const verification = new CdpClient(config);
  const driver = new KK9Driver({ cdp: config, rejectExistingBridge: true });
  const events: string[] = [];
  for (const event of ['message', 'at', 'recalled'] as const) driver.on(event, () => events.push(event));
  driver.on('error', error => { console.error('烟测连接错误', error.message); process.exitCode = 1; });

  async function snapshot() {
    // 仅独立观察窗口；不作为SDK查询或选择目标的数据来源。
    const surface = await verification.evaluate<{
      windowId: string | null; messageListeners: number; driverHook: boolean; nativeObserver: boolean; pendingSends: number;
    }>(`(() => {
      const ipc = window.ipcRenderer || window.require('electron').ipcRenderer;
      const editor = document.querySelector('.chat-editor, .message-editor, .chat-sendArea')?.__vue__;
      return { windowId: editor?.activedSes ? String(editor.activedSes.id) : null,
        messageListeners: ipc.listenerCount('message'), driverHook: !!window.__kairo_bridge_cleanup,
        nativeObserver: !!window.__kairo_native_send_observer, pendingSends: window.__kairo_pending_sends?.size || 0 };
    })()`);
    const rows = [];
    for (const id of [privateId, groupId]) {
      const response = await callIpcToData<{ id: number; maxMessageIndex: number; userReadIndex: number }>(verification, 'getSessionBySessionID', [Number(id)]);
      assert.equal(response.code, 0, `原生会话${id}核对失败`);
      assert.equal(String(response.data?.id), id);
      rows.push({ id, max: response.data!.maxMessageIndex, read: response.data!.userReadIndex });
    }
    return { ...surface, rows };
  }

  const histories = [];
  try {
    await verification.connect();
    const before = await snapshot();
    try {
      await driver.connect();
      assert.equal(await driver.getCurrentUserId(), '5761', '实际登录UID不符');
      assert.equal((await driver.getUserProfile('5761'))?.loginName, '0123040139', '实际登录账号不符');
      const sessions = await driver.getSessions();
      const privateSession = sessions.find(session => session.id === privateId);
      const groupSession = sessions.find(session => session.id === groupId);
      assert.ok(privateSession && groupSession, '授权原生会话不存在');
      assert.equal(privateSession.nativeType, 0);
      assert.equal(privateSession.receiverId, peerId);
      assert.equal(groupSession.nativeType, 1);
      assert.equal(groupSession.receiverId, '29467');
      assert.equal(groupSession.name, '测试123');
      const peer = await driver.getEmployeeBySession(privateSession);
      assert.equal(String(peer?.id), peerId);
      assert.equal(peer?.loginName, 'int2024');
      for (const session of [privateSession, groupSession]) {
        const native = await callIpcToData<Array<{ id: number; msgIdx: number; sessionID: number }>>(verification, 'getMessages', [{ sessionID: Number(session.id), count: 3, endIdx: 2147483647, sendTime: 0 }]);
        assert.equal(native.code, 0, `原生历史${session.id}读取失败`);
        assert.ok(Array.isArray(native.data));
        const history = await driver.getRecentMessages(session, 3);
        const metadata = history.map(message => ({ id: message.id, msgIdx: message.msgIdx, sessionId: message.sessionId }));
        assert.deepEqual(metadata, native.data.map(message => ({ id: String(message.id), msgIdx: message.msgIdx, sessionId: String(message.sessionID) })));
        histories.push({ sessionId: session.id, nativeType: session.nativeType, receiverId: session.receiverId, messages: metadata });
      }
      const afterRead = await snapshot();
      assert.equal(afterRead.windowId, before.windowId, 'SDK读取切换窗口');
      assert.deepEqual(afterRead.rows, before.rows, 'SDK读取改变读索引');
      assert.deepEqual(events, [], '历史读取重放实时事件');
    } finally {
      await driver.disconnect();
    }
    const after = await snapshot();
    assert.deepEqual(after, before, '退出后窗口、读索引或自身Hook/监听未恢复基线');
    console.log(JSON.stringify({
      入口: '@kairo/driver → dist/index.js（当前构建产物）',
      身份: { uid: '5761', login: '0123040139', peerUid: peerId, peerLogin: 'int2024' },
      历史: histories, before, after, 实时事件: events,
      副作用: '未发送、撤回、切窗口、标已读或修改原生缓存',
    }, null, 2));
  } finally {
    await verification.disconnect();
  }
  assert.equal(driver.getStatus(), 'disconnected');
  assert.equal(verification.getStatus(), 'disconnected');
  console.log('构建入口只读烟测通过；Driver与核对连接均已退出');
}

void main().catch(error => {
  console.error('构建入口烟测失败', error);
  process.exitCode = 1;
});
