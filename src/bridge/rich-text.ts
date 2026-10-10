import type { FormattedText, SendOptions } from '../types/index.js';

export interface KK9FontPayload {
  bold: number;
  fontfamily: string;
  size: number;
  italic: number;
  underline: number;
  color?: number;
}

/** 仅编译已确认的消息级字体；不解析或丢弃文字中的标记。 */
export function parseFormattedTextToKK(formatted: FormattedText): { plainText: string; font: KK9FontPayload } {
  if (typeof formatted !== 'string' && (!formatted || Array.isArray(formatted) || typeof formatted.text !== 'string' ||
      Object.keys(formatted).some(key => key !== 'text' && key !== 'font'))) {
    throw new Error('富文本只接受字符串或{text, font}，不支持HTML或逐段样式');
  }
  const plainText = typeof formatted === 'string' ? formatted : formatted.text;
  const style = typeof formatted === 'string' ? undefined : formatted.font;
  if (style !== undefined && (!style || typeof style !== 'object' || Array.isArray(style) ||
      Object.keys(style).some(key => !['bold', 'italic', 'underline', 'fontSize', 'fontFamily', 'color'].includes(key)))) {
    throw new Error('不支持的消息级字体字段');
  }
  for (const flag of ['bold', 'italic', 'underline'] as const) {
    if (style?.[flag] !== undefined && typeof style[flag] !== 'boolean') throw new Error(`${flag}必须为布尔值`);
  }
  if (style?.fontSize !== undefined && (!Number.isFinite(style.fontSize) || style.fontSize <= 0)) throw new Error('fontSize必须为正数字，单位pt');
  if (style?.fontFamily !== undefined && (typeof style.fontFamily !== 'string' || !style.fontFamily.trim())) throw new Error('fontFamily不能为空');
  if (style?.color !== undefined && (typeof style.color !== 'string' || !/^#[\da-f]{6}$/i.test(style.color))) throw new Error('color必须为#RRGGBB');
  const font: KK9FontPayload = {
    bold: style?.bold ? 1 : 0, italic: style?.italic ? 1 : 0, underline: style?.underline ? 1 : 0,
    fontfamily: style?.fontFamily ?? '微软雅黑', size: style?.fontSize ?? 10,
  };
  if (style?.color !== undefined) {
    const hex = style.color.slice(1);
    font.color = parseInt(hex.slice(4, 6) + hex.slice(2, 4) + hex.slice(0, 2), 16);
  }
  return { plainText, font };
}

export function buildMentionNodes(mentions?: SendOptions['mentions']): Array<Record<string, unknown>> {
  if (mentions === undefined) return [];
  return (Array.isArray(mentions) ? mentions : [mentions]).map(member => {
    if (member === 'all') return { type: 2, replyMemberID: -1, replyMemberType: 0,
      replyMemberName: '全体成员', replyMemberNameEN: 'All Members', replyMemberNameTC: '全體成員' };
    if (!member || typeof member !== 'object' || !/^[1-9]\d*$/.test(String(member.uid)) ||
        !Number.isSafeInteger(Number(member.uid)) || typeof member.name !== 'string' || !member.name.trim()) {
      throw new Error('提及必须提供真实用户UID和显示名，不接受昵称字符串');
    }
    const name = member.name.replace(/^@/, '');
    return { type: 2, replyMemberID: Number(member.uid), replyMemberType: 0,
      replyMemberName: name, replyMemberNameEN: name, replyMemberNameTC: name };
  });
}
