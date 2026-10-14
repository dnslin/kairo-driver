import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BridgeMessageOps } from '../src/bridge/message-ops.js';
import { FakeKK9Driver } from '../src/fake-driver.js';
import { InMemorySendOperationStore } from '../src/send-operation.js';
import type { SendOptions } from '../src/types/index.js';
import { createNativeSendRuntime } from './helpers/native-send-runtime.js';

const require = createRequire(import.meta.url);
const imageBytes = fs.readFileSync(new URL('./fixtures/t07-image.png', import.meta.url));
const thumbnailBytes = fs.readFileSync(new URL('./fixtures/t07-thumb.png', import.meta.url));
const roots: string[] = [];
type NativeConfig = NonNullable<Parameters<typeof createNativeSendRuntime>[0]>;
type FileLease = {
  path: string;
  directory: string;
  holders: number;
  readers: number;
  releaseRequested: boolean;
};
type ImageNode = {
  filepath: string;
  filepath_h: string;
  width: number;
  height: number;
  size: number;
  mimetype: string;
};
type NativeMedia = {
  contentType: number;
  content: { filepath?: string; content?: ImageNode[] };
};

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => {
    resolve = done;
  });
  return { promise, resolve };
}

function mediaRuntime(
  kind: 'image' | 'file',
  config: NativeConfig & { corruptArtwork?: boolean } = {}
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kairo-user-media-'));
  roots.push(root);
  const sourceRoot = path.join(root, 'driver');
  const remoteRoot = path.join(root, 'kk-transfer');
  const cacheRoot = path.join(root, 'kk-cache');
  for (const directory of [sourceRoot, remoteRoot, cacheRoot]) fs.mkdirSync(directory);
  const file = path.join(sourceRoot, kind === 'image' ? '实际PNG.jpg' : '中文附件.bin');
  const bytes = kind === 'image' ? imageBytes : Buffer.alloc(600123, 173);
  fs.writeFileSync(file, bytes);
  const thumbPath = path.join(cacheRoot, 'thumb.png');
  const artworkPath = path.join(cacheRoot, 'artwork.png');
  const preparedSources: string[] = [];
  const native = createNativeSendRuntime({
    searchUsers: [
      { id: 91009, login_name: '00AbC-near', name: '同名员工' },
      { id: 91008, login_name: '00abc', name: '同名员工' },
      { id: 91003, login_name: '00AbC', name: '同名员工' },
    ],
    ...config,
    prepareImage: (thumbnail, original) => {
      preparedSources.push(original);
      expect(original).not.toBe(file);
      expect(fs.readFileSync(original)).toEqual(imageBytes);
      fs.writeFileSync(thumbPath, Buffer.from(thumbnail, 'base64'));
      fs.copyFileSync(original, artworkPath);
      if (config.corruptArtwork) fs.writeFileSync(artworkPath, '损坏原图');
      return { code: 0, data: { thumbPath, artworkPath } };
    },
  });
  // 只替换 Electron 解码边界，复用固定真实素材及共享原生 IPC；传输、脚本和文件读取均真实执行。
  const resized = vi.fn(() => ({ toPNG: () => thumbnailBytes }));
  native.window['require'] = (name: string) => {
    if (name === 'os') return { ...os, tmpdir: () => remoteRoot };
    if (name === 'file-type')
      return (buffer: Buffer) =>
        buffer.subarray(0, 8).equals(imageBytes.subarray(0, 8)) ? { mime: 'image/png' } : undefined;
    if (name === 'electron')
      return {
        ipcRenderer: native.ipc,
        nativeImage: {
          createFromBuffer: (buffer: Buffer) => ({
            isEmpty: () => !buffer.equals(imageBytes) && !buffer.equals(thumbnailBytes),
            getSize: () =>
              buffer.equals(imageBytes) ? { width: 640, height: 360 } : { width: 300, height: 168 },
            resize: resized,
          }),
        },
      };
    return require(name) as unknown;
  };
  const deadlines: Array<{ milliseconds: number; expire: () => void }> = [];
  native.context['setTimeout'] = (callback: () => void, milliseconds: number) => {
    const timer = setTimeout(callback, milliseconds);
    if (milliseconds >= 18000 && milliseconds < 60000)
      deadlines.push({
        milliseconds,
        expire: () => {
          clearTimeout(timer);
          callback();
        },
      });
    return timer;
  };
  const budgets: Array<number | undefined> = [];
  const evaluate = native.cdp.evaluate.bind(native.cdp);
  native.cdp.evaluate = <T>(script: string, timeout?: number): Promise<T> => {
    budgets.push(timeout);
    return evaluate<T>(script, timeout);
  };
  const submissions: NativeMedia[] = [];
  const uploadedBytes: Buffer[] = [];
  const leaseSnapshots: Array<Pick<FileLease, 'holders' | 'readers'>> = [];
  const submitted = deferred();
  const leases = () =>
    native.window['__kairo_file_transfers'] as Map<string, FileLease> | undefined;
  const send = native.ipc.send.bind(native.ipc);
  native.ipc.send = (channel, request) => {
    if (request.args[0] === 'sendMessageNew') {
      const message = request.args[1] as NativeMedia;
      submissions.push(message);
      const mediaPath =
        message.contentType === 3
          ? message.content.filepath
          : message.content.content?.[0]?.filepath_h;
      if (!mediaPath) throw new Error('原生媒体缺少实际文件路径');
      uploadedBytes.push(fs.readFileSync(mediaPath));
      const lease = [...(leases()?.values() ?? [])][0];
      if (!lease) throw new Error('原生媒体缺少远端文件租约');
      leaseSnapshots.push({ holders: lease.holders, readers: lease.readers });
      submitted.resolve();
    }
    send(channel, request);
  };
  return {
    ...native,
    file,
    bytes,
    remoteRoot,
    thumbPath,
    artworkPath,
    resized,
    budgets,
    deadlines,
    submissions,
    uploadedBytes,
    leaseSnapshots,
    leases,
    submitted: submitted.promise,
    preparedSources,
    ops: new BridgeMessageOps(native.cdp),
  };
}

