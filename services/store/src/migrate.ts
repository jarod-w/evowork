/**
 * 两个迁移器（09 §4.6）。
 *
 * 这个文件的全部意义在一句话：**投影类表可以被丢弃重建，权威类表不可以**。
 * 文档要求"这条区分要在代码里显式表达（两个迁移器），否则'重建索引'的逻辑总有一天会把
 * automation 表也清了"——所以这里连版本号都是两套，两条路径没有任何共享的可写状态。
 *
 * | | 投影类 | 权威类 |
 * |---|---|---|
 * | 版本键 | `schema_version_projection` | `schema_version_authoritative` |
 * | 迁移前 | 无 | **备份整库**到 `evowork.db.bak.<version>` |
 * | 迁移失败 | 丢弃全部投影表 → 按最新 schema 重建 → **继续启动**（附一条警告） | 回滚到备份 → **抛错，宁可启动失败** |
 * | 理由 | 真源在内核 / 文件系统，重建只是重算一次 | 真源只在这里，丢了就是丢了定时任务定义 |
 */
import { copyFileSync, existsSync, unlinkSync } from 'node:fs';

import { AUTHORITATIVE_TABLES, PROJECTION_TABLES, type TableSpec } from './schema.js';

/** 极小的 sqlite 接口。只用到这几个方法，因此可以在测试里换成内存实现，也便于将来换驱动。 */
export interface SqliteLike {
  exec(sql: string): void;
  prepare(sql: string): {
    run(...params: unknown[]): unknown;
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  };
}

export interface Migration {
  readonly version: number;
  readonly summary: string;
  readonly up: (db: SqliteLike) => void;
}

/** 建表本身就是第 1 版。后续 schema 变化在这两个数组里往后追加，**只加不改**。 */
function createTables(tables: readonly TableSpec[]): Migration {
  return {
    version: 1,
    summary: '建表',
    up: (db) => {
      for (const table of tables) {
        for (const ddl of table.ddl) db.exec(ddl);
      }
    },
  };
}

export const PROJECTION_MIGRATIONS: readonly Migration[] = [createTables(PROJECTION_TABLES)];
export const AUTHORITATIVE_MIGRATIONS: readonly Migration[] = [createTables(AUTHORITATIVE_TABLES)];

export const PROJECTION_VERSION = PROJECTION_MIGRATIONS.at(-1)?.version ?? 0;
export const AUTHORITATIVE_VERSION = AUTHORITATIVE_MIGRATIONS.at(-1)?.version ?? 0;

const META_DDL = `CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`;

export function ensureMeta(db: SqliteLike): void {
  db.exec(META_DDL);
}

export function readMeta(db: SqliteLike, key: string): string | undefined {
  const row = db.prepare(`SELECT value FROM meta WHERE key = ?`).get(key) as
    { value?: string } | undefined;
  return row?.value;
}

