/**
 * 分享托管 HTTP。零框架，理由与 identity / 网关相同：企业私有部署包要最少依赖。
 *
 * ## 两组路由，鉴权方式**刻意不同**
 *
 * | 组 | 谁在调 | 鉴权 |
 * | --- | --- | --- |
 * | `PUT /v1/shares` · `DELETE /v1/shares/:id` | 本机客户端（上传 / 撤销） | identity 签的 access JWT |
 * | `GET /v1/s/:id` · `POST /v1/s/:id/unlock` · `GET /v1/s/:id/blob` · `GET /s/:id` | **没有账号的接收方** | 无 |
 *
 * 读取那一组**不认 `authorization`、不种 cookie、不回 `Set-Cookie`**
 * （11 §13.10 C 第 1 条）：这一页要渲染的是不可信来源的元数据，
 * 它旁边不该放着一把令牌。
 *
 * ## 文件永远以 attachment 下发
 *
 * 除了 §7.4 的预览安全名单，任何字节都带 `Content-Disposition: attachment` 与
 * `X-Content-Type-Options: nosniff` —— 一份 docx 被当成 HTML 跑，和 Visualizer
 * 同时给 `allow-scripts` + `allow-same-origin` 是同一类破口（验收口径第 21 条）。
 */
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';

import { bearer, verifyAccessToken } from '@evowork/account';
import { errorFields, type Logger } from '@evowork/logging';

import { MAX_SHARE_BYTES, type ShareService } from './service.js';

export interface ShareServerOptions {
  readonly service: ShareService;
  /** identity 的 ES256 公钥 PEM，用来验上传者的 access JWT。 */
  readonly publicPem: string;
  readonly logger?: Logger | undefined;
  /** 分享页的静态产物目录。给了就由本服务同源提供，省掉一层 CORS。 */
  readonly webDir?: string | undefined;
}

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' } as const;

/**
 * 分享页的 CSP。
 *
 * `default-src 'none'` 起步，只开这一页真正要的三样。**没有 `unsafe-eval`、
 * 没有 `object-src`、没有外域** —— 这一页会把不可信来源的元数据画出来，
 * 一条宽松的 CSP 就让"画出来"变成"跑起来"。
 */
const PAGE_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' blob: data:",
  "connect-src 'self'",
  "font-src 'self'",
  // PDF 预览用沙箱 iframe，**不给 allow-same-origin**（08 §7.4）
  'frame-src blob:',
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

const STATIC_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
};

