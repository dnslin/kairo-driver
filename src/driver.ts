import EventEmitter from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import { CdpClient } from './cdp/client.js';
import { KK9EventBridge } from './bridge/event-bridge.js';
import { BridgeSessionOps } from './bridge/session-ops.js';
import { BridgeMessageOps } from './bridge/message-ops.js';
import { BridgeOrgOps } from './bridge/org-ops.js';
import { createMessageIdentityKey, extractRecalledEventsFromPayload } from './bridge/converter.js';

import { OrgOps } from './dom/org-ops.js';
import { resolveSelectors } from './dom/selectors.js';
import { SessionOps } from './dom/session-ops.js';

import type {
  CdpConnectionLostEvent,
  CompensationScanOptions,
  ConnectionStatus,
  DriverConfig,
  DriverEvents,
  DriverHealthEvent,
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
  PollingConfig,
  SelectorsConfig,
  SendFileOptions,
  SendOptions,
  SendResult,
} from './types/index.js';
import { DriverError } from './utils/errors.js';
import { InMemorySendOperationStore, type SendOperationStore } from './send-operation.js';
import { createChildLogger } from './utils/logger.js';

const log = createChildLogger('kk9-driver');

// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export declare interface KK9Driver {
  on<U extends keyof DriverEvents>(event: U, listener: DriverEvents[U]): this;
  emit<U extends keyof DriverEvents>(event: U, ...args: Parameters<DriverEvents[U]>): boolean;
}

// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging, no-redeclare
export class KK9Driver extends EventEmitter implements IKK9Driver {
  private readonly cdp: CdpClient;
  private readonly eventBridge: KK9EventBridge;
  private readonly startupGenerationId: string;
  private invalidated = false;
  private disconnectPromise?: Promise<void>;
  private readonly selectors: SelectorsConfig;

  // Bridge 优先操作服务
  private readonly bridgeSessionOps: BridgeSessionOps;
  private readonly bridgeMessageOps: BridgeMessageOps;
  private readonly bridgeOrgOps: BridgeOrgOps;

  // 保留旧版 DOM 操作层（作为后备回退）
  private readonly domSessionOps: SessionOps;
  private readonly domOrgOps: OrgOps;

  private isPolling = false;
  private pollTimer: NodeJS.Timeout | null = null;
  private readonly knownMessageKeys = new Set<string>();
  private readonly knownRecalledMessageKeys = new Set<string>();
  private readonly knownBotSentMessageKeys = new Set<string>();
  private currentUserId?: string | number;

  constructor(
    private readonly config: DriverConfig,
    sendOperationStore: SendOperationStore = new InMemorySendOperationStore()
  ) {
    super();
    this.selectors = resolveSelectors(config.selectors);
    this.cdp = new CdpClient(config.cdp, {
      startupGenerationId: config.startupGenerationId,
    });
    this.startupGenerationId = this.cdp.getStartupGenerationId();
    this.eventBridge = new KK9EventBridge(
      {
        cdp: config.cdp,
        startupGenerationId: this.startupGenerationId,
        rejectExistingBridge: config.rejectExistingBridge,
        knownBotSentMessageKeys: this.knownBotSentMessageKeys,
      },
      this.cdp
    );

    // 初始化 Bridge 操作层
    this.bridgeSessionOps = new BridgeSessionOps(this.cdp);
    this.bridgeMessageOps = new BridgeMessageOps(this.cdp, sendOperationStore);
    this.bridgeOrgOps = new BridgeOrgOps(this.cdp);

    // 初始化 DOM 操作层 (保留)
    this.domSessionOps = new SessionOps(this.cdp, this.selectors);
    this.domOrgOps = new OrgOps(this.cdp);

    this.wireCdpEvents();
  }

  public getStatus(): ConnectionStatus {
    return this.cdp.getStatus();
  }

  public getStartupGenerationId(): string {
    return this.startupGenerationId;
  }

