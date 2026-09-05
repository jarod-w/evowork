/**
 * 打开本机库并跑迁移（09 §4）。
 *
 * `~/.evowork/evowork.db`，WAL，**单写者（服务层），UI 只读走服务层 API**。
 * 驱动用 Node 内置的 `node:sqlite`：它自带 WAL 与 FTS5（2026-09-05 在 Node 22.22 实测），
 * 因此不需要 native 依赖 —— 而 native 依赖在 M9 的三平台打包与公证里是实打实的成本（R10）。
 * 所有 sqlite 访问都走 `SqliteLike` 这个窄接口，将来换驱动只改本文件。
 */
import { DatabaseSync } from 'node:sqlite';

import { digest, type Logger } from '@evowork/logging';

import {
  AUTHORITATIVE_VERSION,
  PROJECTION_VERSION,
  migrateAuthoritative,
  migrateProjection,
  readMeta,
  writeMeta,
  type MigrationOutcome,
  type SqliteLike,
} from './migrate.js';
import { ThreadProjection } from './projection.js';

export interface OpenStoreOptions {
  /** 库文件路径；`:memory:` 用于测试 */
  readonly path: string;
  readonly logger?: Logger;
  /** 设备标识（Q15：automation 绑定设备）。首次打开时写入 meta，之后只读 */
  readonly deviceId?: string;
}

export interface Store {
  readonly db: SqliteLike;
  readonly threads: ThreadProjection;
  readonly migrations: readonly MigrationOutcome[];
  /** 本机设备 id（Q15 的绑定依据） */
  readonly deviceId: string;
  /** 记一条未识别的上游通知（R2 雷达）。**只记方法名与形状，不记 params 正文** */
  recordUnknownEvent(method: string, params: unknown, now?: number): void;
  /** 最近 N 条 item 摘要（04 §9 的首屏快显） */
  putItemDigest(entry: ItemDigestEntry): void;
  readItemDigest(threadId: string, limit?: number): ItemDigestEntry[];
  transaction<T>(fn: () => T): T;
  close(): void;
}

export interface ItemDigestEntry {
  readonly threadId: string;
  readonly seq: number;
  readonly itemId: string;
  readonly itemType: string;
  /** 一行摘要，不存完整内容（09 §4.2） */
  readonly summary: string | null;
  readonly createdAt: number;
}

/** 只保留最近这么多条摘要（09 §4.2：最近 50 条） */
const ITEM_DIGEST_KEEP = 50;

