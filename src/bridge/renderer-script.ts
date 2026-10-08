export function encodeRendererPayload(data: unknown): string {
  return JSON.stringify(encodeURIComponent(JSON.stringify(data)));
}

export const RENDERER_SESSION_RESOLVER_SCRIPT = `
  function resolveRendererSession(sessions, target) {
    if (!Array.isArray(sessions) || !target) return null;
    const cleanTarget = String(target).trim();
    if (/^-?[0-9]+$/.test(cleanTarget)) {
      return sessions.find(session => session && String(session.id) === cleanTarget) || null;
    }

    const idMatch = sessions.find(
      session => session && (
        session.sesUUID === cleanTarget ||
        String(session.id) === cleanTarget
      )
    );
    if (idMatch) return idMatch;
    const nameMatches = sessions.filter(
      session => session && (session.typeName === cleanTarget || session.name === cleanTarget)
    );
    return nameMatches.length === 1 ? nameMatches[0] : null;
  }

  function resolveRendererSessionIdentity(sessions, targetId, targetName) {
    if (!Array.isArray(sessions)) return null;
    if (targetId) {
      const cleanId = String(targetId).trim();
      const idMatch = sessions.find(
        session => session && (
          String(session.id) === cleanId ||
          session.sesUUID === cleanId
        )
      );
      if (idMatch) return idMatch;
      return null;
    }
    if (!targetName) return null;

    const nameMatches = sessions.filter(
      session => session && (
        session.typeName === targetName ||
        session.name === targetName
      )
    );
    return nameMatches.length === 1 ? nameMatches[0] : null;
  }

  function resolveRendererReceiver(session, currentUserId) {
    return session.type === 0 && String(session.typeID) === String(currentUserId)
      ? session.creater
      : session.typeID;
  }
`;

export const RENDERER_IPC_HELPERS_SCRIPT = `
  function nextKairoRequestId() {
    const key = '__kairo_rpc_id';
    const currentId = typeof window[key] === 'number' ? window[key] : 800000;
    window[key] = currentId + 1;
    return currentId + 1;
  }

  function callKairoIpcWithTimeout(timeoutMs, channel, ...args) {
    return new Promise(resolve => {
      if (!ipc || typeof ipc.send !== 'function' || typeof ipc.once !== 'function') {
        resolve({ code: -1, error: '当前环境未找到有效的 ipcRenderer 对象' });
        return;
      }

      const requestId = nextKairoRequestId();
      const replyChannel = 'data-' + requestId;
      let settled = false;
      let timer;

      const cleanup = () => {
        if (typeof ipc.removeListener === 'function') {
          try { ipc.removeListener(replyChannel, onReply); } catch (error) {}
        }
      };
      const finish = payload => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        cleanup();
        resolve(payload);
      };
      const onReply = (_event, payload) => {
        finish(payload || { code: 0 });
      };

      timer = setTimeout(() => {
        finish({ code: -2, error: 'IPC 请求超时' });
      }, timeoutMs);
      ipc.once(replyChannel, onReply);

      try {
        ipc.send('data', {
          id: requestId,
          args: [channel, ...args],
          progress: false
        });
      } catch (sendError) {
        finish({ code: -3, error: 'ipc.send 失败: ' + String(sendError) });
      }
    });
  }

  function callKairoIpc(channel, ...args) {
    return callKairoIpcWithTimeout(4000, channel, ...args);
  }
`;

export const NATIVE_SEND_CONTEXT_SCRIPT = `
  async function readNativeSendContext(target) {
    const identity = await callIpc('getMemberDetail');
    if (identity?.code !== 0 || !Number.isSafeInteger(Number(identity?.data?.id)) || Number(identity.data.id) <= 0) {
      throw new Error('getMemberDetail未取得实际登录身份 (' + identity?.code + ')');
    }
    const response = await callIpc('getSessionBySessionID', Number(target));
    const session = response?.data;
    if (response?.code !== 0 || !session || String(session.id) !== String(target)) {
      throw new Error('getSessionBySessionID未取得指定原生会话 ' + target + ' (' + response?.code + ')');
    }
    const receiver = session.type === 0 && String(session.typeID) === String(identity.data.id) ? session.creater : session.typeID;
    if (!Number.isSafeInteger(Number(receiver)) || Number(receiver) <= 0) throw new Error('原生会话缺少明确接收对象');
    return { identity: identity.data, session: { ...session, sesTypeID: receiver, receiverId: String(receiver), sesUUID: session.type + '-' + receiver }, receiver };
  }
`;

export const CONFIRM_SENT_MESSAGE_SCRIPT = `
  async function waitForPersistedMessage(sessionID, msgFlag) {
    for (let attempt = 0; attempt < 12; attempt++) {
      const response = await callIpc('getMessages', { sessionID, count: 100, endIdx: 2147483647, sendTime: 0 });
      if (response?.code !== 0 || !Array.isArray(response.data)) {
        throw new Error('getMessages关联正式记录失败 (' + response?.code + '): ' + (response?.error || '无效数组'));
      }
      const found = response.data.find(message => message && message.msgFlag === msgFlag &&
        /^[1-9]\\d*$/.test(String(message.id)) && String(message.sessionID) === String(sessionID));
      if (found) return found;
      if (attempt < 11) await new Promise(resolve => setTimeout(resolve, 200));
    }
    return null;
  }
`;

