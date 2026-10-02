import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDb, openDb } from '../src/db.ts';
import type { DatabaseSync } from 'node:sqlite';
import { createFeed, getArticle, listArticles, setRead, exportData } from '../src/repo.ts';
import { importSnapshot } from '../src/importer.ts';
import { parsePubDate, parseRss } from '../src/xml.ts';

const demoDir = join(process.cwd(), 'demo');
const read = (name: string): string => readFileSync(join(demoDir, name), 'utf8');

let db: DatabaseSync;

before(() => {
  db = openDb(':memory:');
});

after(() => {
  closeDb(db);
});

test('快照1：3 新增 + 1 无效（缺 guid 和 link），身份依据正确', () => {
  createFeed(db, 'weekly', '技术周刊', null);
  const feedId = 1;
  const r1 = importSnapshot(db, feedId, 'weekly', read('snapshot1.xml'), 'snapshot1');
  assert.equal(r1.added.length, 3);
  assert.equal(r1.updated.length, 0);
  assert.equal(r1.unchanged.length, 0);
  assert.equal(r1.invalid.length, 1);
  assert.equal(r1.invalid[0].reason.includes('guid'), true);
  const byIdentity = Object.fromEntries(r1.added.map((e) => [e.identity, e.identityBasis]));
  assert.equal(byIdentity['guid-rust-180'], 'guid');
  assert.equal(byIdentity['guid-node22'], 'guid');
  assert.equal(byIdentity['https://weekly.example.com/no-guid-a'], 'link');
});

test('已读标记在后续标题更正后保留', () => {
  const node = listArticles(db, { feedCode: 'weekly' }).find((a) => a.identity === 'guid-node22')!;
  assert.equal(setRead(db, node.article_id, true), true);

  const r2 = importSnapshot(db, 1, 'weekly', read('snapshot2.xml'), 'snapshot2');
  assert.equal(r2.added.length, 1, '快照2 新增 SQLite 一篇');
  assert.equal(r2.updated.length, 1, '快照2 仅标题更正一篇');
  assert.equal(r2.unchanged.length, 2, 'CDATA 改写与空白差异均判为未变');
  assert.equal(r2.invalid.length, 0);
  assert.deepEqual(r2.updated[0].changedFields, ['title']);
  assert.equal(r2.updated[0].identity, 'guid-node22');

  const nodeAfter = listArticles(db, { feedCode: 'weekly' }).find((a) => a.identity === 'guid-node22')!;
  assert.equal(nodeAfter.title, 'Node.js v22 新特性介绍');
  assert.equal(nodeAfter.is_read, 1, '已读状态必须保留');
  assert.equal(nodeAfter.revision_count, 2);
});

test('快照3：内容更新产生修订，旧文消失仅标记 present=0 且已读不丢', () => {
  const r3 = importSnapshot(db, 1, 'weekly', read('snapshot3.xml'), 'snapshot3');
  assert.equal(r3.added.length, 0);
  assert.equal(r3.updated.length, 1);
  assert.equal(r3.unchanged.length, 2);

  const present = new Set(listArticles(db, { feedCode: 'weekly', present: true }).map((a) => a.identity));
  assert.equal(present.has('guid-rust-180'), false, '旧文从默认列表消失');
  const missing = listArticles(db, { feedCode: 'weekly', present: false });
  const rust = missing.find((a) => a.identity === 'guid-rust-180')!;
  assert.ok(rust, '旧文本地仍保留');
  setRead(db, rust.article_id, true);
});

test('重复导入相同快照：全部未变，不新增文章或修订', () => {
  const r = importSnapshot(db, 1, 'weekly', read('snapshot3.xml'), 'snapshot3-dup');
  assert.equal(r.added.length, 0);
  assert.equal(r.updated.length, 0);
  assert.equal(r.unchanged.length, 3);
  assert.equal(listArticles(db, { feedCode: 'weekly' }).find((a) => a.identity === 'guid-node22')!.revision_count, 2);
});

test('无 GUID 链接回退：链接变化不视为同一篇', () => {
  const xmlA = `<?xml version="1.0"?><rss version="2.0"><channel><title>X</title>
    <item><title>A</title><link>https://x/a</link></item></channel></rss>`;
  const xmlB = `<?xml version="1.0"?><rss version="2.0"><channel><title>X</title>
    <item><title>A</title><link>https://x/a-v2</link></item></channel></rss>`;
  createFeed(db, 'linkfb', '链接回退源', null);
  const r1 = importSnapshot(db, 2, 'linkfb', xmlA, null);
  const r2 = importSnapshot(db, 2, 'linkfb', xmlB, null);
  assert.equal(r1.added[0].identityBasis, 'link');
  assert.equal(r2.added.length, 1, '链接不同 = 不同身份，按新增处理而非随机 id');
  assert.equal(r2.unchanged.length, 0);
});

