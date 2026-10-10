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
import { getCardInputError, sendNativeStructuredMessage } from './card-ops.js';
import { prepareVoice } from './voice-ops.js';
import { buildMentionNodes, parseFormattedTextToKK } from './rich-text.js';
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
  async function findReplyTargetMessage(sessionID, targetRef) {
    const matches = message => String(message?.id) === targetRef.messageId &&
      String(message?.sessionID) === String(sessionID);
    let target;
    if (targetRef.msgIdx !== undefined) {
      const response = await callIpc('getMessageBySessionIDAndMsgIdx', sessionID, targetRef.msgIdx);
      if (response?.code !== 0) throw new Error('getMessageBySessionIDAndMsgIdx失败 (' + response?.code + '): ' + (response?.error || response?.message || ''));
      const messages = Array.isArray(response.data) ? response.data : response.data ? [response.data] : [];
      target = messages.find(message => matches(message) && message.msgIdx === targetRef.msgIdx);
    } else {
      let endIdx = 2147483647;
      while (endIdx > 0) {
        const response = await callIpc('getMessages', { sessionID, count: 200, endIdx, sendTime: 0 });
        if (response?.code !== 0 || !Array.isArray(response.data)) throw new Error('getMessages引用查询失败 (' + response?.code + '): ' + (response?.error || response?.message || '无效数组'));
        target = response.data.find(matches);
        if (target || response.data.length < 200) break;
        const next = Math.min(...response.data.map(message => Number(message.msgIdx))) - 1;
        if (!Number.isSafeInteger(next) || next >= endIdx) throw new Error('getMessages引用查询未取得可继续读取的索引');
        endIdx = next;
      }
    }
    if (!target) throw new Error('未在指定会话找到被回复的原生消息');
    if (!Number.isSafeInteger(Number(target.sender)) || Number(target.sender) <= 0 ||
        !Number.isSafeInteger(target.msgIdx) || target.msgIdx <= 0 || /^[CD]/.test(String(target.msgFlag))) {
      throw new Error('引用目标缺少原生发送者/准确索引或已撤回');
    }
    const isText = target.contentType === 0;
    const content = !isText && typeof target.content === 'string' ? JSON.parse(target.content) : target.content;
    if (isText ? typeof content !== 'string' : !content || typeof content !== 'object') throw new Error('引用目标缺少原生内容');
    return { ...target, content };
  }
