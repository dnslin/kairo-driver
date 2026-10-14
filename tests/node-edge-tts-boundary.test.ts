import { EventEmitter, once } from 'node:events';
import fs, { type WriteStream } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import net, { createServer, type Server, type Socket } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import tls, { type ConnectionOptions } from 'node:tls';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EdgeTTS } from 'node-edge-tts';
import { WebSocketServer, type WebSocket } from 'ws';
import { prepareVoice } from '../src/bridge/voice-ops.js';
import type { CdpClient } from '../src/cdp/client.js';

class FakeWebSocket extends EventEmitter {
  public readyState = 1;
  public readonly sent: string[] = [];
  public terminateCalls = 0;

  public send(data: string, optionsOrCallback?: unknown, callback?: (error?: Error) => void): void {
    this.sent.push(data);
    const done = typeof optionsOrCallback === 'function' ? optionsOrCallback : callback;
    (done as ((error?: Error) => void) | undefined)?.();
  }

  public terminate(): void {
    this.terminateCalls += 1;
    if (this.readyState === 3) return;
    this.readyState = 2;
    globalThis.queueMicrotask(() => this.closeFromPeer(1006));
  }

  public emitAudio(data: Uint8Array): void {
    this.emit('message', Buffer.concat([Buffer.from('Path:audio\r\n'), data]), true);
  }

  public emitText(message: string): void {
    this.emit('message', Buffer.from(message), false);
  }

  public closeFromPeer(code: number, reason = ''): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit('close', code, Buffer.from(reason));
  }
}

const tempDirectories: string[] = [];

async function createTempDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kairo-edge-tts-test-'));
  tempDirectories.push(directory);
  return directory;
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('测试服务未获得 TCP 端口');
  return address.port;
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close(error => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function createRejectingProxy(): { server: Server; requests: string[]; sockets: Set<Socket> } {
  const requests: string[] = [];
  const sockets = new Set<Socket>();
  const server = createHttpServer((_request, response) => {
    response.writeHead(502);
    response.end();
  });
  server.on('connection', socket => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  server.on('connect', (request, socket) => {
    requests.push(request.url ?? '');
    socket.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
  });
  return { server, requests, sockets };
}

function guardVoiceNetwork(allowedPorts: number[]): string[] {
  const blockedConnections: string[] = [];
  const connect = net.connect;
  vi.spyOn(net, 'connect').mockImplementation((...args) => {
    const options = args[0] as { host?: string; port?: number };
    if (options.host !== '127.0.0.1' || !allowedPorts.includes(Number(options.port))) {
      blockedConnections.push('TCP');
      throw new Error('测试禁止直接连接外网');
    }
    return connect(...args);
  });
  vi.spyOn(tls, 'connect').mockImplementation(() => {
    blockedConnections.push('TLS');
    throw new Error('测试禁止直接连接外网');
  });
  return blockedConnections;
}

function useFakeConnection(tts: EdgeTTS, socket: FakeWebSocket): WriteStream[] {
  vi.spyOn(tts, '_connectWebSocket').mockResolvedValue(socket as unknown as WebSocket);
  const streams: WriteStream[] = [];
  const createWriteStream = fs.createWriteStream;
  vi.spyOn(fs, 'createWriteStream').mockImplementation((...args) => {
    const stream = createWriteStream(...args);
    streams.push(stream);
    return stream;
  });
  return streams;
}

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(
    tempDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))
  );
});

