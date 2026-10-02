import type { DatabaseSync } from 'node:sqlite';
import {
  contentHash,
  normalizeText,
  parsePubDate,
  parseRss,
  XmlError
} from './xml.js';

export interface ReportEntry {
  identity: string | null;
  identityBasis: 'guid' | 'link' | null;
  title: string;
}

export interface UpdatedEntry extends ReportEntry {
  changedFields: string[];
  revisionNo: number;
}

export interface InvalidEntry {
  index: number;
  title: string;
  guid: string;
  link: string;
  reason: string;
}

export interface ImportReport {
  feedId: number;
  feedCode: string;
  snapshotId: number | null;
  importedAt: string | null;
  identityRule: string;
  datePolicy: string;
  added: ReportEntry[];
  updated: UpdatedEntry[];
  unchanged: ReportEntry[];
  invalid: InvalidEntry[];
}

export function emptyReport(feedId: number, feedCode: string): ImportReport {
  return {
    feedId,
    feedCode,
    snapshotId: null,
    importedAt: null,
    identityRule:
      '同一订阅源内优先使用非空 <guid>；无 guid 时使用非空 <link>；两者皆缺失则记为无效条目，不生成随机身份。身份仅在同一 feed 内比较。',
    datePolicy:
      'pubDate 按 RFC 822 解析；无法解析时标记 pub_date_valid=0、pub_date_iso=NULL，列表按发布时间升序时以空值排在最前。',
    added: [],
    updated: [],
    unchanged: [],
    invalid: []
  };
}

/**
 * 导入一份 RSS 2.0 快照。整个过程在一个事务内完成：
 * 坏 XML 会在写入前抛出，已提交数据不受影响。
 */
export function importSnapshot(
  db: DatabaseSync,
  feedId: number,
  feedCode: string,
  xml: string,
  source: string | null
): ImportReport {
  const parsed = parseRss(xml); // 坏 XML 在此抛出，数据库无任何写入
  const report = emptyReport(feedId, feedCode);

  const findArticle = db.prepare(
    'SELECT id FROM articles WHERE feed_id = ? AND identity = ?'
  );
  const insertSnapshot = db.prepare(
    'INSERT INTO snapshots (feed_id, raw_xml, source, report_json) VALUES (?, ?, ?, ?)'
  );
  const insertArticle = db.prepare(
    `INSERT INTO articles (feed_id, identity, identity_basis, first_seen_snapshot, last_seen_snapshot)
     VALUES (?, ?, ?, ?, ?)`
  );
  const insertRevision = db.prepare(
    `INSERT INTO revisions
       (article_id, revision_no, title, link, guid_value, description, pub_date_raw, pub_date_iso, pub_date_valid, content_hash, snapshot_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const latestRevision = db.prepare(
    'SELECT * FROM revisions WHERE article_id = ? ORDER BY revision_no DESC LIMIT 1'
  );
  const touchArticle = db.prepare(
    'UPDATE articles SET last_seen_snapshot = ?, present = 1 WHERE id = ?'
  );
  const hideMissing = db.prepare(
    'UPDATE articles SET present = 0 WHERE feed_id = ? AND last_seen_snapshot != ?'
  );

  const seenIdentities = new Set<string>();

  db.exec('BEGIN');
  try {
    const snapshotResult = insertSnapshot.run(feedId, xml, source, JSON.stringify(report)) as {
      lastInsertRowid: number | bigint;
    };
    const snapshotId = Number(snapshotResult.lastInsertRowid);
    report.snapshotId = snapshotId;

    parsed.items.forEach((rawItem, index) => {
      const title = normalizeText(rawItem.title);
      const guid = normalizeText(rawItem.guid);
      const link = normalizeText(rawItem.link);

      let identity: string;
      let basis: 'guid' | 'link';
      if (guid) {
        identity = guid;
        basis = 'guid';
      } else if (link) {
        identity = link;
        basis = 'link';
      } else {
        report.invalid.push({
          index,
          title,
          guid,
          link,
          reason: '条目同时缺少非空 <guid> 与 <link>，无法确定稳定身份'
        });
        return;
      }

      if (seenIdentities.has(identity)) {
        report.invalid.push({
          index,
          title,
          guid,
          link,
          reason: `同一快照内身份 ${basis}=${identity} 重复，跳过该重复条目`
        });
        return;
      }
      seenIdentities.add(identity);

      const hash = contentHash(rawItem);
      const date = parsePubDate(rawItem.pubDateRaw);
      const existing = findArticle.get(feedId, identity) as { id: number } | undefined;

      if (!existing) {
        const articleResult = insertArticle.run(feedId, identity, basis, snapshotId, snapshotId) as {
          lastInsertRowid: number | bigint;
        };
        const articleId = Number(articleResult.lastInsertRowid);
        insertRevision.run(
          articleId, 1, title, link, guid, normalizeText(rawItem.description),
          normalizeText(rawItem.pubDateRaw), date.iso, date.valid ? 1 : 0, hash, snapshotId
        );
        report.added.push({ identity, identityBasis: basis, title });
        return;
      }

      const articleId = existing.id;
      const prev = latestRevision.get(articleId) as Record<string, unknown>;
      touchArticle.run(snapshotId, articleId);

      if (prev.content_hash === hash) {
        report.unchanged.push({ identity, identityBasis: basis, title });
        return;
      }

      const changedFields: string[] = [];
      if (prev.title !== title) changedFields.push('title');
      if (prev.description !== normalizeText(rawItem.description)) changedFields.push('description');
      if (prev.pub_date_raw !== normalizeText(rawItem.pubDateRaw)) changedFields.push('pubDate');

      const nextNo = Number(prev.revision_no) + 1;
      insertRevision.run(
        articleId, nextNo, title, link, guid, normalizeText(rawItem.description),
        normalizeText(rawItem.pubDateRaw), date.iso, date.valid ? 1 : 0, hash, snapshotId
      );
      report.updated.push({ identity, identityBasis: basis, title, changedFields, revisionNo: nextNo });
    });

    hideMissing.run(feedId, snapshotId);

    report.importedAt = new Date().toISOString();
    db.prepare('UPDATE snapshots SET report_json = ? WHERE id = ?').run(
      JSON.stringify(report),
      snapshotId
    );
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }

  return report;
}

export { XmlError };
