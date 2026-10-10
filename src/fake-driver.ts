import EventEmitter from 'node:events';
import { randomUUID } from 'node:crypto';
import type {
  CompensationScanOptions,
  ConnectionStatus,
  DriverEvents,
  DriverHealthSnapshot,
  FormattedText,
  IKK9Driver,
  KK9AppMsgOptions,
  KK9BizMsgOptions,
  KK9ChatRecordOptions,
  KK9Employee,
  KK9Message,
  KK9RecalledEvent,
  KK9ReplyTarget,
  KK9Session,
  KK9UrlCardOptions,
  KK9VoiceOptions,
  PreSendCheckResult,
  SendFileOptions,
  SendOptions,
  SendOutcome,
  SendResult,
} from './types/index.js';
import {
  InMemorySendOperationStore,
  createSendOperationFingerprint,
  type SendOperationMessageType,
  type SendOperationStore,
} from './send-operation.js';
import { createNativeMessageKey, sendOperationRecordToResult } from './bridge/send-status.js';
import { createMessageIdentityKey, normalizeNativeMessage } from './bridge/converter.js';
import { buildMentionNodes, parseFormattedTextToKK } from './bridge/rich-text.js';
import { getCardInputError } from './bridge/card-ops.js';
import { DriverError } from './utils/errors.js';

export type FakeSendPayload =
  | FormattedText
  | KK9UrlCardOptions
  | KK9BizMsgOptions
  | KK9AppMsgOptions
  | KK9ChatRecordOptions
  | KK9VoiceOptions;

export type FakeSendBehavior =
  | { mode: 'success'; messageId?: string }
  | { mode: 'pre_trigger_failure'; error: string }
  | { mode: 'post_trigger_timeout'; error?: string }
  | { mode: 'post_trigger_disconnect'; error?: string }
  | { mode: 'post_trigger_lost_response'; error?: string }
  | {
      mode: 'custom';
      handler(
        payload: FakeSendPayload,
        options?: SendOptions | SendFileOptions
      ): Promise<SendOutcome> | SendOutcome;
    }
  | { mode: 'sequence'; behaviors: FakeSendBehavior[] };

export interface RecordedSendCall {
  type:
    | 'text'
    | 'richText'
    | 'reply'
    | 'image'
    | 'file'
    | 'urlCard'
    | 'bizMessage'
    | 'appMessage'
    | 'chatRecord'
    | 'voice';
  payload: FakeSendPayload;
  options?: SendOptions | SendFileOptions;
  timestamp: number;
}

// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export declare interface FakeKK9Driver {
  on<U extends keyof DriverEvents>(event: U, listener: DriverEvents[U]): this;
  emit<U extends keyof DriverEvents>(event: U, ...args: Parameters<DriverEvents[U]>): boolean;
}

// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging, no-redeclare
export class FakeKK9Driver extends EventEmitter implements IKK9Driver {
  private currentUserId: string | null = null;
  private currentSession: KK9Session | null = null;
  private sessions: KK9Session[] = [];
  private messages: KK9Message[] = [];
  private employees: KK9Employee[] = [];
  private currentBehavior: FakeSendBehavior = { mode: 'success' };
  private behaviorSequence: FakeSendBehavior[] = [];
  private selectSessionHandler?: (sessionId: string) => Promise<boolean> | boolean;
  private preSendCheckHandler?: (
    sessionId: string
  ) => Promise<PreSendCheckResult> | PreSendCheckResult;
  private readonly sendOperationStore: SendOperationStore;

  private readonly confirmedSendKeys = new Map<string, string>();
  private readonly knownMessageKeys = new Set<string>();
  private readonly knownRecalledMessageKeys = new Set<string>();
  public readonly recordedCalls: RecordedSendCall[] = [];
  public selectSessionCallsCount = 0;
  public markSessionReadCallsCount = 0;

  constructor(sendOperationStore: SendOperationStore = new InMemorySendOperationStore()) {
    super();
    this.sendOperationStore = sendOperationStore;
  }

