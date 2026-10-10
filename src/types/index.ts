import type EventEmitter from 'node:events';

/**
 * @kairo/driver 强类型与接口定义
 */
export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected';

export type DriverHealthKind =
  | 'cdp_invalidated'
  | 'event_bridge_invalidated'
  | 'connection_identity_mismatch';

export interface CdpConnectionIdentity {
  startupGenerationId: string;
  connectionId: string;
  targetId: string;
  webSocketDebuggerUrl: string;
  connectedAt: number;
}

export interface CdpConnectionLostEvent {
  startupGenerationId: string;
  connectionIdentity: CdpConnectionIdentity | null;
  observedAt: number;
  cause: Error;
}

export interface DriverHealthEvent {
  kind: DriverHealthKind;
  startupGenerationId: string;
  connectionIdentity: CdpConnectionIdentity | null;
  expectedConnectionIdentity?: CdpConnectionIdentity | null;
  observedAt: number;
  cause: Error;
}

export interface DriverHealthSnapshot {
  startupGenerationId: string;
  cdpStatus: ConnectionStatus;
  cdpConnectionIdentity: CdpConnectionIdentity | null;
  eventBridgeAttached: boolean;
  eventBridgeConnectionIdentity: CdpConnectionIdentity | null;
}

export type KK9SessionType = 'private' | 'group' | 'discussion' | 'service' | 'unknown';

export type KK9MessageType =
  | 'text'
  | 'image'
  | 'file'
  | 'quote'
  | 'rich-text'
  | 'url-card'
  | 'biz-message'
  | 'app-message'
  | 'chat-record'
  | 'voice'
  | 'system';

/** 消息来源身份；unknown 表示当前可观察事实不足以安全分类。 */
export type KK9MessageOrigin = 'external' | 'system' | 'unknown';

/** 消息方向；unknown 表示原生发送者或当前登录 UID 不足。 */
export type MessageDirection = 'inbound' | 'outbound' | 'unknown';

/** 发送操作最终状态；unknown 不等同于确定失败。 */
export type SendStatus = 'sent' | 'failed' | 'unknown';

/** 整条消息的字体；字号单位为pt，不支持逐段样式。 */
export interface TextFont {
  /** 六位十六进制颜色，如 #1890ff。 */
  color?: string;
  fontSize?: number;
  fontFamily?: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
}

/** 字符串按原文发送；对象指定整条消息字体，不解析HTML或Markdown。 */
export type FormattedText = string | { text: string; font?: TextFont };

/** 只提供原生身份；发送者和引用内容必须从指定目标会话历史取得。 */
export interface KK9ReplyTarget {
  messageId: string;
  /** 可选准确索引，用于直接定位；提供后必须与消息ID匹配。 */
  msgIdx?: number;
}

/**
 * 被引用/回复消息元数据
 */
export interface KK9ReplyInfo {
  replyToSender: string;
  replyToContent: string;
  replyToId?: string;
  replyToSenderId?: string;
  replyToMsgIdx?: number;
}

/**
 * 群聊 @ 提及元数据
 */
export interface KK9MentionInfo {
  isAtMe: boolean;
  isAtAll: boolean;
  mentionedUsers: string[];
}

/**
 * 发送消息时的 @ 提及目标
 */
export interface KK9MentionTarget {
  uid: number | string;
  name: string;
}

/**
 * 图片元数据（支持本地缓存路径与远程 URI）
 */
export interface KK9ImageInfo {
  /** 本地缓存图片绝对路径 (如 C:\Users\...\file-cache\image\xxx.png) */
  filePath?: string;
  /** 图片 URL 或 file:// 地址 */
  url?: string;
  /** 远程服务器资源 URI */
  uri?: string;
  /** 图片宽度 */
  width?: number;
  /** 图片高度 */
  height?: number;
  /** 图片 MIME 类型 (如 image/png, image/jpeg) */
  mimeType?: string;
  /** 图片大小 (字节) */
  size?: number;
}

/**
 * 文件卡片元数据
 */
export interface KK9FileInfo {
  fileName: string;
  fileSize?: string;
  fileExt?: string;
  filePath?: string;
}

/** 链接图文卡片发送参数。 */
export interface KK9UrlCardOptions {
  title: string;
  summary: string;
  linkUrl: string;
  picUrl?: string;
}

/** 业务通知；只发送展示载荷，不创建任务或日程。 */
export interface KK9BizMsgOptions {
  title: string;
  content: string;
  summary?: string[];
  /** 相对于 KK9 的 ekp_outer_domain，例如 /；不能传完整外部 URL。 */
  bizUrl: string;
  /** 原生展示类型：1 任务样式，2 日程样式。 */
  bizType: 1 | 2;
}

/** 工作台微应用通知卡片发送参数。 */
export interface KK9AppMsgOptions {
  title: string;
  content: string;
  linkUrl?: string;
  pcAppCode?: string;
}

/** 指定来源会话中准确的原生消息，不接受虚构正文或作者。 */
export interface KK9ChatRecordItem {
  messageId: string;
  msgIdx: number;
}

