/**
 * 11 §13.10 B' 的四件新事：邀请 · 吊销其他全部设备 · 策略包生效面 · 额度提醒。
 *
 * 断言写的是**后果**：撤回之后旧链接还能用意味着"撤回"是假的；
 * 提醒不去重意味着每次调用都发一封；生效面把没拉过的设备算成已生效意味着
 * 管理员会以为策略已经生效。
 */
import { generateEs256KeyPair } from '@evowork/account';
import { describe, expect, it } from 'vitest';

import { openIdentityDb } from '../src/db.js';
import { isTokenMail, memoryMailer, type MailMessage } from '../src/mailer.js';
import { TEST_ARGON } from '../src/password.js';
import { parseMasterKey } from '../src/secret-box.js';
import { createIdentity, IdentityError } from '../src/service.js';

const MASTER = parseMasterKey('ab'.repeat(32));
const T0 = 1_700_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

function harness() {
  const db = openIdentityDb(':memory:');
  const mail = memoryMailer();
  let clock = T0;
  const identity = createIdentity({
    db,
    keys: generateEs256KeyPair(),
    masterKey: MASTER,
    mailer: mail,
    argon: TEST_ARGON,
    publicOrigin: 'http://127.0.0.1:8788',
    now: () => clock,
  });
  const admin = identity.bootstrap({
    email: 'admin@example.com',
    password: 'change-me',
    tenantName: '示例科技',
  });
  return {
    db,
    mail,
    identity,
    tenantId: admin.tenantId,
    adminId: (
      db.prepare(`SELECT id FROM users WHERE email = 'admin@example.com'`).get() as {
        id: string;
      }
    ).id,
    advance(ms: number) {
      clock += ms;
    },
  };
}

function tokenOf(mail: { readonly sent: MailMessage[] }, index = -1): string {
  const invites = mail.sent.filter(isTokenMail).filter((m) => m.template === 'invite');
  const picked = invites.at(index);
  if (!picked) throw new Error('没有发出邀请邮件');
  return picked.token;
}

describe('成员邀请', () => {
  it('邀请未注册的人：邮件带 token，接受时必须给密码，接受后直接算邮箱已验证', () => {
    const h = harness();
    const invite = h.identity.createInvite(h.adminId, { email: 'zhang.wei@example.com' });
    expect(invite.email).toBe('zhang.wei@example.com');
    expect(invite.role).toBe('member');

    const token = tokenOf(h.mail);
    const info = h.identity.inviteInfo(token);
    expect(info.registered).toBe(false);
    expect(info.tenantName).toBe('示例科技');

    // 没密码不能接受 —— 否则会建出一个谁都能登的空密码账号
    expect(() => h.identity.acceptInvite(token)).toThrow(IdentityError);
    try {
      h.identity.acceptInvite(token);
    } catch (err) {
      expect((err as IdentityError).code).toBe('needs-password');
    }

    const out = h.identity.acceptInvite(token, 'a-real-password');
    const user = h.db.prepare(`SELECT email_verified FROM users WHERE id = ?`).get(out.userId) as {
      email_verified: number;
    };
    // 能点开这封信本身就证明了对邮箱的控制权，不必再发一封验证信
    expect(user.email_verified).toBe(1);
    expect(h.identity.listMembers(h.adminId).map((m) => m.email)).toContain(
      'zhang.wei@example.com',
    );
  });

  it('邀请已注册但没验过邮箱的人：不碰密码，加进租户，并且顺手把邮箱算作已验证', () => {
    const h = harness();
    h.identity.signup({ email: 'liu.yang@example.com', password: 'already-mine' });
    const invite = h.identity.createInvite(h.adminId, { email: 'liu.yang@example.com' });
    expect(invite.id).toBeTruthy();
    const token = tokenOf(h.mail);
    expect(h.identity.inviteInfo(token).registered).toBe(true);

    h.identity.acceptInvite(token);
    // 不翻 email_verified 的话，这里会出现一个管理员看得到、本人却登不进的成员
    expect(
      (
        h.db
          .prepare(`SELECT email_verified FROM users WHERE email = 'liu.yang@example.com'`)
          .get() as { email_verified: number }
      ).email_verified,
    ).toBe(1);
    // 接受邀请不改密码：原密码仍然能登
    expect(
      h.identity.login({
        identifier: 'liu.yang@example.com',
        password: 'already-mine',
        deviceId: 'dev_x',
      }).role,
    ).toBe('member');
  });

  it('重发换掉 token：旧链接立刻失效，否则「撤回」形同虚设', () => {
    const h = harness();
    const invite = h.identity.createInvite(h.adminId, { email: 'a@example.com' });
    const first = tokenOf(h.mail);
    h.identity.resendInvite(h.adminId, invite.id);
    const second = tokenOf(h.mail);
    expect(second).not.toBe(first);
    expect(() => h.identity.inviteInfo(first)).toThrow(IdentityError);
    expect(h.identity.inviteInfo(second).email).toBe('a@example.com');
  });

  it('撤回之后链接不能再用，且不再出现在待接受列表里', () => {
    const h = harness();
    const invite = h.identity.createInvite(h.adminId, { email: 'b@example.com' });
    const token = tokenOf(h.mail);
    expect(h.identity.listInvites(h.adminId)).toHaveLength(1);
    h.identity.revokeInvite(h.adminId, invite.id);
    expect(h.identity.listInvites(h.adminId)).toHaveLength(0);
    expect(() => h.identity.acceptInvite(token, 'pw')).toThrow(IdentityError);
  });

  it('过期的邀请说「让管理员重发」，不是含糊的「无效」', () => {
    const h = harness();
    h.identity.createInvite(h.adminId, { email: 'c@example.com' });
    const token = tokenOf(h.mail);
    h.advance(8 * DAY);
    try {
      h.identity.inviteInfo(token);
      throw new Error('过期的邀请不该还能用');
    } catch (err) {
      expect((err as IdentityError).code).toBe('expired');
      expect((err as IdentityError).message).toContain('重发');
    }
  });

  it('已经是本租户成员、或有未接受的邀请时，不重复发', () => {
    const h = harness();
    h.identity.createInvite(h.adminId, { email: 'd@example.com' });
    expect(() => h.identity.createInvite(h.adminId, { email: 'd@example.com' })).toThrow(
      IdentityError,
    );
    expect(() => h.identity.createInvite(h.adminId, { email: 'admin@example.com' })).toThrow(
      IdentityError,
    );
  });

  it('邀请动作进身份面审计，且审计里只有邮箱，没有任何内容面字段', () => {
    const h = harness();
    h.identity.createInvite(h.adminId, { email: 'e@example.com' });
    const events = h.identity.listAudit(h.adminId);
    const invited = events.find((row) => row.action === 'invite-member');
    expect(invited?.targetRef).toBe('e@example.com');
    expect(JSON.stringify(events)).not.toMatch(/thread|artifact|prompt|cwd/i);
  });
});

