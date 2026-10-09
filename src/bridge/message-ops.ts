import fs from 'node:fs';
import path from 'node:path';
import mime from 'mime-types';
import { randomUUID } from 'node:crypto';
import type { CdpClient } from '../cdp/client.js';
import { normalizeNativeMessage, type InboundNormalizationDiagnostic } from './converter.js';
import { callIpcToData } from './rpc.js';
import {
  encodeRendererPayload,
  CONFIRM_SENT_MESSAGE_SCRIPT,
  NATIVE_SEND_CONTEXT_SCRIPT,
  RENDERER_IPC_HELPERS_SCRIPT,
  SUBMIT_NATIVE_MESSAGE_SCRIPT,
} from './renderer-script.js';
import { recallNativeMessage } from './recall-ops.js';
import { sendNativeImage } from './image-ops.js';
import { sendNativeStructuredMessage } from './card-ops.js';
import { prepareVoice } from './voice-ops.js';
import { parseFormattedTextToKK } from '../dom/rich-text.js';
import {
  BridgeSendStatus,
  createNativeMessageKey,
  isCdpUnavailableBeforeSend,
  sendOperationRecordToResult,
} from './send-status.js';
import {
  InMemorySendOperationStore,
  createSendOperationFingerprint,
  type SendOperationMessageType,
  type SendOperationStore,
} from '../send-operation.js';
import type {
  FormattedText,
  KK9AppMsgOptions,
  KK9BizMsgOptions,
  KK9ChatRecordOptions,
  KK9Message,
  KK9ReplyTarget,
  KK9Session,
  KK9UrlCardOptions,
  KK9VoiceOptions,
  SendFileOptions,
  SendOptions,
  SendOutcome,
  SendResult,
} from '../types/index.js';
import { DriverError, SendError } from '../utils/errors.js';
import { createChildLogger } from '../utils/logger.js';

const log = createChildLogger('bridge-message-ops');
const MAX_FILE_SIZE_BYTES = 100 * 1024 * 1024;
const FIND_REPLY_TARGET_SCRIPT = `
  function normalizeReplyTargetMessage(message) {
    if (!message || typeof message !== 'object') return null;
    const normalized = { ...message };
    if (typeof normalized.content === 'string') {
      try {
        normalized.content = JSON.parse(normalized.content);
      } catch (error) {}
    }
    return normalized;
  }

  async function findReplyTargetMessage(sessionID, targetRef) {
    const targetMessageId = String(targetRef.messageId);
    const targetMsgIdx = Number(targetRef.msgIdx);
    if (Number.isFinite(targetMsgIdx) && targetMsgIdx > 0) {
      const exactResponse = await callIpc(
        'getMessageBySessionIDAndMsgIdx',
        sessionID,
        targetMsgIdx
      );
      const exactMessages = Array.isArray(exactResponse?.data)
        ? exactResponse.data
        : exactResponse?.data
          ? [exactResponse.data]
          : [];
      const exactMatch = exactMessages.find(
        message => String(message?.id) === targetMessageId
      );
      if (exactMatch) return normalizeReplyTargetMessage(exactMatch);
    }

    let endIdx = 2147483647;
    for (let page = 0; page < 10; page++) {
      const response = await callIpc('getMessages', {
        sessionID,
        count: 200,
        endIdx,
        sendTime: 0
      });
      if (response?.code !== 0 || !Array.isArray(response.data)) return null;

      const match = response.data.find(
        message => String(message?.id) === targetMessageId
      );
      if (match) return normalizeReplyTargetMessage(match);
      if (response.data.length < 200) return null;

      const indices = response.data
        .map(message => Number(message?.msgIdx))
        .filter(index => Number.isFinite(index) && index > 0);
      if (indices.length === 0) return null;
      const nextEndIdx = Math.min(...indices) - 1;
      if (nextEndIdx >= endIdx) return null;
      endIdx = nextEndIdx;
    }
    return null;
  }
`;
function buildMentionNodes(mentions?: SendOptions['mentions']): Array<Record<string, unknown>> {
  if (!mentions) return [];
  const list = Array.isArray(mentions) ? mentions : [mentions];
  const nodes: Array<Record<string, unknown>> = [];

  for (const m of list) {
    if (m === 'all' || m === '全体成员' || m === '所有人') {
      nodes.push({
        type: 2,
        replyMemberID: 0,
        replyMemberType: 1,
        replyMemberName: '全体成员',
      });
    } else if (typeof m === 'string') {
      nodes.push({
        type: 2,
        replyMemberID: 0,
        replyMemberType: 0,
        replyMemberName: m.replace(/^@/, ''),
      });
    } else if (typeof m === 'object' && m !== null) {
      nodes.push({
        type: 2,
        replyMemberID: Number(m.uid) || 0,
        replyMemberType: 0,
        replyMemberName: m.name.replace(/^@/, ''),
      });
    }
  }

  return nodes;
}

