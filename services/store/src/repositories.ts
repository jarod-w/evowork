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
    /**
     * 自动化列表页要的是**全部**，不只是启用的。
     *
     * `listActive` 是调度器用的（只有它该被触发），而 07 的列表页必须显示
     * 暂停与连败自动暂停的那些 —— 恰恰是它们需要用户去处理（Q8：连败 3 次自动 PAUSE）。
     * 隐藏它们等于让"我的定时任务怎么不跑了"没有任何入口。
     */
    listAll(deviceId: string): readonly AutomationRow[] {
      const rows = db
        .prepare('SELECT * FROM automation WHERE device_id = ? ORDER BY created_at DESC')
        .all(deviceId) as RawAutomation[];
      return rows.map(toAutomation);
    },

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

/**
 * 审计记录（10 §6）。**这一层此前整个不存在** —— `audit_log` 表在 schema 里，
 * hook 也在产出记录，但没有任何一处读写它，所以审计页会是一张永远空的表。
 *
 * ## 字段与 `AuditRecord` 是**同一张表的两面**
 *
 * 这里刻意不 import `@evowork/policy` 的 `AuditRecord`：store 是被它依赖的一侧，
 * 反过来 import 会成环。形状由 `audit_log` 的 DDL 定义，两边各自对着 DDL 写 ——
 * 而 `apps/desktop` 的 ingest 是唯一同时看到两者的地方，缝在那里最容易被发现。
 *
 * ## 只写不读就是死数据（10 §6 原话）
 *
 * Q1=A 之下没有企业后台替用户看审计，所以 `list` 与 `insert` 必须同时存在。
 * 只有 insert 的版本会长成"记了三个月、没人打开过"。
 */
export interface AuditLogRow {
  readonly id: number;
  readonly occurredAt: number;
  readonly action: string;
  readonly threadId?: string | undefined;
  readonly turnId?: string | undefined;
  readonly itemId?: string | undefined;
  readonly toolName?: string | undefined;
  readonly actionSummary?: string | undefined;
  readonly pathKind?: string | undefined;
  readonly pathDigest?: string | undefined;
  readonly networkTarget?: string | undefined;
  readonly approvalResult?: string | undefined;
  readonly decidedBy?: string | undefined;
  readonly guardianRisk?: string | undefined;
  readonly exitCode?: number | undefined;
  readonly tokenUsage?: number | undefined;
}

/** 写入用的形状：`id` 由表自增，其余与 `AuditLogRow` 相同。 */
export type AuditLogInput = Omit<AuditLogRow, 'id'>;

interface RawAudit {
  id: number;
  occurred_at: number;
  thread_id: string | null;
  turn_id: string | null;
  item_id: string | null;
  tool_name: string | null;
  action_summary: string | null;
  path_kind: string | null;
  path_digest: string | null;
  network_target: string | null;
  approval_result: string | null;
  decided_by: string | null;
  guardian_risk: string | null;
  exit_code: number | null;
  token_usage: number | null;
}

const opt = <T>(v: T | null): T | undefined => (v === null ? undefined : v);

