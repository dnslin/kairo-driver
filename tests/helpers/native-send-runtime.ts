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
    queryCode?: number;
    cancelCode?: number;
    sendDelayMs?: number;
    responseGate?: Promise<void>;
    responseStarted?: () => void;
    prepareImage?: (thumb: string, source: string) => unknown;
  } = {}
) {
  const sessions = [
    { id: 93001, type: 0, typeID: 91002, creater: 91001, typeName: '员工甲' },
    { id: 93002, type: 1, typeID: 92001, creater: 92001, typeName: '群甲' },
  ];
  const records: Array<Record<string, unknown>> = [];
  const drafts: Array<Record<string, unknown>> = [];
  let nextId = 135700000;
  const ipc = new FakeIpcRenderer(request => {
    const method = request.args[0];
    if (method === 'getMemberDetail')
      return {
        code: 0,
        data: { id: config.identity === undefined ? 91001 : config.identity, name: '原生账号' },
      };
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
      const record = {
        ...message,
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
              msgID: message['id'],
              code: config.code ?? 0,
              data: config.mismatchedSession ? { ...record, sessionID: 999 } : record,
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
