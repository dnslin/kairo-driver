import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { CdpClient, callIpcToData, KK9Driver } from '../src/index.js';
import { extractRecalledEventsFromPayload } from '../src/bridge/converter.js';
import type { KK9Message, KK9RecalledEvent, KK9Session } from '../src/types/index.js';

const [expectedUid, expectedLogin, sessionId, receiverId, receiverLogin] = process.argv.slice(2);
if (!expectedUid || !expectedLogin || !sessionId || !receiverId || !receiverLogin) {
  throw new Error('参数：登录 UID 登录账号 原生会话 ID 对端 UID 对端账号；仅在授权私聊运行');
}
assert.equal(
  process.env['KK9_STAGE1_CONFIRM'],
  `${expectedUid}:${receiverId}:${sessionId}`,
  '必须设置现有私聊确认门禁 KK9_STAGE1_CONFIRM'
);
const cdpConfig = {
  url: process.env['CDP_URL'] || 'http://127.0.0.1:9222',
  pageMatch: process.env['PAGE_MATCH'] || 'renderer.html',
};
const driver = new KK9Driver({ cdp: cdpConfig, rejectExistingBridge: true });
const verificationCdp = new CdpClient(cdpConfig);
const runId = randomUUID();
const marker = `Kairo Driver 原生撤回回归 ${runId}`;
const report: Record<string, unknown> = { 运行ID: runId, 目标账号: receiverLogin, 通过: false };
const messages: KK9Message[] = [];
const recalls: KK9RecalledEvent[] = [];
const errors: string[] = [];
let authorizedSession: KK9Session | undefined;
let ownedMessageId: string | undefined;
let sendStarted = false;
let recalled = false;
driver.on('error', error => errors.push(error.message));
driver.on('message', message => {
  if (message.sessionId === sessionId) messages.push(message);
});
driver.on('recalled', event => {
  if (event.messageId === ownedMessageId || event.sessionId === sessionId) recalls.push(event);
});

async function readNativeHistory(): Promise<Array<Record<string, unknown>>> {
  const response = await callIpcToData<Array<Record<string, unknown>>>(
    verificationCdp,
    'getMessages',
    [
      {
        sessionID: Number(sessionId),
        count: 20,
        endIdx: 2147483647,
        sendTime: 0,
      },
    ]
  );
  assert.equal(response.code, 0, '原生历史查询失败');
  assert.ok(Array.isArray(response.data), '原生历史必须为数组');
  return response.data;
}