export function createAuditRepo(db: SqliteLike) {
  return {
    /**
     * 追加一批记录。
     *
     * **`action` 落在 `tool_name` 上是刻意的**：DDL 里没有单独的 action 列
     * （它是 2026-09-05 定表时按"工具名 + 摘要"设计的），而 hook 产出的
     * `AuditRecord.action` 是分类值（`tool_call` / `approval` / …）。
     * 硬塞进 `action_summary` 会把分类和摘要混成一个字段，之后没法按类型筛。
     * 所以这里 `tool_name` 存 `toolName ?? action` —— 有工具名用工具名，
     * 没有的（会话开始/结束）用分类值，两者都是"这条记录是关于什么的"。
     */
    insertMany(records: readonly AuditLogInput[]): number {
      if (records.length === 0) return 0;
      const stmt = db.prepare(
        `INSERT INTO audit_log
           (occurred_at, thread_id, turn_id, item_id, tool_name, action_summary,
            path_kind, path_digest, network_target, approval_result, decided_by,
            guardian_risk, exit_code, token_usage)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const r of records) {
        stmt.run(
          r.occurredAt,
          r.threadId ?? null,
          r.turnId ?? null,
          r.itemId ?? null,
          r.toolName ?? r.action,
          r.actionSummary ?? null,
          r.pathKind ?? null,
          r.pathDigest ?? null,
          r.networkTarget ?? null,
          r.approvalResult ?? null,
          r.decidedBy ?? null,
          r.guardianRisk ?? null,
          r.exitCode ?? null,
          r.tokenUsage ?? null,
        );
      }
      return records.length;
    },

    /** 最近的记录，新的在前（审计页按时间倒序读）。 */
    list(limit = 200): readonly AuditLogRow[] {
      const rows = db
        .prepare('SELECT * FROM audit_log ORDER BY occurred_at DESC, id DESC LIMIT ?')
        .all(limit) as RawAudit[];
      return rows.map((raw) => ({
        id: raw.id,
        occurredAt: raw.occurred_at,
        action: raw.tool_name ?? 'unknown',
        threadId: opt(raw.thread_id),
        turnId: opt(raw.turn_id),
        itemId: opt(raw.item_id),
        toolName: opt(raw.tool_name),
        actionSummary: opt(raw.action_summary),
        pathKind: opt(raw.path_kind),
        pathDigest: opt(raw.path_digest),
        networkTarget: opt(raw.network_target),
        approvalResult: opt(raw.approval_result),
        decidedBy: opt(raw.decided_by),
        guardianRisk: opt(raw.guardian_risk),
        exitCode: opt(raw.exit_code),
        tokenUsage: opt(raw.token_usage),
      }));
    },

    /** 最早一条的时间（审计页显示"保留 N 天，最早到 X"）。空库返回 undefined。 */
    oldestAt(): number | undefined {
      const row = db.prepare('SELECT MIN(occurred_at) AS at FROM audit_log').get() as
        | {
            at: number | null;
          }
        | undefined;
      return row?.at ?? undefined;
    },

    /** 过期清理（10 §6 的保留期）。返回删掉几条。 */
    deleteBefore(cutoff: number): number {
      const before = (
        db.prepare('SELECT COUNT(*) AS n FROM audit_log WHERE occurred_at < ?').get(cutoff) as {
          n: number;
        }
      ).n;
      db.prepare('DELETE FROM audit_log WHERE occurred_at < ?').run(cutoff);
      return before;
    },
  };
}

export type AuditRepo = ReturnType<typeof createAuditRepo>;

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

    /**
     * 资料库的「本地产物」一栏（06 §3）：**全部工作空间**里还在的产物，最近的在前。
     *
     * 与 `listPresent(root)` 分开而不是给它一个可选参数：那个方法是**对账**用的
     * （拿一个目录下我们以为存在的记录，去和磁盘比对），传空前缀会让它悄悄
     * 变成"对账整个库"——两个用途的分页与排序要求完全不同。
     */
    listAllPresent(limit = 200): readonly ArtifactRow[] {
      const rows = db
        .prepare(
          "SELECT * FROM artifact WHERE file_state = 'PRESENT' ORDER BY created_at DESC LIMIT ?",
        )
        .all(limit) as RawArtifact[];
      return rows.map(toArtifact);
    },

    /**
     * 「项目」页要的 feed（02 §4.3 / C2）：**保留完整版本链，不加 LIMIT**。
     *
     * 不能复用 `listAllPresent`：那个方法是为资料库「本地产物」一栏写的——
     * 只挑 `PRESENT`、按全仓库 200 条封顶。项目卡片的产物数要*先*按 path 折成
     * 最高 version 那一行、*再*看那一行是不是 `PRESENT`
     * （`@evowork/projects` 的 `buildProjectCard`）——折算需要看见整条版本链，
     * 一个「建了又删」的文件是 v1 PRESENT + v2 MISSING，喂 `listAllPresent` 的话
     * v2 那行进不来，v1 就会被误算成"还在"。
     *
     * 也不能封顶：项目页问的是"这一个空间下"的产物，不是"全仓库最近 200 条"——
     * 仓库里产物一多，200 条会先被别的空间占满，这个空间自己反而报「0 个产物」。
     *
     * `readProjectDetail` 的「最近的文件动作」也读这同一个 feed，且**正需要**
     * 每一条版本变化本身（创建/修改/删除/移动都是一条"动作"），不该在这里
     * 先按状态过滤掉——过滤掉的话删除/移动就永远进不了那张表（D-P6）。
     */
    listAllForProjects(): readonly ArtifactRow[] {
      const rows = db
        .prepare('SELECT * FROM artifact ORDER BY created_at DESC')
        .all() as RawArtifact[];
      return rows.map(toArtifact);
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

/* ─────────────────────────── project_local ─────────────────────────── */

export interface ProjectLocalRow {
  readonly id: string;
  readonly name: string;
  /** 内核镜像成功才有（spec §2.3）。缺席是正常状态，不是错误 */
  readonly kernelId?: string | undefined;
  readonly roots: readonly string[];
  readonly createdAt: number;
  readonly updatedAt: number;
}

interface RawProjectLocal {
  id: string;
  name: string;
  kernel_id: string | null;
  created_at: number;
  updated_at: number;
}

/**
 * 工作空间的读写。
 *
 * 与 automation / artifact 一样是**权威类**：没有"重建"这条路，只有老实的 CRUD。
 * `roots` 在另一张表里（D-P2：结构留多根），所以每次读都要跟着查一次 ——
 * 空间数量是个位数到几十，这点代价换的是以后放开多根不用迁移。
 */
export function createProjectRepo(db: SqliteLike) {
  const rootsOf = (projectId: string): readonly string[] =>
    (
      db
        .prepare('SELECT path FROM project_root WHERE project_id = ? ORDER BY position ASC')
        .all(projectId) as { path: string }[]
    ).map((r) => r.path);

  const toRow = (raw: RawProjectLocal): ProjectLocalRow => ({
    id: raw.id,
    name: raw.name,
    ...(raw.kernel_id === null ? {} : { kernelId: raw.kernel_id }),
    roots: rootsOf(raw.id),
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
  });

  return {
    /** 倒序：刚建的空间在最前面 */
    list(): readonly ProjectLocalRow[] {
      const raws = db
        .prepare('SELECT * FROM project_local ORDER BY created_at DESC')
        .all() as RawProjectLocal[];
      return raws.map(toRow);
    },

    get(id: string): ProjectLocalRow | undefined {
      const raw = db.prepare('SELECT * FROM project_local WHERE id = ?').get(id) as
        RawProjectLocal | undefined;
      return raw ? toRow(raw) : undefined;
    },

    insert(row: ProjectLocalRow): void {
      db.prepare(
        `INSERT INTO project_local (id, name, kernel_id, created_at, updated_at)
         VALUES (?,?,?,?,?)`,
      ).run(row.id, row.name, row.kernelId ?? null, row.createdAt, row.updatedAt);
      row.roots.forEach((path, position) => {
        db.prepare(
          `INSERT OR IGNORE INTO project_root (project_id, path, position) VALUES (?,?,?)`,
        ).run(row.id, path, position);
      });
    },

    rename(id: string, name: string, updatedAt: number): void {
      db.prepare('UPDATE project_local SET name = ?, updated_at = ? WHERE id = ?').run(
        name,
        updatedAt,
        id,
      );
    },

    setKernelId(id: string, kernelId: string): void {
      db.prepare('UPDATE project_local SET kernel_id = ? WHERE id = ?').run(kernelId, id);
    },

    /**
     * 移除空间。**只删这两张表的行** —— 不碰磁盘文件，也不碰 artifact 索引。
     * 「从列表移除」在 02 §4.3 里是解绑，不是删除。
     */
    remove(id: string): void {
      db.prepare('DELETE FROM project_root WHERE project_id = ?').run(id);
      db.prepare('DELETE FROM project_local WHERE id = ?').run(id);
    },
  };
}

export type ProjectRepo = ReturnType<typeof createProjectRepo>;
