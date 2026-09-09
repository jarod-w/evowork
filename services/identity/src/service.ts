/**
 * identity 用例。HTTP 层只做路由，决策都在这里，所以测试可以不起服务器。
 */
import {
  ACCESS_TTL_SEC,
  REFRESH_TTL_SEC,
  signAccessToken,
  verifyCodeChallenge,
  type AccessClaims,
  type Es256KeyPair,
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
  | 'no-sms';

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
      .prepare(`SELECT user_id, tenant_id, role FROM memberships WHERE user_id = ?`)
      .get(userId) as MembershipRow | undefined;
  }

  function issueAccess(user: UserRow, deviceId: string, role: Role, tenant: string): string {
    const iat = Math.floor(now() / 1000);
    const claims: AccessClaims = {
      sub: user.id,
      tenant,
      iat,
      exp: iat + ACCESS_TTL_SEC,
      scope: 'gateway',
      quotaClass: 'default',
      deviceId,
      role,
    };
    return signAccessToken(deps.keys.privatePem, claims, deps.keys.kid);
  }

  function issueRefresh(userId: string, deviceId: string): string {
    const raw = randomSecret();
    deps.db.prepare(
      `INSERT INTO refresh_tokens (id, user_id, device_id, token_hash, expires_at, revoked_at)
       VALUES (?, ?, ?, ?, ?, NULL)`,
    ).run(newId('rt'), userId, deviceId, sha256Hex(raw), now() + REFRESH_TTL_SEC * 1000);
    return raw;
  }

  function touchDevice(
    userId: string,
    deviceId: string,
    meta: { name?: string; platform?: string },
  ): void {
    const existing = deps.db.prepare(`SELECT id FROM devices WHERE id = ?`).get(deviceId) as
      | { id: string }
      | undefined;
    if (existing) {
      deps.db
        .prepare(`UPDATE devices SET last_seen_at = ?, revoked_at = NULL WHERE id = ?`)
        .run(now(), deviceId);
      return;
    }
    deps.db.prepare(
      `INSERT INTO devices (id, user_id, name, platform, last_seen_at, revoked_at)
       VALUES (?, ?, ?, ?, ?, NULL)`,
    ).run(deviceId, userId, meta.name ?? 'device', meta.platform ?? 'unknown', now());
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
      deps.db.prepare(
        `INSERT INTO users (id, email, phone, password_hash, email_verified, must_change_password, created_at)
         VALUES (?, ?, ?, ?, 1, 1, ?)`,
      ).run(
        userId,
        config.email ?? null,
        config.phone ?? null,
        hashPassword(config.password, deps.argon),
        now(),
      );
      deps.db
        .prepare(`INSERT INTO memberships (user_id, tenant_id, role, created_at) VALUES (?, ?, 'admin', ?)`)
        .run(userId, tenantId, now());
      return { created: true, tenantId };
    },

    signup(input: { email: string; password: string }): { userId: string } {
      if (findUserByIdentifier(input.email)) {
        throw new IdentityError('conflict', '这个邮箱已经注册过。');
      }
      const userId = newId('usr');
      deps.db.prepare(
        `INSERT INTO users (id, email, phone, password_hash, email_verified, must_change_password, created_at)
         VALUES (?, ?, NULL, ?, 0, 0, ?)`,
      ).run(userId, input.email, hashPassword(input.password, deps.argon), now());
      const token = randomSecret();
      deps.db.prepare(
        `INSERT INTO email_tokens (id, user_id, purpose, token_hash, expires_at, consumed_at)
         VALUES (?, ?, 'verify', ?, ?, NULL)`,
      ).run(newId('em'), userId, sha256Hex(token), now() + EMAIL_TOKEN_TTL_MS);
      void deps.mailer.send({ to: input.email, template: 'verify', token });
      return { userId };
    },

    verifyEmail(token: string): void {
      const row = deps.db
        .prepare(
          `SELECT id, user_id, expires_at, consumed_at FROM email_tokens WHERE token_hash = ? AND purpose = 'verify'`,
        )
        .get(sha256Hex(token)) as
        | { id: string; user_id: string; expires_at: number; consumed_at: number | null }
        | undefined;
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
      deps.db.prepare(
        `INSERT INTO email_tokens (id, user_id, purpose, token_hash, expires_at, consumed_at)
         VALUES (?, ?, 'reset', ?, ?, NULL)`,
      ).run(newId('em'), user.id, sha256Hex(token), now() + EMAIL_TOKEN_TTL_MS);
      void deps.mailer.send({ to: user.email, template: 'reset', token });
    },

    resetPassword(token: string, next: string): void {
      const row = deps.db
        .prepare(
          `SELECT id, user_id, expires_at, consumed_at FROM email_tokens WHERE token_hash = ? AND purpose = 'reset'`,
        )
        .get(sha256Hex(token)) as
        | { id: string; user_id: string; expires_at: number; consumed_at: number | null }
        | undefined;
      if (!row || row.consumed_at !== null) throw new IdentityError('not-found', '重置链接无效。');
      if (row.expires_at < now()) throw new IdentityError('expired', '重置链接已过期。');
      deps.db.prepare(`UPDATE email_tokens SET consumed_at = ? WHERE id = ?`).run(now(), row.id);
      deps.db
        .prepare(`UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?`)
        .run(hashPassword(next, deps.argon), row.user_id);
    },

    changePassword(userId: string, current: string, next: string): void {
      const user = deps.db.prepare(`SELECT * FROM users WHERE id = ?`).get(userId) as
        | UserRow
        | undefined;
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
      deps.db.prepare(
        `INSERT INTO auth_codes (id, user_id, device_id, challenge, redirect_uri, expires_at, consumed_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL)`,
      ).run(
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
        accessToken: issueAccess(user, input.deviceId, mem?.role ?? 'member', mem?.tenant_id ?? 'none'),
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
        throw new IdentityError('expired', '登录已过期，请重新登录。这台电脑上的任务和产物不受影响。');
      }
      if (row.expires_at < now()) {
        throw new IdentityError('expired', '登录已过期，请重新登录。这台电脑上的任务和产物不受影响。');
      }
      const device = deps.db
        .prepare(`SELECT revoked_at FROM devices WHERE id = ?`)
        .get(row.device_id) as { revoked_at: number | null } | undefined;
      if (device?.revoked_at !== null && device?.revoked_at !== undefined) {
        throw new IdentityError('expired', '登录已过期，请重新登录。这台电脑上的任务和产物不受影响。');
      }
      deps.db.prepare(`UPDATE refresh_tokens SET revoked_at = ? WHERE id = ?`).run(now(), row.id);
      const user = deps.db.prepare(`SELECT * FROM users WHERE id = ?`).get(row.user_id) as UserRow;
      const mem = membership(user.id);
      touchDevice(user.id, row.device_id, {});
      return {
        accessToken: issueAccess(user, row.device_id, mem?.role ?? 'member', mem?.tenant_id ?? 'none'),
        refreshToken: issueRefresh(user.id, row.device_id),
      };
    },

    revokeDevice(actorId: string, deviceId: string): void {
      const device = deps.db
        .prepare(`SELECT user_id FROM devices WHERE id = ?`)
        .get(deviceId) as { user_id: string } | undefined;
      if (!device || device.user_id !== actorId) throw new IdentityError('not-found', '没有这个设备。');
      deps.db.prepare(`UPDATE devices SET revoked_at = ? WHERE id = ?`).run(now(), deviceId);
      deps.db
        .prepare(`UPDATE refresh_tokens SET revoked_at = ? WHERE device_id = ? AND revoked_at IS NULL`)
        .run(now(), deviceId);
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
        | UserRow
        | undefined;
      if (!user || !verifyPassword(password, user.password_hash)) {
        throw new IdentityError('invalid-credentials', '密码不对。');
      }
      const mem = membership(userId);
      if (mem?.role === 'admin' && adminCount(mem.tenant_id) <= 1) {
        throw new IdentityError('last-admin', '最后一名管理员不能注销自己。请先把管理员授给别人。');
      }
      deps.db.prepare(`UPDATE refresh_tokens SET revoked_at = ? WHERE user_id = ?`).run(now(), userId);
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
        | { id: string }
        | undefined;
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
      deps.db.prepare(
        `INSERT INTO identity_audit (id, at, actor_user_id, action, target_user_id) VALUES (?, ?, ?, 'grant-admin', ?)`,
      ).run(newId('aud'), now(), actorId, targetUserId);
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
      deps.db.prepare(
        `INSERT INTO identity_audit (id, at, actor_user_id, action, target_user_id) VALUES (?, ?, ?, 'revoke-admin', ?)`,
      ).run(newId('aud'), now(), actorId, targetUserId);
    },

    addMember(actorId: string, targetUserId: string): void {
      const actor = membership(actorId);
      if (actor?.role !== 'admin') throw new IdentityError('forbidden', '只有管理员能加成员。');
      const target = deps.db.prepare(`SELECT id FROM users WHERE id = ?`).get(targetUserId) as
        | { id: string }
        | undefined;
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

    listMembers(actorId: string): readonly AdminMember[] {
      const actor = membership(actorId);
      if (actor?.role !== 'admin') throw new IdentityError('forbidden', '只有管理员能看成员。');
      const rows = deps.db
        .prepare(
          `SELECT u.id, u.email, u.phone, m.role
           FROM memberships m JOIN users u ON u.id = m.user_id
           WHERE m.tenant_id = ?`,
        )
        .all(actor.tenant_id) as { id: string; email: string | null; phone: string | null; role: Role }[];
      return rows.map((row) => ({
        id: row.id,
        ...(row.email ? { email: row.email } : {}),
        ...(row.phone ? { phone: row.phone } : {}),
        role: row.role,
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
        deps.db.prepare(
          `UPDATE hosted_models SET display_name = ?, provider = ?, upstream_model = ?, adapter = ?, base_url = ?, api_key_enc = ?
           WHERE id = ?`,
        ).run(
          input.displayName,
          input.provider,
          input.upstreamModel,
          input.adapter,
          input.baseUrl,
          enc,
          existing.id,
        );
        return { id: existing.id };
      }
      const id = newId('mdl');
      deps.db.prepare(
        `INSERT INTO hosted_models (id, tenant_id, model_id, display_name, provider, upstream_model, adapter, base_url, api_key_enc, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
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
    internalUpstream(tenantId: string, modelId: string): { baseUrl: string; apiKey: string } | undefined {
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
    },

    hostedProvider(tenantId: string, modelId: string): string | undefined {
      const row = deps.db
        .prepare(`SELECT provider FROM hosted_models WHERE tenant_id = ? AND model_id = ?`)
        .get(tenantId, modelId) as { provider: string } | undefined;
      return row?.provider;
    },

    checkQuota(userId: string): { ok: true } | { ok: false; reason: string } {
      const mem = membership(userId);
      if (!mem) return { ok: true };
      const row = deps.db
        .prepare(
          `SELECT tokens_used, tokens_limit FROM quota_accounts WHERE tenant_id = ? AND user_id = ?`,
        )
        .get(mem.tenant_id, userId) as { tokens_used: number; tokens_limit: number } | undefined;
      if (!row || row.tokens_limit <= 0) return { ok: true };
      if (row.tokens_used >= row.tokens_limit) {
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
          `UPDATE quota_accounts SET tokens_used = tokens_used + ? WHERE tenant_id = ? AND user_id = ?`,
        )
        .run(tokens, mem.tenant_id, userId);
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
      deps.db.prepare(
        `INSERT INTO metering (day, tenant, model, provider, tokens_in, tokens_out, tokens_cached, duration_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(day, tenant, model, provider) DO UPDATE SET
           tokens_in = tokens_in + excluded.tokens_in,
           tokens_out = tokens_out + excluded.tokens_out,
           tokens_cached = tokens_cached + excluded.tokens_cached,
           duration_ms = duration_ms + excluded.duration_ms`,
      ).run(
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

    quota(userId: string): { used: number; limit: number } | undefined {
      const mem = membership(userId);
      if (!mem) return undefined;
      const row = deps.db
        .prepare(
          `SELECT tokens_used, tokens_limit FROM quota_accounts WHERE tenant_id = ? AND user_id = ?`,
        )
        .get(mem.tenant_id, userId) as { tokens_used: number; tokens_limit: number } | undefined;
      if (!row) return { used: 0, limit: 0 };
      return { used: row.tokens_used, limit: row.tokens_limit };
    },

    setQuota(actorId: string, targetUserId: string, limit: number): void {
      const actor = membership(actorId);
      if (actor?.role !== 'admin') throw new IdentityError('forbidden', '只有管理员能配额度。');
      deps.db.prepare(
        `INSERT INTO quota_accounts (tenant_id, user_id, tokens_limit, tokens_used) VALUES (?, ?, ?, 0)
         ON CONFLICT(tenant_id, user_id) DO UPDATE SET tokens_limit = excluded.tokens_limit`,
      ).run(actor.tenant_id, targetUserId, limit);
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
  };
}

export type Identity = ReturnType<typeof createIdentity>;

/** 管理端成员。没有任务 / 产物 / prompt。 */
export interface AdminMember {
  readonly id: string;
  readonly email?: string | undefined;
  readonly phone?: string | undefined;
  readonly role: Role;
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