try {
  await driver.connect();
  await verificationCdp.connect();
  assert.equal(await driver.getCurrentUserId(), expectedUid, '实际登录 UID 不匹配');
  assert.equal(
    (await driver.getUserProfile(expectedUid))?.loginName,
    expectedLogin,
    '实际登录账号不匹配'
  );
  const matches = (await driver.getSessions()).filter(session => session.id === sessionId);
  assert.equal(matches.length, 1, '授权原生会话必须唯一');
  authorizedSession = matches[0]!;
  assert.equal(authorizedSession.nativeType, 0, '只允许私聊');
  assert.equal(authorizedSession.receiverId, receiverId, '私聊接收对象不匹配');
  const receiver = await driver.getEmployeeBySession(authorizedSession);
  assert.equal(String(receiver?.id), receiverId, '对端 UID 不匹配');
  assert.equal(receiver?.loginName, receiverLogin, '对端账号不匹配');
  report['身份'] = {
    登录UID: expectedUid,
    登录账号: expectedLogin,
    会话ID: sessionId,
    对端UID: receiverId,
  };

  const nativeBefore = await callIpcToData<Record<string, unknown>>(
    verificationCdp,
    'getSessionBySessionID',
    [Number(sessionId)]
  );
  assert.equal(nativeBefore.code, 0, '单会话原生查询失败');
  assert.equal(String(nativeBefore.data?.['id']), sessionId, '单会话 ID 不匹配');
  const nativeHistory = await readNativeHistory();
  const history = await driver.getRecentMessages(authorizedSession, 20);
  assert.deepEqual(
    history.map(message => ({
      id: message.id,
      msgIdx: message.msgIdx,
      sessionId: message.sessionId,
    })),
    nativeHistory.map(message => ({
      id: String(message['id']),
      msgIdx: message['msgIdx'],
      sessionId: String(message['sessionID']),
    }))
  );
  const nativeAfter = await callIpcToData<Record<string, unknown>>(
    verificationCdp,
    'getSessionBySessionID',
    [Number(sessionId)]
  );
  assert.equal(nativeAfter.code, 0);
  assert.equal(
    nativeAfter.data?.['userReadIndex'],
    nativeBefore.data?.['userReadIndex'],
    '历史读取改变了已读索引'
  );
  assert.equal(messages.length, 0, '只读历史重放了消息');
  assert.equal(recalls.length, 0, '只读历史重放了撤回');
  report['只读历史'] = {
    数量: history.length,
    已读索引: nativeAfter.data?.['userReadIndex'],
    无实时重放: true,
  };

  const activeIdBefore = await verificationCdp.evaluate<string | null>(`(() => {
    const editor = document.querySelector('.chat-editor, .message-editor, .chat-sendArea')?.__vue__;
    return editor?.activedSes ? String(editor.activedSes.id) : null;
  })()`);
  if (activeIdBefore !== sessionId)
    assert.equal(await driver.selectSession(sessionId), true, '无法切换到授权目标');
  const current = await driver.getCurrentSession();
  assert.equal(current?.id, sessionId, '当前会话应返回原生 ID');
  assert.equal(current?.receiverId, receiverId);
  assert.equal(current?.active, true);
  report['当前会话'] = {
    原生ID: current.id,
    对端UID: current.receiverId,
    是否切换: activeIdBefore !== sessionId,
  };

  sendStarted = true;
  let result = await driver.sendText(marker, { targetSessionId: sessionId, operationId: runId });
  if (result.status === 'unknown') result = await driver.getSendStatus(runId);
  const sentHistory = await driver.getRecentMessages(authorizedSession, 20);
  const ownRecord = sentHistory.find(
    message => message.content === marker && message.senderId === expectedUid
  );
  ownedMessageId = ownRecord?.id;
  report['发送'] = {
    状态: result.status,
    消息ID: ownedMessageId,
    错误: result.error,
    回执: result.receipt,
  };
  assert.equal(result.status, 'sent', result.error || '本次原生业务发送未确认；没有重发');
  assert.ok(ownRecord, '原生历史未找到本轮测试消息');
  assert.equal(result.messageId, ownRecord.id, '发送结果与原生消息 ID 不一致');
  assert.equal(ownRecord.sessionId, sessionId);
  assert.equal(ownRecord.direction, 'outbound');
  await sleep(300);
  assert.ok(
    messages.some(message => message.id === ownedMessageId && message.direction === 'outbound'),
    '未观察到真实发送回显'
  );

  assert.equal(
    await driver.recallMessage(ownedMessageId!, authorizedSession),
    true,
    '本轮测试消息撤回失败'
  );
  recalled = true;
  await sleep(600);
  const ownRecalls = recalls.filter(event => event.messageId === ownedMessageId);
  assert.deepEqual(
    ownRecalls.map(event => ({ messageId: event.messageId, sessionId: event.sessionId })),
    [{ messageId: ownedMessageId, sessionId }],
    '真实撤回范围错误或重复派发'
  );
  const recalledHistory = await driver.getRecentMessages(authorizedSession, 20);
  const original = recalledHistory.find(message => message.id === ownedMessageId);
  assert.ok(original, '原生历史缺少本轮被撤回的原消息');
  assert.match(String(original.raw?.['msgFlag']), /^[CD]/, '原生撤回标记未生效');
  assert.equal(original.isRecalled, true, '历史丢失撤回状态');
  assert.equal(original.messageType, 'text', '撤回原文本被误标为系统消息');
  const notice = recalledHistory.find(
    message =>
      message.messageType === 'system' &&
      extractRecalledEventsFromPayload(message.raw, authorizedSession).some(
        event => event.messageId === ownedMessageId
      )
  );
  assert.ok(notice, '原生历史缺少对应撤回系统通知');
  assert.equal(notice.sessionId, sessionId);
  report['撤回'] = {
    消息ID: ownedMessageId,
    会话ID: sessionId,
    事件次数: ownRecalls.length,
    原记录类型: original.messageType,
    原记录已撤回: original.isRecalled,
    原生标记: original.raw?.['msgFlag'],
    通知ID: notice.id,
  };

  const messageCountBefore = messages.filter(
    message => message.id === ownedMessageId || message.id === notice.id
  ).length;
  const recallCountBefore = recalls.filter(event => event.messageId === ownedMessageId).length;
  // 验证真实采集边界并等待查询结束，不启动另属 T11 范围的调度计时器。
  const polling = driver as unknown as {
    collectAndEmitMessages(session: KK9Session, limit: number): Promise<void>;
  };
  await polling.collectAndEmitMessages(authorizedSession, 20);
  await polling.collectAndEmitMessages(authorizedSession, 20);
  assert.equal(
    messages.filter(message => message.id === ownedMessageId || message.id === notice.id).length,
    messageCountBefore,
    '轮询重放了已撤回原记录或系统通知'
  );
  assert.equal(
    recalls.filter(event => event.messageId === ownedMessageId).length,
    recallCountBefore,
    '轮询重放了历史撤回'
  );
  assert.deepEqual(errors, [], '真机运行产生连接或桥接错误');
  report['轮询'] = { 采集次数: 2, 已撤回记录重放: false, 撤回通知重放: false };
  report['通过'] = true;
} catch (error) {
  report['错误'] = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
} finally {
  // 只清理本轮唯一标记且发送人为当前账号的消息；未知发送不重试。
  if (sendStarted && !recalled && authorizedSession) {
    try {
      if (!ownedMessageId) {
        const history = await driver.getRecentMessages(authorizedSession, 20);
        ownedMessageId = history.find(
          message => message.content === marker && message.senderId === expectedUid
        )?.id;
      }
      if (ownedMessageId) recalled = await driver.recallMessage(ownedMessageId, authorizedSession);
    } catch (error) {
      report['清理错误'] = error instanceof Error ? error.message : String(error);
      process.exitCode = 1;
    }
  }
  report['清理'] = { 本轮消息ID: ownedMessageId, 已撤回: recalled, 在途轮询: false };
  try {
    await Promise.all([driver.disconnect(), verificationCdp.disconnect()]);
  } catch (error) {
    report['通过'] = false;
    report['退出错误'] = error instanceof Error ? error.message : String(error);
    process.exitCode = 1;
  } finally {
    await writeFile(
      new URL('../tmp/pr1-fix-live-evidence.json', import.meta.url),
      JSON.stringify(report, null, 2) + '\n'
    );
    console.log(JSON.stringify(report, null, 2));
  }
}
