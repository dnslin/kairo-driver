import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CdpClient, callIpcToData, normalizeNativeMessage } from '../src/index.js';
import { saveNativeFile } from '../src/bridge/attachment-ops.js';

// 独立CDP只读取指定的既有文件，不安装事件桥、不发送消息或切换会话。
const [uid, sessionId, index, expectedName, expectedLength] = process.argv.slice(2);
assert.ok(
  uid && sessionId && index && expectedName,
  '参数：实际登录UID 原生sessionID msgIdx 预期文件名 [预期文件字节数]'
);
for (const value of [uid, sessionId, index]) {
  assert.ok(
    /^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value)),
    'UID、会话及索引必须为正整数'
  );
}
const cdp = new CdpClient({
  url: process.env['CDP_URL'] || 'http://127.0.0.1:9222',
  pageMatch: process.env['PAGE_MATCH'] || 'renderer.html',
});
let directory: string | undefined;
cdp.on('error', (error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});

try {
  await cdp.connect();
  const identity = await callIpcToData<{ id: number }>(cdp, 'getMemberDetail');
  assert.equal(identity.code, 0, JSON.stringify(identity));
  assert.equal(String(identity.data?.id), uid, '实际登录UID不符');
  const response = await callIpcToData<Array<Record<string, unknown>> | Record<string, unknown>>(
    cdp,
    'getMessageBySessionIDAndMsgIdx',
    [Number(sessionId), Number(index)]
  );
  assert.equal(response.code, 0, JSON.stringify(response));
  const rows = Array.isArray(response.data) ? response.data : [response.data];
  const matches = rows.filter(
    row => row && String(row['sessionID']) === sessionId && Number(row['msgIdx']) === Number(index)
  );
  assert.equal(matches.length, 1, '准确会话和索引未返回唯一消息');
  const raw = matches[0]!;
  assert.equal(Number(raw['contentType']), 3, '指定消息不是普通文件');
  const [message] = normalizeNativeMessage(raw, { currentUserId: uid });
  assert.ok(message && !message.isRecalled, '指定文件已撤回或无法规范化');
  assert.equal(message.messageType, 'file');
  const file = message.fileInfo;
  assert.ok(file, '规范化缺少fileInfo');
  assert.equal(file.fileName, expectedName, '实际文件名不符');
  assert.ok(file.uri || file.filePath, '文件缺少缓存路径和服务器URI');
  const beforeTransfers = await cdp.evaluate<number>('window.__kairo_file_transfers?.size || 0');
  directory = await mkdtemp(path.join(os.tmpdir(), 'kairo-receive-'));
  const target = path.join(directory, 'received-file');
  assert.equal(await saveNativeFile(cdp, file, target), target);
  const bytes = await readFile(target);
  if (file.fileSize !== undefined && /^\d+$/.test(file.fileSize)) {
    assert.equal(bytes.length, Number(file.fileSize), '实际内容与元数据字节数不符');
  }
  if (expectedLength !== undefined) {
    assert.ok(
      /^\d+$/.test(expectedLength) && Number.isSafeInteger(Number(expectedLength)),
      '预期字节数必须是非负整数'
    );
    assert.equal(bytes.length, Number(expectedLength), '实际内容与预期字节数不符');
  }
  const afterTransfers = await cdp.evaluate<number>('window.__kairo_file_transfers?.size || 0');
  // 租约Map由多个连接共享，仅报告前后观测值，不把其他实例的合法并发操作判成泄漏。
  console.log(
    JSON.stringify(
      {
        通过: true,
        消息ID: message.id,
        会话ID: sessionId,
        索引: Number(index),
        文件名: file.fileName,
        字节数: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        缓存路径: file.filePath ?? null,
        URI: file.uri ?? null,
        操作前临时租约数: beforeTransfers,
        操作后临时租约数: afterTransfers,
        消息操作次数: 0,
      },
      null,
      2
    )
  );
} finally {
  try {
    await cdp.disconnect();
  } finally {
    if (directory) await rm(directory, { recursive: true, force: true });
  }
}
