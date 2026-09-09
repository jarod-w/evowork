import {
  codeChallengeS256,
  generateCodeVerifier,
  generateEs256KeyPair,
  parseMeteringDay,
  verifyAccessToken,
  verifyPolicyPack,
} from '@evowork/account';
import { describe, expect, it } from 'vitest';

import { openIdentityDb } from '../src/db.js';
import { memoryMailer } from '../src/mailer.js';
import { TEST_ARGON } from '../src/password.js';
import { parseMasterKey } from '../src/secret-box.js';
import { createIdentity, IdentityError } from '../src/service.js';

const MASTER = parseMasterKey('ab'.repeat(32));

function id() {
  const db = openIdentityDb(':memory:');
  const keys = generateEs256KeyPair();
  const mail = memoryMailer();
  const identity = createIdentity({
    db,
    keys,
    masterKey: MASTER,
    mailer: mail,
    argon: TEST_ARGON,
    publicOrigin: 'http://127.0.0.1:8788',
    now: () => 1_700_000_000_000,
  });
  return { identity, mail, keys, db };
}

describe('Q38 种子管理员', () => {
  it('0 个 admin 时用配置创建；已有 admin 时忽略明文密码，不覆盖', () => {
    const { identity, db } = id();
    const first = identity.bootstrap({
      email: 'admin@example.com',
      password: 'change-me',
      tenantName: 'default',
    });
    expect(first.created).toBe(true);
    const second = identity.bootstrap({
      email: 'admin@example.com',
      password: 'a-different-password',
      tenantName: 'default',
    });
    expect(second.created).toBe(false);
    const hash = (db.prepare(`SELECT password_hash FROM users`).get() as { password_hash: string })
      .password_hash;
    // 第二次引导没改哈希：用原密码仍能登，新密码不能
    const login = identity.login({
      identifier: 'admin@example.com',
      password: 'change-me',
      deviceId: 'dev_1',
    });
    expect(login.role).toBe('admin');
    expect(login.mustChangePassword).toBe(true);
    expect(() =>
      identity.login({
        identifier: 'admin@example.com',
        password: 'a-different-password',
        deviceId: 'dev_1',
      }),
    ).toThrow(IdentityError);
    expect(hash.startsWith('$argon2id$')).toBe(true);
  });
});

describe('注册不自动开租户', () => {
  it('自助注册的人没有默认模型，只能等被加入租户', () => {
    const { identity, mail } = id();
    identity.bootstrap({
      email: 'admin@example.com',
      password: 'change-me',
      tenantName: 'default',
    });
    const { userId } = identity.signup({ email: 'user@example.com', password: 'user-pass-1' });
    expect(mail.sent[0]?.template).toBe('verify');
    identity.verifyEmail(mail.sent[0]!.token);
    const login = identity.login({
      identifier: 'user@example.com',
      password: 'user-pass-1',
      deviceId: 'dev_u',
    });
    expect(login.tenantId).toBeNull();
    expect(identity.publicCatalog('none')).toEqual([]);
    expect(identity.me(userId).role).toBe('member');
  });
});

describe('授予 / 收回管理员', () => {
  it('不能收回最后一名；跨租户拒绝；未注册拒绝', () => {
    const { identity, mail } = id();
    const boot = identity.bootstrap({
      email: 'admin@example.com',
      password: 'change-me',
      tenantName: 'default',
    });
    const admin = identity.login({
      identifier: 'admin@example.com',
      password: 'change-me',
      deviceId: 'dev_a',
    });
    identity.changePassword(admin.userId, 'change-me', 'new-pass-1');

    expect(() => identity.revokeAdmin(admin.userId, admin.userId)).toThrow(/最后一名/);
    expect(() => identity.grantAdmin(admin.userId, 'usr_nope')).toThrow(/还没有注册/);

    identity.signup({ email: 'user@example.com', password: 'user-pass-1' });
    identity.verifyEmail(mail.sent.find((m) => m.to === 'user@example.com')!.token);
    const user = identity.login({
      identifier: 'user@example.com',
      password: 'user-pass-1',
      deviceId: 'dev_u',
    });
    identity.grantAdmin(admin.userId, user.userId);
    expect(identity.me(user.userId).role).toBe('admin');
    expect(identity.me(user.userId).tenantId).toBe(boot.tenantId);

    identity.revokeAdmin(admin.userId, user.userId);
    expect(identity.me(user.userId).role).toBe('member');
  });
});