export function writeMeta(db: SqliteLike, key: string, value: string): void {
  db.prepare(
    `INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(key, value);
}

function readVersion(db: SqliteLike, key: string): number {
  const raw = readMeta(db, key);
  const n = raw === undefined ? 0 : Number(raw);
  return Number.isFinite(n) ? n : 0;
}

export interface MigrationOutcome {
  readonly kind: 'projection' | 'authoritative';
  readonly from: number;
  readonly to: number;
  readonly applied: readonly number[];
  /** 投影类专用：迁移失败后走了"丢弃重建"这条路 */
  readonly rebuilt: boolean;
  /** 权威类专用：这次迁移前备份到了哪 */
  readonly backupPath?: string;
  readonly warning?: string;
}

function applyMigrations(db: SqliteLike, migrations: readonly Migration[], from: number): number[] {
  const applied: number[] = [];
  for (const migration of migrations) {
    if (migration.version <= from) continue;
    migration.up(db);
    applied.push(migration.version);
  }
  return applied;
}

/**
 * 在一个事务里跑迁移。
 *
 * **这是进程内失败的唯一有效防线**，文件备份不是 —— 这条是被测试逼出来的结论：
 * 最初的实现是"迁移失败后把备份文件拷回主库"，看起来合理，实际无效：
 * 连接还开着，SQLite 有自己的页缓存与 WAL，进程退出时会把内存里的状态 checkpoint
 * 到刚被覆盖的文件上，于是那次 `DELETE` 又回来了。
 *
 * SQLite 的 DDL 是事务性的，所以建表、改表、数据搬迁可以一起回滚。
 * 文件备份的作用因此收窄到它真正能起作用的场景：**进程在迁移中途被杀**
 * （断电、OOM、用户强退）——那时没有任何代码能跑，只有下次启动时的人工/自动恢复能用它。
 */
function inTransaction<T>(db: SqliteLike, fn: () => T): T {
  // IMMEDIATE：迁移一定要写，早点拿写锁比在中途拿失败好
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // 已经不在事务里（比如迁移自己 COMMIT 过）——把原始错误抛出去更有用
    }
    throw err;
  }
}

/**
 * 投影类迁移。失败就丢弃重建 —— **不阻塞启动**。
 *
 * "丢弃重建"的兜底价值在于：投影表的内容可以从内核（`thread/list` + `thread/items/list`）
 * 与文件系统重算出来，代价只是一次对账（09 §4.1 的一致性校正本来每 10 分钟就跑一次）。
 * 拿这个代价换"用户永远不会因为索引坏了而打不开 App"，明显划算。
 */
export function migrateProjection(
  db: SqliteLike,
  /**
   * 迁移清单可注入。**这是为了让"失败后丢弃重建"这条路径能被真实测到** ——
   * 治理路径上的死代码是本项目栽过的坑：一段从没有测试走到过的恢复逻辑，
   * 等到真出事那天才第一次执行。
   */
  migrations: readonly Migration[] = PROJECTION_MIGRATIONS,
): MigrationOutcome {
  ensureMeta(db);
  const target = migrations.at(-1)?.version ?? 0;
  const from = readVersion(db, 'schema_version_projection');
  if (from === target) {
    return { kind: 'projection', from, to: from, applied: [], rebuilt: false };
  }

  try {
    const applied = inTransaction(db, () => {
      const done = applyMigrations(db, migrations, from);
      writeMeta(db, 'schema_version_projection', String(target));
      return done;
    });
    return { kind: 'projection', from, to: target, applied, rebuilt: false };
  } catch (err) {
    const reason = err instanceof Error ? err.name : 'UnknownError';
    // 重建同样在事务里：半张表的投影库比没有投影库更难排查
    inTransaction(db, () => {
      dropProjectionTables(db);
      // 重建用**内置清单**而不是传入的清单：走到这里意味着传入的那条路已经失败了，
      // 再拿它重建一次只会再失败一次。内置清单是"最新 schema 的建表语句"，永远可用。
      applyMigrations(db, PROJECTION_MIGRATIONS, 0);
      writeMeta(db, 'schema_version_projection', String(PROJECTION_VERSION));
    });
    return {
      kind: 'projection',
      from,
      to: PROJECTION_VERSION,
      applied: PROJECTION_MIGRATIONS.map((m) => m.version),
      rebuilt: true,
      warning: `投影表迁移失败（${reason}），已丢弃重建。任务状态与索引会在下一次对账时补齐。`,
    };
  }
}

/** 丢弃全部投影表。**公开**是为了让「重新扫描」这类功能能复用它，而不是各写一遍 DROP。 */
export function dropProjectionTables(db: SqliteLike): void {
  for (const table of PROJECTION_TABLES) {
    // FTS5 虚拟表也用 DROP TABLE
    db.exec(`DROP TABLE IF EXISTS ${table.name}`);
  }
}

export interface AuthoritativeMigrateOptions {
  /** 数据库文件路径。内存库传 undefined —— 那时跳过备份（没有文件可备份） */
  readonly dbPath?: string;
  /** 备份前先 checkpoint，把 WAL 落进主文件；否则拷出来的备份可能缺最近的写入 */
  readonly checkpoint?: (db: SqliteLike) => void;
  /** 迁移清单可注入，理由同 `migrateProjection` —— 回滚路径必须被测到 */
  readonly migrations?: readonly Migration[];
}

/**
 * 权威类迁移。**宁可启动失败也不丢定时任务定义**（09 §4.6 原话）。
 *
 * 两道防线，作用范围不同（这个区分是被测试逼出来的，见 `inTransaction` 的注释）：
 *
 * | 防线 | 管什么 | 不管什么 |
 * |---|---|---|
 * | **事务回滚**（主） | 迁移代码抛错、DDL 失败、约束冲突 | 进程被杀 |
 * | **文件备份**（副） | 进程在迁移中途被杀后，下次启动时有个东西可回滚 | 进程内的错误（那时连接还开着，拷文件无效） |
 *
 * 顺序：先备份（防被杀）→ 在事务里迁移（防出错）→ 失败则事务回滚 + 抛错中止启动。
 * **失败时不自动拷回备份文件** —— 连接还开着的情况下那个动作是无效的，
 * 而"看起来做了恢复其实没做"比"明确告诉你备份在哪"危险得多。
 */
export function migrateAuthoritative(
  db: SqliteLike,
  options: AuthoritativeMigrateOptions = {},
): MigrationOutcome {
  ensureMeta(db);
  const migrations = options.migrations ?? AUTHORITATIVE_MIGRATIONS;
  const target = migrations.at(-1)?.version ?? 0;
  const from = readVersion(db, 'schema_version_authoritative');
  if (from === target) {
    return { kind: 'authoritative', from, to: from, applied: [], rebuilt: false };
  }

  let backupPath: string | undefined;
  if (options.dbPath && existsSync(options.dbPath) && from > 0) {
    // from === 0 表示这是新库，没有可丢的东西，不必备份
    options.checkpoint?.(db);
    backupPath = `${options.dbPath}.bak.${from}`;
    copyFileSync(options.dbPath, backupPath);
  }

  try {
    const applied = inTransaction(db, () => {
      const done = applyMigrations(db, migrations, from);
      writeMeta(db, 'schema_version_authoritative', String(target));
      return done;
    });
    return {
      kind: 'authoritative',
      from,
      to: target,
      applied,
      rebuilt: false,
      ...(backupPath ? { backupPath } : {}),
    };
  } catch (err) {
    // 事务已回滚，库回到迁移前的状态。备份文件留着不删 ——
    // 它是"进程被杀"那条路径的唯一凭据，而我们无法区分"这次是出错"与"上次是被杀"。
    throw new AuthoritativeMigrationFailed(from, target, backupPath, err);
  }
}

/**
 * 从备份恢复。**必须在没有任何连接打开时调用** —— 这是它单独存在而不是被
 * `migrateAuthoritative` 内部调用的全部原因（内部调用时连接必然是开的，那时拷文件无效）。
 *
 * 调用点在启动流程里：检测到上次迁移中途被杀（有 `.bak.<n>` 且 meta 版本与之不一致）时，
 * 由启动代码关闭连接、恢复、再重新打开。
 */
export function restoreFromBackup(dbPath: string, backupPath: string): void {
  if (!existsSync(backupPath)) {
    throw new Error(`备份不存在：${backupPath}`);
  }
  copyFileSync(backupPath, dbPath);
  // WAL 与 shm 是旧库的，留着会与恢复出来的主文件不一致
  for (const suffix of ['-wal', '-shm']) {
    const sidecar = `${dbPath}${suffix}`;
    if (existsSync(sidecar)) unlinkSync(sidecar);
  }
}

export class AuthoritativeMigrationFailed extends Error {
  override readonly name = 'AuthoritativeMigrationFailed';
  constructor(
    readonly from: number,
    readonly to: number,
    readonly backupPath: string | undefined,
    override readonly cause: unknown,
  ) {
    super(
      `权威表迁移失败（${from} → ${to}），**事务已回滚**，库回到迁移前的状态。` +
        (backupPath
          ? `迁移前的整库备份在 ${backupPath}（它是防"进程被杀"的第二道防线，本次不需要用到它）。`
          : '本次没有产生备份（新库）。') +
        '启动被刻意中止：这些表里有定时任务定义、分享记录与审计留痕，丢一条都不该被静默接受（09 §4.6）。',
    );
  }
}

/** 清理旧备份。保留最近 `keep` 个 —— 备份是保险，不是归档。 */
export function pruneBackups(dbPath: string, versions: readonly number[], keep = 3): string[] {
  const removed: string[] = [];
  const sorted = [...versions].sort((a, b) => b - a);
  for (const version of sorted.slice(keep)) {
    const path = `${dbPath}.bak.${version}`;
    if (existsSync(path)) {
      unlinkSync(path);
      removed.push(path);
    }
  }
  return removed;
}