  public getHealthSnapshot(): DriverHealthSnapshot {
    return {
      startupGenerationId: this.startupGenerationId,
      cdpStatus: this.cdp.getStatus(),
      cdpConnectionIdentity: this.cdp.getConnectionIdentity(),
      eventBridgeAttached: this.eventBridge.isAttached(),
      eventBridgeConnectionIdentity: this.eventBridge.getConnectionIdentity(),
    };
  }

  public getCurrentUserId(): Promise<string | null> {
    return this.bridgeSessionOps.getCurrentUserId();
  }

  public async connect(): Promise<void> {
    if (this.invalidated) {
      throw new DriverError(
        `Driver 属于已失效的 startup generation ${this.startupGenerationId}，禁止原地重连`,
        'DRIVER_INVALIDATED'
      );
    }
    if (this.eventBridge.isAttached()) return;
    let bridgeOwnsCleanup = false;
    try {
      await this.cdp.connect();
      // 监听使用实际登录身份，不以配置值冒充当前账号。
      this.currentUserId = (await this.getCurrentUserId()) ?? undefined;
      // 进入 EventBridge.connect 后由桥接层负责失败清理及错误聚合。
      bridgeOwnsCleanup = true;
      await this.eventBridge.connect(this.currentUserId);
    } catch (error) {
      this.invalidated = true;
      if (!bridgeOwnsCleanup) {
        try {
          await this.disconnect();
        } catch (cleanupError) {
          throw new AggregateError([error, cleanupError], 'Driver 连接失败且清理失败');
        }
      }
      throw error;
    }
  }

  public disconnect(): Promise<void> {
    if (this.disconnectPromise) return this.disconnectPromise;
    this.invalidated = true;
    this.stopPolling();
    this.disconnectPromise = (async (): Promise<void> => {
      try {
        await this.bridgeMessageOps.cancelPendingSends();
      } finally {
        await this.eventBridge.disconnect();
      }
    })();
    return this.disconnectPromise;
  }

  /** 原生空列表正常返回，查询失败保留异常。 */
  public getSessions(): Promise<KK9Session[]> {
    return this.bridgeSessionOps.getSessions();
  }

  private async resolveSessionTarget(target: string): Promise<KK9Session | null> {
    const normalizedTarget = target.trim();
    if (!normalizedTarget) return null;

    const sessions = await this.getSessions();
    const idMatch = sessions.find(session => session.id === normalizedTarget);
    if (idMatch) return idMatch;

    const nameMatches = sessions.filter(session => session.name === normalizedTarget);
    return nameMatches.length === 1 ? nameMatches[0]! : null;
  }

  public getCurrentSession(): Promise<KK9Session | null> {
    return this.bridgeSessionOps.getCurrentSession();
  }

  public async selectSession(sessionId: string): Promise<boolean> {
    const targetSession = await this.resolveSessionTarget(sessionId);
    if (!targetSession) return false;

    const success = await this.bridgeSessionOps.selectSession(targetSession.id);
    if (success) return true;
    return this.domSessionOps.selectSession(targetSession.id);
  }

  /**
   * 显式消除指定会话的未读红点（优先通过 IPC readMessage 同步到服务端）
   */
  public async markSessionRead(sessionId: string): Promise<boolean> {
    const targetSession = await this.resolveSessionTarget(sessionId);
    return targetSession ? this.bridgeSessionOps.markSessionRead(targetSession.id) : false;
  }

  public recordBotSentMessageId(sessionId: string, messageId: string): void {
    const normalizedSessionId = sessionId.trim();
    const normalizedMessageId = messageId.trim();
    if (!normalizedSessionId || !normalizedMessageId) return;
    this.knownBotSentMessageKeys.add(
      createMessageIdentityKey(normalizedSessionId, normalizedMessageId)
    );
    if (this.knownBotSentMessageKeys.size > 10000) {
      const firstKey = this.knownBotSentMessageKeys.values().next().value;
      if (firstKey) this.knownBotSentMessageKeys.delete(firstKey);
    }
  }

