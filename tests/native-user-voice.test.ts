import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EdgeTTS } from 'node-edge-tts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BridgeMessageOps } from '../src/bridge/message-ops.js';
import { KK9Driver } from '../src/driver.js';
import { InMemorySendOperationStore } from '../src/send-operation.js';
import type { CdpClient } from '../src/cdp/client.js';
import type { KK9RecalledEvent, SendOptions } from '../src/types/index.js';
import { getDriverTestInternals } from './helpers/driver-internals.js';
import { createNativeSendRuntime } from './helpers/native-send-runtime.js';
import type { FakeIpcRenderer } from './helpers/renderer-runtime.js';

type NativeConfig = NonNullable<Parameters<typeof createNativeSendRuntime>[0]>;
interface NativeVoiceState {
  drafts: Array<Record<string, unknown>>;
  records: Array<Record<string, unknown>>;
  ipc: FakeIpcRenderer;
  window: Record<string, unknown>;
}
const users = [
  { id: 91004, login_name: 'AbC', name: '00AbC' },
  { id: 91005, login_name: '00abc', name: '同名员工' },
  { id: 91003, login_name: '00AbC', name: '同名员工' },
];
const amrHeader = Buffer.from('#!AMR\n');
const amrFrame = Buffer.from('IyFBTVIKLA4ajszcQMium6nIdhHVkehAIOju', 'base64').subarray(6);
const directories: string[] = [];

// 仅替换 Electron IPC、内置编码器及外部 TTS；WAV 解码、准备、发送脚本和回执关联均执行真实实现。
function voiceRuntime(config: NativeConfig = {}) {
  config.searchUsers ??= users;
  const native = createNativeSendRuntime(config);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kairo-user-voice-'));
  directories.push(directory);
  const wav = Buffer.alloc(44 + 1600);
  wav.write('RIFF');
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(8000, 24);
  wav.writeUInt32LE(16000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(1600, 40);
  for (let offset = 44; offset < wav.length; offset += 2) wav.writeInt16LE(8000, offset);
  const filePath = path.join(directory, 'voice.wav');
  fs.writeFileSync(filePath, wav);
  const codec = {
    encodes: 0,
    onEncode: undefined as (() => void) | undefined,
    Mode: { MR795: 5 },
    encode(pcm: Float32Array, rate: number, mode: number): Buffer {
      expect(rate).toBe(8000);
      expect(mode).toBe(5);
      expect(pcm.some(sample => sample > 0)).toBe(true);
      codec.encodes++;
      codec.onEncode?.();
      return Buffer.concat([
        amrHeader,
        ...Array.from({ length: pcm.length / 160 - 1 }, () => amrFrame),
      ]);
    },
    decode(encoded: Uint8Array): Float32Array {
      return new Float32Array(((encoded.length - 6) / amrFrame.length) * 160);
    },
  };
  const require = native.window['require'] as (name: string) => unknown;
  native.window['process'] = { resourcesPath: '/offline-kk9/resources' };
  native.window['require'] = (name: string) => (name.endsWith('amrnb') ? codec : require(name));
  return { ...native, codec, wav, input: { filePath } };
}

function holdNativeRequest(ipc: FakeIpcRenderer, method: string) {
  const send = ipc.send.bind(ipc);
  let started!: () => void;
  let release!: () => void;
  const pending = new Promise<void>(resolve => {
    started = resolve;
  });
  ipc.send = (channel, request) => {
    if (request.args[0] === method) {
      release = () => send(channel, request);
      started();
    } else send(channel, request);
  };
  return { started: pending, release: () => release() };
}

async function connectDriver(transport: CdpClient, currentUserId = '配置身份不能冒充实际账号') {
  const driver = new KK9Driver({
    cdp: { url: 'http://127.0.0.1:1', pageMatch: '离线语音' },
    currentUserId,
  });
  const { cdp, eventBridge } = getDriverTestInternals(driver);
  vi.spyOn(cdp, 'connect').mockResolvedValue();
  vi.spyOn(cdp, 'getStatus').mockReturnValue('connected');
  vi.spyOn(cdp, 'evaluate').mockImplementation(transport.evaluate.bind(transport));
  vi.spyOn(eventBridge, 'connect').mockResolvedValue();
  vi.spyOn(eventBridge, 'disconnect').mockResolvedValue();
  await driver.connect();
  return driver;
}

function expectNoSubmission(native: NativeVoiceState) {
  expect(native.drafts).toEqual([]);
  expect(native.records).toEqual([]);
  expect(native.ipc.sent.filter(request => request.args[0] === 'sendMessageNew')).toEqual([]);
  expect(
    (native.window['__kairo_pending_sends'] as Map<string, unknown> | undefined)?.size ?? 0
  ).toBe(0);
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const directory of directories.splice(0))
    fs.rmSync(directory, { recursive: true, force: true });
});

