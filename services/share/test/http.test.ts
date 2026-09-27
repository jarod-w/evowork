/**
 * 真起服务器的端到端。
 *
 * 单测证明不了**响应头**，而响应头正是「办公文件不被当网页跑」的落点：
 * `Content-Type` / `Content-Disposition` / `X-Content-Type-Options` 三样任意一样写错，
 * 一份 docx 就可能在接收方的浏览器里被渲染（验收口径第 21 条）。
 *
 * 也顺带证明上传那一半真的认 identity 签的 JWT —— 那个契约写在
 * `services/artifacts/src/upload.ts` 里很久了，从来没有对着一个真的服务端跑过。
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { generateEs256KeyPair, signAccessToken, type AccessClaims } from '@evowork/account';
import { afterEach, describe, expect, it } from 'vitest';

import { memoryBlobs } from '../src/blobs.js';
import { openShareDb } from '../src/db.js';
import { createShareServer } from '../src/http.js';
import { createShareService, sha256Hex } from '../src/service.js';

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

let baseUrl = '';
let close: () => Promise<void> = async () => undefined;

async function start() {
  const keys = generateEs256KeyPair();
  const service = createShareService({
    db: openShareDb(':memory:'),
    blobs: memoryBlobs(),
    publicOrigin: 'https://s.example',
  });
  // 给一个只有 share.html 的临时目录：这一条要验的是**响应头**，不是构建产物
  const webDir = mkdtempSync(join(tmpdir(), 'evowork-share-'));
  writeFileSync(join(webDir, 'share.html'), '<!doctype html><title>分享</title>');
  const server = createShareServer({ service, publicPem: keys.publicPem, webDir });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () =>
    new Promise((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });

  const iat = Math.floor(Date.now() / 1000);
  const claims: AccessClaims = {
    sub: 'usr_1',
    tenant: 'ten_1',
    iat,
    exp: iat + 900,
    scope: 'gateway',
    quotaClass: 'default',
    deviceId: 'dev_1',
    role: 'member',
  };
  return { service, token: signAccessToken(keys.privatePem, claims, keys.kid) };
}

/** 按 `services/artifacts/src/upload.ts` 的那份契约发请求，一个字段都不改。 */
async function upload(
  token: string,
  over: { id?: string; contentType?: string; password?: string; bytes?: Uint8Array } = {},
) {
  return fetch(`${baseUrl}/v1/shares`, {
    method: 'PUT',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': over.contentType ?? DOCX,
      'x-evowork-share-id': over.id ?? 'shr_e2e',
      'x-evowork-name-digest': 'a1b2c3',
      'x-evowork-expires-at': String(Date.now() + 86_400_000),
      ...(over.password ? { 'x-evowork-password': over.password } : {}),
    },
    body: new Blob([(over.bytes ?? new Uint8Array([80, 75, 3, 4])).buffer as ArrayBuffer]),
  });
}

afterEach(async () => {
  await close();
});

describe('上传契约', () => {
  it('带 identity 签的 JWT 就能传，回一条 /s/<id> 链接', async () => {
    const { token } = await start();
    const res = await upload(token);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { url: string }).url).toBe('https://s.example/s/shr_e2e');
  });

  it('没有令牌传不上去 —— 不降级成「不鉴权」', async () => {
    await start();
    const res = await fetch(`${baseUrl}/v1/shares`, {
      method: 'PUT',
      headers: {
        'x-evowork-share-id': 'shr_x',
        'x-evowork-name-digest': 'd',
        'x-evowork-expires-at': '1',
      },
      body: 'x',
    });
    expect(res.status).toBe(401);
  });
});

