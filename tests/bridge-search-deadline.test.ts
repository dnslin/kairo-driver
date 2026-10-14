import http from 'node:http';
import { WebSocketServer } from 'ws';
import { describe, expect, it, vi } from 'vitest';
import { BridgeOrgOps } from '../src/bridge/org-ops.js';
import { CdpClient } from '../src/cdp/client.js';
import { FakeIpcRenderer, runRendererScript } from './helpers/renderer-runtime.js';

async function createStalledEvaluateServer(stalledMethod: string, elapsedPerResponse = 7) {
  let port = 0;
  let announceBlocked!: () => void;
  let rejectBlocked!: (error: unknown) => void;
  const blocked = new Promise<void>((resolve, reject) => {
    announceBlocked = resolve;
    rejectBlocked = reject;
  });
  const ipc = new FakeIpcRenderer(({ args: [method, uid] }) => {
    if (method !== stalledMethod) vi.setSystemTime(Date.now() + elapsedPerResponse);
    if (method === 'unionSearch') return { code: 0, data: { users: [{ id: 1 }] } };
    if (method === 'getMemberDetail') return { code: 0, data: { id: uid, name: '张三', login_name: '0001' } };
    if (method === 'getAllDeptPaths') return { code: 0, data: [] };
    throw new Error(`不得执行其他原生操作: ${String(method)}`);
  });
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json', Connection: 'close' });
    response.end(JSON.stringify([{
      id: '本地搜索目标', type: 'page', title: '人员搜索期限回归', url: 'file:///renderer.html',
      webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/search`,
    }]));
  });
  const wss = new WebSocketServer({ server });
  const evaluations: string[] = [];
  wss.on('connection', ws => {
    ws.on('message', data => {
      void (async () => {
        const bytes = Array.isArray(data) ? Buffer.concat(data) : data instanceof ArrayBuffer ? Buffer.from(data) : data;
        const message = JSON.parse(bytes.toString('utf8')) as {
          id: number; method: string; params: { expression: string };
        };
        if (message.method !== 'Runtime.evaluate') throw new Error('搜索只允许执行渲染查询');
        evaluations.push(message.params.expression);
        if (message.params.expression === '1') {
          ws.send(JSON.stringify({ id: message.id, result: { result: { type: 'number', value: 1 } } }));
          return;
        }
        const result = await runRendererScript(message.params.expression, {
          window: { ipcRenderer: ipc }, setTimeout, clearTimeout,
        });
        if (ipc.sent.at(-1)?.args[0] === stalledMethod) {
          // 网络保持在线，但故意不返回这次 Runtime.evaluate；不以 mock 回声代替客户端计时。
          announceBlocked();
          return;
        }
        ws.send(JSON.stringify({ id: message.id, result: { result: { type: 'object', value: result } } }));
      })().catch(rejectBlocked);
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('本地服务器缺少端口');
  port = address.port;
  return {
    url: `http://127.0.0.1:${port}`,
    blocked,
    ipc,
    evaluations,
    async close() {
      for (const socket of wss.clients) socket.terminate();
      await new Promise<void>((resolve, reject) => wss.close(error => error ? reject(error) : resolve()));
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    },
  };
}

describe('人员搜索真实CDP等待期限', () => {
  it.each([
    ['unionSearch', 30, 30, ['unionSearch'], /unionSearch.*页 1.*Runtime\.evaluate.*超时/],
    ['getMemberDetail', 30, 23, ['unionSearch', 'getMemberDetail'], /getMemberDetail.*UID 1.*Runtime\.evaluate.*超时/],
    ['getAllDeptPaths', 30, 16, ['unionSearch', 'getMemberDetail', 'getAllDeptPaths'], /getAllDeptPaths.*UID 1.*Runtime\.evaluate.*超时/],
    ['unionSearch', 10000, 5000, ['unionSearch'], /unionSearch.*页 1.*Runtime\.evaluate.*超时/],
  ] as const)('%s在总预算%s毫秒内不回应时按剩余预算或单次上限结算', async (method, totalBudget, waitBudget, methods, errorPattern) => {
    const server = await createStalledEvaluateServer(method);
    const client = new CdpClient({ url: server.url, pageMatch: 'renderer.html', heartbeatIntervalMs: 100_000 });
    try {
      await client.connect();
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
      vi.setSystemTime(1000);
      let outcome: unknown;
      const operation = new BridgeOrgOps(client).searchEmployees('张三', totalBudget).then(
        result => { outcome = result; },
        error => { outcome = error; }
      );
      // 必须先确认真实网络收到挂起请求，再推进假时钟，避免网络调度与定时器竞争。
      await server.blocked;
      await vi.advanceTimersByTimeAsync(waitBudget - 1);
      expect(outcome).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1);
      expect(outcome).toBeInstanceOf(Error);
      expect(outcome).toMatchObject({
        code: 'IPC_QUERY_FAILED', message: expect.stringMatching(errorPattern),
        originalCause: {
          code: 'IPC_RPC_FAILED',
          originalCause: { code: 'CDP_ERROR', message: expect.stringContaining(`超时=${waitBudget}ms`) },
        },
      });
      await operation;
      expect(server.ipc.sent.map(request => request.args[0])).toEqual(methods);
      expect(server.evaluations).toHaveLength(methods.length);
      expect(vi.getTimerCount()).toBe(0);
      expect(client.getStatus()).toBe('connected');
      await vi.advanceTimersByTimeAsync(1000);
      expect(server.ipc.sent.map(request => request.args[0])).toEqual(methods);
      expect(server.evaluations).toHaveLength(methods.length);
      await expect(client.evaluate('1')).resolves.toBe(1);
    } finally {
      await client.disconnect();
      vi.useRealTimers();
      await server.close();
    }
  });
});