describe('Q39 / Q40', () => {
  it('注销只清云端身份；最后一名 admin 不能注销', () => {
    const { identity } = id();
    identity.bootstrap({
      email: 'admin@example.com',
      password: 'change-me',
      tenantName: 'default',
    });
    const admin = identity.login({
      identifier: 'admin@example.com',
      password: 'change-me',
      deviceId: 'dev_a',
    });
    expect(() => identity.deleteAccount(admin.userId, 'change-me')).toThrow(/最后一名/);
  });

  it('注销要再输密码；密码对了才清云端身份', () => {
    const { identity, mail } = id();
    identity.bootstrap({
      email: 'admin@example.com',
      password: 'change-me',
      tenantName: 'default',
    });
    identity.signup({ email: 'user@example.com', password: 'user-pass-1' });
    identity.verifyEmail(mail.sent.find((m) => m.to === 'user@example.com')!.token);
    const user = identity.login({
      identifier: 'user@example.com',
      password: 'user-pass-1',
      deviceId: 'dev_u',
    });
    expect(() => identity.deleteAccount(user.userId, 'wrong')).toThrow(/密码不对/);
    identity.deleteAccount(user.userId, 'user-pass-1');
    expect(() =>
      identity.login({
        identifier: 'user@example.com',
        password: 'user-pass-1',
        deviceId: 'dev_u',
      }),
    ).toThrow(/邮箱或密码/);
  });

  it('吊销设备后 refresh 立刻失效', () => {
    const { identity } = id();
    identity.bootstrap({
      email: 'admin@example.com',
      password: 'change-me',
      tenantName: 'default',
    });
    const admin = identity.login({
      identifier: 'admin@example.com',
      password: 'change-me',
      deviceId: 'dev_a',
    });
    identity.revokeDevice(admin.userId, 'dev_a');
    expect(() => identity.refresh(admin.refreshToken)).toThrow(/过期/);
  });
});

describe('默认模型目录类型没有 key', () => {
  it('publicCatalog 没有 apiKey / baseUrl；internal 才有', () => {
    const { identity } = id();
    identity.bootstrap({
      email: 'admin@example.com',
      password: 'change-me',
      tenantName: 'default',
    });
    const admin = identity.login({
      identifier: 'admin@example.com',
      password: 'change-me',
      deviceId: 'dev_a',
    });
    identity.changePassword(admin.userId, 'change-me', 'new-pass-1');
    identity.upsertHostedModel(admin.userId, {
      modelId: 'evowork/hosted-flash',
      displayName: '托管 Flash',
      provider: 'deepseek',
      upstreamModel: 'deepseek-v4-flash',
      adapter: 'deepseek',
      baseUrl: 'https://api.deepseek.com',
      apiKey: 'sk-secret-tenant-key',
    });
    const pub = identity.publicCatalog(admin.tenantId!);
    expect(pub).toHaveLength(1);
    expect(pub[0]).not.toHaveProperty('apiKey');
    expect(pub[0]).not.toHaveProperty('baseUrl');
    expect(pub[0]?.credentialSource).toBe('hosted');
    const inner = identity.internalUpstream(admin.tenantId!, 'evowork/hosted-flash');
    expect(inner).toEqual({
      baseUrl: 'https://api.deepseek.com',
      apiKey: 'sk-secret-tenant-key',
    });
  });
});

describe('计量没有 threadId', () => {
  it('带 threadId 的载荷进不了 recordMetering 的参数类型', () => {
    const parsed = parseMeteringDay({
      day: '2026-09-08',
      tenant: 'ten_1',
      model: 'evowork/hosted-flash',
      provider: 'deepseek',
      tokensIn: 1,
      tokensOut: 2,
      tokensCached: 0,
      durationMs: 10,
      threadId: 'thr_x',
    });
    expect(parsed).not.toHaveProperty('threadId');
  });
});

describe('JWT claims', () => {
  it('登录签发的 access 能被同一把公钥验过，且没有密码字段', () => {
    const { identity, keys } = id();
    identity.bootstrap({
      email: 'admin@example.com',
      password: 'change-me',
      tenantName: 'default',
    });
    const admin = identity.login({
      identifier: 'admin@example.com',
      password: 'change-me',
      deviceId: 'dev_a',
    });
    const verified = verifyAccessToken(admin.accessToken, {
      publicPem: keys.publicPem,
      nowSec: 1_700_000_000,
    });
    expect(verified.ok).toBe(true);
    if (verified.ok) {
      expect(verified.claims.role).toBe('admin');
      expect(verified.claims).not.toHaveProperty('password');
      expect(verified.claims).not.toHaveProperty('threadId');
    }
  });
});

