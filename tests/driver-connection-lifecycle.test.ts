import http from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import { WebSocketServer } from 'ws';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { KK9Driver } from '../src/driver.js';
import { CdpError } from '../src/utils/errors.js';
import { getDriverTestInternals } from './helpers/driver-internals.js';

async function createIdentityFailureServer() {
  let port = 0;
  let socketClosed = false;
  let heartbeatCount = 0;
  const firstHeartbeat = Promise.withResolvers<void>();
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json', Connection: 'close' });
    response.end(
      JSON.stringify([
        {
          id: '本地身份读取目标',
          type: 'page',
          title: '离线连接清理',
          url: 'file:///renderer.html',
          webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/local`,
        },
      ])
    );
  });
  const wss = new WebSocketServer({ server });
  wss.on('connection', socket => {
    socket.on('close', () => {
      socketClosed = true;
    });
    socket.on('message', data => {
      const payload = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data);
      const command = JSON.parse(payload.toString('utf8')) as {
        id: number;
        method: string;
        params?: { expression?: string };
      };
      if (command.method !== 'Runtime.evaluate') {
        socket.send(JSON.stringify({ id: command.id, result: {} }));
      } else if (command.params?.expression === '1') {
        heartbeatCount += 1;
        socket.send(
          JSON.stringify({ id: command.id, result: { result: { type: 'number', value: 1 } } })
        );
        firstHeartbeat.resolve();
      } else {
        // 先观察真实心跳，再使身份读取失败，避免用从未启动的计时器伪证停止。
        void firstHeartbeat.promise.then(() => {
          socket.send(
            JSON.stringify({
              id: command.id,
              result: {
                result: { type: 'undefined' },
                exceptionDetails: { text: '受控身份读取失败' },
              },
            })
          );
        });
      }
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('本地服务器缺少端口');
  port = address.port;
  return {
    url: `http://127.0.0.1:${port}`,
    isSocketClosed: () => socketClosed,
    getHeartbeatCount: () => heartbeatCount,
    async close() {
      for (const socket of wss.clients) socket.terminate();
      await new Promise<void>((resolve, reject) =>
        wss.close(error => (error ? reject(error) : resolve()))
      );
      await new Promise<void>((resolve, reject) =>
        server.close(error => (error ? reject(error) : resolve()))
      );
    },
  };
}

afterEach(() => vi.restoreAllMocks());

describe('KK9Driver 连接失败资源所有权', () => {
  it('身份读取异常后自动关闭真实socket并停止已启动心跳，无需调用方断开', async () => {
    const server = await createIdentityFailureServer();
    const driver = new KK9Driver({
      cdp: {
        url: server.url,
        pageMatch: 'renderer.html',
        heartbeatIntervalMs: 20,
        timeoutMs: 1000,
      },
    });
    let heartbeatEvents = 0;
    driver.on('heartbeat', () => {
      heartbeatEvents += 1;
    });
    try {
      await expect(driver.connect()).rejects.toThrow('受控身份读取失败');
      expect(driver.getStatus()).toBe('disconnected');
      await expect.poll(server.isSocketClosed, { timeout: 2000 }).toBe(true);
      expect(driver.getHealthSnapshot().cdpConnectionIdentity).toBeNull();
      expect(driver.getHealthSnapshot().eventBridgeAttached).toBe(false);
      const stoppedCount = server.getHeartbeatCount();
      const stoppedEvents = heartbeatEvents;
      expect(stoppedCount).toBeGreaterThan(0);
      expect(stoppedEvents).toBeGreaterThan(0);
      await sleep(80);
      expect(server.getHeartbeatCount()).toBe(stoppedCount);
      expect(heartbeatEvents).toBe(stoppedEvents);
      await expect(driver.connect()).rejects.toThrow('禁止原地重连');
      const closing = driver.disconnect();
      expect(driver.disconnect()).toBe(closing);
      await closing;
    } finally {
      // 仅在断言完成或回归失败后兜底，不能代替待测路径的自动释放。
      await driver.disconnect();
      await server.close();
    }
  });

  it('身份读取与清理同时失败时保留两个原始原因，重复关闭仍报告清理失败', async () => {
    const driver = new KK9Driver({
      cdp: { url: 'http://127.0.0.1:9222', pageMatch: 'renderer.html' },
    });
    const { cdp } = getDriverTestInternals(driver);
    const identityError = new CdpError('身份读取失败');
    const cleanupError = new Error('底层关闭失败');
    vi.spyOn(cdp, 'connect').mockResolvedValue();
    vi.spyOn(driver, 'getCurrentUserId').mockRejectedValue(identityError);
    vi.spyOn(cdp, 'disconnect').mockRejectedValue(cleanupError);

    const failure: unknown = await driver.connect().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([identityError, cleanupError]);
    await expect(driver.connect()).rejects.toThrow('禁止原地重连');
    const closing = driver.disconnect();
    expect(driver.disconnect()).toBe(closing);
    await expect(closing).rejects.toBe(cleanupError);
  });

  it('Hook连接已聚合清理失败时不再次包装或重复追加同一原因', async () => {
    const driver = new KK9Driver({
      cdp: { url: 'http://127.0.0.1:9222', pageMatch: 'renderer.html' },
      currentUserId: '91001',
    });
    const { cdp } = getDriverTestInternals(driver);
    const hookError = new CdpError('Hook执行失败');
    const cleanupError = new Error('Hook失败后的底层关闭失败');
    vi.spyOn(cdp, 'connect').mockResolvedValue();
    vi.spyOn(cdp, 'getStatus').mockReturnValue('connected');
    vi.spyOn(driver, 'getCurrentUserId').mockResolvedValue('91001');
    vi.spyOn(cdp, 'sendCommand').mockResolvedValue({});
    vi.spyOn(cdp, 'evaluate').mockRejectedValueOnce(hookError).mockResolvedValue({ owned: true });
    vi.spyOn(cdp, 'disconnect').mockRejectedValue(cleanupError);

    const failure: unknown = await driver.connect().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([
      expect.objectContaining({ cause: hookError }),
      cleanupError,
    ]);
    await expect(driver.connect()).rejects.toThrow('禁止原地重连');
    await expect(driver.disconnect()).rejects.toBe(cleanupError);
  });
});
