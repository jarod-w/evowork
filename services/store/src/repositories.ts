/**
 * automation 与 artifact 两张权威表的读写。
 *
 * 它们与 `ThreadProjection` 的区别在类别上：**权威类**（09 §4）——
 * 丢了就是丢了定时任务定义与产物索引，推不回来。所以这里没有"重建"这条路，
 * 只有老实的 CRUD。
 *
 * ## 为什么是独立的工厂函数而不是挂在 `Store` 上
 *
 * `Store` 现在的形状是"协议事件流要用的东西"，而这两张表是**别的服务**在用
 * （scheduler 与 artifacts）。挂上去会让每个 import `Store` 的地方都拖上它们的类型。
 * 拿 `db` 组一个 repo 出来，依赖方向更干净。
 */

import type { SqliteLike } from './migrate.js';

/* ─────────────────────────── automation ─────────────────────────── */

export interface AutomationRow {
  readonly id: string;
  readonly name: string;
  readonly prompt: string;
  readonly deviceId: string;
  readonly schedule: string;
  readonly timezone: string;
  readonly status: 'ACTIVE' | 'PAUSED';
  readonly misfirePolicy: 'FIRE_ONCE_ON_WAKE' | 'FIRE_ALL' | 'DROP';
  readonly catchupWindowMs: number;
  readonly consecutiveFailures: number;
  readonly lastFireTime?: number | undefined;
  readonly validFrom?: number | undefined;
  readonly validUntil?: number | undefined;
  readonly budgetLimit: number;
  readonly workspaces: readonly string[];
}

interface RawAutomation {
  id: string;
  name: string;
  prompt: string;
  device_id: string;
  schedule: string;
  timezone: string;
  status: string;
  misfire_policy: string;
  catchup_window_ms: number;
  consecutive_failures: number;
  last_fire_time: number | null;
  valid_from: number | null;
  valid_until: number | null;
  budget_limit: number;
  workspaces: string;
}

function toAutomation(raw: RawAutomation): AutomationRow {
  return {
    id: raw.id,
    name: raw.name,
    prompt: raw.prompt,
    deviceId: raw.device_id,
    schedule: raw.schedule,
    timezone: raw.timezone,
    status: raw.status === 'PAUSED' ? 'PAUSED' : 'ACTIVE',
    misfirePolicy: raw.misfire_policy as AutomationRow['misfirePolicy'],
    catchupWindowMs: raw.catchup_window_ms,
    consecutiveFailures: raw.consecutive_failures,
    ...(raw.last_fire_time === null ? {} : { lastFireTime: raw.last_fire_time }),
    ...(raw.valid_from === null ? {} : { validFrom: raw.valid_from }),
    ...(raw.valid_until === null ? {} : { validUntil: raw.valid_until }),
    budgetLimit: raw.budget_limit,
    workspaces: JSON.parse(raw.workspaces) as string[],
  };
}

