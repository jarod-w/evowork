/**
 * identity 用例。HTTP 层只做路由，决策都在这里，所以测试可以不起服务器。
 */
import {
  ACCESS_TTL_SEC,
  POLICY_PACK_SCHEMA_VER,
  REFRESH_TTL_SEC,
  parsePolicyPackPayload,
  signAccessToken,
  signPolicyPack,
  verifyCodeChallenge,
  type AccessClaims,
  type Es256KeyPair,
  type PolicyPackEnvelope,
  type Role,
} from '@evowork/account';

import type { BootstrapConfig } from './config.js';
import type { SqliteLike } from './db.js';
import { newId, randomSecret, sha256Hex } from './ids.js';
import type { Mailer } from './mailer.js';
import { hashPassword, verifyPassword, type ArgonParams } from './password.js';
import { decryptSecret, encryptSecret } from './secret-box.js';

const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILS = 5;
const AUTH_CODE_TTL_MS = 5 * 60 * 1000;
const EMAIL_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
/** 邀请链接的有效期。短到过期了要重发，长到够一个假期。 */
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export type IdentityErrorCode =
  | 'invalid-credentials'
  | 'locked'
  | 'unverified'
  | 'must-change-password'
  | 'not-found'
  | 'conflict'
  | 'forbidden'
  | 'last-admin'
  | 'other-tenant'
  | 'not-registered'
  | 'bad-challenge'
  | 'expired'
  | 'invalid-redirect'
  | 'no-sms'
  | 'needs-password'
  | 'invalid';