  public connect(): Promise<void> {
    return Promise.resolve();
  }

  public disconnect(): Promise<void> {
    return Promise.resolve();
  }

  public getStatus(): ConnectionStatus {
    return 'connected';
  }

  public getStartupGenerationId(): string {
    return 'fake-startup-gen';
  }

  public getHealthSnapshot(): DriverHealthSnapshot {
    return {
      startupGenerationId: 'fake-startup-gen',
      cdpStatus: 'connected',
      cdpConnectionIdentity: null,
      eventBridgeAttached: true,
      eventBridgeConnectionIdentity: null,
    };
  }

  public setCurrentUserId(userId: string | null): void {
    this.currentUserId = userId;
  }

  public getCurrentUserId(): Promise<string | null> {
    return Promise.resolve(this.currentUserId);
  }

  public setSessions(sessions: KK9Session[]): void {
    this.sessions = sessions;
  }
  public setMessages(messages: KK9Message[]): void {
    this.messages = messages;
  }

  public setEmployees(employees: KK9Employee[]): void {
    this.employees = employees;
  }

  public getSessions(): Promise<KK9Session[]> {
    return Promise.resolve(this.sessions);
  }

  public getRecentMessages(session: KK9Session, limit = 20): Promise<KK9Message[]> {
    return Promise.resolve(
      this.messages.filter(message => message.sessionId === session.id).slice(-Math.max(1, limit))
    );
  }

  public scanCompensationWindow(options: CompensationScanOptions): Promise<KK9Message[]> {
    const to = options.toTimestamp ?? Date.now();
    const limit = options.maxMessagesPerSession ?? 20;
    if (!Number.isFinite(options.fromTimestamp) || !Number.isFinite(to) || options.fromTimestamp > to) return Promise.reject(new DriverError('补偿扫描时间窗口无效', 'COMPENSATION_SCAN_INVALID_WINDOW'));
    if (!Number.isSafeInteger(limit) || limit <= 0) return Promise.reject(new DriverError('补偿扫描数量必须为正整数', 'COMPENSATION_SCAN_INVALID_LIMIT'));
    for (const id of options.sessionIds ?? []) {
      if (!this.sessions.some(session => session.id === id)) return Promise.reject(new DriverError(`补偿扫描原生会话不存在: ${id}`, 'COMPENSATION_SCAN_SESSION_NOT_FOUND'));
    }
    const result: KK9Message[] = [];
    for (const session of this.sessions) {
      if (options.sessionIds && !options.sessionIds.includes(session.id)) continue;
      const seen = new Set<string>();
      const selected = this.messages.filter(m => m.sessionId === session.id && m.timestamp >= options.fromTimestamp && m.timestamp <= to)
        .sort((a, b) => (b.msgIdx ?? b.timestamp) - (a.msgIdx ?? a.timestamp))
        .filter(m => { if (seen.has(m.id)) return false; seen.add(m.id); return true; })
        .slice(0, limit).reverse();
      result.push(...selected);
    }
    return Promise.resolve(result);
  }

  public setSendBehavior(behavior: FakeSendBehavior): void {
    if (behavior.mode === 'sequence') {
      this.behaviorSequence = [...behavior.behaviors];
      this.currentBehavior = this.behaviorSequence.shift() ?? { mode: 'success' };
    } else {
      this.currentBehavior = behavior;
      this.behaviorSequence = [];
    }
  }

  public setSelectSessionBehavior(
    handler: (sessionId: string) => Promise<boolean> | boolean
  ): void {
    this.selectSessionHandler = handler;
  }

  public setPreSendCheckBehavior(
    handler: (sessionId: string) => Promise<PreSendCheckResult> | PreSendCheckResult
  ): void {
    this.preSendCheckHandler = handler;
  }

  public async selectSession(sessionId: string): Promise<boolean> {
    this.selectSessionCallsCount++;
    const exact = this.sessions.find(session => session.id === sessionId);
    const names = this.sessions.filter(session => session.name === sessionId);
    const session = exact ?? (names.length === 1 ? names[0] : undefined);
    if (!session) return false;
    const ok = this.selectSessionHandler ? await this.selectSessionHandler(session.id) : true;
    if (ok) this.currentSession = { ...session, active: true };
    return ok;
  }

