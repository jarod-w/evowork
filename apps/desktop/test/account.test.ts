/**
 * 桌面账号会话（Q33=A / 11 §12 第 12 · 14 条）。
 *
 * 密码不在这个进程里。未登录时零出网。登出只清会话。
 */
import type { Server } from 'node:http';

import { describe, expect, it, vi } from 'vitest';

import { ACCESS_JWT_ENV, TENANT_MODELS_ENV, UPSTREAM_BASE_URL_ENV } from '@evowork/gateway';

import {
  ACCOUNT_SECRET_PREFIX,
  createAccountSession,
  REFRESH_SECRET,
  type AccountVault,
} from '../src/main/account.js';

function memoryVault(seed: Record<string, string> = {}): AccountVault & {
  readonly map: Map<string, string>;
} {
  const map = new Map(Object.entries(seed));
  return {
    map,
    get: (name) => map.get(name),
    set: (name, value) => {
      map.set(name, value);
      return true;
    },
    remove: (name) => map.delete(name),
  };
}

const ORIGINS = {
  identityOrigin: 'https://id.example.com',
  webOrigin: 'https://web.example.com',
} as const;

describe('未登录不出网', () => {
  it('gatewayInject 是空对象 —— 调用方不得据此去打我们的云', () => {
    const session = createAccountSession({
      vault: memoryVault(),
      readFlag: () => undefined,
      writeFlag: () => undefined,
      openExternal: async () => undefined,
      ...ORIGINS,
    });
    expect(session.gatewayInject()).toEqual({});
    expect(session.signedIn()).toBe(false);
  });

  it('没有配置账号服务地址时立刻拒绝，不开浏览器、不挂起', async () => {
    const openExternal = vi.fn(async () => undefined);
    const session = createAccountSession({
      vault: memoryVault(),
      readFlag: () => undefined,
      writeFlag: () => undefined,
      openExternal,
    });
    const result = await session.startLogin();
    expect(result.ok).toBe(false);
    expect(result.refused).toMatch(/不能登录/);
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('vault 里没有 refresh 时 restore 不发任何请求', async () => {
    const fetchFn = vi.fn(async () => new Response('{}'));
    const session = createAccountSession({
      vault: memoryVault(),
      readFlag: () => undefined,
      writeFlag: () => undefined,
      openExternal: async () => undefined,
      ...ORIGINS,
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    await session.restore();
    expect(fetchFn).not.toHaveBeenCalled();
    expect(session.signedIn()).toBe(false);
  });
});

describe('PKCE 登录', () => {
  it('打开系统浏览器，用授权码换票；refresh 进密钥库，access JWT 只留内存', async () => {
    const vault = memoryVault();
    const fetchFn = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/v1/oauth/token')) {
        return new Response(
          JSON.stringify({
            accessToken: 'hdr.eyJyb2xlIjoibWVtYmVyIn0.sig',
            refreshToken: 'rt_1',
          }),
          { status: 200 },
        );
      }
      if (url.endsWith('/v1/catalog')) {
        return new Response(
          JSON.stringify({
            data: [
              {
                id: 'evowork/hosted-flash',
                displayName: '托管',
                provider: 'deepseek',
                upstreamModel: 'deepseek-v4-flash',
              },
            ],
          }),
          { status: 200 },
        );
      }
      if (url.endsWith('/v1/quota')) {
        return new Response(JSON.stringify({ used: 1, limit: 10 }), { status: 200 });
      }
      return new Response('{}', { status: 404 });
    });
    let serverRef: Server | undefined;
    const session = createAccountSession({
      vault,
      readFlag: () => undefined,
      writeFlag: () => undefined,
      ...ORIGINS,
      fetchFn: fetchFn as unknown as typeof fetch,
      openExternal: async (url: string) => {
        const parsed = new URL(url);
        expect(parsed.origin).toBe('https://web.example.com');
        expect(parsed.pathname).toBe('/signin');
        expect(parsed.searchParams.get('code_challenge_method')).toBe('S256');
        expect(parsed.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:4390/callback');
        const state = parsed.searchParams.get('state') ?? '';
        queueMicrotask(() => {
          const req = { url: `/callback?code=abc&state=${state}` };
          const res = { writeHead: () => undefined, end: () => undefined };
          serverRef?.emit('request', req, res);
        });
      },
      listen: async (server: Server) => {
        serverRef = server;
        return 4390;
      },
    });
    const result = await session.startLogin();
    expect(result.ok).toBe(true);
    expect(session.signedIn()).toBe(true);
    expect(vault.get(REFRESH_SECRET)).toBe('rt_1');
    expect([...vault.map.keys()].every((key) => key.startsWith(ACCOUNT_SECRET_PREFIX))).toBe(true);
    expect([...vault.map.values()].join()).not.toContain('hdr.');
    const injected = session.gatewayInject();
    expect(injected[ACCESS_JWT_ENV]).toBe('hdr.eyJyb2xlIjoibWVtYmVyIn0.sig');
    expect(injected[UPSTREAM_BASE_URL_ENV]).toBe('https://id.example.com');
    expect(injected[TENANT_MODELS_ENV]).toContain('evowork/hosted-flash');
    expect(injected[TENANT_MODELS_ENV]).not.toContain('apiKey');
    const bodies = fetchFn.mock.calls
      .map((call) => (call[1] as { body?: string } | undefined)?.body ?? '')
      .join('\n');
    expect(bodies).not.toContain('password');
  });
});

describe('登出', () => {
  it('只清 refresh 与内存 JWT，不向 identity 发注销请求（注销走 WEB）', async () => {
    const vault = memoryVault({ [REFRESH_SECRET]: 'rt_keep_local_history' });
    const fetchFn = vi.fn(async () => new Response('{}'));
    const session = createAccountSession({
      vault,
      readFlag: () => undefined,
      writeFlag: () => undefined,
      openExternal: async () => undefined,
      ...ORIGINS,
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    await session.logout();
    expect(vault.get(REFRESH_SECRET)).toBeUndefined();
    expect(session.gatewayInject()).toEqual({});
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
