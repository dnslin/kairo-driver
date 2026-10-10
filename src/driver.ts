import EventEmitter from 'node:events';
import { CdpClient } from './cdp/client.js';
import { KK9EventBridge } from './bridge/event-bridge.js';
import { BridgeSessionOps } from './bridge/session-ops.js';
import { BridgeMessageOps } from './bridge/message-ops.js';
import { BridgeOrgOps } from './bridge/org-ops.js';
import { createMessageIdentityKey } from './bridge/converter.js';


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

  // 原生操作服务
  private readonly bridgeSessionOps: BridgeSessionOps;
  private readonly bridgeMessageOps: BridgeMessageOps;
  private readonly bridgeOrgOps: BridgeOrgOps;


  private readonly knownRecalledMessageKeys = new Set<string>();
  private currentUserId?: string | number;

  constructor(
    config: DriverConfig,
    sendOperationStore: SendOperationStore = new InMemorySendOperationStore()
  ) {
    super();
    this.cdp = new CdpClient(config.cdp, {
      startupGenerationId: config.startupGenerationId,
    });
    this.startupGenerationId = this.cdp.getStartupGenerationId();
    this.eventBridge = new KK9EventBridge(
      {
        cdp: config.cdp,
        startupGenerationId: this.startupGenerationId,
        rejectExistingBridge: config.rejectExistingBridge,
      },
      this.cdp
    );

    // 初始化 Bridge 操作层
    this.bridgeSessionOps = new BridgeSessionOps(this.cdp);
    this.bridgeMessageOps = new BridgeMessageOps(this.cdp, sendOperationStore);
    this.bridgeOrgOps = new BridgeOrgOps(this.cdp);


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


  /** 指定原生会话标记已读；不按名称解析，不默认当前窗口。 */
  public markSessionRead(sessionId: string): Promise<boolean> {
    return this.bridgeSessionOps.markSessionRead(sessionId);
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


  private attachNativeRecall(result: SendResult, targetSessionId?: string): SendResult {
    this.recordSendResult(result, targetSessionId);
    if (result.status !== 'sent') return result;

    const messageId = result.messageId;
    const sessionId = targetSessionId?.trim();
    return {
      ...result,
      recall: sessionId ? (): Promise<boolean> => this.recallMessage(messageId, sessionId) : undefined,
    };
  }

  /** 指定原生会话读取历史，不重放实时事件或回退 DOM。 */
  public getRecentMessages(session: KK9Session, limit = 20): Promise<KK9Message[]> {
    return this.bridgeMessageOps.getRecentMessages(
      session,
      limit,
      this.currentUserId
    );
  }

  public async scanCompensationWindow(options: CompensationScanOptions): Promise<KK9Message[]> {
    const toTimestamp = options.toTimestamp ?? Date.now();
    if (!Number.isFinite(options.fromTimestamp) || !Number.isFinite(toTimestamp) || options.fromTimestamp > toTimestamp) {
      throw new DriverError(
        `补偿扫描时间窗口无效: from=${options.fromTimestamp}, to=${toTimestamp}`,
        'COMPENSATION_SCAN_INVALID_WINDOW'
      );
    }
    const maxMessages = options.maxMessagesPerSession ?? 20;
    if (!Number.isSafeInteger(maxMessages) || maxMessages <= 0) throw new DriverError(`补偿扫描数量必须为正整数: ${maxMessages}`, 'COMPENSATION_SCAN_INVALID_LIMIT');
    if (this.getStatus() !== 'connected') {
      throw new DriverError(
        `补偿扫描需要已连接的 CDP (当前状态: ${this.getStatus()})`,
        'COMPENSATION_SCAN_UNAVAILABLE'
      );
    }

    try {
      const sessions: KK9Session[] = [];
      if (options.sessionIds) {
        for (const id of new Set(options.sessionIds)) {
          const session = await this.bridgeSessionOps.getSessionById(id);
          if (!session) throw new DriverError(`补偿扫描原生会话不存在: ${id}`, 'COMPENSATION_SCAN_SESSION_NOT_FOUND');
          sessions.push(session);
        }
      } else {
        sessions.push(...await this.getSessions());
      }
      const seen = new Set<string>();
      const recovered: KK9Message[] = [];

      for (const session of sessions) {
        const messages = await this.bridgeMessageOps.getMessagesInRange(session, options.fromTimestamp, toTimestamp, maxMessages, this.currentUserId);
        for (const message of messages) {
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

  /** 必须指定原生会话ID或实体；原生成功确认和实时通知共用撤回去重。 */
  public async recallMessage(messageId: string, session: KK9Session | string): Promise<boolean> {
    if (this.invalidated) return false;
    const sessionId = typeof session === 'string' ? session.trim() : session?.id;
    const success = await this.bridgeMessageOps.recallMessage(messageId, sessionId ?? '');
    if (success && !this.invalidated) {
      this.handleRecalledEvent({ messageId, sessionId,
        sender: String(this.currentUserId ?? '我'), time: new Date().toLocaleTimeString(), timestamp: Date.now() });
    }
    return success;
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

  /** 原生可见组织查询；正常空不切换实现，失败抛错。 */
  public getOrgEmployees(timeoutMs?: number): Promise<KK9Employee[]> {
    return this.bridgeOrgOps.getOrgEmployees(timeoutMs);
  }

  /**
   * 按 UID 精确单点查询员工档案
   */
  public getUserProfile(userId: number | string): Promise<KK9Employee | null> {
    return this.bridgeOrgOps.getUserProfile(userId);
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