  public getCurrentSession(): Promise<KK9Session | null> {
    return Promise.resolve(this.currentSession);
  }

  public markSessionRead(sessionId: string): Promise<boolean> {
    this.markSessionReadCallsCount++;
    const session = this.sessions.find(item => item.id === sessionId.trim());
    if (!session) return Promise.resolve(false);
    session.unread = false;
    session.unreadCount = 0;
    session.unreadAt = false;
    if (this.currentSession?.id === session.id) {
      this.currentSession.unread = false;
      this.currentSession.unreadCount = 0;
      this.currentSession.unreadAt = false;
    }
    return Promise.resolve(true);
  }

  public async preSendCheck(sessionId: string): Promise<PreSendCheckResult> {
    if (this.preSendCheckHandler) {
      return await this.preSendCheckHandler(sessionId);
    }
    return { canSend: true };
  }

  public async sendText(text: string, options?: SendOptions): Promise<SendResult> {
    if (options?.replyTo !== undefined) return this.sendReply(options.replyTo, text, options);
    return this.executeSendAction('text', 'text', text, options);
  }

  public async sendRichText(content: FormattedText, options?: SendOptions): Promise<SendResult> {
    if (options?.replyTo !== undefined) return this.sendReply(options.replyTo, content, options);
    return this.executeSendAction('rich-text', 'richText', content, options);
  }

  public async sendReply(
    replyTo: string | KK9ReplyTarget,
    content: FormattedText,
    options?: SendOptions
  ): Promise<SendResult> {
    return this.executeSendAction('reply', 'reply', content, { ...options, replyTo });
  }

  public async sendImage(imagePath: string, options?: SendOptions): Promise<SendResult> {
    return this.executeSendAction('image', 'image', imagePath, options);
  }

  public async sendFile(filePath: string, options?: SendFileOptions): Promise<SendResult> {
    return this.executeSendAction('file', 'file', filePath, options);
  }

  public async sendUrlCard(card: KK9UrlCardOptions, options?: SendOptions): Promise<SendResult> {
    return this.executeSendAction('url-card', 'urlCard', card, options, false);
  }

  public async sendBizMessage(
    message: KK9BizMsgOptions,
    options?: SendOptions
  ): Promise<SendResult> {
    return this.executeSendAction('biz-message', 'bizMessage', message, options, false);
  }

  public async sendAppMessage(
    message: KK9AppMsgOptions,
    options?: SendOptions
  ): Promise<SendResult> {
    return this.executeSendAction('app-message', 'appMessage', message, options, false);
  }

  public async sendChatRecord(
    record: KK9ChatRecordOptions,
    options?: SendOptions
  ): Promise<SendResult> {
    return this.executeSendAction('chat-record', 'chatRecord', record, options, false);
  }

  public async sendVoice(voice: KK9VoiceOptions, options?: SendOptions): Promise<SendResult> {
    return this.executeSendAction('voice', 'voice', voice, options, false);
  }
  public async getSendStatus(operationId: string): Promise<SendResult> {
    const operation = await this.sendOperationStore.get(operationId);
    return operation
      ? sendOperationRecordToResult(operation)
      : {
          operationId: operationId.trim(),
          status: 'unknown',
          isPreTrigger: false,
        };
  }

  public recallMessage(messageId: string, session: KK9Session | string): Promise<boolean> {
    const sessionId = typeof session === 'string' ? session.trim() : session?.id;
    const target = this.messages.find(message => message.sessionId === sessionId && message.id === messageId);
    if (!sessionId || !/^[1-9]\d*$/.test(sessionId) || !target || target.isRecalled ||
        !this.currentUserId || target.senderId !== this.currentUserId) return Promise.resolve(false);
    target.isRecalled = true;
    this.emitRecalled({ messageId, sessionId, sender: this.currentUserId,
      time: new Date().toLocaleTimeString(), timestamp: Date.now() });
    return Promise.resolve(true);
  }

