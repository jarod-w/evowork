/**
 * `thread_projection` 的读写（09 §4.1）。
 *
 * **权威性规则**（09 §4.1 原话）：`title` / `cwd` / `archived` 的真源是内核，投影表只是缓存；
 * `derived_status` 及其后的字段真源是投影表。因此筛选时的顺序是固定的：
 *
 *   ① 在 sqlite 里按条件查出 thread_id 集合（状态、日期这些内核给不了的条件）
 *   ② 再用 `thread/list` 拉这批的权威元数据渲染
 *
 * **不要反过来**（先全量拉再本地过滤）：上千任务时会卡（04 §3.4 的实现要点）。
 * 所以本文件只提供 `queryThreadIds()` 这种"返回 id 集合"的查询，
 * 不提供"返回完整任务对象"的查询 —— 后者会诱导人跳过第 ② 步。
 */
import type { Thread, ThreadStatus, ThreadTokenUsage, TurnStatus } from '@evowork/protocol';

import { deriveStatus } from './derive-status.js';
import type { SqliteLike } from './migrate.js';
import type { DerivedStatus } from './schema.js';

export interface ProjectionRow {
  thread_id: string;
  title: string | null;
  cwd: string | null;
  project_id: string | null;
  section_id: string | null;
  derived_status: DerivedStatus;
  last_turn_status: TurnStatus | null;
  last_turn_id: string | null;
  scenario_id: string | null;
  mode_id: string | null;
  permission_id: string | null;
  model: string | null;
  plan_confirmed: number;
  has_plan_item: number;
  automation_id: string | null;
  artifact_count: number;
  token_input: number;
  token_output: number;
  token_cached: number;
  cost_estimate: number;
  budget_limit: number | null;
  share_id: string | null;
  first_message: string | null;
  parent_thread_id: string | null;
  created_at: number | null;
  updated_at: number | null;
  recency_at: number | null;
  archived: number;
}

/** EvoWork 侧的任务初值（场景 / 模式 / 权限 / 预算），thread 创建时一次性写入。 */
export interface ThreadOrigin {
  readonly scenarioId?: string;
  readonly modeId?: string;
  readonly permissionId?: string;
  readonly automationId?: string;
  readonly budgetLimit?: number;
}

export interface ThreadFilter {
  /** 多选状态。这是投影表存在的主要理由（04 §3.4） */
  readonly statuses?: readonly DerivedStatus[];
  /** 时间范围（毫秒时间戳），按 updated_at */
  readonly updatedAfter?: number;
  readonly updatedBefore?: number;
  readonly cwd?: string;
  readonly projectId?: string;
  readonly automationId?: string;
  /** 是否有产物（08 §2 的索引 join） */
  readonly hasArtifact?: boolean;
  readonly archived?: boolean;
  /** 只看顶层任务：子任务不出现在顶层列表（04 §3.2） */
  readonly topLevelOnly?: boolean;
  readonly limit?: number;
  readonly offset?: number;
}

const COLUMNS = [
  'thread_id',
  'title',
  'cwd',
  'project_id',
  'section_id',
  'derived_status',
  'last_turn_status',
  'last_turn_id',
  'scenario_id',
  'mode_id',
  'permission_id',
  'model',
  'plan_confirmed',
  'has_plan_item',
  'automation_id',
  'artifact_count',
  'token_input',
  'token_output',
  'token_cached',
  'cost_estimate',
  'budget_limit',
  'share_id',
  'first_message',
  'parent_thread_id',
  'created_at',
  'updated_at',
  'recency_at',
  'archived',
] as const;

export class ThreadProjection {
  constructor(private readonly db: SqliteLike) {}

  get(threadId: string): ProjectionRow | undefined {
    return this.db
      .prepare(`SELECT ${COLUMNS.join(', ')} FROM thread_projection WHERE thread_id = ?`)
      .get(threadId) as ProjectionRow | undefined;
  }