`;

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
    currentUserId?: string | number
  ): Promise<KK9Message[]> {
    return (await this.getHistoryPage(session, limit, 2147483647, currentUserId)).messages;
  }

  /** 按原生索引向前读取，返回范围内最近的有限条记录；不承诺不可见历史全量。 */
  public async getMessagesInRange(
    session: KK9Session,
    fromTimestamp: number,
    toTimestamp: number,
    limit: number,
    currentUserId?: string | number
  ): Promise<KK9Message[]> {
    let endIdx = 2147483647;
    const selected: KK9Message[] = [];
    const seen = new Set<string>();
    while (endIdx > 0 && selected.length < limit) {
      const page = await this.getHistoryPage(session, 200, endIdx, currentUserId);
      for (let i = page.messages.length - 1; i >= 0 && selected.length < limit; i--) {
        const message = page.messages[i]!;
        if (message.timestamp < fromTimestamp || message.timestamp > toTimestamp || seen.has(message.id)) continue;
        seen.add(message.id);
        selected.push(message);
      }
      if (page.raw.length < 200 || selected.length >= limit ||
          page.messages.some(message => message.timestamp < fromTimestamp)) break;
      const next = Math.min(...page.raw.map(row => row && typeof row === 'object' && 'msgIdx' in row ? Number(row.msgIdx) : NaN)) - 1;
      if (!Number.isSafeInteger(next) || next >= endIdx) throw new DriverError(`getMessages 会话 ${session.id} endIdx ${endIdx} 无法继续分页`, 'IPC_INVALID_RESPONSE');
      endIdx = next;
    }
    return selected.reverse();
  }

  private async getHistoryPage(
    session: KK9Session, limit: number, endIdx: number, currentUserId?: string | number
  ): Promise<{ raw: unknown[]; messages: KK9Message[] }> {
    const sessionId = session?.id?.trim();
    if (!sessionId || !/^-?[0-9]+$/.test(sessionId) || !Number.isSafeInteger(Number(sessionId))) {
      throw new DriverError('历史读取必须指定原生会话 ID', 'INVALID_SESSION_ID');
    }
    const response = await callIpcToData<unknown[]>(this.cdp, 'getMessages', [
      { sessionID: Number(sessionId), count: Math.max(1, limit), endIdx, sendTime: 0 },
    ]).catch((err: unknown) => {
      throw new DriverError(`getMessages 会话 ${sessionId} endIdx ${endIdx}: ${String(err)}`, 'IPC_QUERY_FAILED', err instanceof Error ? err : undefined);
    });
    if (response.code !== 0) {
      throw new DriverError(
        `getMessages 会话 ${sessionId} endIdx ${endIdx} 失败 (${response.code}): ${response.error || response.message || ''}`,
        'IPC_QUERY_FAILED'
      );
    }
    if (!Array.isArray(response.data)) {
      throw new DriverError(`getMessages 会话 ${sessionId} endIdx ${endIdx} 未返回有效数组`, 'IPC_INVALID_RESPONSE');
    }
    const messages = normalizeNativeMessage(
      {
        messages: response.data,
        session: { id: sessionId, name: session.name, type: session.type },
      },
      {
        currentUserId,
        session,
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
    return { raw: response.data, messages };
  }

  public sendText(text: string, options: SendOptions = {}): Promise<SendResult> {
    if (options.replyTo !== undefined) return this.sendReply(options.replyTo, text, options);
    return this.executeOperation('text', options, text, (key, bound) =>
      this.sendRichTextRaw(text, bound, key)
    );
  }
  public sendRichText(content: FormattedText, options: SendOptions = {}): Promise<SendResult> {
    if (options.replyTo !== undefined) return this.sendReply(options.replyTo, content, options);
    return this.executeOperation('rich-text', options, content, (key, bound) =>
      this.sendRichTextRaw(content, bound, key)
    );
  }
  private sendRichTextRaw(
    content: FormattedText,
    options: SendOptions,
    key: string
  ): Promise<SendOutcome> {
    let parsed;
    let mentions;
    try {
      parsed = parseFormattedTextToKK(content);
      mentions = buildMentionNodes(options.mentions);
    } catch (error) {
      return Promise.resolve({ status: 'failed', error: String(error), isPreTrigger: true });
    }
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
      const target = typeof replyTo === 'string' ? { messageId: replyTo } : replyTo;
      let parsed;
      let mentions;
      try {
        if (!target || !/^[1-9]\d*$/.test(target.messageId) || !Number.isSafeInteger(Number(target.messageId)) ||
            (target.msgIdx !== undefined && (!Number.isSafeInteger(target.msgIdx) || target.msgIdx <= 0)) ||
            Object.keys(target).some(field => field !== 'messageId' && field !== 'msgIdx')) throw new Error('引用必须指定原生消息ID及可选准确索引，不接受摘要或发送者');
        parsed = parseFormattedTextToKK(content);
        mentions = buildMentionNodes(bound.mentions);
      } catch (error) {
        return Promise.resolve({ status: 'failed', error: String(error), isPreTrigger: true });
      }
      if (!parsed.plainText.trim())
        return Promise.resolve({ status: 'failed', error: '回复内容不能为空', isPreTrigger: true });
      const nodes = mentions.flatMap(node => [node, { type: 0, text: ' ' }]);
      nodes.push({ type: 0, text: parsed.plainText });
      return this.sendContent(
        13,
        { content: nodes, font: parsed.font },
        bound,
        key,
        mentions.map(node => node['replyMemberID']),
        target
      );
    });
  }
  public sendFile(filePath: string, options: SendFileOptions = {}): Promise<SendResult> {
    return this.executeOperation('file', options, filePath, async (key, bound) => {
      const fullPath = path.resolve(filePath);
      let size: number;
      try {
        const stats = fs.statSync(fullPath);
        if (stats.isDirectory())
          return { status: 'failed', error: '不能发送目录: ' + fullPath, isPreTrigger: true };
        if (stats.size > MAX_FILE_SIZE_BYTES)
          return { status: 'failed', error: '文件大小超出限制(100MB)', isPreTrigger: true };
        const descriptor = fs.openSync(fullPath, 'r');
        try {
          // 实际读取一个字节，发现本地读取错误；文件内容仍由原生发送负责上传。
          fs.readSync(descriptor, Buffer.alloc(1), 0, 1, 0);
        } finally {
          fs.closeSync(descriptor);
        }
        size = stats.size;
      } catch (error) {
        return { status: 'failed', error: '本地文件预检失败: ' + fullPath + '；' + String(error), isPreTrigger: true };
      }
      return this.sendContent(
        3,
        {
          type: 'File',
          mimetype: mime.lookup(fullPath) || 'application/octet-stream',
          filepath: fullPath,
          size: String(size),
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
    replyTo?: KK9ReplyTarget
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
      let mentionIds = data.mentionIds;
      if (data.contentType === 13) {
        ${FIND_REPLY_TARGET_SCRIPT}
        let targetMessage;
        try { targetMessage = await findReplyTargetMessage(targetSes.id, data.replyTo); }
        catch (error) { return { status: 'failed', error: '引用会话 ' + targetSes.id + ' 消息 ' + data.replyTo.messageId + ': ' + String(error), isPreTrigger: true }; }
        mentionIds = [Number(targetMessage.sender), ...mentionIds];
        messageContent = { replyedID: Number(targetMessage.sender), replyedName: targetMessage.senderName || '', replyedNameEN: targetMessage.senderNameEN || '', replyedNameTC: targetMessage.senderNameTC || '', replyedMsgId: targetMessage.id, replyedMsgIndex: targetMessage.msgIdx, replyedContentType: targetMessage.contentType, replyedContent: targetMessage.content.replyContent || targetMessage.content, replyContent: { content: data.content.content }, font: data.content.font };
      }
      // 草稿设备列允许NULL；正式核心从CORE_DATA使用当前注册设备，不以空值冒充设备身份。
      const msgObj = { contentType: data.contentType, content: messageContent, sender: identity.id, senderName: identity.name, senderNameEN: identity.name_en || '', senderNameTC: identity.name_tc || '', receiver, sessionType: targetSes.type, sessionID: targetSes.id,
        sendTime: Math.floor(Date.now()/1000), status: 'sending', type: 0, atState: data.contentType === 13 ? 2 : mentionIds.length ? 0 : 1, atMemberIDList: mentionIds, msgFlag: data.key };
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
      // 远端图片由 KK9 自己下载；不预先伪造 isValid 或本地路径。
    };
    return this.executeOperation('url-card', options, content, (nativeKey, effectiveOptions) => {
      const error = getCardInputError('url-card', content);
      if (error) {
        return Promise.resolve<SendOutcome>({
          status: 'failed',
          error,
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
      bizUrl: message.bizUrl,
      bizType: message.bizType,
    };
    return this.executeOperation('biz-message', options, content, (nativeKey, effectiveOptions) => {
      const error = getCardInputError('biz-message', content);
      if (error) {
        return Promise.resolve<SendOutcome>({
          status: 'failed',
          error,
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
      ...(message.linkUrl !== undefined ? { linkUrl: message.linkUrl } : {}),
      ...(message.pcAppCode !== undefined ? { pcAppCode: message.pcAppCode } : {}),
    };
    return this.executeOperation('app-message', options, content, (nativeKey, effectiveOptions) => {
      const error = getCardInputError('app-message', content);
      if (error) {
        return Promise.resolve<SendOutcome>({
          status: 'failed',
          error,
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
    const content = {
      sourceSessionId: record.sourceSessionId,
      msgArray: Array.isArray(record.msgArray) ? record.msgArray.map(item => ({ ...item })) : record.msgArray,
    };
    return this.executeOperation('chat-record', options, content, (nativeKey, effectiveOptions) => {
      const error = getCardInputError('chat-record', content);
      if (error) {
        return Promise.resolve<SendOutcome>({
          status: 'failed',
          error,
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
  public recallMessage(messageId: string, sessionId: string): Promise<boolean> {
    return recallNativeMessage(this.cdp, messageId, sessionId);
  }
}
