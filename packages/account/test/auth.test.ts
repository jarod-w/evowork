import { describe, expect, it } from 'vitest';

import { jwtAuth } from '../src/auth.js';
import { ACCESS_TTL_SEC, type AccessClaims } from '../src/claims.js';
import { generateEs256KeyPair, signAccessToken } from '../src/jwt.js';

function claims(): AccessClaims {
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
  };
}

describe('jwtAuth', () => {
  it('合法 Bearer 过；缺头 / 错前缀 / 坏 token 都是 false，不区分原因', () => {
    const pair = generateEs256KeyPair();
    const token = signAccessToken(pair.privatePem, claims(), pair.kid);
    const auth = jwtAuth({ publicPem: pair.publicPem, nowSec: 1_700_000_010 });
    expect(auth(`Bearer ${token}`)).toBe(true);
    expect(auth(undefined)).toBe(false);
    expect(auth('Basic x')).toBe(false);
    expect(auth('Bearer ')).toBe(false);
    expect(auth('Bearer not-a-jwt')).toBe(false);
  });
});
