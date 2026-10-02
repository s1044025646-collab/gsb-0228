import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { XmlError } from './xml.js';
import { importSnapshot } from './importer.js';
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

export interface ApiError {
  status: number;
  code: string;
  message: string;
}

function error(status: number, code: string, message: string): ApiError {
  return { status, code, message };
}

function send(res: ServerResponse, status: number, body: unknown, contentType = 'application/json; charset=utf-8'): void {
  const payload = typeof body === 'string' ? body : JSON.stringify(body, null, 2);
  res.writeHead(status, { 'Content-Type': contentType });
  res.end(payload);
}

function sendError(res: ServerResponse, err: ApiError): void {
  send(res, err.status, { error: { code: err.code, message: err.message } });
}

async function readBody(req: IncomingMessage, maxBytes = 5 * 1024 * 1024): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw error(413, 'PAYLOAD_TOO_LARGE', `请求体超过 ${maxBytes} 字节限制`);
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function parseJsonBody(raw: string): Record<string, unknown> {
  if (!raw.trim()) return {};
  try {
    const value = JSON.parse(raw) as unknown;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw error(400, 'INVALID_JSON', 'JSON 请求体必须是对象');
    }
    return value as Record<string, unknown>;
  } catch (e) {
    if (e instanceof SyntaxError) {
      throw error(400, 'INVALID_JSON', 'JSON 解析失败');
    }
    throw e;
  }
}

const CODE_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

function requireFeed(db: DatabaseSync, code: string) {
  const feed = getFeedByCode(db, code);
  if (!feed) throw error(404, 'FEED_NOT_FOUND', `订阅源不存在: ${code}`);
  return feed;
}

async function handle(db: DatabaseSync, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const method = req.method ?? 'GET';

  if (method === 'GET' && path === '/health') {
    send(res, 200, { status: 'ok' });
    return;
  }

  if (method === 'GET' && path === '/feeds') {
    send(res, 200, { feeds: listFeeds(db) });
    return;
  }

  if (method === 'POST' && path === '/feeds') {
    const body = parseJsonBody(await readBody(req));
    const code = String(body.code ?? '').trim();
    const title = String(body.title ?? '').trim();
    if (!CODE_RE.test(code)) {
      throw error(400, 'INVALID_CODE', 'code 必须为 1-64 位字母/数字/_/-，且以字母或数字开头');
    }
    if (!title) throw error(400, 'MISSING_TITLE', 'title 不能为空');
    if (getFeedByCode(db, code)) {
      throw error(409, 'FEED_EXISTS', `订阅源 code 已存在: ${code}`);
    }
    const feed = createFeed(db, code, title, body.link ? String(body.link) : null);
    send(res, 201, { feed: { id: feed.id, code, title, link: body.link ?? null } });
    return;
  }

  let m = path.match(/^\/feeds\/([^/]+)\/import$/);
  if (method === 'POST' && m) {
    const feed = requireFeed(db, decodeURIComponent(m[1]));
    const contentType = (req.headers['content-type'] ?? '').toLowerCase();
    const raw = await readBody(req);
    let xml: string;
    let source: string | null = null;
    if (contentType.includes('application/json')) {
      const body = parseJsonBody(raw);
      if (typeof body.xml !== 'string' || !body.xml.trim()) {
        throw error(400, 'MISSING_XML', 'JSON 体必须包含非空字符串字段 xml');
      }
      xml = body.xml;
      source = body.source ? String(body.source) : null;
    } else if (contentType.includes('xml')) {
      xml = raw;
    } else {
      throw error(400, 'UNSUPPORTED_MEDIA_TYPE', 'Content-Type 必须为 application/xml、text/xml 或 application/json');
    }
    try {
      const report = importSnapshot(db, feed.id, feed.code, xml, source);
      send(res, 200, { report });
    } catch (e) {
      if (e instanceof XmlError) throw error(422, 'INVALID_XML', e.message);
      throw e;
    }
    return;
  }

  m = path.match(/^\/feeds\/([^/]+)\/articles$/);
  if (method === 'GET' && m) {
    const feed = requireFeed(db, decodeURIComponent(m[1]));
    const readParam = url.searchParams.get('read');
    const presentParam = url.searchParams.get('present');
    if (readParam !== null && readParam !== 'true' && readParam !== 'false') {
      throw error(400, 'INVALID_QUERY', "read 只能是 'true' 或 'false'");
    }
    if (presentParam !== null && presentParam !== 'true' && presentParam !== 'false') {
      throw error(400, 'INVALID_QUERY', "present 只能是 'true' 或 'false'");
    }
    send(res, 200, {
      articles: listArticles(db, {
        feedCode: feed.code,
        read: readParam === null ? undefined : readParam === 'true',
        present: presentParam === null ? undefined : presentParam === 'true'
      })
    });
    return;
  }

  if (method === 'GET' && path === '/articles') {
    const readParam = url.searchParams.get('read');
    if (readParam !== null && readParam !== 'true' && readParam !== 'false') {
      throw error(400, 'INVALID_QUERY', "read 只能是 'true' 或 'false'");
    }
    send(res, 200, {
      articles: listArticles(db, { read: readParam === null ? undefined : readParam === 'true' })
    });
    return;
  }

  m = path.match(/^\/articles\/(\d+)$/);
  if (method === 'GET' && m) {
    const article = getArticle(db, Number(m[1]));
    if (!article) throw error(404, 'ARTICLE_NOT_FOUND', '文章不存在');
    send(res, 200, { article });
    return;
  }

  m = path.match(/^\/articles\/(\d+)\/read$/);
  if (method === 'POST' && m) {
    const body = parseJsonBody(await readBody(req));
    const readValue = body.read;
    if (typeof readValue !== 'boolean') {
      throw error(400, 'INVALID_READ', 'JSON 体必须包含布尔字段 read');
    }
    const ok = setRead(db, Number(m[1]), readValue);
    if (!ok) throw error(404, 'ARTICLE_NOT_FOUND', '文章不存在');
    send(res, 200, { articleId: Number(m[1]), isRead: readValue });
    return;
  }

  if (method === 'GET' && path === '/snapshots') {
    const feed = url.searchParams.get('feed') ?? undefined;
    send(res, 200, { snapshots: listSnapshots(db, feed) });
    return;
  }

  m = path.match(/^\/snapshots\/(\d+)\/report$/);
  if (method === 'GET' && m) {
    const report = getSnapshotReport(db, Number(m[1]));
    if (!report) throw error(404, 'SNAPSHOT_NOT_FOUND', '快照不存在');
    send(res, 200, { report });
    return;
  }

  if (method === 'GET' && path === '/export') {
    const format = url.searchParams.get('format') === 'xml' ? 'xml' : 'json';
    const feed = url.searchParams.get('feed') ?? undefined;
    if (feed) requireFeed(db, feed);
    const data = exportData(db, format, feed);
    send(res, 200, data, format === 'xml' ? 'application/xml; charset=utf-8' : 'application/json; charset=utf-8');
    return;
  }

  throw error(404, 'NOT_FOUND', `路由不存在: ${method} ${path}`);
}

export function startServer(db: DatabaseSync, port: number): Promise<{ server: Server; port: number }> {
  const server = createServer((req, res) => {
    handle(db, req, res).catch((e: unknown) => {
      if (e && typeof e === 'object' && 'status' in e && 'code' in e) {
        sendError(res, e as ApiError);
      } else {
        sendError(res, error(500, 'INTERNAL', (e as Error).message));
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      const address = server.address();
      const actual = typeof address === 'object' && address ? address.port : port;
      resolve({ server, port: actual });
    });
  });
}