interface MediaRuntime {
  ipc: { listenerCount(channel: string): number };
  window: Record<string, unknown>;
  leases(): Map<string, FileLease> | undefined;
  remoteRoot: string;
  file: string;
  bytes: Buffer;
}

function expectClean(runtime: MediaRuntime) {
  expect(runtime.ipc.listenerCount('0-91003-sendMsgCallback')).toBe(0);
  expect(
    (runtime.window['__kairo_pending_sends'] as Map<string, unknown> | undefined)?.size ?? 0
  ).toBe(0);
  expect(runtime.leases()?.size ?? 0).toBe(0);
  expect(fs.readdirSync(runtime.remoteRoot)).toEqual([]);
  expect(fs.readFileSync(runtime.file)).toEqual(runtime.bytes);
  expect(vi.getTimerCount()).toBe(0);
}

const media = [
  {
    kind: 'image',
    name: '图片',
    contentType: 4,
    send: (ops: BridgeMessageOps | FakeKK9Driver, file: string, options: SendOptions) =>
      ops.sendImage(file, options),
  },
  {
    kind: 'file',
    name: '文件',
    contentType: 3,
    send: (ops: BridgeMessageOps | FakeKK9Driver, file: string, options: SendOptions) =>
      ops.sendFile(file, options),
  },
] as const;

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