  /**
   * 从内核的 `Thread` 更新投影行。
   *
   * 只覆盖**内核权威**的字段（title / cwd / archived / model / 时间戳 / section / project），
   * 不动 EvoWork 自己的字段（scenario / mode / budget / artifact_count）——
   * 否则每次对账都会把用户在任务里改过的模式冲掉。
   */
  upsertFromThread(thread: Thread, origin: ThreadOrigin = {}): DerivedStatus {
    const existing = this.get(thread.id);
    const modeId = origin.modeId ?? existing?.mode_id ?? null;
    const derived = deriveStatus({
      threadStatus: thread.status,
      lastTurnStatus: existing?.last_turn_status ?? lastTurnStatusOf(thread),
      archived: existing ? existing.archived === 1 : false,
      modeId,
      hasPlanItem: existing?.has_plan_item === 1,
      planConfirmed: existing?.plan_confirmed === 1,
    });

    this.db
      .prepare(
        `INSERT INTO thread_projection (
           thread_id, title, cwd, project_id, section_id, derived_status, last_turn_status,
           last_turn_id, scenario_id, mode_id, permission_id, model, automation_id,
           budget_limit, first_message, parent_thread_id, created_at, updated_at, recency_at
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(thread_id) DO UPDATE SET
           title = excluded.title,
           cwd = excluded.cwd,
           project_id = excluded.project_id,
           section_id = excluded.section_id,
           derived_status = excluded.derived_status,
           model = excluded.model,
           parent_thread_id = excluded.parent_thread_id,
           updated_at = excluded.updated_at,
           recency_at = excluded.recency_at,
           -- EvoWork 自己的字段：只在原来为空时填（不覆盖用户在任务里改过的值）
           scenario_id = COALESCE(thread_projection.scenario_id, excluded.scenario_id),
           mode_id = COALESCE(thread_projection.mode_id, excluded.mode_id),
           permission_id = COALESCE(thread_projection.permission_id, excluded.permission_id),
           automation_id = COALESCE(thread_projection.automation_id, excluded.automation_id),
           budget_limit = COALESCE(thread_projection.budget_limit, excluded.budget_limit),
           first_message = COALESCE(thread_projection.first_message, excluded.first_message)`,
      )
      .run(
        thread.id,
        thread.name ?? null,
        thread.cwd,
        thread.projectId ?? null,
        thread.section?.id ?? null,
        derived,
        existing?.last_turn_status ?? lastTurnStatusOf(thread),
        existing?.last_turn_id ?? lastTurnIdOf(thread),
        origin.scenarioId ?? null,
        modeId,
        origin.permissionId ?? null,
        thread.model ?? null,
        origin.automationId ?? null,
        origin.budgetLimit ?? null,
        thread.preview || null,
        thread.parentThreadId ?? null,
        toMs(thread.createdAt),
        toMs(thread.updatedAt),
        toMs(thread.recencyAt ?? thread.updatedAt),
      );
    return derived;
  }

  /** `thread/status/changed`（09 §3.4）。 */
  applyStatusChanged(threadId: string, status: ThreadStatus, now = Date.now()): DerivedStatus {
    const row = this.get(threadId);
    const derived = deriveStatus({
      threadStatus: status,
      lastTurnStatus: row?.last_turn_status ?? null,
      archived: row?.archived === 1,
      modeId: row?.mode_id ?? null,
      hasPlanItem: row?.has_plan_item === 1,
      planConfirmed: row?.plan_confirmed === 1,
    });
    this.#patch(threadId, { derived_status: derived, updated_at: now, recency_at: now });
    return derived;
  }