describe('node-edge-tts 依赖边界', () => {
  it('使用新服务地址与订阅键完成真实 WebSocket 合成，不覆盖为旧 Host', async () => {
    const server = createHttpServer();
    const sockets = new Set<Socket>();
    server.on('connection', socket => {
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
    });
    const requests: Array<{ host: string | undefined; url: URL }> = [];
    const websocketServer = new WebSocketServer({
      server,
      verifyClient(info) {
        const url = new URL(info.req.url, 'https://api.msedgeservices.com');
        requests.push({ host: info.req.headers.host, url });
        return (
          info.req.headers.host === 'api.msedgeservices.com' &&
          url.pathname === '/tts/cognitiveservices/websocket/v1' &&
          url.searchParams.has('Ocp-Apim-Subscription-Key') &&
          !url.searchParams.has('TrustedClientToken')
        );
      },
    });
    const audio = await readFile(new URL('./fixtures/voice.mp3', import.meta.url));
    websocketServer.on('connection', socket => {
      socket.on('message', data => {
        const bytes = Array.isArray(data)
          ? Buffer.concat(data)
          : data instanceof ArrayBuffer
            ? Buffer.from(data)
            : data;
        if (!bytes.toString('utf8').includes('Path:ssml')) return;
        socket.send(Buffer.concat([Buffer.from('Path:audio\r\n'), audio]));
        socket.send('Path:turn.end');
      });
    });
    const port = await listen(server);
    vi.spyOn(tls, 'connect').mockImplementation(() => net.connect(port, '127.0.0.1'));
    const outputPath = path.join(await createTempDirectory(), 'new-endpoint.mp3');
    try {
      await new EdgeTTS({ timeout: 1000 }).ttsPromise('新协议端点验证', outputPath);
      expect(await readFile(outputPath)).toEqual(audio);
      expect(requests).toHaveLength(1);
      expect(requests[0]!.url.searchParams.get('Sec-MS-GEC')).toBeTruthy();
      expect(requests[0]!.url.searchParams.get('Sec-MS-GEC-Version')).toBeTruthy();
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>(resolve => websocketServer.close(() => resolve()));
      await closeServer(server);
    }
  });

  it('连接握手挂起时按 deadline 终止真实 WebSocket 底层连接', async () => {
    let markAccepted = (_socket: Socket): void => {};
    const accepted = new Promise<Socket>(resolve => {
      markAccepted = resolve;
    });
    let serverSocket: Socket | undefined;
    const server = createServer(socket => {
      serverSocket = socket;
      socket.resume();
      markAccepted(socket);
    });
    const port = await listen(server);
    const connect = tls.connect;
    vi.spyOn(tls, 'connect').mockImplementation((...args) =>
      connect({ ...(args[0] as ConnectionOptions), host: '127.0.0.1', port })
    );
    const outputPath = path.join(await createTempDirectory(), 'handshake-timeout.mp3');

    try {
      // 这里必须使用真实时钟，才能覆盖 ws 与 TCP 握手资源的真实 deadline。
      const tts = new EdgeTTS({ timeout: 100 });
      const connection = tts.ttsPromise('握手超时', outputPath).then(
        () => ({ error: undefined }),
        error => ({ error })
      );
      const socket = await accepted;
      const result = await connection;

      expect(result.error).toBeInstanceOf(Error);
      expect((result.error as Error).message).toBe('Timed out');
      if (!socket.destroyed) await once(socket, 'close');
      expect(socket.destroyed).toBe(true);
    } finally {
      serverSocket?.destroy();
      await closeServer(server);
    }
  });

  it('代理 CONNECT 挂起时超时必须关闭代理 TCP 连接', async () => {
    let markAccepted = (_socket: Socket): void => {};
    const accepted = new Promise<Socket>(resolve => {
      markAccepted = resolve;
    });
    let serverSocket: Socket | undefined;
    const server = createServer(socket => {
      serverSocket = socket;
      socket.resume();
      markAccepted(socket);
    });
    const port = await listen(server);
    guardVoiceNetwork([port]);
    const outputPath = path.join(await createTempDirectory(), 'proxy-timeout.mp3');
    try {
      const tts = new EdgeTTS({ proxy: `http://127.0.0.1:${port}`, timeout: 100 });
      const pending = tts.ttsPromise('代理握手超时', outputPath).then(
        () => ({ error: undefined }),
        error => ({ error })
      );
      const socket = await accepted;
      const result = await pending;
      expect(result.error).toBeInstanceOf(Error);
      expect((result.error as Error).message).toBe('Timed out');
      await vi.waitFor(() => expect(socket.destroyed).toBe(true), { timeout: 500 });
    } finally {
      serverSocket?.destroy();
      await closeServer(server);
    }
  });

  it('合成阶段挂起时关闭文件流和 WebSocket 后返回超时错误', async () => {
    const directory = await createTempDirectory();
    const outputPath = path.join(directory, 'timeout.mp3');
    const socket = new FakeWebSocket();
    const tts = new EdgeTTS({ timeout: 50 });
    const streams = useFakeConnection(tts, socket);

    await expect(tts.ttsPromise('超时测试', outputPath)).rejects.toThrow('Timed out');

    expect(socket.terminateCalls).toBe(1);
    expect(socket.listenerCount('message')).toBe(0);
    expect(streams[0]?.closed).toBe(true);
  });

  it('文件流写入错误进入 Promise 拒绝并关闭 WebSocket', async () => {
    const directory = await createTempDirectory();
    const outputPath = path.join(directory, 'missing', 'stream-error.mp3');
    const socket = new FakeWebSocket();
    const tts = new EdgeTTS({ timeout: 1000 });
    const streams = useFakeConnection(tts, socket);

    await expect(tts.ttsPromise('文件错误', outputPath)).rejects.toMatchObject({ code: 'ENOENT' });

    expect(socket.terminateCalls).toBe(1);
    expect(socket.listenerCount('message')).toBe(0);
    expect(streams[0]?.closed).toBe(true);
  });

  it('异常 close 会结束合成并关闭仍打开的文件流', async () => {
    const directory = await createTempDirectory();
    const outputPath = path.join(directory, 'closed.mp3');
    const socket = new FakeWebSocket();
    const tts = new EdgeTTS({ timeout: 1000 });
    const streams = useFakeConnection(tts, socket);

    const pending = tts.ttsPromise('连接断开', outputPath);
    await vi.waitFor(() => expect(socket.sent).toHaveLength(1));
    socket.closeFromPeer(1006, 'abnormal');

    await expect(pending).rejects.toThrow(/1006.*abnormal/);
    expect(socket.listenerCount('message')).toBe(0);
    expect(streams[0]?.closed).toBe(true);
  });

  it('正常 turn.end 会刷盘并关闭资源，晚到音频不会继续写入', async () => {
    const directory = await createTempDirectory();
    const outputPath = path.join(directory, 'complete.mp3');
    const socket = new FakeWebSocket();
    const tts = new EdgeTTS({ timeout: 1000 });
    const streams = useFakeConnection(tts, socket);
    const audio = Buffer.from('complete audio');

    const pending = tts.ttsPromise('正常完成', outputPath);
    await vi.waitFor(() => expect(socket.sent).toHaveLength(1));
    socket.emitAudio(audio);
    socket.emitText('Path:turn.end');
    await pending;

    expect(await readFile(outputPath)).toEqual(audio);
    expect(socket.terminateCalls).toBe(1);
    expect(socket.listenerCount('message')).toBe(0);
    expect(streams[0]?.closed).toBe(true);
    socket.emitAudio(Buffer.from('late audio'));

    expect(await readFile(outputPath)).toEqual(audio);
  });
});