export class BridgeMessageOps {
  private readonly sendStatus: BridgeSendStatus;
  private readonly inFlight = new Map<
    AbortController,
    { key?: string; result: Promise<SendResult> }
  >();
  private sendsCancelled = false;
  constructor(
    private readonly cdp: CdpClient,
    private readonly sendOperationStore: SendOperationStore = new InMemorySendOperationStore()
  ) {
    this.sendStatus = new BridgeSendStatus(cdp, sendOperationStore);
  }
  public getSendStatus(operationId: string): Promise<SendResult> {
    return this.sendStatus.getSendStatus(operationId);
  }

  public async cancelPendingSends(): Promise<void> {
    this.sendsCancelled = true;
    const pending = [...this.inFlight.entries()];
    for (const [controller] of pending) controller.abort();
    const keys = pending.flatMap(([, operation]) => (operation.key ? [operation.key] : []));
    try {
      if (keys.length && !isCdpUnavailableBeforeSend(this.cdp)) {
        await this.cdp.evaluate(
          '(() => { for (const key of ' +
            JSON.stringify(keys) +
            ') window.__kairo_pending_sends?.get(key)?.(); })()'
        );
      }
    } finally {
      await Promise.allSettled(pending.map(([, operation]) => operation.result));
    }
  }

  private async executeOperation<T extends SendOptions | SendFileOptions>(
    kind: SendOperationMessageType,
    options: T,
    content: unknown,
    action: (key: string, options: T, signal: AbortSignal) => Promise<SendOutcome>
  ): Promise<SendResult> {
    const controller = new AbortController();
    if (this.sendsCancelled) controller.abort();
    const result = this.runOperation(kind, options, content, action, controller);
    this.inFlight.set(controller, { result });
    try {
      return await result;
    } finally {
      this.inFlight.delete(controller);
    }
  }

  private async runOperation<T extends SendOptions | SendFileOptions>(
    kind: SendOperationMessageType,
    options: T,
    content: unknown,
    action: (key: string, options: T, signal: AbortSignal) => Promise<SendOutcome>,
    controller: AbortController
  ): Promise<SendResult> {
    const operationId =
      options.operationId === undefined ? randomUUID() : options.operationId.trim();
    if (!operationId) throw new SendError('operationId不能为空');
    const targetSessionId = options.targetSessionId?.trim();
    const effectiveOptions =
      targetSessionId &&
      /^-?[0-9]+$/.test(targetSessionId) &&
      Number.isSafeInteger(Number(targetSessionId))
        ? { ...options, operationId, targetSessionId }
        : null;
    const fingerprint = createSendOperationFingerprint({
      targetSessionId: options.targetSessionId?.trim(),
      messageType: kind,
      content: {
        payload: content,
        replyTo: 'replyTo' in options ? options.replyTo : undefined,
        mentions: 'mentions' in options ? options.mentions : undefined,
      },
    });
    const claim = await this.sendOperationStore.claim({ operationId, fingerprint });
    if (!claim.claimed) return this.sendStatus.resolve(claim.operation);
    let outcome: SendOutcome;
    const key = createNativeMessageKey(kind, operationId);
    this.inFlight.get(controller)!.key = key;
    if (!effectiveOptions)
      outcome = { status: 'failed', error: '发送必须指定明确原生会话ID', isPreTrigger: true };
    else if (controller.signal.aborted)
      outcome = { status: 'failed', error: '本轮发送已取消，未提交原生发送', isPreTrigger: true };
    else if (isCdpUnavailableBeforeSend(this.cdp))
      outcome = { status: 'failed', error: '发送前CDP未连接', isPreTrigger: true };
    else {
      try {
        outcome = await action(key, effectiveOptions, controller.signal);
      } catch (error) {
        outcome = { status: 'unknown', error: String(error), isPreTrigger: false };
      }
    }
    return sendOperationRecordToResult(await this.sendOperationStore.update(operationId, outcome));
  }

