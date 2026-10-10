import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { CdpClient } from '../src/cdp/client.js';
import { BridgeMessageOps } from '../src/bridge/message-ops.js';
import { callIpcToData } from '../src/bridge/rpc.js';
import type {
  KK9UrlCardOptions,
  KK9BizMsgOptions,
  KK9AppMsgOptions,
  KK9ChatRecordOptions,
  SendResult,
} from '../src/types/index.js';

type CardInput =
  | { kind: 'url'; data: KK9UrlCardOptions }
  | { kind: 'biz'; data: KK9BizMsgOptions }
  | { kind: 'app'; data: KK9AppMsgOptions }
  | { kind: 'record'; data: KK9ChatRecordOptions };
export type SpikeCardResult = SendResult & { contentType: number; typeName: string };
export interface SpikeCardTestSummary {
  exitCode: number;
  results: SpikeCardResult[];
  recalledMessageIds: string[];
}

// 只诊断调用方明确提供的一种卡片，不生成假应用编号、业务单据或聊天作者。
export async function runSpikeCardTest(options: {
  cdp: CdpClient;
  env?: NodeJS.ProcessEnv;
  input?: CardInput;
  logger?: Pick<Console, 'log' | 'error'>;
}): Promise<SpikeCardTestSummary> {
  const env = options.env ?? process.env;
  const logger = options.logger ?? console;
  const targetId = env['KK9_MEDIA_TARGET_ID']?.trim() || '';
  const targetName = env['KK9_MEDIA_TARGET_NAME']?.trim() || '';
  const summary: SpikeCardTestSummary = { exitCode: 0, results: [], recalledMessageIds: [] };
  const ops = new BridgeMessageOps(options.cdp);
  let connected = false;
  try {
    if (!/^[1-9]\d*$/.test(targetId) || !targetName)
      throw new Error('必须指定原生 KK9_MEDIA_TARGET_ID 和 KK9_MEDIA_TARGET_NAME');
    await options.cdp.connect();
    connected = true;
    const identity = await callIpcToData<{ id: number }>(options.cdp, 'getMemberDetail', []);
    const session = await callIpcToData<{ id: number; typeName: string }>(
      options.cdp,
      'getSessionBySessionID',
      [Number(targetId)]
    );
    if (identity.code !== 0 || !identity.data?.id) throw new Error('无法取得实际登录身份');
    if (
      session.code !== 0 ||
      String(session.data?.id) !== targetId ||
      session.data?.typeName !== targetName
    )
      throw new Error('原生目标ID或名称不匹配');
    if (env['KK9_MEDIA_CONFIRM'] !== `${identity.data.id}:${targetId}:${targetName}`)
      throw new Error('KK9_MEDIA_CONFIRM 未匹配实际身份与原生目标');
    const input =
      options.input ??
      (JSON.parse(await readFile(env['KK9_CARD_PAYLOAD_FILE'] || '', 'utf8')) as CardInput);
    const sendOptions = {
      targetSessionId: targetId,
      operationId: randomUUID(),
      verifyTimeoutMs: 20000,
    };
    let result: SendResult;
    let contentType: number;
    switch (input.kind) {
      case 'url':
        contentType = 10;
        result = await ops.sendUrlCard(input.data, sendOptions);
        break;
      case 'biz':
        contentType = 17;
        result = await ops.sendBizMessage(input.data, sendOptions);
        break;
      case 'app':
        contentType = 8;
        result = await ops.sendAppMessage(input.data, sendOptions);
        break;
      case 'record':
        contentType = 15;
        result = await ops.sendChatRecord(input.data, sendOptions);
        break;
      default:
        throw new Error('卡片 kind 必须为 url、biz、app 或 record');
    }
    if (result.status === 'unknown') result = await ops.getSendStatus(sendOptions.operationId);
    summary.results.push({ ...result, contentType, typeName: input.kind });
    if (result.status !== 'sent') summary.exitCode = 1;
    logger.log(JSON.stringify(summary.results));
    logger.log('业务确认不代表实际展示；unknown 仅查询原操作，不重发。');
  } catch (error) {
    summary.exitCode = 1;
    logger.error('卡片诊断失败:', error);
  } finally {
    if (connected && env['KK9_MEDIA_KEEP'] !== '1') {
      for (const result of summary.results) {
        if (result.status !== 'sent') continue;
        try {
          if (await ops.recallMessage(result.messageId, targetId)) {
            summary.recalledMessageIds.push(result.messageId);
          } else {
            summary.exitCode = 1;
            logger.error(`卡片清理失败: 未撤回本轮卡片 ${result.messageId}`);
          }
        } catch (error) {
          summary.exitCode = 1;
          logger.error('卡片清理失败:', error);
        }
      }
    }
    if (connected) await options.cdp.disconnect();
  }
  return summary;
}

const entryPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (entryPath === import.meta.url) {
  const cdp = new CdpClient({
    url: process.env['CDP_URL'] || 'http://127.0.0.1:9222',
    pageMatch: process.env['PAGE_MATCH'] || 'renderer.html',
  });
  void runSpikeCardTest({ cdp })
    .then(summary => {
      process.exitCode = summary.exitCode;
    })
    .catch(error => {
      console.error('卡片诊断退出失败:', error);
      process.exitCode = 1;
    });
}