export function openStore(options: OpenStoreOptions): Store {
  const raw = new DatabaseSync(options.path);
  const db: SqliteLike = raw as unknown as SqliteLike;

  // WAL：单写者多读者。内存库不支持 WAL，pragma 会静默回落到 memory 模式
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');

  // 顺序刻意：**权威表先迁**。它可能抛错中止启动，那时不该已经动过投影表 ——
  // 否则用户看到的是"启动失败"外加"索引也被重建了"两件事。
  const migrations: MigrationOutcome[] = [];
  migrations.push(
    migrateAuthoritative(db, {
      ...(options.path === ':memory:' ? {} : { dbPath: options.path }),
      checkpoint: (d) => d.exec('PRAGMA wal_checkpoint(TRUNCATE)'),
    }),
  );
  migrations.push(migrateProjection(db));

  const deviceId = ensureDeviceId(db, options.deviceId);

  for (const outcome of migrations) {
    if (outcome.applied.length === 0 && !outcome.rebuilt) continue;
    const fields = {
      schemaVersion: outcome.to,
      reason: outcome.rebuilt ? 'REBUILT' : 'MIGRATED',
    } as const;
    if (outcome.rebuilt) {
      options.logger?.warn('store.projection.rebuilt', fields);
    } else {
      options.logger?.info(`store.migration.${outcome.kind}`, fields);
    }
  }

  const store: Store = {
    db,
    threads: new ThreadProjection(db),
    migrations,
    deviceId,

    recordUnknownEvent(method, params, now = Date.now()) {
      // **只记形状不记内容**：未识别的通知里可能有正文（比如某个新的 item 类型带 text 字段）。
      // 形状 = 顶层键名排序后的摘要，足够回答"上游加了什么"，且不可能含业务数据。
      const shape = shapeOf(params);
      db.prepare(
        `INSERT INTO unknown_event(method, shape, first_seen, last_seen, hits)
         VALUES(?,?,?,?,1)
         ON CONFLICT(method, shape) DO UPDATE SET last_seen = excluded.last_seen, hits = hits + 1`,
      ).run(method, shape, now, now);
    },

    putItemDigest(entry) {
      db.prepare(
        `INSERT INTO item_digest(thread_id, seq, item_id, item_type, summary, created_at)
         VALUES(?,?,?,?,?,?)
         ON CONFLICT(thread_id, seq) DO UPDATE SET
           item_id = excluded.item_id, item_type = excluded.item_type,
           summary = excluded.summary, created_at = excluded.created_at`,
      ).run(
        entry.threadId,
        entry.seq,
        entry.itemId,
        entry.itemType,
        entry.summary,
        entry.createdAt,
      );
      // 只留最近 ITEM_DIGEST_KEEP 条 —— 它是快显缓存，不是历史副本
      db.prepare(
        `DELETE FROM item_digest WHERE thread_id = ? AND seq <= (
           SELECT MAX(seq) - ? FROM item_digest WHERE thread_id = ?
         )`,
      ).run(entry.threadId, ITEM_DIGEST_KEEP, entry.threadId);
    },

    readItemDigest(threadId, limit = ITEM_DIGEST_KEEP) {
      const rows = db
        .prepare(
          `SELECT thread_id, seq, item_id, item_type, summary, created_at
           FROM item_digest WHERE thread_id = ? ORDER BY seq DESC LIMIT ?`,
        )
        .all(threadId, limit) as {
        thread_id: string;
        seq: number;
        item_id: string;
        item_type: string;
        summary: string | null;
        created_at: number;
      }[];
      return rows
        .map((r) => ({
          threadId: r.thread_id,
          seq: r.seq,
          itemId: r.item_id,
          itemType: r.item_type,
          summary: r.summary,
          createdAt: r.created_at,
        }))
        .reverse();
    },

    transaction<T>(fn: () => T): T {
      db.exec('BEGIN');
      try {
        const result = fn();
        db.exec('COMMIT');
        return result;
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    },

    close() {
      // WAL 收尾：不 checkpoint 的话 -wal 文件会一直留着，用户看到三个文件会以为出错了
      try {
        db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      } catch {
        // 只读或已关闭时会失败，不影响正确性
      }
      raw.close();
    },
  };

  return store;
}

export const SCHEMA_VERSIONS = {
  projection: PROJECTION_VERSION,
  authoritative: AUTHORITATIVE_VERSION,
} as const;

function ensureDeviceId(db: SqliteLike, provided?: string): string {
  const existing = readMeta(db, 'device_id');
  if (existing) return existing;
  const id = provided ?? `dev_${digest(`${Date.now()}-${Math.random()}`)}`;
  writeMeta(db, 'device_id', id);
  return id;
}

/**
 * 形状指纹：顶层键名（排序）+ 值的类型。
 *
 * 例：`{threadId, item:{...}}` → `item:object|threadId:string`。
 * 这样同一个新通知的多次出现会聚成一条，而不是每次都新增一行。
 */
function shapeOf(params: unknown): string {
  if (params === null || params === undefined) return '(empty)';
  if (Array.isArray(params)) return `array[${params.length > 0 ? typeof params[0] : 'empty'}]`;
  if (typeof params !== 'object') return typeof params;
  return Object.entries(params as Record<string, unknown>)
    .map(([k, v]) => `${k}:${Array.isArray(v) ? 'array' : typeof v}`)
    .sort()
    .join('|');
}
