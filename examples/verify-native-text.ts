import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  CdpClient,
  callIpcToData,
  createNativeMessageKey,
  InMemorySendOperationStore,
  KK9Driver,
} from '../src/index.js';
import type { KK9Session, SendResult } from '../src/types/index.js';

const [uid, login, privateId, peerId, peerLogin, groupId, groupReceiver, groupName] =
  process.argv.slice(2);
assert.ok(
  uid && login && privateId && peerId && peerLogin && groupId && groupReceiver && groupName,
  '参数：登录UID 登录账号 私聊原生ID 对端UID 对端账号 群原生ID 群接收对象 群精确名'
);
assert.equal(
  process.env['KK9_REAL_TEST_CONFIRM'],
  `${uid}:${privateId}:${groupId}`,
  '必须保留双目标确认门禁KK9_REAL_TEST_CONFIRM'
);
assert.equal(
  process.env['KK9_STAGE1_CONFIRM'],
  `${uid}:${peerId}:${privateId}`,
  '必须保留私聊确认门禁KK9_STAGE1_CONFIRM'
);
const config = {
  url: process.env['CDP_URL'] || 'http://127.0.0.1:9222',
  pageMatch: process.env['PAGE_MATCH'] || 'renderer.html',
};
const store = new InMemorySendOperationStore();
let driver = new KK9Driver({ cdp: config, rejectExistingBridge: true }, store);
const verification = new CdpClient(config);
const runId = randomUUID();
const operations = [
  {
    kind: '私聊',
    id: privateId,
    operationId: `${runId}:private`,
    text: `T03原生文本验收 ${runId} 私聊`,
  },
  {
    kind: '群聊',
    id: groupId,
    operationId: `${runId}:group`,
    text: `T03原生文本验收 ${runId} 群聊`,
  },
  {
    kind: '提交后断线',
    id: privateId,
    operationId: `${runId}:disconnect`,
    text: `T03连接边界验收 ${runId}`,
  },
];
const owned: Array<{ id: string; session: KK9Session; operationId: string; recalled: boolean }> =
  [];
const report: Record<string, unknown> = {
  运行ID: runId,
  通过: false,
  目标: [],
  未真机触发: ['617服务器禁发', '普通服务器业务失败', '上传失败；本轮不发送媒体'],
  保存正文或凭据: false,
};
let targets: KK9Session[] = [];
let captureInstalled = false;
let interrupted: Promise<void> | undefined;
let verificationConnected = false;

async function activeWindow(): Promise<string | null> {
  return verification.evaluate(
    `(() => { const editor = document.querySelector('.chat-editor, .message-editor, .chat-sendArea')?.__vue__; return editor?.activedSes ? String(editor.activedSes.id) : null; })()`
  );
}
async function history(session: KK9Session): Promise<Array<Record<string, unknown>>> {
  const response = await callIpcToData<Array<Record<string, unknown>>>(
    verification,
    'getMessages',
    [{ sessionID: Number(session.id), count: 100, endIdx: 2147483647, sendTime: 0 }]
  );
  assert.equal(response.code, 0, '原生历史失败');
  assert.ok(Array.isArray(response.data), '原生历史无效');
  return response.data;
}
async function verifyIdentity(): Promise<KK9Session[]> {
  assert.equal(await driver.getCurrentUserId(), uid, '实际登录UID不匹配');
  assert.equal((await driver.getUserProfile(uid!))?.loginName, login, '实际登录账号不匹配');
  const sessions = await driver.getSessions();
  const privateMatches = sessions.filter(session => session.id === privateId);
  const groupMatches = sessions.filter(session => session.id === groupId);
  assert.equal(privateMatches.length, 1, '指定私聊原生ID必须唯一');
  assert.equal(groupMatches.length, 1, '人工消歧后的指定群原生ID必须唯一');
  const privateSession = privateMatches[0]!;
  const groupSession = groupMatches[0]!;
  assert.equal(privateSession.nativeType, 0);
  assert.equal(privateSession.receiverId, peerId);
  assert.equal((await driver.getEmployeeBySession(privateSession))?.loginName, peerLogin);
  assert.equal(groupSession.name, groupName, '群精确名称不符');
  assert.equal(groupSession.type, 'group', '不能用员工、讨论组或服务号替代群');
  assert.equal(groupSession.nativeType, 1);
  assert.equal(groupSession.receiverId, groupReceiver, '群接收对象不符');
  report['身份'] = {
    登录UID: uid,
    登录账号: login,
    私聊: { id: privateId, receiver: peerId, login: peerLogin, nativeType: 0 },
    群聊: { id: groupId, receiver: groupReceiver, name: groupName, nativeType: 1 },
    群消歧: '用户已明确选择793803；不操作同名716827',
  };
  return [privateSession, groupSession];
}