describe('办公文件的响应头（验收口径第 21 条）', () => {
  it('以 attachment + octet-stream + nosniff 下发，浏览器没有机会渲染它', async () => {
    const { token } = await start();
    await upload(token);
    const res = await fetch(`${baseUrl}/v1/s/shr_e2e/blob`);
    expect(res.status).toBe(200);
    // 真实 MIME 内联下发 = 邀请浏览器去渲染一份不可信文件
    expect(res.headers.get('content-type')).toBe('application/octet-stream');
    expect(res.headers.get('content-disposition')).toBe('attachment');
    // nosniff 挡住"类型写对了但浏览器自作主张"那一路
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-security-policy')).toContain('sandbox');
  });

  it('图片才走 inline，且同样带 nosniff 与 sandbox', async () => {
    const { token } = await start();
    await upload(token, { id: 'shr_png', contentType: 'image/png' });
    const res = await fetch(`${baseUrl}/v1/s/shr_png/blob`);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('content-disposition')).toBe('inline');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('SVG 当成普通附件下发 —— 它是能带脚本的 XML', async () => {
    const { token } = await start();
    await upload(token, { id: 'shr_svg', contentType: 'image/svg+xml' });
    const res = await fetch(`${baseUrl}/v1/s/shr_svg/blob`);
    expect(res.headers.get('content-type')).toBe('application/octet-stream');
    expect(res.headers.get('content-disposition')).toBe('attachment');
  });
});

describe('读取面不碰账号（验收口径第 25 条）', () => {
  it('元数据接口不回 Set-Cookie，也不因为带了令牌而给更多', async () => {
    const { token } = await start();
    await upload(token);
    const anon = await fetch(`${baseUrl}/v1/s/shr_e2e`);
    const withToken = await fetch(`${baseUrl}/v1/s/shr_e2e`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(anon.headers.get('set-cookie')).toBeNull();
    expect(await anon.text()).toBe(await withToken.text());
  });

  it('跨源开了读，但没开 credentials', async () => {
    const { token } = await start();
    await upload(token);
    const res = await fetch(`${baseUrl}/v1/s/shr_e2e`);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('access-control-allow-credentials')).toBeNull();
  });
});

describe('密码与撤销', () => {
  it('设了密码就必须先解锁，解锁用的是哈希不是明文', async () => {
    const { token } = await start();
    const hash = sha256Hex('shr_pw:hunter2');
    await upload(token, { id: 'shr_pw', password: hash });

    const locked = await fetch(`${baseUrl}/v1/s/shr_pw/blob`);
    expect(locked.status).toBe(403);

    const unlock = await fetch(`${baseUrl}/v1/s/shr_pw/unlock`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ passwordHash: hash }),
    });
    expect(unlock.status).toBe(200);
    const grant = ((await unlock.json()) as { grant: string }).grant;

    const opened = await fetch(`${baseUrl}/v1/s/shr_pw/blob`, {
      headers: { 'x-evowork-grant': grant },
    });
    expect(opened.status).toBe(200);
    // 解锁之后它依然是不可预览的 docx
    expect(opened.headers.get('content-disposition')).toBe('attachment');
  });

  it('撤销之后链接失效，且撤销一个不存在的 id 不暴露它不存在', async () => {
    const { token } = await start();
    await upload(token);
    const gone = await fetch(`${baseUrl}/v1/shares/shr_e2e`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(gone.status).toBe(204);
    const seen = (await (await fetch(`${baseUrl}/v1/s/shr_e2e`)).json()) as { state: string };
    expect(seen.state).toBe('revoked');

    const nobody = await fetch(`${baseUrl}/v1/shares/shr_nope`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(nobody.status).toBe(204);
  });
});

describe('分享页本身', () => {
  it('/s/<id> 回 HTML，且 CSP 是 default-src none 起步', async () => {
    await start();
    const res = await fetch(`${baseUrl}/s/shr_e2e`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');

    const csp = res.headers.get('content-security-policy') ?? '';
    expect(csp).toContain("default-src 'none'");
    // 这一页要把不可信来源的元数据画出来，一条宽松的 CSP 就让"画出来"变成"跑起来"
    expect(csp).not.toContain('unsafe-eval');
    expect(csp).toContain("frame-ancestors 'none'");
    // PDF 预览的 iframe 只准加载 blob:，不准加载外域
    expect(csp).toContain('frame-src blob:');

    // 分享链接会被转发到各种地方，别把来源带给我们自己
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('页面对任何 id 都一样 —— 从 HTML 上看不出这个分享存不存在', async () => {
    await start();
    const real = await fetch(`${baseUrl}/s/shr_e2e`);
    const fake = await fetch(`${baseUrl}/s/shr_zzzzz`);
    expect(await real.text()).toBe(await fake.text());
  });
});