describe('Q40 吊销其他全部设备', () => {
  it('留下当前这台，其余设备与它们的 refresh 全部作废', () => {
    const h = harness();
    h.identity.login({ identifier: 'admin@example.com', password: 'change-me', deviceId: 'here' });
    const away = h.identity.login({
      identifier: 'admin@example.com',
      password: 'change-me',
      deviceId: 'cafe',
    });
    const out = h.identity.revokeOtherDevices(h.adminId, 'here');
    expect(out.revoked).toBe(1);

    const devices = h.identity.listDevices(h.adminId);
    expect(devices.find((d) => d.id === 'here')?.revoked).toBe(false);
    expect(devices.find((d) => d.id === 'cafe')?.revoked).toBe(true);
    // 被吊销那台手里的 refresh 立刻换不到 access —— 否则"吊销"只是列表上的一个字
    expect(() => h.identity.refresh(away.refreshToken)).toThrow(IdentityError);
  });
});

describe('策略包生效面', () => {
  it('签发之后没有设备算已拉取；拉过之后才计入', () => {
    const h = harness();
    h.identity.login({ identifier: 'admin@example.com', password: 'change-me', deviceId: 'mac' });
    h.identity.login({ identifier: 'admin@example.com', password: 'change-me', deviceId: 'win' });
    h.identity.issuePolicyPack(h.adminId, {
      expiresInDays: 30,
      disabledModels: [],
      allowCustom: false,
    });

    const before = h.identity.policyReach(h.adminId);
    expect(before.total).toBe(2);
    // 「已签发」不等于「已生效」：一台都还没来拉
    expect(before.pulled).toBe(0);
    expect(before.stale.map((d) => d.deviceId).sort()).toEqual(['mac', 'win']);

    const packId = h.identity.currentPolicyPackId(h.tenantId);
    h.identity.markPolicyPulled('mac', packId);
    const after = h.identity.policyReach(h.adminId);
    expect(after.pulled).toBe(1);
    expect(after.stale.map((d) => d.deviceId)).toEqual(['win']);
  });

  it('重新签发之后，拿着旧包的设备重新算作没拉过', () => {
    const h = harness();
    h.identity.login({ identifier: 'admin@example.com', password: 'change-me', deviceId: 'mac' });
    h.identity.issuePolicyPack(h.adminId, {
      expiresInDays: 30,
      disabledModels: [],
      allowCustom: true,
    });
    h.identity.markPolicyPulled('mac', h.identity.currentPolicyPackId(h.tenantId));
    expect(h.identity.policyReach(h.adminId).pulled).toBe(1);

    h.advance(1000);
    h.identity.issuePolicyPack(h.adminId, {
      expiresInDays: 30,
      disabledModels: ['glm-5.3-flash'],
      allowCustom: false,
    });
    expect(h.identity.policyReach(h.adminId).pulled).toBe(0);
  });

  it('生效面只给设备身份，不给它在做什么', () => {
    const h = harness();
    h.identity.login({ identifier: 'admin@example.com', password: 'change-me', deviceId: 'mac' });
    h.identity.issuePolicyPack(h.adminId, {
      expiresInDays: 30,
      disabledModels: [],
      allowCustom: true,
    });
    const reach = h.identity.policyReach(h.adminId);
    expect(JSON.stringify(reach)).not.toMatch(/thread|artifact|prompt|cwd|workspace/i);
  });
});