  public isBotSentMessageId(sessionId: string, messageId: string): boolean {
    const normalizedSessionId = sessionId.trim();
    const normalizedMessageId = messageId.trim();
    if (!normalizedSessionId || !normalizedMessageId) return false;
    return this.knownBotSentMessageKeys.has(
      createMessageIdentityKey(normalizedSessionId, normalizedMessageId)
    );
  }

  private recordSendResult(result: SendResult, sessionId?: string): void {
    const status = result.status;
    const fields = {
      event: 'Driver发送结果',
      status,
      messageId: result.messageId,
      sessionId,
      startupGenerationId: this.startupGenerationId,
      durationMs: result.verifyLatencyMs,
      errorType: status === 'sent' ? undefined : status === 'unknown' ? 'send_unknown' : 'driver',
    };
    if (status === 'sent') {
      log.info(fields);
    } else {
      log.warn(fields);
    }
  }

  private rememberBotSentMessage(result: SendResult, targetSessionId?: string): void {
    if (result.status !== 'sent') return;
    const sessionId = targetSessionId?.trim();
    if (!sessionId) return;
    this.recordBotSentMessageId(sessionId, result.messageId);
  }

  private attachNativeRecall(result: SendResult, targetSessionId?: string): SendResult {
    this.rememberBotSentMessage(result, targetSessionId);
    this.recordSendResult(result, targetSessionId);
    if (result.status !== 'sent') return result;

    const messageId = result.messageId;
    const sessionId = targetSessionId?.trim();
    return {
      ...result,
      recall: () => this.bridgeMessageOps.recallMessage(messageId, sessionId),
    };
  }

  /** 指定原生会话读取历史，不重放实时事件或回退 DOM。 */
  public getRecentMessages(session: KK9Session, limit = 20): Promise<KK9Message[]> {
    return this.bridgeMessageOps.getRecentMessages(
      session,
      limit,
      this.knownBotSentMessageKeys,
      this.currentUserId
    );
  }

  public async scanCompensationWindow(options: CompensationScanOptions): Promise<KK9Message[]> {
    const toTimestamp = options.toTimestamp ?? Date.now();
    if (options.fromTimestamp > toTimestamp) {
      throw new DriverError(
        `补偿扫描时间窗口无效: from=${options.fromTimestamp}, to=${toTimestamp}`,
        'COMPENSATION_SCAN_INVALID_WINDOW'
      );
    }
    if (this.getStatus() !== 'connected') {
      throw new DriverError(
        `补偿扫描需要已连接的 CDP (当前状态: ${this.getStatus()})`,
        'COMPENSATION_SCAN_UNAVAILABLE'
      );
    }

    try {
      const allSessions = await this.getSessions();
      const requestedIds = options.sessionIds ? new Set(options.sessionIds) : null;
      const sessions = requestedIds
        ? allSessions.filter(session => requestedIds.has(session.id))
        : allSessions;
      const maxMessages = options.maxMessagesPerSession ?? 20;
      const switchDelayMs = options.switchDelayMs ?? this.config.polling?.switchDelayMs ?? 500;
      const seen = new Set<string>();
      const recovered: KK9Message[] = [];

      for (const session of sessions) {
        const switched = await this.selectSession(session.id);
        if (!switched) {
          throw new DriverError(
            `补偿扫描切换会话失败: ${session.id}`,
            'COMPENSATION_SCAN_SESSION_SWITCH_FAILED'
          );
        }
        if (switchDelayMs > 0) {
          await sleep(switchDelayMs);
        }

        const messages = await this.getRecentMessages(session, maxMessages);
        for (const message of messages) {
          if (message.timestamp < options.fromTimestamp || message.timestamp > toTimestamp) {
            continue;
          }
          const messageId = message.messageId || message.id;
          const key = createMessageIdentityKey(message.sessionId, messageId);

          if (seen.has(key)) {
            continue;
          }
          seen.add(key);
          recovered.push(message);
        }
      }

      return recovered;
    } catch (err) {
      if (err instanceof DriverError) {
        throw err;
      }
      const cause = err instanceof Error ? err : new Error(String(err));
      throw new DriverError(`补偿扫描失败: ${cause.message}`, 'COMPENSATION_SCAN_FAILED', cause);
    }
  }

