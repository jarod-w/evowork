/**
 * identity HTTP。零框架，理由与网关相同：企业私有部署包要最少依赖。
 *
 * 密码只出现在这里的请求体与 WEB 表单里，不写日志。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import { bearer, meteringDayUtc, parseMeteringDay, verifyAccessToken } from '@evowork/account';
import { errorFields, type Logger } from '@evowork/logging';

import { IdentityError, type Identity } from './service.js';
import type { Es256KeyPair } from '@evowork/account';
import { toJwks } from '@evowork/account';

export interface IdentityServerOptions {
  readonly identity: Identity;
  readonly keys: Es256KeyPair;
  readonly logger?: Logger;
  readonly internalToken?: string | undefined;
  readonly webOrigin?: string | undefined;
}

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' } as const;

export function createIdentityServer(options: IdentityServerOptions): Server {
  const { identity, keys, logger } = options;

  return createServer((req, res) => {
    void handle(req, res).catch((err: unknown) => {
      logger?.error('identity.http.unhandled', errorFields(err));
      if (!res.headersSent) {
        res.writeHead(500, JSON_HEADERS);
        res.end(JSON.stringify({ error: { message: '内部错误', code: 'internal' } }));
      } else {
        res.end();
      }
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    cors(req, res);
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }
    const url = new URL(req.url ?? '/', 'http://localhost');

    if (req.method === 'GET' && (url.pathname === '/healthz' || url.pathname === '/readyz')) {
      json(res, 200, { ok: true });
      return;
    }
    if (
      req.method === 'GET' &&
      (url.pathname === '/v1/jwks' || url.pathname === '/.well-known/jwks.json')
    ) {
      json(res, 200, toJwks(keys));
      return;
    }

    try {
      await route(req, res, url);
    } catch (err) {
      if (err instanceof IdentityError) {
        json(res, statusOf(err.code), { error: { message: err.message, code: err.code } });
        return;
      }
      throw err;
    }
  }

  async function route(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const path = url.pathname;

    if (req.method === 'POST' && path === '/v1/signup') {
      const body = await readJson(req);
      const email = str(body.email);
      const password = str(body.password);
      if (!email || !password) {
        json(res, 400, { error: { message: '需要邮箱和密码', code: 'bad-request' } });
        return;
      }
      const out = identity.signup({ email, password });
      json(res, 201, { userId: out.userId });
      return;
    }

    if (req.method === 'POST' && path === '/v1/verify-email') {
      const token = str((await readJson(req)).token);
      if (!token) {
        json(res, 400, { error: { message: '需要 token', code: 'bad-request' } });
        return;
      }
      identity.verifyEmail(token);
      json(res, 200, { ok: true });
      return;
    }

    if (req.method === 'POST' && path === '/v1/login') {
      const body = await readJson(req);
      const identifier = str(body.identifier) ?? str(body.email);
      const password = str(body.password);
      const deviceId = str(body.deviceId) ?? 'web';
      if (!identifier || !password) {
        json(res, 400, { error: { message: '需要账号和密码', code: 'bad-request' } });
        return;
      }
      const deviceName = str(body.deviceName);
      const platform = str(body.platform);
      const out = identity.login({
        identifier,
        password,
        deviceId,
        ...(deviceName ? { deviceName } : {}),
        ...(platform ? { platform } : {}),
      });
      const session = identity.createSession(out.userId);
      res.setHeader('set-cookie', `session=${session}; Path=/; HttpOnly; SameSite=Lax`);
      json(res, 200, {
        accessToken: out.accessToken,
        refreshToken: out.refreshToken,
        mustChangePassword: out.mustChangePassword,
        role: out.role,
        tenantId: out.tenantId,
      });
      return;
    }

    if (req.method === 'POST' && path === '/v1/forgot-password') {
      const email = str((await readJson(req)).email);
      if (email) identity.requestPasswordReset(email);
      json(res, 200, { ok: true });
      return;
    }

    if (req.method === 'POST' && path === '/v1/reset-password') {
      const body = await readJson(req);
      const token = str(body.token);
      const password = str(body.password);
      if (!token || !password) {
        json(res, 400, { error: { message: '需要 token 和新密码', code: 'bad-request' } });
        return;
      }
      identity.resetPassword(token, password);
      json(res, 200, { ok: true });
      return;
    }

    if (req.method === 'POST' && path === '/v1/oauth/token') {
      const body = await readJson(req);
      const grant = str(body.grant_type);
      if (grant === 'authorization_code') {
        const code = str(body.code);
        const verifier = str(body.code_verifier);
        const redirectUri = str(body.redirect_uri);
        const deviceId = str(body.device_id);
        if (!code || !verifier || !redirectUri || !deviceId) {
          json(res, 400, { error: { message: '缺少 PKCE 字段', code: 'bad-request' } });
          return;
        }
        json(res, 200, identity.exchangeCode({ code, verifier, redirectUri, deviceId }));
        return;
      }
      if (grant === 'refresh_token') {
        const refresh = str(body.refresh_token);
        if (!refresh) {
          json(res, 400, { error: { message: '缺少 refresh_token', code: 'bad-request' } });
          return;
        }
        json(res, 200, identity.refresh(refresh));
        return;
      }
      json(res, 400, { error: { message: '不支持的 grant_type', code: 'bad-request' } });
      return;
    }

    if (req.method === 'GET' && path === '/v1/oauth/authorize') {
      const userId = actorFrom(req)?.sub;
      if (!userId) {
        json(res, 401, { error: { message: '请先登录', code: 'unauthorized' } });
        return;
      }
      const challenge = url.searchParams.get('code_challenge') ?? '';
      const redirectUri = url.searchParams.get('redirect_uri') ?? '';
      const deviceId = url.searchParams.get('device_id') ?? '';
      const state = url.searchParams.get('state') ?? '';
      const { code } = identity.startAuthorize({ userId, deviceId, challenge, redirectUri });
      const next = new URL(redirectUri);
      next.searchParams.set('code', code);
      if (state) next.searchParams.set('state', state);
      res.writeHead(302, { location: next.toString() });
      res.end();
      return;
    }

    if (req.method === 'POST' && path === '/v1/oauth/authorize') {
      const userId = actorFrom(req)?.sub;
      if (!userId) {
        json(res, 401, { error: { message: '请先登录', code: 'unauthorized' } });
        return;
      }
      const body = await readJson(req);
      const challenge = str(body.code_challenge);
      const redirectUri = str(body.redirect_uri);
      const deviceId = str(body.device_id);
      if (!challenge || !redirectUri || !deviceId) {
        json(res, 400, { error: { message: '缺少 PKCE 字段', code: 'bad-request' } });
        return;
      }
      json(res, 200, identity.startAuthorize({ userId, deviceId, challenge, redirectUri }));
      return;
    }

    if (req.method === 'GET' && path === '/v1/internal/upstream') {
      if (!options.internalToken || req.headers['x-evowork-internal'] !== options.internalToken) {
        json(res, 401, { error: { message: '鉴权失败', code: 'unauthorized' } });
        return;
      }
      const tenant = url.searchParams.get('tenant') ?? '';
      const model = url.searchParams.get('model') ?? '';
      const up = identity.internalUpstream(tenant, model);
      if (!up) {
        json(res, 404, { error: { message: '没有这个模型', code: 'not-found' } });
        return;
      }
      json(res, 200, up);
      return;
    }

    const actor = actorFrom(req);
    if (!actor) {
      json(res, 401, { error: { message: '鉴权失败', code: 'unauthorized' } });
      return;
    }

    if (req.method === 'GET' && path === '/v1/me') {
      json(res, 200, identity.me(actor.sub));
      return;
    }

    if (req.method === 'POST' && path === '/v1/password') {
      const body = await readJson(req);
      const current = str(body.current);
      const next = str(body.next);
      if (!current || !next) {
        json(res, 400, { error: { message: '需要当前密码和新密码', code: 'bad-request' } });
        return;
      }
      identity.changePassword(actor.sub, current, next);
      json(res, 200, { ok: true });
      return;
    }

    if (req.method === 'GET' && path === '/v1/devices') {
      json(res, 200, { devices: identity.listDevices(actor.sub) });
      return;
    }

    if (req.method === 'POST' && path === '/v1/devices/revoke') {
      const deviceId = str((await readJson(req)).deviceId);
      if (!deviceId) {
        json(res, 400, { error: { message: '需要 deviceId', code: 'bad-request' } });
        return;
      }
      identity.revokeDevice(actor.sub, deviceId);
      json(res, 200, { ok: true });
      return;
    }

    if (req.method === 'POST' && path === '/v1/account/delete') {
      const password = str((await readJson(req)).password);
      if (!password) {
        json(res, 400, { error: { message: '注销需要再输入一次密码', code: 'bad-request' } });
        return;
      }
      identity.deleteAccount(actor.sub, password);
      json(res, 200, { ok: true });
      return;
    }

    if (req.method === 'GET' && path === '/v1/catalog') {
      if (actor.tenant === 'none') {
        json(res, 200, { data: [] });
        return;
      }
      json(res, 200, { data: identity.publicCatalog(actor.tenant) });
      return;
    }

    if (req.method === 'POST' && path === '/v1/metering') {
      const parsed = parseMeteringDay(await readJson(req));
      if (!parsed) {
        json(res, 400, { error: { message: '计量载荷不合法', code: 'bad-request' } });
        return;
      }
      identity.recordMetering(parsed);
      json(res, 200, { ok: true });
      return;
    }

    if (req.method === 'GET' && path === '/v1/quota') {
      json(res, 200, identity.quota(actor.sub) ?? { used: 0, limit: 0, quotaClass: 'default' });
      return;
    }

    if (req.method === 'GET' && path === '/v1/policy-pack') {
      if (actor.tenant === 'none') {
        json(res, 200, { pack: null });
        return;
      }
      json(res, 200, { pack: identity.currentPolicyPack(actor.tenant) ?? null });
      return;
    }

    if (req.method === 'POST' && path === '/v1/responses') {
      await proxyResponses(req, res, actor);
      return;
    }

    if (path.startsWith('/v1/admin/')) {
      const me = identity.me(actor.sub);
      if (me.role !== 'admin') {
        json(res, 403, { error: { message: '需要管理员', code: 'forbidden' } });
        return;
      }
      if (me.mustChangePassword) {
        json(res, 403, {
          error: { message: '请先修改引导密码。', code: 'must-change-password' },
        });
        return;
      }
      await adminRoute(req, res, path, actor.sub);
      return;
    }

    json(res, 404, { error: { message: `未知端点：${path}`, code: 'not-found' } });
  }

  async function proxyResponses(
    req: IncomingMessage,
    res: ServerResponse,
    actor: { sub: string; tenant: string },
  ): Promise<void> {
    const quota = identity.checkQuota(actor.sub);
    if (!quota.ok) {
      json(res, 402, { error: { message: quota.reason, code: 'quota_exhausted' } });
      return;
    }
    const raw = await readJson(req);
    const model = str(raw.model);
    if (!model) {
      json(res, 400, { error: { message: '需要 model', code: 'bad-request' } });
      return;
    }
    if (actor.tenant === 'none') {
      json(res, 404, { error: { message: '没有这个模型', code: 'not-found' } });
      return;
    }
    const up = identity.internalUpstream(actor.tenant, model);
    const provider = identity.hostedProvider(actor.tenant, model) ?? 'private';
    if (!up) {
      json(res, 404, { error: { message: '没有这个模型', code: 'not-found' } });
      return;
    }
    const target = up.baseUrl.endsWith('/v1')
      ? `${up.baseUrl}/responses`
      : `${up.baseUrl.replace(/\/$/, '')}/v1/responses`;
    const started = Date.now();
    const upstream = await fetch(target, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${up.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(raw),
    });
    const buf = Buffer.from(await upstream.arrayBuffer());
    let tokensIn = 0;
    let tokensOut = 0;
    try {
      const decoded: unknown = JSON.parse(buf.toString('utf8'));
      if (decoded && typeof decoded === 'object' && 'usage' in decoded) {
        const usage = (decoded as { usage?: { input_tokens?: number; output_tokens?: number } })
          .usage;
        tokensIn = usage?.input_tokens ?? 0;
        tokensOut = usage?.output_tokens ?? 0;
      }
    } catch {
      /* 流式或非 JSON：只记请求次数，token 记 0 */
    }
    identity.recordMetering({
      day: meteringDayUtc(Date.now()),
      tenant: actor.tenant,
      model,
      provider,
      tokensIn,
      tokensOut,
      tokensCached: 0,
      durationMs: Date.now() - started,
    });
    identity.addQuotaUsage(actor.sub, tokensIn + tokensOut);
    res.writeHead(upstream.status, {
      'content-type': upstream.headers.get('content-type') ?? 'application/json',
    });
    res.end(buf);
  }

  async function adminRoute(
    req: IncomingMessage,
    res: ServerResponse,
    path: string,
    actorId: string,
  ): Promise<void> {
    if (req.method === 'GET' && path === '/v1/admin/members') {
      json(res, 200, { members: identity.listMembers(actorId) });
      return;
    }
    if (req.method === 'POST' && path === '/v1/admin/members') {
      const targetUserId = str((await readJson(req)).userId);
      if (!targetUserId) {
        json(res, 400, { error: { message: '需要 userId', code: 'bad-request' } });
        return;
      }
      identity.addMember(actorId, targetUserId);
      json(res, 200, { ok: true });
      return;
    }
    if (req.method === 'POST' && path === '/v1/admin/grant') {
      const targetUserId = str((await readJson(req)).userId);
      if (!targetUserId) {
        json(res, 400, { error: { message: '需要 userId', code: 'bad-request' } });
        return;
      }
      identity.grantAdmin(actorId, targetUserId);
      json(res, 200, { ok: true });
      return;
    }
    if (req.method === 'POST' && path === '/v1/admin/revoke') {
      const targetUserId = str((await readJson(req)).userId);
      if (!targetUserId) {
        json(res, 400, { error: { message: '需要 userId', code: 'bad-request' } });
        return;
      }
      identity.revokeAdmin(actorId, targetUserId);
      json(res, 200, { ok: true });
      return;
    }
    if (req.method === 'GET' && path === '/v1/admin/models') {
      const me = identity.me(actorId);
      json(res, 200, { models: me.tenantId ? identity.publicCatalog(me.tenantId) : [] });
      return;
    }
    if (req.method === 'POST' && path === '/v1/admin/models') {
      const body = await readJson(req);
      const modelId = str(body.modelId);
      const displayName = str(body.displayName);
      const provider = str(body.provider);
      const upstreamModel = str(body.upstreamModel);
      const adapter = str(body.adapter) ?? provider;
      const baseUrl = str(body.baseUrl);
      const apiKey = str(body.apiKey);
      if (
        !modelId ||
        !displayName ||
        !provider ||
        !upstreamModel ||
        !adapter ||
        !baseUrl ||
        !apiKey
      ) {
        json(res, 400, { error: { message: '默认模型字段不完整', code: 'bad-request' } });
        return;
      }
      json(
        res,
        200,
        identity.upsertHostedModel(actorId, {
          modelId,
          displayName,
          provider,
          upstreamModel,
          adapter,
          baseUrl,
          apiKey,
        }),
      );
      return;
    }
    if (req.method === 'POST' && path === '/v1/admin/models/delete') {
      const modelId = str((await readJson(req)).modelId);
      if (!modelId) {
        json(res, 400, { error: { message: '需要 modelId', code: 'bad-request' } });
        return;
      }
      identity.deleteHostedModel(actorId, modelId);
      json(res, 200, { ok: true });
      return;
    }
    if (req.method === 'POST' && path === '/v1/admin/quota') {
      const body = await readJson(req);
      const userId = str(body.userId);
      const limit = body.limit;
      if (!userId || typeof limit !== 'number') {
        json(res, 400, { error: { message: '需要 userId 与 limit', code: 'bad-request' } });
        return;
      }
      identity.setQuota(actorId, userId, limit);
      json(res, 200, { ok: true });
      return;
    }
    if (req.method === 'GET' && path === '/v1/admin/quota-classes') {
      json(res, 200, { classes: identity.listQuotaClasses(actorId) });
      return;
    }
    if (req.method === 'POST' && path === '/v1/admin/quota-classes') {
      const body = await readJson(req);
      const name = str(body.name);
      const tokensLimit = body.tokensLimit;
      if (!name || typeof tokensLimit !== 'number') {
        json(res, 400, { error: { message: '需要 name 与 tokensLimit', code: 'bad-request' } });
        return;
      }
      identity.upsertQuotaClass(actorId, name, tokensLimit);
      json(res, 200, { ok: true });
      return;
    }
    if (req.method === 'POST' && path === '/v1/admin/quota-class') {
      const body = await readJson(req);
      const userId = str(body.userId);
      const quotaClass = str(body.quotaClass);
      if (!userId || !quotaClass) {
        json(res, 400, { error: { message: '需要 userId 与 quotaClass', code: 'bad-request' } });
        return;
      }
      identity.assignQuotaClass(actorId, userId, quotaClass);
      json(res, 200, { ok: true });
      return;
    }
    if (req.method === 'GET' && path === '/v1/admin/policy-pack') {
      const me = identity.me(actorId);
      json(res, 200, {
        pack: me.tenantId ? (identity.currentPolicyPack(me.tenantId) ?? null) : null,
      });
      return;
    }
    if (req.method === 'POST' && path === '/v1/admin/policy-pack') {
      const body = await readJson(req);
      const expiresInDays = body.expiresInDays;
      if (typeof expiresInDays !== 'number') {
        json(res, 400, { error: { message: '需要 expiresInDays', code: 'bad-request' } });
        return;
      }
      const graceInDays = body.graceInDays;
      const disabledModels = strList(body.disabledModels);
      const disabledProfiles = strList(body.disabledProfiles);
      const reason = str(body.reason);
      json(
        res,
        200,
        identity.issuePolicyPack(actorId, {
          expiresInDays,
          ...(typeof graceInDays === 'number' ? { graceInDays } : {}),
          ...(disabledModels ? { disabledModels } : {}),
          ...(typeof body.allowCustom === 'boolean' ? { allowCustom: body.allowCustom } : {}),
          ...(reason ? { reason } : {}),
          ...(typeof body.allowManagedHooksOnly === 'boolean'
            ? { allowManagedHooksOnly: body.allowManagedHooksOnly }
            : {}),
          ...(typeof body.disableShare === 'boolean' ? { disableShare: body.disableShare } : {}),
          ...(typeof body.disableSlots === 'boolean' ? { disableSlots: body.disableSlots } : {}),
          ...(typeof body.forceAudit === 'boolean' ? { forceAudit: body.forceAudit } : {}),
          ...(disabledProfiles ? { disabledProfiles } : {}),
        }),
      );
      return;
    }
    json(res, 404, { error: { message: `未知端点：${path}`, code: 'not-found' } });
  }

  function actorFrom(
    req: IncomingMessage,
  ): { sub: string; tenant: string; role: string } | undefined {
    const token = bearer(req.headers.authorization);
    if (token) {
      const result = verifyAccessToken(token, { publicPem: keys.publicPem });
      if (result.ok)
        return { sub: result.claims.sub, tenant: result.claims.tenant, role: result.claims.role };
    }
    const cookie = req.headers.cookie ?? '';
    const match = /(?:^|; )session=([^;]+)/.exec(cookie);
    const sessionId = match?.[1];
    if (!sessionId) return undefined;
    const userId = identity.userIdFromSession(sessionId);
    if (!userId) return undefined;
    const me = identity.me(userId);
    return { sub: userId, tenant: me.tenantId ?? 'none', role: me.role };
  }

  function cors(req: IncomingMessage, res: ServerResponse): void {
    const origin = options.webOrigin;
    if (!origin) return;
    if (req.headers.origin === origin) {
      res.setHeader('access-control-allow-origin', origin);
      res.setHeader('access-control-allow-credentials', 'true');
      res.setHeader('access-control-allow-headers', 'authorization, content-type');
      res.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS');
    }
  }
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, JSON_HEADERS);
  res.end(JSON.stringify(body));
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

function strList(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: string[] = [];
  for (const item of value) {
    if (typeof item === 'string' && item.trim() !== '') out.push(item.trim());
  }
  return out;
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return {};
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  return parsed as Record<string, unknown>;
}

function statusOf(code: IdentityError['code']): number {
  switch (code) {
    case 'invalid-credentials':
    case 'unverified':
    case 'bad-challenge':
      return 401;
    case 'locked':
    case 'must-change-password':
    case 'forbidden':
    case 'last-admin':
    case 'other-tenant':
      return 403;
    case 'not-found':
    case 'not-registered':
      return 404;
    case 'conflict':
      return 409;
    case 'expired':
      return 401;
    case 'invalid-redirect':
    case 'no-sms':
    case 'invalid':
      return 400;
    default:
      return 400;
  }
}
