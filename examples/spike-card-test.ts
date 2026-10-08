import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { CdpClient } from '../src/cdp/client.js';
import { recallNativeMessage } from '../src/bridge/recall-ops.js';
import {
  CONFIRM_SENT_MESSAGE_SCRIPT,
  RENDERER_IPC_HELPERS_SCRIPT,
  SUBMIT_NATIVE_MESSAGE_SCRIPT,
  encodeRendererPayload,
} from '../src/bridge/renderer-script.js';
import type { SendOutcome, SendResult } from '../src/types/index.js';

interface TargetSession {
  id: number | string;
  type: number;
  sesUUID: string;
  typeID: number | string;
  sesTypeID?: number | string;
  name: string;
}

interface SessionInfo {
  myUid: number | string;
  myName: string;
  targetSes: TargetSession | null;
}

interface AuthorizedSessionInfo {
  myUid: number | string;
  myName: string;
  targetSes: TargetSession;
}

export type SpikeCardResult = SendResult & { contentType: number; typeName: string };

export interface SpikeCardTestSummary {
  exitCode: number;
  results: SpikeCardResult[];
  recalledMessageIds: string[];
}

interface SpikeLogger {
  log(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

interface SpikeCardTestOptions {
  cdp: CdpClient;
  env?: NodeJS.ProcessEnv;
  logger?: SpikeLogger;
  delay?: (milliseconds: number) => Promise<void>;
}

interface SpikeCase {
  typeName: string;
  contentType: number;
  content: unknown;
}

function createSpikeCases(groupId: number, groupName: string): readonly SpikeCase[] {
  return [
    {
      typeName: 'UrlCard (链接卡片)',
      contentType: 10,
      content: {
        title: '[Spike测试] Kairo 系统部署报告',
        summary: '自动化构建成功，这是一条免模板的 UrlCard 原生卡片消息测试。',
        linkUrl: 'https://example.com/build/1024',
        picUrl: 'https://www.google.com/favicon.ico',
      },
    },
    {
      typeName: 'BizMsg (业务任务卡片)',
      contentType: 17,
      content: {
        title: '[Spike测试] 任务催办通知',
        content: '您的数字化需求单已进入待审批状态，请及时处理。',
        summary: ['单据编号: REQ-20260906-01', '提交人员: 测试提交人', '单据状态: 待审批'],
        bizUrl: 'https://example.com/oa/flow/123',
        bizType: 1,
      },
    },
    {
      typeName: 'AppMsg (微应用通知)',
      contentType: 8,
      content: {
        title: '[Spike测试] 微应用系统提醒',
        content: '<p>这是一条<b>微应用</b>风格的富文本通知消息测试。</p>',
        linkUrl: 'https://example.com/app/dashboard',
        pcAppCode: 'test_app',
      },
    },
    {
      typeName: 'GroupInfoShare (群名片推荐)',
      contentType: 14,
      content: {
        groupId,
        groupName,
        ownerName: '管理员',
      },
    },
  ];
}

async function readAuthorizedSession(
  cdp: CdpClient,
  targetId: string,
  targetName: string,
  confirmation: string | undefined
): Promise<AuthorizedSessionInfo> {
  const encoded = encodeRendererPayload({ targetId });
  const sessionInfo = await cdp.evaluate<SessionInfo>(`
    (() => {
      const data = JSON.parse(decodeURIComponent(${encoded}));
      const main = document.querySelector('.main-page')?.__vue__;
      const editor = document.querySelector('.chat-editor, .message-editor, .chat-sendArea')?.__vue__;
      const sessions = editor?.sortedSessions;
      const matched = Array.isArray(sessions)
        ? sessions.find(session => session && (
            String(session.sesUUID ?? '') === data.targetId ||
            String(session.id ?? '') === data.targetId
          ))
        : null;
      return {
        myUid: main?.userID || editor?.userID || '',
        myName: main?.userName || editor?.userName || '测试员',
        targetSes: matched ? {
          id: matched.id,
          type: matched.type,
          sesUUID: matched.sesUUID,
          typeID: matched.typeID,
          sesTypeID: matched.sesTypeID,
          name: matched.typeName || matched.name || ''
        } : null
      };
    })()
  `);

  const targetSession = sessionInfo?.targetSes;
  if (!targetSession) {
    throw new Error(`未按配置 ID 找到目标测试会话: ${targetId}`);
  }
  if (targetSession.name !== targetName) {
    throw new Error(
      `目标会话名称不匹配: ID ${targetId} 对应 [${targetSession.name}]，期望 [${targetName}]`
    );
  }
  if (!String(sessionInfo.myUid).trim()) {
    throw new Error('无法识别当前登录用户');
  }
  const expectedConfirmation = `${sessionInfo.myUid}:${targetId}:${targetName}`;
  if (confirmation !== expectedConfirmation) {
    throw new Error('请设置 KK9_MEDIA_CONFIRM=当前UID:目标ID:目标名称 后运行');
  }

  return { ...sessionInfo, targetSes: targetSession };
}

async function sendCustomMessage(
  cdp: CdpClient,
  sessionInfo: AuthorizedSessionInfo,
  testCase: SpikeCase,
  msgFlag: string,
  logger: SpikeLogger
): Promise<SpikeCardResult> {
  logger.log('--------------------------------------------------');
  logger.log(`测试发送类型: ${testCase.typeName} (contentType: ${testCase.contentType})`);
  logger.log('Payload:', JSON.stringify(testCase.content, null, 2));

  const encoded = encodeRendererPayload({
    targetSes: sessionInfo.targetSes,
    myUid: sessionInfo.myUid,
    myName: sessionInfo.myName,
    contentType: testCase.contentType,
    content: testCase.content,
    msgFlag,
  });

  try {
    const result = await cdp.evaluate<SendOutcome>(
      `
      (async () => {
        const electron = window.require ? window.require('electron') : null;
        const ipc = window.ipcRenderer || electron?.ipcRenderer;
        ${RENDERER_IPC_HELPERS_SCRIPT}
        const callIpc = callKairoIpc;
        ${CONFIRM_SENT_MESSAGE_SCRIPT}
        ${SUBMIT_NATIVE_MESSAGE_SCRIPT}

        const data = JSON.parse(decodeURIComponent(${encoded}));
        const targetSes = data.targetSes;
        const msgObj = {
          contentType: data.contentType,
          content: data.content,
          sender: data.myUid,
          senderName: data.myName,
          senderNameEN: data.myName,
          senderNameTC: data.myName,
          receiver: targetSes.typeID || targetSes.sesTypeID,
          sendTime: Math.floor(Date.now() / 1000),
          sessionType: targetSes.type,
          sessionID: targetSes.id,
          atState: 1,
          atMemberIDList: [],
          status: 'sending',
          type: 0,
          msgFlag: data.msgFlag
        };

        const submission = await submitNativeMessage(msgObj, targetSes);
        if (submission.failure) {
          return submission.failure;
        }
        return {
          status: 'sent',
          messageId: String(submission.confirmedMessage.id),
          receipt: submission.receipt,
          isPreTrigger: false
        };
      })()
    `,
      15000
    );

    const normalized: SpikeCardResult = {
      ...(result || { status: 'unknown', error: '原生提交未取得业务结果', isPreTrigger: false }),
      operationId: msgFlag,
      contentType: testCase.contentType,
      typeName: testCase.typeName,
    };

    if (normalized.status === 'sent') {
      logger.log(`发送已确认落库，正式消息 ID: ${normalized.messageId}`);
    } else {
      logger.error(
        `发送结果为 ${normalized.status}，禁止自动重发: ${normalized.error || '未获得权威确认'}`
      );
    }
    return normalized;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`发送动作结果无法确认，禁止自动重发: ${message}`);
    return {
      contentType: testCase.contentType,
      typeName: testCase.typeName,
      operationId: msgFlag,
      status: 'unknown',
      error: message,
      isPreTrigger: false,
    };
  }
}

export async function runSpikeCardTest(
  options: SpikeCardTestOptions
): Promise<SpikeCardTestSummary> {
  const env = options.env ?? process.env;
  const logger = options.logger ?? console;
  const delay = options.delay ?? (milliseconds => sleep(milliseconds));
  const targetId = env['KK9_MEDIA_TARGET_ID']?.trim() || '';
  const targetName = env['KK9_MEDIA_TARGET_NAME']?.trim() || '';
  const keep = env['KK9_MEDIA_KEEP'] === '1';
  const results: SpikeCardResult[] = [];
  const sentMessageIds: string[] = [];
  const recalledMessageIds: string[] = [];
  let exitCode = 0;
  let connected = false;

  logger.log('=== KK9 非文本/卡片消息服务端可行性 Spike 测试 ===\n');
  try {
    if (!targetId || !targetName) {
      throw new Error('必须设置 KK9_MEDIA_TARGET_ID 和 KK9_MEDIA_TARGET_NAME');
    }
    const groupSessionId = env['KK9_TEST_GROUP_ID']?.trim() || '';
    const groupName = env['KK9_TEST_GROUP_NAME']?.trim() || '';
    const groupId = Number(groupSessionId.slice(2));
    if (
      !/^1-\d+$/.test(groupSessionId) ||
      !Number.isSafeInteger(groupId) ||
      groupId <= 0 ||
      !groupName
    ) {
      throw new Error('必须设置 KK9_TEST_GROUP_ID=1-<群ID> 和 KK9_TEST_GROUP_NAME，用于群名片');
    }
    const cases = createSpikeCases(groupId, groupName);
    logger.log('1. 连接 KK9 CDP...');
    await options.cdp.connect();
    connected = true;
    logger.log('CDP 已连接\n');

    const sessionInfo = await readAuthorizedSession(
      options.cdp,
      targetId,
      targetName,
      env['KK9_MEDIA_CONFIRM']
    );
    logger.log(
      `2. 目标会话确认: [${sessionInfo.targetSes.name}] (id: ${targetId}, type: ${sessionInfo.targetSes.type})`
    );
    logger.log(`当前操作者 UID: ${sessionInfo.myUid} (${sessionInfo.myName})\n`);

    for (let index = 0; index < cases.length; index++) {
      const testCase = cases[index]!;
      const result = await sendCustomMessage(
        options.cdp,
        sessionInfo,
        testCase,
        `KAIRO_SPIKE_${testCase.contentType}_${Date.now()}_${index}`,
        logger
      );
      results.push(result);
      if (result.status === 'sent') {
        sentMessageIds.push(result.messageId);
      } else {
        exitCode = 1;
      }
      if (index < cases.length - 1) await delay(1500);
    }

    logger.log('\n==================================================');
    logger.log('Spike 测试汇总:');
    for (const result of results) {
      logger.log(
        ` - ${result.typeName} (type=${result.contentType}): ${result.status}` +
          (result.messageId ? ` (ID=${result.messageId})` : ` (${result.error || '无正式消息 ID'})`)
      );
    }
    logger.log('==================================================\n');
  } catch (error) {
    exitCode = 1;
    logger.error('Spike 测试执行异常:', error);
  } finally {
    if (connected && !keep) {
      for (const messageId of sentMessageIds) {
        const recalled = await recallNativeMessage(options.cdp, messageId, targetId);
        if (recalled) {
          recalledMessageIds.push(messageId);
          logger.log(`已撤回 Spike 消息 ${messageId}`);
        } else {
          exitCode = 1;
          logger.error(`未撤回 Spike 消息 ${messageId}: 原生撤回返回失败`);
        }
      }
    } else if (keep && sentMessageIds.length > 0) {
      logger.log(`保留供界面检查的消息: ${sentMessageIds.join(', ')}`);
    }

    if (connected) {
      try {
        await options.cdp.disconnect();
      } catch (error) {
        exitCode = 1;
        logger.error('断开 KK9 CDP 失败:', error);
      }
    }
  }

  return { exitCode, results, recalledMessageIds };
}

async function main(): Promise<void> {
  const cdp = new CdpClient({
    url: process.env['CDP_URL'] || 'http://127.0.0.1:9222',
    pageMatch: process.env['PAGE_MATCH'] || 'renderer.html',
  });
  const summary = await runSpikeCardTest({ cdp });
  if (summary.exitCode !== 0) process.exitCode = summary.exitCode;
}

const entryPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (entryPath === import.meta.url) {
  void main().catch(error => {
    console.error('Spike 测试执行异常:', error);
    process.exitCode = 1;
  });
}
