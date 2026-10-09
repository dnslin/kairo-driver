import type {
  KK9FileInfo,
  KK9ImageInfo,
  KK9MentionInfo,
  KK9Message,
  KK9MessageOrigin,
  KK9MessageType,
  MessageDirection,
  KK9RecalledEvent,
  KK9ReplyInfo,
  KK9Session,
} from '../types/index.js';

export function toSafeString(val: unknown, defaultVal = ''): string {
  if (typeof val === 'string') return val;
  if (typeof val === 'number' || typeof val === 'boolean' || typeof val === 'bigint') {
    return val.toString();
  }
  return defaultVal;
}

export function createMessageIdentityKey(sessionId: string, nativeMessageId: string): string {
  return `${sessionId.trim()}:${nativeMessageId.trim()}`;
}

export function tryParseJson(val: unknown): Record<string, unknown> | null {
  if (!val) return null;
  if (typeof val === 'object' && !Array.isArray(val)) return val as Record<string, unknown>;
  if (typeof val === 'string') {
    const trimmed = val.trim();
    if (
      (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
      (trimmed.startsWith('[') && trimmed.endsWith(']'))
    ) {
      try {
        const res = JSON.parse(trimmed) as unknown;
        if (res && typeof res === 'object') return res as Record<string, unknown>;
      } catch {
        return null;
      }
    }
  }
  return null;
}

function extractTextContent(content: unknown, notifyMsg?: unknown, contentType?: unknown): string {
  if (typeof content === 'string') {
    const parsed = tryParseJson(content);
    if (parsed) return extractTextContent(parsed, notifyMsg, contentType);
    return content;
  }
  if (content && typeof content === 'object') {
    const obj = content as Record<string, unknown>;
    const nativeContentType = Number(contentType);
    if (nativeContentType === 2) {
      const duration = Number(obj['duration']);
      return Number.isFinite(duration) && duration > 0 ? `[语音: ${duration}秒]` : '[语音]';
    }
    if ([8, 10, 15, 17].includes(nativeContentType)) {
      const title = toSafeString(obj['title']).trim();
      const detail =
        nativeContentType === 10
          ? toSafeString(obj['summary']).trim()
          : nativeContentType === 8 || nativeContentType === 17
            ? toSafeString(obj['content']).trim()
            : '';
      const summary = [title, detail].filter(Boolean).join('\n');
      if (summary) return summary;
    }
    if (obj['filename'] || obj['fileName']) {
      const fn = toSafeString(obj['filename'] || obj['fileName']);
      return `[文件: ${fn}]`;
    }
    if (Array.isArray(obj['content'])) {
      const text = obj['content']
        .map((node: unknown) => {
          if (node && typeof node === 'object') {
            const contentNode = node as Record<string, unknown>;
            if (typeof contentNode['text'] === 'string') return contentNode['text'];
            if (contentNode['type'] === 1) return '[图片]';
          }
          return '';
        })
        .filter(Boolean)
        .join('');
      if (text) return text;
    }
    if (typeof obj['text'] === 'string') return obj['text'];
    if (typeof obj['msg'] === 'string') return obj['msg'];
    if (typeof obj['content'] === 'string') {
      return extractTextContent(obj['content'], notifyMsg, contentType);
    }
    try {
      return JSON.stringify(content);
    } catch {
      return toSafeString(content);
    }
  }
  if (typeof notifyMsg === 'string' && notifyMsg.trim()) {
    return notifyMsg;
  }
  return '';
}

function determineMessageType(
  raw: Record<string, unknown>,
  images?: KK9ImageInfo[],
  fileInfo?: KK9FileInfo,
  replyTo?: KK9ReplyInfo
): KK9MessageType {
  if (typeof raw['messageType'] === 'string') {
    return raw['messageType'] as KK9MessageType;
  }
  const nativeContentType = Number(raw['contentType']);
  if (nativeContentType === 6) return 'system';
  if (nativeContentType === 2) return 'voice';
  if (nativeContentType === 8) return 'app-message';
  if (nativeContentType === 10) return 'url-card';
  if (nativeContentType === 15) return 'chat-record';
  if (nativeContentType === 17) return 'biz-message';
  if (fileInfo || nativeContentType === 3 || raw['contentType'] === 'file') {
    return 'file';
  }
  if ((images && images.length > 0) || nativeContentType === 1 || raw['contentType'] === 'image') {
    return 'image';
  }
  if (replyTo || raw['replyMsg'] || nativeContentType === 13) {
    return 'quote';
  }
  if (raw['richText'] || raw['html'] || raw['contentType'] === 'rich-text') {
    return 'rich-text';
  }
  if (raw['isSystem'] || raw['system'] || raw['contentType'] === 'system') {
    return 'system';
  }
  return 'text';
}


export type InboundNormalizationSource = 'event_bridge' | 'polling' | 'history' | 'unknown';

export interface InboundNormalizationDiagnostic {
  kind: 'missing_inbound_identity';
  missingFields: readonly ('sessionId' | 'nativeMessageId')[];
  sessionId: string;
  source: InboundNormalizationSource;
  observedAt: number;
}

export interface NormalizeNativeMessageContext {
  session?: Partial<KK9Session>;
  currentUserId?: string | number;
  source?: InboundNormalizationSource;
  onDiagnostic?: (diagnostic: InboundNormalizationDiagnostic) => void;
}


function isRecalledMessageItem(item: Record<string, unknown>): boolean {
  const msgFlag = toSafeString(item['msgFlag']);
  return (
    msgFlag.startsWith('C') ||
    msgFlag.startsWith('D') ||
    item['msgState'] === 1 ||
    item['isRecalled'] === true
  );
}

function isCancelMessageItem(item: Record<string, unknown>): boolean {
  if (item['event'] === 'CancelMessage' || item['type'] === 'CancelMessage') {
    return true;
  }
  if (Number(item['contentType']) !== 6) return false;
  const contentObj = tryParseJson(item['content']);
  return Boolean(
    contentObj &&
    (contentObj['event'] === 'CancelMessage' || contentObj['type'] === 'CancelMessage')
  );
}

/** 消息使用原生会话 ID，界面标识不能覆盖原生身份。 */
function resolvePublicSessionId(
  raw: Record<string, unknown>,
  fallbackId?: string,
  currentUserId?: string | number
): string {
  const session =
    raw['session'] && typeof raw['session'] === 'object'
      ? (raw['session'] as Record<string, unknown>)
      : undefined;
  const nativeSessionId = toSafeString(raw['sessionID'] ?? session?.['id']).trim();
  if (nativeSessionId) return nativeSessionId;
  const myUid =
    currentUserId !== undefined && currentUserId !== null
      ? toSafeString(currentUserId).trim()
      : undefined;

  // 1. 优先使用明确的 sesUUID / sessionId
  // 若为私聊且值恰好为指向机器人自身的 0-myUid 或 myUid，需跳过，不能直接采纳为有效会话
  const sessionSesUuid = toSafeString(session?.['sesUUID']).trim();
  if (sessionSesUuid && (!myUid || (sessionSesUuid !== `0-${myUid}` && sessionSesUuid !== myUid))) {
    return sessionSesUuid;
  }

  const rawSesUuid = toSafeString(raw['sesUUID']).trim();
  if (rawSesUuid && (!myUid || (rawSesUuid !== `0-${myUid}` && rawSesUuid !== myUid))) {
    return rawSesUuid;
  }

  const rawSessionId = toSafeString(raw['sessionId']).trim();
  if (rawSessionId && (!myUid || (rawSessionId !== `0-${myUid}` && rawSessionId !== myUid))) {
    return rawSessionId;
  }

  // 2. 从 session 对象组装：优先 sesTypeID，其次根据 creater / typeID 判断
  if (session && session['type'] != null) {
    const sType = toSafeString(session['type']);
    const isGroup = sType === '1' || sType === 'group';
    const sesTypeID = session['sesTypeID'] != null ? toSafeString(session['sesTypeID']).trim() : '';
    const typeID = session['typeID'] != null ? toSafeString(session['typeID']).trim() : '';
    const creater = session['creater'] != null ? toSafeString(session['creater']).trim() : '';

    if (isGroup) {
      const targetId = sesTypeID || typeID;
      if (targetId) return `${sType}-${targetId}`;
    } else {
      // 私聊：目标必须是对方用户 ID，不能是当前用户 (myUid)
      let peerId = sesTypeID;
      if (!peerId || (myUid && peerId === myUid)) {
        if (creater && (!myUid || creater !== myUid)) {
          peerId = creater;
        } else if (typeID && (!myUid || typeID !== myUid)) {
          peerId = typeID;
        }
      }
      if (peerId && (!myUid || peerId !== myUid)) {
        return `${sType}-${peerId}`;
      }
    }
  }

  // 3. 原生 sessionID 或 session.id
  const rawSessionID = toSafeString(raw['sessionID']).trim();
  if (rawSessionID && (!myUid || (rawSessionID !== `0-${myUid}` && rawSessionID !== myUid))) {
    return rawSessionID;
  }

  const sessionIdFromObj = toSafeString(session?.['id']).trim();
  if (
    sessionIdFromObj &&
    (!myUid || (sessionIdFromObj !== `0-${myUid}` && sessionIdFromObj !== myUid))
  ) {
    return sessionIdFromObj;
  }

  // 4. 回退 fallbackId
  const fallback = toSafeString(fallbackId).trim();
  if (fallback && (!myUid || (fallback !== `0-${myUid}` && fallback !== myUid))) {
    return fallback;
  }

  return (
    sessionSesUuid ||
    rawSesUuid ||
    rawSessionId ||
    rawSessionID ||
    sessionIdFromObj ||
    fallback ||
    ''
  );
}

export function normalizeNativeMessage(
  payload: unknown,
  context?: NormalizeNativeMessageContext
): KK9Message[] {
  if (!payload || typeof payload !== 'object') {
    return [];
  }

  const rawObj = payload as Record<string, unknown>;

  const sessionObj = (
    rawObj['session'] && typeof rawObj['session'] === 'object' ? rawObj['session'] : {}
  ) as Record<string, unknown>;

  const currentUserId =
    context?.currentUserId !== undefined ? toSafeString(context.currentUserId) : null;

  const baseSessionId = resolvePublicSessionId(
    rawObj,
    context?.session?.id,
    currentUserId ?? undefined
  );

  const rawSessionName =
    rawObj['sessionName'] ??
    sessionObj['name'] ??
    sessionObj['typeName'] ??
    sessionObj['createrName'] ??
    context?.session?.name;
  const sessionName = toSafeString(rawSessionName, baseSessionId || '未知会话');


  let rawList: Array<Record<string, unknown>> = [];
  if (Array.isArray(rawObj['messages'])) {
    rawList = rawObj['messages'] as Array<Record<string, unknown>>;
  } else if (Array.isArray(rawObj['message'])) {
    rawList = rawObj['message'] as Array<Record<string, unknown>>;
  } else if (rawObj['message'] && typeof rawObj['message'] === 'object') {
    rawList = [rawObj['message'] as Record<string, unknown>];
  } else if (Array.isArray(rawObj['data'])) {
    rawList = rawObj['data'] as Array<Record<string, unknown>>;
  } else if (rawObj['data'] && typeof rawObj['data'] === 'object') {
    rawList = [rawObj['data'] as Record<string, unknown>];
  } else if (Array.isArray(payload)) {
    rawList = payload as Array<Record<string, unknown>>;
  } else {
    rawList = [rawObj];
  }
  const now = Date.now();

  return rawList
    .filter(
      (item): item is Record<string, unknown> =>
        !!item && typeof item === 'object' &&
        (context?.source === 'history' || (!isRecalledMessageItem(item) && !isCancelMessageItem(item)))
    )
    .map((item): KK9Message | null => {
      const nativeType = item['sessionType'] ?? sessionObj['type'] ?? rawObj['sessionType'];
      const sessionType: KK9Session['type'] = context?.session?.type ??
        (nativeType === 0 || nativeType === 'private' ? 'private' :
         nativeType === 1 || nativeType === 'group' ? 'group' :
         nativeType === 2 || nativeType === 'discussion' ? 'discussion' :
         nativeType === 3 || nativeType === 'service' ? 'service' :
         nativeType === undefined ? 'private' : 'unknown');
      const rawSender =
        item['senderName'] ??
        item['sendName'] ??
        item['fromUserName'] ??
        item['sender'] ??
        (item['isMe'] ? '我' : '未知用户');
      const sender = toSafeString(rawSender, '未知用户');

      const nestedIdentity = item['raw'] && typeof item['raw'] === 'object'
        ? item['raw'] as Record<string, unknown> : undefined;
      const rawSenderId = item['senderId'] ?? item['senderID'] ?? item['fromUID'] ??
        (typeof item['sender'] === 'number' || /^\d+$/.test(toSafeString(item['sender'])) ? item['sender'] : undefined) ??
        nestedIdentity?.['senderId'] ?? nestedIdentity?.['senderID'] ?? nestedIdentity?.['fromUID'] ??
        (typeof nestedIdentity?.['sender'] === 'number' || /^\d+$/.test(toSafeString(nestedIdentity?.['sender'])) ? nestedIdentity?.['sender'] : undefined);
      const senderId = rawSenderId !== undefined ? toSafeString(rawSenderId).trim() : undefined;

      const contentObj =
        tryParseJson(item['content']) ||
        (typeof item['content'] === 'object' ? (item['content'] as Record<string, unknown>) : null);
      const content = extractTextContent(item['content'], item['notifyMsg'], item['contentType']);
      const rawTime = item['time'] ?? item['sendTime'];
      const time = toSafeString(rawTime, new Date(now).toLocaleTimeString());

      const isMe = Boolean(currentUserId && senderId && senderId === currentUserId);

      let timestamp = now;
      const rawTs =
        item['timestamp'] ??
        item['sendTime'] ??
        item['msgTime'] ??
        item['createTime'] ??
        item['time'];
      if (typeof rawTs === 'number') {
        timestamp = rawTs < 10000000000 ? rawTs * 1000 : rawTs;
      } else if (typeof rawTs === 'string') {
        const parsed = Number(rawTs);
        if (!isNaN(parsed) && parsed > 0) {
          timestamp = parsed < 10000000000 ? parsed * 1000 : parsed;
        } else {
          const dateParsed = new Date(rawTs).getTime();
          if (!isNaN(dateParsed)) timestamp = dateParsed;
        }
      }

      const rawMentionsRecord =
        item['mentions'] && typeof item['mentions'] === 'object'
          ? (item['mentions'] as Record<string, unknown>)
          : null;
      const mentionedUsers = Array.isArray(rawMentionsRecord?.['mentionedUsers'])
        ? rawMentionsRecord['mentionedUsers'].filter(
            (user): user is string => typeof user === 'string'
          )
        : [];
      const rawMentions: KK9MentionInfo | undefined = rawMentionsRecord
        ? {
            isAtMe: rawMentionsRecord['isAtMe'] === true,
            isAtAll: rawMentionsRecord['isAtAll'] === true,
            mentionedUsers,
          }
        : undefined;
      let atMe = Boolean(
        item['atMe'] || item['isAtMe'] || rawMentions?.isAtMe || item['atState'] === 2
      );
      let atAll = Boolean(
        item['atAll'] || item['isAtAll'] || rawMentions?.isAtAll || item['atState'] === 3
      );

      const atMemberList = Array.isArray(item['atMemberIDList'])
        ? item['atMemberIDList']
        : (rawMentions?.mentionedUsers ?? []);
      if (
        atMemberList.includes('all') ||
        atMemberList.includes(-1) ||
        atMemberList.includes('-1')
      ) {
        atAll = true;
      }
      if (
        currentUserId &&
        (atMemberList.includes(currentUserId) || atMemberList.includes(Number(currentUserId)))
      ) {
        atMe = true;
      }

      let mentions: KK9MentionInfo | undefined;
      if (atMe || atAll || atMemberList.length > 0) {
        mentions = {
          isAtMe: atMe,
          isAtAll: atAll,
          mentionedUsers: atMemberList.map(u => toSafeString(u)),
        };
      }

      let replyTo: KK9ReplyInfo | undefined;
      if (item['replyTo'] && typeof item['replyTo'] === 'object') {
        replyTo = item['replyTo'] as KK9ReplyInfo;
      } else if (item['replyMsg'] && typeof item['replyMsg'] === 'object') {
        const r = item['replyMsg'] as Record<string, unknown>;
        replyTo = {
          replyToSender: toSafeString(r['sender'] ?? r['senderName'] ?? r['replyToSender'], ''),
          replyToContent: toSafeString(r['content'] ?? r['text'] ?? r['replyToContent'], ''),
          replyToId:
            (r['id'] ?? r['replyToId']) ? toSafeString(r['id'] ?? r['replyToId']) : undefined,
        };
      }

      let images: KK9ImageInfo[] | undefined;
      if (Array.isArray(item['images'])) {
        images = item['images'] as KK9ImageInfo[];
      } else if (contentObj && Array.isArray(contentObj['content'])) {
        const list = contentObj['content'] as Array<Record<string, unknown>>;
        const imgNodes = list.filter(
          c => c && (c['type'] === 1 || c['filepath'] || c['filepath_h'] || c['uri'])
        );
        if (imgNodes.length > 0) {
          images = imgNodes.map(c => {
            const fp = toSafeString(c['filepath'] || c['filepath_h']);
            return {
              filePath: fp || undefined,
              url: c['url']
                ? toSafeString(c['url'])
                : fp
                  ? 'file:///' + fp.replace(/\\/g, '/')
                  : undefined,
              uri: c['uri'] || c['uri_h'] ? toSafeString(c['uri'] || c['uri_h']) : undefined,
              mimeType: c['mimetype'] ? toSafeString(c['mimetype']) : 'image/png',
              width: typeof c['width'] === 'number' ? c['width'] : undefined,
              height: typeof c['height'] === 'number' ? c['height'] : undefined,
              size: typeof c['size'] === 'number' ? c['size'] : undefined,
            };
          });
        }
      } else if (item['picPath'] || item['imgUrl'] || item['picUrl']) {
        const fp = item['picPath'] ? toSafeString(item['picPath']) : undefined;
        images = [
          {
            filePath: fp,
            url: item['imgUrl']
              ? toSafeString(item['imgUrl'])
              : item['picUrl']
                ? toSafeString(item['picUrl'])
                : fp
                  ? 'file:///' + fp.replace(/\\/g, '/')
                  : undefined,
            width: typeof item['width'] === 'number' ? item['width'] : undefined,
            height: typeof item['height'] === 'number' ? item['height'] : undefined,
          },
        ];
      }

      let fileInfo: KK9FileInfo | undefined;
      if (Number(item['contentType']) !== 2) {
        if (item['fileInfo'] && typeof item['fileInfo'] === 'object') {
          fileInfo = item['fileInfo'] as KK9FileInfo;
        } else if (
          contentObj &&
          (contentObj['filename'] ||
            contentObj['fileName'] ||
            contentObj['filepath'] ||
            contentObj['filePath'])
        ) {
          const fileName = toSafeString(
            contentObj['filename'] || contentObj['fileName'],
            '未知文件'
          );
          const extMatch =
            fileName.lastIndexOf('.') !== -1
              ? fileName.slice(fileName.lastIndexOf('.'))
              : undefined;
          fileInfo = {
            fileName,
            filePath: toSafeString(contentObj['filepath'] || contentObj['filePath']) || undefined,
            fileSize: toSafeString(contentObj['size'] || contentObj['fileSize']) || undefined,
            fileExt: extMatch,
          };
        } else if (item['fileName'] || item['filePath']) {
          const fileName = toSafeString(item['fileName'], '未知文件');
          const extMatch =
            fileName.lastIndexOf('.') !== -1
              ? fileName.slice(fileName.lastIndexOf('.'))
              : undefined;
          fileInfo = {
            fileName,
            fileSize:
              typeof item['fileSize'] === 'string'
                ? item['fileSize']
                : typeof item['fileSizeFormatted'] === 'string'
                  ? item['fileSizeFormatted']
                  : item['fileSize'] !== undefined
                    ? toSafeString(item['fileSize'])
                    : undefined,
            fileExt: typeof item['fileExt'] === 'string' ? item['fileExt'] : extMatch,
            filePath: typeof item['filePath'] === 'string' ? item['filePath'] : undefined,
          };
        }
      }

      const messageType = isCancelMessageItem(item)
        ? 'system'
        : determineMessageType(item, images, fileInfo, replyTo);

      const nestedRaw =
        item['raw'] && typeof item['raw'] === 'object'
          ? (item['raw'] as Record<string, unknown>)
          : undefined;
      const nativeMessageId =
        [
          item['msgID'],
          item['msgId'],
          item['messageId'],
          item['id'],
          nestedRaw?.['msgID'],
          nestedRaw?.['msgId'],
          nestedRaw?.['messageId'],
          nestedRaw?.['id'],
        ]
          .map(value => toSafeString(value).trim())
          .find(Boolean) ?? '';

      let sessionId = baseSessionId;
      // 在私聊场景下，若为他人发来的入站消息（!isMe）：
      // 1. 会话 partner 必然是发送者 senderId。
      // 2. 如果 sessionId 缺失、或者错误地指向了机器人自身 (0-currentUserId 或 currentUserId)，
      //    必须收敛纠正为 0-senderId，确保不会在客户端寻找自身会话失败，也不会导致多用户会话串线。
      if (sessionType === 'private' && !isMe && senderId && !sessionObj['id'] && !rawObj['sessionID']) {
        if (
          !sessionId ||
          (currentUserId &&
            (sessionId === `0-${currentUserId}` || sessionId === currentUserId))
        ) {
          sessionId = `0-${senderId}`;
        }
      }

      let effectiveSessionName = sessionName;
      if (
        sessionType === 'private' &&
        !isMe &&
        sender &&
        sender !== '未知用户' &&
        (!rawSessionName ||
          rawSessionName === baseSessionId ||
          (currentUserId &&
            (rawSessionName === currentUserId || rawSessionName === `0-${currentUserId}`)))
      ) {
        effectiveSessionName = sender;
      }

      const missingFields: Array<'sessionId' | 'nativeMessageId'> = [];
      if (!sessionId) {
        missingFields.push('sessionId');
      }
      if (!nativeMessageId) {
        missingFields.push('nativeMessageId');
      }

      if (missingFields.length > 0) {
        context?.onDiagnostic?.({
          kind: 'missing_inbound_identity',
          missingFields,
          sessionId,
          source: context?.source ?? 'unknown',
          observedAt: Date.now(),
        });
        return null;
      }

      const direction: MessageDirection = messageType === 'system' || !currentUserId || !senderId
        ? 'unknown' : isMe ? 'outbound' : 'inbound';
      const origin: KK9MessageOrigin = messageType === 'system' ? 'system'
        : direction === 'inbound' ? 'external' : 'unknown';

      return {
        id: nativeMessageId,
        messageId: nativeMessageId,
        msgIdx: typeof item['msgIdx'] === 'number' ? item['msgIdx'] : undefined,
        sessionId,
        sessionName: effectiveSessionName,
        sessionType,
        origin,
        direction,
        sender,
        senderId,
        content,
        time,
        isMe,
        timestamp,
        messageType,
        isRecalled: isRecalledMessageItem(item),
        atMe,
        atAll,
        mentions,
        replyTo,
        fileInfo,
        images,
        raw: item,
      };
    })
    .filter((msg): msg is KK9Message => msg !== null);
}

export function extractRecalledEventsFromPayload(
  payload: unknown,
  sessionContext?: Partial<KK9Session>
): KK9RecalledEvent[] {
  if (!payload || typeof payload !== 'object') {
    return [];
  }

  const rawObj = payload as Record<string, unknown>;
  const events: KK9RecalledEvent[] = [];
  const defaultSessionId = resolvePublicSessionId(rawObj, sessionContext?.id);

  let rawList: Array<Record<string, unknown>>;
  if (Array.isArray(rawObj['messages'])) {
    rawList = rawObj['messages'] as Array<Record<string, unknown>>;
  } else if (Array.isArray(rawObj['message'])) {
    rawList = rawObj['message'] as Array<Record<string, unknown>>;
  } else if (rawObj['message'] && typeof rawObj['message'] === 'object') {
    rawList = [rawObj['message'] as Record<string, unknown>];
  } else if (Array.isArray(rawObj['data'])) {
    rawList = rawObj['data'] as Array<Record<string, unknown>>;
  } else if (rawObj['data'] && typeof rawObj['data'] === 'object') {
    rawList = [rawObj['data'] as Record<string, unknown>];
  } else if (Array.isArray(payload)) {
    rawList = payload as Array<Record<string, unknown>>;
  } else {
    rawList = [rawObj];
  }

  for (const item of rawList) {
    if (!item || typeof item !== 'object' || isRecalledMessageItem(item)) continue;
    const contentObj = Number(item['contentType']) === 6 ? tryParseJson(item['content']) : null;
    const contentIsCancel =
      contentObj &&
      (contentObj['event'] === 'CancelMessage' || contentObj['type'] === 'CancelMessage');
    const explicitRecall =
      item['event'] === 'CancelMessage' || item['type'] === 'CancelMessage' ||
      item['type'] === 'recalled' || item['type'] === 'revokeMsg';
    if (!contentIsCancel && !explicitRecall) continue;

    // 系统通知自身 ID 不是撤回目标，目标缺失时不能回退到通知记录。
    const target = contentIsCancel && contentObj ? contentObj : item;
    const messageId = toSafeString(
      target['msgID'] ?? target['msgId'] ?? target['messageId'] ?? target['id']
    ).trim();
    if (!messageId) continue;
    const itemSession =
      item['session'] && typeof item['session'] === 'object'
        ? (item['session'] as Record<string, unknown>)
        : undefined;
    const sessionId =
      toSafeString(item['sessionID'] ?? itemSession?.['id']).trim() ||
      defaultSessionId || resolvePublicSessionId(item);
    events.push({
      messageId,
      sessionId,
      sender: toSafeString(
        item['sender'] ?? item['senderName'] ?? item['fromUserName'] ?? contentObj?.['sender'],
        '某人'
      ),
      time: toSafeString(item['time'] ?? item['sendTime'], new Date().toLocaleTimeString()),
      timestamp: typeof item['timestamp'] === 'number' ? item['timestamp'] : Date.now(),
    });
  }

  return events;
}

export function normalizeRecalledEvent(payload: unknown): KK9RecalledEvent | null {
  if (!payload || typeof payload !== 'object') return null;
  const raw = payload as Record<string, unknown>;
  const events = extractRecalledEventsFromPayload({ ...raw, event: 'CancelMessage' });
  return events[0] ?? null;
}
