import { generateKeyPairSync } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { ACCESS_TTL_SEC } from '../src/claims.js';
import {
  checkEs256PublicPem,
  generateEs256KeyPair,
  signAccessToken,
  verifyAccessToken,
} from '../src/jwt.js';
import type { AccessClaims } from '../src/claims.js';

function claims(over: Partial<AccessClaims> = {}): AccessClaims {
  const now = 1_700_000_000;
  return {
    sub: 'usr_1',
    tenant: 'ten_1',
    iat: now,
    exp: now + ACCESS_TTL_SEC,
    scope: 'gateway',
    quotaClass: 'default',
    deviceId: 'dev_1',
    role: 'member',
    ...over,
  };
}

describe('ES256 JWT', () => {
  it('自己签的自己验得过', () => {
    const pair = generateEs256KeyPair();
    const token = signAccessToken(pair.privatePem, claims(), pair.kid);
    const result = verifyAccessToken(token, { publicPem: pair.publicPem, nowSec: 1_700_000_010 });
    expect(result).toEqual({ ok: true, claims: claims() });
  });

  it('用 JWK 也能验 —— 网关缓存的是 JWKS，不是 PEM', () => {
    const pair = generateEs256KeyPair();
    const token = signAccessToken(pair.privatePem, claims(), pair.kid);
    const result = verifyAccessToken(token, { jwk: pair.jwk, nowSec: 1_700_000_010 });
    expect(result.ok).toBe(true);
  });

  it('过期（含时钟偏移）失败', () => {
    const pair = generateEs256KeyPair();
    const token = signAccessToken(pair.privatePem, claims({ exp: 1_700_000_100 }), pair.kid);
    expect(
      verifyAccessToken(token, {
        publicPem: pair.publicPem,
        nowSec: 1_700_000_200,
        clockSkewSec: 60,
      }).ok,
    ).toBe(false);
  });

  it('改一个字节就验不过 —— 不是「看起来像 JWT 就算」', () => {
    const pair = generateEs256KeyPair();
    const token = signAccessToken(pair.privatePem, claims(), pair.kid);
    const tampered = `${token.slice(0, -4)}AAAA`;
    expect(
      verifyAccessToken(tampered, { publicPem: pair.publicPem, nowSec: 1_700_000_010 }),
    ).toEqual({ ok: false, reason: 'bad-sig' });
  });

  it('别人的密钥验不过', () => {
    const a = generateEs256KeyPair();
    const b = generateEs256KeyPair();
    const token = signAccessToken(a.privatePem, claims(), a.kid);
    expect(verifyAccessToken(token, { publicPem: b.publicPem, nowSec: 1_700_000_010 }).ok).toBe(
      false,
    );
  });
});

describe('验签方启动时的公钥体检', () => {
  /*
   * 判据是**后果**：体检放行的，必须真能验过我们签的令牌；体检拒绝的（私钥除外），
   * 必须真的验不了。只断言"返回了哪个 problem"的话，体检与验签可以各说各的 ——
   * 而这一步存在的全部理由，就是让"启动成功"等于"验签可用"。
   */
  const now = 1_700_000_010;

  it('放行的公钥真的验得过我们签的令牌（正向对照）', () => {
    const pair = generateEs256KeyPair();
    const checked = checkEs256PublicPem(pair.publicPem);
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    const token = signAccessToken(pair.privatePem, claims(), pair.kid);
    expect(verifyAccessToken(token, { publicPem: checked.pem, nowSec: now }).ok).toBe(true);
  });

  /*
   * 2026-09-27 线上的原样：systemd 的 EnvironmentFile 把不带引号值里的 `\n` 当转义吃掉，
   * 进程拿到的是 `-----BEGIN PUBLIC KEY-----nMFkw…`。放它启动的后果是所有上传静默 401。
   */
  it('被 systemd 吃掉反斜杠的那一串：拒绝，且它确实验不了', () => {
    const pair = generateEs256KeyPair();
    const mangled = pair.publicPem.trim().split('\n').join('n');
    expect(checkEs256PublicPem(mangled)).toEqual({ ok: false, problem: 'unparseable' });

    const token = signAccessToken(pair.privatePem, claims(), pair.kid);
    expect(verifyAccessToken(token, { publicPem: mangled, nowSec: now }).ok).toBe(false);
  });

  it.each([
    ['RSA', () => generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey],
    ['P-384', () => generateKeyPairSync('ec', { namedCurve: 'P-384' }).publicKey],
  ])('能解析但不是 P-256 的 %s 公钥：拒绝 —— 每次验签都会失败，与坏公钥同一个后果', (_, make) => {
    const pem = make().export({ type: 'spki', format: 'pem' }).toString();
    expect(checkEs256PublicPem(pem)).toEqual({ ok: false, problem: 'not-es256' });

    const pair = generateEs256KeyPair();
    const token = signAccessToken(pair.privatePem, claims(), pair.kid);
    expect(verifyAccessToken(token, { publicPem: pem, nowSec: now }).ok).toBe(false);
  });

  /*
   * 这是唯一一种"其实验得过"却要拒绝的：`createPublicKey` 会从私钥导出公钥。
   * 拒绝它的理由不是验不了，是**签发密钥不该出现在只验签的机器上**。
   */
  it('给的是私钥：拒绝，哪怕它验得过', () => {
    const pair = generateEs256KeyPair();
    const token = signAccessToken(pair.privatePem, claims(), pair.kid);
    expect(verifyAccessToken(token, { publicPem: pair.privatePem, nowSec: now }).ok).toBe(true);
    expect(checkEs256PublicPem(pair.privatePem)).toEqual({ ok: false, problem: 'private-key' });
  });

  it.each([[undefined], [''], ['   \n ']])('没给（%j）：missing', (pem) => {
    expect(checkEs256PublicPem(pem)).toEqual({ ok: false, problem: 'missing' });
  });
});
