#!/usr/bin/env node
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { closeDb, openDb } from './db.js';
import { importSnapshot } from './importer.js';
import { XmlError } from './xml.js';
import {
  createFeed,
  exportData,
  getArticle,
  getFeedByCode,
  listArticles,
  listFeeds,
  listSnapshots,
  getSnapshotReport,
  setRead
} from './repo.js';
import { startServer } from './server.js';

const DEFAULT_DB = resolve('data/rss.db');

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function parseCommon(): { dbPath: string; positionals: string[]; values: Record<string, string | boolean> } {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      db: { type: 'string', default: DEFAULT_DB },
      feed: { type: 'string' },
      file: { type: 'string' },
      code: { type: 'string' },
      title: { type: 'string' },
      link: { type: 'string' },
      id: { type: 'string' },
      read: { type: 'string' },
      port: { type: 'string', default: '0' },
      format: { type: 'string', default: 'json' },
      out: { type: 'string' }
    }
  });
  return { dbPath: values.db as string, positionals, values: values as Record<string, string | boolean> };
}

function requireFeedCode(values: Record<string, unknown>): string {
  if (!values.feed) throw new Error('缺少必填参数 --feed <code>');
  return String(values.feed);
}

function summarizeReport(report: Awaited<ReturnType<typeof importSnapshot>>): unknown {
  return {
    snapshotId: report.snapshotId,
    added: report.added.map((e) => ({ basis: e.identityBasis, identity: e.identity, title: e.title })),
    updated: report.updated.map((e) => ({
      basis: e.identityBasis,
      identity: e.identity,
      title: e.title,
      changedFields: e.changedFields,
      revisionNo: e.revisionNo
    })),
    unchanged: report.unchanged.map((e) => ({ basis: e.identityBasis, identity: e.identity, title: e.title })),
    invalid: report.invalid
  };
}

async function runDemo(dbPath: string): Promise<void> {
  try {
    rmSync(dbPath, { force: true });
  } catch {
    /* 忽略删除失败 */
  }
  const db = openDb(dbPath);
  const log = (msg: string): void => {
    process.stdout.write(`\n=== ${msg} ===\n`);
  };

  log('注册订阅源 weekly');
  createFeed(db, 'weekly', '技术周刊', 'https://weekly.example.com/');
  print(listFeeds(db));

  const importFile = (file: string) => {
    const xml = readFileSync(resolve(file), 'utf8');
    const feed = getFeedByCode(db, 'weekly')!;
    return importSnapshot(db, feed.id, feed.code, xml, file);
  };

  log('导入快照 1：预期 新增 3（guid-rust-180 / guid-node22 / 链接回退），无效 1');
  print(summarizeReport(importFile('demo/snapshot1.xml')));

  log('将 guid-node22（标题更正前）标记为已读');
  const before = listArticles(db, { feedCode: 'weekly' });
  const nodeArticle = before.find((a) => a.identity === 'guid-node22');
  if (!nodeArticle) throw new Error('演示数据异常：未找到 guid-node22');
  setRead(db, nodeArticle.article_id, true);
  print({ articleId: nodeArticle.article_id, isRead: true });

  log('导入快照 2：预期 新增 1，更新 1（标题更正），未变 2（含 CDATA/空白等价），无效 0');
  print(summarizeReport(importFile('demo/snapshot2.xml')));

  log('导入快照 3（重复导入快照 2 语义）：这里导入 snapshot3，预期 更新 1，未变 2；旧文 Rust 从列表消失');
  print(summarizeReport(importFile('demo/snapshot3.xml')));

  log('验证已读状态在标题更正与多轮更新后仍然保留');
  const after = listArticles(db, { feedCode: 'weekly' });
  const nodeAfter = after.find((a) => a.identity === 'guid-node22');
  print({
    identity: 'guid-node22',
    title: nodeAfter?.title,
    isRead: Boolean(nodeAfter?.is_read),
    revisionCount: nodeAfter?.revision_count
  });

  log('默认列表只含当前快照中仍出现的文章；加 present=false 可查看已消失旧文（含已读状态）');
  print({
    present: listArticles(db, { feedCode: 'weekly' }).map((a) => a.identity),
    missing: listArticles(db, { feedCode: 'weekly', present: false }).map((a) => ({
      identity: a.identity,
      title: a.title,
      isRead: Boolean(a.is_read)
    }))
  });

  log('查看 guid-node22 的修订对比（revision 1 -&gt; 2）');
  print(getArticle(db, nodeArticle.article_id));

  closeDb(db);
  process.stdout.write(`\n演示完成，数据库位于 ${dbPath}\n`);
}

