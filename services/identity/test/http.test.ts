import type { AddressInfo } from 'node:net';

import { generateEs256KeyPair } from '@evowork/account';
import { afterEach, describe, expect, it } from 'vitest';

import { openIdentityDb } from '../src/db.js';
import { createIdentityServer } from '../src/http.js';
import { memoryMailer } from '../src/mailer.js';
import { TEST_ARGON } from '../src/password.js';
import { parseMasterKey } from '../src/secret-box.js';
import { createIdentity } from '../src/service.js';

const MASTER = parseMasterKey('cd'.repeat(32));

let baseUrl = '';
let close: () => Promise<void> = async () => undefined;

async function start() {
  const db = openIdentityDb(':memory:');
  const keys = generateEs256KeyPair();
  const identity = createIdentity({
    db,
    keys,
    masterKey: MASTER,
    mailer: memoryMailer(),
    argon: TEST_ARGON,
    publicOrigin: 'http://127.0.0.1',
  });
  identity.bootstrap({
    email: 'admin@example.com',
    password: 'change-me',
    tenantName: 'default',
  });
  const server = createIdentityServer({ identity, keys, internalToken: 'svc-token' });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
  close = () =>
    new Promise((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  return { identity, keys };
}

afterEach(async () => {
  await close();
});

describe('identity HTTP', () => {
  it('登录后目录没有 apiKey；内部端点才返回上游', async () => {
    await start();
    const login = await fetch(`${baseUrl}/v1/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        identifier: 'admin@example.com',
        password: 'change-me',
        deviceId: 'dev_http',
      }),
    });
    expect(login.status).toBe(200);
    const tokens = (await login.json()) as { accessToken: string; userId?: string };
    await fetch(`${baseUrl}/v1/password`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${tokens.accessToken}`,
      },
      body: JSON.stringify({ current: 'change-me', next: 'new-pass-1' }),
    });
    // 改密之后旧 access 仍有效直到过期；管理动作看服务端当时角色
    const created = await fetch(`${baseUrl}/v1/admin/models`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${tokens.accessToken}`,
      },
      body: JSON.stringify({
        modelId: 'evowork/hosted-flash',
        displayName: '托管',
        provider: 'deepseek',
        upstreamModel: 'deepseek-v4-flash',
        adapter: 'deepseek',
        baseUrl: 'https://api.deepseek.com',
        apiKey: 'sk-http-secret',
      }),
    });
    expect(created.status).toBe(200);

    const catalog = await fetch(`${baseUrl}/v1/catalog`, {
      headers: { authorization: `Bearer ${tokens.accessToken}` },
    });
    const body = (await catalog.json()) as { data: Record<string, unknown>[] };
    expect(body.data[0]).not.toHaveProperty('apiKey');
    expect(body.data[0]).not.toHaveProperty('baseUrl');

    const inner = await fetch(
      `${baseUrl}/v1/internal/upstream?tenant=${encodeURIComponent(
        (
          (await (
            await fetch(`${baseUrl}/v1/me`, {
              headers: { authorization: `Bearer ${tokens.accessToken}` },
            })
          ).json()) as { tenantId: string }
        ).tenantId,
      )}&model=evowork/hosted-flash`,
      { headers: { 'x-evowork-internal': 'svc-token' } },
    );
    expect(inner.status).toBe(200);
    expect(await inner.json()).toEqual({
      baseUrl: 'https://api.deepseek.com',
      apiKey: 'sk-http-secret',
    });
  });

  it('JWKS 无需登录', async () => {
    await start();
    const res = await fetch(`${baseUrl}/v1/jwks`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { keys: unknown[] };
    expect(body.keys.length).toBe(1);
  });
});