  /** 指定原生会话读取历史；空页正常返回，失败抛错，不依赖或回退聊天窗口。 */
  public async getRecentMessages(
    session: KK9Session,
    limit = 20,
    knownBotSentMessageKeys?: Set<string>,
    currentUserId?: string | number
  ): Promise<KK9Message[]> {
    const sessionId = session?.id?.trim();
    if (!sessionId || !/^-?[0-9]+$/.test(sessionId) || !Number.isSafeInteger(Number(sessionId))) {
      throw new DriverError('历史读取必须指定原生会话 ID', 'INVALID_SESSION_ID');
    }
    const response = await callIpcToData<unknown[]>(this.cdp, 'getMessages', [
      {
        sessionID: Number(sessionId),
        count: Math.max(1, limit),
        endIdx: 2147483647,
        sendTime: 0,
      },
    ]);
    if (response.code !== 0) {
      throw new DriverError(
        `getMessages 会话 ${sessionId} 失败 (${response.code}): ${response.error || response.message || ''}`,
        'IPC_QUERY_FAILED'
      );
    }
    if (!Array.isArray(response.data)) {
      throw new DriverError(`getMessages 会话 ${sessionId} 未返回有效数组`, 'IPC_INVALID_RESPONSE');
    }
    return normalizeNativeMessage(
      {
        messages: response.data,
        session: { id: sessionId, name: session.name, type: session.type },
      },
      {
        currentUserId,
        session,
        knownBotSentMessageKeys,
        source: 'history',
        onDiagnostic: (diagnostic: InboundNormalizationDiagnostic) => {
          log.warn(
            {
              kind: diagnostic.kind,
              missingFields: diagnostic.missingFields,
              sessionId: diagnostic.sessionId,
            },
            '丢弃缺少原生消息身份的历史记录'
          );
        },
      }
    );
  }

  public sendText(text: string, options: SendOptions = {}): Promise<SendResult> {
    if (options.replyTo) return this.sendReply(options.replyTo, text, options);
    return this.executeOperation('text', options, text, (key, bound) =>
      this.sendRichTextRaw(text, bound, key)
    );
  }
  public sendRichText(content: FormattedText, options: SendOptions = {}): Promise<SendResult> {
    if (options.replyTo) return this.sendReply(options.replyTo, content, options);
    return this.executeOperation('rich-text', options, content, (key, bound) =>
      this.sendRichTextRaw(content, bound, key)
    );
  }
  private sendRichTextRaw(
    content: FormattedText,
    options: SendOptions,
    key: string
  ): Promise<SendOutcome> {
    const parsed = parseFormattedTextToKK(content);
    const mentions = buildMentionNodes(options.mentions);
    if (!parsed.plainText.trim() && mentions.length === 0)
      return Promise.resolve({ status: 'failed', error: '文本内容不能为空', isPreTrigger: true });
    const nodes = mentions.flatMap(node => [node, { type: 0, text: ' ' }]);
    if (parsed.plainText) nodes.push({ type: 0, text: parsed.plainText });
    return this.sendContent(
      4,
      { content: nodes, font: parsed.font },
      options,
      key,
      mentions.map(node => node['replyMemberID'])
    );
  }
  public sendReply(
    replyTo: string | KK9ReplyTarget,
    content: FormattedText,
    options: SendOptions = {}
  ): Promise<SendResult> {
    return this.executeOperation('reply', { ...options, replyTo }, content, (key, bound) => {
      const parsed = parseFormattedTextToKK(content);
      if (!parsed.plainText.trim())
        return Promise.resolve({ status: 'failed', error: '回复内容不能为空', isPreTrigger: true });
      const mentions = buildMentionNodes(bound.mentions);
      const nodes = mentions.flatMap(node => [node, { type: 0, text: ' ' }]);
      nodes.push({ type: 0, text: parsed.plainText });
      return this.sendContent(
        13,
        { content: nodes, font: parsed.font },
        bound,
        key,
        [],
        typeof replyTo === 'string' ? { messageId: replyTo } : replyTo
      );
    });
  }
  public sendFile(filePath: string, options: SendFileOptions = {}): Promise<SendResult> {
    return this.executeOperation('file', options, filePath, async (key, bound) => {
      const fullPath = path.resolve(filePath);
      if (!fs.existsSync(fullPath))
        return { status: 'failed', error: '文件不存在: ' + fullPath, isPreTrigger: true };
      const stats = fs.statSync(fullPath);
      if (stats.isDirectory())
        return { status: 'failed', error: '不能发送目录: ' + fullPath, isPreTrigger: true };
      if (stats.size > MAX_FILE_SIZE_BYTES)
        return { status: 'failed', error: '文件大小超出限制(100MB)', isPreTrigger: true };
      return this.sendContent(
        3,
        {
          type: 'File',
          mimetype: mime.lookup(fullPath) || 'application/octet-stream',
          filepath: fullPath,
          size: String(stats.size),
          isValid: true,
          filename: path.basename(fullPath),
        },
        bound,
        key
      );
    });
  }