describe('prepareVoice 文本合成代理路由', () => {
  it.each([
    ['HTTPS_PROXY 优先于 HTTP_PROXY，且忽略首尾空白', 'selected', 'secondary'],
    ['未设置 HTTPS_PROXY 时使用 HTTP_PROXY', undefined, 'selected'],
    ['HTTPS_PROXY 为空白时使用 HTTP_PROXY', 'blank', 'selected'],
  ])('%s：真实 CONNECT 拒绝保留失败原因且不直连', async (_name, httpsValue, httpValue) => {
    const selected = createRejectingProxy();
    const secondary = createRejectingProxy();
    try {
      const selectedPort = await listen(selected.server);
      const secondaryPort = await listen(secondary.server);
      const values: Record<string, string> = {
        selected: `  http://127.0.0.1:${selectedPort}  `,
        secondary: `http://127.0.0.1:${secondaryPort}`,
        blank: ' \t ',
      };
      vi.stubEnv('HTTPS_PROXY', httpsValue ? values[httpsValue] : undefined);
      vi.stubEnv('HTTP_PROXY', httpValue ? values[httpValue] : undefined);
      const blockedConnections = guardVoiceNetwork([selectedPort, secondaryPort]);
      const cdp = { evaluate: vi.fn() } as unknown as CdpClient;

      await expect(prepareVoice(cdp, { text: '代理拒绝测试' })).rejects.toMatchObject({
        code: 'VOICE_TTS_FAILED',
        message: expect.stringContaining('502'),
        originalCause: { message: expect.stringContaining('502') },
      });

      expect(selected.requests).toEqual(['api.msedgeservices.com:443']);
      expect(secondary.requests).toEqual([]);
      expect(blockedConnections).toEqual([]);
      expect(cdp.evaluate).not.toHaveBeenCalled();
    } finally {
      for (const socket of [...selected.sockets, ...secondary.sockets]) socket.destroy();
      await Promise.all([closeServer(selected.server), closeServer(secondary.server)]);
    }
  });

  it.each([undefined, ' \t '])('两项代理均为 %j 时保留直连，不读取 ALL_PROXY', async value => {
    const ignored = createRejectingProxy();
    try {
      const port = await listen(ignored.server);
      vi.stubEnv('HTTPS_PROXY', value);
      vi.stubEnv('HTTP_PROXY', value);
      vi.stubEnv('ALL_PROXY', `http://127.0.0.1:${port}`);
      const blockedConnections = guardVoiceNetwork([port]);
      const cdp = { evaluate: vi.fn() } as unknown as CdpClient;

      // 在真实 TLS 边界阻止直连，既观察既有路线，也保证测试不会访问外网。
      await expect(prepareVoice(cdp, { text: '无代理测试' })).rejects.toMatchObject({
        code: 'VOICE_TTS_FAILED',
        originalCause: { message: '测试禁止直接连接外网' },
      });

      expect(blockedConnections).toEqual(['TLS']);
      expect(ignored.requests).toEqual([]);
      expect(cdp.evaluate).not.toHaveBeenCalled();
    } finally {
      for (const socket of ignored.sockets) socket.destroy();
      await closeServer(ignored.server);
    }
  });
});
