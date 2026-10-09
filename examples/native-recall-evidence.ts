type Row = Record<string, unknown>;

export interface NativeRecallEvidence {
  targetIds: string[];
  uid: string;
  peerId: string;
  capture: { requests: Row[]; notices: Row[]; messages: Row[] };
  history: Row[];
  owned: Array<{ id: string; sessionId: string; kind: string }>;
  events: Array<{ messageId: string; sessionId: string }>;
}

export interface NativeRecallCheck {
  sessionId: string;
  kind: string;
  通过: boolean;
  messageIds: string[];
}

/** 按本轮原生身份和动作判定，不要求人工操作预备文本或匹配正文标签。 */
export function verifyNativeRecallEvidence(evidence: NativeRecallEvidence): NativeRecallCheck[] {
  const { targetIds, uid, peerId, capture, history, owned, events } = evidence;
  const checks: NativeRecallCheck[] = [];
  for (const sessionId of targetIds) {
    const sdk = owned.find(item => item.sessionId === sessionId && item.kind === 'SDK');
    const sdkIndex = Number(capture.requests.find(item => item['sessionId'] === sessionId &&
      item['messageId'] === sdk?.id && item['phase'] === 'SDK')?.['msgIdx']);
    for (const kind of ['SDK', '人工', '远端']) {
      const ids = kind === '远端'
        ? capture.messages.filter(item => item['phase'] === '监听' && item['sessionId'] === sessionId &&
          item['senderId'] === peerId && item['contentType'] === 4).map(item => String(item['id']))
        : kind === '人工'
          ? capture.requests.filter(item => item['phase'] === '监听' && item['sessionId'] === sessionId &&
            item['type'] === 'own' && item['code'] === 0 && Number(item['msgIdx']) > sdkIndex)
            .map(item => String(item['messageId']))
          : sdk ? [sdk.id] : [];
      const valid = ids.filter(id => {
        const original = history.find(item => item['sessionId'] === sessionId && item['id'] === id);
        const notice = capture.notices.find(item => item['sessionId'] === sessionId &&
          item['messageId'] === id && Number(item['byAdmin']) === 0);
        const action = capture.requests.find(item => item['sessionId'] === sessionId && item['messageId'] === id &&
          item['code'] === 0 && item['type'] === 'own' && item['phase'] === (kind === '人工' ? '监听' : 'SDK'));
        return events.filter(item => item.sessionId === sessionId && item.messageId === id).length === 1 &&
          original?.['isRecalled'] === true && original['senderId'] === (kind === '远端' ? peerId : uid) &&
          (kind === '远端' ? Boolean(notice) : Boolean(action));
      });
      checks.push({ sessionId, kind, 通过: valid.length > 0, messageIds: valid });
    }
  }
  return checks;
}
