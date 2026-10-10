import type { CdpClient } from '../../src/cdp/client.js';
import { FakeIpcRenderer, runRendererScript } from './renderer-runtime.js';

export function createNativeSendRuntime(
  config: {
    code?: number;
    businessCode?: number;
    callback?: boolean;
    identity?: number | null;
    insertCode?: number;
    insertWithoutData?: boolean;
    responseLost?: boolean;
    mismatchedSession?: boolean;
    mismatchedReceiver?: boolean;
    mismatchedSender?: boolean;
    mismatchedDraft?: boolean;
    receiptSessionId?: number;
    searchUsers?: Array<{ id: number; login_name: string; name: string }>;
    searchCode?: number;
    targetProfile?: Record<string, unknown>;
    targetProfileCode?: number;
    permissionCode?: number;
    permissionDenied?: boolean;
    existingUserSessionId?: number;
    reverseUserSession?: boolean;
    queryCode?: number;
    cancelCode?: number;
    sendDelayMs?: number;
    responseGate?: Promise<void>;
    responseStarted?: () => void;
    prepareImage?: (thumb: string, source: string) => unknown;
  } = {}
) {
  const sessions: Array<{ id: number; type: number; typeID: number | string;
    creater: number | string; typeName: string }> = [
    { id: 93001, type: 0, typeID: 91002, creater: 91001, typeName: '员工甲' },
    { id: 93002, type: 1, typeID: 92001, creater: 92001, typeName: '群甲' },
  ];
  if (config.existingUserSessionId !== undefined || config.reverseUserSession) sessions.push({
    id: config.existingUserSessionId ?? 93003, type: 0,
    typeID: config.reverseUserSession ? '91001' : 91003,
    creater: config.reverseUserSession ? '91003' : 91001, typeName: '准确接收者',
  });
  const users = config.searchUsers ?? [{ id: 91003, login_name: 'int2023', name: '准确接收者' }];
  const records: Array<Record<string, unknown>> = [];
  const drafts: Array<Record<string, unknown>> = [];
  let nextId = 135700000;
  const ipc = new FakeIpcRenderer(request => {
    const method = request.args[0];
    if (method === 'getMemberDetail') {
      if (request.args[1] === undefined)
        return { code: 0, data: {
          id: config.identity === undefined ? 91001 : config.identity,
          login_name: '0123040139', name: '原生账号',
        } };
      if (config.targetProfileCode) return { code: config.targetProfileCode, error: '目标档案拒绝' };
      return { code: 0, data: config.targetProfile ?? users.find(user => user.id === request.args[1]) ?? null };
    }
    if (method === 'unionSearch') {
      if (config.searchCode) return { code: config.searchCode, error: '人员搜索拒绝' };
      const query = request.args[1];
      if (!query || typeof query !== 'object' || !('type' in query) || query.type !== 'user' ||
          !('kwd' in query) || typeof query.kwd !== 'string' || !('pageNo' in query) ||
          !Number.isSafeInteger(query.pageNo) || Number(query.pageNo) < 1 ||
          !('pageSize' in query) || query.pageSize !== 200) throw new Error('人员搜索参数不符合原生协议');
      const start = (Number(query.pageNo) - 1) * query.pageSize;
      return { code: 0, data: { probableUsers: [], users: users.slice(start, start + query.pageSize),
        groups: [], departs: [], apps: [], messages: [], files: [] } };
    }
    if (method === 'getUsersSessionLimit') {
      if (config.permissionCode) return { code: config.permissionCode, error: '权限查询拒绝' };
      if (!Number.isSafeInteger(request.args[1]) || Number(request.args[1]) <= 0)
        throw new Error('权限查询应传准确接收者UID');
      return { code: 0, data: config.permissionDenied ? [request.args[1]] : [] };
    }
    if (method === 'getSessionBySessionID')
      return { code: 0, data: sessions.find(session => session.id === request.args[1]) };
    if (method === 'insertSendBefoeMsg') {
      if (config.insertCode) return { code: config.insertCode, error: '原生插入拒绝' };
      if (config.insertWithoutData) return { code: 0 };
      const draft = {
        ...(request.args[1] as Record<string, unknown>),
        id: -drafts.length - 1,
        msgIdx: 1.001,
      };
      drafts.push(draft);
      return { code: 0, data: draft };
    }
    if (method === 'sendMessageNew') {
      const message = request.args[1] as Record<string, unknown>;
      let sessionID = message['sessionID'];
      if (sessionID === 0) {
        let session = sessions.find(item => item.type === 0 &&
          ((String(item.typeID) === String(message['receiver']) && String(item.creater) === String(message['sender'])) ||
           (String(item.typeID) === String(message['sender']) && String(item.creater) === String(message['receiver']))));
        if (!session) {
          session = { id: 94001, type: 0, typeID: Number(message['receiver']),
            creater: Number(message['sender']), typeName: '准确接收者' };
          sessions.push(session);
        }
        sessionID = session.id;
      }
      const record = {
        ...message,
        sessionID,
        id: nextId++,
        msgIdx: records.length + 1,
        status: 'success',
        deviceID: 88001,
        ...(config.businessCode ? { ext: JSON.stringify({ status: config.businessCode }) } : {}),
      };
      records.push(record);
      if (config.callback !== false)
        ipc.emit(
          `${String(message['sessionType'])}-${String(message['receiver'])}-sendMsgCallback`,
          {
            args: {
              msgID: config.mismatchedDraft ? Number(message['id']) - 100 : message['id'],
              code: config.code ?? 0,
              data: {
                ...record,
                ...(config.mismatchedSession ? { sessionID: 999 } : {}),
                ...(config.receiptSessionId !== undefined ? { sessionID: config.receiptSessionId } : {}),
                ...(config.mismatchedReceiver ? { receiver: 91999 } : {}),
                ...(config.mismatchedSender ? { sender: 91999 } : {}),
              },
            },
          }
        );
      return { code: 0 };
    }
    if (method === 'getMessages') {
      const query = request.args[1] as { sessionID: number; count: number; endIdx: number };
      return {
        code: config.queryCode ?? 0,
        data: records
          .filter(
            message =>
              message['sessionID'] === query.sessionID && Number(message['msgIdx']) <= query.endIdx
          )
          .slice(-query.count),
      };
    }
    if (method === 'getMessageBySessionIDAndMsgIdx')
      return {
        code: 0,
        data: records.filter(
          message =>
            message['sessionID'] === request.args[1] && message['msgIdx'] === request.args[2]
        ),
      };
    if (method === 'getMessageByMsgId')
      return {
        code: config.queryCode ?? 0,
        data: records.find(message => String(message['id']) === String(request.args[1])),
      };
    if (method === 'cancelMessage') {
      if (config.cancelCode) return { code: config.cancelCode, error: '原生拒绝撤回' };
      const target = request.args[1];
      if (!target || typeof target !== 'object' || !('sessionID' in target) ||
          !('msgID' in target) || !('msgIdx' in target)) return { code: 627 };
      const record = records.find(message => message['sessionID'] === target.sessionID &&
        message['id'] === target.msgID && message['msgIdx'] === target.msgIdx);
      if (!record) return { code: 627, error: '原生撤回目标不匹配' };
      record['msgFlag'] = 'C';
      return { code: 0 };
    }
    if (method === 'sendingImgBeforeHandle')
      return (
        config.prepareImage?.(request.args[1] as string, request.args[2] as string) ?? {
          code: 1,
          error: '未提供图片预处理',
        }
      );
    throw new Error('未声明原生方法 ' + String(method));
  });
  if (config.sendDelayMs !== undefined) {
    const send = ipc.send.bind(ipc);
    ipc.send = (channel, request) => {
      if (request.args[0] === 'sendMessageNew') {
        setTimeout(() => send(channel, request), config.sendDelayMs);
      } else send(channel, request);
    };
  }
  const window: Record<string, unknown> = { ipcRenderer: ipc };
  const context: Record<string, unknown> = { window, setTimeout, clearTimeout, AbortController };
  let connected = true;
  const cdp = {
    getStatus: () => (connected ? 'connected' : 'disconnected'),
    evaluate: async (script: string) => {
      const value = await runRendererScript(script, context);
      if (script.includes('submitNativeMessage(msgObj')) {
        config.responseStarted?.();
        await config.responseGate;
      }
      if (config.responseLost && script.includes('submitNativeMessage(msgObj'))
        throw new Error('提交后CDP响应丢失');
      return value;
    },
  } as unknown as CdpClient;
  return {
    cdp,
    ipc,
    context,
    window,
    sessions,
    records,
    drafts,
    disconnect() {
      connected = false;
    },
  };
}