  /**
   * 发送纯文本消息
   */
  public async sendText(text: string, options: SendOptions = {}): Promise<SendResult> {
    const targetSessionId = options.targetSessionId;
    return this.attachNativeRecall(
      await this.bridgeMessageOps.sendText(text, options),
      targetSessionId
    );
  }

  /**
   * 发送富文本与带 @ 提及的消息
   */
  public async sendRichText(
    content: FormattedText,
    options: SendOptions = {}
  ): Promise<SendResult> {
    const targetSessionId = options.targetSessionId;
    return this.attachNativeRecall(
      await this.bridgeMessageOps.sendRichText(content, options),
      targetSessionId
    );
  }

  /**
   * 发送引用/回复消息
   */
  public async sendReply(
    replyTo: string | KK9ReplyTarget,
    content: FormattedText,
    options: SendOptions = {}
  ): Promise<SendResult> {
    const targetSessionId = options.targetSessionId;
    return this.attachNativeRecall(
      await this.bridgeMessageOps.sendReply(replyTo, content, options),
      targetSessionId
    );
  }

  /**
   * 发送文件
   */
  public async sendFile(filePath: string, options: SendFileOptions = {}): Promise<SendResult> {
    const targetSessionId = options.targetSessionId;
    return this.attachNativeRecall(
      await this.bridgeMessageOps.sendFile(filePath, options),
      targetSessionId
    );
  }
  /**
   * 只查询发送操作状态，不触发新的发送动作
   */
  public getSendStatus(operationId: string): Promise<SendResult> {
    return this.bridgeMessageOps.getSendStatus(operationId);
  }

  /**
   * 发送本地图片
   */
  public async sendImage(imagePath: string, options: SendOptions = {}): Promise<SendResult> {
    const targetSessionId = options.targetSessionId;
    return this.attachNativeRecall(
      await this.bridgeMessageOps.sendImage(imagePath, options),
      targetSessionId
    );
  }

  /** 发送链接图文卡片。 */
  public async sendUrlCard(
    card: KK9UrlCardOptions,
    options: SendOptions = {}
  ): Promise<SendResult> {
    const targetSessionId = options.targetSessionId;
    const result = await this.bridgeMessageOps.sendUrlCard(card, options);
    return this.attachNativeRecall(result, targetSessionId);
  }

  /** 发送业务任务或通知卡片。 */
  public async sendBizMessage(
    message: KK9BizMsgOptions,
    options: SendOptions = {}
  ): Promise<SendResult> {
    const targetSessionId = options.targetSessionId;
    const result = await this.bridgeMessageOps.sendBizMessage(message, options);
    return this.attachNativeRecall(result, targetSessionId);
  }

  /** 发送工作台微应用通知卡片。 */
  public async sendAppMessage(
    message: KK9AppMsgOptions,
    options: SendOptions = {}
  ): Promise<SendResult> {
    const targetSessionId = options.targetSessionId;
    const result = await this.bridgeMessageOps.sendAppMessage(message, options);
    return this.attachNativeRecall(result, targetSessionId);
  }

  /** 发送合并聊天记录卡片。 */
  public async sendChatRecord(
    record: KK9ChatRecordOptions,
    options: SendOptions = {}
  ): Promise<SendResult> {
    const targetSessionId = options.targetSessionId;
    const result = await this.bridgeMessageOps.sendChatRecord(record, options);
    return this.attachNativeRecall(result, targetSessionId);
  }

  /** 准备并发送原生语音消息。 */
  public async sendVoice(voice: KK9VoiceOptions, options: SendOptions = {}): Promise<SendResult> {
    const targetSessionId = options.targetSessionId;
    const result = await this.bridgeMessageOps.sendVoice(voice, options);
    return this.attachNativeRecall(result, targetSessionId);
  }

