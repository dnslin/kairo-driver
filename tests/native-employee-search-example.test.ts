import EventEmitter from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { KK9EventBridge } from '../src/bridge/event-bridge.js';
import { BridgeOrgOps } from '../src/bridge/org-ops.js';
import { callIpcToData } from '../src/bridge/rpc.js';
import { CdpClient } from '../src/cdp/client.js';
import { FakeIpcRenderer, createRendererRuntime, runRendererScript } from './helpers/renderer-runtime.js';
import type { FakeIpcRequest, RendererRuntime } from './helpers/renderer-runtime.js';

interface Scenario {
  searchCode?: number;
  independentFailure?: boolean;
  cleanupFailure?: boolean;
  driverLost?: boolean;
  otherGeneration?: boolean;
  asyncCdpError?: boolean;
  login?: string;
  candidateUid?: string;
  forbiddenMethod?: boolean;
}

interface Evidence {
  通过: boolean;
  错误: Array<{ 阶段: string; 代码: string | number | null; 原因: string }>;
  搜索期间原生方法计数?: Record<string, number>;
  原生登录身份严格核对?: boolean;
  查询前基线?: unknown;
  退出后基线?: unknown;
  核对摘要?: { 包含指定候选: boolean };
}

interface ExampleResult {
  report: Evidence | undefined;
  ipc: FakeIpcRenderer & { eventNames(): string[] };
  window: Record<string, unknown>;
  originalSend: FakeIpcRenderer['send'];
  sessions: Array<{ id: number; type: number; typeID: number; maxMessageIndex: number; userReadIndex: number }>;
  renderer: RendererRuntime;
  unhandled: unknown[];
  driverDisconnects: number;
  independentDisconnects: number;
  otherResources: unknown[] | undefined;
  currentBridge: KK9EventBridge | undefined;
  exitCode: string | number | undefined;
}