describe('原生语音按准确工号发送', () => {
  it('首次联系只发送 AMR 语音，准确工号和正式会话回执参与操作防重', async () => {
    const native = voiceRuntime();
    native.sessions.splice(0);
    const store = new InMemorySendOperationStore();
    const ops = new BridgeMessageOps(native.cdp, store);
    const options = { targetLoginName: ' 00AbC ', operationId: 'voice-first', verifyTimeoutMs: 50 };
    const result = await ops.sendVoice(native.input, options, 91001);
    expect(result).toMatchObject({
      status: 'sent',
      sessionId: '94001',
      messageId: '135700000',
      receipt: { draftId: '-1', code: 0, sessionId: '94001', messageId: '135700000', msgIdx: 1 },
    });
    expect(native.context['document']).toBeUndefined();
    expect(native.drafts).toMatchObject([
      { sessionID: 0, sessionType: 0, sender: 91001, receiver: 91003, contentType: 2 },
    ]);
    expect(native.records).toHaveLength(1);
    expect(native.records[0]).toMatchObject({ sessionID: 94001, contentType: 2, receiver: 91003 });
    const content = native.records[0]?.['content'] as { data: string; duration: number };
    expect(Object.keys(content).sort()).toEqual(['data', 'duration']);
    expect(content.duration).toBe(1);
    expect(Buffer.from(content.data, 'base64').subarray(0, 6)).toEqual(amrHeader);
    expect(
      native.ipc.sent
        .filter(request => request.args[0] === 'unionSearch')
        .map(request => request.args[1])
    ).toEqual([{ type: 'user', kwd: '00AbC', pageNo: 1, pageSize: 200 }]);
    expect(await store.get(options.operationId)).toMatchObject({
      status: 'sent',
      sessionId: '94001',
      fingerprint: { targetSessionId: '', targetLoginName: '00AbC', messageType: 'voice' },
    });
    const requests = native.ipc.sent.length;
    expect(
      await ops.sendVoice(native.input, { ...options, targetLoginName: '00AbC' }, 91001)
    ).toEqual(result);
    expect(
      await new BridgeMessageOps(native.cdp, store).getSendStatus(options.operationId)
    ).toEqual(result);
    await expect(
      ops.sendVoice(native.input, { ...options, targetLoginName: '00abc' }, 91001)
    ).rejects.toThrow('fingerprint');
    await expect(
      ops.sendVoice({ filePath: native.input.filePath + '.different' }, options, 91001)
    ).rejects.toThrow('fingerprint');
    expect(native.codec.encodes).toBe(1);
    expect(native.ipc.sent).toHaveLength(requests);
    expect(native.ipc.listenerCount('0-91003-sendMsgCallback')).toBe(0);
    expect((native.window['__kairo_pending_sends'] as Map<string, unknown>).size).toBe(0);
  });

  it('文本合成沿用真实准备且不先发送文本，重放不再合成', async () => {
    const native = voiceRuntime();
    const syntheses: Array<{ text: string; file: string }> = [];
    vi.spyOn(EdgeTTS.prototype, 'ttsPromise').mockImplementation((text, file) => {
      syntheses.push({ text, file });
      fs.writeFileSync(file, native.wav);
      return Promise.resolve();
    });
    const ops = new BridgeMessageOps(native.cdp);
    const input = { text: '  读出 <研发&财务>\n正文  ' };
    const options = { targetLoginName: '00AbC', operationId: 'voice-tts' };
    const result = await ops.sendVoice(input, options, 91001);
    expect(result.status).toBe('sent');
    expect(syntheses.map(call => call.text)).toEqual([input.text.trim()]);
    expect(fs.existsSync(syntheses[0]!.file)).toBe(false);
    expect(fs.existsSync(path.dirname(syntheses[0]!.file))).toBe(false);
    expect(native.records).toHaveLength(1);
    expect(native.records[0]?.['contentType']).toBe(2);
    expect(await ops.sendVoice(input, options, 91001)).toEqual(result);
    expect(syntheses).toHaveLength(1);
    expect(native.codec.encodes).toBe(1);
  });

  it.each([
    { label: '正向私聊', config: { existingUserSessionId: 93003 } },
    { label: '反向私聊', config: { reverseUserSession: true } },
  ])('已有$label由原生复用；显式会话不查工号', async ({ config }) => {
    const native = voiceRuntime(config);
    const ops = new BridgeMessageOps(native.cdp);
    expect(await ops.sendVoice(native.input, { targetLoginName: '00AbC' }, 91001)).toMatchObject({
      status: 'sent',
      sessionId: '93003',
    });
    expect(native.sessions).toHaveLength(3);
    const searches = native.ipc.sent.filter(request => request.args[0] === 'unionSearch').length;
    expect(await ops.sendVoice(native.input, { targetSessionId: '93001' }, 91001)).toMatchObject({
      status: 'sent',
    });
    expect(native.drafts[1]).toMatchObject({ sessionID: 93001, contentType: 2, receiver: 91002 });
    expect(native.ipc.sent.filter(request => request.args[0] === 'unionSearch')).toHaveLength(
      searches
    );
  });

  it.each([
    { label: '错误大小写', config: { searchUsers: [users[1]!] } },
    { label: '缺少前导零或仅显示名匹配', config: { searchUsers: [users[0]!] } },
    {
      label: '工号歧义',
      config: { searchUsers: [users[2]!, { id: 91006, login_name: '00AbC', name: '另一员工' }] },
    },
    { label: '档案工号不符', config: { targetProfile: { id: 91003, login_name: '00abc' } } },
    { label: '档案UID不符', config: { targetProfile: { id: 91004, login_name: '00AbC' } } },
    { label: '本人', config: { searchUsers: [{ id: 91001, login_name: '00AbC', name: '本人' }] } },
    { label: '权限禁止', config: { permissionDenied: true } },
    { label: '搜索失败', config: { searchCode: 627 } },
  ])('$label在草稿前拒绝', async ({ config }) => {
    const native = voiceRuntime(config);
    expect(
      await new BridgeMessageOps(native.cdp).sendVoice(
        native.input,
        { targetLoginName: '00AbC' },
        91001
      )
    ).toMatchObject({ status: 'failed', isPreTrigger: true });
    expectNoSubmission(native);
  });

  it('无效目标或缺少连接绑定UID在准备前拒绝，不能采用当前账号', async () => {
    const native = voiceRuntime();
    const ops = new BridgeMessageOps(native.cdp);
    const targets: SendOptions[] = [
      {},
      { targetLoginName: '' },
      { targetLoginName: ' ' },
      { targetLoginName: '00AbC', targetSessionId: '93001' },
      { targetLoginName: '00AbC', targetSessionId: '' },
    ];
    for (const target of targets)
      expect(await ops.sendVoice(native.input, target, 91001)).toMatchObject({
        status: 'failed',
        isPreTrigger: true,
      });
    for (const uid of [undefined, 0, ''])
      expect(await ops.sendVoice(native.input, { targetLoginName: '00AbC' }, uid)).toMatchObject({
        status: 'failed',
        isPreTrigger: true,
        error: expect.stringContaining('UID'),
      });
    expect(native.codec.encodes).toBe(0);
    expect(native.ipc.sent).toEqual([]);
    expectNoSubmission(native);
  });

  it.each([
    { label: '没有业务回执', config: { callback: false }, status: 'unknown' },
    { label: '错接收者', config: { mismatchedReceiver: true }, status: 'unknown' },
    { label: '错发送者', config: { mismatchedSender: true }, status: 'unknown' },
    { label: '错负草稿', config: { mismatchedDraft: true }, status: 'unknown' },
    { label: '错正式会话', config: { mismatchedSession: true }, status: 'unknown' },
    { label: '正式会话为空', config: { receiptSessionId: 0 }, status: 'unknown' },
    { label: '业务失败正ID', config: { businessCode: 617 }, status: 'failed' },
  ])('$label不确认成功，查询及重放不再编码提交', async ({ config, status }) => {
    vi.useFakeTimers();
    const native = voiceRuntime(config);
    const gate = holdNativeRequest(native.ipc, 'sendMessageNew');
    const store = new InMemorySendOperationStore();
    const ops = new BridgeMessageOps(native.cdp, store);
    const options = { targetLoginName: '00AbC', operationId: 'voice-receipt', verifyTimeoutMs: 50 };
    const pending = ops.sendVoice(native.input, options, 91001);
    await gate.started;
    // 首次提交仍在等待时，重复意图只能读取 unknown；最终回执由后续查询取得。
    const concurrent = await ops.sendVoice(native.input, options, 91001);
    expect(concurrent).toMatchObject({ status: 'unknown', operationId: options.operationId });
    gate.release();
    await vi.runAllTimersAsync();
    const result = await pending;
    expect(result).toMatchObject({ status, isPreTrigger: false });
    if (status === 'failed') expect(result.nativeCode).toBe(617);
    expect((await ops.getSendStatus(options.operationId)).status).toBe(status);
    expect((await ops.sendVoice(native.input, options, 91001)).status).toBe(status);
    expect(await store.get(options.operationId)).toMatchObject({ status });
    expect(native.codec.encodes).toBe(1);
    expect(native.drafts).toHaveLength(1);
    expect(native.records).toHaveLength(1);
    expect(native.ipc.listenerCount('0-91003-sendMsgCallback')).toBe(0);
    expect((native.window['__kairo_pending_sends'] as Map<string, unknown>).size).toBe(0);
  });

  it.each(['准备', '工号查询'] as const)('%s期间换号，恢复原账号也不重发', async phase => {
    const config: NativeConfig = { identity: 91001 };
    // 配置对象由原生替身读取，模拟实际 getMemberDetail 在等待期间改变。
    const native = voiceRuntime(config);
    const send = native.ipc.send.bind(native.ipc);
    native.ipc.send = (channel, request) => {
      if (phase === '工号查询' && request.args[0] === 'unionSearch') config.identity = 91999;
      send(channel, request);
    };
    if (phase === '准备')
      native.codec.onEncode = () => {
        config.identity = 91999;
      };
    const ops = new BridgeMessageOps(native.cdp);
    const options = { targetLoginName: '00AbC', operationId: 'voice-switched' };
    const result = await ops.sendVoice(native.input, options, 91001);
    expect(result).toMatchObject({
      status: 'failed',
      isPreTrigger: true,
      error: expect.stringMatching(/UID|身份/),
    });
    expectNoSubmission(native);
    config.identity = 91001;
    expect(await ops.sendVoice(native.input, options, 91001)).toEqual(result);
    expect(native.codec.encodes).toBe(1);
  });

  it.each(['准备', '工号查询'] as const)('%s期间取消不创建草稿或提交', async phase => {
    const native = voiceRuntime();
    const ops = new BridgeMessageOps(native.cdp);
    if (phase === '准备')
      native.codec.onEncode = () => {
        void ops.cancelPendingSends();
      };
    const gate = phase === '工号查询' ? holdNativeRequest(native.ipc, 'unionSearch') : undefined;
    const pending = ops.sendVoice(native.input, { targetLoginName: '00AbC' }, 91001);
    if (gate) {
      await gate.started;
      const cancelling = ops.cancelPendingSends();
      gate.release();
      await cancelling;
    }
    expect(await pending).toMatchObject({ status: 'failed', isPreTrigger: true });
    expectNoSubmission(native);
  });

  it('提交后取消保持 unknown 且释放监听，不重发', async () => {
    const native = voiceRuntime({ callback: false });
    const ops = new BridgeMessageOps(native.cdp);
    const gate = holdNativeRequest(native.ipc, 'sendMessageNew');
    const options = { targetLoginName: '00AbC', operationId: 'voice-cancel-submitted' };
    const pending = ops.sendVoice(native.input, options, 91001);
    await gate.started;
    gate.release();
    await ops.cancelPendingSends();
    const result = await pending;
    expect(result).toMatchObject({ status: 'unknown', isPreTrigger: false });
    expect(await ops.sendVoice(native.input, options, 91001)).toEqual(result);
    expect(native.codec.encodes).toBe(1);
    expect(native.records).toHaveLength(1);
    expect(native.ipc.listenerCount('0-91003-sendMsgCallback')).toBe(0);
    expect((native.window['__kairo_pending_sends'] as Map<string, unknown>).size).toBe(0);
  });
});

