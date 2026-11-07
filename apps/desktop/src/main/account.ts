/**
 * 桌面账号会话（M10b / 11 §5 · Q33=A）。
 *
 * 密码不出现在这个文件里：登录走系统浏览器 + PKCE + loopback。
 * refresh 进密钥库（`EVOWORK_ACCOUNT_REFRESH`）；access JWT 只留在内存。
 *
 * **未登录时这个模块不向我们的云发任何请求**（11 §12 第 14 条），
 * 连默认模型清单都不拉。
 */
import { createServer, type Server } from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  ACCESS_JWT_ENV,
  encodeTenantModels,
  TENANT_MODELS_ENV,
  UPSTREAM_BASE_URL_ENV,
  type ModelRegistryEntry,
} from '@evowork/gateway';
import { codeChallengeS256, generateCodeVerifier, parseAccessClaims } from '@evowork/account';
import type { Logger } from '@evowork/logging';

import type { DeviceView } from '../shared/ipc.js';

export const ACCOUNT_SECRET_PREFIX = 'EVOWORK_ACCOUNT_';
export const REFRESH_SECRET = `${ACCOUNT_SECRET_PREFIX}REFRESH`;
export const DEVICE_ID_KEY = 'evowork.device.id';

const PROVIDERS = ['deepseek', 'moonshot', 'zhipu', 'private'] as const;

export interface AccountVault {
  get(name: string): string | undefined;
  set(name: string, value: string): boolean;
  remove(name: string): boolean;
}

export interface AccountOrigins {
  /** 账号页。密码表单只在这里 */
  readonly webOrigin?: string | undefined;
  /** identity HTTP。token / catalog / devices */
  readonly identityOrigin?: string | undefined;
}

export interface AccountDeps extends AccountOrigins {
  readonly onSessionChanged?: (() => Promise<void> | void) | undefined;
  readonly now?: (() => number) | undefined;
  readonly vault: AccountVault;
  readonly readFlag: (key: string) => string | undefined;
  readonly writeFlag: (key: string, value: string) => void;
  readonly openExternal: (url: string) => Promise<void>;
  readonly logger?: Logger | undefined;
  readonly fetchFn?: typeof fetch | undefined;
  readonly listen?: ((server: Server) => Promise<number>) | undefined;
}

export interface AccountDecoration {
  readonly signedIn: boolean;
  readonly role?: 'member' | 'admin' | undefined;
  readonly devices?: readonly DeviceView[] | undefined;
  readonly quotaUsed?: number | undefined;
  readonly quotaLimit?: number | undefined;
}

export interface AccountSession {
  readonly origins: AccountOrigins;
  signedIn(): boolean;
  /** 内存里的 access JWT。未登录是 undefined —— 调用方不得据此出网 */
  accessToken(): string | undefined;
  decorate(): AccountDecoration;
  /** 注入本机网关子进程。未登录时是空对象 —— 调用方不得据此出网 */
  gatewayInject(): NodeJS.ProcessEnv;
  startLogin(page?: 'signin' | 'signup'): Promise<{ ok: boolean; refused?: string }>;
  logout(): Promise<void>;
  listDevices(): Promise<readonly DeviceView[]>;
  revokeDevice(deviceId: string): Promise<{ ok: boolean; refused?: string }>;
  openWeb(path: string): Promise<{ ok: boolean; refused?: string }>;
  restore(): Promise<void>;
  refresh(): Promise<boolean>;
  dispose(): void;
}

export function originsFromEnv(env: NodeJS.ProcessEnv, configDir?: string): AccountOrigins {
  let bundled: AccountOrigins = {};
  if (configDir) {
    try {
      const value = JSON.parse(
        readFileSync(join(configDir, 'account.json'), 'utf8'),
      ) as AccountOrigins;
      if (value && typeof value === 'object')
        bundled = {
          ...(typeof value.webOrigin === 'string' ? { webOrigin: value.webOrigin } : {}),
          ...(typeof value.identityOrigin === 'string'
            ? { identityOrigin: value.identityOrigin }
            : {}),
        };
    } catch {
      // 没有随包配置的开发环境仍可显式用环境变量配置。
    }
  }
  const identity =
    env.EVOWORK_IDENTITY_ORIGIN?.trim() ||
    env.EVOWORK_HOSTED_ORIGIN?.trim() ||
    bundled.identityOrigin?.trim() ||
    undefined;
  const web = env.EVOWORK_WEB_ORIGIN?.trim() || bundled.webOrigin?.trim() || undefined;
  return {
    ...(web ? { webOrigin: web.replace(/\/$/, '') } : {}),
    ...(identity ? { identityOrigin: identity.replace(/\/$/, '') } : {}),
  };
}