for (const item of media) {
  describe(`${item.name}按准确工号原生发送`, () => {
    it('真实字节直达准确接收人，首次正式会话来自回执且同操作不重传', async () => {
      const runtime = mediaRuntime(item.kind);
      const options = {
        targetLoginName: ' 00AbC ',
        operationId: `first-${item.kind}`,
        verifyTimeoutMs: 30,
      };
      const result = await item.send(runtime.ops, runtime.file, options);
      expect(result).toMatchObject({
        status: 'sent',
        messageId: '135700000',
        sessionId: '94001',
        receipt: { sessionId: '94001', messageId: '135700000' },
      });
      expect(runtime.submissions).toHaveLength(1);
      expect(runtime.drafts[0]).toMatchObject({
        contentType: item.contentType,
        sender: 91001,
        receiver: 91003,
        sessionType: 0,
        sessionID: 0,
      });
      expect(runtime.uploadedBytes).toEqual([runtime.bytes]);
      expect(runtime.leaseSnapshots).toEqual([{ holders: 1, readers: 1 }]);
      if (item.kind === 'file') {
        expect(runtime.drafts[0]?.['content']).toMatchObject({
          filename: '中文附件.bin',
          size: '600123',
          mimetype: 'application/octet-stream',
        });
        expect(runtime.submissions[0]?.content.filepath).not.toBe(runtime.file);
      } else {
        expect(runtime.drafts[0]?.['content']).toMatchObject({
          content: [
            {
              filepath: runtime.thumbPath,
              filepath_h: runtime.artworkPath,
              width: 640,
              height: 360,
              size: imageBytes.length,
              mimetype: 'image/png',
            },
          ],
        });
        expect(runtime.resized).toHaveBeenCalledWith({ width: 300, height: 168, quality: 'best' });
        expect(fs.readFileSync(runtime.thumbPath)).toEqual(thumbnailBytes);
        expect(fs.readFileSync(runtime.artworkPath)).toEqual(imageBytes);
        expect(fs.existsSync(runtime.preparedSources[0]!)).toBe(false);
      }
      expect(
        runtime.ipc.sent
          .filter(request => request.args[0] === 'unionSearch')
          .map(request => request.args[1])
      ).toEqual([{ type: 'user', kwd: '00AbC', pageNo: 1, pageSize: 200 }]);
      expect(
        runtime.ipc.sent
          .filter(request => request.args[0] === 'getSessionBySessionID')
          .map(request => request.args[1])
      ).toEqual([94001]);
      expect(runtime.budgets).toContain(20030);
      expect(runtime.deadlines.map(timer => timer.milliseconds)).toContain(18030);
      expect(
        await item.send(runtime.ops, runtime.file, { ...options, targetLoginName: '00AbC' })
      ).toEqual(result);
      expect(await runtime.ops.getSendStatus(options.operationId)).toEqual(result);
      await expect(
        item.send(runtime.ops, runtime.file, { ...options, targetLoginName: 'other' })
      ).rejects.toThrow(/fingerprint|指纹|冲突/);
      await expect(item.send(runtime.ops, runtime.file + '.different', options)).rejects.toThrow(
        /fingerprint|指纹|冲突/
      );
      expect(runtime.submissions).toHaveLength(1);
      expect(
        runtime.ipc.sent.filter(request => request.args[0] === 'sendingImgBeforeHandle')
      ).toHaveLength(item.kind === 'image' ? 1 : 0);
      expectClean(runtime);
    });

    it('按工号复用既有正式私聊，显式会话仍无需人员搜索', async () => {
      const runtime = mediaRuntime(item.kind, {
        existingUserSessionId: 93003,
        reverseUserSession: true,
      });
      const directed = await item.send(runtime.ops, runtime.file, {
        targetLoginName: '00AbC',
        operationId: `existing-${item.kind}`,
      });
      expect(directed).toMatchObject({
        status: 'sent',
        sessionId: '93003',
        receipt: { sessionId: '93003' },
      });
      expect(runtime.drafts[0]).toMatchObject({ sessionID: 0, receiver: 91003 });
      const searches = runtime.ipc.sent.filter(request => request.args[0] === 'unionSearch').length;
      const explicit = await item.send(runtime.ops, runtime.file, {
        targetSessionId: '93003',
        operationId: `session-${item.kind}`,
      });
      expect(explicit).toMatchObject({ status: 'sent', receipt: { sessionId: '93003' } });
      expect(runtime.drafts[1]).toMatchObject({
        sessionID: 93003,
        receiver: '91003',
        contentType: item.contentType,
      });
      expect(runtime.ipc.sent.filter(request => request.args[0] === 'unionSearch')).toHaveLength(
        searches
      );
      expect(runtime.uploadedBytes).toEqual([runtime.bytes, runtime.bytes]);
      expectClean(runtime);
    });

    it('缺少、空白或双重目标在传输前失败', async () => {
      const runtime = mediaRuntime(item.kind);
      const targets: SendOptions[] = [
        {},
        { targetLoginName: '' },
        { targetLoginName: '  ' },
        { targetLoginName: '00AbC', targetSessionId: '93001' },
        { targetLoginName: '00AbC', targetSessionId: '' },
      ];
      for (const [index, target] of targets.entries()) {
        expect(
          await item.send(runtime.ops, runtime.file, {
            ...target,
            operationId: `invalid-${item.kind}-${index}`,
          })
        ).toMatchObject({ status: 'failed', isPreTrigger: true });
      }
      expect(runtime.budgets).toEqual([]);
      expect(runtime.ipc.sent).toEqual([]);
      expectClean(runtime);
    });

    it.each([
      ['非准确工号', { searchUsers: [{ id: 91009, login_name: '00AbC-near', name: '同名员工' }] }],
      ['大小写不符', { searchUsers: [{ id: 91003, login_name: '00abc', name: '同名员工' }] }],
      [
        '工号歧义',
        {
          searchUsers: [
            { id: 91003, login_name: '00AbC', name: '员工甲' },
            { id: 91004, login_name: '00AbC', name: '员工乙' },
          ],
        },
      ],
      ['档案不符', { targetProfile: { id: 91003, login_name: 'other' } }],
      ['禁止私聊', { permissionDenied: true }],
      ['本人账号', { searchUsers: [{ id: 91001, login_name: '00AbC', name: '本人' }] }],
      ['无登录身份', { identity: 0 }],
    ] satisfies Array<[string, NativeConfig]>)(
      '%s时不建草稿且清理已传输资源',
      async (_name, config) => {
        const runtime = mediaRuntime(item.kind, config);
        expect(
          await item.send(runtime.ops, runtime.file, { targetLoginName: '00AbC' })
        ).toMatchObject({ status: 'failed', isPreTrigger: true });
        expect(runtime.budgets.length).toBeGreaterThan(0);
        expect(runtime.drafts).toEqual([]);
        expect(runtime.submissions).toEqual([]);
        expectClean(runtime);
      }
    );

    it.each([
      ['缺少回执', { callback: false }],
      ['错误接收人回执', { mismatchedReceiver: true }],
    ] satisfies Array<[string, NativeConfig]>)(
      '%s保持未知，重复与查询均不再提交',
      async (_name, config) => {
        const runtime = mediaRuntime(item.kind, config);
        const options = {
          targetLoginName: '00AbC',
          operationId: `unknown-${item.kind}`,
          verifyTimeoutMs: 30,
        };
        const pending = item.send(runtime.ops, runtime.file, options);
        await runtime.submitted;
        await vi.advanceTimersByTimeAsync(31);
        const result = await pending;
        expect(result).toMatchObject({ status: 'unknown', isPreTrigger: false });
        expect(result.sessionId).toBeUndefined();
        expect(result.messageId).toBeUndefined();
        expect(runtime.records).toHaveLength(1);
        expect(await item.send(runtime.ops, runtime.file, options)).toEqual(result);
        expect(await runtime.ops.getSendStatus(options.operationId)).toEqual(result);
        expect(runtime.submissions).toHaveLength(1);
        expectClean(runtime);
      }
    );

    it.each(['超时', '取消'] as const)(
      '%s不能提前删除原生仍在读取的租约，迟到完成才释放',
      async mode => {
        const runtime = mediaRuntime(item.kind);
        const started = deferred();
        let release!: () => void;
        let lateBytes: Buffer | undefined;
        const send = runtime.ipc.send.bind(runtime.ipc);
        runtime.ipc.send = (channel, request) => {
          if (request.args[0] !== 'sendMessageNew') {
            send(channel, request);
            return;
          }
          const message = request.args[1] as NativeMedia;
          const nativePath =
            message.contentType === 3
              ? message.content.filepath
              : message.content.content?.[0]?.filepath_h;
          if (!nativePath) throw new Error('原生读取缺少文件路径');
          release = () => {
            lateBytes = fs.readFileSync(nativePath);
            send(channel, request);
          };
          started.resolve();
        };
        const options = {
          targetLoginName: '00AbC',
          operationId: `late-${item.kind}`,
          verifyTimeoutMs: 30,
        };
        const pending = item.send(runtime.ops, runtime.file, options);
        await started.promise;
        if (mode === '取消') await runtime.ops.cancelPendingSends();
        else await vi.advanceTimersByTimeAsync(31);
        const result = await pending;
        expect(result).toMatchObject({ status: 'unknown', isPreTrigger: false });
        const lease = [...(runtime.leases()?.values() ?? [])][0];
        expect(lease).toMatchObject({ holders: 0, readers: 1, releaseRequested: true });
        if (!lease) throw new Error('等待结束后原生读取租约被提前删除');
        expect(fs.readFileSync(lease.path)).toEqual(runtime.bytes);
        expect(runtime.records).toEqual([]);
        expect(await item.send(runtime.ops, runtime.file, options)).toEqual(result);
        expect(await runtime.ops.getSendStatus(options.operationId)).toEqual(result);
        release();
        await Promise.resolve();
        await Promise.resolve();
        expect(lateBytes).toEqual(runtime.bytes);
        expect(runtime.records).toHaveLength(1);
        expect(runtime.submissions).toHaveLength(1);
        expect(fs.existsSync(lease.directory)).toBe(false);
        expectClean(runtime);
      }
    );

    it('首块传输期间取消，不进入人员查询或原生发送并清理资源', async () => {
      const runtime = mediaRuntime(item.kind);
      const started = deferred();
      const gate = deferred();
      const evaluate = runtime.cdp.evaluate.bind(runtime.cdp);
      let blocked = false;
      runtime.cdp.evaluate = async <T>(script: string, timeout?: number): Promise<T> => {
        const value = await evaluate<T>(script, timeout);
        if (!blocked && script.includes('fs.writeSync')) {
          blocked = true;
          started.resolve();
          await gate.promise;
        }
        return value;
      };
      const pending = item.send(runtime.ops, runtime.file, { targetLoginName: '00AbC' });
      await started.promise;
      expect(fs.readdirSync(runtime.remoteRoot)).toHaveLength(1);
      const cancelling = runtime.ops.cancelPendingSends();
      gate.resolve();
      await cancelling;
      expect(await pending).toMatchObject({ status: 'failed', isPreTrigger: true });
      expect(runtime.ipc.sent).toEqual([]);
      expect(runtime.drafts).toEqual([]);
      expectClean(runtime);
    });

    it.each(['取消', '整轮期限'] as const)('准确工号查询期间%s，不建草稿并释放租约', async mode => {
      const runtime = mediaRuntime(item.kind);
      const started = deferred();
      const send = runtime.ipc.send.bind(runtime.ipc);
      runtime.ipc.send = (channel, request) => {
        if (request.args[0] === 'unionSearch') {
          started.resolve();
          if (mode === '整轮期限') {
            const deadline = runtime.deadlines[0];
            if (!deadline) throw new Error('定向发送未登记整轮期限');
            deadline.expire();
          }
          return;
        }
        send(channel, request);
      };
      const pending = item.send(runtime.ops, runtime.file, {
        targetLoginName: '00AbC',
        verifyTimeoutMs: 30,
      });
      await started.promise;
      if (mode === '取消') await runtime.ops.cancelPendingSends();
      expect(await pending).toMatchObject({ status: 'failed', isPreTrigger: true });
      expect(runtime.drafts).toEqual([]);
      expect(runtime.submissions).toEqual([]);
      expectClean(runtime);
    });
  });

  describe(`${item.name}假驱动定向契约`, () => {
    it('准确区分大小写与相似工号，正式会话复用且重复操作不再记录', async () => {
      const store = new InMemorySendOperationStore();
      const driver = new FakeKK9Driver(store);
      driver.setCurrentUserId('91001');
      driver.setEmployees([
        { id: 91009, loginName: '00AbC-near', name: '同名员工', updatedAt: 1 },
        { id: 91008, loginName: '00abc', name: '同名员工', updatedAt: 1 },
        { id: 91003, loginName: '00AbC', name: '同名员工', updatedAt: 1 },
      ]);
      const options = { targetLoginName: ' 00AbC ', operationId: `fake-${item.kind}` };
      const result = await item.send(driver, '本地附件', options);
      expect(result).toMatchObject({ status: 'sent', isPreTrigger: false });
      expect(await driver.getSessions()).toEqual([
        expect.objectContaining({
          id: result.sessionId,
          type: 'private',
          nativeType: 0,
          receiverId: '91003',
        }),
      ]);
      expect(driver.recordedCalls[0]).toMatchObject({
        type: item.kind,
        targetLoginName: '00AbC',
        payload: '本地附件',
      });
      const second = await item.send(driver, '另一附件', {
        targetLoginName: '00AbC',
        operationId: `fake-next-${item.kind}`,
      });
      expect(second).toMatchObject({ status: 'sent', sessionId: result.sessionId });
      expect(await driver.getSessions()).toHaveLength(1);
      driver.setEmployees([]);
      expect(await item.send(driver, '本地附件', { ...options, targetLoginName: '00AbC' })).toEqual(
        result
      );
      const observer = new FakeKK9Driver(store);
      expect(
        await item.send(observer, '本地附件', { ...options, targetLoginName: '00AbC' })
      ).toEqual(result);
      expect(observer.recordedCalls).toEqual([]);
      await expect(
        item.send(driver, '本地附件', { ...options, targetLoginName: 'other' })
      ).rejects.toThrow('fingerprint');
      await expect(item.send(driver, '冲突附件', options)).rejects.toThrow('fingerprint');
      expect(driver.recordedCalls).toHaveLength(2);
    });

    it('未知结果不建会话，换故障模式和人员数据后重放仍不重发', async () => {
      const driver = new FakeKK9Driver();
      driver.setCurrentUserId('91001');
      driver.setEmployees([{ id: 91003, loginName: '00AbC', name: '目标员工', updatedAt: 1 }]);
      driver.setSendBehavior({ mode: 'post_trigger_timeout', error: '未收到业务回执' });
      const options = { targetLoginName: '00AbC', operationId: `fake-unknown-${item.kind}` };
      const result = await item.send(driver, '本地附件', options);
      expect(result).toMatchObject({ status: 'unknown', isPreTrigger: false });
      expect(result.sessionId).toBeUndefined();
      expect(await driver.getSessions()).toEqual([]);
      driver.setEmployees([]);
      driver.setSendBehavior({ mode: 'success' });
      expect(await item.send(driver, '本地附件', options)).toEqual(result);
      expect(await driver.getSendStatus(options.operationId)).toEqual(result);
      expect(driver.recordedCalls).toHaveLength(1);
      expect(driver.recordedCalls[0]).toMatchObject({ type: item.kind, targetLoginName: '00AbC' });
      expect(await driver.getSessions()).toEqual([]);
    });
  });
}

it('按工号发图片仍校验真实原生原图，损坏时不建草稿且清理传输租约', async () => {
  const runtime = mediaRuntime('image', { corruptArtwork: true });
  expect(await runtime.ops.sendImage(runtime.file, { targetLoginName: '00AbC' })).toMatchObject({
    status: 'failed',
    isPreTrigger: true,
    error: expect.stringContaining(runtime.artworkPath),
  });
  expect(runtime.drafts).toEqual([]);
  expect(runtime.submissions).toEqual([]);
  expectClean(runtime);
});