export function createAutomationRepo(db: SqliteLike) {
  return {
    get(id: string): AutomationRow | undefined {
      const raw = db.prepare('SELECT * FROM automation WHERE id = ?').get(id) as
        RawAutomation | undefined;
      return raw ? toAutomation(raw) : undefined;
    },

    /** 只列**本机绑定**且未暂停的（Q15：其他设备只读，不触发）。 */
    listActive(deviceId: string): readonly AutomationRow[] {
      const rows = db
        .prepare("SELECT * FROM automation WHERE device_id = ? AND status = 'ACTIVE'")
        .all(deviceId) as RawAutomation[];
      return rows.map(toAutomation);
    },

    updateAutomation(
      id: string,
      patch: {
        readonly status?: 'ACTIVE' | 'PAUSED';
        readonly consecutiveFailures?: number;
        readonly lastFireTime?: number;
        readonly deviceId?: string;
      },
    ): void {
      const sets: string[] = [];
      const values: unknown[] = [];
      if (patch.status !== undefined) {
        sets.push('status = ?');
        values.push(patch.status);
      }
      if (patch.consecutiveFailures !== undefined) {
        sets.push('consecutive_failures = ?');
        values.push(patch.consecutiveFailures);
      }
      if (patch.lastFireTime !== undefined) {
        sets.push('last_fire_time = ?');
        values.push(patch.lastFireTime);
      }
      if (patch.deviceId !== undefined) {
        sets.push('device_id = ?');
        values.push(patch.deviceId);
      }
      if (sets.length === 0) return;
      sets.push('updated_at = ?');
      values.push(Date.now(), id);
      db.prepare(`UPDATE automation SET ${sets.join(', ')} WHERE id = ?`).run(...values);
    },

    /**
     * 落一条执行记录。
     *
     * **返回 false 表示幂等键冲突** —— `ix_run_idem` 是
     * `(automation_id, fire_time, trigger)` 的唯一索引，所以"这一次已经处理过"
     * 就是一次插入冲突（09 §6.2：单机不需要分布式锁）。
     * `INSERT OR IGNORE` + `changes` 比先查后写少一个竞态。
     *
     * `trigger` 在键里的理由见 `schema.ts` 上那条注释：MISSED 与补跑共享 fire_time。
     */
    insertRun(record: {
      readonly automationId: string;
      readonly fireTime: number;
      readonly status: string;
      readonly trigger: string;
      readonly skipReason?: string | undefined;
      readonly originalFireTime?: number | undefined;
      readonly threadId?: string | undefined;
      readonly startedAt: number;
    }): boolean {
      const result = db
        .prepare(
          `INSERT OR IGNORE INTO automation_run
             (id, automation_id, fire_time, thread_id, status, skip_reason, trigger, original_fire_time, started_at)
           VALUES (?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          // 主键要跟唯一索引同口径，否则冲突会先撞主键、报的错也对不上
          `run_${record.automationId}_${record.fireTime}_${record.trigger}`,
          record.automationId,
          record.fireTime,
          record.threadId ?? null,
          record.status,
          record.skipReason ?? null,
          record.trigger,
          record.originalFireTime ?? null,
          record.startedAt,
        );
      // `SqliteLike.run` 的返回是 unknown（它要同时兼容 node:sqlite 与测试替身）。
      // `changes` 是两者都有的字段，这里只读它
      const changes = (result as { changes?: number } | undefined)?.changes ?? 0;
      return changes > 0;
    },

    finishRun(input: {
      readonly automationId: string;
      readonly fireTime: number;
      readonly status: 'SUCCEEDED' | 'FAILED';
      readonly failureClass?: string | undefined;
      readonly threadId?: string | undefined;
      readonly tokenUsage?: number | undefined;
      readonly errorSummary?: string | undefined;
      readonly finishedAt: number;
    }): void {
      db.prepare(
        `UPDATE automation_run
            SET status = ?, failure_class = ?, thread_id = COALESCE(?, thread_id),
                token_usage = ?, error_summary = ?, finished_at = ?
          WHERE automation_id = ? AND fire_time = ? AND status NOT IN ('MISSED', 'SKIPPED')`,
      ).run(
        input.status,
        input.failureClass ?? null,
        input.threadId ?? null,
        input.tokenUsage ?? null,
        // error_summary 是**分类后的一句话**，不是原始错误（可能含正文，Q14 同口径）
        input.errorSummary ?? null,
        input.finishedAt,
        input.automationId,
        input.fireTime,
      );
    },

    /** 执行历史（07 §5）。倒序，供详情页分页。 */
    listRuns(automationId: string, limit = 50): readonly Record<string, unknown>[] {
      return db
        .prepare(
          'SELECT * FROM automation_run WHERE automation_id = ? ORDER BY fire_time DESC LIMIT ?',
        )
        .all(automationId, limit) as Record<string, unknown>[];
    },
  };
}

export type AutomationRepo = ReturnType<typeof createAutomationRepo>;

/* ─────────────────────────── artifact ─────────────────────────── */

export interface ArtifactRow {
  readonly id: string;
  readonly threadId?: string | undefined;
  readonly turnId?: string | undefined;
  readonly automationId?: string | undefined;
  readonly path: string;
  readonly artifactType: string;
  readonly outputFormat: string;
  readonly title: string;
  readonly operationKind: string;
  readonly sizeBytes?: number | undefined;
  readonly contentHash?: string | undefined;
  readonly version: number;
  readonly supersedesId?: string | undefined;
  readonly sourceSignal: string;
  readonly fileState: 'PRESENT' | 'MISSING' | 'MOVED';
  readonly shareId?: string | undefined;
  readonly createdAt: number;
}

interface RawArtifact {
  id: string;
  thread_id: string | null;
  turn_id: string | null;
  automation_id: string | null;
  path: string;
  artifact_type: string;
  output_format: string | null;
  title: string | null;
  operation_kind: string | null;
  size_bytes: number | null;
  content_hash: string | null;
  version: number;
  supersedes_id: string | null;
  source_signal: string;
  file_state: string;
  share_id: string | null;
  created_at: number;
}

function toArtifact(raw: RawArtifact): ArtifactRow {
  return {
    id: raw.id,
    ...(raw.thread_id === null ? {} : { threadId: raw.thread_id }),
    ...(raw.turn_id === null ? {} : { turnId: raw.turn_id }),
    ...(raw.automation_id === null ? {} : { automationId: raw.automation_id }),
    path: raw.path,
    artifactType: raw.artifact_type,
    outputFormat: raw.output_format ?? '',
    title: raw.title ?? raw.path,
    operationKind: raw.operation_kind ?? 'create',
    ...(raw.size_bytes === null ? {} : { sizeBytes: raw.size_bytes }),
    ...(raw.content_hash === null ? {} : { contentHash: raw.content_hash }),
    version: raw.version,
    ...(raw.supersedes_id === null ? {} : { supersedesId: raw.supersedes_id }),
    sourceSignal: raw.source_signal,
    fileState: raw.file_state as ArtifactRow['fileState'],
    ...(raw.share_id === null ? {} : { shareId: raw.share_id }),
    createdAt: raw.created_at,
  };
}

export function createArtifactRepo(db: SqliteLike) {
  return {
    /** 某个路径的最新一版（版本链的头）。 */
    latestFor(path: string): ArtifactRow | undefined {
      const raw = db
        .prepare(
          "SELECT * FROM artifact WHERE path = ? AND file_state != 'MISSING' ORDER BY version DESC LIMIT 1",
        )
        .get(path) as RawArtifact | undefined;
      return raw ? toArtifact(raw) : undefined;
    },

    insert(record: ArtifactRow): void {
      db.prepare(
        `INSERT INTO artifact
           (id, thread_id, turn_id, automation_id, path, artifact_type, output_format, title,
            operation_kind, size_bytes, content_hash, version, supersedes_id, source_signal,
            file_state, share_id, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        record.id,
        record.threadId ?? null,
        record.turnId ?? null,
        record.automationId ?? null,
        record.path,
        record.artifactType,
        record.outputFormat,
        record.title,
        record.operationKind,
        record.sizeBytes ?? null,
        record.contentHash ?? null,
        record.version,
        record.supersedesId ?? null,
        record.sourceSignal,
        record.fileState,
        record.shareId ?? null,
        record.createdAt,
      );
    },

    /**
     * 元数据订正：同一条记录、同一版本，只改类型/标题/来源这类"谁说的"信息。
     *
     * 与 `insert` 分开是因为它**不产生新版本** —— 内容没变，变的是我们对它的认识
     * （见 `@evowork/artifacts` 的 `RecognizeOutcome.corrected`）。
     */
    update(record: ArtifactRow): void {
      db.prepare(
        `UPDATE artifact
            SET artifact_type = ?, output_format = ?, title = ?, operation_kind = ?, source_signal = ?
          WHERE id = ?`,
      ).run(
        record.artifactType,
        record.outputFormat,
        record.title,
        record.operationKind,
        record.sourceSignal,
        record.id,
      );
    },

    /** 这个工作空间下当前认为存在的记录（对账要用）。 */
    listPresent(root: string): readonly ArtifactRow[] {
      const rows = db
        .prepare("SELECT * FROM artifact WHERE path LIKE ? AND file_state = 'PRESENT'")
        .all(`${root}%`) as RawArtifact[];
      return rows.map(toArtifact);
    },

    setFileState(id: string, state: ArtifactRow['fileState'], path?: string): void {
      if (path === undefined) {
        db.prepare('UPDATE artifact SET file_state = ? WHERE id = ?').run(state, id);
        return;
      }
      db.prepare('UPDATE artifact SET file_state = ?, path = ? WHERE id = ?').run(state, path, id);
    },

    /** 结果区「产物」与资料库「本地产物」都读它。 */
    listForThread(threadId: string): readonly ArtifactRow[] {
      const rows = db
        .prepare('SELECT * FROM artifact WHERE thread_id = ? ORDER BY created_at DESC')
        .all(threadId) as RawArtifact[];
      return rows.map(toArtifact);
    },

    attachShare(artifactId: string, shareId: string | null): void {
      db.prepare('UPDATE artifact SET share_id = ? WHERE id = ?').run(shareId, artifactId);
    },
  };
}

export type ArtifactRepo = ReturnType<typeof createArtifactRepo>;