describe('额度提醒', () => {
  function withQuota() {
    const h = harness();
    h.identity.signup({ email: 'member@example.com', password: 'pw-member' });
    const memberId = (
      h.db.prepare(`SELECT id FROM users WHERE email = 'member@example.com'`).get() as {
        id: string;
      }
    ).id;
    h.identity.addMember(h.adminId, memberId);
    h.identity.setQuota(h.adminId, memberId, 1000);
    h.mail.sent.length = 0;
    return { ...h, memberId };
  }

  it('到阈值发一封给本人，同一期不再发第二封', () => {
    const h = withQuota();
    h.identity.addQuotaUsage(h.memberId, 700);
    expect(h.mail.sent).toHaveLength(0);

    h.identity.addQuotaUsage(h.memberId, 150); // 850 / 1000 = 85% ≥ 80%
    const warn = h.mail.sent.filter((m) => m.template === 'quota-warn');
    expect(warn).toHaveLength(1);
    expect(warn[0]?.to).toBe('member@example.com');

    h.identity.addQuotaUsage(h.memberId, 10);
    expect(h.mail.sent.filter((m) => m.template === 'quota-warn')).toHaveLength(1);
  });

  it('用尽时通知本人，并汇总给管理员', () => {
    const h = withQuota();
    h.identity.addQuotaUsage(h.memberId, 1000);
    const done = h.mail.sent.filter((m) => m.template === 'quota-exhausted');
    expect(done.map((m) => m.to).sort()).toEqual(['admin@example.com', 'member@example.com']);
    const toAdmin = done.find((m) => m.to === 'admin@example.com');
    expect(toAdmin && 'subject' in toAdmin ? toAdmin.subject : undefined).toBe(
      'member@example.com',
    );
  });

  it('本人关掉提醒后不再收到，但管理员那条汇总还在', () => {
    const h = withQuota();
    h.identity.setWarnOptOut(h.memberId, true);
    expect(h.identity.warnOptOut(h.memberId)).toBe(true);
    h.identity.addQuotaUsage(h.memberId, 1000);
    expect(h.mail.sent.map((m) => m.to)).toEqual(['admin@example.com']);
  });

  it('管理员关掉租户开关后，成员的阈值提醒不发', () => {
    const h = withQuota();
    h.identity.setTenantSettings(h.adminId, { warnMember: false });
    h.identity.addQuotaUsage(h.memberId, 900);
    expect(h.mail.sent.filter((m) => m.template === 'quota-warn')).toHaveLength(0);
  });

  it('不限额度（limit = 0）的人永远不触发提醒', () => {
    const h = withQuota();
    h.identity.setQuota(h.adminId, h.memberId, 0);
    h.identity.addQuotaUsage(h.memberId, 10_000_000);
    expect(h.mail.sent).toHaveLength(0);
  });

  it('提醒邮件里只有数字，没有任务 / 产物 / prompt（K6 · Q14 的同一条纪律）', () => {
    const h = withQuota();
    h.identity.addQuotaUsage(h.memberId, 1000);
    for (const message of h.mail.sent) {
      expect(isTokenMail(message)).toBe(false);
      expect(Object.keys(message).sort()).not.toContain('body');
      expect(JSON.stringify(message)).not.toMatch(/thread|artifact|prompt|cwd/i);
    }
  });

  it('阈值只接受 1–99，越界要报错而不是静默改成别的值', () => {
    const h = harness();
    expect(() => h.identity.setTenantSettings(h.adminId, { warnPercent: 0 })).toThrow(
      IdentityError,
    );
    expect(() => h.identity.setTenantSettings(h.adminId, { warnPercent: 100 })).toThrow(
      IdentityError,
    );
    expect(h.identity.setTenantSettings(h.adminId, { warnPercent: 60 }).warnPercent).toBe(60);
  });
});