async function main(): Promise<void> {
  const { dbPath, positionals, values } = parseCommon();
  const command = positionals[0] ?? 'help';

  if (command === 'help' || command === '--help' || command === '-h') {
    process.stdout.write(
      [
        '用法: rss-cli <命令> [选项]',
        '命令:',
        '  serve                         启动 HTTP API（--port，默认 0 = 系统分配空闲端口）',
        '  feed-add    --code --title [--link]',
        '  feeds                         列出订阅源',
        '  import      --feed <code> --file <xml>',
        '  articles    [--feed <code>] [--read true|false]',
        '  read        --id <文章ID> --read true|false',
        '  revisions   --id <文章ID>     查看文章全部修订',
        '  snapshots   [--feed <code>]   列出导入快照',
        '  report      --id <快照ID>     查看某次导入报告',
        '  export      [--feed <code>] [--format json|xml] [--out 文件]',
        '  demo                          运行三份连续快照的完整演示',
        `全局选项 --db <路径>（默认 ${DEFAULT_DB}）`
      ].join('\n') + '\n'
    );
    return;
  }

  if (command === 'demo') {
    await runDemo(dbPath);
    return;
  }

  if (command === 'serve') {
    const db = openDb(dbPath);
    const port = Number(values.port ?? 0);
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
      throw new Error('--port 必须是 0-65535 的整数');
    }
    const { port: actual } = await startServer(db, port);
    process.stdout.write(`HTTP API 已启动: http://127.0.0.1:${actual}  (Ctrl+C 退出)\n`);
    return;
  }

  const db = openDb(dbPath);
  try {
    switch (command) {
      case 'feed-add': {
        if (!values.code || !/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(String(values.code))) {
          throw new Error('--code 必须为 1-64 位字母/数字/_/-，且以字母或数字开头');
        }
        if (!values.title) throw new Error('缺少 --title');
        const feed = createFeed(
          db,
          String(values.code),
          String(values.title),
          values.link ? String(values.link) : null
        );
        print(feed);
        break;
      }
      case 'feeds':
        print(listFeeds(db));
        break;
      case 'import': {
        if (!values.file) throw new Error('缺少 --file <xml 路径>');
        const code = requireFeedCode(values);
        const feed = getFeedByCode(db, code);
        if (!feed) throw new Error(`订阅源不存在: ${code}`);
        const xml = readFileSync(resolve(String(values.file)), 'utf8');
        try {
          print({ report: summarizeReport(importSnapshot(db, feed.id, feed.code, xml, String(values.file))) });
        } catch (e) {
          if (e instanceof XmlError) throw new Error(`INVALID_XML: ${e.message}`);
          throw e;
        }
        break;
      }
      case 'articles': {
        let read: boolean | undefined;
        if (values.read !== undefined) {
          if (!['true', 'false'].includes(String(values.read))) throw new Error("--read 只能是 true 或 false");
          read = String(values.read) === 'true';
        }
        print({
          articles: listArticles(db, { feedCode: values.feed ? String(values.feed) : undefined, read })
        });
        break;
      }
      case 'read': {
        if (!values.id) throw new Error('缺少 --id');
        if (!['true', 'false'].includes(String(values.read))) throw new Error("--read 只能是 true 或 false");
        const ok = setRead(db, Number(values.id), String(values.read) === 'true');
        if (!ok) throw new Error(`文章不存在: ${values.id}`);
        print({ articleId: Number(values.id), isRead: String(values.read) === 'true' });
        break;
      }
      case 'revisions': {
        if (!values.id) throw new Error('缺少 --id');
        const article = getArticle(db, Number(values.id));
        if (!article) throw new Error(`文章不存在: ${values.id}`);
        print({ article });
        break;
      }
      case 'snapshots':
        print({ snapshots: listSnapshots(db, values.feed ? String(values.feed) : undefined) });
        break;
      case 'report': {
        if (!values.id) throw new Error('缺少 --id');
        const report = getSnapshotReport(db, Number(values.id));
        if (!report) throw new Error(`快照不存在: ${values.id}`);
        print(report);
        break;
      }
      case 'export': {
        const format = String(values.format ?? 'json') === 'xml' ? 'xml' : 'json';
        const data = exportData(db, format, values.feed ? String(values.feed) : undefined);
        if (values.out) writeFileSync(resolve(String(values.out)), data, 'utf8');
        else process.stdout.write(data + '\n');
        break;
      }
      default:
        throw new Error(`未知命令: ${command}（运行 cli help 查看用法）`);
    }
  } finally {
    closeDb(db);
  }
}

main().catch((e: Error) => {
  process.stderr.write(`错误: ${e.message}\n`);
  process.exit(1);
});
