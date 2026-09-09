import { describe, expect, it } from 'vitest';

import { ACCESS_TTL_SEC } from '../src/claims.js';
import { generateEs256KeyPair, signAccessToken, verifyAccessToken } from '../src/jwt.js';
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
      verifyAccessToken(token, { publicPem: pair.publicPem, nowSec: 1_700_000_200, clockSkewSec: 60 })
        .ok,
    ).toBe(false);
  });

  it('改一个字节就验不过 —— 不是「看起来像 JWT 就算」', () => {
    const pair = generateEs256KeyPair();
    const token = signAccessToken(pair.privatePem, claims(), pair.kid);
    const tampered = `${token.slice(0, -4)}AAAA`;
    expect(verifyAccessToken(tampered, { publicPem: pair.publicPem, nowSec: 1_700_000_010 })).toEqual(
      { ok: false, reason: 'bad-sig' },
    );
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
