import { randomUUID } from 'node:crypto';
import EventEmitter from 'node:events';
import { CdpClient } from '../cdp/client.js';
import type {
  CdpConfig,
  CdpConnectionIdentity,
  CdpConnectionLostEvent,
  ConnectionStatus,
  DriverConfig,
  DriverHealthEvent,
  EventBridgeConfig,
  DriverEvents,
  KK9Message,
  KK9RecalledEvent,
  KK9Session,
} from '../types/index.js';
import { createChildLogger } from '../utils/logger.js';
import {
  createMessageIdentityKey,
  type InboundNormalizationDiagnostic,
  extractRecalledEventsFromPayload,
  normalizeNativeMessage,
  normalizeRecalledEvent,
} from './converter.js';

const log = createChildLogger('event-bridge');

const DEFAULT_BINDING_NAME = '__kairo_native_bridge';
const DEFAULT_MAX_MESSAGE_IDS = 10000;

// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export declare interface KK9EventBridge {
  on<U extends keyof DriverEvents>(event: U, listener: DriverEvents[U]): this;
  emit<U extends keyof DriverEvents>(event: U, ...args: Parameters<DriverEvents[U]>): boolean;
}

// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging, no-redeclare
export class KK9EventBridge extends EventEmitter {
  private readonly cdp: CdpClient;
  private readonly startupGenerationId: string;
  private readonly bindingName: string;
  private readonly maxMessageIds: number;
  private currentUserId?: string | number;
  private readonly enableRecallHook: boolean;
  private readonly rejectExistingBridge: boolean;
  private attached = false;
  private isConnecting = false;
  private lastAttachError: Error | null = null;
  private injectionIdentity: CdpConnectionIdentity | null = null;
  // 健康身份会在断线时清空，清理责任必须保留到本实例关闭。
  private cleanupConnectionId: string | null = null;
  private disconnectPromise: Promise<void> | null = null;
  private readonly knownMessageKeys = new Set<string>();
  private readonly knownRecalledMessageKeys = new Set<string>();

  constructor(
    config: EventBridgeConfig | DriverConfig | { cdp: CdpConfig },
    cdpClient?: CdpClient
  ) {
    super();
    const bridgeConfig = config as EventBridgeConfig;
    this.startupGenerationId = bridgeConfig.startupGenerationId ?? randomUUID();
    this.bindingName = bridgeConfig.bindingName || DEFAULT_BINDING_NAME;
    this.maxMessageIds = bridgeConfig.maxMessageIds || DEFAULT_MAX_MESSAGE_IDS;
    this.currentUserId = bridgeConfig.currentUserId;
    this.enableRecallHook = bridgeConfig.enableRecallHook ?? true;
    this.rejectExistingBridge = bridgeConfig.rejectExistingBridge === true;

    this.cdp =
      cdpClient || new CdpClient(config.cdp, { startupGenerationId: this.startupGenerationId });
    this.wireCdpEvents();
  }

  /**
   * 获取底层连接状态
   */
  public getStatus(): ConnectionStatus {
    return this.cdp.getStatus();
  }
  public getStartupGenerationId(): string {
    return this.startupGenerationId;
  }

  public getConnectionIdentity(): CdpConnectionIdentity | null {
    return this.injectionIdentity;
  }

  /**
   * 检查页面 Hook 是否已成功注入
   */
  public isAttached(): boolean {
    return this.attached;
  }

  /**
   * 获取底层 CDP 客户端实例
   */
  public getCdpClient(): CdpClient {
    return this.cdp;
  }