  public getOrgEmployees(_timeoutMs?: number): Promise<KK9Employee[]> {
    return Promise.resolve(this.employees);
  }

  public getUserProfile(userId: number | string): Promise<KK9Employee | null> {
    const found = this.employees.find(e => String(e.id) === String(userId));
    return Promise.resolve(found || null);
  }

  public async getEmployeeBySession(session: string | KK9Session): Promise<KK9Employee | null> {
    const resolved =
      typeof session === 'string'
        ? this.sessions.find(item => item.id === session.trim())
        : session;
    return resolved?.type === 'private' && resolved.receiverId
      ? this.getUserProfile(resolved.receiverId)
      : null;
  }



  private async executeSendAction(
    operationType: SendOperationMessageType,
    callType: RecordedSendCall['type'],
    payload: FakeSendPayload,
    options?: SendOptions | SendFileOptions,
    supportsReplyAndMentions = true
  ): Promise<SendResult> {
    const operationId =
      options?.operationId === undefined ? randomUUID() : options.operationId.trim();
    const effectiveOptions: SendOptions | SendFileOptions = { ...options, operationId };
    const replyTo = options && 'replyTo' in options ? options.replyTo : undefined;
    const mentions = options && 'mentions' in options ? options.mentions : undefined;
    const fingerprint = createSendOperationFingerprint({
      targetSessionId: options?.targetSessionId,
      messageType: operationType,
      content: { payload, replyTo, mentions },
    });
    const claim = await this.sendOperationStore.claim({ operationId, fingerprint });
    if (!claim.claimed) return sendOperationRecordToResult(claim.operation);
    let textError: string | undefined;
    if (['text', 'rich-text', 'reply'].includes(operationType)) {
      try {
        const parsed = parseFormattedTextToKK(payload as FormattedText);
        const nodes = buildMentionNodes(mentions);
        if (!parsed.plainText.trim() && (operationType === 'reply' || nodes.length === 0)) throw new Error('文本内容不能为空');
        if (operationType === 'reply') {
          const target = typeof replyTo === 'string' ? { messageId: replyTo } : replyTo;
          if (!target || !/^[1-9]\d*$/.test(target.messageId) ||
              Object.keys(target).some(key => key !== 'messageId' && key !== 'msgIdx')) throw new Error('引用必须指定原生消息ID及可选准确索引');
          const message = this.messages.find(item => item.sessionId === options?.targetSessionId && item.id === target.messageId &&
            (target.msgIdx === undefined || item.msgIdx === target.msgIdx));
          if (!message || message.isRecalled || !message.senderId || !message.msgIdx) throw new Error('未在指定会话找到可引用的原生消息');
        }
      } catch (error) { textError = String(error); }
    }
    if (operationType === 'url-card' || operationType === 'biz-message' || operationType === 'app-message' || operationType === 'chat-record') {
      textError = getCardInputError(operationType, payload as KK9UrlCardOptions | KK9BizMsgOptions | KK9AppMsgOptions | KK9ChatRecordOptions);
      if (!textError && operationType === 'chat-record') {
        const record = payload as KK9ChatRecordOptions;
        if (record.msgArray.some(ref => !this.messages.some(message =>
          message.sessionId === record.sourceSessionId && message.id === ref.messageId &&
          message.msgIdx === ref.msgIdx && !message.isRecalled && message.senderId && message.sender))) {
          textError = '合并来源消息不存在、索引不符、已撤回或缺少真实作者';
        }
      }
    }
    let outcome: SendOutcome;
    if (!options?.targetSessionId?.trim()) {
      outcome = { status: 'failed', error: '发送必须指定明确原生会话ID', isPreTrigger: true };
    } else if (textError) {
      outcome = { status: 'failed', error: textError, isPreTrigger: true };
    } else if (!supportsReplyAndMentions && (replyTo !== undefined || mentions !== undefined)) {
      outcome = {
        status: 'failed',
        error: '原生卡片与语音消息不支持replyTo或mentions',
        isPreTrigger: true,
      };
    } else {
      this.recordedCalls.push({
        type: callType,
        payload,
        options: effectiveOptions,
        timestamp: Date.now(),
      });
      try {
        outcome = await this.executeSendBehavior(payload, effectiveOptions);
      } catch (error) {
        outcome = { status: 'unknown', error: String(error), isPreTrigger: false };
      }
    }
    const result = sendOperationRecordToResult(await this.sendOperationStore.update(operationId, outcome));
    if (result.status === 'sent' && effectiveOptions.targetSessionId) {
      this.confirmedSendKeys.set(createMessageIdentityKey(effectiveOptions.targetSessionId, result.messageId),
        createNativeMessageKey(operationType, operationId));
      if (this.confirmedSendKeys.size > 10000)
        this.confirmedSendKeys.delete(this.confirmedSendKeys.keys().next().value!);
    }
    return result;
  }