async function runExample(scenario: Scenario = {}): Promise<ExampleResult> {
  vi.resetModules();
  const sessions = [{ id: 93001, type: 0, typeID: 91003, maxMessageIndex: 181, userReadIndex: 5 }];
  let heldReplyChannel: string | undefined;
  let releaseNativeReply: (() => void) | undefined;
  let lateEvaluation: Promise<unknown> | undefined;
  class SearchIpc extends FakeIpcRenderer {
    eventNames(): string[] {
      return ['message', ...this.sent.map(request => `data-${request.id}`), ...(heldReplyChannel ? [heldReplyChannel] : [])];
    }
  }
  const ipc = new SearchIpc(request => {
    switch (request.args[0]) {
      case 'getConversations': return { code: 0, data: { sessionsInfo: sessions } };
      case 'getMemberDetail':
        if (request.args[1] === undefined) return scenario.independentFailure
          ? { code: 633, error: '原生拒绝原因', message: '原生补充原因' }
          : { code: 0, data: { id: 91001, login_name: '原生账号' } };
        return { code: 0, data: { id: 91003, name: '候选员工', login_name: '00123' } };
      case 'unionSearch': return scenario.searchCode
        ? { code: scenario.searchCode, error: '原始人员搜索拒绝原因' }
        : { code: 0, data: { users: [{ id: 91003 }] } };
      case 'getAllDeptPaths': return { code: 0, data: [{ deptPaths: [{ name: '部门甲' }, { name: '部门乙' }] }] };
      case 'getSessionBySessionID': return { code: 0, data: sessions[0] };
      default: throw new Error('示例发出了未授权原生方法：' + String(request.args[0]));
    }
  });
  if (scenario.asyncCdpError) {
    const nativeSend = ipc.send;
    ipc.send = function(channel: string, request: FakeIpcRequest) {
      if (request.args[0] === 'unionSearch' && !releaseNativeReply) {
        heldReplyChannel = `data-${request.id}`;
        releaseNativeReply = () => { Reflect.apply(nativeSend, this, [channel, request]); };
        globalThis.queueMicrotask(() => emitIndependentError('独立CDP异步错误'));
        return;
      }
      Reflect.apply(nativeSend, this, [channel, request]);
    };
  }
  ipc.on('message', vi.fn());
  const originalSend = ipc.send;
  const renderer = createRendererRuntime({ ipc, sessions });
  const window = renderer.context['window'] as Record<string, unknown>;
  const config = { url: 'http://127.0.0.1:1', pageMatch: '人员专项离线回归' };
  const unhandled: unknown[] = [];
  let driverDisconnects = 0;
  let independentDisconnects = 0;
  let savedReport: Evidence | undefined;
  let currentBridge: KK9EventBridge | undefined;
  let otherResources: unknown[] | undefined;

  function createConnection(generationId: string) {
    const client = new CdpClient(config, { startupGenerationId: generationId });
    let connected = false;
    let notifyClosed!: (error: Error) => void;
    const closed = new Promise<Error>(resolve => { notifyClosed = resolve; });
    const lose = () => {
      connected = false;
      notifyClosed(new Error('仅Driver CDP失联或主动退出'));
    };
    vi.spyOn(client, 'connect').mockImplementation(() => { connected = true; return Promise.resolve(); });
    vi.spyOn(client, 'getStatus').mockImplementation(() => connected ? 'connected' : 'disconnected');
    vi.spyOn(client, 'getConnectionIdentity').mockImplementation(() => connected ? {
      startupGenerationId: generationId, connectionId: generationId + '-连接', targetId: '页面',
      webSocketDebuggerUrl: 'ws://127.0.0.1:1/离线', connectedAt: 1,
    } : null);
    vi.spyOn(client, 'evaluate').mockImplementation(async script => {
      if (!connected) throw new Error('仅Driver CDP失联');
      const evaluation = runRendererScript(script, renderer.context);
      if (scenario.asyncCdpError && generationId === '本代' && heldReplyChannel && !lateEvaluation) lateEvaluation = evaluation;
      return await Promise.race([evaluation, closed.then(error => { throw error; })]);
    });
    vi.spyOn(client, 'sendCommand').mockImplementation(method => {
      if (method === 'Runtime.addBinding') window['__kairo_native_bridge'] = vi.fn();
      return Promise.resolve({});
    });
    vi.spyOn(client, 'disconnect').mockImplementation(() => { lose(); return Promise.resolve(); });
    return { client, lose };
  }

  const own = createConnection('本代');
  const independent = createConnection('独立观察');
  function emitIndependentError(message: string) {
    // 真正的EventEmitter无监听时会抛错；只在测试边界捕获，避免污染Vitest进程。
    try { independent.client.emit('error', new Error(message)); }
    catch (error) {
      unhandled.push(error);
      own.lose();
    }
  }
  vi.spyOn(independent.client, 'disconnect').mockImplementation(async () => {
    independentDisconnects++;
    if (scenario.asyncCdpError) {
      globalThis.queueMicrotask(() => emitIndependentError('退出期间独立CDP异步错误'));
      await Promise.resolve();
    }
    independent.lose();
  });

  class ExampleDriver extends EventEmitter {
    private readonly bridge = new KK9EventBridge({ cdp: config, startupGenerationId: '本代', currentUserId: '91001', rejectExistingBridge: true }, own.client);
    getStartupGenerationId() { return '本代'; }
    getStatus() { return own.client.getStatus(); }
    async connect() { await this.bridge.connect(); }
    async disconnect() {
      driverDisconnects++;
      await this.bridge.disconnect();
    }
    async searchEmployees(keyword: string) {
      if (scenario.driverLost) {
        own.lose();
        if (scenario.otherGeneration) {
          const other = createConnection('其他代');
          currentBridge = new KK9EventBridge({ cdp: config, startupGenerationId: '其他代', currentUserId: '91001' }, other.client);
          await currentBridge.connect();
          otherResources = [window['__kairo_bridge_cleanup'], window['__kairo_native_send_observer'], window['__kairo_native_bridge']];
        }
        throw new Error('仅Driver CDP失联');
      }
      try {
        const result = await new BridgeOrgOps(own.client).searchEmployees(keyword);
        if (scenario.forbiddenMethod) ipc.send('data', { id: 999, args: ['getSessionBySessionID'] });
        return result;
      } finally {
        if (scenario.cleanupFailure) {
          const observedSend = ipc.send;
          ipc.send = function(...args) { return Reflect.apply(observedSend, this, args); };
        }
      }
    }
  }

  vi.doMock('@kairo/driver', () => ({ CdpClient: class { constructor() { return independent.client; } }, KK9Driver: ExampleDriver, callIpcToData }));
  vi.doMock('node:fs/promises', () => ({
    mkdir: vi.fn().mockResolvedValue(undefined),
    writeFile: vi.fn((_path: URL, content: string) => { savedReport = JSON.parse(content) as Evidence; return Promise.resolve(); }),
  }));
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const argv = process.argv;
  const exitCode = process.exitCode;
  process.argv = ['node', '人员专项', '91001', scenario.login ?? '原生账号', '候选', scenario.candidateUid ?? '91003'];
  process.exitCode = 0;
  try {
    // 顶层入口必须在每个场景的模块mock与argv就绪后加载，静态导入会提前执行。
    await import('../examples/verify-native-employee-search.js');
    // 出口完成后才放行真实renderer里的迟到原生回复；不能因此启动档案或部门后续查询。
    releaseNativeReply?.();
    await lateEvaluation;
    return { report: savedReport, ipc, window, originalSend, sessions, renderer, unhandled,
      driverDisconnects, independentDisconnects, otherResources, currentBridge, exitCode: process.exitCode };
  } finally {
    process.argv = argv;
    process.exitCode = exitCode;
  }
}