  /**
   * 连接 CDP 并完成原生事件桥注入；可在注入前传入本代已读取的登录身份。
   */
  public async connect(currentUserId?: string | number): Promise<void> {
    if (this.disconnectPromise) {
      throw new Error('EventBridge 已关闭，禁止原地重连');
    }
    if (this.getStatus() === 'connected' && this.attached) {
      return;
    }
    if (this.isConnecting) {
      return;
    }

    this.isConnecting = true;
    try {
      if (currentUserId !== undefined) this.currentUserId = currentUserId;
      if (this.getStatus() !== 'connected') {
        await this.cdp.connect();
      }
      const attached = await this.reattach();
      if (!attached) {
        const cause =
          this.lastAttachError ??
          new Error(`EventBridge 注入失败 (启动代次: ${this.startupGenerationId})`);
        throw new Error(`EventBridge 注入失败 (启动代次: ${this.startupGenerationId})`, { cause });
      }
      log.info(
        { binding: this.bindingName, startupGenerationId: this.startupGenerationId },
        'KK9 原生事件直连桥就绪'
      );
    } catch (error) {
      try {
        await this.disconnect();
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], 'EventBridge 连接失败且清理失败');
      }
      throw error;
    } finally {
      this.isConnecting = false;
    }
  }

  /**
   * 主动断开连接并清理事件桥
   */
  public disconnect(): Promise<void> {
    this.disconnectPromise ??= this.closeOwnedResources();
    return this.disconnectPromise;
  }

  private async closeOwnedResources(): Promise<void> {
    this.attached = false;
    this.injectionIdentity = null;
    const errors: unknown[] = [];
    try {
      if (this.cleanupConnectionId !== null && this.cdp.getStatus() !== 'connected') {
        // 失联是已知状态，不把未执行的远端清理伪装成新的关闭异常。
        log.warn(
          {
            event: 'Driver运行异常',
            status: 'down',
            errorType: 'driver',
            startupGenerationId: this.startupGenerationId,
          },
          'CDP 已失联，远端 Hook 留待新代接管时清理'
        );
      } else if (this.cleanupConnectionId !== null) {
        const result = await this.cdp.evaluate<{ owned: boolean; error?: string }>(
          this.buildInBrowserCleanupScript(this.cleanupConnectionId)
        );
        if (result?.owned) {
          if (result.error) errors.push(new Error(`EventBridge 清理失败: ${result.error}`));
          await this.cdp.sendCommand('Runtime.removeBinding', { name: this.bindingName });
        }
      }
    } catch (error) {
      errors.push(error);
    } finally {
      this.cleanupConnectionId = null;
      try {
        await this.cdp.disconnect();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, 'EventBridge 资源清理失败');
    log.info({ startupGenerationId: this.startupGenerationId }, 'KK9 原生事件直连桥已断开');
  }

  private buildInBrowserCleanupScript(connectionId: string): string {
    return `(() => {
      const cleanup = window.__kairo_bridge_cleanup;
      if (typeof cleanup === 'function' &&
          (cleanup.generationId !== ${JSON.stringify(this.startupGenerationId)} ||
           cleanup.connectionId !== ${JSON.stringify(connectionId)})) {
        return { owned: false };
      }
      const binding = window[${JSON.stringify(this.bindingName)}];
      let error;
      try {
        if (typeof cleanup === 'function') cleanup();
      } catch (cause) {
        error = String(cause);
      } finally {
        if (window[${JSON.stringify(this.bindingName)}] === binding) {
          delete window[${JSON.stringify(this.bindingName)}];
        }
      }
      return { owned: true, error };
    })()`;
  }

  /**
   * 重新注入 CDP Binding 与渲染进程 Hook 脚本
   */
  public async reattach(): Promise<boolean> {
    if (this.disconnectPromise) return false;
    const connectionIdentity = this.getCdpConnectionIdentity();
    if (this.attached && this.sameConnectionIdentity(this.injectionIdentity, connectionIdentity)) {
      return true;
    }

    if (connectionIdentity && connectionIdentity.startupGenerationId !== this.startupGenerationId) {
      const cause = new Error(
        `CDP 连接身份属于启动代次 ${connectionIdentity.startupGenerationId}，期望 ${this.startupGenerationId}`
      );
      this.lastAttachError = cause;
      this.emitHealth('connection_identity_mismatch', cause, connectionIdentity);
      return false;
    }

    try {
      await this.cdp.sendCommand('Runtime.enable');
      await this.cdp.sendCommand('Runtime.addBinding', { name: this.bindingName });
      this.cleanupConnectionId = connectionIdentity?.connectionId ?? '';

      const hookScript = this.buildInBrowserHookScript(connectionIdentity);
      const injectionResult = await this.cdp.evaluate<{
        ok?: boolean;
        busFound?: boolean;
        nativeAttached?: boolean;
        sessionsHooked?: number;
      }>(hookScript);
      if (this.disconnectPromise) throw new Error('EventBridge 注入期间已关闭');
      if (!injectionResult?.ok || injectionResult.nativeAttached !== true) {
        throw new Error(
          `EventBridge 注入返回无效: ok=${String(injectionResult?.ok)}, busFound=${String(injectionResult?.busFound)}, nativeAttached=${String(injectionResult?.nativeAttached)}`
        );
      }
      this.injectionIdentity = connectionIdentity;
      this.lastAttachError = null;
      this.attached = true;
      log.debug(
        { binding: this.bindingName, startupGenerationId: this.startupGenerationId },
        '原生事件桥 Hook 注入成功'
      );
      return true;
    } catch (err) {
      const cause = err instanceof Error ? err : new Error(String(err));
      this.lastAttachError = cause;
      log.warn(
        {
          event: 'Driver运行异常',
          errorType: 'driver',
          startupGenerationId: this.startupGenerationId,
        },
        '注入原生事件桥 Hook 失败'
      );
      this.attached = false;
      this.injectionIdentity = null;
      this.emitHealth('event_bridge_invalidated', cause, connectionIdentity);
      return false;
    }
  }

  private getCdpConnectionIdentity(): CdpConnectionIdentity | null {
    const cdp = this.cdp as CdpClient & {
      getConnectionIdentity?: () => CdpConnectionIdentity | null;
    };
    return typeof cdp.getConnectionIdentity === 'function' ? cdp.getConnectionIdentity() : null;
  }
  private sameConnectionIdentity(
    left: CdpConnectionIdentity | null,
    right: CdpConnectionIdentity | null
  ): boolean {
    if (left === null || right === null) {
      return left === right;
    }
    return (
      left.startupGenerationId === right.startupGenerationId &&
      left.connectionId === right.connectionId
    );
  }

  private emitHealth(
    kind: DriverHealthEvent['kind'],
    cause: Error,
    connectionIdentity: CdpConnectionIdentity | null
  ): void {
    const event: DriverHealthEvent = {
      kind,
      startupGenerationId: this.startupGenerationId,
      connectionIdentity,
      expectedConnectionIdentity: this.injectionIdentity,
      observedAt: Date.now(),
      cause,
    };
    this.emit('health', event);
  }
  private reportNormalizationDiagnostic(diagnostic: InboundNormalizationDiagnostic): void {
    log.warn(
      {
        kind: diagnostic.kind,
        missingFields: diagnostic.missingFields,
        sessionId: diagnostic.sessionId,
        source: diagnostic.source,
        observedAt: diagnostic.observedAt,
      },
      '丢弃缺少入站身份字段的消息'
    );
  }

  /**
   * 解析外部原始消息载荷并返回标准 KK9Message 实体
   */
  public parseRawMessage(raw: unknown, sessionContext?: Partial<KK9Session>): KK9Message[] {
    return normalizeNativeMessage(raw, {
      session: sessionContext,
      currentUserId: this.currentUserId,
      source: 'event_bridge',
      onDiagnostic: diagnostic => this.reportNormalizationDiagnostic(diagnostic),
    });
  }

  /**
   * 处理从 CDP Runtime.bindingCalled 接收到的事件数据
   */
  private handleBindingPayload(payloadStr: string): void {
    if (!this.attached) {
      return;
    }

    let parsed: {
      type?: string;
      data?: unknown;
      event?: string;
      generationId?: string;
      connectionId?: string;
    } | null = null;
    try {
      parsed = JSON.parse(payloadStr) as {
        type?: string;
        data?: unknown;
        event?: string;
        generationId?: string;
        connectionId?: string;
      };
    } catch (err) {
      const errorType = err instanceof Error ? err.constructor.name : typeof err;
      log.warn({ errorType }, '收到非 JSON 格式的原生事件载荷');
      return;
    }

    if (!parsed || typeof parsed !== 'object') {
      return;
    }

    if (parsed.generationId && parsed.generationId !== this.startupGenerationId) {
      const cause = new Error(
        `EventBridge 事件属于启动代次 ${parsed.generationId}，期望 ${this.startupGenerationId}`
      );
      this.emitHealth('connection_identity_mismatch', cause, this.getCdpConnectionIdentity());
      return;
    }

    if (
      parsed.connectionId &&
      this.injectionIdentity?.connectionId &&
      parsed.connectionId !== this.injectionIdentity.connectionId
    ) {
      const cause = new Error(
        `EventBridge 事件连接身份 ${parsed.connectionId} 与当前注入身份不一致`
      );
      this.emitHealth('connection_identity_mismatch', cause, this.getCdpConnectionIdentity());
      return;
    }

    const currentIdentity = this.getCdpConnectionIdentity();
    if (!this.sameConnectionIdentity(this.injectionIdentity, currentIdentity)) {
      const cause = new Error('EventBridge 注入身份与当前 CDP 连接身份不一致');
      this.attached = false;
      this.emitHealth('connection_identity_mismatch', cause, currentIdentity);
      return;
    }

    const eventType = parsed.type || parsed.event;
    const data = parsed.data !== undefined ? parsed.data : parsed;

    // 1. 优先提取载荷中可能包含的消息撤回事件
    if (this.enableRecallHook) {
      const recalledEvents = extractRecalledEventsFromPayload(data);
      for (const evt of recalledEvents) {
        this.handleRecalledEvent(evt);
      }
    }

    // 2. 分发业务事件
    switch (eventType) {
      case 'receive-message': {
        this.handleIncomingMessages(data);
        break;
      }
      case 'send-confirmed': {
        const confirmed = data as { key?: string; payload?: unknown };
        if (typeof confirmed.key === 'string')
          this.handleIncomingMessages(confirmed.payload, undefined, confirmed.key);
        break;
      }
      case 'recalled':
      case 'CancelMessage':
      case 'revokeMsg': {
        this.handleRecalledPayload(data);
        break;
      }
      default:
        break;
    }
  }

  /**
   * 标准化消息并派发 message 和 at 事件
   */
  private handleIncomingMessages(payload: unknown, sessionContext?: Partial<KK9Session>, sdkSendKey?: string): void {
    const messages = normalizeNativeMessage(payload, {
      session: sessionContext,
      currentUserId: this.currentUserId,
      source: 'event_bridge',
      onDiagnostic: diagnostic => this.reportNormalizationDiagnostic(diagnostic),
    });
    for (const msg of messages) {
      if (sdkSendKey && msg.direction === 'outbound') msg.sdkSendKey = sdkSendKey;
      const messageKey = createMessageIdentityKey(msg.sessionId, msg.id);

      if (this.knownMessageKeys.has(messageKey)) {
        continue;
      }

      this.recordMessageId(messageKey);
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
        '原生事件桥接收到新消息'
      );
      this.emit('message', msg);

      if (msg.atMe || msg.atAll || msg.mentions?.isAtMe || msg.mentions?.isAtAll) {
        log.info({ id: msg.id, sender: msg.sender, mentions: msg.mentions }, '捕获到 @ 提及事件');
        this.emit('at', msg);
      }
    }
  }

  /**
   * 处理撤回事件并去重派发
   */
  private handleRecalledPayload(payload: unknown): void {
    if (!this.enableRecallHook) return;
    const evt = normalizeRecalledEvent(payload);
    if (!evt || !evt.messageId || !evt.sessionId) return;
    this.handleRecalledEvent(evt);
  }

  /**
   * 触发单条撤回事件
   */
  private handleRecalledEvent(evt: KK9RecalledEvent): void {
    if (!this.enableRecallHook || !evt.messageId || !evt.sessionId) return;
    const messageKey = createMessageIdentityKey(evt.sessionId, evt.messageId);
    if (this.knownRecalledMessageKeys.has(messageKey)) {
      return;
    }

    this.recordRecalledKey(messageKey);
    log.info(
      { messageId: evt.messageId, sessionId: evt.sessionId, sender: evt.sender },
      '捕获到原生消息撤回事件'
    );
    this.emit('recalled', evt);
  }

  /**
   * 记录去重消息 ID（带 FIFO 淘汰）
   */
  private recordMessageId(messageKey: string): void {
    this.knownMessageKeys.add(messageKey);
    if (this.knownMessageKeys.size > this.maxMessageIds) {
      const oldest = this.knownMessageKeys.values().next().value;
      if (oldest) this.knownMessageKeys.delete(oldest);
    }
  }

  /**
   * 记录已撤回消息 ID（带 FIFO 淘汰）
   */
  private recordRecalledKey(messageKey: string): void {
    this.knownRecalledMessageKeys.add(messageKey);
    if (this.knownRecalledMessageKeys.size > this.maxMessageIds) {
      const oldest = this.knownRecalledMessageKeys.values().next().value;
      if (oldest) this.knownRecalledMessageKeys.delete(oldest);
    }
  }

  /**
   * 监听底层 CDP 状态、心跳与 binding 回调
   */
  private wireCdpEvents(): void {
    this.cdp.on('status', (status: ConnectionStatus) => {
      this.emit('status', status);
      if (status !== 'connected') {
        this.attached = false;
        this.injectionIdentity = null;
      }
    });

    this.cdp.on('connection_lost', (event: CdpConnectionLostEvent) => {
      const wasAttached = this.attached;
      this.attached = false;
      this.injectionIdentity = null;
      if (wasAttached) {
        this.emitHealth('event_bridge_invalidated', event.cause, event.connectionIdentity);
      }
    });

    this.cdp.on('heartbeat', (uptime: number) => this.emit('heartbeat', uptime));
    this.cdp.on('error', (err: Error) => this.emit('error', err));

    this.cdp.on('Runtime.bindingCalled', (rawParams: unknown) => {
      const params = rawParams as { name?: string; payload?: string };
      if (
        this.attached &&
        params?.name === this.bindingName &&
        typeof params.payload === 'string'
      ) {
        this.handleBindingPayload(params.payload);
      }
    });
  }

  /**
   * 构建渲染进程中的 JS Hook 注入脚本
   */
  private buildInBrowserHookScript(connectionIdentity: CdpConnectionIdentity | null): string {
    const binding = this.bindingName;
    const generationId = JSON.stringify(this.startupGenerationId);
    const connectionId = JSON.stringify(connectionIdentity?.connectionId ?? '');
    return `
      (() => {
        if (typeof window.__kairo_bridge_cleanup === 'function') {
          if (${this.rejectExistingBridge} && window.__kairo_bridge_cleanup.generationId !== ${generationId}) {
            throw new Error('已有其他Driver桥接，拒绝接管');
          }
          try {
            window.__kairo_bridge_cleanup();
          } catch {
            console.warn('[KairoDriver] 前序Hook清理异常');
          }
        }

        let active = true;
        function postEvent(type, data) {
          if (!active) return;
          if (typeof window[${JSON.stringify(binding)}] === 'function') {
            try {
              window[${JSON.stringify(binding)}](JSON.stringify({ generationId: ${generationId}, connectionId: ${connectionId}, type, data, timestamp: Date.now() }));
            } catch {
              console.error('[KairoDriver] 事件派发到CDP binding失败');
            }
          }
        }

        // Vue 仅保留 T05 尚未验收的本机手工撤回捕获，不参与普通消息接收。
        const getMainPageVm = () => typeof document === 'undefined' ? null : document.querySelector('#main-page, .main-page, #app, .app-container')?.__vue__;
        const getEditorVm = () => typeof document === 'undefined' ? null : document.querySelector('.chat-editor, .message-editor, .chat-sendArea')?.__vue__;
        const getChatContentVm = () => {
          if (typeof document === 'undefined') return null;
          const containers = Array.from(document.querySelectorAll('.chat-container, .chat-content, .message-content-box'));
          for (const node of containers) {
            const vm = node.__vue__;
            if (vm && (vm.$options?.name === 'chat-content' || vm.$options?._componentTag === 'chat-content')) {
              return vm;
            }
          }
          return document.querySelector('.chat-content, .message-content-box')?.__vue__ || null;
        };

        const getBus = () => {
          const main = getMainPageVm();
          const editor = getEditorVm();
          const chat = getChatContentVm();
          return main?.$bus || editor?.$bus || chat?.$bus || window.vueBus || window.$bus || null;
        };

        const bus = ${this.enableRecallHook} ? getBus() : null;
        const electron = window.require ? window.require('electron') : null;
        const ipc = window.ipcRenderer || electron?.ipcRenderer;
        const nativeAttached = Boolean(ipc && typeof ipc.on === 'function' && typeof ipc.removeListener === 'function');
        if (!nativeAttached) throw new Error('原生消息接收通道不可用');
        const unbindFns = [];
        const hookedSessions = new Set();
        const knownSessions = new Map();
        let observer = null;
        const cleanup = () => {
          active = false;
          const errors = [];
          for (const unbind of unbindFns.splice(0)) {
            try { unbind(); } catch (error) { errors.push(error); }
          }
          if (observer) {
            try { observer.disconnect(); } catch (error) { errors.push(error); }
            observer = null;
          }
          if (window.__kairo_bridge_cleanup === cleanup) delete window.__kairo_bridge_cleanup;
          if (errors.length) throw new AggregateError(errors, 'EventBridge Hook 清理失败');
        };
        cleanup.generationId = ${generationId};
        cleanup.connectionId = ${connectionId};
        window.__kairo_bridge_cleanup = cleanup;

        function resolveSenderName(senderId, msgId, sesUUID) {
          const main = getMainPageVm();
          const editor = getEditorVm();
          const myUid = main?.userID || editor?.userID;
          const myName = editor?.activedSes?.createrName || main?.userName;

          if (senderId && String(senderId) === String(myUid)) {
            return myName || '我';
          }

          // 1. 尝试从当前 chat-content 实例消息列表中反查原消息发送者
          if (msgId) {
            const chatContainers = document.querySelectorAll('.chat-container, .chat-content, .message-content-box');
            for (const container of chatContainers) {
              const vm = container.__vue__;
              if (vm && Array.isArray(vm.messages)) {
                const orig = vm.messages.find(m => String(m.id) === String(msgId) || String(m.msgID) === String(msgId));
                if (orig) {
                  if (String(orig.sender) === String(myUid)) {
                    return myName || '我';
                  }
                  if (orig.senderName) return String(orig.senderName);
                  if (orig.sendName) return String(orig.sendName);
                  if (orig.sender) senderId = orig.sender;
                }
              }
            }
          }

          // 2. 尝试从会话列表（sortedSessions）中反查联系人姓名
          if (sesUUID && editor?.sortedSessions) {
            const ses = editor.sortedSessions.find(s => s.sesUUID === sesUUID || String(s.id) === sesUUID);
            if (ses) {
              if (ses.type === 0) { // 私聊
                if (senderId && String(senderId) === String(myUid)) {
                  return ses.createrName || myName || '我';
                }
                return ses.typeName || ses.createrName || ses.name || (senderId ? String(senderId) : '对方');
              }
              if (ses.name) return ses.name;
            }
          }

          if (senderId && String(senderId) === String(myUid)) {
            return myName || '我';
          }

          return senderId ? String(senderId) : (myName || '我');
        }

        function onBus(event, handler) {
          if (!bus || typeof bus.$on !== 'function') return;
          bus.$on(event, handler);
          unbindFns.push(() => bus.$off(event, handler));
        }

        function forwardRecallCandidates(payload, session) {
          if (!payload) return;
          // 候选放入message，普通历史记录不会被当作显式撤回目标。
          postEvent('recalled', {
            sessionID: payload.sessionID ?? session?.id,
            session: payload.session ?? session,
            message: payload.message ?? payload.messages ?? payload,
          });
        }

        function hookSession(session) {
          const sesUUID = session?.sesUUID;
          if (!sesUUID || !bus || typeof bus.$on !== 'function') return;
          if (session.id !== undefined && session.id !== null && String(session.id).trim()) {
            knownSessions.set(sesUUID, session);
          }
          if (hookedSessions.has(sesUUID)) return;
          hookedSessions.add(sesUUID);
          // 监听会话增量消息
          onBus(sesUUID + '-msg', (msgArray) => {
            forwardRecallCandidates(msgArray, knownSessions.get(sesUUID));
          });

          // 监听会话专用撤回事件
          onBus(sesUUID + '-revokeMsg', (revokePayload) => {
            if (!revokePayload) return;
            const msgId = String(revokePayload.msgID || revokePayload.msgId || revokePayload.id || '');
            const session = revokePayload.session ?? knownSessions.get(sesUUID);
            const sessionID = revokePayload.sessionID ?? session?.id;
            if (sessionID === undefined || sessionID === null || !String(sessionID).trim()) return;
            postEvent('recalled', {
              ...revokePayload,
              event: 'CancelMessage',
              session,
              sessionID,
              sender: resolveSenderName(revokePayload.sender || revokePayload.senderName, msgId, sesUUID),
            });
          });
        }
        const pendingSends = new Map();
        const pendingMessages = new Map();
        const receiptWaiters = new Map();
        function forwardNative(payload) {
          if (!active || !payload) return;
          const messages = Array.isArray(payload.message) ? payload.message : [];
          if (!messages.length) {
            if (!payload.session || payload.message) postEvent('receive-message', payload);
            return;
          }
          for (const message of messages) {
            const key = message.msgFlag;
            const envelope = { ...payload, message: [message] };
            if (pendingSends.get(key) === String(payload.sessionID ?? message.sessionID) && String(message.sender) === ${JSON.stringify(String(this.currentUserId ?? ''))}) {
              const queued = pendingMessages.get(key) || [];
              queued.push(envelope);
              pendingMessages.set(key, queued);
            } else postEvent('receive-message', envelope);
          }
        }
        const onNativeMessage = (_event, payload) => forwardNative(payload?.args);
        ipc.on('message', onNativeMessage);
        unbindFns.push(() => ipc.removeListener('message', onNativeMessage));

        // 客户端本机手工发送只有原生业务回调；组件销毁会清空该会话监听。
        // 在原生派发边界观察，不重建 KK9 监听快照，也不依赖 Vue 的 -msg 转发。
        const originalEmit = ipc.emit;
        const nativeEmit = function(channel, ...args) {
          if (active && typeof channel === 'string' && /^\\d+-\\d+-sendMsgCallback$/.test(channel)) {
            for (const listener of receiptWaiters.get(channel) || []) {
              if (!ipc.listeners(channel).includes(listener)) listener(...args);
            }
            const receipt = args[1]?.args;
            const message = receipt?.data;
            let ext = message?.ext;
            if (typeof ext === 'string') {
              try { ext = JSON.parse(ext); }
              catch (error) { console.warn('[KairoDriver] 原生回调ext无法解析', error); return originalEmit.call(this, channel, ...args); }
            }
            if (receipt?.code === 0 && (ext?.status === undefined || ext.status === 0) &&
                /^[1-9]\\d*$/.test(String(message?.id)) && message?.sessionID !== undefined) {
              forwardNative({ sessionID: message.sessionID, message: [message] });
            }
          }
          return originalEmit.call(this, channel, ...args);
        };
        ipc.emit = nativeEmit;
        unbindFns.push(() => {
          if (ipc.emit === nativeEmit) ipc.emit = originalEmit;
          else throw new Error('原生派发 Hook 已被其他调用方替换，未覆盖其 Hook');
        });

        const onNativeSend = data => {
          if (!active) return;
          if (data.stage === 'subscribe') {
            const listeners = receiptWaiters.get(data.channel) || new Set();
            listeners.add(data.listener);
            receiptWaiters.set(data.channel, listeners);
            return;
          }
          if (data.stage === 'unsubscribe') {
            const listeners = receiptWaiters.get(data.channel);
            listeners?.delete(data.listener);
            if (!listeners?.size) receiptWaiters.delete(data.channel);
            return;
          }
          if (data.stage === 'pending') { pendingSends.set(data.key, String(data.sessionID)); return; }
          if (data.stage === 'confirmed') {
            postEvent('send-confirmed', { key: data.key, payload: data });
            return;
          }
          if (data.stage === 'settled') {
            pendingSends.delete(data.key);
            const queued = pendingMessages.get(data.key) || [];
            pendingMessages.delete(data.key);
            for (const payload of queued) forwardNative(payload);
          }
        };
        window.__kairo_native_send_observer = onNativeSend;
        unbindFns.push(() => {
          pendingSends.clear(); pendingMessages.clear();
          for (const [channel, listeners] of receiptWaiters)
            for (const listener of listeners) ipc.removeListener(channel, listener);
          receiptWaiters.clear();
          if (window.__kairo_native_send_observer === onNativeSend) delete window.__kairo_native_send_observer;
        });

        if (bus && typeof bus.$on === 'function') {
          // 1. 监听全局 receive-message
          onBus('receive-message', (payload) => {
            if (!payload) return;
            const session = payload.session;
            const sesUUID = session?.sesUUID || payload.sesUUID;
            if (sesUUID) hookSession({ ...session, sesUUID, id: payload.sessionID ?? session?.id });

            forwardRecallCandidates(payload, knownSessions.get(sesUUID));

          });

          // 2. 监听全局 CancelMessage
          onBus('CancelMessage', (payload) => {
            if (!payload) return;
            const msgId = String(payload.msgID || payload.msgId || payload.id || '');
            const lookupSessionId = payload.session?.sesUUID || payload.sesUUID || payload.sessionId || payload.sessionID;
            const session = payload.session?.id != null ? payload.session : knownSessions.get(lookupSessionId);
            const sessionID = payload.sessionID ?? session?.id;
            if (sessionID === undefined || sessionID === null || !String(sessionID).trim()) return;
            postEvent('recalled', {
              ...payload,
              event: 'CancelMessage',
              session,
              sessionID,
              sender: resolveSenderName(payload.sender || payload.senderName || payload.fromUserName, msgId, lookupSessionId),
            });
          });

          // 3. 预先挂钩所有已知会话
          const editor = getEditorVm();
          const sortedSessions = editor?.sortedSessions || [];
          if (Array.isArray(sortedSessions)) {
            sortedSessions.forEach(s => {
              if (s && s.sesUUID) hookSession(s);
            });
          }
          if (editor?.activedSes?.sesUUID) {
            hookSession(editor.activedSes);
          }
        }

        // 4. 挂钩所有 chat-content 组件实例的撤回方法
        function hookChatContentInstances() {
          const main = getMainPageVm();
          const editor = getEditorVm();
          const myUid = main?.userID || editor?.userID;
          const chatContainers = document.querySelectorAll('.chat-container, .chat-content, .message-content-box');
          chatContainers.forEach(container => {
            const vm = container.__vue__;
            if (vm && typeof vm.addRevokeMsg === 'function' && !vm.__kairo_revoke_active) {
              vm.__kairo_revoke_active = true;
              const origAdd = vm.addRevokeMsg;
              vm.addRevokeMsg = function(data) {
                if (data && (data.msgID || data.msgId || data.id)) {
                  const msgId = String(data.msgID || data.msgId || data.id);
                  const lookupSessionId = vm.sesInfo?.sesUUID || vm.sessionID || '';
                  const session = vm.sesInfo?.id != null ? vm.sesInfo :
                    knownSessions.get(vm.sesInfo?.sesUUID) ?? data.session;
                  const sessionID = data.sessionID ?? vm.sessionID ?? session?.id;
                  if (sessionID !== undefined && sessionID !== null && String(sessionID).trim()) {
                    postEvent('recalled', {
                      ...data,
                      event: 'CancelMessage',
                      session,
                      sessionID,
                      sender: resolveSenderName(data.sender || vm.loginID || myUid, msgId, lookupSessionId),
                    });
                  }
                }
                return origAdd.apply(this, arguments);
              };
              const hookedAdd = vm.addRevokeMsg;
              unbindFns.push(() => {
                if (vm.addRevokeMsg === hookedAdd) {
                  vm.addRevokeMsg = origAdd;
                  delete vm.__kairo_revoke_active;
                }
              });
            }
          });
        }
        if (${this.enableRecallHook} && typeof document !== 'undefined') {
          hookChatContentInstances();
          // 仅跟踪实际组件重建后的本机手工撤回方法，不读取历史气泡。
          if (typeof MutationObserver !== 'undefined') {
            observer = new MutationObserver(hookChatContentInstances);
            observer.observe(document.body, { childList: true, subtree: true });
          }
        }


        return { ok: true, busFound: !!bus, nativeAttached, sessionsHooked: hookedSessions.size };
      })()
    `;
  }
}
