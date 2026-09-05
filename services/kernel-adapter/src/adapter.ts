/**
 * 适配层的语义化 API（09 §3.1）。
 *
 * 前端只调这里，不调 app-server —— 这是 K2 的执行方式。四条职责逐条落在下面的方法上：
 * 收敛实验方法、展开 EvoWork 概念、合并数据源、降级与兜底。
 *
 * ## 一处对文档的修订：筛选的第 ② 步（04 §3.4）
 *
 * 04 §3.4 的实现要点写「先在 sqlite 里按条件查出 thread_id 列表，再用 `thread/list` 拉取
 * 这批的权威元数据」。**`thread/list` 没有"按 id 过滤"的参数**（F8 的参数清单里没有），
 * 所以这一步做不到。实际可行的两条路：
 *
 *   ① 对**当前可见页**（≤30 条）逐个 `thread/read` 拉权威字段 —— 有界，且只在筛选生效时发生；
 *   ② 依赖定期对账（启动 + 每 10 分钟一次 `thread/list?useStateDbOnly`）把 title/cwd 刷新。
 *
 * 这里两条都做：列表先用投影表**立刻**渲染（04 §9 的 <300ms），再对可见页做 ① 校正。
 * 已按 CLAUDE.md §9 回写 04 §3.4。
 */
import {
  EXPERIMENTAL_METHOD,
  METHOD,
  type ExperimentalFeature,
  type PermissionProfileSummary,
  type Thread,
  type ThreadItem,
  type ThreadListResponse,
  type ThreadStartResponse,
  type Turn,
  type TurnStartResponse,
  type UserInput,
} from '@evowork/protocol';
import { errorFields, type Logger } from '@evowork/logging';
import type { ProjectionRow, Store, ThreadFilter } from '@evowork/store';

import {
  assertDegradationCoverage,
  CapabilityRegistry,
  type CapabilityReport,
} from './capabilities.js';
import { createEventRouter, type SideEffect, type UiEvent } from './events.js';
import { createApprovalRouter, type ApprovalReply, type PendingApproval } from './approvals.js';
import { KernelSession, type KernelSessionOptions, type SessionNotice } from './session.js';
import {
  BUILTIN_SCENARIOS,
  expandTurnStart,
  MODES,
  type ComposerOverrides,
  type ModeId,
  type Scenario,
} from './scenario.js';

export interface Catalog {
  readonly permissionProfiles: readonly PermissionProfileSummary[];
  readonly experimentalFeatures: readonly ExperimentalFeature[];
  readonly scenarios: readonly Scenario[];
  readonly modes: readonly (typeof MODES)[ModeId][];
}

export interface TaskListItem {
  readonly threadId: string;
  readonly title: string | null;
  readonly status: ProjectionRow['derived_status'];
  readonly cwd: string | null;
  readonly updatedAt: number | null;
  readonly artifactCount: number;
  readonly fromAutomation: boolean;
}

export interface AdapterOptions {
  readonly store: Store;
  /**
   * 会话参数。**适配层自己建 session**，不接受外部传入一个建好的。
   *
   * 这是被测试逼出来的设计：早先版本允许两条构造路径（传 session 或传 sessionOptions），
   * 而 `onNotice`、未识别通知记录、崩溃恢复钩子这三样只在"适配层自己建"的那条路上接线。
   * 于是外部传入 session 时，R2 雷达与"内核已重启"提示会**静默失效** ——
   * 两条路径里有一条缺功能，比只有一条能力弱的路径危险得多。
   */
  readonly sessionOptions: Omit<
    KernelSessionOptions,
    'recover' | 'onNotice' | 'onUnhandledNotification'
  >;
  readonly logger?: Logger;
  readonly onUiEvent?: (event: UiEvent) => void;
  readonly onSideEffect?: (effect: SideEffect) => void;
  readonly onNotice?: (notice: SessionNotice) => void;
  readonly onDegrade?: (report: CapabilityReport) => void;
  readonly onPendingApprovalsChanged?: (pending: readonly PendingApproval[]) => void;
  /** 审批交给谁（UI）。不提供时一律 decline —— 没人能确认时选择不做 */
  readonly askApproval?: (approval: PendingApproval) => Promise<ApprovalReply>;
  readonly scenarios?: readonly Scenario[];
  readonly readInstructions?: (file: string) => string | undefined;
  readonly now?: () => number;
  /** 每页拉多少条权威元数据（第 ② 步的上界） */
  readonly authoritativePageSize?: number;
}

