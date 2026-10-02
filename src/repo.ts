import type { DatabaseSync } from 'node:sqlite';
import { toXml } from './xml.js';

export function createFeed(
  db: DatabaseSync,
  code: string,
  title: string,
  link: string | null
): { id: number } {
  const result = db
    .prepare('INSERT INTO feeds (code, title, link) VALUES (?, ?, ?)')
    .run(code, title, link) as { lastInsertRowid: number | bigint };
  return { id: Number(result.lastInsertRowid) };
}

export function getFeedByCode(db: DatabaseSync, code: string) {
  return db.prepare('SELECT * FROM feeds WHERE code = ?').get(code) as
    | { id: number; code: string; title: string; link: string | null }
    | undefined;
}

export function getFeedById(db: DatabaseSync, id: number) {
  return db.prepare('SELECT * FROM feeds WHERE id = ?').get(id) as
    | { id: number; code: string; title: string; link: string | null }
    | undefined;
}

export function listFeeds(db: DatabaseSync) {
  return db
    .prepare(
      `SELECT f.*,
              (SELECT COUNT(*) FROM articles a WHERE a.feed_id = f.id) AS article_count,
              (SELECT COUNT(*) FROM articles a WHERE a.feed_id = f.id AND a.is_read = 1) AS read_count
       FROM feeds f ORDER BY f.id`
    )
    .all();
}

export interface ArticleQuery {
  feedCode?: string;
  read?: boolean;
  present?: boolean;
}

export interface ArticleRow {
  article_id: number;
  feed_code: string;
  identity: string;
  identity_basis: 'guid' | 'link';
  is_read: number;
  present: number;
  title: string;
  link: string | null;
  pub_date_iso: string | null;
  pub_date_valid: number;
  revision_count: number;
}

/**
 * 文章列表：按最新修订发布时间升序；
 * 非法/缺失日期 pub_date_iso 为 NULL，SQLite 升序中 NULL 排在最前，保证顺序确定。
 * 其次以 article_id 升序兜底，保证完全稳定。
 */
export function listArticles(db: DatabaseSync, q: ArticleQuery): ArticleRow[] {
  const where: string[] = [];
  const params: Array<string | number> = [];
  if (q.feedCode) {
    where.push('f.code = ?');
    params.push(q.feedCode);
  }
  if (q.read !== undefined) {
    where.push('a.is_read = ?');
    params.push(q.read ? 1 : 0);
  }
  if (q.present !== undefined) {
    where.push('a.present = ?');
    params.push(q.present ? 1 : 0);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  return db
    .prepare(
      `SELECT a.id AS article_id, f.code AS feed_code, a.identity, a.identity_basis,
              a.is_read, a.present,
              r.title, r.link, r.pub_date_iso, r.pub_date_valid,
              (SELECT COUNT(*) FROM revisions rv WHERE rv.article_id = a.id) AS revision_count
       FROM articles a
       JOIN feeds f ON f.id = a.feed_id
       JOIN revisions r ON r.id = (
         SELECT id FROM revisions WHERE article_id = a.id ORDER BY revision_no DESC LIMIT 1
       )
       ${whereSql}
       ORDER BY r.pub_date_iso IS NOT NULL, r.pub_date_iso ASC, a.id ASC`
    )
    .all(...params) as unknown as ArticleRow[];
}

export function setRead(db: DatabaseSync, articleId: number, read: boolean): boolean {
  const result = db.prepare('UPDATE articles SET is_read = ? WHERE id = ?').run(
    read ? 1 : 0,
    articleId
  );
  return result.changes > 0;
}

export function getArticle(db: DatabaseSync, articleId: number) {
  const article = db
    .prepare(
      `SELECT a.id AS article_id, f.code AS feed_code, a.identity, a.identity_basis,
              a.is_read, a.present
       FROM articles a JOIN feeds f ON f.id = a.feed_id WHERE a.id = ?`
    )
    .get(articleId) as
    | {
        article_id: number;
        feed_code: string;
        identity: string;
        identity_basis: string;
        is_read: number;
        present: number;
      }
    | undefined;
  if (!article) return undefined;
  const revisions = db
    .prepare(
      `SELECT revision_no, title, link, guid_value, description, pub_date_raw,
              pub_date_iso, pub_date_valid, snapshot_id, created_at
       FROM revisions WHERE article_id = ? ORDER BY revision_no ASC`
    )
    .all(articleId);
  return { ...article, revisions };
}

export interface ExportData {
  exportedAt: string;
  feeds: unknown[];
  articles: unknown[];
  revisions: unknown[];
}

export function exportData(db: DatabaseSync, format: 'json' | 'xml', feedCode?: string): string {
  const params: Array<string | number> = [];
  let feedFilter = '';
  if (feedCode) {
    feedFilter = 'WHERE code = ?';
    params.push(feedCode);
  }
  const feeds = db.prepare(`SELECT * FROM feeds ${feedFilter} ORDER BY id`).all(...params);
  const ids = (feeds as Array<{ id: number }>).map((f) => f.id);
  const placeholder = ids.map(() => '?').join(',');
  const articles = ids.length
    ? (db
        .prepare(`SELECT * FROM articles WHERE feed_id IN (${placeholder}) ORDER BY id`)
        .all(...ids) as unknown[])
    : [];
  const articleIds = (articles as Array<{ id: number }>).map((a) => a.id);
  const ap = articleIds.map(() => '?').join(',');
  const revisions = articleIds.length
    ? (db
        .prepare(`SELECT * FROM revisions WHERE article_id IN (${ap}) ORDER BY id`)
    .all(...articleIds) as unknown[])
    : [];

  const payload: ExportData = {
    exportedAt: new Date().toISOString(),
    feeds,
    articles,
    revisions
  };
  if (format === 'json') return JSON.stringify(payload, null, 2);
  return toXml({ export: payload });
}

export function listSnapshots(db: DatabaseSync, feedCode?: string) {
  if (feedCode) {
    return db
      .prepare(
        `SELECT s.id, s.feed_id, f.code AS feed_code, s.imported_at, s.source,
                length(s.raw_xml) AS raw_bytes
         FROM snapshots s JOIN feeds f ON f.id = s.feed_id
         WHERE f.code = ? ORDER BY s.id`
      )
      .all(feedCode);
  }
  return db
    .prepare(
      `SELECT s.id, s.feed_id, f.code AS feed_code, s.imported_at, s.source,
              length(s.raw_xml) AS raw_bytes
       FROM snapshots s JOIN feeds f ON f.id = s.feed_id ORDER BY s.id`
    )
    .all();
}

export function getSnapshotReport(db: DatabaseSync, snapshotId: number) {
  const row = db
    .prepare('SELECT report_json FROM snapshots WHERE id = ?')
    .get(snapshotId) as { report_json: string } | undefined;
  return row ? (JSON.parse(row.report_json) as unknown) : undefined;
}