  private async sendContent(
    contentType: number,
    content: unknown,
    options: SendOptions | SendFileOptions,
    key: string,
    mentionIds: unknown[] = [],
    replyTo?: Partial<KK9ReplyTarget>
  ): Promise<SendOutcome> {
    const started = Date.now();
    const timeout = options.verifyTimeoutMs ?? 8000;
    const encoded = encodeRendererPayload({
      target: options.targetSessionId,
      contentType,
      content,
      key,
      mentionIds,
      replyTo,
      timeout,
    });
    const script = `(async () => {
      const electron = window.require ? window.require('electron') : null;
      const ipc = window.ipcRenderer || electron?.ipcRenderer;
      ${RENDERER_IPC_HELPERS_SCRIPT}
      ${NATIVE_SEND_CONTEXT_SCRIPT}
      ${CONFIRM_SENT_MESSAGE_SCRIPT}
      ${SUBMIT_NATIVE_MESSAGE_SCRIPT}
      const data = JSON.parse(decodeURIComponent(${encoded}));
      const cancellation = beginNativeSend(data.key);
      const callIpc = (channel, ...args) => callKairoIpcWithSignal(cancellation.signal, channel, ...args);
      try {
      let context;
      try { context = await readNativeSendContext(data.target); }
      catch (error) { return { status: 'failed', error: String(error), isPreTrigger: true }; }
      const { identity, session: targetSes, receiver } = context;
      let messageContent = data.content;
      if (data.contentType === 13) {
        ${FIND_REPLY_TARGET_SCRIPT}
        const targetMessage = await findReplyTargetMessage(targetSes.id, data.replyTo);
        if (!targetMessage) return { status: 'failed', error: '未在指定会话找到被回复的原生消息', isPreTrigger: true };
        messageContent = { type: 'Reply', replyedID: targetMessage.sender || 0, replyedName: targetMessage.senderName || '', replyedNameEN: targetMessage.senderNameEN || '', replyedNameTC: targetMessage.senderNameTC || '', replyedMsgId: targetMessage.id, replyedMsgIndex: targetMessage.msgIdx, replyedContentType: targetMessage.contentType, replyedContent: targetMessage.content?.replyContent || targetMessage.content, replyContent: data.content };
      }
      // 草稿设备列允许NULL；正式核心从CORE_DATA使用当前注册设备，不以空值冒充设备身份。
      const msgObj = { contentType: data.contentType, content: messageContent, sender: identity.id, senderName: identity.name, senderNameEN: identity.name_en || '', senderNameTC: identity.name_tc || '', receiver, sessionType: targetSes.type, sessionID: targetSes.id,
        sendTime: Math.floor(Date.now()/1000), status: 'sending', type: 0, atState: data.mentionIds.length ? 0 : 1, atMemberIDList: data.mentionIds, msgFlag: data.key };
      const submission = await submitNativeMessage(msgObj, targetSes, data.timeout, cancellation.signal);
      if (submission.failure) return submission.failure;
      return { status: 'sent', messageId: String(submission.confirmedMessage.id), receipt: submission.receipt, isPreTrigger: false };
      } finally { cancellation.finish(); }
    })()`;
    try {
      const outcome = await this.cdp.evaluate<SendOutcome>(script, timeout + 12000);
      if (!outcome || !['sent', 'failed', 'unknown'].includes(outcome.status))
        return { status: 'unknown', error: '原生发送未返回有效结果', isPreTrigger: false };
      return { ...outcome, verifyLatencyMs: Date.now() - started };
    } catch (error) {
      return {
        status: 'unknown',
        error: '原生发送连接异常: ' + String(error),
        isPreTrigger: false,
        verifyLatencyMs: Date.now() - started,
      };
    }
  }

  public sendImage(imagePath: string, options: SendOptions = {}): Promise<SendResult> {
    return this.executeOperation('image', options, imagePath, (key, bound) =>
      sendNativeImage(this.cdp, imagePath, bound, key)
    );
  }
  /** 发送链接图文卡片。 */
  public sendUrlCard(card: KK9UrlCardOptions, options: SendOptions = {}): Promise<SendResult> {
    const content = {
      title: card.title,
      summary: card.summary,
      linkUrl: card.linkUrl,
      picUrl: card.picUrl ?? '',
      isValid: true,
      filepath: '',
    };
    return this.executeOperation('url-card', options, content, (nativeKey, effectiveOptions) => {
      if (!content.title.trim() || !content.summary.trim() || !content.linkUrl.trim()) {
        return Promise.resolve<SendOutcome>({
          status: 'failed',
          error: 'UrlCard 的 title、summary 与 linkUrl 不能为空',
          isPreTrigger: true,
        });
      }
      return sendNativeStructuredMessage(
        this.cdp,
        { kind: 'url-card', contentType: 10, content },
        effectiveOptions,
        nativeKey
      );
    });
  }