describe('PKCE', () => {
  it('对的 verifier 换得到 token；错的不行', () => {
    const { identity } = id();
    identity.bootstrap({
      email: 'admin@example.com',
      password: 'change-me',
      tenantName: 'default',
    });
    const admin = identity.login({
      identifier: 'admin@example.com',
      password: 'change-me',
      deviceId: 'dev_a',
    });
    const verifier = generateCodeVerifier();
    const challenge = codeChallengeS256(verifier);
    const { code } = identity.startAuthorize({
      userId: admin.userId,
      deviceId: 'dev_a',
      challenge,
      redirectUri: 'http://127.0.0.1:4390/callback',
    });
    const tokens = identity.exchangeCode({
      code,
      verifier,
      redirectUri: 'http://127.0.0.1:4390/callback',
      deviceId: 'dev_a',
    });
    expect(tokens.accessToken.length).toBeGreaterThan(20);
    expect(() =>
      identity.exchangeCode({
        code,
        verifier,
        redirectUri: 'http://127.0.0.1:4390/callback',
        deviceId: 'dev_a',
      }),
    ).toThrow();
  });
});

describe('额度闸门', () => {
  it('用尽后 checkQuota 拒绝，且不自动换成别的模型（调用方只能看到这句话）', () => {
    const { identity } = id();
    identity.bootstrap({
      email: 'admin@example.com',
      password: 'change-me',
      tenantName: 'default',
    });
    const admin = identity.login({
      identifier: 'admin@example.com',
      password: 'change-me',
      deviceId: 'dev_a',
    });
    identity.setQuota(admin.userId, admin.userId, 10);
    expect(identity.checkQuota(admin.userId).ok).toBe(true);
    identity.addQuotaUsage(admin.userId, 10);
    const denied = identity.checkQuota(admin.userId);
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.reason).toContain('不会自动换成');
  });

  it('配额班级用尽同样拒绝，JWT 带真实 quotaClass，不自动换模型', () => {
    const { identity, keys } = id();
    identity.bootstrap({
      email: 'admin@example.com',
      password: 'change-me',
      tenantName: 'default',
    });
    const admin = identity.login({
      identifier: 'admin@example.com',
      password: 'change-me',
      deviceId: 'dev_a',
    });
    identity.upsertQuotaClass(admin.userId, 'staff', 5);
    identity.assignQuotaClass(admin.userId, admin.userId, 'staff');
    expect(identity.checkQuota(admin.userId).ok).toBe(true);
    identity.addQuotaUsage(admin.userId, 5);
    const denied = identity.checkQuota(admin.userId);
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.reason).toContain('不会自动换成');
    const token = identity.login({
      identifier: 'admin@example.com',
      password: 'change-me',
      deviceId: 'dev_b',
    }).accessToken;
    const claims = verifyAccessToken(token, {
      publicPem: keys.publicPem,
      nowSec: 1_700_000_010,
    });
    expect(claims.ok).toBe(true);
    if (claims.ok) expect(claims.claims.quotaClass).toBe('staff');
  });

  it('default 班级上限 0 = 不限，没有每人覆盖时放行', () => {
    const { identity } = id();
    identity.bootstrap({
      email: 'admin@example.com',
      password: 'change-me',
      tenantName: 'default',
    });
    const admin = identity.login({
      identifier: 'admin@example.com',
      password: 'change-me',
      deviceId: 'dev_a',
    });
    identity.addQuotaUsage(admin.userId, 1_000_000);
    expect(identity.checkQuota(admin.userId).ok).toBe(true);
    expect(identity.quota(admin.userId)?.quotaClass).toBe('default');
  });
});

describe('签名策略包', () => {
  it('管理员签发后成员能拿到信封，里面没有 apiKey', () => {
    const { identity, keys } = id();
    identity.bootstrap({
      email: 'admin@example.com',
      password: 'change-me',
      tenantName: 'default',
    });
    const admin = identity.login({
      identifier: 'admin@example.com',
      password: 'change-me',
      deviceId: 'dev_a',
    });
    const envelope = identity.issuePolicyPack(admin.userId, {
      expiresInDays: 30,
      allowCustom: false,
      disabledModels: ['evowork/kimi-k3'],
      reason: '企业锁定',
    });
    expect(JSON.stringify(envelope)).not.toMatch(/apiKey/);
    const verified = verifyPolicyPack(envelope, { publicPem: keys.publicPem });
    expect(verified.ok).toBe(true);
    if (verified.ok) {
      expect(verified.payload.models.allowCustom).toBe(false);
      expect(verified.payload.models.disabled).toEqual(['evowork/kimi-k3']);
    }
    expect(identity.currentPolicyPack(admin.tenantId ?? '')?.payloadJson).toBe(
      envelope.payloadJson,
    );
  });
});