  /**
   * 消息撤回 (Recall / CancelMessage)
   */
  public async recallMessage(messageId: string, session?: KK9Session | string): Promise<boolean> {
    if (typeof session === 'string') {
      const targetSession = await this.resolveSessionTarget(session);
      return targetSession
        ? this.bridgeMessageOps.recallMessage(messageId, targetSession.id)
        : false;
    }
    return this.bridgeMessageOps.recallMessage(messageId, session?.id);
  }

  private handleRecalledEvent(event: KK9RecalledEvent): void {
    if (!event.messageId || !event.sessionId) {
      log.warn(
        { messageId: event.messageId, sessionId: event.sessionId },
        '丢弃缺少入站身份字段的撤回事件'
      );
      return;
    }
    const messageKey = createMessageIdentityKey(event.sessionId, event.messageId);

    if (this.knownRecalledMessageKeys.has(messageKey)) {
      return;
    }
    this.knownRecalledMessageKeys.add(messageKey);
    if (this.knownRecalledMessageKeys.size > 10000) {
      const firstKey = this.knownRecalledMessageKeys.values().next().value;
      if (firstKey) this.knownRecalledMessageKeys.delete(firstKey);
    }

    log.info({ messageId: event.messageId, sender: event.sender }, '捕获到消息撤回事件并派发');
    this.emit('recalled', event);
  }

  /**
   * 优先通过 Bridge / IPC 递归遍历企业全量员工档案
   */
  public async getOrgEmployees(timeoutMs?: number): Promise<KK9Employee[]> {
    const employees = await this.bridgeOrgOps.getOrgEmployees(timeoutMs);
    if (employees.length > 0) {
      return employees;
    }
    return this.domOrgOps.getEmployees(timeoutMs);
  }

  /**
   * 按 UID 精确单点查询员工档案
   */
  public async getUserProfile(userId: number | string): Promise<KK9Employee | null> {
    const profile = await this.bridgeOrgOps.getUserProfile(userId);
    if (profile) {
      return profile;
    }
    return this.domOrgOps.getUserProfile(userId);
  }

  /** 通过原生会话 ID 或实体查询私聊对端档案；用户 UID 请使用 getUserProfile。 */
  public async getEmployeeBySession(session: string | KK9Session): Promise<KK9Employee | null> {
    if (typeof session === 'string' && !session.trim()) return null;
    const resolved =
      typeof session === 'string'
        ? (await this.getSessions()).find(item => item.id === session.trim())
        : session;
    return resolved?.type === 'private' && resolved.receiverId
      ? this.getUserProfile(resolved.receiverId)
      : null;
  }

  public startPolling(customPolling?: Partial<PollingConfig>): void {
    if (this.isPolling) return;

    const pollConfig: PollingConfig = {
      intervalMs: customPolling?.intervalMs ?? this.config.polling?.intervalMs ?? 3000,
      switchDelayMs: customPolling?.switchDelayMs ?? this.config.polling?.switchDelayMs ?? 500,
      maxSessionsPerCycle:
        customPolling?.maxSessionsPerCycle ?? this.config.polling?.maxSessionsPerCycle ?? 10,
      maxMessagesPerSession:
        customPolling?.maxMessagesPerSession ?? this.config.polling?.maxMessagesPerSession ?? 20,
      autoSwitchSession:
        customPolling?.autoSwitchSession ?? this.config.polling?.autoSwitchSession ?? true,
    };

    this.isPolling = true;
    log.info(pollConfig, '启动消息智能轮询器');

    const pollLoop = async (): Promise<void> => {
      if (!this.isPolling) return;

      try {
        if (this.getStatus() === 'connected') {
          await this.executePollCycle(pollConfig);
        }
      } catch (err) {
        log.warn({ err: String(err) }, '轮询周期异常，等待下一周期');
      }

      if (this.isPolling) {
        this.pollTimer = setTimeout(() => {
          void pollLoop();
        }, pollConfig.intervalMs);
      }
    };

    void pollLoop();
  }

