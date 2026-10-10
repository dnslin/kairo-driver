import assert from 'node:assert/strict';
import { CdpClient, callIpcToData, KK9Driver } from '../src/index.js';

const phase = process.argv[2];
assert.equal(phase, 'a', '参数：a（组织查询）');
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
} finally {
  await Promise.all([driver.disconnect(), cdp.disconnect()]);
  console.log('本轮 Driver 与核对连接已退出');
}