export function createAccountSession(deps: AccountDeps): AccountSession {
  const fetchFn = deps.fetchFn ?? fetch;
  const now = deps.now ?? Date.now;
  let expiresAt = 0;
  let generation = 0;
  let disposed = false;
  let renewal: Promise<boolean> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pendingLogin: { cancel(): void } | undefined;
  let accessJwt: string | undefined;
  let role: 'member' | 'admin' | undefined;
  let tenantModelsJson: string | undefined;
  let devices: DeviceView[] = [];
  let quotaUsed: number | undefined;
  let quotaLimit: number | undefined;

  function deviceId(): string {
    const existing = deps.readFlag(DEVICE_ID_KEY);
    if (existing && existing.length > 0) return existing;
    const minted = `dev_${randomBytes(9).toString('base64url')}`;
    deps.writeFlag(DEVICE_ID_KEY, minted);
    return minted;
  }

  function decodeRole(jwt: string): 'member' | 'admin' | undefined {
    const payload = jwt.split('.')[1];
    if (!payload) return undefined;
    try {
      const json = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as unknown;
      return parseAccessClaims(json)?.role;
    } catch {
      return undefined;
    }
  }

  function clearTimer(): void {
    if (timer) clearTimeout(timer);
    timer = undefined;
  }

  function clearMemory(): void {
    clearTimer();
    accessJwt = undefined;
    expiresAt = 0;
    role = undefined;
    tenantModelsJson = undefined;
    devices = [];
    quotaUsed = undefined;
    quotaLimit = undefined;
  }

  async function changed(): Promise<void> {
    try {
      await deps.onSessionChanged?.();
    } catch {
      deps.logger?.warn('desktop.account.sync_failed', { reason: 'SESSION_CHANGED' });
    }
  }

  function schedule(delay = Math.max(1_000, expiresAt - now() - 60_000)): void {
    clearTimer();
    if (disposed) return;
    timer = setTimeout(() => {
      void refresh();
    }, delay);
    timer.unref?.();
  }

  async function identityFetch(path: string, init: RequestInit = {}): Promise<Response> {
    const origin = deps.identityOrigin;
    if (!origin) throw new Error('no-identity');
    return fetchFn(`${origin}${path}`, {
      ...init,
      signal: init.signal ?? AbortSignal.timeout(15_000),
    });
  }

  async function applyTokens(
    access: string,
    refreshToken: string,
    expected: number,
  ): Promise<boolean> {
    if (disposed || expected !== generation) return false;
    if (!deps.vault.set(REFRESH_SECRET, refreshToken)) {
      clearMemory();
      deps.vault.remove(REFRESH_SECRET);
      await changed();
      return false;
    }
    accessJwt = access;
    role = decodeRole(access);
    try {
      const claims = JSON.parse(
        Buffer.from(access.split('.')[1] ?? '', 'base64url').toString('utf8'),
      ) as { exp?: number };
      expiresAt = typeof claims.exp === 'number' ? claims.exp * 1000 : now() + 15 * 60_000;
    } catch {
      expiresAt = now() + 15 * 60_000;
    }
    schedule();
    // 先更新网关令牌，目录/配额暂时断网不能把已成功换票变成登录失败。
    await changed();
    try {
      await refreshCatalog();
    } catch {
      /* 下次账号请求可重试。 */
    }
    return expected === generation && !disposed;
  }

  async function refresh(): Promise<boolean> {
    if (renewal) return renewal;
    const refreshToken = deps.vault.get(REFRESH_SECRET);
    if (disposed || !refreshToken || !deps.identityOrigin) return false;
    const expected = generation;
    renewal = (async () => {
      try {
        const res = await identityFetch('/v1/oauth/token', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: refreshToken }),
        });
        if (expected !== generation || disposed) return false;
        if (!res.ok) {
          if (res.status === 400 || res.status === 401 || res.status === 403) {
            generation += 1;
            clearMemory();
            deps.vault.remove(REFRESH_SECRET);
            await changed();
          } else {
            schedule(30_000);
          }
          return false;
        }
        const tokens = (await res.json()) as { accessToken?: string; refreshToken?: string };
        if (!tokens.accessToken || !tokens.refreshToken) {
          schedule(30_000);
          return false;
        }
        return await applyTokens(tokens.accessToken, tokens.refreshToken, expected);
      } catch {
        if (expected === generation && !disposed) schedule(30_000);
        return false;
      } finally {
        renewal = undefined;
      }
    })();
    return renewal;
  }

  async function authorizedFetch(path: string, init: RequestInit = {}): Promise<Response> {
    if (accessJwt && expiresAt - now() < 60_000) await refresh();
    const send = () =>
      identityFetch(path, {
        ...init,
        headers: { ...init.headers, authorization: `Bearer ${accessJwt ?? ''}` },
      });
    const result = await send();
    if (result.status === 401 && (await refresh())) return send();
    return result;
  }

  async function refreshCatalog(): Promise<void> {
    if (!accessJwt || !deps.identityOrigin) {
      tenantModelsJson = undefined;
      return;
    }
    const expected = generation;
    const res = await identityFetch('/v1/catalog', {
      headers: { authorization: `Bearer ${accessJwt}` },
    });
    if (expected !== generation || disposed) return;
    if (!res.ok) {
      tenantModelsJson = undefined;
      return;
    }
    const body = (await res.json()) as { data?: readonly Record<string, unknown>[] };
    const specs: ModelRegistryEntry[] = [];
    for (const item of body.data ?? []) {
      const provider = PROVIDERS.find((p) => p === item.provider);
      const id = typeof item.id === 'string' ? item.id : '';
      const upstreamModel = typeof item.upstreamModel === 'string' ? item.upstreamModel : '';
      if (!provider || !id || !upstreamModel) continue;
      specs.push({
        id,
        provider,
        upstreamModel,
        displayName: typeof item.displayName === 'string' ? item.displayName : id,
        tier: 'standard',
        verified: false,
        unverified: [],
        notes: '',
        capabilities: {
          streaming: true,
          toolCalls: true,
          parallelToolCalls: false,
          reasoning: false,
          promptCache: false,
          imageInput: false,
          maxContextTokens: 8_000,
        },
      });
    }
    if (expected !== generation || disposed) return;
    tenantModelsJson = specs.length > 0 ? encodeTenantModels(specs) : undefined;
    const quotaRes = await identityFetch('/v1/quota', {
      headers: { authorization: `Bearer ${accessJwt}` },
    });
    if (quotaRes.ok && expected === generation && !disposed) {
      const q = (await quotaRes.json()) as { used?: number; limit?: number };
      if (expected !== generation || disposed) return;
      quotaUsed = typeof q.used === 'number' ? q.used : undefined;
      quotaLimit = typeof q.limit === 'number' ? q.limit : undefined;
    }
  }

  async function listenLoopback(): Promise<{
    server: Server;
    port: number;
    code: Promise<URL>;
    cancel(): void;
  }> {
    const server = createServer();
    let settle: ((url: URL) => void) | undefined;
    let fail: ((error: Error) => void) | undefined;
    const code = new Promise<URL>((resolve, reject) => {
      settle = resolve;
      fail = reject;
    });
    // 浏览器打开失败/用户取消时，拒绝也不会成为未处理异常。
    void code.catch(() => undefined);
    const timeout = setTimeout(() => fail?.(new Error('timeout')), 15 * 60_000);
    timeout.unref?.();
    server.on('request', (req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (url.pathname !== '/callback') {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><p>可以回到 EvoWork 了。</p>');
      clearTimeout(timeout);
      settle?.(url);
    });
    try {
      const port = await (deps.listen
        ? deps.listen(server)
        : new Promise<number>((resolve, reject) => {
            server.once('error', reject);
            server.listen(0, '127.0.0.1', () => {
              const addr = server.address();
              if (addr && typeof addr === 'object') resolve(addr.port);
              else reject(new Error('listen'));
            });
          }));
      return {
        server,
        port,
        code,
        cancel() {
          clearTimeout(timeout);
          fail?.(new Error('cancelled'));
        },
      };
    } catch (error) {
      clearTimeout(timeout);
      server.close();
      throw error;
    }
  }

  return {
    get origins(): AccountOrigins {
      return {
        ...(deps.webOrigin ? { webOrigin: deps.webOrigin } : {}),
        ...(deps.identityOrigin ? { identityOrigin: deps.identityOrigin } : {}),
      };
    },

    signedIn: () => accessJwt !== undefined && expiresAt > now(),

    accessToken: () => (expiresAt > now() ? accessJwt : undefined),

    decorate() {
      return {
        signedIn: accessJwt !== undefined && expiresAt > now(),
        ...(role ? { role } : {}),
        ...(devices.length > 0 ? { devices } : {}),
        ...(quotaUsed !== undefined ? { quotaUsed } : {}),
        ...(quotaLimit !== undefined ? { quotaLimit } : {}),
      };
    },

    gatewayInject() {
      if (!accessJwt || expiresAt <= now() || !deps.identityOrigin) return {};
      return {
        [ACCESS_JWT_ENV]: accessJwt,
        [UPSTREAM_BASE_URL_ENV]: deps.identityOrigin,
        ...(tenantModelsJson ? { [TENANT_MODELS_ENV]: tenantModelsJson } : {}),
      };
    },

    async startLogin(page = 'signin') {
      if (disposed || pendingLogin)
        return { ok: false, refused: '登录已在进行，请完成浏览器中的登录。' };
      generation += 1;
      const expected = generation;
      const web = deps.webOrigin;
      const identity = deps.identityOrigin;
      if (!web || !identity) {
        return { ok: false, refused: '这个版本没有配置账号服务地址，现在不能登录。' };
      }
      const verifier = generateCodeVerifier();
      const challenge = codeChallengeS256(verifier);
      const state = randomBytes(16).toString('base64url');
      let loop: Awaited<ReturnType<typeof listenLoopback>>;
      try {
        loop = await listenLoopback();
      } catch {
        return { ok: false, refused: '无法打开本机登录回调，请稍后再试。' };
      }
      const { server, port, code: returned } = loop;
      pendingLogin = loop;
      const redirectUri = `http://127.0.0.1:${port}/callback`;
      const start = new URL(`${web}/${page}`);
      start.searchParams.set('code_challenge', challenge);
      start.searchParams.set('code_challenge_method', 'S256');
      start.searchParams.set('redirect_uri', redirectUri);
      start.searchParams.set('state', state);
      start.searchParams.set('device_id', deviceId());
      try {
        await deps.openExternal(start.toString());
        const cb = await returned;
        if (cb.searchParams.get('state') !== state) {
          return { ok: false, refused: '登录回调校验失败，请再试一次。' };
        }
        const authCode = cb.searchParams.get('code');
        if (!authCode) {
          return { ok: false, refused: '没有拿到授权码。' };
        }
        const tokenRes = await identityFetch('/v1/oauth/token', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            grant_type: 'authorization_code',
            code: authCode,
            code_verifier: verifier,
            redirect_uri: redirectUri,
            device_id: deviceId(),
          }),
        });
        if (!tokenRes.ok) {
          return { ok: false, refused: '换票失败，请重新登录。' };
        }
        const tokens = (await tokenRes.json()) as { accessToken?: string; refreshToken?: string };
        if (!tokens.accessToken || !tokens.refreshToken) {
          return { ok: false, refused: '换票失败，请重新登录。' };
        }
        if (!(await applyTokens(tokens.accessToken, tokens.refreshToken, expected))) {
          return { ok: false, refused: '登录已取消或无法保存登录凭据，请检查系统密钥库。' };
        }
        deps.logger?.info('desktop.account.signed_in', { authMode: 'hosted' });
        return { ok: true };
      } catch {
        return { ok: false, refused: '登录没有完成。可以稍后再试，本机任务不受影响。' };
      } finally {
        loop.cancel();
        if (pendingLogin === loop) pendingLogin = undefined;
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },

    async logout() {
      generation += 1;
      pendingLogin?.cancel();
      clearMemory();
      deps.vault.remove(REFRESH_SECRET);
      await changed();
      deps.logger?.info('desktop.account.signed_out', { authMode: 'local' });
    },

    async listDevices() {
      if (!accessJwt) return [];
      const res = await authorizedFetch('/v1/devices');
      if (!res.ok) return [];
      const body = (await res.json()) as { devices?: DeviceView[] };
      devices = body.devices ?? [];
      return devices;
    },

    async revokeDevice(id) {
      if (!accessJwt) return { ok: false, refused: '还没有登录。' };
      const res = await authorizedFetch('/v1/devices/revoke', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${accessJwt}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ deviceId: id }),
      });
      if (!res.ok) return { ok: false, refused: '没能吊销这台设备。' };
      devices = devices.map((d) => (d.id === id ? { ...d, revoked: true } : d));
      return { ok: true };
    },

    async openWeb(path) {
      const web = deps.webOrigin;
      if (!web) return { ok: false, refused: '这个版本没有配置账号页地址。' };
      const url = `${web}${path.startsWith('/') ? path : `/${path}`}`;
      await deps.openExternal(url);
      return { ok: true };
    },

    async restore() {
      await refresh();
    },
    refresh,
    dispose() {
      disposed = true;
      generation += 1;
      clearTimer();
      pendingLogin?.cancel();
    },
  };
}

export function vaultFromEnvMap(map: () => Record<string, string>): AccountVault {
  const extra: Record<string, string> = {};
  return {
    get(name) {
      return extra[name] ?? map()[name];
    },
    set(name, value) {
      extra[name] = value;
      return true;
    },
    remove(name) {
      delete extra[name];
      return true;
    },
  };
}
