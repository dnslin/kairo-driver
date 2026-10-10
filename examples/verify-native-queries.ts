import assert from 'node:assert/strict';
import { CdpClient, callIpcToData, KK9Driver } from '../src/index.js';

const phase = process.argv[2];
assert.ok(phase === 'a' || phase === 'b' || phase === 'c', '参数：a（组织查询）、b（标已读，可追加 --listen）、c（历史范围）');
if (phase === 'b') assert.equal(process.env['KK9_REAL_TEST_CONFIRM'], '5761:716791:793803', '标已读必须通过授权门禁');
const config = { url: process.env['CDP_URL'] || 'http://127.0.0.1:9222', pageMatch: process.env['PAGE_MATCH'] || 'renderer.html' };
const driver = new KK9Driver({ cdp: config, rejectExistingBridge: true });
const cdp = new CdpClient(config);
const events: string[] = [];
for (const event of ['message', 'at', 'recalled'] as const) driver.on(event, () => events.push(event));
driver.on('error', error => { console.error('查询验收连接错误', error.message); process.exitCode = 1; });

async function snapshot() {
  const windowId = await cdp.evaluate<string | null>(`(() => { const editor = document.querySelector('.chat-editor, .message-editor, .chat-sendArea')?.__vue__; return editor?.activedSes ? String(editor.activedSes.id) : null; })()`);
  const rows = [];
  for (const id of [716791, 793803]) {
    const response = await callIpcToData<{ id: number; type: number; typeID: number; maxMessageIndex: number; userReadIndex: number }>(cdp, 'getSessionBySessionID', [id]);
    assert.equal(response.code, 0);
    assert.equal(response.data?.id, id);
    const row = response.data;
    rows.push({ id: row.id, type: row.type, receiver: row.typeID, max: row.maxMessageIndex, read: row.userReadIndex });
  }
  return { windowId, rows };
}