export class IdentityError extends Error {
  override readonly name = 'IdentityError';
  constructor(
    readonly code: IdentityErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface IdentityDeps {
  readonly db: SqliteLike;
  readonly keys: Es256KeyPair;
  readonly masterKey: Buffer;
  readonly mailer: Mailer;
  readonly argon: ArgonParams;
  readonly now?: () => number;
  readonly publicOrigin: string;
}

interface UserRow {
  id: string;
  email: string | null;
  phone: string | null;
  password_hash: string;
  email_verified: number;
  must_change_password: number;
}

interface MembershipRow {
  user_id: string;
  tenant_id: string;
  role: Role;
  quota_class: string;
  warn_opt_out?: number;
}

export function createIdentity(deps: IdentityDeps) {
  const now = () => deps.now?.() ?? Date.now();

  function adminCount(tenantId: string): number {
    const row = deps.db
      .prepare(`SELECT COUNT(*) AS n FROM memberships WHERE tenant_id = ? AND role = 'admin'`)
      .get(tenantId) as { n: number };
    return Number(row.n);
  }

  function findUserByIdentifier(identifier: string): UserRow | undefined {
    return deps.db
      .prepare(`SELECT * FROM users WHERE email = ? OR phone = ?`)
      .get(identifier, identifier) as UserRow | undefined;
  }

  function membership(userId: string): MembershipRow | undefined {
    return deps.db
      .prepare(
        `SELECT user_id, tenant_id, role, quota_class, warn_opt_out FROM memberships WHERE user_id = ?`,
      )
      .get(userId) as MembershipRow | undefined;
  }

  function effectiveQuota(userId: string): { used: number; limit: number } | undefined {
    const mem = membership(userId);
    if (!mem) return undefined;
    const row = deps.db
      .prepare(
        `SELECT tokens_used, tokens_limit, quota_override
         FROM quota_accounts WHERE tenant_id = ? AND user_id = ?`,
      )
      .get(mem.tenant_id, userId) as
      { tokens_used: number; tokens_limit: number; quota_override: number } | undefined;
    const classRow = deps.db
      .prepare(`SELECT tokens_limit FROM quota_classes WHERE tenant_id = ? AND name = ?`)
      .get(mem.tenant_id, mem.quota_class || 'default') as { tokens_limit: number } | undefined;
    const classLimit = classRow?.tokens_limit ?? 0;
    const used = row?.tokens_used ?? 0;
    const limit = row && Number(row.quota_override) === 1 ? row.tokens_limit : classLimit;
    return { used, limit };
  }

  /**
   * 计费周期键。额度提醒每期只发一次，换期自动可再发。
   *
   * 口径与 `quota_accounts.tokens_used` 一致：那一列是**当期累计**，
   * 换期由运维清零。这里只需要一个"同一期里别重复发"的键，所以取 UTC 月份就够。
   */
  function periodKey(at: number): string {
    return new Date(at).toISOString().slice(0, 7);
  }

  function tenantSettingsRow(tenantId: string): {
    warn_member: number;
    warn_percent: number;
    warn_admin: number;
  } {
    const row = deps.db
      .prepare(
        `SELECT warn_member, warn_percent, warn_admin FROM tenant_settings WHERE tenant_id = ?`,
      )
      .get(tenantId) as
      { warn_member: number; warn_percent: number; warn_admin: number } | undefined;
    if (row) return row;
    deps.db
      .prepare(
        `INSERT OR IGNORE INTO tenant_settings (tenant_id, warn_member, warn_percent, warn_admin)
         VALUES (?, 1, 80, 1)`,
      )
      .run(tenantId);
    return { warn_member: 1, warn_percent: 80, warn_admin: 1 };
  }

  /** 这一期里这条提醒发过没有。发过返回 false，没发过就**占位并返回 true**。 */
  function claimNotice(tenantId: string, userId: string, kind: 'warn' | 'exhausted'): boolean {
    const period = periodKey(now());
    const seen = deps.db
      .prepare(
        `SELECT 1 AS hit FROM quota_notices
         WHERE tenant_id = ? AND user_id = ? AND kind = ? AND period = ?`,
      )
      .get(tenantId, userId, kind, period) as { hit: number } | undefined;
    if (seen) return false;
    deps.db
      .prepare(
        `INSERT INTO quota_notices (tenant_id, user_id, kind, period, sent_at) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(tenantId, userId, kind, period, now());
    return true;
  }

  function adminEmails(tenantId: string): readonly string[] {
    const rows = deps.db
      .prepare(
        `SELECT u.email FROM memberships m JOIN users u ON u.id = m.user_id
         WHERE m.tenant_id = ? AND m.role = 'admin' AND u.email IS NOT NULL`,
      )
      .all(tenantId) as { email: string }[];
    return rows.map((row) => row.email);
  }

  /**
   * 额度提醒（11 §13.10 B'）。**用尽不会自动换便宜模型（Q11），所以必须提前说**——
   * 否则用户的第一感知是任务跑一半停住。
   *
   * 邮件里只有 used / limit 两个数字，没有任务、产物或 prompt。
   */
  function maybeWarnQuota(tenantId: string, userId: string): void {
    const q = effectiveQuota(userId);
    if (!q || q.limit <= 0) return;
    const settings = tenantSettingsRow(tenantId);
    const user = deps.db.prepare(`SELECT email FROM users WHERE id = ?`).get(userId) as
      { email: string | null } | undefined;
    const mem = membership(userId);
    const optedOut = Number(mem?.warn_opt_out ?? 0) === 1;

    if (q.used >= q.limit) {
      if (!claimNotice(tenantId, userId, 'exhausted')) return;
      if (user?.email && !optedOut) {
        void deps.mailer.send({
          to: user.email,
          template: 'quota-exhausted',
          used: q.used,
          limit: q.limit,
        });
      }
      if (settings.warn_admin === 1) {
        for (const to of adminEmails(tenantId)) {
          void deps.mailer.send({
            to,
            template: 'quota-exhausted',
            used: q.used,
            limit: q.limit,
            ...(user?.email ? { subject: user.email } : {}),
          });
        }
      }
      return;
    }

    if (settings.warn_member !== 1 || optedOut || !user?.email) return;
    if (q.used * 100 < q.limit * settings.warn_percent) return;
    if (!claimNotice(tenantId, userId, 'warn')) return;
    void deps.mailer.send({
      to: user.email,
      template: 'quota-warn',
      used: q.used,
      limit: q.limit,
    });
  }

  function tenantName(tenantId: string): string {
    const row = deps.db.prepare(`SELECT name FROM tenants WHERE id = ?`).get(tenantId) as
      { name: string } | undefined;
    return row?.name ?? tenantId;
  }

  function inviteView(id: string): AdminInvite {
    const row = deps.db
      .prepare(
        `SELECT i.id, i.email, i.role, i.quota_class, i.created_at, i.expires_at,
                u.email AS by_email
         FROM invites i LEFT JOIN users u ON u.id = i.invited_by
         WHERE i.id = ?`,
      )
      .get(id) as {
      id: string;
      email: string;
      role: Role;
      quota_class: string;
      created_at: number;
      expires_at: number;
      by_email: string | null;
    };
    return {
      id: row.id,
      email: row.email,
      role: row.role,
      quotaClass: row.quota_class || 'default',
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      ...(row.by_email ? { invitedByEmail: row.by_email } : {}),
    };
  }

  interface InviteRow {
    id: string;
    tenant_id: string;
    email: string;
    role: Role;
    quota_class: string;
    invited_by: string;
    expires_at: number;
    accepted_at: number | null;
    revoked_at: number | null;
  }

  function requireLiveInvite(token: string): InviteRow {
    const row = deps.db
      .prepare(
        `SELECT id, tenant_id, email, role, quota_class, invited_by, expires_at, accepted_at, revoked_at
         FROM invites WHERE token_hash = ?`,
      )
      .get(sha256Hex(token)) as InviteRow | undefined;
    if (!row || row.revoked_at !== null) {
      throw new IdentityError('not-found', '邀请链接无效或已被撤回。');
    }
    if (row.accepted_at !== null) throw new IdentityError('conflict', '这条邀请已经被接受了。');
    if (row.expires_at < now())
      throw new IdentityError('expired', '邀请链接已过期，请让管理员重发。');
    return row;
  }

  function requireAdmin(actorId: string): MembershipRow {
    const actor = membership(actorId);
    if (actor?.role !== 'admin') {
      throw new IdentityError('forbidden', '只有管理员能做这个操作。');
    }
    return actor;
  }

  function recordAudit(
    actorId: string,
    action: IdentityAuditAction,
    extras?: { readonly targetUserId?: string; readonly targetRef?: string },
  ): void {
    deps.db
      .prepare(
        `INSERT INTO identity_audit (id, at, actor_user_id, action, target_user_id, target_ref)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        newId('aud'),
        now(),
        actorId,
        action,
        extras?.targetUserId ?? null,
        extras?.targetRef ?? null,
      );
  }

  function packRowToView(row: {
    id: string;
    payload_json: string;
    kid: string;
    issued_at: number;
    expires_at: number;
    revoked_at: number | null;
    actor_email: string | null;
    actor_phone: string | null;
  }): AdminPolicyPackView {
    const payload = parsePolicyPackPayload(row.payload_json);
    return {
      id: row.id,
      kid: row.kid,
      issuedAt: row.issued_at,
      expiresAt: row.expires_at,
      ...(payload?.graceUntil !== undefined ? { graceUntil: payload.graceUntil } : {}),
      disabledModels: payload?.models.disabled ?? [],
      disabledProfiles: payload?.disabledProfiles ?? [],
      allowCustom: payload?.models.allowCustom ?? true,
      ...(payload?.models.reason ? { reason: payload.models.reason } : {}),
      allowManagedHooksOnly: payload?.allowManagedHooksOnly ?? false,
      disableShare: payload?.disableShare ?? false,
      disableSlots: payload?.disableSlots ?? false,
      forceAudit: payload?.forceAudit ?? false,
      revoked: row.revoked_at !== null,
      ...(row.actor_email ? { actorEmail: row.actor_email } : {}),
      ...(row.actor_phone ? { actorPhone: row.actor_phone } : {}),
    };
  }

  function issueAccess(user: UserRow, deviceId: string, role: Role, tenant: string): string {
    const iat = Math.floor(now() / 1000);
    const claims: AccessClaims = {
      sub: user.id,
      tenant,
      iat,
      exp: iat + ACCESS_TTL_SEC,
      scope: 'gateway',
      quotaClass: membership(user.id)?.quota_class ?? 'default',
      deviceId,
      role,
    };
    return signAccessToken(deps.keys.privatePem, claims, deps.keys.kid);
  }

  function issueRefresh(userId: string, deviceId: string): string {
    const raw = randomSecret();
    deps.db
      .prepare(
        `INSERT INTO refresh_tokens (id, user_id, device_id, token_hash, expires_at, revoked_at)
       VALUES (?, ?, ?, ?, ?, NULL)`,
      )
      .run(newId('rt'), userId, deviceId, sha256Hex(raw), now() + REFRESH_TTL_SEC * 1000);
    return raw;
  }

  function touchDevice(
    userId: string,
    deviceId: string,
    meta: { name?: string; platform?: string },
  ): void {
    const existing = deps.db.prepare(`SELECT id FROM devices WHERE id = ?`).get(deviceId) as
      { id: string } | undefined;
    if (existing) {
      deps.db
        .prepare(`UPDATE devices SET last_seen_at = ?, revoked_at = NULL WHERE id = ?`)
        .run(now(), deviceId);
      return;
    }
    deps.db
      .prepare(
        `INSERT INTO devices (id, user_id, name, platform, last_seen_at, revoked_at)
       VALUES (?, ?, ?, ?, ?, NULL)`,
      )
      .run(deviceId, userId, meta.name ?? 'device', meta.platform ?? 'unknown', now());
  }

  function failLogin(identifier: string): never {
    deps.db
      .prepare(`INSERT INTO login_attempts (identifier, at, ok) VALUES (?, ?, 0)`)
      .run(identifier, now());
    throw new IdentityError('invalid-credentials', '邮箱或密码不对。');
  }

  function locked(identifier: string): boolean {
    const since = now() - LOGIN_WINDOW_MS;
    const row = deps.db
      .prepare(
        `SELECT COUNT(*) AS n FROM login_attempts WHERE identifier = ? AND at >= ? AND ok = 0`,
      )
      .get(identifier, since) as { n: number };
    return Number(row.n) >= LOGIN_MAX_FAILS;
  }

  return {
    /**
     * Q38：库里 0 个 admin 时才消费明文密码。已有 admin 时忽略，不重置。
     */
    bootstrap(config: BootstrapConfig): { created: boolean; tenantId: string } {
      const existing = deps.db
        .prepare(`SELECT tenant_id FROM memberships WHERE role = 'admin' LIMIT 1`)
        .get() as { tenant_id: string } | undefined;
      if (existing) {
        return { created: false, tenantId: existing.tenant_id };
      }
      if (!config.password || (!config.email && !config.phone)) {
        throw new IdentityError('not-found', '引导配置缺少密码，以及邮箱或手机号。');
      }
      const tenantId = newId('ten');
      deps.db
        .prepare(`INSERT INTO tenants (id, name, created_at) VALUES (?, ?, ?)`)
        .run(tenantId, config.tenantName, now());
      const userId = newId('usr');
      deps.db
        .prepare(
          `INSERT INTO users (id, email, phone, password_hash, email_verified, must_change_password, created_at)
         VALUES (?, ?, ?, ?, 1, 1, ?)`,
        )
        .run(
          userId,
          config.email ?? null,
          config.phone ?? null,
          hashPassword(config.password, deps.argon),
          now(),
        );
      deps.db
        .prepare(
          `INSERT INTO memberships (user_id, tenant_id, role, created_at) VALUES (?, ?, 'admin', ?)`,
        )
        .run(userId, tenantId, now());
      deps.db
        .prepare(
          `INSERT OR IGNORE INTO quota_classes (tenant_id, name, tokens_limit) VALUES (?, 'default', 0)`,
        )
        .run(tenantId);
      return { created: true, tenantId };
    },

    signup(input: { email: string; password: string }): { userId: string } {
      if (findUserByIdentifier(input.email)) {
        throw new IdentityError('conflict', '这个邮箱已经注册过。');
      }
      const userId = newId('usr');
      deps.db
        .prepare(
          `INSERT INTO users (id, email, phone, password_hash, email_verified, must_change_password, created_at)
         VALUES (?, ?, NULL, ?, 0, 0, ?)`,
        )
        .run(userId, input.email, hashPassword(input.password, deps.argon), now());
      const token = randomSecret();
      deps.db
        .prepare(
          `INSERT INTO email_tokens (id, user_id, purpose, token_hash, expires_at, consumed_at)
         VALUES (?, ?, 'verify', ?, ?, NULL)`,
        )
        .run(newId('em'), userId, sha256Hex(token), now() + EMAIL_TOKEN_TTL_MS);
      void deps.mailer.send({ to: input.email, template: 'verify', token });
      return { userId };
    },

    verifyEmail(token: string): void {
      const row = deps.db
        .prepare(
          `SELECT id, user_id, expires_at, consumed_at FROM email_tokens WHERE token_hash = ? AND purpose = 'verify'`,
        )
        .get(sha256Hex(token)) as
        { id: string; user_id: string; expires_at: number; consumed_at: number | null } | undefined;
      if (!row || row.consumed_at !== null) throw new IdentityError('not-found', '验证链接无效。');
      if (row.expires_at < now()) throw new IdentityError('expired', '验证链接已过期。');
      deps.db.prepare(`UPDATE email_tokens SET consumed_at = ? WHERE id = ?`).run(now(), row.id);
      deps.db.prepare(`UPDATE users SET email_verified = 1 WHERE id = ?`).run(row.user_id);
    },

    requestPasswordReset(email: string): void {
      const user = findUserByIdentifier(email);
      // 不暴露「这个邮箱在不在」—— 没用户也假装发出去了
      if (!user?.email) return;
      const token = randomSecret();
      deps.db
        .prepare(
          `INSERT INTO email_tokens (id, user_id, purpose, token_hash, expires_at, consumed_at)
         VALUES (?, ?, 'reset', ?, ?, NULL)`,
        )
        .run(newId('em'), user.id, sha256Hex(token), now() + EMAIL_TOKEN_TTL_MS);
      void deps.mailer.send({ to: user.email, template: 'reset', token });
    },

    resetPassword(token: string, next: string): void {
      const row = deps.db
        .prepare(
          `SELECT id, user_id, expires_at, consumed_at FROM email_tokens WHERE token_hash = ? AND purpose = 'reset'`,
        )
        .get(sha256Hex(token)) as
        { id: string; user_id: string; expires_at: number; consumed_at: number | null } | undefined;
      if (!row || row.consumed_at !== null) throw new IdentityError('not-found', '重置链接无效。');
      if (row.expires_at < now()) throw new IdentityError('expired', '重置链接已过期。');
      deps.db.prepare(`UPDATE email_tokens SET consumed_at = ? WHERE id = ?`).run(now(), row.id);
      deps.db
        .prepare(`UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?`)
        .run(hashPassword(next, deps.argon), row.user_id);
    },

    changePassword(userId: string, current: string, next: string): void {
      const user = deps.db.prepare(`SELECT * FROM users WHERE id = ?`).get(userId) as
        UserRow | undefined;
      if (!user || !verifyPassword(current, user.password_hash)) {
        throw new IdentityError('invalid-credentials', '当前密码不对。');
      }
      deps.db
        .prepare(`UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?`)
        .run(hashPassword(next, deps.argon), userId);
    },

    login(input: {
      identifier: string;
      password: string;
      deviceId: string;
      deviceName?: string;
      platform?: string;
    }): {
      userId: string;
      accessToken: string;
      refreshToken: string;
      mustChangePassword: boolean;
      role: Role;
      tenantId: string | null;
    } {
      if (locked(input.identifier)) {
        throw new IdentityError('locked', '尝试次数过多，请稍后再试。');
      }
      const user = findUserByIdentifier(input.identifier);
      if (!user || !verifyPassword(input.password, user.password_hash)) failLogin(input.identifier);
      if (!user.email_verified) {
        throw new IdentityError('unverified', '请先验证邮箱。');
      }
      deps.db
        .prepare(`INSERT INTO login_attempts (identifier, at, ok) VALUES (?, ?, 1)`)
        .run(input.identifier, now());
      const mem = membership(user.id);
      const role: Role = mem?.role ?? 'member';
      const tenantId = mem?.tenant_id ?? null;
      touchDevice(user.id, input.deviceId, {
        ...(input.deviceName !== undefined ? { name: input.deviceName } : {}),
        ...(input.platform !== undefined ? { platform: input.platform } : {}),
      });
      return {
        userId: user.id,
        accessToken: issueAccess(user, input.deviceId, role, tenantId ?? 'none'),
        refreshToken: issueRefresh(user.id, input.deviceId),
        mustChangePassword: user.must_change_password === 1,
        role,
        tenantId,
      };
    },

    createSession(userId: string): string {
      const id = randomSecret();
      deps.db
        .prepare(`INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)`)
        .run(id, userId, now() + SESSION_TTL_MS);
      return id;
    },

    userIdFromSession(sessionId: string): string | undefined {
      const row = deps.db
        .prepare(`SELECT user_id, expires_at FROM sessions WHERE id = ?`)
        .get(sessionId) as { user_id: string; expires_at: number } | undefined;
      if (!row || row.expires_at < now()) return undefined;
      return row.user_id;
    },

    startAuthorize(input: {
      userId: string;
      deviceId: string;
      challenge: string;
      redirectUri: string;
    }): { code: string } {
      if (!input.redirectUri.startsWith('http://127.0.0.1:')) {
        throw new IdentityError('invalid-redirect', '桌面登录只能回调到本机 loopback。');
      }
      const code = randomSecret();
      deps.db
        .prepare(
          `INSERT INTO auth_codes (id, user_id, device_id, challenge, redirect_uri, expires_at, consumed_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL)`,
        )
        .run(
          sha256Hex(code),
          input.userId,
          input.deviceId,
          input.challenge,
          input.redirectUri,
          now() + AUTH_CODE_TTL_MS,
        );
      return { code };
    },

    exchangeCode(input: {
      code: string;
      verifier: string;
      redirectUri: string;
      deviceId: string;
    }): { accessToken: string; refreshToken: string } {
      const row = deps.db
        .prepare(
          `SELECT user_id, device_id, challenge, redirect_uri, expires_at, consumed_at FROM auth_codes WHERE id = ?`,
        )
        .get(sha256Hex(input.code)) as
        | {
            user_id: string;
            device_id: string;
            challenge: string;
            redirect_uri: string;
            expires_at: number;
            consumed_at: number | null;
          }
        | undefined;
      if (!row || row.consumed_at !== null) throw new IdentityError('not-found', '授权码无效。');
      if (row.expires_at < now()) throw new IdentityError('expired', '授权码已过期。');
      if (row.redirect_uri !== input.redirectUri || row.device_id !== input.deviceId) {
        throw new IdentityError('invalid-redirect', 'redirect_uri 或 device 不匹配。');
      }
      if (!verifyCodeChallenge(input.verifier, row.challenge)) {
        throw new IdentityError('bad-challenge', 'PKCE 校验失败。');
      }
      deps.db
        .prepare(`UPDATE auth_codes SET consumed_at = ? WHERE id = ?`)
        .run(now(), sha256Hex(input.code));
      const user = deps.db.prepare(`SELECT * FROM users WHERE id = ?`).get(row.user_id) as UserRow;
      const mem = membership(user.id);
      touchDevice(user.id, input.deviceId, {});
      return {
        accessToken: issueAccess(
          user,
          input.deviceId,
          mem?.role ?? 'member',
          mem?.tenant_id ?? 'none',
        ),
        refreshToken: issueRefresh(user.id, input.deviceId),
      };
    },

    refresh(refreshToken: string): { accessToken: string; refreshToken: string } {
      const row = deps.db
        .prepare(
          `SELECT id, user_id, device_id, expires_at, revoked_at FROM refresh_tokens WHERE token_hash = ?`,
        )
        .get(sha256Hex(refreshToken)) as
        | {
            id: string;
            user_id: string;
            device_id: string;
            expires_at: number;
            revoked_at: number | null;
          }
        | undefined;
      if (!row || row.revoked_at !== null) {
        throw new IdentityError(
          'expired',
          '登录已过期，请重新登录。这台电脑上的任务和产物不受影响。',
        );
      }
      if (row.expires_at < now()) {
        throw new IdentityError(
          'expired',
          '登录已过期，请重新登录。这台电脑上的任务和产物不受影响。',
        );
      }
      const device = deps.db
        .prepare(`SELECT revoked_at FROM devices WHERE id = ?`)
        .get(row.device_id) as { revoked_at: number | null } | undefined;
      if (device?.revoked_at !== null && device?.revoked_at !== undefined) {
        throw new IdentityError(
          'expired',
          '登录已过期，请重新登录。这台电脑上的任务和产物不受影响。',
        );
      }
      deps.db.prepare(`UPDATE refresh_tokens SET revoked_at = ? WHERE id = ?`).run(now(), row.id);
      const user = deps.db.prepare(`SELECT * FROM users WHERE id = ?`).get(row.user_id) as UserRow;
      const mem = membership(user.id);
      touchDevice(user.id, row.device_id, {});
      return {
        accessToken: issueAccess(
          user,
          row.device_id,
          mem?.role ?? 'member',
          mem?.tenant_id ?? 'none',
        ),
        refreshToken: issueRefresh(user.id, row.device_id),
      };
    },

    revokeDevice(actorId: string, deviceId: string): void {
      const device = deps.db.prepare(`SELECT user_id FROM devices WHERE id = ?`).get(deviceId) as
        { user_id: string } | undefined;
      if (!device || device.user_id !== actorId)
        throw new IdentityError('not-found', '没有这个设备。');
      deps.db.prepare(`UPDATE devices SET revoked_at = ? WHERE id = ?`).run(now(), deviceId);
      deps.db
        .prepare(
          `UPDATE refresh_tokens SET revoked_at = ? WHERE device_id = ? AND revoked_at IS NULL`,
        )
        .run(now(), deviceId);
    },

    /**
     * 吊销除 `keepDeviceId` 之外的全部设备（Q40，11 §13.9 写了但一直没实现）。
     *
     * 不合并进 `revokeDevice`：那个是"这一台"，这个是"除了我这台之外的所有台"。
     * 合成一个按钮会让"我在网吧登过"这件事没有单独的出口。
     */
    revokeOtherDevices(actorId: string, keepDeviceId?: string): { revoked: number } {
      const rows = deps.db
        .prepare(`SELECT id FROM devices WHERE user_id = ? AND revoked_at IS NULL`)
        .all(actorId) as { id: string }[];
      const targets = rows.map((row) => row.id).filter((id) => id !== keepDeviceId);
      for (const id of targets) {
        deps.db.prepare(`UPDATE devices SET revoked_at = ? WHERE id = ?`).run(now(), id);
        deps.db
          .prepare(
            `UPDATE refresh_tokens SET revoked_at = ? WHERE device_id = ? AND revoked_at IS NULL`,
          )
          .run(now(), id);
      }
      return { revoked: targets.length };
    },

    listDevices(userId: string): readonly {
      readonly id: string;
      readonly name: string;
      readonly platform: string;
      readonly lastSeenAt: number;
      readonly revoked: boolean;
    }[] {
      const rows = deps.db
        .prepare(
          `SELECT id, name, platform, last_seen_at, revoked_at FROM devices WHERE user_id = ? ORDER BY last_seen_at DESC`,
        )
        .all(userId) as {
        id: string;
        name: string;
        platform: string;
        last_seen_at: number;
        revoked_at: number | null;
      }[];
      return rows.map((row) => ({
        id: row.id,
        name: row.name,
        platform: row.platform,
        lastSeenAt: row.last_seen_at,
        revoked: row.revoked_at !== null,
      }));
    },

    deleteAccount(userId: string, password: string): void {
      const user = deps.db.prepare(`SELECT * FROM users WHERE id = ?`).get(userId) as
        UserRow | undefined;
      if (!user || !verifyPassword(password, user.password_hash)) {
        throw new IdentityError('invalid-credentials', '密码不对。');
      }
      const mem = membership(userId);
      if (mem?.role === 'admin' && adminCount(mem.tenant_id) <= 1) {
        throw new IdentityError('last-admin', '最后一名管理员不能注销自己。请先把管理员授给别人。');
      }
      deps.db
        .prepare(`UPDATE refresh_tokens SET revoked_at = ? WHERE user_id = ?`)
        .run(now(), userId);
      deps.db.prepare(`UPDATE devices SET revoked_at = ? WHERE user_id = ?`).run(now(), userId);
      deps.db.prepare(`DELETE FROM sessions WHERE user_id = ?`).run(userId);
      deps.db.prepare(`DELETE FROM memberships WHERE user_id = ?`).run(userId);
      deps.db.prepare(`DELETE FROM quota_accounts WHERE user_id = ?`).run(userId);
      deps.db.prepare(`DELETE FROM users WHERE id = ?`).run(userId);
    },

    grantAdmin(actorId: string, targetUserId: string): void {
      const actor = membership(actorId);
      if (actor?.role !== 'admin') throw new IdentityError('forbidden', '只有管理员能授予管理员。');
      const target = deps.db.prepare(`SELECT id FROM users WHERE id = ?`).get(targetUserId) as
        { id: string } | undefined;
      if (!target) throw new IdentityError('not-registered', '对方还没有注册。');
      const other = membership(targetUserId);
      if (other && other.tenant_id !== actor.tenant_id) {
        throw new IdentityError('other-tenant', '不能把其他租户的成员授为管理员。');
      }
      if (other) {
        deps.db
          .prepare(`UPDATE memberships SET role = 'admin' WHERE user_id = ? AND tenant_id = ?`)
          .run(targetUserId, actor.tenant_id);
      } else {
        deps.db
          .prepare(
            `INSERT INTO memberships (user_id, tenant_id, role, created_at) VALUES (?, ?, 'admin', ?)`,
          )
          .run(targetUserId, actor.tenant_id, now());
      }
      recordAudit(actorId, 'grant-admin', { targetUserId });
    },

    revokeAdmin(actorId: string, targetUserId: string): void {
      const actor = membership(actorId);
      if (actor?.role !== 'admin') throw new IdentityError('forbidden', '只有管理员能收回管理员。');
      const target = membership(targetUserId);
      if (!target || target.tenant_id !== actor.tenant_id) {
        throw new IdentityError('not-found', '对方不是本租户成员。');
      }
      if (target.role === 'admin' && adminCount(actor.tenant_id) <= 1) {
        throw new IdentityError('last-admin', '不能收回最后一名管理员。');
      }
      deps.db
        .prepare(`UPDATE memberships SET role = 'member' WHERE user_id = ? AND tenant_id = ?`)
        .run(targetUserId, actor.tenant_id);
      recordAudit(actorId, 'revoke-admin', { targetUserId });
    },

    addMember(actorId: string, targetUserId: string): void {
      const actor = membership(actorId);
      if (actor?.role !== 'admin') throw new IdentityError('forbidden', '只有管理员能加成员。');
      const target = deps.db.prepare(`SELECT id FROM users WHERE id = ?`).get(targetUserId) as
        { id: string } | undefined;
      if (!target) throw new IdentityError('not-registered', '对方还没有注册。');
      const other = membership(targetUserId);
      if (other && other.tenant_id !== actor.tenant_id) {
        throw new IdentityError('other-tenant', '对方属于其他租户。');
      }
      if (!other) {
        deps.db
          .prepare(
            `INSERT INTO memberships (user_id, tenant_id, role, created_at) VALUES (?, ?, 'member', ?)`,
          )
          .run(targetUserId, actor.tenant_id, now());
      }
    },

    addMemberByEmail(actorId: string, email: string): void {
      const target = findUserByIdentifier(email);
      if (!target) throw new IdentityError('not-registered', '对方还没有注册。');
      this.addMember(actorId, target.id);
    },

    /**
     * 邀请一个**还没注册**的人进租户（11 §13.10 B'）。
     *
     * Q38 只解决了"已注册用户怎么加进来"，而企业部署第一天遇到的是反过来的情形：
     * 管理员手上是一串公司邮箱，人还没注册。原先的做法是口头让对方先去注册、
     * 再回来填邮箱 —— 那一步没有任何系统记录，也没人知道谁还没接受。
     *
     * 邀请链接里的 token 只存哈希，和验证 / 重置邮件同一条纪律。
     */
    createInvite(
      actorId: string,
      input: { email: string; role?: Role; quotaClass?: string },
    ): AdminInvite {
      const actor = requireAdmin(actorId);
      const email = input.email.trim().toLowerCase();
      if (!email.includes('@')) throw new IdentityError('invalid', '邀请需要一个邮箱地址。');

      const existing = findUserByIdentifier(email);
      if (existing) {
        const other = membership(existing.id);
        if (other?.tenant_id === actor.tenant_id) {
          throw new IdentityError('conflict', '这个人已经是本租户成员了。');
        }
        if (other) throw new IdentityError('other-tenant', '对方属于其他租户，要换租户得先退出。');
      }
      const pending = deps.db
        .prepare(
          `SELECT id FROM invites
           WHERE tenant_id = ? AND email = ? AND accepted_at IS NULL AND revoked_at IS NULL
             AND expires_at > ?`,
        )
        .get(actor.tenant_id, email, now()) as { id: string } | undefined;
      if (pending) throw new IdentityError('conflict', '已经邀请过这个邮箱，还没被接受。');

      const id = newId('inv');
      const token = randomSecret();
      deps.db
        .prepare(
          `INSERT INTO invites
             (id, tenant_id, email, role, quota_class, token_hash, invited_by, created_at, expires_at, accepted_at, revoked_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
        )
        .run(
          id,
          actor.tenant_id,
          email,
          input.role ?? 'member',
          input.quotaClass ?? 'default',
          sha256Hex(token),
          actorId,
          now(),
          now() + INVITE_TTL_MS,
        );
      void deps.mailer.send({
        to: email,
        template: 'invite',
        token,
        tenantName: tenantName(actor.tenant_id),
      });
      recordAudit(actorId, 'invite-member', { targetRef: email });
      return inviteView(id);
    },

    listInvites(actorId: string): readonly AdminInvite[] {
      const actor = requireAdmin(actorId);
      const rows = deps.db
        .prepare(
          `SELECT id FROM invites
           WHERE tenant_id = ? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ?
           ORDER BY created_at DESC`,
        )
        .all(actor.tenant_id, now()) as { id: string }[];
      return rows.map((row) => inviteView(row.id));
    },

    revokeInvite(actorId: string, inviteId: string): void {
      const actor = requireAdmin(actorId);
      const row = deps.db
        .prepare(`SELECT id, tenant_id, email FROM invites WHERE id = ?`)
        .get(inviteId) as { id: string; tenant_id: string; email: string } | undefined;
      if (!row || row.tenant_id !== actor.tenant_id) {
        throw new IdentityError('not-found', '没有这条邀请。');
      }
      deps.db.prepare(`UPDATE invites SET revoked_at = ? WHERE id = ?`).run(now(), inviteId);
      recordAudit(actorId, 'revoke-invite', { targetRef: row.email });
    },

    /** 重发 = **换一个 token**，旧链接立刻失效。不换的话"撤回"就形同虚设。 */
    resendInvite(actorId: string, inviteId: string): AdminInvite {
      const actor = requireAdmin(actorId);
      const row = deps.db
        .prepare(`SELECT id, tenant_id, email, accepted_at, revoked_at FROM invites WHERE id = ?`)
        .get(inviteId) as
        | {
            id: string;
            tenant_id: string;
            email: string;
            accepted_at: number | null;
            revoked_at: number | null;
          }
        | undefined;
      if (!row || row.tenant_id !== actor.tenant_id) {
        throw new IdentityError('not-found', '没有这条邀请。');
      }
      if (row.accepted_at !== null) throw new IdentityError('conflict', '这条邀请已经被接受了。');
      if (row.revoked_at !== null) throw new IdentityError('conflict', '这条邀请已经撤回了。');
      const token = randomSecret();
      deps.db
        .prepare(`UPDATE invites SET token_hash = ?, expires_at = ? WHERE id = ?`)
        .run(sha256Hex(token), now() + INVITE_TTL_MS, inviteId);
      void deps.mailer.send({
        to: row.email,
        template: 'invite',
        token,
        tenantName: tenantName(actor.tenant_id),
      });
      return inviteView(inviteId);
    },

    /**
     * 邀请页在收件人还没登录时就要渲染，所以这一条**不鉴权** —— 它只认 token。
     * 返回里没有租户成员名单、没有额度、没有任何内容面字段：拿到链接的人
     * 只能看到"谁邀请我、进哪个租户、我这个邮箱注册过没有"。
     */
    inviteInfo(token: string): {
      email: string;
      tenantName: string;
      registered: boolean;
      expiresAt: number;
    } {
      const row = requireLiveInvite(token);
      return {
        email: row.email,
        tenantName: tenantName(row.tenant_id),
        registered: findUserByIdentifier(row.email) !== undefined,
        expiresAt: row.expires_at,
      };
    },

    /**
     * 接受邀请。两种情形：
     *   · 邮箱已注册 → 只是加进租户，不碰密码
     *   · 邮箱没注册 → 用这里的密码建号，并且**直接算邮箱已验证**
     *     （能点开这封信本身就证明了对这个邮箱的控制权，再发一封验证信是多余的一步）
     */
    acceptInvite(token: string, password?: string): { userId: string } {
      const row = requireLiveInvite(token);
      let user = findUserByIdentifier(row.email);
      if (!user) {
        if (!password) {
          throw new IdentityError('needs-password', '这个邮箱还没有账号，请设置一个密码。');
        }
        const userId = newId('usr');
        deps.db
          .prepare(
            `INSERT INTO users (id, email, phone, password_hash, email_verified, must_change_password, created_at)
             VALUES (?, ?, NULL, ?, 1, 0, ?)`,
          )
          .run(userId, row.email, hashPassword(password, deps.argon), now());
        user = deps.db.prepare(`SELECT * FROM users WHERE id = ?`).get(userId) as UserRow;
      }
      // 注册过但一直没验邮箱的人，点开邀请信同样证明了对这个邮箱的控制权。
      // 不在这里把 email_verified 翻过来，就会出现一个**管理员看得到、本人登不进**
      // 的成员：signup 的"未验证"是对的，acceptInvite 的"加进租户"也是对的，
      // 合起来才是错的（CLAUDE.md §9.1）。
      if (user.email_verified !== 1) {
        deps.db.prepare(`UPDATE users SET email_verified = 1 WHERE id = ?`).run(user.id);
      }
      const other = membership(user.id);
      if (other && other.tenant_id !== row.tenant_id) {
        throw new IdentityError('other-tenant', '你已经属于另一个租户，要换租户得先退出。');
      }
      if (!other) {
        deps.db
          .prepare(
            `INSERT INTO memberships (user_id, tenant_id, role, quota_class, created_at)
             VALUES (?, ?, ?, ?, ?)`,
          )
          .run(user.id, row.tenant_id, row.role, row.quota_class || 'default', now());
      }
      deps.db.prepare(`UPDATE invites SET accepted_at = ? WHERE id = ?`).run(now(), row.id);
      recordAudit(row.invited_by, 'add-member', { targetUserId: user.id });
      return { userId: user.id };
    },

    listMembers(actorId: string): readonly AdminMember[] {
      const actor = membership(actorId);
      if (actor?.role !== 'admin') throw new IdentityError('forbidden', '只有管理员能看成员。');
      const rows = deps.db
        .prepare(
          `SELECT u.id, u.email, u.phone, m.role, m.quota_class
           FROM memberships m JOIN users u ON u.id = m.user_id
           WHERE m.tenant_id = ?`,
        )
        .all(actor.tenant_id) as {
        id: string;
        email: string | null;
        phone: string | null;
        role: Role;
        quota_class: string;
      }[];
      return rows.map((row) => ({
        id: row.id,
        ...(row.email ? { email: row.email } : {}),
        ...(row.phone ? { phone: row.phone } : {}),
        role: row.role,
        quotaClass: row.quota_class || 'default',
      }));
    },

    upsertHostedModel(
      actorId: string,
      input: {
        modelId: string;
        displayName: string;
        provider: string;
        upstreamModel: string;
        adapter: string;
        baseUrl: string;
        apiKey: string;
      },
    ): { id: string } {
      const actor = membership(actorId);
      if (actor?.role !== 'admin') throw new IdentityError('forbidden', '只有管理员能配默认模型。');
      const existing = deps.db
        .prepare(`SELECT id FROM hosted_models WHERE tenant_id = ? AND model_id = ?`)
        .get(actor.tenant_id, input.modelId) as { id: string } | undefined;
      const enc = encryptSecret(deps.masterKey, input.apiKey);
      if (existing) {
        deps.db
          .prepare(
            `UPDATE hosted_models SET display_name = ?, provider = ?, upstream_model = ?, adapter = ?, base_url = ?, api_key_enc = ?
           WHERE id = ?`,
          )
          .run(
            input.displayName,
            input.provider,
            input.upstreamModel,
            input.adapter,
            input.baseUrl,
            enc,
            existing.id,
          );
        recordAudit(actorId, 'update-model-key', { targetRef: input.modelId });
        return { id: existing.id };
      }
      const id = newId('mdl');
      deps.db
        .prepare(
          `INSERT INTO hosted_models (id, tenant_id, model_id, display_name, provider, upstream_model, adapter, base_url, api_key_enc, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          actor.tenant_id,
          input.modelId,
          input.displayName,
          input.provider,
          input.upstreamModel,
          input.adapter,
          input.baseUrl,
          enc,
          now(),
        );
      recordAudit(actorId, 'update-model-key', { targetRef: input.modelId });
      return { id };
    },

    /** 客户端 / 本机网关看到的目录：**没有 apiKey，也没有上游 baseUrl** */
    publicCatalog(tenantId: string): readonly PublicModel[] {
      const rows = deps.db
        .prepare(
          `SELECT model_id, display_name, provider, upstream_model, adapter FROM hosted_models WHERE tenant_id = ?`,
        )
        .all(tenantId) as {
        model_id: string;
        display_name: string;
        provider: string;
        upstream_model: string;
        adapter: string;
      }[];
      return rows.map((row) => ({
        id: row.model_id,
        displayName: row.display_name,
        provider: row.provider,
        upstreamModel: row.upstream_model,
        adapter: row.adapter,
        credentialSource: 'hosted',
        layer: 'tenant',
      }));
    },

    /** 云端网关内部：带上游。不进客户端契约。 */
    internalUpstream(
      tenantId: string,
      modelId: string,
    ): { baseUrl: string; apiKey: string } | undefined {
      const row = deps.db
        .prepare(
          `SELECT base_url, api_key_enc FROM hosted_models WHERE tenant_id = ? AND model_id = ?`,
        )
        .get(tenantId, modelId) as { base_url: string; api_key_enc: string } | undefined;
      if (!row) return undefined;
      return { baseUrl: row.base_url, apiKey: decryptSecret(deps.masterKey, row.api_key_enc) };
    },

    deleteHostedModel(actorId: string, modelId: string): void {
      const actor = membership(actorId);
      if (actor?.role !== 'admin') throw new IdentityError('forbidden', '只有管理员能删默认模型。');
      deps.db
        .prepare(`DELETE FROM hosted_models WHERE tenant_id = ? AND model_id = ?`)
        .run(actor.tenant_id, modelId);
      recordAudit(actorId, 'delete-model', { targetRef: modelId });
    },

    hostedProvider(tenantId: string, modelId: string): string | undefined {
      const row = deps.db
        .prepare(`SELECT provider FROM hosted_models WHERE tenant_id = ? AND model_id = ?`)
        .get(tenantId, modelId) as { provider: string } | undefined;
      return row?.provider;
    },

    checkQuota(userId: string): { ok: true } | { ok: false; reason: string } {
      const q = effectiveQuota(userId);
      if (!q || q.limit <= 0) return { ok: true };
      if (q.used >= q.limit) {
        return { ok: false, reason: '托管额度已用完。不会自动换成其他模型。' };
      }
      return { ok: true };
    },

    addQuotaUsage(userId: string, tokens: number): void {
      if (tokens <= 0) return;
      const mem = membership(userId);
      if (!mem) return;
      deps.db
        .prepare(
          `INSERT INTO quota_accounts (tenant_id, user_id, tokens_limit, tokens_used, quota_override)
           VALUES (?, ?, 0, ?, 0)
           ON CONFLICT(tenant_id, user_id) DO UPDATE SET tokens_used = tokens_used + excluded.tokens_used`,
        )
        .run(mem.tenant_id, userId, tokens);
      maybeWarnQuota(mem.tenant_id, userId);
    },

    recordMetering(day: {
      day: string;
      tenant: string;
      model: string;
      provider: string;
      tokensIn: number;
      tokensOut: number;
      tokensCached: number;
      durationMs: number;
    }): void {
      deps.db
        .prepare(
          `INSERT INTO metering (day, tenant, model, provider, tokens_in, tokens_out, tokens_cached, duration_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(day, tenant, model, provider) DO UPDATE SET
           tokens_in = tokens_in + excluded.tokens_in,
           tokens_out = tokens_out + excluded.tokens_out,
           tokens_cached = tokens_cached + excluded.tokens_cached,
           duration_ms = duration_ms + excluded.duration_ms`,
        )
        .run(
          day.day,
          day.tenant,
          day.model,
          day.provider,
          day.tokensIn,
          day.tokensOut,
          day.tokensCached,
          day.durationMs,
        );
    },

    quota(userId: string): { used: number; limit: number; quotaClass: string } | undefined {
      const mem = membership(userId);
      if (!mem) return undefined;
      const q = effectiveQuota(userId) ?? { used: 0, limit: 0 };
      return { ...q, quotaClass: mem.quota_class ?? 'default' };
    },

    setQuota(actorId: string, targetUserId: string, limit: number): void {
      const actor = membership(actorId);
      if (actor?.role !== 'admin') throw new IdentityError('forbidden', '只有管理员能配额度。');
      deps.db
        .prepare(
          `INSERT INTO quota_accounts (tenant_id, user_id, tokens_limit, tokens_used, quota_override)
           VALUES (?, ?, ?, 0, 1)
           ON CONFLICT(tenant_id, user_id) DO UPDATE SET
             tokens_limit = excluded.tokens_limit,
             quota_override = 1`,
        )
        .run(actor.tenant_id, targetUserId, limit);
      recordAudit(actorId, 'set-quota', { targetUserId, targetRef: String(limit) });
    },

    me(userId: string): {
      id: string;
      email?: string;
      phone?: string;
      role: Role;
      tenantId: string | null;
      mustChangePassword: boolean;
    } {
      const user = deps.db.prepare(`SELECT * FROM users WHERE id = ?`).get(userId) as UserRow;
      const mem = membership(userId);
      return {
        id: user.id,
        ...(user.email ? { email: user.email } : {}),
        ...(user.phone ? { phone: user.phone } : {}),
        role: mem?.role ?? 'member',
        tenantId: mem?.tenant_id ?? null,
        mustChangePassword: user.must_change_password === 1,
      };
    },

    membership,
    listQuotaClasses(actorId: string): readonly { name: string; tokensLimit: number }[] {
      const actor = requireAdmin(actorId);
      const rows = deps.db
        .prepare(`SELECT name, tokens_limit FROM quota_classes WHERE tenant_id = ? ORDER BY name`)
        .all(actor.tenant_id) as { name: string; tokens_limit: number }[];
      return rows.map((row) => ({ name: row.name, tokensLimit: row.tokens_limit }));
    },

    upsertQuotaClass(actorId: string, name: string, tokensLimit: number): void {
      const actor = requireAdmin(actorId);
      if (!/^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(name)) {
        throw new IdentityError('invalid', '配额班级名不合法。');
      }
      if (!Number.isFinite(tokensLimit) || !Number.isInteger(tokensLimit) || tokensLimit < 0) {
        throw new IdentityError('invalid', '额度上限必须是 ≥ 0 的整数。0 = 不限。');
      }
      deps.db
        .prepare(
          `INSERT INTO quota_classes (tenant_id, name, tokens_limit) VALUES (?, ?, ?)
           ON CONFLICT(tenant_id, name) DO UPDATE SET tokens_limit = excluded.tokens_limit`,
        )
        .run(actor.tenant_id, name, tokensLimit);
    },

    assignQuotaClass(actorId: string, targetUserId: string, quotaClass: string): void {
      const actor = requireAdmin(actorId);
      const target = membership(targetUserId);
      if (!target || target.tenant_id !== actor.tenant_id) {
        throw new IdentityError('not-found', '对方不是本租户成员。');
      }
      const cls = deps.db
        .prepare(`SELECT name FROM quota_classes WHERE tenant_id = ? AND name = ?`)
        .get(actor.tenant_id, quotaClass) as { name: string } | undefined;
      if (!cls) throw new IdentityError('not-found', '没有这个配额班级。');
      deps.db
        .prepare(`UPDATE memberships SET quota_class = ? WHERE user_id = ? AND tenant_id = ?`)
        .run(quotaClass, targetUserId, actor.tenant_id);
      recordAudit(actorId, 'assign-quota-class', { targetUserId, targetRef: quotaClass });
    },

    issuePolicyPack(
      actorId: string,
      input: {
        expiresInDays: number;
        graceInDays?: number | undefined;
        disabledModels?: readonly string[] | undefined;
        allowCustom?: boolean | undefined;
        reason?: string | undefined;
        allowManagedHooksOnly?: boolean | undefined;
        disableShare?: boolean | undefined;
        disableSlots?: boolean | undefined;
        forceAudit?: boolean | undefined;
        disabledProfiles?: readonly string[] | undefined;
      },
    ): PolicyPackEnvelope {
      const actor = requireAdmin(actorId);
      if (
        !Number.isFinite(input.expiresInDays) ||
        !Number.isInteger(input.expiresInDays) ||
        input.expiresInDays < 1 ||
        input.expiresInDays > 3650
      ) {
        throw new IdentityError('invalid', '有效期天数必须是 1–3650。');
      }
      const issuedAtBase = Math.floor(now() / 1000);
      const latest = deps.db
        .prepare(`SELECT MAX(issued_at) AS m FROM policy_packs WHERE tenant_id = ?`)
        .get(actor.tenant_id) as { m: number | null } | undefined;
      const issuedAt =
        latest?.m !== null && latest?.m !== undefined && latest.m >= issuedAtBase
          ? latest.m + 1
          : issuedAtBase;
      const expiresAt = issuedAt + input.expiresInDays * 86_400;
      const graceUntil =
        input.graceInDays !== undefined &&
        Number.isInteger(input.graceInDays) &&
        input.graceInDays > 0
          ? expiresAt + input.graceInDays * 86_400
          : undefined;
      const envelope = signPolicyPack(
        deps.keys.privatePem,
        {
          schemaVer: POLICY_PACK_SCHEMA_VER,
          tenant: actor.tenant_id,
          issuedAt,
          expiresAt,
          ...(graceUntil !== undefined ? { graceUntil } : {}),
          models: {
            disabled: [...(input.disabledModels ?? [])],
            allowCustom: input.allowCustom !== false,
            ...(input.reason ? { reason: input.reason } : {}),
          },
          allowManagedHooksOnly: input.allowManagedHooksOnly === true,
          disableShare: input.disableShare === true,
          disableSlots: input.disableSlots === true,
          forceAudit: input.forceAudit === true,
          disabledProfiles: [...(input.disabledProfiles ?? [])],
        },
        deps.keys.kid,
      );
      const packId = newId('ppk');
      deps.db
        .prepare(
          `UPDATE policy_packs SET revoked_at = ? WHERE tenant_id = ? AND revoked_at IS NULL`,
        )
        .run(now(), actor.tenant_id);
      deps.db
        .prepare(
          `INSERT INTO policy_packs
             (id, tenant_id, payload_json, signature, kid, issued_at, expires_at, actor_user_id, revoked_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
        )
        .run(
          packId,
          actor.tenant_id,
          envelope.payloadJson,
          envelope.signature,
          envelope.kid,
          issuedAt,
          expiresAt,
          actorId,
        );
      recordAudit(actorId, 'issue-policy-pack', { targetRef: packId });
      return envelope;
    },

    currentPolicyPack(tenantId: string): PolicyPackEnvelope | undefined {
      const row = deps.db
        .prepare(
          `SELECT payload_json, signature, kid FROM policy_packs
           WHERE tenant_id = ? AND revoked_at IS NULL
           ORDER BY issued_at DESC, rowid DESC LIMIT 1`,
        )
        .get(tenantId) as { payload_json: string; signature: string; kid: string } | undefined;
      if (!row) return undefined;
      return { payloadJson: row.payload_json, signature: row.signature, kid: row.kid };
    },

    /**
     * 设备拉到了哪一份包（11 §13.10 B'）。
     *
     * 签发之后管理员最想知道的是"生效了没有"，而下发是**拉取不是推送** ——
     * 一台一周没开机的设备会一直停在旧包上。不记这一笔的话，管理端只能
     * 显示"已签发"，而那句话在 12 台里有 2 台没拿到的时候是误导。
     */
    markPolicyPulled(deviceId: string, packId: string | undefined): void {
      if (!deviceId) return;
      deps.db
        .prepare(`UPDATE devices SET policy_pack_id = ?, policy_pulled_at = ? WHERE id = ?`)
        .run(packId ?? null, now(), deviceId);
    },

    /** 当前包的 id（`currentPolicyPack` 只给信封，签名面不带 id）。 */
    currentPolicyPackId(tenantId: string): string | undefined {
      const row = deps.db
        .prepare(
          `SELECT id FROM policy_packs
           WHERE tenant_id = ? AND revoked_at IS NULL
           ORDER BY issued_at DESC, rowid DESC LIMIT 1`,
        )
        .get(tenantId) as { id: string } | undefined;
      return row?.id;
    },

    policyReach(actorId: string): PolicyReach {
      const actor = requireAdmin(actorId);
      const current = this.currentPolicyPackId(actor.tenant_id);
      const rows = deps.db
        .prepare(
          `SELECT d.id, d.name, d.platform, d.last_seen_at, d.policy_pack_id, d.policy_pulled_at,
                  u.email AS owner_email
           FROM devices d
           JOIN memberships m ON m.user_id = d.user_id
           LEFT JOIN users u ON u.id = d.user_id
           WHERE m.tenant_id = ? AND d.revoked_at IS NULL
           ORDER BY d.last_seen_at DESC`,
        )
        .all(actor.tenant_id) as {
        id: string;
        name: string;
        platform: string;
        last_seen_at: number;
        policy_pack_id: string | null;
        policy_pulled_at: number | null;
        owner_email: string | null;
      }[];
      const stale = rows
        .filter((row) => current === undefined || row.policy_pack_id !== current)
        .map((row) => ({
          deviceId: row.id,
          name: row.name,
          platform: row.platform,
          lastSeenAt: row.last_seen_at,
          ...(row.owner_email ? { ownerEmail: row.owner_email } : {}),
          ...(row.policy_pulled_at !== null ? { pulledAt: row.policy_pulled_at } : {}),
        }));
      return {
        ...(current !== undefined ? { packId: current } : {}),
        total: rows.length,
        pulled: rows.length - stale.length,
        stale,
      };
    },

    tenantSettings(actorId: string): TenantSettings {
      const actor = requireAdmin(actorId);
      const row = tenantSettingsRow(actor.tenant_id);
      return {
        warnMember: row.warn_member === 1,
        warnPercent: row.warn_percent,
        warnAdmin: row.warn_admin === 1,
      };
    },

    setTenantSettings(actorId: string, patch: Partial<TenantSettings>): TenantSettings {
      const actor = requireAdmin(actorId);
      const current = tenantSettingsRow(actor.tenant_id);
      const percent = patch.warnPercent ?? current.warn_percent;
      if (!Number.isInteger(percent) || percent < 1 || percent > 99) {
        throw new IdentityError('invalid', '提醒阈值要在 1–99 之间。');
      }
      deps.db
        .prepare(
          `UPDATE tenant_settings SET warn_member = ?, warn_percent = ?, warn_admin = ?
           WHERE tenant_id = ?`,
        )
        .run(
          (patch.warnMember ?? current.warn_member === 1) ? 1 : 0,
          percent,
          (patch.warnAdmin ?? current.warn_admin === 1) ? 1 : 0,
          actor.tenant_id,
        );
      return this.tenantSettings(actorId);
    },

    /** 成员自己的「别提醒我」。管理员开关在租户设置里，两个都开才发。 */
    setWarnOptOut(userId: string, optOut: boolean): void {
      const mem = membership(userId);
      if (!mem) return;
      deps.db
        .prepare(`UPDATE memberships SET warn_opt_out = ? WHERE user_id = ? AND tenant_id = ?`)
        .run(optOut ? 1 : 0, userId, mem.tenant_id);
    },

    warnOptOut(userId: string): boolean {
      return Number(membership(userId)?.warn_opt_out ?? 0) === 1;
    },

    listPolicyPacks(actorId: string): {
      current: AdminPolicyPackView | null;
      history: readonly AdminPolicyPackView[];
    } {
      const actor = requireAdmin(actorId);
      const rows = deps.db
        .prepare(
          `SELECT p.id, p.payload_json, p.kid, p.issued_at, p.expires_at, p.revoked_at,
                  p.rowid AS pack_rowid,
                  u.email AS actor_email, u.phone AS actor_phone
           FROM policy_packs p
           LEFT JOIN users u ON u.id = p.actor_user_id
           WHERE p.tenant_id = ?
           ORDER BY p.issued_at DESC, p.rowid DESC`,
        )
        .all(actor.tenant_id) as {
        id: string;
        payload_json: string;
        kid: string;
        issued_at: number;
        expires_at: number;
        revoked_at: number | null;
        pack_rowid: number;
        actor_email: string | null;
        actor_phone: string | null;
      }[];
      const history = rows.map(packRowToView);
      const current = history.find((row) => !row.revoked) ?? null;
      return { current, history };
    },

    revokePolicyPack(actorId: string): void {
      const actor = requireAdmin(actorId);
      const row = deps.db
        .prepare(
          `SELECT id FROM policy_packs
           WHERE tenant_id = ? AND revoked_at IS NULL
           ORDER BY issued_at DESC, rowid DESC LIMIT 1`,
        )
        .get(actor.tenant_id) as { id: string } | undefined;
      if (!row) throw new IdentityError('not-found', '没有可撤销的策略包。');
      deps.db.prepare(`UPDATE policy_packs SET revoked_at = ? WHERE id = ?`).run(now(), row.id);
      recordAudit(actorId, 'revoke-policy-pack', { targetRef: row.id });
    },

    listAudit(actorId: string): readonly IdentityAuditRow[] {
      const actor = requireAdmin(actorId);
      const rows = deps.db
        .prepare(
          `SELECT a.at, a.action, a.target_ref,
                  actor.email AS actor_email, actor.phone AS actor_phone,
                  target.email AS target_email, target.phone AS target_phone
           FROM identity_audit a
           JOIN users actor ON actor.id = a.actor_user_id
           LEFT JOIN users target ON target.id = a.target_user_id
           WHERE a.actor_user_id IN (SELECT user_id FROM memberships WHERE tenant_id = ?)
           ORDER BY a.at DESC, a.rowid DESC
           LIMIT 200`,
        )
        .all(actor.tenant_id) as {
        at: number;
        action: IdentityAuditAction;
        target_ref: string | null;
        actor_email: string | null;
        actor_phone: string | null;
        target_email: string | null;
        target_phone: string | null;
      }[];
      return rows.map((row) => ({
        at: row.at,
        action: row.action,
        ...(row.actor_email ? { actorEmail: row.actor_email } : {}),
        ...(row.actor_phone ? { actorPhone: row.actor_phone } : {}),
        ...(row.target_email ? { targetEmail: row.target_email } : {}),
        ...(row.target_phone ? { targetPhone: row.target_phone } : {}),
        ...(row.target_ref ? { targetRef: row.target_ref } : {}),
      }));
    },

    /**
     * 管理端用量：租户当期总量 + 按人当期累计。
     * **不**查 metering、**不**按天分组（Q43=A）。
     */
    adminUsage(actorId: string): AdminUsage {
      const members = this.listMembers(actorId);
      const rows: AdminUsageMember[] = members.map((member) => {
        const q = effectiveQuota(member.id) ?? { used: 0, limit: 0 };
        return {
          id: member.id,
          ...(member.email ? { email: member.email } : {}),
          ...(member.phone ? { phone: member.phone } : {}),
          used: q.used,
          limit: q.limit,
          quotaClass: member.quotaClass,
          exhausted: q.limit > 0 && q.used >= q.limit,
        };
      });
      return {
        tenantUsed: rows.reduce((sum, row) => sum + row.used, 0),
        members: rows,
      };
    },
  };
}

export type Identity = ReturnType<typeof createIdentity>;

/** 管理端成员。没有任务 / 产物 / prompt。 */
export interface AdminMember {
  readonly id: string;
  readonly email?: string | undefined;
  readonly phone?: string | undefined;
  readonly role: Role;
  readonly quotaClass: string;
}

/** 策略包的人类可读投影。没有任务 / 产物 / prompt。 */
export interface AdminPolicyPackView {
  readonly id: string;
  readonly kid: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly graceUntil?: number | undefined;
  readonly disabledModels: readonly string[];
  readonly disabledProfiles: readonly string[];
  readonly allowCustom: boolean;
  readonly reason?: string | undefined;
  readonly allowManagedHooksOnly: boolean;
  readonly disableShare: boolean;
  readonly disableSlots: boolean;
  readonly forceAudit: boolean;
  readonly revoked: boolean;
  readonly actorEmail?: string | undefined;
  readonly actorPhone?: string | undefined;
}

export type IdentityAuditAction =
  | 'grant-admin'
  | 'revoke-admin'
  | 'update-model-key'
  | 'delete-model'
  | 'issue-policy-pack'
  | 'revoke-policy-pack'
  | 'invite-member'
  | 'revoke-invite'
  | 'add-member'
  | 'set-quota'
  | 'assign-quota-class';

/** 身份面审计。没有任务 / 产物 / prompt。 */
export interface IdentityAuditRow {
  readonly at: number;
  readonly action: IdentityAuditAction;
  readonly actorEmail?: string | undefined;
  readonly actorPhone?: string | undefined;
  readonly targetEmail?: string | undefined;
  readonly targetPhone?: string | undefined;
  readonly targetRef?: string | undefined;
}

/** 按人当期累计。没有按天字段。 */
export interface AdminUsageMember {
  readonly id: string;
  readonly email?: string | undefined;
  readonly phone?: string | undefined;
  readonly used: number;
  readonly limit: number;
  readonly quotaClass: string;
  readonly exhausted: boolean;
}

/** 管理端用量。没有 days / series / byDay。 */
export interface AdminUsage {
  readonly tenantUsed: number;
  readonly members: readonly AdminUsageMember[];
}

/** 待接受的邀请。没有任务 / 产物 / prompt。 */
export interface AdminInvite {
  readonly id: string;
  readonly email: string;
  readonly role: Role;
  readonly quotaClass: string;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly invitedByEmail?: string | undefined;
}

/** 一台还停在旧策略包上的设备。只有设备身份，没有它在做什么。 */
export interface StaleDevice {
  readonly deviceId: string;
  readonly name: string;
  readonly platform: string;
  readonly lastSeenAt: number;
  readonly ownerEmail?: string | undefined;
  readonly pulledAt?: number | undefined;
}

/** 策略包生效面。下发是拉取不是推送，所以"已签发"不等于"已生效"。 */
export interface PolicyReach {
  readonly packId?: string | undefined;
  readonly total: number;
  readonly pulled: number;
  readonly stale: readonly StaleDevice[];
}

/** 租户级的额度提醒设置。没有内容面字段。 */
export interface TenantSettings {
  readonly warnMember: boolean;
  readonly warnPercent: number;
  readonly warnAdmin: boolean;
}

/** 客户端目录条目。类型上没有 apiKey / baseUrl。 */
export interface PublicModel {
  readonly id: string;
  readonly displayName: string;
  readonly provider: string;
  readonly upstreamModel: string;
  readonly adapter: string;
  readonly credentialSource: 'hosted';
  readonly layer: 'tenant';
}
