import assert from 'node:assert/strict';
import { CdpClient, callIpcToData, KK9Driver } from '../src/index.js';

const [expectedUid, expectedLogin, sessionId, receiverId, receiverLogin] = process.argv.slice(2);
if (!expectedUid || !expectedLogin || !sessionId || !receiverId || !receiverLogin) {
  throw new Error('参数：登录 UID 登录账号 原生会话 ID 对端 UID 对端账号；只在已授权范围运行');
}
const cdpConfig = {
  url: process.env['CDP_URL'] || 'http://127.0.0.1:9222',
  pageMatch: process.env['PAGE_MATCH'] || 'renderer.html',
};
const driver = new KK9Driver({ cdp: cdpConfig, rejectExistingBridge: true });
const verificationCdp = new CdpClient(cdpConfig);
driver.on('error', error => {
  console.error('只读验收连接错误', error.message);
  process.exitCode = 1;
});
try {
  await driver.connect();
  assert.equal(await driver.getCurrentUserId(), expectedUid, '实际登录 UID 已变化');
  const profile = await driver.getUserProfile(expectedUid);
  assert.equal(profile?.loginName, expectedLogin, '实际登录账号已变化');
  const sessions = await driver.getSessions();
  const matches = sessions.filter(session => session.id === sessionId);
  assert.equal(matches.length, 1, '授权原生会话必须唯一');
  const session = matches[0]!;
  assert.equal(session.type, 'private', '本脚本只允许已授权既有私聊');
  assert.equal(session.nativeType, 0);
  assert.equal(session.receiverId, receiverId, '原生接收对象已变化');
  const receiver = await driver.getEmployeeBySession(session);
  assert.equal(String(receiver?.id), receiverId);
  assert.equal(receiver?.loginName, receiverLogin, '对端账号已变化');
  await verificationCdp.connect();
  type Conversations = { sessionsInfo: Record<string, { id: number; userReadIndex: number }> };
  const before = await callIpcToData<Conversations>(verificationCdp, 'getConversations');
  assert.equal(before.code, 0, '读取前原生会话查询失败');
  const readIndexBefore = Object.values(before.data!.sessionsInfo).find(item => String(item.id) === sessionId)?.userReadIndex;
  assert.notEqual(readIndexBefore, undefined, '缺少读取前已读索引');
  const native = await callIpcToData<Array<{ id: number; msgIdx: number; sessionID: number }>>(
    verificationCdp, 'getMessages', [{ sessionID: Number(sessionId), count: 10, endIdx: 2147483647, sendTime: 0 }]
  );
  assert.equal(native.code, 0, '原生历史对照失败');
  assert.ok(Array.isArray(native.data), '原生历史回包必须为数组');
  const realtimeEvents: string[] = [];
  driver.on('message', () => realtimeEvents.push('message'));
  driver.on('at', () => realtimeEvents.push('at'));
  driver.on('recalled', () => realtimeEvents.push('recalled'));
  const messages = await driver.getRecentMessages(session, 10);
  assert.deepEqual(messages.map(message => ({ id: message.id, msgIdx: message.msgIdx, sessionId: message.sessionId })),
    native.data.map(message => ({ id: String(message.id), msgIdx: message.msgIdx, sessionId: String(message.sessionID) })));
  assert.deepEqual(realtimeEvents, [], '历史读取不得重放实时事件');
  const after = await callIpcToData<Conversations>(verificationCdp, 'getConversations');
  assert.equal(after.code, 0, '读取后原生会话查询失败');
  const readIndexAfter = Object.values(after.data!.sessionsInfo).find(item => String(item.id) === sessionId)?.userReadIndex;
  assert.equal(readIndexAfter, readIndexBefore, '历史读取不得改变已读索引');
  console.log(JSON.stringify({
    当前身份: { uid: expectedUid, loginName: profile.loginName },
    授权会话: { id: session.id, nativeType: session.nativeType, receiverId: session.receiverId },
    查询实现: '修改后的 KK9Driver 原生身份与会话路径',
    历史元数据: messages.map(message => ({ id: message.id, msgIdx: message.msgIdx, sessionId: message.sessionId })),
    已读索引: { before: readIndexBefore, after: readIndexAfter },
    实时事件: realtimeEvents,
    聊天操作: '未发送、撤回、切换、创建会话、标记已读或插入草稿',
  }, null, 2));
} finally {
  await Promise.all([driver.disconnect(), verificationCdp.disconnect()]);
}
