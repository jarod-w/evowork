import type { AddressInfo } from 'node:net';

import { createServer } from 'node:http';

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

  it('签发策略包后成员 GET 拿到信封，响应里没有 apiKey', async () => {
    await start();
    const login = await fetch(`${baseUrl}/v1/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        identifier: 'admin@example.com',
        password: 'change-me',
        deviceId: 'dev_pack',
      }),
    });
    const tokens = (await login.json()) as { accessToken: string };
    await fetch(`${baseUrl}/v1/password`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${tokens.accessToken}`,
      },
      body: JSON.stringify({ current: 'change-me', next: 'new-pass-1' }),
    });
    const issued = await fetch(`${baseUrl}/v1/admin/policy-pack`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${tokens.accessToken}`,
      },
      body: JSON.stringify({
        expiresInDays: 30,
        allowCustom: false,
        disabledModels: ['openai/gpt-5'],
      }),
    });
    expect(issued.status).toBe(200);
    const envelope = (await issued.json()) as Record<string, unknown>;
    expect(envelope).not.toHaveProperty('apiKey');
    expect(typeof envelope.payloadJson).toBe('string');
    expect(JSON.stringify(envelope)).not.toMatch(/apiKey/);

    const got = await fetch(`${baseUrl}/v1/policy-pack`, {
      headers: { authorization: `Bearer ${tokens.accessToken}` },
    });
    expect(got.status).toBe(200);
    const body = (await got.json()) as { pack: Record<string, unknown> | null };
    expect(body.pack?.payloadJson).toBe(envelope.payloadJson);
    expect(JSON.stringify(body)).not.toMatch(/apiKey/);
  });

  it('改密前管理端 403；改密后能进（11 §12 第 23 条）', async () => {
    await start();
    const login = await fetch(`${baseUrl}/v1/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        identifier: 'admin@example.com',
        password: 'change-me',
        deviceId: 'dev_gate',
      }),
    });
    const tokens = (await login.json()) as { accessToken: string; mustChangePassword: boolean };
    expect(tokens.mustChangePassword).toBe(true);
    const blocked = await fetch(`${baseUrl}/v1/admin/members`, {
      headers: { authorization: `Bearer ${tokens.accessToken}` },
    });
    expect(blocked.status).toBe(403);
    expect(((await blocked.json()) as { error: { code: string } }).error.code).toBe(
      'must-change-password',
    );
    await fetch(`${baseUrl}/v1/password`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${tokens.accessToken}`,
      },
      body: JSON.stringify({ current: 'change-me', next: 'new-pass-1' }),
    });
    const me = await fetch(`${baseUrl}/v1/me`, {
      headers: { authorization: `Bearer ${tokens.accessToken}` },
    });
    expect(((await me.json()) as { mustChangePassword: boolean }).mustChangePassword).toBe(false);
    const allowed = await fetch(`${baseUrl}/v1/admin/members`, {
      headers: { authorization: `Bearer ${tokens.accessToken}` },
    });
    expect(allowed.status).toBe(200);
  });

  it('管理端用量即使带 groupBy=day 也不返回按天序列（Q43=A）', async () => {
    await start();
    const login = await fetch(`${baseUrl}/v1/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        identifier: 'admin@example.com',
        password: 'change-me',
        deviceId: 'dev_usage',
      }),
    });
    const tokens = (await login.json()) as { accessToken: string };
    await fetch(`${baseUrl}/v1/password`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${tokens.accessToken}`,
      },
      body: JSON.stringify({ current: 'change-me', next: 'new-pass-1' }),
    });
    const res = await fetch(`${baseUrl}/v1/admin/usage?groupBy=day`, {
      headers: { authorization: `Bearer ${tokens.accessToken}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toHaveProperty('tenantUsed');
    expect(body).toHaveProperty('members');
    expect(body).not.toHaveProperty('days');
    expect(body).not.toHaveProperty('series');
    expect(JSON.stringify(body)).not.toMatch(/byDay/);
  });

  /**
   * 托管模型这一跳**必须是边收边转**。
   *
   * 原先这里是 `await upstream.arrayBuffer()`：整条响应读完才写回第一个字节。
   * 那对用户来说等于完全没有流式，而下游内核 300 秒收不到帧就判整个回合失败 ——
   * 于是"答案越长越容易失败"。这条测试卡的就是那一点：**上游还没说完，
   * 下游必须已经拿到字节了**。
   */
  it('托管转发是边收边转的，不是读完再转；用量从流里那条 completed 取', async () => {
    let releaseUpstream = () => undefined;
    const upstreamServer = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
      res.write(`data: ${JSON.stringify({ type: 'response.created' })}\n\n`);
      // 先吐一帧就停住 —— 模拟"模型还在写"
      releaseUpstream = () => {
        res.write(
          `data: ${JSON.stringify({
            type: 'response.completed',
            response: { id: 'r1', usage: { input_tokens: 40, output_tokens: 60 } },
          })}\n\n`,
        );
        res.end('data: [DONE]\n\n');
      };
    });
    await new Promise<void>((resolve) => upstreamServer.listen(0, '127.0.0.1', resolve));
    const upstreamPort = (upstreamServer.address() as AddressInfo).port;

    await start();
    const login = await fetch(`${baseUrl}/v1/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        identifier: 'admin@example.com',
        password: 'change-me',
        deviceId: 'dev_stream',
      }),
    });
    const tokens = (await login.json()) as { accessToken: string };
    const auth = { authorization: `Bearer ${tokens.accessToken}` };
    // 引导密码没改之前，管理端一律 403（与本文件其它用例同一条前置）
    await fetch(`${baseUrl}/v1/password`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...auth },
      body: JSON.stringify({ current: 'change-me', next: 'new-pass-1' }),
    });
    const registered = await fetch(`${baseUrl}/v1/admin/models`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...auth },
      body: JSON.stringify({
        modelId: 'evowork/hosted-flash',
        displayName: '托管',
        provider: 'deepseek',
        upstreamModel: 'deepseek-v4-flash',
        adapter: 'deepseek',
        baseUrl: `http://127.0.0.1:${upstreamPort}`,
        apiKey: 'sk-stream-secret',
      }),
    });
    expect(registered.status).toBe(200);

    const relayed = await fetch(`${baseUrl}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...auth },
      body: JSON.stringify({ model: 'evowork/hosted-flash', input: [], stream: true }),
    });
    expect(relayed.status).toBe(200);

    const reader = relayed.body!.getReader();
    const firstChunk = await reader.read();
    // **上游此刻还没说完**：读完再转的实现会卡在这一行直到超时
    expect(new TextDecoder().decode(firstChunk.value)).toContain('response.created');

    releaseUpstream();
    let rest = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      rest += new TextDecoder().decode(value);
    }
    expect(rest).toContain('[DONE]');

    // 用量原先从整份 JSON 里取；改成流式之后要从 `response.completed` 那帧取，口径不能丢
    const quota = await fetch(`${baseUrl}/v1/quota`, { headers: auth });
    expect(((await quota.json()) as { used: number }).used).toBe(100);

    await new Promise<void>((resolve) => upstreamServer.close(() => resolve()));
  });
});
