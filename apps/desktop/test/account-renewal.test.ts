import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAccountSession, originsFromEnv, REFRESH_SECRET } from '../src/main/account.js';

const T0 = 1_800_000_000_000;
function token(serial: number, ttl = 120) {
  return `header.${Buffer.from(JSON.stringify({ sub: 'user', tenant: 'none', scope: [], deviceId: 'dev', quotaClass: 'default', role: 'member', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + ttl })).toString('base64url')}.sig${serial}`;
}
function harness() {
  const secrets = new Map([[REFRESH_SECRET, 'refresh-0']]);
  let serial = 0;
  const changed = vi.fn();
  const fetchFn = vi.fn(async (input: RequestInfo | URL) => {
    const path = new URL(String(input)).pathname;
    if (path === '/v1/oauth/token') {
      serial += 1;
      return Response.json({ accessToken: token(serial), refreshToken: `refresh-${serial}` });
    }
    return Response.json({ data: [], devices: [{ id: 'dev' }], used: 0, limit: 0 });
  });
  const session = createAccountSession({
    webOrigin: 'https://web.example.com',
    identityOrigin: 'https://id.example.com',
    vault: {
      get: (key) => secrets.get(key),
      set: (key, value) => {
        secrets.set(key, value);
        return true;
      },
      remove: (key) => secrets.delete(key),
    },
    readFlag: () => 'dev',
    writeFlag: () => undefined,
    openExternal: async () => undefined,
    fetchFn: fetchFn as typeof fetch,
    onSessionChanged: changed,
  });
  return { session, secrets, fetchFn, changed };
}
afterEach(() => {
  vi.useRealTimers();
});

describe('桌面令牌生命周期', () => {
  it('到期前自动旋转 refresh 并通知宿主更新网关；关闭后不再续期', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const h = harness();
    await h.session.restore();
    const initial = h.session.accessToken();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.session.accessToken()).not.toBe(initial);
    expect(h.secrets.get(REFRESH_SECRET)).toBe('refresh-2');
    expect(h.changed).toHaveBeenCalledTimes(2);
    h.session.dispose();
    const calls = h.fetchFn.mock.calls.length;
    await vi.advanceTimersByTimeAsync(180_000);
    expect(h.fetchFn).toHaveBeenCalledTimes(calls);
    expect(h.secrets.has(REFRESH_SECRET)).toBe(true);
  });

  it('并发 401 只换一次票，设备请求重放后成功', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const h = harness();
    await h.session.restore();
    const initial = h.session.accessToken();
    const normal = h.fetchFn.getMockImplementation()!;
    h.fetchFn.mockImplementation(async (input, init?: RequestInit) => {
      if (
        String(input).endsWith('/v1/devices') &&
        new Headers(init?.headers).get('authorization') === `Bearer ${initial}`
      )
        return new Response('', { status: 401 });
      return normal(input);
    });
    const devices = await Promise.all([
      h.session.listDevices(),
      h.session.listDevices(),
      h.session.listDevices(),
    ]);
    expect(devices.every((rows) => rows.length === 1)).toBe(true);
    expect(
      h.fetchFn.mock.calls.filter(([url]) => String(url).endsWith('/v1/oauth/token')),
    ).toHaveLength(2);
    h.session.dispose();
  });

  it('断网后保留凭据并重试，明确吊销后退出且停止重试', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const h = harness();
    await h.session.restore();
    const normal = h.fetchFn.getMockImplementation()!;
    h.fetchFn.mockRejectedValueOnce(new TypeError('offline'));
    await h.session.refresh();
    expect(h.secrets.get(REFRESH_SECRET)).toBe('refresh-1');
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.secrets.get(REFRESH_SECRET)).toBe('refresh-2');
    h.fetchFn.mockImplementation(async (input) =>
      String(input).endsWith('/v1/oauth/token') ? new Response('', { status: 401 }) : normal(input),
    );
    await h.session.refresh();
    expect(h.session.signedIn()).toBe(false);
    expect(h.session.gatewayInject()).toEqual({});
    expect(h.secrets.has(REFRESH_SECRET)).toBe(false);
    const calls = h.fetchFn.mock.calls.length;
    await vi.advanceTimersByTimeAsync(180_000);
    expect(h.fetchFn).toHaveBeenCalledTimes(calls);
  });

  it.each(['logout', 'dispose'] as const)('在途续期不能在 %s 后恢复登录', async (operation) => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const h = harness();
    let complete!: (response: Response) => void;
    h.fetchFn.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    const pending = h.session.refresh();
    await h.session[operation]();
    complete(Response.json({ accessToken: token(1), refreshToken: 'late' }));
    expect(await pending).toBe(false);
    expect(h.session.signedIn()).toBe(false);
    expect(h.secrets.get(REFRESH_SECRET)).not.toBe('late');
  });

  it('密钥库保存失败时不报告登录成功', async () => {
    const session = createAccountSession({
      identityOrigin: 'https://id.example.com',
      vault: { get: () => 'refresh', set: () => false, remove: () => true },
      readFlag: () => undefined,
      writeFlag: () => undefined,
      openExternal: async () => undefined,
      fetchFn: (async () =>
        Response.json({ accessToken: token(1), refreshToken: 'next' })) as typeof fetch,
    });
    expect(await session.refresh()).toBe(false);
    expect(session.signedIn()).toBe(false);
    session.dispose();
  });

  it('访达启动可读随包账号地址，环境变量覆盖不触发网络', () => {
    const dir = mkdtempSync(join(tmpdir(), 'evowork-account-config-'));
    try {
      writeFileSync(
        join(dir, 'account.json'),
        JSON.stringify({
          webOrigin: 'https://account.example.com',
          identityOrigin: 'https://id.example.com',
        }),
      );
      expect(originsFromEnv({}, dir).webOrigin).toBe('https://account.example.com');
      expect(
        originsFromEnv({ EVOWORK_IDENTITY_ORIGIN: 'https://private.example.com/' }, dir)
          .identityOrigin,
      ).toBe('https://private.example.com');
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});
