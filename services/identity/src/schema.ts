/**
 * identity 的 sqlite schema。**这是云端库**，可以有 `tenant_id` ——
 * D10 扫的是本机 `services/store`，不是这里。
 *
 * 没有任务 / 产物 / prompt 列。想加得先改这份 DDL，而改它会被
 * `test/no-content-schema.test.ts` 看见。
 */
export const IDENTITY_DDL = `
CREATE TABLE IF NOT EXISTS tenants (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE,
  phone TEXT UNIQUE,
  password_hash TEXT NOT NULL,
  email_verified INTEGER NOT NULL DEFAULT 0,
  must_change_password INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS memberships (
  user_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  role TEXT NOT NULL,
  quota_class TEXT NOT NULL DEFAULT 'default',
  -- 成员自己关掉「快用完了提醒我」。管理员的开关在 tenant_settings，
  -- 两个都开才发 —— 提醒是给本人的，本人说不要就不发。
  warn_opt_out INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, tenant_id)
);

CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  platform TEXT NOT NULL,
  last_seen_at INTEGER NOT NULL,
  revoked_at INTEGER,
  -- 这台设备最后一次拉到的策略包。管理端的"生效面"读它：签发之后到底有几台拿到了。
  -- 只记包 id 与时间，不记这台机器在做什么。
  policy_pack_id TEXT,
  policy_pulled_at INTEGER
);

CREATE TABLE IF NOT EXISTS refresh_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER
);

CREATE TABLE IF NOT EXISTS email_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  purpose TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS auth_codes (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  challenge TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER
);

CREATE TABLE IF NOT EXISTS hosted_models (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  provider TEXT NOT NULL,
  upstream_model TEXT NOT NULL,
  adapter TEXT NOT NULL,
  base_url TEXT NOT NULL,
  api_key_enc TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (tenant_id, model_id)
);

CREATE TABLE IF NOT EXISTS quota_accounts (
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  tokens_limit INTEGER NOT NULL,
  tokens_used INTEGER NOT NULL DEFAULT 0,
  quota_override INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, user_id)
);

CREATE TABLE IF NOT EXISTS quota_classes (
  tenant_id TEXT NOT NULL,
  name TEXT NOT NULL,
  tokens_limit INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, name)
);

CREATE TABLE IF NOT EXISTS signing_keys (
  kid TEXT PRIMARY KEY,
  public_pem TEXT NOT NULL,
  public_jwk_json TEXT NOT NULL,
  private_pem_enc TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS policy_packs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  signature TEXT NOT NULL,
  kid TEXT NOT NULL,
  issued_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  actor_user_id TEXT NOT NULL,
  revoked_at INTEGER
);

CREATE TABLE IF NOT EXISTS identity_audit (
  id TEXT PRIMARY KEY,
  at INTEGER NOT NULL,
  actor_user_id TEXT NOT NULL,
  action TEXT NOT NULL,
  target_user_id TEXT,
  target_ref TEXT
);

CREATE TABLE IF NOT EXISTS invites (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  email TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',
  quota_class TEXT NOT NULL DEFAULT 'default',
  token_hash TEXT NOT NULL UNIQUE,
  invited_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  accepted_at INTEGER,
  revoked_at INTEGER
);

CREATE TABLE IF NOT EXISTS tenant_settings (
  tenant_id TEXT PRIMARY KEY,
  warn_member INTEGER NOT NULL DEFAULT 1,
  warn_percent INTEGER NOT NULL DEFAULT 80,
  warn_admin INTEGER NOT NULL DEFAULT 1
);

-- 发过的额度提醒。没有它，每一次调用都会再发一封。
-- period 是计费周期键（YYYY-MM），换期即重新可发。
CREATE TABLE IF NOT EXISTS quota_notices (
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  period TEXT NOT NULL,
  sent_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, user_id, kind, period)
);

CREATE TABLE IF NOT EXISTS login_attempts (
  identifier TEXT NOT NULL,
  at INTEGER NOT NULL,
  ok INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS metering (
  day TEXT NOT NULL,
  tenant TEXT NOT NULL,
  model TEXT NOT NULL,
  provider TEXT NOT NULL,
  tokens_in INTEGER NOT NULL,
  tokens_out INTEGER NOT NULL,
  tokens_cached INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  PRIMARY KEY (day, tenant, model, provider)
);
`;