// 订阅只属于本次负草稿；原生数据请求完成与业务回执是两件事。
export const SUBMIT_NATIVE_MESSAGE_SCRIPT = `
  const observeNativeSend = window.__kairo_native_send_observer;
  async function submitNativeMessage(msgObj, targetSession, timeoutMs = 8000) {
    const insertRes = await callIpc('insertSendBefoeMsg', msgObj);
    if (insertRes?.code !== 0 || !Number.isSafeInteger(Number(insertRes?.data?.id)) || Number(insertRes.data.id) >= 0) {
      const definite = Boolean(insertRes && insertRes.code !== 0 && insertRes.code !== -2);
      return { insertFailed: true, failure: { status: definite ? 'failed' : 'unknown',
        error: 'insertSendBefoeMsg未取得负草稿 (' + insertRes?.code + '): ' + (insertRes?.error || '无效草稿'), isPreTrigger: definite } };
    }
    msgObj.id = insertRes.data.id;
    msgObj.msgIdx = insertRes.data.msgIdx;
    const draftId = String(msgObj.id);
    const channel = msgObj.sessionType + '-' + msgObj.receiver + '-sendMsgCallback';
    const receipts = window.__kairo_send_receipts || (window.__kairo_send_receipts = new Map());
    const pending = window.__kairo_pending_sends || (window.__kairo_pending_sends = new Map());
    let settle;
    let timer;
    let settled = false;
    let callback;
    const received = new Promise(resolve => { settle = resolve; });
    const finish = value => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ipc.removeListener(channel, onReceipt);
      pending.delete(msgObj.msgFlag);
      settle(value);
    };
    const onReceipt = (_event, payload) => {
      // 原生windows.sendTo使用{ id:false, args:回执对象 }，不是数组。
      const value = payload?.args;
      if (!value || String(value.msgID) !== draftId) return;
      const data = value.data;
      if (data?.sessionID !== undefined && String(data.sessionID) !== String(msgObj.sessionID)) return;
      let ext = data?.ext;
      try { if (typeof ext === 'string') ext = JSON.parse(ext); }
      catch { finish({ failure: { status: 'unknown', error: '本次业务ext无法解析', isPreTrigger: false } }); return; }
      const receipt = { draftId, sessionId: String(msgObj.sessionID), code: value.code,
        ...(typeof ext?.status === 'number' ? { businessCode: ext.status } : {}),
        ...(data?.id !== undefined ? { messageId: String(data.id) } : {}),
        ...(data?.msgIdx !== undefined ? { msgIdx: Number(data.msgIdx) } : {}) };
      if (typeof value.code !== 'number') { finish({ failure: { status: 'unknown', error: '本次业务回执缺code', isPreTrigger: false } }); return; }
      const failedCode = value.code !== 0 ? value.code : ext?.status !== undefined && ext.status !== 0 ? ext.status : undefined;
      callback = { receipt, ...(failedCode !== undefined ? { failure: { status: 'failed', nativeCode: failedCode,
        error: '原生发送业务失败 (' + failedCode + ')；会话 ' + msgObj.sessionID + '；草稿 ' + draftId,
        isPreTrigger: false, receipt } } : { data }) };
      receipts.set(msgObj.msgFlag, { receipt, ...(callback.failure ? { failure: callback.failure } : {}) });
      finish(callback);
    };
    ipc.on(channel, onReceipt);
    pending.set(msgObj.msgFlag, () => finish({ failure: { status: 'unknown', error: '本轮发送等待已取消', isPreTrigger: false } }));
    timer = setTimeout(() => finish({ failure: { status: 'unknown', error: '本次原生业务回执超时', isPreTrigger: false } }), timeoutMs);
    try {
      // 监听已就绪；回执可先于data请求回包到达，外层code0不参与成功判定。
      const submission = callIpc('sendMessageNew', { ...msgObj });
      submission.catch(error => finish(callback || { failure: { status: 'unknown', error: String(error), isPreTrigger: false } }));
      submission.then(response => {
        if (response?.code !== 0) finish(callback || { failure: { status: 'unknown',
          error: 'sendMessageNew请求未完成 (' + response?.code + '): ' + (response?.error || ''), isPreTrigger: false } });
      }, () => undefined);
      const observation = await received;
      await submission.catch(() => undefined);
      if (observation.failure) return observation;
      let confirmedMessage = observation.data;
      if (!/^[1-9]\\d*$/.test(String(confirmedMessage?.id))) {
        confirmedMessage = await waitForPersistedMessage(msgObj.sessionID, msgObj.msgFlag);
      }
      if (!confirmedMessage || String(confirmedMessage.sessionID) !== String(msgObj.sessionID)) {
        return { receipt: observation.receipt, failure: { status: 'unknown', error: '成功业务回执尚未关联本次正式消息ID', isPreTrigger: false, receipt: observation.receipt } };
      }
      const receipt = { ...observation.receipt, messageId: String(confirmedMessage.id), msgIdx: Number(confirmedMessage.msgIdx) };
      receipts.set(msgObj.msgFlag, { receipt });
      if (typeof observeNativeSend === 'function') observeNativeSend({ sessionId: String(msgObj.sessionID), session: targetSession, message: [confirmedMessage] });
      return { confirmedMessage, receipt };
    } catch (error) {
      return { failure: { status: 'unknown', error: String(error), isPreTrigger: false }, ...(callback?.receipt ? { receipt: callback.receipt } : {}) };
    } finally {
      finish({ failure: { status: 'unknown', error: '本轮发送结束', isPreTrigger: false } });
    }
  }
`;
