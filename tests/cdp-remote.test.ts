import { once } from 'node:events';
import http from 'node:http';
import { WebSocketServer } from 'ws';
import { describe, expect, it, vi } from 'vitest';
import { CdpClient } from '../src/cdp/client.js';
import type { CdpConnectionLostEvent } from '../src/types/index.js';

// 发现服务和执行服务使用不同的本地随机端口，不依赖真实 KK9 或远程网络。
async function createDiscoveryServer() {
  const requests: string[] = [];
  const upgrades: string[] = [];
  const commands: Array<{ id: number; method: string; params?: { expression?: string } }> = [];
  let targetId = 'first-target';
  let targetType = 'page';
  let replyEnabled = true;
  let resolveCommand!: () => void;
  const receivedCommand = new Promise<void>(resolve => {
    resolveCommand = resolve;
  });
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(wss, 'listening');
  const wsAddress = wss.address();
  if (!wsAddress || typeof wsAddress === 'string') throw new Error('本地执行服务缺少端口');
  const wsUrl = () => `ws://127.0.0.1:${wsAddress.port}/devtools/page/${targetId}?source=discovery`;
  const targets = () => [
    {
      id: 'non-renderer',
      title: '非渲染目标',
      type: 'other',
      url: 'file:///renderer.html',
      webSocketDebuggerUrl: 'ws://127.0.0.1:1/不应连接',
    },
    {
      id: targetId,
      title: '隔离渲染目标',
      type: targetType,
      url: 'file:///app/renderer.html',
      webSocketDebuggerUrl: wsUrl(),
    },
  ];
  wss.on('connection', (socket, request) => {
    upgrades.push(request.url ?? '');
    socket.on('message', data => {
      const bytes = Array.isArray(data)
        ? Buffer.concat(data)
        : Buffer.isBuffer(data)
          ? data
          : Buffer.from(data);
      const text = bytes.toString('utf8');
      const command = JSON.parse(text) as (typeof commands)[number];
      commands.push(command);
      resolveCommand();
      if (replyEnabled) {
        socket.send(
          JSON.stringify({
            id: command.id,
            result: { result: { type: 'number', value: 2 } },
          })
        );
      }
    });
  });
  const server = http.createServer((request, response) => {
    requests.push(request.url ?? '');
    if (request.url !== '/json' && request.url !== '/cdp/json') {
      response.writeHead(404);
      response.end();
      return;
    }
    response.writeHead(200, { 'Content-Type': 'application/json', Connection: 'close' });
    response.end(JSON.stringify(targets()));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('本地发现服务缺少端口');
  return {
    url: `http://127.0.0.1:${address.port}`,
    wsUrl,
    targets,
    requests,
    upgrades,
    commands,
    receivedCommand,
    setTarget(id: string, type = 'page') {
      targetId = id;
      targetType = type;
    },
    suspendReplies() {
      replyEnabled = false;
    },
    resumeReplies() {
      replyEnabled = true;
    },
    terminateConnections() {
      for (const socket of wss.clients) socket.terminate();
    },
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

describe('CDP 远程发现与执行地址边界', () => {
  it.each([
    ['', '/json', 'page'],
    ['///', '/json', 'webview'],
    ['/cdp///', '/cdp/json', 'app'],
  ])('HTTP 基址后缀 %s 保留发现路径，并原样连接发现的独立执行地址', async (suffix, path, type) => {
    const server = await createDiscoveryServer();
    server.setTarget('http-target', type);
    const client = new CdpClient({
      url: `${server.url}${suffix}`,
      pageMatch: 'renderer.html',
      heartbeatIntervalMs: 60_000,
    });
    try {
      await client.connect();
      await expect(client.evaluate('1+1')).resolves.toBe(2);
      expect(server.requests).toEqual([path]);
      expect(server.upgrades).toEqual(['/devtools/page/http-target?source=discovery']);
      expect(client.getConnectionIdentity()).toMatchObject({
        targetId: 'http-target',
        webSocketDebuggerUrl: server.wsUrl(),
      });
      expect(server.commands).toEqual([
        expect.objectContaining({
          method: 'Runtime.evaluate',
          params: { expression: '1+1', returnByValue: true, awaitPromise: true },
        }),
      ]);
    } finally {
      await client.disconnect();
      await server.close();
    }
  });

  it('HTTPS 基址不降级、不改主机端口，也不把发现的 ws 地址推断成 wss', async () => {
    const server = await createDiscoveryServer();
    // 只替代 HTTPS 发现传输以隔离证书部署；后续 WebSocket 握手和求值走真实本地服务。
    const discovery = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(server.targets()), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );
    const client = new CdpClient({
      url: 'https://remote.example:9443/cdp///',
      pageMatch: 'renderer.html',
      heartbeatIntervalMs: 60_000,
    });
    try {
      await client.connect();
      await expect(client.evaluate('1+1')).resolves.toBe(2);
      expect(discovery).toHaveBeenCalledTimes(1);
      expect(discovery).toHaveBeenCalledWith('https://remote.example:9443/cdp/json', {
        signal: expect.any(AbortSignal),
      });
      expect(server.requests).toEqual([]);
      expect(server.upgrades).toEqual(['/devtools/page/first-target?source=discovery']);
      expect(client.getConnectionIdentity()?.webSocketDebuggerUrl).toBe(server.wsUrl());
    } finally {
      discovery.mockRestore();
      await client.disconnect();
      await server.close();
    }
  });

  it('HTTPS 发现传输失败时保留原因，不尝试 HTTP 或本机地址回退', async () => {
    const failure = new Error('受控 TLS 信任失败');
    const discovery = vi.spyOn(globalThis, 'fetch').mockRejectedValue(failure);
    const client = new CdpClient({
      url: 'https://remote.example:9443',
      pageMatch: 'renderer.html',
    });
    try {
      await expect(client.connect()).rejects.toThrow('受控 TLS 信任失败');
      expect(discovery).toHaveBeenCalledTimes(1);
      expect(discovery).toHaveBeenCalledWith('https://remote.example:9443/json', {
        signal: expect.any(AbortSignal),
      });
      expect(client.getStatus()).toBe('disconnected');
      expect(client.getConnectionIdentity()).toBeNull();
    } finally {
      discovery.mockRestore();
      await client.disconnect();
    }
  });

  it('失联结算旧请求，新实例重新发现当前目标且不重发旧请求', async () => {
    const server = await createDiscoveryServer();
    const config = { url: server.url, pageMatch: 'renderer.html', heartbeatIntervalMs: 60_000 };
    const first = new CdpClient(config);
    const replacement = new CdpClient(config);
    try {
      await first.connect();
      const identity = first.getConnectionIdentity();
      const lost = new Promise<CdpConnectionLostEvent>(resolve => {
        first.once('connection_lost', resolve);
      });
      server.suspendReplies();
      const pending = expect(first.evaluate('1+1')).rejects.toThrow('连接已断开');
      await server.receivedCommand;
      server.terminateConnections();
      const event = await lost;
      await pending;
      expect(event.connectionIdentity).toEqual(identity);
      expect(first.getStatus()).toBe('disconnected');
      expect(first.getConnectionIdentity()).toBeNull();
      expect(server.requests).toEqual(['/json']);

      server.setTarget('replacement-target');
      server.resumeReplies();
      await replacement.connect();
      await expect(replacement.evaluate('1+1')).resolves.toBe(2);
      expect(server.requests).toEqual(['/json', '/json']);
      expect(server.upgrades).toEqual([
        '/devtools/page/first-target?source=discovery',
        '/devtools/page/replacement-target?source=discovery',
      ]);
      expect(server.commands).toHaveLength(2);
      expect(replacement.getConnectionIdentity()).toMatchObject({
        targetId: 'replacement-target',
        webSocketDebuggerUrl: server.wsUrl(),
      });
      expect(replacement.getStartupGenerationId()).not.toBe(first.getStartupGenerationId());
      expect(replacement.getConnectionIdentity()?.connectionId).not.toBe(identity?.connectionId);
      expect(first.getStatus()).toBe('disconnected');
    } finally {
      await first.disconnect();
      await replacement.disconnect();
      await server.close();
    }
  });
});