  /**
   * `turn/completed`（09 §3.4）—— **这是"已完成 / 失败 / 已中断"三态唯一的来源**。
   * 内核的 `ThreadStatus` 里没有它们（F7），不记在这里就永远推不出来。
   */
  applyTurnCompleted(
    threadId: string,
    turn: { readonly id: string; readonly status: TurnStatus },
    now = Date.now(),
  ): DerivedStatus {
    const row = this.get(threadId);
    const derived = deriveStatus({
      // turn 结束时内核尚未必发出 status/changed，这里按"不再 active"推
      threadStatus: 'idle',
      lastTurnStatus: turn.status,
      archived: row?.archived === 1,
      modeId: row?.mode_id ?? null,
      hasPlanItem: row?.has_plan_item === 1,
      planConfirmed: row?.plan_confirmed === 1,
    });
    this.#patch(threadId, {
      derived_status: derived,
      last_turn_status: turn.status,
      last_turn_id: turn.id,
      updated_at: now,
      recency_at: now,
    });
    return derived;
  }

  /** `turn/plan/updated`：出现计划 → 可能进入"规划中"（04 §2.2）。 */
  applyPlanUpdated(threadId: string, hasSteps: boolean, now = Date.now()): DerivedStatus {
    const row = this.get(threadId);
    this.#patch(threadId, { has_plan_item: hasSteps ? 1 : 0, updated_at: now });
    const derived = deriveStatus({
      threadStatus: row ? null : null,
      lastTurnStatus: row?.last_turn_status ?? null,
      archived: row?.archived === 1,
      modeId: row?.mode_id ?? null,
      hasPlanItem: hasSteps,
      planConfirmed: row?.plan_confirmed === 1,
    });
    this.#patch(threadId, { derived_status: derived });
    return derived;
  }

  /** 用户点了「确认执行」（Plan 模式的确认点，04 §5.2 #4）。 */
  markPlanConfirmed(threadId: string, now = Date.now()): void {
    this.#patch(threadId, { plan_confirmed: 1, updated_at: now });
  }

  /** `thread/tokenUsage/updated`：累计用量，供预算闸门与用量条使用（10 §5.2）。 */
  applyTokenUsage(threadId: string, usage: ThreadTokenUsage, now = Date.now()): void {
    const total = usage.total ?? {};
    this.#patch(threadId, {
      token_input: total.inputTokens ?? 0,
      token_output: total.outputTokens ?? 0,
      token_cached: total.cachedInputTokens ?? 0,
      updated_at: now,
    });
  }

  setArchived(threadId: string, archived: boolean, now = Date.now()): DerivedStatus {
    const row = this.get(threadId);
    const derived = archived
      ? 'archived'
      : deriveStatus({
          threadStatus: null,
          lastTurnStatus: row?.last_turn_status ?? null,
          archived: false,
          modeId: row?.mode_id ?? null,
          hasPlanItem: row?.has_plan_item === 1,
          planConfirmed: row?.plan_confirmed === 1,
        });
    this.#patch(threadId, {
      archived: archived ? 1 : 0,
      derived_status: derived,
      updated_at: now,
    });
    return derived;
  }

  setTaskSettings(
    threadId: string,
    settings: {
      readonly scenarioId?: string;
      readonly modeId?: string;
      readonly permissionId?: string;
      readonly model?: string;
      readonly budgetLimit?: number | null;
    },
  ): void {
    const patch: Record<string, unknown> = {};
    if (settings.scenarioId !== undefined) patch.scenario_id = settings.scenarioId;
    if (settings.modeId !== undefined) patch.mode_id = settings.modeId;
    if (settings.permissionId !== undefined) patch.permission_id = settings.permissionId;
    if (settings.model !== undefined) patch.model = settings.model;
    if (settings.budgetLimit !== undefined) patch.budget_limit = settings.budgetLimit;
    if (Object.keys(patch).length > 0) this.#patch(threadId, patch);
  }

  incrementArtifactCount(threadId: string, delta = 1): void {
    this.db
      .prepare(
        `UPDATE thread_projection SET artifact_count = MAX(0, artifact_count + ?) WHERE thread_id = ?`,
      )
      .run(delta, threadId);
  }

  remove(threadId: string): void {
    this.db.prepare(`DELETE FROM thread_projection WHERE thread_id = ?`).run(threadId);
  }

  /**
   * 按条件查出 thread_id 集合 —— 筛选流程的第 ① 步（04 §3.4）。
   *
   * 返回 id 而不是完整行是刻意的：投影表的 title 可能过期（内核是真源），
   * 让调用方必须走第 ② 步去拉权威字段。
   */
  queryThreadIds(filter: ThreadFilter = {}): string[] {
    const where: string[] = [];
    const params: unknown[] = [];

    if (filter.statuses && filter.statuses.length > 0) {
      where.push(`derived_status IN (${filter.statuses.map(() => '?').join(',')})`);
      params.push(...filter.statuses);
    }
    if (filter.updatedAfter !== undefined) {
      where.push('updated_at >= ?');
      params.push(filter.updatedAfter);
    }
    if (filter.updatedBefore !== undefined) {
      where.push('updated_at <= ?');
      params.push(filter.updatedBefore);
    }
    if (filter.cwd !== undefined) {
      where.push('cwd = ?');
      params.push(filter.cwd);
    }
    if (filter.projectId !== undefined) {
      where.push('project_id = ?');
      params.push(filter.projectId);
    }
    if (filter.automationId !== undefined) {
      where.push('automation_id = ?');
      params.push(filter.automationId);
    }
    if (filter.hasArtifact === true) where.push('artifact_count > 0');
    if (filter.hasArtifact === false) where.push('artifact_count = 0');
    if (filter.archived !== undefined) {
      where.push('archived = ?');
      params.push(filter.archived ? 1 : 0);
    } else {
      // 默认不带归档：归档任务的入口是「更多 → 数据管理」（02 §4.7），不在任务列表里
      where.push('archived = 0');
    }
    if (filter.topLevelOnly) where.push('parent_thread_id IS NULL');

    const limit = filter.limit ?? 200;
    const offset = filter.offset ?? 0;
    // 排序带 thread_id 兜底：同一毫秒创建的任务（批量导入、定时任务同时触发）在只按时间排序时
    // 顺序是不确定的，UI 上的表现是列表在两次渲染之间跳动。加一个稳定的第二排序键即可消除。
    const sql =
      `SELECT thread_id FROM thread_projection` +
      (where.length ? ` WHERE ${where.join(' AND ')}` : '') +
      ` ORDER BY COALESCE(recency_at, updated_at, created_at) DESC, thread_id ASC LIMIT ? OFFSET ?`;

    return (this.db.prepare(sql).all(...params, limit, offset) as { thread_id: string }[]).map(
      (r) => r.thread_id,
    );
  }

  /** 筛选生效时侧边栏要显示「任务 (12 / 148)」（04 §3.4） */
  count(filter: ThreadFilter = {}): number {
    const ids = this.queryThreadIds({ ...filter, limit: 1_000_000, offset: 0 });
    return ids.length;
  }

  countByStatus(): Record<string, number> {
    const rows = this.db
      .prepare(
        `SELECT derived_status AS status, COUNT(*) AS n FROM thread_projection WHERE archived = 0 GROUP BY derived_status`,
      )
      .all() as { status: string; n: number }[];
    return Object.fromEntries(rows.map((r) => [r.status, r.n]));
  }

  /** 对账用：投影表里有、但内核已经没有的 thread（09 §4.1 的一致性校正） */
  idsNotIn(knownIds: readonly string[]): string[] {
    const all = this.db.prepare(`SELECT thread_id FROM thread_projection`).all() as {
      thread_id: string;
    }[];
    const known = new Set(knownIds);
    return all.map((r) => r.thread_id).filter((id) => !known.has(id));
  }

  #patch(threadId: string, patch: Record<string, unknown>): void {
    const keys = Object.keys(patch);
    if (keys.length === 0) return;
    const sql = `UPDATE thread_projection SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE thread_id = ?`;
    this.db.prepare(sql).run(...keys.map((k) => patch[k]), threadId);
  }
}

/** 内核时间戳是**秒**（`created_at` / `updated_at` 的注释明写），我们统一用毫秒。 */
function toMs(seconds: number | null | undefined): number | null {
  if (seconds === null || seconds === undefined) return null;
  return seconds < 1e12 ? Math.round(seconds * 1000) : Math.round(seconds);
}

function lastTurnStatusOf(thread: Thread): TurnStatus | null {
  const last = thread.turns.at(-1);
  return last?.status ?? null;
}

function lastTurnIdOf(thread: Thread): string | null {
  return thread.turns.at(-1)?.id ?? null;
}