  private async executeSendBehavior(
    payload: FakeSendPayload,
    options?: SendOptions | SendFileOptions
  ): Promise<SendOutcome> {
    const active = this.currentBehavior;
    if (this.behaviorSequence.length > 0) {
      this.currentBehavior = this.behaviorSequence.shift()!;
    }

    switch (active.mode) {
      case 'success':
        return {
          status: 'sent',
          messageId:
            active.messageId ?? `kk_msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          isPreTrigger: false,
          verifyLatencyMs: 15,
        };

      case 'pre_trigger_failure':
        return {
          status: 'failed',
          error: active.error,
          isPreTrigger: true,
        };

      case 'post_trigger_timeout':
        return {
          status: 'unknown',
          error: active.error ?? 'CDP send timeout after trigger',
          isPreTrigger: false,
        };

      case 'post_trigger_disconnect':
        return {
          status: 'unknown',
          error: active.error ?? 'CDP disconnected during send verification',
          isPreTrigger: false,
        };

      case 'post_trigger_lost_response':
        return {
          status: 'unknown',
          error: active.error ?? 'Driver response lost after send action dispatched',
          isPreTrigger: false,
        };

      case 'custom':
        return await active.handler(payload, options);

      default:
        return {
          status: 'sent',
          messageId: `kk_msg_def_${Date.now()}`,
          isPreTrigger: false,
        };
    }
  }

  public emitMessage(msg: KK9Message): void {
    const normalized = normalizeNativeMessage(msg, { currentUserId: this.currentUserId ?? undefined })[0];
    if (!normalized) return;
    const key = createMessageIdentityKey(normalized.sessionId, normalized.id);
    if (this.knownMessageKeys.has(key)) return;
    this.knownMessageKeys.add(key);
    if (this.knownMessageKeys.size > 10000)
      this.knownMessageKeys.delete(this.knownMessageKeys.values().next().value!);
    if (normalized.direction === 'outbound') normalized.sdkSendKey = this.confirmedSendKeys.get(key);
    this.emit('message', normalized);
    if (normalized.atMe || normalized.atAll) this.emit('at', normalized);
  }

  public emitRecalled(evt: KK9RecalledEvent): void {
    if (!evt.sessionId || !evt.messageId) return;
    const key = createMessageIdentityKey(evt.sessionId, evt.messageId);
    if (this.knownRecalledMessageKeys.has(key)) return;
    this.knownRecalledMessageKeys.add(key);
    if (this.knownRecalledMessageKeys.size > 10000)
      this.knownRecalledMessageKeys.delete(this.knownRecalledMessageKeys.values().next().value!);
    this.emit('recalled', evt);
  }

  public reset(): void {
    this.recordedCalls.length = 0;
    this.selectSessionCallsCount = 0;
    this.markSessionReadCallsCount = 0;
    this.currentBehavior = { mode: 'success' };
    this.behaviorSequence = [];
    this.selectSessionHandler = undefined;
    this.preSendCheckHandler = undefined;
  }
}