export function createAdapter(options: AdapterOptions) {
  // 启动即检查「每个实验方法都有降级路径」——缺一条就等于给未来留一次白屏
  assertDegradationCoverage();

  const { store, logger } = options;
  const now = options.now ?? (() => Date.now());
  const scenarios = options.scenarios ?? BUILTIN_SCENARIOS;
  const capabilities = new CapabilityRegistry((report) => options.onDegrade?.(report));

  const events = createEventRouter({
    store,
    onUiEvent: (event) => options.onUiEvent?.(event),
    ...(options.onSideEffect ? { onSideEffect: options.onSideEffect } : {}),
    ...(logger ? { logger } : {}),
    now,
  });

  const approvals = createApprovalRouter({
    ask: options.askApproval ?? (async () => ({ decision: 'decline' as const })),
    isUnattended: (threadId) => Boolean(store.threads.get(threadId)?.automation_id),
    ...(options.onPendingApprovalsChanged
      ? { onPendingChanged: options.onPendingApprovalsChanged }
      : {}),
    ...(logger ? { logger } : {}),
    now,
  });

  const session = new KernelSession({
    ...options.sessionOptions,
    recover: async () => recoverOpenThreads(),
    ...(options.onNotice ? { onNotice: options.onNotice } : {}),
    // R2 雷达：未识别的通知记形状（不记正文）。接在这里而不是让调用方自己接 ——
    // 它是"上游改了什么"的唯一线索，不该取决于谁构造了 session
    onUnhandledNotification: (method, params) => {
      store.recordUnknownEvent(method, params, now());
      options.onUiEvent?.({ type: 'unknown-event', method });
    },
  });

  let catalog: Catalog | undefined;

  /** 重启后补齐：对每个打开的 thread 做 `thread/resume` + `thread/items/list`（09 §1 / §5）。 */
  async function recoverOpenThreads(): Promise<number> {
    let recovered = 0;
    for (const threadId of session.openThreads) {
      try {
        await session.peer.request(METHOD.threadResume, { threadId });
        // 拉全量 item 后由前端按 item_id 去重合并（09 §5 第三行：事件丢失的兜底）
        await session.peer.request(METHOD.threadItemsList, { threadId });
        recovered += 1;
      } catch (err) {
        logger?.warn('adapter.recover.failed', { threadId, ...errorFields(err) });
      }
    }
    return recovered;
  }

  /** 带降级的实验方法调用：失败即定性并走兜底（09 §3.3）。 */
  async function callExperimental<T>(
    method: string,
    params: unknown,
    fallback: () => T,
  ): Promise<T> {
    if (!capabilities.isUsable(method)) return fallback();
    try {
      return await session.peer.request<T>(method, params);
    } catch (err) {
      const classified = capabilities.classifyFailure(method, err);
      if (classified.degraded) return fallback();
      throw err;
    }
  }

  return {
    session,
    capabilities,
    events,
    approvals,

    /**
     * 启动序列（09 §3.2）。
     *
     * 与文档的一处差异已回写：第 5 步不再是「用 `experimentalFeature/list` 决定 UI 降级」——
     * 那个方法返回的是内核功能开关而不是协议方法可用性（F18）。改为「探测 + 失败即降级」。
     */
    async start(): Promise<Catalog> {
      // 审批处理器必须在 start 之前就位：内核可能在握手后立刻发出请求（F14）
      for (const method of approvals.methods()) {
        session.onRequest(method, (params, m) => approvals.handle(m, params));
      }
      for (const method of events.methods()) {
        session.onNotification(method, (params, m) => events.handle(m, params));
      }

      await session.start();

      const [profiles, features] = await Promise.all([
        session.peer.request<{ data: PermissionProfileSummary[] }>(
          METHOD.permissionProfileList,
          {},
        ),
        session.peer
          .request<{ data: ExperimentalFeature[] }>(METHOD.experimentalFeatureList, {})
          .catch(() => ({ data: [] as ExperimentalFeature[] })),
      ]);

      await capabilities.probeStartup(async (method) => {
        await session.peer.request(method, {});
      });

      catalog = {
        permissionProfiles: profiles.data ?? [],
        experimentalFeatures: features.data ?? [],
        scenarios,
        modes: Object.values(MODES),
      };
      return catalog;
    },

    async stop(): Promise<void> {
      await session.stop();
    },

    catalog(): Catalog | undefined {
      return catalog;
    },

    /**
     * 任务列表（04 §3.4）。
     *
     * 两阶段：投影表**立刻**给出可渲染的列表（含状态与日期筛选，内核给不了）；
     * 调用方随后可用 `refreshAuthoritative()` 校正当前可见页的 title/cwd。
     */
    listTasks(filter: ThreadFilter = {}): TaskListItem[] {
      const ids = store.threads.queryThreadIds({ topLevelOnly: true, ...filter });
      return ids
        .map((id) => store.threads.get(id))
        .filter((row): row is ProjectionRow => row !== undefined)
        .map((row) => ({
          threadId: row.thread_id,
          title: row.title,
          status: row.derived_status,
          cwd: row.cwd,
          updatedAt: row.updated_at,
          artifactCount: row.artifact_count,
          fromAutomation: Boolean(row.automation_id),
        }));
    },

    /** 第 ② 步：对当前可见页拉权威元数据。有界（默认 30 条）。 */
    async refreshAuthoritative(threadIds: readonly string[]): Promise<number> {
      const pageSize = options.authoritativePageSize ?? 30;
      const page = threadIds.slice(0, pageSize);
      const results = await Promise.allSettled(
        page.map((threadId) =>
          session.peer.request<{ thread: Thread }>(METHOD.threadRead, { threadId }),
        ),
      );
      let refreshed = 0;
      for (const result of results) {
        if (result.status !== 'fulfilled' || !result.value?.thread) continue;
        store.threads.upsertFromThread(result.value.thread);
        refreshed += 1;
      }
      return refreshed;
    },

    /**
     * 一致性校正（09 §4.1）：启动时与每 10 分钟一次。
     * 用 `useStateDbOnly` 避免全量扫 rollout（文档明写）。
     */
    async reconcile(): Promise<{ upserted: number; removed: number }> {
      const response = await session.peer.request<ThreadListResponse>(METHOD.threadList, {
        limit: 200,
        sortKey: 'recencyAt',
        useStateDbOnly: true,
      });
      const threads = response.data ?? [];
      for (const thread of threads) store.threads.upsertFromThread(thread);
      const stale = store.threads.idsNotIn(threads.map((t) => t.id));
      for (const id of stale) store.threads.remove(id);
      logger?.info('adapter.reconcile.done', { itemCount: threads.length });
      return { upserted: threads.length, removed: stale.length };
    },

    /**
     * 新建任务（03 §4.6）：`thread/start` → `turn/start` → 路由到 `/tasks/:id`。
     * 首页不创建 thread，所以**从首页离开不产生空任务**（03 §1）。
     */
    async createTask(args: {
      readonly input: readonly UserInput[];
      readonly scenarioId?: string;
      readonly overrides?: ComposerOverrides;
      readonly automationId?: string;
    }): Promise<{ threadId: string; turn: Turn; degradations: readonly string[] }> {
      const scenario =
        scenarios.find((s) => s.id === args.scenarioId) ??
        scenarios.find((s) => s.default) ??
        scenarios[0];
      if (!scenario) throw new Error('没有可用的场景包');

      const modeId = args.overrides?.modeId ?? scenario.mode ?? 'craft';
      const mode = MODES[modeId];
      const permissions = mode.lockPermissions
        ? mode.permissions
        : (args.overrides?.permissions ?? scenario.permissions ?? mode.permissions);

      const started = await session.peer.request<ThreadStartResponse>(METHOD.threadStart, {
        ...(args.overrides?.cwd ? { cwd: args.overrides.cwd } : {}),
        ...((args.overrides?.model ?? scenario.model)
          ? { model: args.overrides?.model ?? scenario.model }
          : {}),
        // F5：permissions 与 sandbox 互斥，只传一个
        permissions,
      });
      const threadId = started.thread.id;
      session.openThreads.add(threadId);

      const expanded = expandTurnStart({
        threadId,
        input: args.input,
        scenario,
        ...(args.overrides ? { overrides: args.overrides } : {}),
        readInstructions: options.readInstructions ?? (() => undefined),
        collaborationModeAvailable: capabilities.isUsable('turn/start.collaborationMode'),
        permissionsFieldAvailable: capabilities.isUsable('turn/start.permissions'),
      });

      store.threads.upsertFromThread(started.thread, {
        ...expanded.origin,
        ...(args.automationId ? { automationId: args.automationId } : {}),
      });

      const turnResponse = await session.peer.request<TurnStartResponse>(
        METHOD.turnStart,
        expanded.params,
      );
      return { threadId, turn: turnResponse.turn, degradations: expanded.degradations };
    },

    /**
     * 在已有任务里发消息。
     *
     * 执行中的输入**入队而不是报错**（04 §5.4）。`thread/queue/*` 是实验方法，
     * 不可用时退回本机队列（09 §3.3）—— 队列内容留在投影表之外由前端持有，
     * 因为它是"还没发生的输入"，不属于任务历史。
     */
    async sendMessage(args: {
      readonly threadId: string;
      readonly input: readonly UserInput[];
      readonly overrides?: ComposerOverrides;
      readonly scenarioId?: string;
      /** 「立即插话」= steer；默认排队（04 §5.5：默认排队） */
      readonly steer?: boolean;
    }): Promise<{ queued: boolean; degradations: readonly string[] }> {
      const row = store.threads.get(args.threadId);
      const running = row?.derived_status === 'running' || row?.derived_status === 'pending';

      if (running && !args.steer) {
        const queued = await callExperimental<boolean>(
          EXPERIMENTAL_METHOD.threadQueueAdd,
          { threadId: args.threadId, input: args.input },
          () => false,
        );
        return { queued: queued !== false, degradations: [] };
      }

      if (running && args.steer) {
        await session.peer.request(METHOD.turnSteer, {
          threadId: args.threadId,
          input: args.input,
        });
        return { queued: false, degradations: [] };
      }

      const scenario =
        scenarios.find((s) => s.id === (args.scenarioId ?? row?.scenario_id)) ??
        scenarios.find((s) => s.default) ??
        scenarios[0];
      if (!scenario) throw new Error('没有可用的场景包');

      const expanded = expandTurnStart({
        threadId: args.threadId,
        input: args.input,
        scenario,
        overrides: {
          ...(row?.mode_id ? { modeId: row.mode_id as ModeId } : {}),
          ...(row?.permission_id ? { permissions: row.permission_id } : {}),
          ...(row?.model ? { model: row.model } : {}),
          ...args.overrides,
        },
        readInstructions: options.readInstructions ?? (() => undefined),
        collaborationModeAvailable: capabilities.isUsable('turn/start.collaborationMode'),
        permissionsFieldAvailable: capabilities.isUsable('turn/start.permissions'),
      });

      session.openThreads.add(args.threadId);
      await session.peer.request(METHOD.turnStart, expanded.params);
      return { queued: false, degradations: expanded.degradations };
    },

    /** 中断（04 §5.5）。 */
    async interrupt(threadId: string): Promise<void> {
      await session.peer.request(METHOD.turnInterrupt, { threadId });
    },

    /**
     * 打开任务（04 §9：< 300ms 出内容）。
     *
     * 先返回投影表缓存的摘要让 UI 立刻渲染，再用 `thread/items/list` 校正 ——
     * 摘要**不是权威副本**（09 §4.2），所以调用方必须用第二个返回值覆盖第一个。
     */
    async openTask(threadId: string): Promise<{
      readonly cached: ReturnType<Store['readItemDigest']>;
      readonly items: Promise<readonly ThreadItem[]>;
    }> {
      session.openThreads.add(threadId);
      const cached = store.readItemDigest(threadId);
      const items = (async () => {
        await session.peer.request(METHOD.threadResume, { threadId }).catch(() => undefined);
        const response = await session.peer.request<{ data: ThreadItem[] }>(
          METHOD.threadItemsList,
          { threadId },
        );
        return response.data ?? [];
      })();
      return { cached, items };
    },

    closeTask(threadId: string): void {
      session.openThreads.delete(threadId);
    },

    /** 任务级设置（04 §4）：下一次 `turn/start` 生效，**不追溯已发生的回合**。 */
    setTaskSettings(
      threadId: string,
      settings: {
        readonly modeId?: ModeId;
        readonly permissions?: string;
        readonly model?: string;
        readonly budgetLimit?: number | null;
      },
    ): void {
      store.threads.setTaskSettings(threadId, {
        ...(settings.modeId ? { modeId: settings.modeId } : {}),
        ...(settings.permissions ? { permissionId: settings.permissions } : {}),
        ...(settings.model ? { model: settings.model } : {}),
        ...(settings.budgetLimit !== undefined ? { budgetLimit: settings.budgetLimit } : {}),
      });
    },

    /** 设定预算（Q11：用内核的 `ThreadGoal.budget`，不自建）。 */
    async setBudget(threadId: string, budget: number): Promise<void> {
      await session.peer.request(METHOD.threadGoalSet, { threadId, budget });
      store.threads.setTaskSettings(threadId, { budgetLimit: budget });
    },

    /** 当前不可用的能力，供设置页「本机能力」列出（09 §3.3：降级一律显式）。 */
    degradations(): CapabilityReport[] {
      return capabilities.unavailable();
    },
  };
}

export type Adapter = ReturnType<typeof createAdapter>;
