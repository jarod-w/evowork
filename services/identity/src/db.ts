import { DatabaseSync } from 'node:sqlite';

import { IDENTITY_DDL } from './schema.js';

export interface SqliteLike {
  exec(sql: string): void;
  prepare(sql: string): {
    run(...params: unknown[]): unknown;
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  };
}

export function openIdentityDb(path: string): SqliteLike {
  const raw = new DatabaseSync(path);
  const db = raw as unknown as SqliteLike;
  if (path !== ':memory:') db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(IDENTITY_DDL);
  migrateIdentityDb(db);
  return db;
}

/**
 * `CREATE TABLE IF NOT EXISTS` 不会给已有表加列。文件库要从 M10b 升上来。
 */
export function migrateIdentityDb(db: SqliteLike): void {
  if (!hasColumn(db, 'memberships', 'quota_class')) {
    db.exec(`ALTER TABLE memberships ADD COLUMN quota_class TEXT NOT NULL DEFAULT 'default'`);
  }
  if (!hasColumn(db, 'quota_accounts', 'quota_override')) {
    db.exec(`ALTER TABLE quota_accounts ADD COLUMN quota_override INTEGER NOT NULL DEFAULT 0`);
    // 已有行都是 setQuota 写的每人上限，不是班级默认。
    db.exec(`UPDATE quota_accounts SET quota_override = 1`);
  }
  if (!hasColumn(db, 'identity_audit', 'target_ref')) {
    db.exec(`ALTER TABLE identity_audit ADD COLUMN target_ref TEXT`);
  }
  migratePolicyPacks(db);
  db.exec(
    `INSERT OR IGNORE INTO quota_classes (tenant_id, name, tokens_limit)
     SELECT id, 'default', 0 FROM tenants`,
  );
}

function migratePolicyPacks(db: SqliteLike): void {
  if (!hasColumn(db, 'policy_packs', 'id')) {
    db.exec(`CREATE TABLE policy_packs_v2 (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      signature TEXT NOT NULL,
      kid TEXT NOT NULL,
      issued_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      actor_user_id TEXT NOT NULL,
      revoked_at INTEGER
    )`);
    db.exec(`INSERT INTO policy_packs_v2
      (id, tenant_id, payload_json, signature, kid, issued_at, expires_at, actor_user_id, revoked_at)
      SELECT 'ppk_' || tenant_id, tenant_id, payload_json, signature, kid, issued_at, expires_at, actor_user_id, NULL
      FROM policy_packs`);
    db.exec(`DROP TABLE policy_packs`);
    db.exec(`ALTER TABLE policy_packs_v2 RENAME TO policy_packs`);
    return;
  }
  if (!hasColumn(db, 'policy_packs', 'revoked_at')) {
    db.exec(`ALTER TABLE policy_packs ADD COLUMN revoked_at INTEGER`);
  }
}

function hasColumn(db: SqliteLike, table: string, column: string): boolean {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return cols.some((col) => col.name === column);
}
