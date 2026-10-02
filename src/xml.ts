import { XMLParser, XMLBuilder, XMLValidator } from 'fast-xml-parser';
import { createHash } from 'node:crypto';

export interface ParsedItem {
  guid: string;
  link: string;
  title: string;
  description: string;
  pubDateRaw: string;
}

export interface ParsedFeed {
  title: string;
  link: string;
  items: ParsedItem[];
}

const parser = new XMLParser({
  ignoreAttributes: true,
  trimValues: true,
  cdataPropName: '__cdata',
  parseTagValue: false
});

/** 将 fast-xml-parser 可能产生的 CDATA 对象/数组节点归一为纯文本。 */
function textOf(node: unknown): string {
  if (node === null || node === undefined) return '';
  if (typeof node === 'string') return collapseSpace(node);
  if (typeof node === 'number' || typeof node === 'boolean') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (typeof node === 'object') {
    const obj = node as Record<string, unknown>;
    if ('__cdata' in obj) return textOf(obj.__cdata);
    if ('#text' in obj) return textOf(obj['#text']);
    return '';
  }
  return '';
}

/** 折叠所有连续空白（含换行/制表符）为单个空格并去首尾空白，用于内容规范化。 */
export function collapseSpace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/** 语义规范化：空白写法差异不视为内容变化。 */
export function normalizeText(value: string): string {
  return collapseSpace(value);
}

const RFC822_MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11
};

export interface DateResult {
  iso: string | null;
  valid: boolean;
}

/**
 * 解析 RSS 2.0 pubDate（RFC 822，如 "Tue, 11 Feb 2025 10:00:00 GMT"）。
 * 无效或缺失日期返回 valid=false，调用方按 epoch 0 排序，避免排序随机。
 */
export function parsePubDate(raw: string): DateResult {
  const value = normalizeText(raw);
  if (!value) return { iso: null, valid: false };
  const match = value.match(
    /^(?:[A-Za-z]{3},\s*)?(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([A-Za-z]{1,5}|[+-]\d{4})?)?/
  );
  if (!match) {
    const time = Date.parse(value);
    if (!Number.isNaN(time)) return { iso: new Date(time).toISOString(), valid: true };
    return { iso: null, valid: false };
  }
  const [, day, mon, year, hh, mm, ss, tz] = match;
  const month = RFC822_MONTHS[mon.toLowerCase()];
  if (month === undefined) return { iso: null, valid: false };
  const offsetMs = tz ? tzOffsetMs(tz) : 0;
  const utcMs = Date.UTC(
    Number(year), month, Number(day),
    Number(hh ?? 0), Number(mm ?? 0), Number(ss ?? 0)
  ) - offsetMs;
  if (Number.isNaN(utcMs)) return { iso: null, valid: false };
  return { iso: new Date(utcMs).toISOString(), valid: true };
}

function tzOffsetMs(tz: string): number {
  if (/^[+-]\d{4}$/.test(tz)) {
    const sign = tz[0] === '-' ? -1 : 1;
    return sign * (Number(tz.slice(1, 3)) * 60 + Number(tz.slice(3, 5))) * 60_000;
  }
  return 0; // GMT/UT/EST 等：RSS 快照演示统一按 UTC 处理
}

export function parseRss(xml: string): ParsedFeed {
  const validation = XMLValidator.validate(xml);
  if (validation !== true) {
    const err = validation as { err?: { msg?: string } };
    throw new XmlError(`XML 格式不合法: ${err.err?.msg ?? '未知错误'}`);
  }
  let doc: Record<string, unknown>;
  try {
    doc = parser.parse(xml) as Record<string, unknown>;
  } catch (e) {
    throw new XmlError(`XML 解析失败: ${(e as Error).message}`);
  }
  const rss = doc.rss as Record<string, unknown> | undefined;
  if (!rss) throw new XmlError('缺少 <rss> 根元素（仅支持 RSS 2.0）');
  const channel = rss.channel as Record<string, unknown> | undefined;
  if (!channel) throw new XmlError('缺少 <channel> 元素');
  const rawItems = channel.item;
  const itemNodes = rawItems === undefined ? [] : Array.isArray(rawItems) ? rawItems : [rawItems];
  const items: ParsedItem[] = itemNodes.map((node) => {
    const obj = (node ?? {}) as Record<string, unknown>;
    return {
      guid: textOf(obj.guid),
      link: textOf(obj.link),
      title: textOf(obj.title),
      description: textOf(obj.description),
      pubDateRaw: textOf(obj.pubDate)
    };
  });
  return {
    title: textOf(channel.title) || '(未命名订阅源)',
    link: textOf(channel.link),
    items
  };
}

export class XmlError extends Error {}

/** 文章语义内容指纹：标题、摘要、发布日期（原始归一值）任一变化则哈希变化。 */
export function contentHash(item: {
  title: string;
  description: string;
  pubDateRaw: string;
}): string {
  const basis = JSON.stringify({
    t: normalizeText(item.title),
    d: normalizeText(item.description),
    p: normalizeText(item.pubDateRaw)
  });
  return createHash('sha256').update(basis).digest('hex');
}

const builder = new XMLBuilder({ format: true, cdataPropName: '__cdata' });

export function toXml(value: unknown): string {
  return '<?xml version="1.0" encoding="UTF-8"?>\n' + builder.build(value);
}