describe('公开 Driver 连接绑定身份与正式语音撤回', () => {
  it.each([
    { label: '工号', target: { targetLoginName: '00AbC' }, switchAccount: false },
    { label: '工号', target: { targetLoginName: '00AbC' }, switchAccount: true },
    { label: '会话', target: { targetSessionId: '93001' }, switchAccount: false },
    { label: '会话', target: { targetSessionId: '93001' }, switchAccount: true },
  ])(
    '连接读取实际UID发送到$label；准备后换号=$switchAccount',
    async ({ target, switchAccount }) => {
      const config: NativeConfig = { identity: 91001 };
      const native = voiceRuntime(config);
      const driver = await connectDriver(native.cdp);
      try {
        expect(await driver.getCurrentUserId()).toBe('91001');
        if (switchAccount)
          native.codec.onEncode = () => {
            config.identity = 91999;
          };
        const options = { ...target, operationId: 'voice-public-identity' };
        const result = await driver.sendVoice(native.input, options);
        expect(result).toMatchObject({
          status: switchAccount ? 'failed' : 'sent',
          isPreTrigger: switchAccount,
        });
        expect(await driver.getCurrentUserId()).toBe(switchAccount ? '91999' : '91001');
        if (switchAccount) expectNoSubmission(native);
        else {
          expect(native.drafts).toHaveLength(1);
          expect(native.drafts[0]).toMatchObject({ sender: 91001, contentType: 2 });
          expect(native.records).toHaveLength(1);
        }
        config.identity = 91001;
        expect((await driver.sendVoice(native.input, options)).status).toBe(result.status);
        expect(native.codec.encodes).toBe(1);
      } finally {
        await driver.disconnect();
      }
    }
  );

  it('未登录连接不采用配置UID，在语音准备前失败', async () => {
    const native = voiceRuntime({ identity: null });
    const driver = await connectDriver(native.cdp, '91001');
    try {
      expect(await driver.getCurrentUserId()).toBeNull();
      expect(await driver.sendVoice(native.input, { targetLoginName: '00AbC' })).toMatchObject({
        status: 'failed',
        isPreTrigger: true,
        error: expect.stringContaining('UID'),
      });
      expect(native.codec.encodes).toBe(0);
      expectNoSubmission(native);
    } finally {
      await driver.disconnect();
    }
  });

  it('工号模式在等待期间固定，快捷撤回使用首次正式会话而非草稿0或后来选项', async () => {
    const native = voiceRuntime();
    const driver = await connectDriver(native.cdp);
    try {
      const gate = holdNativeRequest(native.ipc, 'sendMessageNew');
      const recalled: KK9RecalledEvent[] = [];
      driver.on('recalled', event => recalled.push(event));
      const options: SendOptions = { targetLoginName: '00AbC', operationId: 'voice-recall' };
      const pending = driver.sendVoice(native.input, options);
      await gate.started;
      options.targetLoginName = undefined;
      options.targetSessionId = '93002';
      gate.release();
      const result = await pending;
      expect(result).toMatchObject({
        status: 'sent',
        sessionId: '94001',
        receipt: { sessionId: '94001' },
      });
      expect(native.drafts[0]).toMatchObject({ sessionID: 0, sender: 91001 });
      if (!result.recall) throw new Error('已确认语音缺少快捷撤回');
      expect(await result.recall()).toBe(true);
      expect(native.records[0]?.['msgFlag']).toBe('C');
      expect(
        native.ipc.sent
          .filter(request => request.args[0] === 'cancelMessage')
          .map(request => request.args[1])
      ).toMatchObject([{ sessionID: 94001, msgID: 135700000, msgIdx: 1 }]);
      expect(recalled).toMatchObject([
        { sessionId: '94001', messageId: '135700000', sender: '91001' },
      ]);
    } finally {
      await driver.disconnect();
    }
  });
});