  public stopPolling(): void {
    this.isPolling = false;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    log.info('已停止消息轮询器');
  }

  private async executePollCycle(config: PollingConfig): Promise<void> {
    if (config.autoSwitchSession === false) {
      const current = await this.getCurrentSession();
      if (current) {
        await this.collectAndEmitMessages(current, config.maxMessagesPerSession);
      }
      return;
    }

    const sessions = await this.getSessions();
    const unreadSessions = sessions
      .filter(s => s.unread || s.unreadAt)
      .sort((a, b) => {
        if (a.unreadAt && !b.unreadAt) return -1;
        if (!a.unreadAt && b.unreadAt) return 1;
        return (b.unreadCount || 0) - (a.unreadCount || 0);
      });

    if (unreadSessions.length > 0) {
      const batch = unreadSessions.slice(0, config.maxSessionsPerCycle);
      for (const session of batch) {
        if (!this.isPolling) break;

        const switched = await this.selectSession(session.id);
        if (switched) {
          await sleep(config.switchDelayMs);
          await this.collectAndEmitMessages(session, config.maxMessagesPerSession);
        }
      }
    } else {
      const current = await this.getCurrentSession();
      if (current) {
        await this.collectAndEmitMessages(current, config.maxMessagesPerSession);
      }
    }
  }

  private async collectAndEmitMessages(session: KK9Session, limit: number): Promise<void> {
    const messages = await this.getRecentMessages(session, limit);
    for (const msg of messages) {
      // 历史撤回只供查询，不能经轮询重放为新的消息、提及或撤回事件。
      if (
        msg.isRecalled ||
        (msg.messageType === 'system' &&
          extractRecalledEventsFromPayload(msg.raw, session).length > 0)
      ) {
        continue;
      }
      const messageKey = createMessageIdentityKey(msg.sessionId, msg.id);

      if (!this.knownMessageKeys.has(messageKey)) {
        this.knownMessageKeys.add(messageKey);
        if (this.knownMessageKeys.size > 10000) {
          const firstKey = this.knownMessageKeys.values().next().value;
          if (firstKey) this.knownMessageKeys.delete(firstKey);
        }

        log.debug(
          {
            id: msg.id,
            messageId: msg.messageId ?? msg.id,
            sessionId: msg.sessionId,
            sender: msg.sender,
            direction: msg.direction,
            origin: msg.origin,
            status: 'received',
          },
          '捕获新消息并触发事件'
        );
        this.emit('message', msg);

        if (msg.atMe || msg.atAll || msg.mentions?.isAtMe || msg.mentions?.isAtAll) {
          log.info({ id: msg.id, sender: msg.sender, mentions: msg.mentions }, '捕获到 @ 提及事件');
          this.emit('at', msg);
        }
      }
    }
  }

  private wireCdpEvents(): void {
    this.cdp.on('status', (status: ConnectionStatus) => this.emit('status', status));
    this.cdp.on('heartbeat', (uptime: number) => this.emit('heartbeat', uptime));
    this.cdp.on('connection_lost', (event: CdpConnectionLostEvent) => {
      this.invalidated = true;
      const health: DriverHealthEvent = {
        kind: 'cdp_invalidated',
        startupGenerationId: this.startupGenerationId,
        connectionIdentity: event.connectionIdentity,
        observedAt: event.observedAt,
        cause: event.cause,
      };
      this.emit('health', health);
    });

    this.eventBridge.on('message', (message: KK9Message) => this.emit('message', message));
    this.eventBridge.on('at', (message: KK9Message) => this.emit('at', message));
    this.eventBridge.on('recalled', (event: KK9RecalledEvent) => this.handleRecalledEvent(event));
    this.eventBridge.on('health', (event: DriverHealthEvent) => {
      this.invalidated = true;
      this.emit('health', event);
    });
    this.eventBridge.on('error', (err: Error) => {
      this.invalidated = true;
      this.emit('error', err);
    });
  }
}
