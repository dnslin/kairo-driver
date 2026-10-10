import { afterEach, describe, expect, it, vi } from 'vitest';
import { BridgeMessageOps } from '../src/bridge/message-ops.js';
import { InMemorySendOperationStore } from '../src/send-operation.js';
import type { SendOptions, SendResult } from '../src/types/index.js';
import { createNativeSendRuntime } from './helpers/native-send-runtime.js';

// 执行SDK实际生成的渲染脚本；原生IPC提供人员查询、权限和正式会话分配。
describe('按准确工号首次发送文本SDK', () => {
  afterEach(() => vi.useRealTimers());

  it('首次发送使用真实双方UID和sessionID0，返回正式会话且重复与查询均只读', async () => {
    const native = createNativeSendRuntime();
    const store = new InMemorySendOperationStore();
    const ops = new BridgeMessageOps(native.cdp, store);
    const options = { operationId: 'user-first' };
    expect(native.sessions.some(session => session.typeID === 91003)).toBe(false);
    const sent = await ops.sendTextToUser('  int2023  ', '第一条准确文本', options);
    expect(sent).toMatchObject({
      status: 'sent', operationId: 'user-first', sessionId: '94001', messageId: '135700000',
      receipt: { draftId: '-1', code: 0, sessionId: '94001', messageId: '135700000', msgIdx: 1 },
    });
    expect(native.drafts).toMatchObject([{
      sessionID: 0, sessionType: 0, sender: 91001, receiver: 91003,
      content: { content: [{ type: 0, text: '第一条准确文本' }] },
    }]);
    const submissions = native.ipc.sent.filter(request => request.args[0] === 'sendMessageNew');
    expect(submissions).toHaveLength(1);
    expect(submissions[0]?.args[1]).toMatchObject({ sessionID: 0, sessionType: 0, sender: 91001, receiver: 91003 });
    expect(native.records).toMatchObject([{ sessionID: 94001, sender: 91001, receiver: 91003 }]);
    const lookups = native.ipc.sent.filter(request => request.args[0] === 'unionSearch').length;
    expect(await ops.sendTextToUser('int2023', '第一条准确文本', options)).toEqual(sent);
    expect(await new BridgeMessageOps(native.cdp, store).getSendStatus('user-first')).toEqual(sent);
    expect(native.ipc.sent.filter(request => request.args[0] === 'unionSearch')).toHaveLength(lookups);
    expect(native.records).toHaveLength(1);
    expect(await store.get('user-first')).toMatchObject({
      sessionId: '94001', fingerprint: { targetSessionId: '', targetLoginName: 'int2023', messageType: 'text-to-user' },
    });
    expect(native.ipc.listenerCount('0-91003-sendMsgCallback')).toBe(0);
    expect(native.ipc.sent.map(request => request.args[0])).not.toContain('getSessionInfo6');
    expect(native.ipc.sent.map(request => request.args[0])).not.toContain('getUsersByLoginNames');
    expect(native.ipc.sent.map(request => request.args[0])).not.toContain('getConversations');
  });

  it('已有私聊仍按人员提交，由原生复用正式会话而不另建', async () => {
    const native = createNativeSendRuntime({ existingUserSessionId: 93003 });
    const sessionCount = native.sessions.length;
    const result = await new BridgeMessageOps(native.cdp).sendTextToUser('int2023', '复用私聊');
    expect(result).toMatchObject({ status: 'sent', sessionId: '93003', receipt: { sessionId: '93003' } });
    expect(native.drafts[0]).toMatchObject({ sessionID: 0, receiver: 91003 });
    expect(native.records[0]).toMatchObject({ sessionID: 93003 });
    expect(native.sessions).toHaveLength(sessionCount);
  });

  it('反向私聊双方UID为字符串时，仍准确发送给对方并复用正式会话', async () => {
    const native = createNativeSendRuntime({ reverseUserSession: true });
    const sessionCount = native.sessions.length;
    const result = await new BridgeMessageOps(native.cdp).sendTextToUser('int2023', '反向私聊复用');
    expect(result).toMatchObject({ status: 'sent', sessionId: '93003', receipt: { sessionId: '93003' } });
    expect(native.drafts).toMatchObject([{ sessionID: 0, sessionType: 0, sender: 91001, receiver: 91003 }]);
    expect(native.records).toMatchObject([{ sessionID: 93003, sender: 91001, receiver: 91003 }]);
    expect(native.sessions).toHaveLength(sessionCount);
    expect(native.records).toHaveLength(1);
  });

  it('搜索跨页读取，忽略显示名与前缀相似账号，跨页重复UID不产生歧义', async () => {
    const users = Array.from({ length: 200 }, (_, index) => ({
      id: 92000 + index, login_name: 'int2023-' + index, name: 'int2023',
    }));
    users[0] = { id: 91003, login_name: 'int2023', name: '准确接收者' };
    users.push({ id: 91003, login_name: 'int2023', name: '准确接收者' });
    const native = createNativeSendRuntime({ searchUsers: users });
    const result = await new BridgeMessageOps(native.cdp).sendTextToUser('int2023', '必须查完候选');
    expect(result).toMatchObject({ status: 'sent', sessionId: '94001' });
    expect(native.records[0]).toMatchObject({ receiver: 91003 });
    expect(native.ipc.sent.filter(request => request.args[0] === 'unionSearch').map(request => request.args[1])).toEqual([
      { type: 'user', kwd: 'int2023', pageNo: 1, pageSize: 200 },
      { type: 'user', kwd: 'int2023', pageNo: 2, pageSize: 200 },
    ]);
  });

  it.each([
    ['空工号', { loginName: '  ', config: {}, method: undefined, reason: undefined }],
    ['目标是当前本人', { loginName: '0123040139', config: { searchUsers: [{ id: 91001, login_name: '0123040139', name: '原生账号' }] }, method: undefined, reason: undefined }],
    ['没有准确账号', { loginName: 'int2023', config: { searchUsers: [{ id: 91004, login_name: 'int2023-extra', name: 'int2023' }] }, method: undefined, reason: undefined }],
    ['不同UID共用准确账号', { loginName: 'int2023', config: { searchUsers: [{ id: 91003, login_name: 'int2023', name: '甲' }, { id: 91004, login_name: 'int2023', name: '乙' }] }, method: undefined, reason: undefined }],
    ['搜索失败', { loginName: 'int2023', config: { searchCode: 627 }, method: 'unionSearch', reason: '人员搜索拒绝' }],
    ['档案账号不符', { loginName: 'int2023', config: { targetProfile: { id: 91003, login_name: '其他账号', name: '对端' } }, method: 'getMemberDetail', reason: undefined }],
    ['档案UID不符', { loginName: 'int2023', config: { targetProfile: { id: 91004, login_name: 'int2023', name: '对端' } }, method: 'getMemberDetail', reason: undefined }],
    ['档案查询失败', { loginName: 'int2023', config: { targetProfileCode: 627 }, method: 'getMemberDetail', reason: '目标档案拒绝' }],
    ['权限查询失败', { loginName: 'int2023', config: { permissionCode: 627 }, method: 'getUsersSessionLimit', reason: '权限查询拒绝' }],
    ['权限明确禁止', { loginName: 'int2023', config: { permissionDenied: true }, method: 'getUsersSessionLimit', reason: undefined }],
  ])('%s为前置失败，不建立草稿且同意图不重复找人', async (_label, { loginName, config, method, reason }) => {
    const native = createNativeSendRuntime(config);
    const ops = new BridgeMessageOps(native.cdp);
    const options = { operationId: 'user-pretrigger' };
    const result = await ops.sendTextToUser(loginName, '不可发送', options);
    expect(result).toMatchObject({ status: 'failed', isPreTrigger: true });
    if (method) expect(result.error).toContain(method);
    if (reason) expect(result.error).toContain(reason);
    const requests = native.ipc.sent.length;
    expect(await ops.sendTextToUser(loginName, '不可发送', options)).toEqual(result);
    expect(await ops.getSendStatus('user-pretrigger')).toEqual(result);
    expect(native.ipc.sent).toHaveLength(requests);
    expect(native.drafts).toEqual([]);
    expect(native.records).toEqual([]);
  });

  it('后页出现不同UID的同工号仍拒绝，不能看到首页匹配就发送', async () => {
    const users = Array.from({ length: 200 }, (_, index) => ({ id: 92000 + index, login_name: '候选' + index, name: '候选' }));
    users[0] = { id: 91003, login_name: 'int2023', name: '甲' };
    users.push({ id: 91004, login_name: 'int2023', name: '乙' });
    const native = createNativeSendRuntime({ searchUsers: users });
    expect(await new BridgeMessageOps(native.cdp).sendTextToUser('int2023', '歧义拒绝')).toMatchObject({ status: 'failed', isPreTrigger: true });
    expect(native.drafts).toEqual([]);
    expect(native.records).toEqual([]);
  });

  it.each([{ code: 627 }, { businessCode: 617 }])('原生业务失败保留失败码、正式会话回执，查询不能改判成功', async config => {
    const native = createNativeSendRuntime(config);
    const ops = new BridgeMessageOps(native.cdp);
    const options = { operationId: 'user-business-failed' };
    const result = await ops.sendTextToUser('int2023', '业务拒绝', options);
    expect(result).toMatchObject({ status: 'failed', nativeCode: config.code ?? config.businessCode, isPreTrigger: false, receipt: { sessionId: '94001' } });
    expect(await ops.getSendStatus('user-business-failed')).toEqual(result);
    expect(await ops.sendTextToUser('int2023', '业务拒绝', options)).toEqual(result);
    expect(native.records).toHaveLength(1);
  });

  it.each([
    { mismatchedReceiver: true },
    { mismatchedSender: true },
    { mismatchedDraft: true },
    { receiptSessionId: 0 },
    { mismatchedSession: true },
  ])('错接收对象、本人、负草稿或正式会话回执均不能确认，也不能靠正ID历史补判', async config => {
    vi.useFakeTimers();
    const native = createNativeSendRuntime(config);
    const ops = new BridgeMessageOps(native.cdp);
    const options = { operationId: 'user-wrong-receipt', verifyTimeoutMs: 50 };
    const pending = ops.sendTextToUser('int2023', '不接受错误证据', options);
    await vi.runAllTimersAsync();
    expect((await pending).status).not.toBe('sent');
    expect((await ops.getSendStatus(options.operationId)).status).not.toBe('sent');
    expect((await ops.sendTextToUser('int2023', '不接受错误证据', options)).status).not.toBe('sent');
    expect(native.records).toHaveLength(1);
    expect(native.ipc.listenerCount('0-91003-sendMsgCallback')).toBe(0);
  });

  it('CDP响应丢失后跨实例共享Store只读恢复正式会话及业务回执', async () => {
    const native = createNativeSendRuntime({ responseLost: true });
    const store = new InMemorySendOperationStore();
    const ops = new BridgeMessageOps(native.cdp, store);
    expect(await ops.sendTextToUser('int2023', '响应丢失', { operationId: 'user-lost' })).toMatchObject({ status: 'unknown' });
    const lookups = native.ipc.sent.filter(request => request.args[0] === 'unionSearch').length;
    const recovered = await new BridgeMessageOps(native.cdp, store).getSendStatus('user-lost');
    expect(recovered).toMatchObject({
      status: 'sent', sessionId: '94001', messageId: '135700000',
      receipt: { draftId: '-1', sessionId: '94001', code: 0, messageId: '135700000' },
    });
    expect(await ops.sendTextToUser('int2023', '响应丢失', { operationId: 'user-lost' })).toEqual(recovered);
    expect(native.ipc.sent.filter(request => request.args[0] === 'unionSearch')).toHaveLength(lookups);
    expect(native.records).toHaveLength(1);
  });

  it('未知操作并发重复只声明一次，不再次找人或提交，换工号或内容冲突', async () => {
    vi.useFakeTimers();
    const native = createNativeSendRuntime({ callback: false });
    const ops = new BridgeMessageOps(native.cdp);
    const options = { operationId: 'user-unknown', verifyTimeoutMs: 50 };
    const first = ops.sendTextToUser('int2023', '未知意图', options);
    const concurrent = ops.sendTextToUser('int2023', '未知意图', options);
    await vi.runAllTimersAsync();
    expect((await first).status).toBe('unknown');
    expect((await concurrent).status).toBe('unknown');
    const lookups = native.ipc.sent.filter(request => request.args[0] === 'unionSearch').length;
    expect((await ops.sendTextToUser('int2023', '未知意图', options)).status).toBe('unknown');
    expect((await ops.getSendStatus(options.operationId)).status).toBe('unknown');
    await expect(ops.sendTextToUser('其他工号', '未知意图', options)).rejects.toThrow(/fingerprint/);
    await expect(ops.sendTextToUser('int2023', '不同内容', options)).rejects.toThrow(/fingerprint/);
    await expect(ops.sendText('未知意图', { targetSessionId: '93001', operationId: options.operationId })).rejects.toThrow(/fingerprint/);
    expect(native.ipc.sent.filter(request => request.args[0] === 'unionSearch')).toHaveLength(lookups);
    expect(native.records).toHaveLength(1);
  });

  it('人员搜索等待时取消不提交，迟到的搜索响应不能恢复发送', async () => {
    const native = createNativeSendRuntime();
    const send = native.ipc.send.bind(native.ipc);
    let ready = (): void => {};
    let respond = (): void => {};
    const started = new Promise<void>(resolve => { ready = resolve; });
    native.ipc.send = (channel, request) => {
      if (request.args[0] === 'unionSearch') {
        respond = () => send(channel, request);
        ready();
      } else send(channel, request);
    };
    const ops = new BridgeMessageOps(native.cdp);
    const pending = ops.sendTextToUser('int2023', '搜索中取消', { operationId: 'user-cancel-lookup' });
    await started;
    const cancelling = ops.cancelPendingSends();
    respond();
    await cancelling;
    expect(await pending).toMatchObject({ status: 'failed', isPreTrigger: true });
    expect(native.drafts).toEqual([]);
    expect(native.records).toEqual([]);
    expect(native.ipc.listenerCount('0-91003-sendMsgCallback')).toBe(0);
  });

  it('取消一个实例只释放自己的首次发送监听，另一个实例仍能接收正式会话回执', async () => {
    const native = createNativeSendRuntime({ callback: false });
    const first = new BridgeMessageOps(native.cdp);
    const second = new BridgeMessageOps(native.cdp);
    const otherListener = vi.fn();
    native.ipc.on('0-91003-sendMsgCallback', otherListener);
    const a = first.sendTextToUser('int2023', '甲', { operationId: 'user-cancel-a' });
    const b = second.sendTextToUser('int2023', '乙', { operationId: 'user-cancel-b' });
    for (let i = 0; i < 200 && native.records.length < 2; i++) await Promise.resolve();
    expect(native.records).toHaveLength(2);
    await first.cancelPendingSends();
    expect((await a).status).toBe('unknown');
    expect(native.ipc.listenerCount('0-91003-sendMsgCallback')).toBe(2);
    const record = native.records[1];
    const draft = native.drafts[1];
    expect(record).toMatchObject({ content: { content: [{ text: '乙' }] } });
    expect(draft).toMatchObject({ content: { content: [{ text: '乙' }] } });
    native.ipc.emit('0-91003-sendMsgCallback', { args: { msgID: draft?.['id'], code: 0, data: record } });
    expect(await b).toMatchObject({ status: 'sent', sessionId: '94001' });
    expect(otherListener).toHaveBeenCalledTimes(1);
    expect(native.ipc.listenerCount('0-91003-sendMsgCallback')).toBe(1);
    // 此Map由同一渲染脚本创建，节点仅持有其跨VM引用。
    const pendingSends = native.window['__kairo_pending_sends'] as Map<string, unknown>;
    expect(pendingSends.size).toBe(0);
    native.ipc.removeListener('0-91003-sendMsgCallback', otherListener);
  });

  it.each(['人员搜索', '正式记录'] as const)('整轮超时中止%s，迟到回复不能恢复提交且释放在途任务', async stage => {
    vi.useFakeTimers();
    const users = Array.from({ length: 2001 }, (_, index) => ({
      id: 92000 + index, login_name: 'int2023-' + index, name: '候选',
    }));
    users[0] = { id: 91003, login_name: 'int2023', name: '准确接收者' };
    const native = createNativeSendRuntime(stage === '人员搜索' ? { searchUsers: users } : {});
    const send = native.ipc.send.bind(native.ipc);
    native.ipc.send = (channel, request) => {
      if (stage === '人员搜索' && request.args[0] === 'unionSearch') {
        setTimeout(() => send(channel, request), 3500);
      } else if (stage === '正式记录' && request.args[0] === 'getMessages') {
        // 正式回执已到，但模拟查询尚不可见本次记录。
        const query = request.args[1];
        if (!query || typeof query !== 'object') throw new Error('历史查询缺少参数');
        setTimeout(() => send(channel, { ...request, args: ['getMessages', { ...query, endIdx: 0 }] }), 3500);
      } else send(channel, request);
    };
    const ops = new BridgeMessageOps(native.cdp);
    let observed: SendResult | undefined;
    const pending = ops.sendTextToUser('int2023', '整轮截止', { operationId: 'user-deadline-' + stage })
      .then(result => { observed = result; return result; });
    try {
      await vi.advanceTimersByTimeAsync(28000);
      expect(observed).toMatchObject(stage === '人员搜索'
        ? { status: 'failed', isPreTrigger: true }
        : { status: 'unknown', isPreTrigger: false });
      expect(observed?.error).toContain('整轮超时');
      const pendingSends = native.window['__kairo_pending_sends'] as Map<string, unknown>;
      expect(pendingSends.size).toBe(0);
    } finally {
      await ops.cancelPendingSends();
      await vi.runAllTimersAsync();
      await pending;
    }
    expect(native.drafts).toHaveLength(stage === '人员搜索' ? 0 : 1);
    expect(native.records).toHaveLength(stage === '人员搜索' ? 0 : 1);
    expect(native.ipc.listenerCount('0-91003-sendMsgCallback')).toBe(0);
  });

  it('成功回执的正式记录被后续消息挤出最新历史后仍只读恢复', async () => {
    const native = createNativeSendRuntime({ responseLost: true });
    const store = new InMemorySendOperationStore();
    const ops = new BridgeMessageOps(native.cdp, store);
    const options = { operationId: 'user-busy-history' };
    expect(await ops.sendTextToUser('int2023', '恢复原意图', options)).toMatchObject({ status: 'unknown' });
    const original = native.records[0]!;
    for (let index = 0; index < 101; index++) native.records.push({
      ...original, id: 135700001 + index, msgIdx: index + 2, msgFlag: '其他意图-' + index,
    });
    const recovered = await new BridgeMessageOps(native.cdp, store).getSendStatus(options.operationId);
    expect(recovered).toMatchObject({ status: 'sent', sessionId: '94001', messageId: '135700000', receipt: { msgIdx: 1 } });
    expect(await ops.sendTextToUser('int2023', '恢复原意图', options)).toEqual(recovered);
    expect(native.ipc.sent.filter(request => request.args[0] === 'sendMessageNew')).toHaveLength(1);
  });

  it('精确状态查询不接受另一接收者记录，原生错误保留方法与原因', async () => {
    const config = { responseLost: true, queryCode: 0 };
    const native = createNativeSendRuntime(config);
    const ops = new BridgeMessageOps(native.cdp);
    expect(await ops.sendTextToUser('int2023', '只认本次记录', { operationId: 'user-exact-evidence' })).toMatchObject({ status: 'unknown' });
    native.records[0]!['receiver'] = 91999;
    expect(await ops.getSendStatus('user-exact-evidence')).toMatchObject({ status: 'unknown' });
    config.queryCode = 627;
    await expect(ops.getSendStatus('user-exact-evidence')).rejects.toThrow(/getMessageByMsgId.*627/);
    expect(native.ipc.sent.filter(request => request.args[0] === 'sendMessageNew')).toHaveLength(1);
  });

  it('复用普通发送选项仍仅发纯文本，重复最小选项不发生意图冲突', async () => {
    const native = createNativeSendRuntime();
    const ops = new BridgeMessageOps(native.cdp);
    const options: SendOptions = { operationId: 'user-options-only', targetSessionId: '93001', mentions: 'all', replyTo: '其他引用' };
    const result = await ops.sendTextToUser('int2023', '准确纯文本', options);
    expect(result).toMatchObject({ status: 'sent', sessionId: '94001' });
    expect(native.records).toMatchObject([{
      content: { content: [{ type: 0, text: '准确纯文本' }] }, atMemberIDList: [], atState: 1,
    }]);
    expect(await ops.sendTextToUser('int2023', '准确纯文本', { operationId: options.operationId })).toEqual(result);
    expect(native.records).toHaveLength(1);
  });

  it('普通选项的提及不能把工号发送的空正文变成可发送消息', async () => {
    const native = createNativeSendRuntime();
    const options: SendOptions = { operationId: 'user-empty-with-mention', mentions: 'all' };
    expect(await new BridgeMessageOps(native.cdp).sendTextToUser('int2023', '', options)).toMatchObject({ status: 'failed', isPreTrigger: true });
    expect(native.drafts).toEqual([]);
    expect(native.records).toEqual([]);
  });
});