async function captureSnapshot(): Promise<Record<string, unknown>> {
  return verification.evaluate(
    `(() => { const capture = window.__kairo_t03_capture; return { 回执: capture.receipts, 原生请求: capture.requests, 监听基线: capture.baseline, 监听当前: capture.channels.map(channel => ({ channel, count: capture.ipc.listenerCount(channel) })) }; })()`
  );
}

try {
  await driver.connect();
  await verification.connect();
  verificationConnected = true;
  targets = await verifyIdentity();
  const initialWindow = await activeWindow();
  report['初始窗口'] = initialWindow;
  // 仅观察现有窗口。若恰好显示某个授权目标，只切到另一个授权目标证明指定路由。
  if (initialWindow === privateId || initialWindow === groupId) {
    const other = initialWindow === privateId ? groupId : privateId;
    assert.equal(await driver.selectSession(other), true, '必要的授权目标窗口切换失败');
  }
  const channels = targets.map(
    session => `${session.nativeType}-${session.receiverId}-sendMsgCallback`
  );
  const keys = operations.map(operation => createNativeMessageKey('text', operation.operationId));
  const disconnectKey = keys[2]!;
  await verification.sendCommand('Runtime.addBinding', { name: '__kairo_t03_submit' });
  verification.on('Runtime.bindingCalled', (params: { name?: string; payload?: string }) => {
    if (params.name !== '__kairo_t03_submit' || params.payload !== disconnectKey || interrupted)
      return;
    // 只关闭本轮Driver的CDP，不全局断网、不退出KK9；IPC动作已交给原生发送。
    // 专项故障注入使用本轮已知Driver私有CDP槽；不接触其他实例。
    const ownSlots = driver as unknown as { cdp: CdpClient };
    interrupted = ownSlots.cdp.disconnect();
  });
  await verification.evaluate(`(() => {
    if (window.__kairo_t03_capture) throw new Error('已有本轮采集，拒绝覆盖');
    const ipc = window.ipcRenderer || window.require('electron').ipcRenderer;
    const channels = ${JSON.stringify(channels)};
    const keys = ${JSON.stringify(keys)};
    const disconnectKey = ${JSON.stringify(disconnectKey)};
    const capture = { ipc, channels, drafts: new Set(), receipts: [], requests: [], baseline: channels.map(channel => ({ channel, count: ipc.listenerCount(channel) })) };
    const original = ipc.send;
    const wrapper = function(channel, request, ...args) {
      const message = request?.args?.[1];
      const method = request?.args?.[0];
      const owned = channel === 'data' && keys.includes(message?.msgFlag);
      if (owned && (method === 'insertSendBefoeMsg' || method === 'sendMessageNew')) {
        capture.requests.push({ method, key: message.msgFlag, draftId: message.id === undefined ? null : String(message.id), sessionId: String(message.sessionID), sender: String(message.sender), receiver: String(message.receiver), nativeType: message.sessionType, deviceParameterPresent: Object.prototype.hasOwnProperty.call(message,'deviceID') });
        if (method === 'sendMessageNew') capture.drafts.add(String(message.id));
      }
      const result = original.call(this, channel, request, ...args);
      if (owned && method === 'sendMessageNew' && message.msgFlag === disconnectKey) window.__kairo_t03_submit(disconnectKey);
      return result;
    };
    const onReceipt = (_event, payload) => {
      const value = payload?.args;
      if (!capture.drafts.has(String(value?.msgID))) return;
      let ext = value.data?.ext;
      if (typeof ext === 'string') ext = JSON.parse(ext);
      capture.receipts.push({ draftId: String(value.msgID), code: value.code, businessCode: ext?.status ?? null, messageId: value.data?.id === undefined ? null : String(value.data.id), msgIdx: value.data?.msgIdx ?? null, sessionId: String(value.data?.sessionID), sender: String(value.data?.sender), receiver: String(value.data?.receiver), deviceID: value.data?.deviceID ?? null });
    };
    capture.onReceipt = onReceipt;
    for (const channel of channels) ipc.on(channel, onReceipt);
    ipc.send = wrapper;
    capture.cleanup = () => { for (const channel of channels) ipc.removeListener(channel, onReceipt); if (ipc.send !== wrapper) throw new Error('采集send Hook被其他调用方替换'); ipc.send = original; delete window.__kairo_t03_capture; };
    window.__kairo_t03_capture = capture;
  })()`);
  captureInstalled = true;
  const results: Array<Record<string, unknown>> = [];
  for (let index = 0; index < operations.length; index++) {
    const operation = operations[index]!;
    const target = targets.find(session => session.id === operation.id)!;
    let before = await activeWindow();
    if (before === target.id) {
      const other = targets.find(session => session.id !== target.id)!;
      assert.equal(await driver.selectSession(other.id), true);
      before = await activeWindow();
    }
    assert.notEqual(before, target.id, '发送时必须显示别的会话');
    // KK9切换聊天组件会移除该会话监听；只重挂本轮自己的采集函数。
    await verification.evaluate(`(() => { const capture = window.__kairo_t03_capture;
      for (const channel of capture.channels) if (!capture.ipc.listeners(channel).includes(capture.onReceipt)) capture.ipc.on(channel, capture.onReceipt);
    })()`);
    const result = await driver.sendText(operation.text, {
      targetSessionId: target.id,
      operationId: operation.operationId,
    });
    if (index === 2) {
      assert.ok(interrupted, '未观察到实际sendMessageNew提交；断线边界未执行');
      await interrupted;
      assert.equal(result.status, 'unknown', '提交后失联必须unknown，禁止重发');
      const oldGeneration = driver.getStartupGenerationId();
      await driver.disconnect();
      // 远端脚本还会完成本次原生回执采集；等采集结束，再只清本轮旧Hook。
      for (let attempt = 0; attempt < 100; attempt++) {
        const pending = await verification.evaluate<number>(
          'window.__kairo_pending_sends?.size || 0'
        );
        if (pending === 0) break;
        await sleep(100);
      }
      assert.equal(
        await verification.evaluate<number>('window.__kairo_pending_sends?.size || 0'),
        0,
        '旧发送采集尚未结束'
      );
      await verification.evaluate(
        `(() => { const cleanup = window.__kairo_bridge_cleanup; if (cleanup && cleanup.generationId !== ${JSON.stringify(oldGeneration)}) throw new Error('不是本轮旧Hook'); cleanup?.(); })()`
      );
      driver = new KK9Driver({ cdp: config, rejectExistingBridge: true }, store);
      await driver.connect();
      targets = await verifyIdentity();
    }
    let confirmed: SendResult = result;
    if (confirmed.status === 'unknown')
      confirmed = await driver.getSendStatus(operation.operationId);
    const records = await history(target);
    const matches: Array<Record<string, unknown>> = records.filter(
      message => message['msgFlag'] === keys[index] && String(message['sender']) === uid
    );
    assert.equal(matches.length, 1, '本轮唯一意图应只有一条正式记录');
    const record = matches[0]!;
    owned.push({
      id: String(record['id']),
      session: target,
      operationId: operation.operationId,
      recalled: false,
    });
    assert.equal(confirmed.status, 'sent', confirmed.error || '没有本次业务确认，不重发');
    assert.equal(confirmed.messageId, String(record['id']));
    assert.equal(String(record['sessionID']), target.id);
    assert.equal(String(record['sender']), uid);
    assert.equal(String(record['receiver']), target.receiverId);
    assert.ok(Number(record['deviceID']) > 0, '正式记录必须使用原生当前设备');
    const repeated = await driver.sendText(operation.text, {
      targetSessionId: target.id,
      operationId: operation.operationId,
    });
    const queried = await driver.getSendStatus(operation.operationId);
    assert.equal(repeated.status, 'sent');
    assert.equal(repeated.messageId, confirmed.messageId);
    assert.equal(queried.status, 'sent');
    assert.equal(queried.messageId, confirmed.messageId);
    assert.equal(
      (await history(target)).filter(message => message['msgFlag'] === keys[index]).length,
      1,
      '重复或查询增加了第二条记录'
    );
    const after = await activeWindow();
    assert.equal(after, before, 'SDK发送自动切换了窗口');
    const snapshot = await captureSnapshot();
    const requests = snapshot['原生请求'] as Array<Record<string, unknown>>;
    assert.equal(
      requests.filter(
        request => request['key'] === keys[index] && request['method'] === 'sendMessageNew'
      ).length,
      1,
      '重复/查询导致二次原生提交'
    );
    const receipts = snapshot['回执'] as Array<Record<string, unknown>>;
    const callback = receipts.find(
      receipt => receipt['messageId'] === confirmed.messageId && receipt['sessionId'] === target.id
    );
    assert.ok(callback, '独立采集未找到本次正式ID业务回执');
    assert.equal(callback['code'], 0);
    assert.equal(callback['businessCode'], null);
    assert.equal(callback['draftId'], confirmed.receipt?.draftId);
    assert.equal(callback['msgIdx'], record['msgIdx']);
    results.push({
      类型: operation.kind,
      原生会话: target.id,
      接收对象: target.receiverId,
      nativeType: target.nativeType,
      operationId: operation.operationId,
      初始结果: result.status,
      查询结果: confirmed.status,
      草稿ID: callback['draftId'],
      正式ID: confirmed.messageId,
      索引: record['msgIdx'],
      deviceID: record['deviceID'],
      回执码: callback['code'],
      业务码: callback['businessCode'],
      发送前窗口: before,
      发送后窗口: after,
      原生提交次数: 1,
      查询重复无新增: true,
    });
    report['目标'] = results;
  }
  report['通过'] = true;
} catch (error) {
  report['错误'] = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
} finally {
  // 只清理本轮本人唯一标记的消息。未知结果只回查，不二次发送。
  if (verificationConnected) {
    for (const operation of operations) {
      const target = targets.find(session => session.id === operation.id);
      if (!target || owned.some(item => item.operationId === operation.operationId)) continue;
      try {
        const key = createNativeMessageKey('text', operation.operationId);
        const matches = (await history(target)).filter(
          message => message['msgFlag'] === key && String(message['sender']) === uid
        );
        if (matches.length === 1)
          owned.push({
            id: String(matches[0]!['id']),
            session: target,
            operationId: operation.operationId,
            recalled: false,
          });
      } catch (error) {
        report['清理查询错误'] = String(error);
        process.exitCode = 1;
      }
    }
    for (const message of owned) {
      try {
        // 现有撤回能力用于清理；必要切换仅在两个授权目标内，不代表实施T05。
        if ((await activeWindow()) !== message.session.id)
          assert.equal(await driver.selectSession(message.session.id), true);
        await sleep(300);
        assert.equal(
          await driver.recallMessage(message.id, message.session),
          true,
          '本轮本人消息撤回失败'
        );
        const recalled = (await history(message.session)).find(
          record => String(record['id']) === message.id
        );
        assert.ok(recalled && /^[CD]/.test(String(recalled['msgFlag'])), '未核对到原生撤回状态');
        message.recalled = true;
      } catch (error) {
        report['清理错误'] = String(error);
        report['通过'] = false;
        process.exitCode = 1;
      }
    }
    if (captureInstalled) {
      try {
        report['独立采集'] = await captureSnapshot();
        await verification.evaluate('window.__kairo_t03_capture.cleanup()');
        await verification.sendCommand('Runtime.removeBinding', { name: '__kairo_t03_submit' });
      } catch (error) {
        report['采集清理错误'] = String(error);
        report['通过'] = false;
        process.exitCode = 1;
      }
    }
  }
  try {
    await driver.disconnect();
  } catch (error) {
    report['Driver退出错误'] = String(error);
    report['通过'] = false;
    process.exitCode = 1;
  }
  if (verificationConnected) {
    try {
      report['退出后'] = await verification.evaluate(
        `({ 本轮采集残留: !!window.__kairo_t03_capture, 在途发送: window.__kairo_pending_sends?.size || 0, DriverHook残留: typeof window.__kairo_bridge_cleanup === 'function' })`
      );
    } catch (error) {
      report['退出核对错误'] = String(error);
      process.exitCode = 1;
    }
  }
  await verification.disconnect();
  report['清理'] = owned.map(message => ({
    消息ID: message.id,
    原生会话: message.session.id,
    operationId: message.operationId,
    已撤回: message.recalled,
  }));
  await mkdir(new URL('../tmp/', import.meta.url), { recursive: true });
  await writeFile(
    new URL('../tmp/t03-live-evidence.json', import.meta.url),
    JSON.stringify(report, null, 2) + '\n'
  );
  console.log(JSON.stringify(report, null, 2));
}