try {
  await driver.connect();
  await cdp.connect();
  assert.equal(await driver.getCurrentUserId(), '5761');
  assert.equal((await driver.getUserProfile(5761))?.loginName, '0123040139');
  const sessions = await driver.getSessions();
  const privateSession = sessions.find(s => s.id === '716791');
  const groupSession = sessions.find(s => s.id === '793803');
  assert.equal(privateSession?.nativeType, 0);
  assert.equal(privateSession?.receiverId, '3585');
  assert.equal((await driver.getEmployeeBySession('716791'))?.loginName, 'int2024');
  assert.equal(groupSession?.nativeType, 1);
  assert.equal(groupSession?.receiverId, '29467');
  assert.equal(groupSession?.name, '测试123');
  if (phase === 'a') {
    const before = await snapshot();
    const roots = await callIpcToData<Array<{ id: number; name: string }>>(cdp, 'getDepartmentVisible');
    assert.equal(roots.code, 0);
    const employees = await driver.getOrgEmployees();
    assert.equal(new Set(employees.map(e => String(e.id))).size, employees.length, '组织重复 UID');
    assert.ok(employees.some(e => String(e.id) === '5761'), '原生组织缺少已确认登录成员');
    const peer = await driver.getUserProfile(3585);
    assert.equal(peer?.loginName, 'int2024');
    const after = await snapshot();
    assert.deepEqual(after, before, '组织查询改变窗口或读索引');
    assert.deepEqual(events, [], '查询重放实时事件');
    console.log(JSON.stringify({ 切片: 'T11a', 身份: '5761/0123040139', 根部门: roots.data?.map(({ id, name }) => ({ id, name })), 员工数量: employees.length, 指定档案: { uid: peer.id, login: peer.loginName }, before, after, 实时事件: events }, null, 2));
  } else if (phase === 'c') {
    const before = await snapshot();
    const ranges = [];
    for (const id of ['716791', '793803']) {
      const native = await callIpcToData<Array<{ id: number; msgIdx: number; sendTime: number; sessionID: number }>>(cdp, 'getMessages', [{ sessionID: Number(id), count: 250, endIdx: 2147483647, sendTime: 0 }]);
      assert.equal(native.code, 0);
      assert.ok(Array.isArray(native.data));
      const rows = native.data;
      // 私聊范围越过最近200条，群范围越过最近20条；复用已有历史，不制造消息。
      const distance = id === '716791' ? 205 : 25;
      assert.ok(rows.length > distance, '缺少范围验收的既有历史');
      const upper = rows[rows.length - distance]!;
      const lower = rows[Math.max(0, rows.length - distance - 5)]!;
      const fromTimestamp = lower.sendTime * 1000, toTimestamp = upper.sendTime * 1000;
      const expected = rows.filter(r => r.sendTime * 1000 >= fromTimestamp && r.sendTime * 1000 <= toTimestamp).slice(-3);
      const result = await driver.scanCompensationWindow({ sessionIds: [id], fromTimestamp, toTimestamp, maxMessagesPerSession: 3 });
      assert.deepEqual(result.map(m => [m.id, m.msgIdx, m.sessionId]), expected.map(r => [String(r.id), r.msgIdx, String(r.sessionID)]));
      ranges.push({ id, fromTimestamp, toTimestamp, 覆盖: '原生当前可见范围内最近3条，不代表无界全量', 原生对照: expected.map(r => ({ id: r.id, msgIdx: r.msgIdx })), SDK: result.map(m => ({ id: m.id, msgIdx: m.msgIdx })) });
    }
    const after = await snapshot();
    assert.deepEqual(after, before, '范围读取改变窗口或读索引');
    assert.deepEqual(events, [], '范围读取重放实时事件');
    console.log(JSON.stringify({ 切片: 'T11c', ranges, before, after, 实时事件: events }, null, 2));
  } else {
    const initialWindow = (await snapshot()).windowId;
    try {
      for (const id of ['716791', '793803']) {
        const other = id === '716791' ? '793803' : '716791';
        assert.equal(await driver.selectSession(other), true, '仅用另一授权会话准备目标未显示场景');
        const before = await snapshot();
        assert.equal(before.windowId, other);
        const row = before.rows.find(s => String(s.id) === id)!;
        assert.equal(await driver.markSessionRead(id), true);
        const after = await snapshot();
        assert.equal(after.windowId, other);
        assert.equal(after.rows.find(s => String(s.id) === id)!.read, row.max);
        console.log(JSON.stringify({ 切片: 'T11b', 阶段: '既有未读或幂等', id, before, after }));
      }
      if (process.argv.includes('--listen')) {
        for (const id of ['716791', '793803']) {
          const other = id === '716791' ? '793803' : '716791';
          assert.equal(await driver.selectSession(other), true);
          const incoming = new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => { driver.off('message', listener); reject(new Error(`等待授权目标${id}新入站超时；未证明未读推进`)); }, 180000);
            const listener = (message: { sessionId: string; senderId?: string }) => {
              if (message.sessionId !== id || message.senderId !== '3585') return;
              clearTimeout(timer); driver.off('message', listener); resolve();
            };
            driver.on('message', listener);
          });
          console.log(id === '716791' ? 'T11B_PRIVATE_READY：等待int2024私聊一条文本' : 'T11B_GROUP_READY：等待int2024在测试123/793803一条文本');
          await incoming;
          const before = await snapshot();
          const row = before.rows.find(s => String(s.id) === id)!;
          assert.equal(before.windowId, other);
          assert.ok(row.read < row.max, '没有真实未读前提，不能声称推进');
          const target = sessions.find(s => s.id === id)!;
          const eventCount = events.length;
          await driver.getRecentMessages(target, 2);
          assert.deepEqual(await snapshot(), before, '历史读取不能改变读索引/窗口');
          assert.equal(events.length, eventCount, '历史不得重放事件');
          assert.equal(await driver.markSessionRead(id), true);
          const after = await snapshot();
          assert.equal(after.windowId, other);
          assert.equal(after.rows.find(s => String(s.id) === id)!.read, row.max);
          console.log(JSON.stringify({ 切片: 'T11b', 阶段: '真实未读推进', id, before, after, 历史新增事件: events.length - eventCount }));
        }
      }
    } finally {
      if (initialWindow === '716791' || initialWindow === '793803') assert.equal(await driver.selectSession(initialWindow), true);
    }
  }
} finally {
  await Promise.all([driver.disconnect(), cdp.disconnect()]);
  console.log('本轮 Driver 与核对连接已退出');
}