test('跨源身份隔离：不同源相同 GUID 不混淆', () => {
  const xml = `<?xml version="1.0"?><rss version="2.0"><channel><title>Y</title>
    <item><title>同名 GUID 文章</title><guid>SHARED-GUID</guid><link>https://y/1</link></item>
    </channel></rss>`;
  createFeed(db, 'other', '另一个源', null);
  const r = importSnapshot(db, 3, 'other', xml, null);
  assert.equal(r.added.length, 1);
  const otherArticle = listArticles(db, { feedCode: 'other' })[0];
  setRead(db, otherArticle.article_id, true);
  const weeklySame = listArticles(db, { feedCode: 'weekly' }).filter((a) => a.identity === 'SHARED-GUID');
  assert.equal(weeklySame.length, 0, 'weekly 源下不应出现 other 源的文章');
});

test('非法日期被明确标记且排序确定（无效日期排最前）', () => {
  assert.equal(parsePubDate('不是日期').valid, false);
  assert.equal(parsePubDate('').valid, false);
  assert.equal(parsePubDate('Tue, 11 Feb 2025 10:00:00 GMT').iso, '2025-02-11T10:00:00.000Z');
  const xml = `<?xml version="1.0"?><rss version="2.0"><channel><title>D</title>
    <item><title>坏日期</title><guid>bad-date</guid><pubDate>next week</pubDate></item>
    <item><title>好日期</title><guid>good-date</guid><pubDate>Mon, 03 Feb 2025 00:00:00 GMT</pubDate></item>
    </channel></rss>`;
  createFeed(db, 'dates', '日期源', null);
  importSnapshot(db, 4, 'dates', xml, null);
  const rows = listArticles(db, { feedCode: 'dates' });
  assert.equal(rows[0].identity, 'bad-date');
  assert.equal(rows[0].pub_date_valid, 0);
  assert.equal(rows[0].pub_date_iso, null);
});

test('坏 XML 导入失败：事务回滚，已有数据与快照数不变', () => {
  const before = listArticles(db, { feedCode: 'weekly' }).length;
  assert.throws(
    () => importSnapshot(db, 1, 'weekly', '<rss><channel><item><title>未闭合', null),
    /XML/
  );
  const after = listArticles(db, { feedCode: 'weekly' }).length;
  assert.equal(before, after);
});

test('同快照内重复身份条目进入无效清单', () => {
  const xml = `<?xml version="1.0"?><rss version="2.0"><channel><title>Dup</title>
    <item><title>A</title><guid>DUP</guid></item>
    <item><title>A again</title><guid>DUP</guid></item>
    </channel></rss>`;
  createFeed(db, 'dup', '重复身份源', null);
  const r = importSnapshot(db, 5, 'dup', xml, null);
  assert.equal(r.added.length, 1);
  assert.equal(r.invalid.length, 1);
});

test('修订历史可查，仅标题变化产生 revision 2', () => {
  const node = listArticles(db, { feedCode: 'weekly' }).find((a) => a.identity === 'guid-node22')!;
  const detail = getArticle(db, node.article_id)!;
  assert.equal(detail.revisions.length, 2);
  assert.equal((detail.revisions[0] as { title: string }).title, 'Node.js v22 新特性介召');
  assert.equal((detail.revisions[1] as { title: string }).title, 'Node.js v22 新特性介绍');
});

test('导出包含文章与修订（JSON）', () => {
  const data = JSON.parse(exportData(db, 'json')) as {
    feeds: unknown[];
    articles: unknown[];
    revisions: unknown[];
  };
  assert.ok(data.feeds.length >= 5);
  assert.ok(data.articles.length >= 7);
  assert.ok(data.revisions.length >= 8);
});

test('服务重启后仍能查询旧文章与修订（文件型 SQLite 持久化）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rss-test-'));
  const dbFile = join(dir, 'restart.db');
  const d1 = openDb(dbFile);
  createFeed(d1, 'persist', '持久化源', null);
  importSnapshot(d1, 1, 'persist', read('snapshot1.xml'), 's1');
  importSnapshot(d1, 1, 'persist', read('snapshot2.xml'), 's2');
  const article = listArticles(d1, { feedCode: 'persist' }).find((a) => a.identity === 'guid-node22')!;
  setRead(d1, article.article_id, true);
  closeDb(d1);

  const d2 = openDb(dbFile);
  const reopened = listArticles(d2, { feedCode: 'persist' }).find((a) => a.identity === 'guid-node22')!;
  assert.equal(reopened.title, 'Node.js v22 新特性介绍');
  assert.equal(reopened.is_read, 1);
  assert.equal(reopened.revision_count, 2);
  assert.equal(getArticle(d2, reopened.article_id)!.revisions.length, 2);
  closeDb(d2);
  rmSync(dir, { recursive: true, force: true });
});

test('parseRss 拒绝非 RSS 文档', () => {
  assert.throws(() => parseRss('<?xml version="1.0"?><feed><entry/></feed>'), /rss/);
});
