import { describe, expect, it } from 'vitest';

import { ACCESS_CLAIM_KEYS, parseAccessClaims } from '../src/claims.js';

describe('AccessClaims 装不进内容', () => {
  it('允许的键正好是那八个，没有 threadId / password / email / name', () => {
    expect([...ACCESS_CLAIM_KEYS].sort()).toEqual(
      ['deviceId', 'exp', 'iat', 'quotaClass', 'role', 'scope', 'sub', 'tenant'].sort(),
    );
    expect(ACCESS_CLAIM_KEYS).not.toContain('threadId');
    expect(ACCESS_CLAIM_KEYS).not.toContain('password');
    expect(ACCESS_CLAIM_KEYS).not.toContain('email');
    expect(ACCESS_CLAIM_KEYS).not.toContain('name');
    expect(ACCESS_CLAIM_KEYS).not.toContain('prompt');
  });

  it('缺 tenant 就失败 —— 否则计量会落到错误的租户上', () => {
    expect(
      parseAccessClaims({
        sub: 'usr_1',
        exp: 1_800_000_000,
        iat: 1_700_000_000,
        scope: 'gateway',
        quotaClass: 'default',
        deviceId: 'dev_1',
        role: 'member',
      }),
    ).toBeUndefined();
  });

  it('多出来的键丢掉，不因此 401（旧 identity 加 optional 键时网关仍能验）', () => {
    const claims = parseAccessClaims({
      sub: 'usr_1',
      tenant: 'ten_1',
      exp: 1_800_000_000,
      iat: 1_700_000_000,
      scope: 'gateway',
      quotaClass: 'default',
      deviceId: 'dev_1',
      role: 'admin',
      threadId: 'thr_should_be_dropped',
      displayName: '不该进来',
    });
    expect(claims).toEqual({
      sub: 'usr_1',
      tenant: 'ten_1',
      exp: 1_800_000_000,
      iat: 1_700_000_000,
      scope: 'gateway',
      quotaClass: 'default',
      deviceId: 'dev_1',
      role: 'admin',
    });
    expect(claims).not.toHaveProperty('threadId');
  });

  it('role 不是 member/admin 就失败 —— 自由字符串能装内容', () => {
    expect(
      parseAccessClaims({
        sub: 'usr_1',
        tenant: 'ten_1',
        exp: 1_800_000_000,
        iat: 1_700_000_000,
        scope: 'gateway',
        quotaClass: 'default',
        deviceId: 'dev_1',
        role: 'super-admin with a title',
      }),
    ).toBeUndefined();
  });
});