function assertExited(result: ExampleResult) {
  expect(result.report).toBeDefined();
  expect(result.driverDisconnects).toBe(1);
  expect(result.independentDisconnects).toBe(1);
  expect(result.window['__kairo_employee_search_probe']).toBeUndefined();
  expect(result.ipc.eventNames().filter(name => /^data-\d+$/.test(name)).every(name => result.ipc.listenerCount(name) === 0)).toBe(true);
}

describe('人员搜索专项实际入口的诊断与退出', () => {
  afterEach(() => {
    vi.doUnmock('@kairo/driver');
    vi.doUnmock('node:fs/promises');
    vi.restoreAllMocks();
  });

  it('成功仅只读搜索，身份、候选范围、会话窗口读索引与资源保持不变', async () => {
    const result = await runExample();
    assertExited(result);
    expect(result.report).toMatchObject({ 通过: true, 错误: [], 原生登录身份严格核对: true, 核对摘要: { 包含指定候选: true }, 搜索期间原生方法计数: { unionSearch: 1, getMemberDetail: 1, getAllDeptPaths: 1 } });
    expect(result.report?.退出后基线).toEqual(result.report?.查询前基线);
    expect(result.ipc.send).toBe(result.originalSend);
    expect(result.ipc.sent.every(request => ['getConversations', 'getMemberDetail', 'unionSearch', 'getAllDeptPaths'].includes(String(request.args[0])))).toBe(true);
    expect(result.renderer.events).toEqual([]);
    expect(result.renderer.commits).toEqual([]);
    expect(result.exitCode).toBe(0);
  });

  it('第一个原生搜索失败保留方法、页1、627及原始拒绝原因，不强求成功方法完整性', async () => {
    const result = await runExample({ searchCode: 627 });
    assertExited(result);
    expect(result.report?.通过).toBe(false);
    expect(result.report?.错误).toHaveLength(1);
    expect(result.report?.错误[0]?.原因).toMatch(/unionSearch.*页 1.*627.*原始人员搜索拒绝原因/);
    expect(result.ipc.send).toBe(result.originalSend);
    expect(result.ipc.sent.filter(request => request.args[0] === 'unionSearch')).toHaveLength(1);
  });

  it('独立原生查询非零保留方法、真实原生码以及error和message两个原因', async () => {
    const result = await runExample({ independentFailure: true });
    assertExited(result);
    expect(result.report?.错误[0]?.原因).toContain('getMemberDetail');
    expect(String(result.report?.错误[0]?.代码)).toBe('633');
    expect(result.report?.错误[0]?.原因).toContain('原生拒绝原因');
    expect(result.report?.错误[0]?.原因).toContain('原生补充原因');
    expect(result.ipc.sent.some(request => request.args[0] === 'unionSearch')).toBe(false);
  });

  it('搜索首错与观察器清理失败同时报告，不覆盖首错或继续独立搜索', async () => {
    const result = await runExample({ searchCode: 627, cleanupFailure: true });
    assertExited(result);
    const reasons = result.report?.错误.map(error => error.原因) ?? [];
    expect(reasons.some(reason => /unionSearch.*627.*原始人员搜索拒绝原因/.test(reason))).toBe(true);
    expect(reasons.some(reason => reason.includes('ipc.send被其他调用方修改'))).toBe(true);
    expect(result.ipc.sent.filter(request => request.args[0] === 'unionSearch')).toHaveLength(1);
  });

  it('Driver单连接失联时通过健康独立CDP清本代Hook、观察器及binding', async () => {
    const result = await runExample({ driverLost: true });
    assertExited(result);
    expect(result.report?.错误.some(error => error.原因.includes('仅Driver CDP失联'))).toBe(true);
    expect(result.window['__kairo_bridge_cleanup']).toBeUndefined();
    expect(result.window['__kairo_native_send_observer']).toBeUndefined();
    expect(result.window['__kairo_native_bridge']).toBeUndefined();
    expect(result.ipc.listenerCount('message')).toBe(1);
    expect(result.ipc.send).toBe(result.originalSend);
    expect(result.report?.退出后基线).toEqual(result.report?.查询前基线);
  });

  it('旧代退出不删除另一代已接管的Hook、观察器及binding', async () => {
    const result = await runExample({ driverLost: true, otherGeneration: true });
    try {
      assertExited(result);
      expect([result.window['__kairo_bridge_cleanup'], result.window['__kairo_native_send_observer'], result.window['__kairo_native_bridge']]).toEqual(result.otherResources);
      expect(result.ipc.listenerCount('message')).toBe(2);
    } finally { await result.currentBridge?.disconnect(); }
  });

  it('独立CDP异步error与退出期间error进入统一退出并生成报告，恢复探针且无迟到查询', async () => {
    const result = await runExample({ asyncCdpError: true });
    assertExited(result);
    expect(result.unhandled).toEqual([]);
    expect(result.report?.通过).toBe(false);
    expect(result.report?.错误.some(error => error.原因.includes('独立CDP异步错误'))).toBe(true);
    expect(result.report?.错误.some(error => error.原因.includes('退出期间独立CDP异步错误'))).toBe(true);
    expect(result.ipc.send).toBe(result.originalSend);
    expect(result.window['__kairo_bridge_cleanup']).toBeUndefined();
    expect(result.window['__kairo_native_send_observer']).toBeUndefined();
    expect(result.window['__kairo_native_bridge']).toBeUndefined();
    expect(result.ipc.sent.filter(request => request.args[0] === 'unionSearch')).toHaveLength(1);
    expect(result.ipc.sent.filter(request => request.args[0] === 'getMemberDetail')).toHaveLength(1);
    expect(result.ipc.sent.some(request => request.args[0] === 'getAllDeptPaths')).toBe(false);
  });

  it('身份不符时不能进入Driver人员搜索', async () => {
    const result = await runExample({ login: '其他账号' });
    assertExited(result);
    expect(result.report?.通过).toBe(false);
    expect(result.report?.错误.some(error => error.原因.includes('原生实际登录UID或login_name'))).toBe(true);
    expect(result.ipc.sent.some(request => request.args[0] === 'unionSearch')).toBe(false);
  });

  it('指定候选不在原生结果时不能宣称成功', async () => {
    const result = await runExample({ candidateUid: '91004' });
    assertExited(result);
    expect(result.report?.通过).toBe(false);
    expect(result.report?.错误.some(error => error.原因.includes('搜索结果不包含指定候选UID'))).toBe(true);
  });

  it('搜索期间出现非搜索data方法时不能宣称满足只读搜索白名单', async () => {
    const result = await runExample({ forbiddenMethod: true });
    assertExited(result);
    expect(result.report?.通过).toBe(false);
    expect(result.report?.错误.some(error => error.原因.includes('搜索出现白名单外data方法'))).toBe(true);
  });
});
