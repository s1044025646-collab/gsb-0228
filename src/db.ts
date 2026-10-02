import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export let dbInstance: DatabaseSync | null = null;

export function openDb(dbPath: string): DatabaseSync {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  migrate(db);
  dbInstance = db;
  return db;
}

export function closeDb(db: DatabaseSync): void {
  db.close();
  if (dbInstance === db) dbInstance = null;
}

function migrate(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS feeds (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      link TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      feed_id INTEGER NOT NULL REFERENCES feeds(id),
      imported_at TEXT NOT NULL DEFAULT (datetime('now')),
      raw_xml TEXT NOT NULL,
      source TEXT,
      report_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS articles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      feed_id INTEGER NOT NULL REFERENCES feeds(id),
      identity TEXT NOT NULL,
      identity_basis TEXT NOT NULL CHECK (identity_basis IN ('guid','link')),
      first_seen_snapshot INTEGER NOT NULL REFERENCES snapshots(id),
      last_seen_snapshot INTEGER NOT NULL REFERENCES snapshots(id),
      is_read INTEGER NOT NULL DEFAULT 0,
      present INTEGER NOT NULL DEFAULT 1,
      UNIQUE(feed_id, identity)
    );

    CREATE TABLE IF NOT EXISTS revisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      article_id INTEGER NOT NULL REFERENCES articles(id),
      revision_no INTEGER NOT NULL,
      title TEXT NOT NULL,
      link TEXT,
      guid_value TEXT,
      description TEXT,
      pub_date_raw TEXT,
      pub_date_iso TEXT,
      pub_date_valid INTEGER NOT NULL DEFAULT 1,
      content_hash TEXT NOT NULL,
      snapshot_id INTEGER NOT NULL REFERENCES snapshots(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(article_id, revision_no)
    );

    CREATE INDEX IF NOT EXISTS idx_articles_feed ON articles(feed_id, is_read);
    CREATE INDEX IF NOT EXISTS idx_revisions_article ON revisions(article_id, revision_no);
  `);
}

export interface FeedRow {
  id: number;
  code: string;
  title: string;
  link: string | null;
  created_at: string;
}
