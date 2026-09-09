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
  startLogin(): Promise<{ ok: boolean; refused?: string }>;
  logout(): Promise<void>;
  listDevices(): Promise<readonly DeviceView[]>;
  revokeDevice(deviceId: string): Promise<{ ok: boolean; refused?: string }>;
  openWeb(path: string): Promise<{ ok: boolean; refused?: string }>;
  restore(): Promise<void>;
}

export function originsFromEnv(env: NodeJS.ProcessEnv): AccountOrigins {
  const identity =
    env.EVOWORK_IDENTITY_ORIGIN?.trim() || env.EVOWORK_HOSTED_ORIGIN?.trim() || undefined;
  const web = env.EVOWORK_WEB_ORIGIN?.trim() || undefined;
  return {
    ...(web ? { webOrigin: web.replace(/\/$/, '') } : {}),
    ...(identity ? { identityOrigin: identity.replace(/\/$/, '') } : {}),
  };
}

export function createAccountSession(deps: AccountDeps): AccountSession {
  const fetchFn = deps.fetchFn ?? fetch;
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

  async function identityFetch(path: string, init: RequestInit = {}): Promise<Response> {
    const origin = deps.identityOrigin;
    if (!origin) throw new Error('no-identity');
    return fetchFn(`${origin}${path}`, init);
  }

  async function applyTokens(access: string, refresh: string): Promise<void> {
    accessJwt = access;
    role = decodeRole(access);
    deps.vault.set(REFRESH_SECRET, refresh);
    await refreshCatalog();
  }

  async function refreshCatalog(): Promise<void> {
    if (!accessJwt || !deps.identityOrigin) {
      tenantModelsJson = undefined;
      return;
    }
    const res = await identityFetch('/v1/catalog', {
      headers: { authorization: `Bearer ${accessJwt}` },
    });
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
    tenantModelsJson = specs.length > 0 ? encodeTenantModels(specs) : undefined;
    const quotaRes = await identityFetch('/v1/quota', {
      headers: { authorization: `Bearer ${accessJwt}` },
    });
    if (quotaRes.ok) {
      const q = (await quotaRes.json()) as { used?: number; limit?: number };
      quotaUsed = typeof q.used === 'number' ? q.used : undefined;
      quotaLimit = typeof q.limit === 'number' ? q.limit : undefined;
    }
  }

  async function listenLoopback(): Promise<{ server: Server; port: number; code: Promise<URL> }> {
    const server = createServer();
    const port = await (deps.listen
      ? deps.listen(server)
      : new Promise<number>((resolve, reject) => {
          server.listen(0, '127.0.0.1', () => {
            const addr = server.address();
            if (addr && typeof addr === 'object') resolve(addr.port);
            else reject(new Error('listen'));
          });
        }));
    const code = new Promise<URL>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout')), 5 * 60 * 1000);
      server.on('request', (req, res) => {
        const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end('<!doctype html><p>可以回到 EvoWork 了。</p>');
        if (url.pathname === '/callback') {
          clearTimeout(timer);
          resolve(url);
        }
      });
    });
    return { server, port, code };
  }

  return {
    get origins(): AccountOrigins {
      return {
        ...(deps.webOrigin ? { webOrigin: deps.webOrigin } : {}),
        ...(deps.identityOrigin ? { identityOrigin: deps.identityOrigin } : {}),
      };
    },

    signedIn: () => accessJwt !== undefined,

    accessToken: () => accessJwt,

    decorate() {
      return {
        signedIn: accessJwt !== undefined,
        ...(role ? { role } : {}),
        ...(devices.length > 0 ? { devices } : {}),
        ...(quotaUsed !== undefined ? { quotaUsed } : {}),
        ...(quotaLimit !== undefined ? { quotaLimit } : {}),
      };
    },

    gatewayInject() {
      if (!accessJwt || !deps.identityOrigin) return {};
      return {
        [ACCESS_JWT_ENV]: accessJwt,
        [UPSTREAM_BASE_URL_ENV]: deps.identityOrigin,
        ...(tenantModelsJson ? { [TENANT_MODELS_ENV]: tenantModelsJson } : {}),
      };
    },

    async startLogin() {
      const web = deps.webOrigin;
      const identity = deps.identityOrigin;
      if (!web || !identity) {
        return { ok: false, refused: '这个版本没有配置账号服务地址，现在不能登录。' };
      }
      const verifier = generateCodeVerifier();
      const challenge = codeChallengeS256(verifier);
      const state = randomBytes(16).toString('base64url');
      const { server, port, code: returned } = await listenLoopback();
      const redirectUri = `http://127.0.0.1:${port}/callback`;
      const start = new URL(`${web}/signin`);
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
        await applyTokens(tokens.accessToken, tokens.refreshToken);
        deps.logger?.info('desktop.account.signed_in', { authMode: 'hosted' });
        return { ok: true };
      } catch {
        return { ok: false, refused: '登录没有完成。可以稍后再试，本机任务不受影响。' };
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },

    async logout() {
      accessJwt = undefined;
      role = undefined;
      tenantModelsJson = undefined;
      devices = [];
      quotaUsed = undefined;
      quotaLimit = undefined;
      deps.vault.remove(REFRESH_SECRET);
      deps.logger?.info('desktop.account.signed_out', { authMode: 'local' });
    },

    async listDevices() {
      if (!accessJwt) return [];
      const res = await identityFetch('/v1/devices', {
        headers: { authorization: `Bearer ${accessJwt}` },
      });
      if (!res.ok) return [];
      const body = (await res.json()) as { devices?: DeviceView[] };
      devices = body.devices ?? [];
      return devices;
    },

    async revokeDevice(id) {
      if (!accessJwt) return { ok: false, refused: '还没有登录。' };
      const res = await identityFetch('/v1/devices/revoke', {
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
      const refresh = deps.vault.get(REFRESH_SECRET);
      if (!refresh || !deps.identityOrigin) return;
      try {
        const res = await identityFetch('/v1/oauth/token', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: refresh }),
        });
        if (!res.ok) {
          deps.vault.remove(REFRESH_SECRET);
          return;
        }
        const tokens = (await res.json()) as { accessToken?: string; refreshToken?: string };
        if (!tokens.accessToken || !tokens.refreshToken) {
          deps.vault.remove(REFRESH_SECRET);
          return;
        }
        await applyTokens(tokens.accessToken, tokens.refreshToken);
      } catch {
        /* 未登录可用：恢复失败就保持未登录，不出网重试 */
      }
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