export function createShareServer(options: ShareServerOptions): Server {
  const { service, logger } = options;

  return createServer((req, res) => {
    void handle(req, res).catch((err: unknown) => {
      logger?.error('share.http.unhandled', errorFields(err));
      if (!res.headersSent) {
        res.writeHead(500, JSON_HEADERS);
        res.end(JSON.stringify({ error: { message: '内部错误', code: 'internal' } }));
      } else {
        res.end();
      }
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;

    // 读取面允许跨源：接收方的页面可能由别处托管（开发期就是这样）。
    // 这一组本来就无鉴权，开放读不会多泄露什么；**不开 credentials**。
    if (path.startsWith('/v1/s/')) {
      res.setHeader('access-control-allow-origin', '*');
      res.setHeader('access-control-allow-headers', 'content-type, x-evowork-grant');
      res.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS');
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method === 'GET' && (path === '/healthz' || path === '/readyz')) {
      json(res, 200, { ok: true });
      return;
    }

    if (req.method === 'PUT' && path === '/v1/shares') {
      await put(req, res);
      return;
    }

    const revokeMatch = /^\/v1\/shares\/([A-Za-z0-9_-]{1,64})$/.exec(path);
    if (req.method === 'DELETE' && revokeMatch) {
      const actor = actorOf(req);
      if (!actor) {
        json(res, 401, { error: { message: '鉴权失败', code: 'unauthorized' } });
        return;
      }
      const ok = await service.revoke(revokeMatch[1] ?? '', actor.sub);
      // 撤销一个不存在的 id 也回 204：不让人用它探测 id 是否存在
      res.writeHead(ok ? 204 : 204);
      res.end();
      return;
    }

    const metaMatch = /^\/v1\/s\/([A-Za-z0-9_-]{1,64})$/.exec(path);
    if (req.method === 'GET' && metaMatch) {
      json(res, 200, service.describe(metaMatch[1] ?? ''));
      return;
    }

    const unlockMatch = /^\/v1\/s\/([A-Za-z0-9_-]{1,64})\/unlock$/.exec(path);
    if (req.method === 'POST' && unlockMatch) {
      const body = await readJson(req);
      const hash = typeof body.passwordHash === 'string' ? body.passwordHash : '';
      const out = service.unlock(unlockMatch[1] ?? '', hash);
      // 失败不区分"密码错"与"链接已失效"：两者都只回 ok:false
      json(res, out.ok ? 200 : 403, out.ok ? { ok: true, grant: out.grant } : { ok: false });
      return;
    }

    const blobMatch = /^\/v1\/s\/([A-Za-z0-9_-]{1,64})\/blob$/.exec(path);
    if (req.method === 'GET' && blobMatch) {
      await blob(req, res, blobMatch[1] ?? '');
      return;
    }

    if (req.method === 'GET' && /^\/s\/[A-Za-z0-9_-]{1,64}$/.test(path)) {
      await page(res);
      return;
    }

    if (req.method === 'GET' && options.webDir) {
      if (await staticFile(res, path)) return;
    }

    json(res, 404, { error: { message: '没有这个地址', code: 'not-found' } });
  }

  async function put(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const actor = actorOf(req);
    if (!actor) {
      json(res, 401, { error: { message: '鉴权失败', code: 'unauthorized' } });
      return;
    }
    const id = header(req, 'x-evowork-share-id');
    const nameDigest = header(req, 'x-evowork-name-digest');
    const expiresAt = Number(header(req, 'x-evowork-expires-at') ?? '');
    if (!id || !/^[A-Za-z0-9_-]{1,64}$/.test(id) || !nameDigest || !Number.isFinite(expiresAt)) {
      json(res, 400, { error: { message: '分享头不完整', code: 'bad-request' } });
      return;
    }
    const bytes = await readBody(req, MAX_SHARE_BYTES);
    if (!bytes) {
      json(res, 413, { error: { message: '超过分享的 200MB 上限。', code: 'too-large' } });
      return;
    }
    const passwordHash = header(req, 'x-evowork-password');
    const out = await service.put({
      id,
      ownerSub: actor.sub,
      tenant: actor.tenant,
      nameDigest,
      contentType: header(req, 'content-type') ?? 'application/octet-stream',
      expiresAt,
      ...(passwordHash ? { passwordHash } : {}),
      bytes,
    });
    if (!out.ok) {
      json(res, out.status, { error: { message: out.message, code: 'rejected' } });
      return;
    }
    logger?.info('share.stored', { shareId: id, byteSize: bytes.byteLength });
    json(res, 200, { url: out.url });
  }

  async function blob(req: IncomingMessage, res: ServerResponse, id: string): Promise<void> {
    const grant = header(req, 'x-evowork-grant');
    const out = await service.download(id, grant);
    if (!out.ok) {
      json(res, out.state === 'locked' ? 403 : 404, { error: { code: out.state } });
      return;
    }
    /*
     * 预览安全名单之外的一切都是 attachment。
     *
     * 把 docx 按它的真实 MIME 内联下发，等于邀请浏览器去渲染一份不可信文件；
     * `nosniff` 再挡住"类型写错了但浏览器自作主张"这一路。
     */
    const inline = out.previewable;
    res.writeHead(200, {
      'content-type': inline ? out.contentType : 'application/octet-stream',
      'content-length': String(out.bytes.byteLength),
      'content-disposition': inline ? 'inline' : 'attachment',
      'x-content-type-options': 'nosniff',
      'cache-control': 'private, no-store',
      'access-control-allow-origin': '*',
      // 即使是预览类型，也不让它把自己当成一个可以跑脚本的文档
      'content-security-policy': "default-src 'none'; sandbox",
    });
    res.end(Buffer.from(out.bytes));
  }

  async function page(res: ServerResponse): Promise<void> {
    if (!options.webDir) {
      json(res, 404, { error: { message: '没有部署分享页', code: 'not-found' } });
      return;
    }
    const html = await readFile(join(resolve(options.webDir), 'share.html'), 'utf8').catch(
      () => undefined,
    );
    if (html === undefined) {
      json(res, 404, { error: { message: '没有部署分享页', code: 'not-found' } });
      return;
    }
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'content-security-policy': PAGE_CSP,
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'cache-control': 'no-store',
    });
    res.end(html);
  }

  async function staticFile(res: ServerResponse, path: string): Promise<boolean> {
    const root = resolve(options.webDir ?? '');
    const target = resolve(join(root, normalize(path)));
    if (!target.startsWith(root)) return false;
    const body = await readFile(target).catch(() => undefined);
    if (!body) return false;
    res.writeHead(200, {
      'content-type': STATIC_TYPES[extname(target)] ?? 'application/octet-stream',
      'x-content-type-options': 'nosniff',
      'content-security-policy': PAGE_CSP,
    });
    res.end(body);
    return true;
  }

  function actorOf(req: IncomingMessage): { sub: string; tenant: string } | undefined {
    const token = bearer(req.headers.authorization);
    if (!token) return undefined;
    const result = verifyAccessToken(token, { publicPem: options.publicPem });
    if (!result.ok) return undefined;
    return { sub: result.claims.sub, tenant: result.claims.tenant };
  }
}

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  const raw = Array.isArray(value) ? value[0] : value;
  return raw && raw.trim() !== '' ? raw.trim() : undefined;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  if (!res.headersSent) res.writeHead(status, JSON_HEADERS);
  res.end(JSON.stringify(body));
}

/** 超过上限直接停，不把 200MB+ 读完才发现。 */
async function readBody(req: IncomingMessage, limit: number): Promise<Uint8Array | undefined> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > limit) return undefined;
    chunks.push(buf);
  }
  return new Uint8Array(Buffer.concat(chunks));
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const bytes = await readBody(req, 64 * 1024);
  if (!bytes || bytes.byteLength === 0) return {};
  try {
    const parsed: unknown = JSON.parse(Buffer.from(bytes).toString('utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed as Record<string, unknown>;
  } catch {
    return {};
  }
}
