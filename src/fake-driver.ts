import EventEmitter from 'node:events';
import { randomUUID } from 'node:crypto';
import { open, rename, rm } from 'node:fs/promises';
import path from 'node:path';
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
  KK9EmployeeSearchItem,
  KK9EmployeeSearchResult,
  KK9FileInfo,
  KK9GroupMember,
  KK9ImageInfo,
  KK9Message,
  KK9RecalledEvent,
  KK9ReplyTarget,
  KK9Session,
  KK9UrlCardOptions,
  KK9VoiceOptions,
  SendFileOptions,
  SendOptions,
  SendOutcome,
  SendResult,
  SendToUserOptions,
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
import { getOriginalImageUri, hasOriginalImageSource } from './utils/image.js';

function cachedFileKey(source: string): string {
  if (source.startsWith('file:')) {
    const url = new URL(source);
    source = `${url.hostname ? `//${url.hostname}` : ''}${decodeURIComponent(url.pathname)}`;
    if (/^\/[a-zA-Z]:/.test(source)) source = source.slice(1);
  }
  return source.replace(/\\/g, '/');
}

function normalizeGroupQueryId(value: string, label: string, code: string): string {
  const text = typeof value === 'string' ? value.trim() : '';
  const id = Number(text);
  if (!/^\d+$/.test(text) || !Number.isSafeInteger(id) || id <= 0) {
    throw new DriverError(`${label}必须为正安全整数`, code);
  }
  return String(id);
}

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
    | 'textToUser'
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
  targetLoginName?: string;
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
  private sessions: KK9Session[] = [];
  private messages: KK9Message[] = [];
  private employees: KK9Employee[] = [];
  private searchEmployeeProfiles: KK9EmployeeSearchItem[] = [];
  private readonly groupMemberProfiles = new Map<string, KK9GroupMember[]>();
  private currentBehavior: FakeSendBehavior = { mode: 'success' };
  private behaviorSequence: FakeSendBehavior[] = [];
  private readonly sendOperationStore: SendOperationStore;
  private readonly imageResources = new Map<string, Uint8Array>();
  private readonly cachedFiles = new Map<string, Uint8Array>();

  private readonly confirmedSendKeys = new Map<string, string>();
  private readonly knownMessageKeys = new Set<string>();
  private readonly knownRecalledMessageKeys = new Set<string>();
  public readonly recordedCalls: RecordedSendCall[] = [];
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

  /** 独立注入真实搜索档案，不从组织架构展示字段推断工号。 */
  public setSearchEmployees(employees: KK9EmployeeSearchItem[]): void {
    const profiles = new Map<string, { employee: KK9EmployeeSearchItem; paths: Set<string> }>();
    for (const employee of employees) {
      const numericId = Number(employee.id);
      if (!Number.isSafeInteger(numericId) || numericId <= 0) {
        throw new DriverError('员工搜索档案 UID 必须为正安全整数', 'IPC_QUERY_FAILED');
      }
      const id = String(numericId);
      let profile = profiles.get(id);
      if (!profile) {
        profile = { employee: { id, name: null, loginName: null, departmentPaths: null }, paths: new Set() };
        profiles.set(id, profile);
      }
      if (!profile.employee.name && typeof employee.name === 'string' && employee.name.trim()) {
        profile.employee.name = employee.name;
      }
      if (!profile.employee.loginName && typeof employee.loginName === 'string' && employee.loginName.trim()) {
        profile.employee.loginName = employee.loginName;
      }
      for (const departmentPath of employee.departmentPaths ?? []) {
        if (typeof departmentPath === 'string' && departmentPath.trim()) profile.paths.add(departmentPath);
      }
    }
    this.searchEmployeeProfiles = [...profiles.values()].map(({ employee, paths }) => ({
      ...employee,
      departmentPaths: paths.size ? [...paths] : null,
    }));
  }

  public searchEmployees(keyword: string, timeoutMs = 30000): Promise<KK9EmployeeSearchResult> {
    const startedAt = Date.now();
    const query = keyword.trim();
    if (!query) return Promise.reject(new DriverError('员工搜索关键词不能为空', 'IPC_QUERY_FAILED'));
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      return Promise.reject(new DriverError(`员工搜索总期限必须为正有限毫秒数：${timeoutMs}`, 'IPC_QUERY_FAILED'));
    }
    const employees = this.searchEmployeeProfiles
      .filter(employee => employee.name?.includes(query) || employee.loginName?.includes(query))
      .map(employee => ({ ...employee, departmentPaths: employee.departmentPaths ? [...employee.departmentPaths] : null }));
    if (Date.now() - startedAt >= timeoutMs) {
      return Promise.reject(new DriverError(`员工搜索超过总期限，超时 ${timeoutMs}ms`, 'IPC_QUERY_FAILED'));
    }
    return Promise.resolve({ employees, hasMore: false });
  }

  /** 按原生会话独立注入真实群成员档案，不使用组织架构或搜索展示资料补值。 */
  public setGroupMembers(sessionId: string, members: KK9GroupMember[]): void {
    const key = normalizeGroupQueryId(sessionId, '群成员查询原生会话 ID ', 'IPC_QUERY_FAILED');
    const profiles = new Map<string, { member: KK9GroupMember; paths: Set<string> }>();
    for (const member of members) {
      const id = normalizeGroupQueryId(member.id, '群成员档案 UID ', 'IPC_QUERY_FAILED');
      let profile = profiles.get(id);
      if (!profile) {
        profile = {
          member: {
            id,
            name: typeof member.name === 'string' && member.name.trim() ? member.name : null,
            loginName: typeof member.loginName === 'string' && member.loginName.trim() ? member.loginName : null,
            departmentPaths: null,
            position: typeof member.position === 'string' && member.position.trim() ? member.position : null,
          },
          paths: new Set(),
        };
        profiles.set(id, profile);
      }
      for (const departmentPath of member.departmentPaths ?? []) {
        if (typeof departmentPath === 'string' && departmentPath.trim()) profile.paths.add(departmentPath);
      }
    }
    this.groupMemberProfiles.set(key, [...profiles.values()].map(({ member, paths }) => ({
      ...member,
      departmentPaths: paths.size ? [...paths] : null,
    })));
  }

  public getGroupMembers(sessionId: string, timeoutMs = 30000): Promise<KK9GroupMember[]> {
    try {
      const startedAt = Date.now();
      const id = normalizeGroupQueryId(sessionId, '群成员查询原生会话 ID ', 'INVALID_SESSION_ID');
      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        throw new DriverError(`群成员查询总期限必须为正有限毫秒数：${timeoutMs}`, 'IPC_QUERY_FAILED');
      }
      const session = this.sessions.find(item => /^\d+$/.test(item.id.trim()) && String(Number(item.id)) === id);
      if (!session) throw new DriverError(`群成员查询原生会话不存在：${id}`, 'IPC_INVALID_RESPONSE');
      if (session.type !== 'group' || session.nativeType !== 1) {
        throw new DriverError(`群成员查询目标不是原生群会话：${id}`, 'INVALID_SESSION_ID');
      }
      normalizeGroupQueryId(session.receiverId, '群成员查询原生群接收对象 ID ', 'INVALID_SESSION_ID');
      const members = (this.groupMemberProfiles.get(id) ?? []).map(member => ({
        ...member,
        departmentPaths: member.departmentPaths ? [...member.departmentPaths] : null,
      }));
      if (Date.now() - startedAt >= timeoutMs) {
        throw new DriverError(`群成员查询超过总期限，超时 ${timeoutMs}ms`, 'IPC_QUERY_FAILED');
      }
      return Promise.resolve(members);
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }

  /** 注入服务器图片资源；下载写入实际字节，不制造消息回声。 */
  public setImageResource(uri: string, bytes: Uint8Array): void {
    this.imageResources.set(uri, bytes);
  }

  /** 注入 KK9 机器上的缓存字节；支持 Windows 路径，独立于 Driver 本地文件系统。 */
  public setCachedFile(filePath: string, bytes: Uint8Array): void {
    this.cachedFiles.set(cachedFileKey(filePath), bytes);
  }

  public async downloadImage(image: KK9ImageInfo, fullPath: string): Promise<string> {
    const uri = getOriginalImageUri(image);
    const target = path.resolve(fullPath);
    const cache = hasOriginalImageSource(image)
      ? image.originalFilePath
      : image.filePath || (image.url?.startsWith('file:') ? image.url : undefined);
    try {
      let bytes = cache ? this.cachedFiles.get(cachedFileKey(cache)) : undefined;
      if (bytes === undefined) {
        if (!uri) throw new Error('图片缺少可下载的原图 URI');
        bytes = this.imageResources.get(uri);
        if (bytes === undefined) throw new Error(`图片资源不存在：${uri}`);
      }
      if (bytes.byteLength < 1) throw new Error('原图不是非空普通文件');
      await this.publishAttachmentBytes(target, bytes);
      return target;
    } catch (error) {
      throw new DriverError(
        `下载原图 ${uri || cache || '未知资源'} 到 ${target} 失败：${error instanceof Error ? error.message : String(error)}`,
        'IMAGE_DOWNLOAD_FAILED', error instanceof Error ? error : undefined
      );
    }
  }

  public async saveFile(file: KK9FileInfo, fullPath: string): Promise<string> {
    const target = path.resolve(fullPath);
    try {
      if (!file.filePath) throw new Error('普通文件尚未缓存，缺少 KK9 filePath');
      const bytes = this.cachedFiles.get(cachedFileKey(file.filePath));
      if (bytes === undefined) throw new Error(`ENOENT：KK9 缓存不存在：${file.filePath}`);
      await this.publishAttachmentBytes(target, bytes);
      return target;
    } catch (error) {
      throw new DriverError(
        `保存文件 ${file.fileName}（KK9 缓存 ${file.filePath || '未缓存'}）到 ${target} 失败：${error instanceof Error ? error.message : String(error)}`,
        'FILE_SAVE_FAILED', error instanceof Error ? error : undefined
      );
    }
  }

  private async publishAttachmentBytes(target: string, bytes: Uint8Array): Promise<void> {
    const temporary = path.join(path.dirname(target), `.kairo-attachment-${randomUUID()}.part`);
    const destination = await open(temporary, 'wx');
    let closed = false;
    try {
      await destination.writeFile(bytes);
      await destination.close();
      closed = true;
      await rename(temporary, target);
    } catch (error) {
      const errors = [error];
      if (!closed) {
        try { await destination.close(); }
        catch (closeError) { errors.push(closeError); }
      }
      try { await rm(temporary, { force: true }); }
      catch (cleanupError) { errors.push(cleanupError); }
      if (errors.length > 1) {
        throw new AggregateError(errors, `本地附件写入与清理失败：${errors.map(String).join('；')}`);
      }
      throw error;
    }
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


  public markSessionRead(sessionId: string): Promise<boolean> {
    this.markSessionReadCallsCount++;
    const session = this.sessions.find(item => item.id === sessionId.trim());
    if (!session) return Promise.resolve(false);
    session.unread = false;
    session.unreadCount = 0;
    session.unreadAt = false;
    return Promise.resolve(true);
  }


  public async sendText(text: string, options?: SendOptions): Promise<SendResult> {
    if (options?.replyTo !== undefined) return this.sendReply(options.replyTo, text, options);
    return this.executeSendAction('text', 'text', text, options);
  }

  public async sendTextToUser(loginName: string, text: string, options?: SendToUserOptions): Promise<SendResult> {
    return this.executeSendAction('text-to-user', 'textToUser', text, {
      operationId: options?.operationId,
      verifyTimeoutMs: options?.verifyTimeoutMs,
    }, false, loginName.trim());
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
    return this.executeSendAction('image', 'image', imagePath, options, false, options?.targetLoginName?.trim());
  }

  public async sendFile(filePath: string, options?: SendFileOptions): Promise<SendResult> {
    return this.executeSendAction('file', 'file', filePath, options, false, options?.targetLoginName?.trim());
  }

  public async sendUrlCard(card: KK9UrlCardOptions, options?: SendOptions): Promise<SendResult> {
    return this.executeSendAction('url-card', 'urlCard', card, options, false, options?.targetLoginName?.trim());
  }

  public async sendBizMessage(
    message: KK9BizMsgOptions,
    options?: SendOptions
  ): Promise<SendResult> {
    return this.executeSendAction('biz-message', 'bizMessage', message, options, false, options?.targetLoginName?.trim());
  }

  public async sendAppMessage(
    message: KK9AppMsgOptions,
    options?: SendOptions
  ): Promise<SendResult> {
    return this.executeSendAction('app-message', 'appMessage', message, options, false, options?.targetLoginName?.trim());
  }

  public async sendChatRecord(
    record: KK9ChatRecordOptions,
    options?: SendOptions
  ): Promise<SendResult> {
    return this.executeSendAction('chat-record', 'chatRecord', record, options, false);
  }

  public async sendVoice(voice: KK9VoiceOptions, options?: SendOptions): Promise<SendResult> {
    return this.executeSendAction('voice', 'voice', voice, options, false, options?.targetLoginName?.trim());
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
    supportsReplyAndMentions = true,
    targetLoginName?: string
  ): Promise<SendResult> {
    const operationId =
      options?.operationId === undefined ? randomUUID() : options.operationId.trim();
    const effectiveOptions: SendOptions | SendFileOptions = { ...options, operationId };
    const replyTo = options && 'replyTo' in options ? options.replyTo : undefined;
    const mentions = options && 'mentions' in options ? options.mentions : undefined;
    const fingerprint = createSendOperationFingerprint({
      targetSessionId: options?.targetSessionId,
      targetLoginName,
      messageType: operationType,
      content: { payload, replyTo, mentions },
    });
    const claim = await this.sendOperationStore.claim({ operationId, fingerprint });
    if (!claim.claimed) return sendOperationRecordToResult(claim.operation);
    let textError: string | undefined;
    if (operationType === 'text-to-user' && (typeof payload !== 'string' || !payload.trim())) {
      textError = '文本内容不能为空';
    }
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
    let targetEmployee: KK9Employee | undefined;
    let targetError: string | undefined;
    const optionLoginName = options?.targetLoginName;
    if (optionLoginName !== undefined && !['url-card', 'biz-message', 'app-message', 'image', 'file', 'voice'].includes(operationType)) {
      targetError = '此发送方法不支持targetLoginName';
    } else if (targetLoginName !== undefined && options?.targetSessionId !== undefined) {
      targetError = 'targetLoginName与targetSessionId不能同时指定';
    }
    if (targetLoginName !== undefined && !textError && !targetError) {
      if (!targetLoginName) {
        targetError = '发送必须指定准确工号';
      } else if (!this.currentUserId?.trim()) {
        targetError = '按工号发送缺少当前登录身份';
      } else {
        const candidates = new Map<string, KK9Employee>();
        for (const employee of this.employees) {
          if (employee.loginName === targetLoginName) candidates.set(String(employee.id), employee);
        }
        if (candidates.size === 0) targetError = `未找到准确工号: ${targetLoginName}`;
        else if (candidates.size > 1) targetError = `工号对应多个UID，拒绝歧义目标: ${targetLoginName}`;
        else targetEmployee = candidates.values().next().value;
        if (targetEmployee && String(targetEmployee.id) === this.currentUserId.trim()) {
          targetError = '按工号发送仅支持其他人员，不能发送给本人';
        }
      }
    }
    let outcome: SendOutcome;
    if (targetLoginName === undefined && !options?.targetSessionId?.trim()) {
      outcome = { status: 'failed', error: '发送必须指定明确原生会话ID', isPreTrigger: true };
    } else if (textError) {
      outcome = { status: 'failed', error: textError, isPreTrigger: true };
    } else if (targetError) {
      outcome = { status: 'failed', error: targetError, isPreTrigger: true };
    } else if (!supportsReplyAndMentions && (replyTo !== undefined || mentions !== undefined)) {
      outcome = {
        status: 'failed',
        error: '原生卡片、图片、文件与语音消息不支持replyTo或mentions',
        isPreTrigger: true,
      };
    } else {
      this.recordedCalls.push({
        type: callType,
        payload,
        options: effectiveOptions,
        ...(targetLoginName !== undefined ? { targetLoginName } : {}),
        timestamp: Date.now(),
      });
      try {
        outcome = await this.executeSendBehavior(payload, effectiveOptions);
      } catch (error) {
        outcome = { status: 'unknown', error: String(error), isPreTrigger: false };
      }
    }
    if (targetEmployee) {
      if (outcome.status === 'sent') {
        const receiverId = String(targetEmployee.id);
        let sessionId = outcome.sessionId && /^[1-9]\d*$/.test(outcome.sessionId) ? outcome.sessionId : undefined;
        let session = this.sessions.find(item => item.type === 'private' && item.receiverId === receiverId && /^[1-9]\d*$/.test(item.id) &&
          (sessionId === undefined || item.id === sessionId));
        if (!session) {
          if (!sessionId) {
            let nextId = 1;
            while (this.sessions.some(item => item.id === String(nextId))) nextId++;
            sessionId = String(nextId);
          }
          session = { id: sessionId, name: targetEmployee.name, type: 'private', nativeType: 0, receiverId, unread: false };
          this.sessions.push(session);
        }
        outcome = { ...outcome, sessionId: session.id };
      } else {
        // 故障结果不能把注入的会话号当成本次创建会话的证据。
        outcome = { ...outcome, sessionId: undefined };
      }
    }
    const result = sendOperationRecordToResult(await this.sendOperationStore.update(operationId, outcome));
    const confirmedSessionId = targetLoginName !== undefined ? result.sessionId : effectiveOptions.targetSessionId;
    if (result.status === 'sent' && confirmedSessionId) {
      this.confirmedSendKeys.set(createMessageIdentityKey(confirmedSessionId, result.messageId),
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
    this.markSessionReadCallsCount = 0;
    this.currentBehavior = { mode: 'success' };
    this.behaviorSequence = [];
  }
}