  /** 发送业务任务或通知卡片。 */
  public sendBizMessage(message: KK9BizMsgOptions, options: SendOptions = {}): Promise<SendResult> {
    const content = {
      title: message.title,
      content: message.content,
      summary: [...(message.summary ?? [])],
      bizUrl: message.bizUrl ?? '',
      bizType: message.bizType ?? 1,
    };
    return this.executeOperation('biz-message', options, content, (nativeKey, effectiveOptions) => {
      if (!content.title.trim() || !content.content.trim()) {
        return Promise.resolve<SendOutcome>({
          status: 'failed',
          error: 'BizMsg 的 title 与 content 不能为空',
          isPreTrigger: true,
        });
      }
      return sendNativeStructuredMessage(
        this.cdp,
        { kind: 'biz-message', contentType: 17, content },
        effectiveOptions,
        nativeKey
      );
    });
  }

  /** 发送工作台微应用通知卡片。 */
  public sendAppMessage(message: KK9AppMsgOptions, options: SendOptions = {}): Promise<SendResult> {
    const content = {
      title: message.title,
      content: message.content,
      linkUrl: message.linkUrl ?? '',
      pcAppCode: message.pcAppCode ?? '',
    };
    return this.executeOperation('app-message', options, content, (nativeKey, effectiveOptions) => {
      if (!content.title.trim() || !content.content.trim()) {
        return Promise.resolve<SendOutcome>({
          status: 'failed',
          error: 'AppMsg 的 title 与 content 不能为空',
          isPreTrigger: true,
        });
      }
      return sendNativeStructuredMessage(
        this.cdp,
        { kind: 'app-message', contentType: 8, content },
        effectiveOptions,
        nativeKey
      );
    });
  }

  /** 发送可点击查看详情的合并聊天记录卡片。 */
  public sendChatRecord(
    record: KK9ChatRecordOptions,
    options: SendOptions = {}
  ): Promise<SendResult> {
    let content: KK9ChatRecordOptions;
    try {
      const serialized = JSON.stringify({
        title: record.title,
        msgArray: record.msgArray,
      });
      content = JSON.parse(serialized) as KK9ChatRecordOptions;
    } catch (error) {
      const cause = error instanceof Error ? error : new Error(String(error));
      throw new SendError(`无法生成 ChatRecord 内容快照: ${cause.message}`, cause);
    }

    return this.executeOperation('chat-record', options, content, (nativeKey, effectiveOptions) => {
      const invalidItem = content.msgArray.some(
        item =>
          !item.senderName.trim() ||
          !Number.isFinite(item.contentType) ||
          item.content === undefined
      );
      if (!content.title.trim() || content.msgArray.length === 0 || invalidItem) {
        return Promise.resolve<SendOutcome>({
          status: 'failed',
          error: 'ChatRecord 需要非空 title 与至少一条完整消息',
          isPreTrigger: true,
        });
      }
      return sendNativeStructuredMessage(
        this.cdp,
        { kind: 'chat-record', contentType: 15, content },
        effectiveOptions,
        nativeKey
      );
    });
  }
  public sendVoice(voice: KK9VoiceOptions, options: SendOptions = {}): Promise<SendResult> {
    const input = { ...voice };
    return this.executeOperation('voice', options, input, async (key, bound, signal) => {
      if (bound.replyTo !== undefined || bound.mentions !== undefined)
        return {
          status: 'failed',
          error: '原生语音消息不支持replyTo或mentions',
          isPreTrigger: true,
        };
      try {
        const prepared = await prepareVoice(this.cdp, input);
        if (signal.aborted)
          return { status: 'failed', error: '语音准备期间本轮发送已取消', isPreTrigger: true };
        return sendNativeStructuredMessage(
          this.cdp,
          { kind: 'voice', contentType: 2, content: prepared },
          bound,
          key
        );
      } catch (error) {
        return { status: 'failed', error: '语音准备失败: ' + String(error), isPreTrigger: true };
      }
    });
  }
  public recallMessage(messageId: string, sessionId?: string): Promise<boolean> {
    return recallNativeMessage(this.cdp, messageId, sessionId);
  }
}
