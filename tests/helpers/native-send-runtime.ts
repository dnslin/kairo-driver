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
    if (method === 'sendingImgBeforeHandle')
      return { code: 0, data: { thumbPath: '原生缩略图', artworkPath: '原生原图' } };
    throw new Error('未声明原生方法 ' + String(method));
  });
  const window: Record<string, unknown> = { ipcRenderer: ipc };
  const context: Record<string, unknown> = { window, setTimeout, clearTimeout };
  let connected = true;
  const cdp = {
    getStatus: () => (connected ? 'connected' : 'disconnected'),
    evaluate: async (script: string) => {
      const value = await runRendererScript(script, context);
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