/** 合并转发；原生标题由来源会话和实际登录身份生成。 */
export interface KK9ChatRecordOptions {
  sourceSessionId: string;
  msgArray: KK9ChatRecordItem[];
}

/** 语音输入二选一：文本合成或本地音频文件。 */
export type KK9VoiceOptions =
  | { text: string; filePath?: never; voice?: string }
  | { filePath: string; text?: never; voice?: never };

export interface KK9Session {
  /** 原生 sessionID 的字符串形式，不是用户 UID 或界面 sesUUID。 */
  id: string;
  name: string;
  type: KK9SessionType;
  /** 原生会话类型；未知类型保留原数值。 */
  nativeType: number;
  /** 私聊为对端用户 UID，其他类型为原生 typeID。 */
  receiverId: string;
  unread: boolean;
  unreadCount?: number;
  /** 标记是否有未读 @ 我或 @ 全体 */
  unreadAt?: boolean;
  lastMessage?: string;
  lastMessageTime?: string;
}

export interface KK9Message {
  /** 基于 KK9 原生消息 ID 的稳定身份 */
  id: string;
  /** KK9 原生消息 ID；标准化失败时消息被丢弃 */
  messageId?: string;
  /** 原生消息索引，不是消息 ID。 */
  msgIdx?: number;

  sessionId: string;
  sessionName: string;
  sessionType: KK9SessionType;
  /** 消息来源身份 */
  origin?: KK9MessageOrigin;
  /** 消息方向；标准化消息始终提供该字段。 */
  direction: MessageDirection;
  /** 已确认本实例 SDK 发送的原生意图键，可用 createNativeMessageKey 对照 operationId。 */
  sdkSendKey?: string;
  sender: string;
  senderId?: string;
  content: string;
  time: string;
  isMe: boolean;
  timestamp: number;
  /** 消息分类类型 */
  messageType?: KK9MessageType;
  /** 是否已被撤回 */
  isRecalled?: boolean;
  /** 是否 @ 了当前机器人 */
  atMe?: boolean;
  /** 是否 @ 了全体成员 */
  atAll?: boolean;
  /** @ 提及详情 */
  mentions?: KK9MentionInfo;
  /** 引用回复信息 */
  replyTo?: KK9ReplyInfo;
  /** 文件卡片信息 */
  fileInfo?: KK9FileInfo;
  /** 消息中包含的图片列表（单图或图文混排多图） */
  images?: KK9ImageInfo[];
  raw?: Record<string, unknown>;
}

/**
 * 员工档案与组织架构信息
 */
export interface KK9Employee {
  /** 唯一员工 UID */
  id: number | string;
  /** 工号 / 登录账号 (login_name) */
  loginName: string;
  /** 真实姓名 */
  name: string;
  /** 岗位 / 职称 (pos) */
  position?: string;
  /** 物理工位 / 办公区 */
  region?: string;
  /** 个性签名 (sig) */
  signature?: string;
  /** 手机号 */
  phone?: string;
  /** 电子邮箱 */
  email?: string;
  /** 头像地址 */
  avatarUrl?: string;
  /** 部门全路径层级 */
  deptPaths?: Array<{ id: number; name: string }>;
  /** 原始对象备份 */
  raw?: Record<string, unknown>;
  /** 抽取时间戳 (毫秒) */
  updatedAt: number;
}


export interface CdpConfig {
  url: string;
  pageMatch: string;
  timeoutMs?: number;
  heartbeatIntervalMs?: number;
}

export interface CompensationScanOptions {
  /** 毫秒闭区间，范围读取只返回原生当前可见历史，不代表无界全量。 */
  fromTimestamp: number;
  toTimestamp?: number;
  sessionIds?: readonly string[];
  /** 每会话返回范围内最近N条，默认20；必须为正整数。 */
  maxMessagesPerSession?: number;
}

export interface DriverConfig {
  cdp: CdpConfig;
  /** 连接前的规范化身份提示；connect 始终以原生登录档案取得实际 UID。 */
  currentUserId?: string | number;
  /** 共享客户端验收可显式拒绝接管其他代次的Hook。 */
  rejectExistingBridge?: boolean;
  /** Composition Root 分配的唯一启动代次。 */
  startupGenerationId?: string;
}

export interface EventBridgeConfig {
  cdp: CdpConfig;
  /** Composition Root 分配的唯一启动代次。 */
  startupGenerationId?: string;
  /** 自定义 CDP 绑定名称 (默认 '__kairo_native_bridge') */
  bindingName?: string;
  /** 去重 native messageId 的最大缓存数量 (默认 10000) */
  maxMessageIds?: number;
  /** 当前用户 UID / 账号 (用于识别自身发出消息 isMe) */
  currentUserId?: string | number;
  enableRecallHook?: boolean;
  rejectExistingBridge?: boolean;
}

/** 本次原生业务回执的必要元数据；不包含聊天正文。 */
export interface NativeSendReceipt {
  draftId: string;
  sessionId: string;
  code: number;
  businessCode?: number;
  messageId?: string;
  msgIdx?: number;
}

/** 发送状态只有一个判别字段；sent不表示对端收到或已读。 */
export type SendOutcome = {
  recall?: () => Promise<boolean>;
  isPreTrigger?: boolean;
  verifyLatencyMs?: number;
  nativeCode?: number;
  receipt?: NativeSendReceipt;
} & (
  | { status: 'sent'; messageId: string; error?: never }
  | { status: 'failed'; error: string; messageId?: never }
  | { status: 'unknown'; error?: string; messageId?: never }
);

/** 每个发送意图始终具有稳定operationId；省略输入时SDK生成一次。 */
export type SendResult = SendOutcome & { operationId: string };

/**
 * 消息撤回事件元数据
 */
export interface KK9RecalledEvent {
  messageId: string;
  sessionId: string;
  sender: string;
  time: string;
  timestamp?: number;
}


export interface SendOptions {
  /** 必须提供原生会话ID；缺省返回failed，不使用当前窗口或会话名称。 */
  targetSessionId?: string;
  /** 稳定发送意图ID；重复调用仅查询或返回原结果，不再次提交。 */
  operationId?: string;
  verifyTimeoutMs?: number;
  /** 引用/回复目标 */
  replyTo?: string | KK9ReplyTarget;
  /** 提及必须提供用户UID与显示名；全体成员只能显式使用all，不按昵称解析。 */
  mentions?: KK9MentionTarget | 'all' | Array<KK9MentionTarget | 'all'>;
}

export interface SendFileOptions {
  /** 必须提供原生会话ID；缺省返回failed，不使用当前窗口或会话名称。 */
  targetSessionId?: string;
  /** 稳定发送意图ID；重复调用仅查询或返回原结果，不再次提交。 */
  operationId?: string;
  verifyTimeoutMs?: number;
}

export interface DriverEvents {
  status: (status: ConnectionStatus) => void;
  message: (message: KK9Message) => void;
  /** 专为群聊 @ 我/全体 派发的快捷事件 */
  at: (message: KK9Message) => void;
  /** 消息撤回事件 */
  recalled: (event: KK9RecalledEvent) => void;
  error: (error: Error) => void;
  heartbeat: (uptimeMs: number) => void;
  health: (event: DriverHealthEvent) => void;
}

/**
 * IKK9Driver 顶层纯净抽象接口契约
 * 仅暴露出对 KK9 IM 软件的操作，屏蔽底层协议 (CDP/IPC/Bridge) 细节
 */
export interface IKK9Driver extends EventEmitter {
  // 生命周期与连接状态
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  getStatus(): ConnectionStatus;
  getStartupGenerationId(): string;
  getHealthSnapshot(): DriverHealthSnapshot;
  /** 读取当前实际登录 UID；未登录返回 null，读取失败抛错，不回退配置身份。 */
  getCurrentUserId(): Promise<string | null>;

  // 会话管理
  getSessions(): Promise<KK9Session[]>;
  /** 仅接受原生 ID；不存在返回 false，原生操作失败抛 DriverError。 */
  markSessionRead(sessionId: string): Promise<boolean>;

  // 消息读取与补偿
  /** 必须指定 getSessions 返回的原生会话；历史不会派发实时事件，查询失败抛错。 */
  getRecentMessages(session: KK9Session, limit?: number): Promise<KK9Message[]>;
  scanCompensationWindow(options: CompensationScanOptions): Promise<KK9Message[]>;

  // 消息发送与撤回
  sendText(text: string, options?: SendOptions): Promise<SendResult>;
  sendRichText(content: FormattedText, options?: SendOptions): Promise<SendResult>;
  sendReply(
    replyTo: string | KK9ReplyTarget,
    content: FormattedText,
    options?: SendOptions
  ): Promise<SendResult>;
  sendFile(filePath: string, options?: SendFileOptions): Promise<SendResult>;
  getSendStatus(operationId: string): Promise<SendResult>;
  sendImage(imagePath: string, options?: SendOptions): Promise<SendResult>;
  sendUrlCard(card: KK9UrlCardOptions, options?: SendOptions): Promise<SendResult>;
  sendBizMessage(message: KK9BizMsgOptions, options?: SendOptions): Promise<SendResult>;
  sendAppMessage(message: KK9AppMsgOptions, options?: SendOptions): Promise<SendResult>;
  sendChatRecord(record: KK9ChatRecordOptions, options?: SendOptions): Promise<SendResult>;
  sendVoice(voice: KK9VoiceOptions, options?: SendOptions): Promise<SendResult>;
  /** 显式原生会话；无可撤回目标返回false，原生失败抛出含目标和错误上下文的DriverError。 */
  recallMessage(messageId: string, session: KK9Session | string): Promise<boolean>;

  // 组织架构与员工档案
  getOrgEmployees(timeoutMs?: number): Promise<KK9Employee[]>;
  getUserProfile(userId: number | string): Promise<KK9Employee | null>;
  getEmployeeBySession(session: string | KK9Session): Promise<KK9Employee | null>;

  // 强类型事件监听器绑定
  on<U extends keyof DriverEvents>(event: U, listener: DriverEvents[U]): this;
  emit<U extends keyof DriverEvents>(event: U, ...args: Parameters<DriverEvents[U]>): boolean;
}
