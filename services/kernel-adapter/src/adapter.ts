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
  JsonRpcCallError,
  METHOD,
  type ExperimentalFeature,
  type FuzzyFileSearchResponse,
  type McpServerOauthLoginResponse,
  type McpServerStatusListResponse,
  type PermissionProfileSummary,
  type PluginListResponse,
  type ProjectCreateParams,
  type ProjectDeleteParams,
  type ProjectUpdateParams,
  type SkillsListResponse,
  type Thread,
  type ThreadGoal,
  type ThreadGoalStatus,
  type ThreadItem,
  type ThreadItemEntry,
  type ThreadItemsListResponse,
  type ThreadListResponse,
  type ThreadReadResponse,
  type ThreadResumeResponse,
  type ThreadSearchOccurrence,
  type ThreadStartResponse,
  type Turn,
  type TurnStartResponse,
  type UserInput,
} from '@evowork/protocol';
import { errorFields, type Logger } from '@evowork/logging';
import type { ProjectionRow, Store, ThreadFilter, TitleSource } from '@evowork/store';

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
  resolveModeId,
  assertModeSendable,
  MODES,
  type ComposerOverrides,
  type ModeId,
  type Scenario,
} from './scenario.js';
import { deriveTaskTitle } from './title.js';
import { DISABLE_OPENAI_DOCS_CONFIG } from './identity.js';

/**
 * 工作空间（第 5 节的映射表：EvoWork 的「空间」= 内核的 Project + cwd）。
 *
 * 只留 UI 真正要的三项。内核的 `Project` 还有 metadata / position / 两个时间戳，
 * 全量转发等于把一个实验方法的形状钉在 Composer 上（K2 的收敛职责）。
 */
export interface Workspace {
  readonly id: string;
  readonly name: string;
  /** 第一个 root 的绝对路径。任务在这个目录里跑（`turn/start` 的 cwd） */
  readonly path: string | null;
}

/** `project/list` 的响应形状里我们真正读的那部分（`v2/project.rs:22-35`）。 */
interface RawProject {
  readonly id: string;
  readonly name: string;
  readonly roots?: readonly { readonly path?: string }[];
}

/**
 * `Project` → `Workspace`。
 *
 * **只取第一个 root**：内核允许一个 project 有多个根，而 `turn/start` 只收一个 cwd。
 * 多根时取第一个是唯一不会静默出错的选择 —— 其余的根在 UI 上没有表达方式，
 * 猜一个"最合适的"会让任务跑在用户没预期的目录里。
 */
function toWorkspace(project: RawProject): Workspace {
  return {
    id: project.id,
    name: project.name,
    path: project.roots?.[0]?.path ?? null,
  };
}

export interface Catalog {
  readonly permissionProfiles: readonly PermissionProfileSummary[];
  readonly experimentalFeatures: readonly ExperimentalFeature[];
  readonly scenarios: readonly Scenario[];
  readonly modes: readonly (typeof MODES)[ModeId][];
  /**
   * 可选的工作空间。**`project/list` 不可用时是空数组，不是缺字段** ——
   * 前端据此渲染"还没有工作空间"的说明，而不是一个空白下拉
   * （2026-09-06 用户报的「点选择工作空间不能正常显示」正是空下拉）。
   */
  readonly workspaces: readonly Workspace[];
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

export interface TaskSearchResult {
  readonly threadId: string;
  readonly snippet: string;
}

export interface QueuedInput {
  readonly id: string;
  readonly input: readonly UserInput[];
}

export type { ThreadGoal, ThreadGoalStatus, ThreadSearchOccurrence };

export interface AdapterOptions {
  readonly store: Store;
  /** 由宿主提供的只读技能根；握手后注册，内核重启时自动重放。 */
  readonly skillRoots?: readonly string[];
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
  /**
   * 产品身份底稿，原样传给 `thread/start.baseInstructions`（F25）。
   *
   * 缺它时内核自带的「Codex CLI」底稿原样漏出来，而这条路径上不会报错。
   * 宿主从 `config/prompts/base-instructions.md` 读；测试传一句短的即可。
   */
  readonly baseInstructions?: string;
  readonly now?: () => number;
  /** 每页拉多少条权威元数据（第 ② 步的上界） */
  readonly authoritativePageSize?: number;
}

export const NO_AVAILABLE_MODEL_MESSAGE =
  '没有可用模型。请先在「设置 → 模型」添加或启用一个模型，再开始任务。';

function requireResolvedModel(model: string | undefined): string {
  const resolved = model?.trim();
  if (!resolved) throw new Error(NO_AVAILABLE_MODEL_MESSAGE);
  return resolved;
}

export function createAdapter(options: AdapterOptions) {
  // 启动即检查「每个实验方法都有降级路径」——缺一条就等于给未来留一次白屏
  assertDegradationCoverage();

  const { store, logger } = options;
  const now = options.now ?? (() => Date.now());
  const scenarios = options.scenarios ?? BUILTIN_SCENARIOS;
  const capabilities = new CapabilityRegistry((report) => options.onDegrade?.(report));
  /**
   * 「旁聊」对应的 ephemeral fork 只存在于当前内核进程，不能走持久任务的
   * read/delete/list 协议。缓存 fork 响应既让打开动作有明确分流，也避免它混进投影表。
   */
  const ephemeralThreads = new Map<string, Thread>();
  const ephemeralThreadIds = new Set<string>();

  const events = createEventRouter({
    store,
    ephemeralThreadIds,
    onUiEvent: (event) => {
      if (event.type === 'task-removed') {
        session.openThreads.delete(event.threadId);
        localQueues.delete(event.threadId);
        approvals.cancel((a) => a.threadId === event.threadId);
      }
      if (event.type === 'turn-completed')
        approvals.cancel((a) => a.kind === 'mcp' && a.threadId === event.threadId);
      options.onUiEvent?.(event);
    },
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
    recover: async () => {
      await registerSkillRoots();
      return recoverOpenThreads();
    },
    ...(options.onNotice ? { onNotice: options.onNotice } : {}),
    // R2 雷达：未识别的通知记形状（不记正文）。接在这里而不是让调用方自己接 ——
    // 它是"上游改了什么"的唯一线索，不该取决于谁构造了 session
    onUnhandledNotification: (method, params) => {
      store.recordUnknownEvent(method, params, now());
      const threadId =
        params &&
        typeof params === 'object' &&
        typeof (params as { threadId?: unknown }).threadId === 'string'
          ? (params as { threadId: string }).threadId
          : undefined;
      options.onUiEvent?.({ type: 'unknown-event', method, ...(threadId ? { threadId } : {}) });
    },
  });

  let catalog: Catalog | undefined;
  /** 实验队列不可用时的本机兜底。内容只活在进程内，不冒充任务历史。 */
  const localQueues = new Map<string, QueuedInput[]>();
  let queueSequence = 0;

  /**
   * 重命名任务（04 §3.3 的行操作，也是新任务自动起名的落点）。
   *
   * **写内核而不是写投影表**：09 §4.1 规定 `title` 的真源是内核，投影表只是缓存。
   * 内核会回一条 `thread/name/updated`，由事件路由更新投影表并推给 UI ——
   * 所以这里不碰 sqlite，少一个"两处不一致"的机会。
   *
   * 空名字**在这里就挡掉**：内核对空名回 `invalid_request`
   * （`thread_processor.rs:1788` 的 `normalize_thread_name`），送过去只是换一种方式失败。
   *
   * ## `source` 为什么必填
   *
   * 内核只有一个 `Thread.name`，它分不出这个名字是截出来的、产物给的、还是用户改的。
   * 三者的优先级不同（`canOverrideTitle`），所以**谁写谁报**，记在投影表的
   * `title_source` 上。写内核成功之后才记 —— 先记会在失败时留下一条谎。
   *
   * 覆盖判断**不在这里**：这个函数是"把名字写下去"，由调用方决定该不该写。
   * 放进来的话，用户改名也要先过一遍优先级，而那正是唯一不该被拦的一条。
   */
  async function setTaskName(
    threadId: string,
    name: string,
    source: TitleSource,
  ): Promise<boolean> {
    if (name.trim() === '') return false;
    try {
      await session.peer.request(METHOD.threadSetName, { threadId, name });
      /*
       * 投影行还不存在时这一步写不进去（`UPDATE` 影响 0 行、不报错）。
       * 名字**已经写进内核了**，所以这次改名是成功的 —— 但来源丢了，
       * 下一个产物会再改一次名。不留痕的话没人能解释那次多余的改名。
       */
      if (!store.threads.applyTitle(threadId, name, source)) {
        logger?.warn('adapter.title_source.no_row', { threadId });
      }
      options.onUiEvent?.({ type: 'task-renamed', threadId, title: name });
      return true;
    } catch (err: unknown) {
      // 起名失败不影响任务本身，但**要留痕**：否则"为什么还是未命名"没有任何线索
      logger?.warn('adapter.set_task_name.failed', { threadId, ...errorFields(err) });
      return false;
    }
  }

  /** 重启后补齐：恢复 thread 后重新读取历史（09 §1 / §5）。 */
  async function recoverOpenThreads(): Promise<number> {
    let recovered = 0;
    for (const threadId of session.openThreads) {
      try {
        const resumed = await session.peer.request<ThreadResumeResponse>(METHOD.threadResume, {
          threadId,
        });
        // 拉全量 item 后由前端按 item_id 去重合并（09 §5 第三行：事件丢失的兜底）。
        // 某些存储后端尚未实现分页接口，要走 thread/read 的兼容路径。
        await listAllThreadItemsWithFallback(
          (method, params) => session.peer.request(method, params),
          threadId,
          resumed.thread.turns,
        );
        recovered += 1;
      } catch (err) {
        logger?.warn('adapter.recover.failed', { threadId, ...errorFields(err) });
      }
    }
    return recovered;
  }

  async function registerSkillRoots(): Promise<void> {
    const extraRoots = [
      ...new Set((options.skillRoots ?? []).filter((root) => root.trim() !== '')),
    ];
    if (extraRoots.length === 0) return;
    await session.peer.request(METHOD.skillsExtraRootsSet, { extraRoots });
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
      if (classified.degraded) {
        /*
         * 只在**第一次**判定降级时走到这里：`isUsable` 之后的调用会在上面短路，
         * 不会再发请求、也不会再走到这一行 —— 所以不会刷屏。
         * 只记方法名 + 错误码，不带 params（Q14；params 里可能是路径 / 项目名这类正文）。
         */
        logger?.warn('adapter.experimental_call.degraded', {
          method,
          ...errorFields(err),
          errorCode: classified.report?.reason ?? 'METHOD_NOT_FOUND',
        });
        return fallback();
      }
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
      await registerSkillRoots();

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

      /*
       * 工作空间列表。`project/list` 是实验方法，所以走 `callExperimental`：
       * 不可用时拿到空数组并已由能力表记过一条降级（09 §3.3），
       * **不会让启动失败** —— 一个下拉的内容不该决定 App 能不能用。
       */
      const projects = await callExperimental<{ data?: readonly RawProject[] }>(
        EXPERIMENTAL_METHOD.projectList,
        {},
        () => ({ data: [] }),
      );

      catalog = {
        permissionProfiles: profiles.data ?? [],
        experimentalFeatures: features.data ?? [],
        scenarios,
        modes: Object.values(MODES),
        workspaces: (projects.data ?? []).map(toWorkspace),
      };
      return catalog;
    },

    async stop(): Promise<void> {
      approvals.cancel(() => true);
      ephemeralThreads.clear();
      ephemeralThreadIds.clear();
      await session.stop();
    },

    async requestComputerUseConsent(approval: PendingApproval): Promise<ApprovalReply> {
      const row = store.threads.get(approval.threadId);
      if (
        !row ||
        row.automation_id ||
        row.parent_thread_id ||
        row.last_turn_id !== approval.turnId ||
        row.derived_status !== 'running'
      )
        return { decision: 'decline' };
      const result = await approvals.handle('mcpServer/elicitation/request', {
        ...approval.params,
        threadId: approval.threadId,
        turnId: approval.turnId,
      });
      const latest = store.threads.get(approval.threadId);
      if (!latest || latest.last_turn_id !== approval.turnId || latest.derived_status !== 'running')
        return { decision: 'cancel' };
      const content = result.content as Record<string, unknown> | null;
      return {
        decision:
          result.action === 'accept' ? 'accept' : result.action === 'cancel' ? 'cancel' : 'decline',
        ...(typeof content?.scope === 'string' ? { optionId: content.scope } : {}),
      };
    },
    cancelComputerUseApprovals(): void {
      approvals.cancel((a) => a.kind === 'mcp' && a.params.serverName === 'cua_repl');
    },

    catalog(): Catalog | undefined {
      return catalog;
    },

    /** 以 app-server 的发现结果为唯一事实源，避免 UI 自己猜技能名和路径。 */
    async listSkills(
      cwds: readonly string[] = [],
      forceReload = false,
    ): Promise<SkillsListResponse> {
      return session.peer.request<SkillsListResponse>(METHOD.skillsList, {
        ...(cwds.length > 0 ? { cwds: [...cwds] } : {}),
        ...(forceReload ? { forceReload: true } : {}),
      });
    },

    /** 文件补全由内核的并行索引完成；同一 token 的前一请求会被取消。 */
    async searchFiles(
      query: string,
      roots: readonly string[],
      cancellationToken?: string,
    ): Promise<FuzzyFileSearchResponse> {
      if (!query.trim() || roots.length === 0) return { files: [] };
      return session.peer.request<FuzzyFileSearchResponse>(METHOD.fuzzyFileSearch, {
        query,
        roots: [...roots],
        cancellationToken: cancellationToken ?? null,
      });
    },

    async setSkillEnabled(input: {
      readonly path?: string;
      readonly name?: string;
      readonly enabled: boolean;
    }): Promise<boolean> {
      if (!input.path && !input.name) throw new Error('启停技能需要 path 或 name');
      const response = await session.peer.request<{ readonly effectiveEnabled: boolean }>(
        METHOD.skillsConfigWrite,
        {
          path: input.path ?? null,
          name: input.name ?? null,
          enabled: input.enabled,
        },
      );
      return response.effectiveEnabled;
    },

    /**
     * 套件目录只读本地与工作区源。公开远程市场尚未通过产品/合规决策，不能顺手打开。
     */
    async listPluginBundles(cwds: readonly string[] = []): Promise<PluginListResponse> {
      return session.peer.request<PluginListResponse>(METHOD.pluginList, {
        cwds: cwds.length > 0 ? [...cwds] : null,
        marketplaceKinds: ['local', 'workspace-directory'],
        forceRefetch: false,
      });
    },

    async installPluginBundle(input: {
      readonly marketplacePath: string;
      readonly pluginName: string;
    }): Promise<void> {
      await session.peer.request(METHOD.pluginInstall, {
        marketplacePath: input.marketplacePath,
        remoteMarketplaceName: null,
        installAttemptId: null,
        pluginName: input.pluginName,
      });
    },

    async uninstallPluginBundle(pluginId: string): Promise<void> {
      await session.peer.request(METHOD.pluginUninstall, { pluginId });
    },

    async listMcpServerStatuses(threadId?: string): Promise<McpServerStatusListResponse> {
      return session.peer.request<McpServerStatusListResponse>(METHOD.mcpServerStatusList, {
        detail: 'toolsAndAuthOnly',
        ...(threadId ? { threadId } : {}),
      });
    },

    async startMcpServerOauthLogin(
      name: string,
      threadId?: string,
    ): Promise<McpServerOauthLoginResponse> {
      return session.peer.request<McpServerOauthLoginResponse>(METHOD.mcpServerOauthLogin, {
        name,
        ...(threadId ? { threadId } : {}),
      });
    },

    async reloadMcpServers(): Promise<void> {
      await session.peer.request(METHOD.mcpServerReload, undefined);
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
      const page = threadIds
        .filter((threadId) => !ephemeralThreadIds.has(threadId))
        .slice(0, pageSize);
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
      const model = requireResolvedModel(args.overrides?.model ?? scenario.model);

      const reviewerAvailable = capabilities.isUsable('turn/start.approvalsReviewer');
      const modeId = resolveModeId(args.overrides?.modeId ?? scenario.mode);
      assertModeSendable(modeId, reviewerAvailable);
      const mode = MODES[modeId];

      const started = await session.peer.request<ThreadStartResponse>(METHOD.threadStart, {
        ...(args.overrides?.cwd ? { cwd: args.overrides.cwd } : {}),
        model,
        // F5：permissions 与 sandbox 互斥，只传一个
        permissions: mode.kernelPermissions,
        approvalPolicy: mode.approvalPolicy,
        approvalsReviewer: mode.approvalsReviewer,
        // F25：整段替换内核底稿。developer_instructions 盖不住「你是谁」
        ...(options.baseInstructions ? { baseInstructions: options.baseInstructions } : {}),
        config: DISABLE_OPENAI_DOCS_CONFIG,
      });
      const threadId = started.thread.id;
      session.openThreads.add(threadId);

      const expanded = expandTurnStart({
        threadId,
        input: args.input,
        scenario,
        overrides: { ...args.overrides, model },
        readInstructions: options.readInstructions ?? (() => undefined),
        collaborationModeAvailable: capabilities.isUsable('turn/start.collaborationMode'),
        permissionsFieldAvailable: capabilities.isUsable('turn/start.permissions'),
        approvalsReviewerAvailable: reviewerAvailable,
      });

      const title = deriveTaskTitle(args.input);
      const firstMessage = args.input
        .filter((part): part is Extract<UserInput, { type: 'text' }> => part.type === 'text')
        .map((part) => part.text)
        .join('\n')
        .trim();

      store.threads.upsertFromThread(started.thread, {
        ...expanded.origin,
        ...(args.automationId ? { automationId: args.automationId } : {}),
        ...(firstMessage !== '' ? { firstMessage } : {}),
      });
      // 侧边栏不必等 `thread/started`：那条通知的 name 是 null，而且可能晚于命名。
      options.onUiEvent?.({ type: 'task-created', threadId, title: title ?? null });

      const turnResponse = await session.peer.request<TurnStartResponse>(
        METHOD.turnStart,
        expanded.params,
      );

      /*
       * 起名放在 `turn/start` **之后**：它对这一回合毫无影响，排在前面只会
       * 让第一个字慢一次往返。失败也不抛 —— 一个装饰性字段没写上，
       * 不该把一个已经跑起来的任务变成"创建失败"（见 `setTaskName`）。
       */
      if (title !== undefined) await setTaskName(threadId, title, 'derived');

      return { threadId, turn: turnResponse.turn, degradations: expanded.degradations };
    },

    setTaskName,

    async searchTasks(searchTerm: string): Promise<readonly TaskSearchResult[]> {
      const term = searchTerm.trim();
      if (!term) return [];
      const response = await callExperimental<{
        readonly data?: readonly { readonly thread?: Thread; readonly snippet?: string }[];
      }>(
        EXPERIMENTAL_METHOD.threadSearch,
        { searchTerm: term, limit: 100, sortKey: 'recency_at', sortDirection: 'desc' },
        () => ({ data: [] }),
      );
      const hits: TaskSearchResult[] = [];
      for (const hit of response.data ?? []) {
        if (!hit.thread) continue;
        store.threads.upsertFromThread(hit.thread);
        hits.push({ threadId: hit.thread.id, snippet: hit.snippet ?? hit.thread.name ?? '' });
      }
      // 实验搜索不可用时，标题搜索仍然可用；不把摘要缓存伪装成正文命中。
      if (hits.length === 0) {
        const lower = term.toLocaleLowerCase();
        for (const id of store.threads.queryThreadIds({ topLevelOnly: true })) {
          const row = store.threads.get(id);
          if ((row?.title ?? '').toLocaleLowerCase().includes(lower)) {
            hits.push({ threadId: id, snippet: row?.title ?? '' });
          }
        }
      }
      return hits;
    },

    async searchTaskOccurrences(
      threadId: string,
      searchTerm: string,
    ): Promise<readonly ThreadSearchOccurrence[]> {
      const term = searchTerm.trim();
      if (!term) return [];
      const response = await callExperimental<{
        readonly data?: readonly ThreadSearchOccurrence[];
      }>(
        EXPERIMENTAL_METHOD.threadSearchOccurrences,
        { threadId, searchTerm: term, limit: 100 },
        () => ({ data: [] }),
      );
      return response.data ?? [];
    },

    async forkTask(threadId: string, lastTurnId?: string, ephemeral = false): Promise<string> {
      const response = await session.peer.request<{ readonly thread: Thread }>(METHOD.threadFork, {
        threadId,
        ...(lastTurnId ? { lastTurnId } : {}),
        excludeTurns: true,
        ...(ephemeral ? { ephemeral: true } : {}),
      });
      if (response.thread.ephemeral) {
        ephemeralThreads.set(response.thread.id, response.thread);
        ephemeralThreadIds.add(response.thread.id);
      } else {
        store.threads.upsertFromThread(response.thread);
      }
      session.openThreads.add(response.thread.id);
      return response.thread.id;
    },

    async archiveTask(threadId: string): Promise<void> {
      if (ephemeralThreads.delete(threadId)) {
        ephemeralThreadIds.delete(threadId);
        session.openThreads.delete(threadId);
        localQueues.delete(threadId);
        options.onUiEvent?.({ type: 'task-removed', threadId });
        return;
      }
      await session.peer.request(METHOD.threadArchive, { threadId });
      store.threads.setArchived(threadId, true, now());
      session.openThreads.delete(threadId);
    },

    async deleteTask(threadId: string): Promise<void> {
      approvals.cancel((a) => a.threadId === threadId);
      if (ephemeralThreads.delete(threadId)) {
        ephemeralThreadIds.delete(threadId);
        session.openThreads.delete(threadId);
        localQueues.delete(threadId);
        options.onUiEvent?.({ type: 'task-removed', threadId });
        return;
      }
      await session.peer.request(METHOD.threadDelete, { threadId });
      store.threads.remove(threadId);
      session.openThreads.delete(threadId);
      localQueues.delete(threadId);
      options.onUiEvent?.({ type: 'task-removed', threadId });
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
        const id = `q-${now().toString(36)}-${(queueSequence += 1).toString(36)}`;
        const queued = await callExperimental<
          { readonly queuedSubmission?: { readonly id?: string } } | false
        >(
          EXPERIMENTAL_METHOD.threadQueueAdd,
          { threadId: args.threadId, input: args.input, clientUserMessageId: id },
          () => false,
        );
        if (queued === false) {
          const current = localQueues.get(args.threadId) ?? [];
          localQueues.set(args.threadId, [...current, { id, input: args.input }]);
        }
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

      const overrides: ComposerOverrides = {
        ...(row?.mode_id ? { modeId: resolveModeId(row.mode_id) } : {}),
        ...(row?.permission_id ? { permissions: row.permission_id } : {}),
        ...(row?.model ? { model: row.model } : {}),
        ...args.overrides,
      };
      requireResolvedModel(overrides.model ?? scenario.model);

      const expanded = expandTurnStart({
        threadId: args.threadId,
        input: args.input,
        scenario,
        overrides,
        readInstructions: options.readInstructions ?? (() => undefined),
        collaborationModeAvailable: capabilities.isUsable('turn/start.collaborationMode'),
        permissionsFieldAvailable: capabilities.isUsable('turn/start.permissions'),
        approvalsReviewerAvailable: capabilities.isUsable('turn/start.approvalsReviewer'),
      });

      session.openThreads.add(args.threadId);
      await session.peer.request(METHOD.turnStart, expanded.params);
      return { queued: false, degradations: expanded.degradations };
    },

    async listQueuedInputs(threadId: string): Promise<readonly QueuedInput[]> {
      const response = await callExperimental<{
        readonly data?: readonly { readonly id?: string; readonly input?: readonly UserInput[] }[];
      }>(EXPERIMENTAL_METHOD.threadQueueList, { threadId, limit: 100 }, () => ({ data: [] }));
      const remote = (response.data ?? [])
        .filter((entry): entry is { readonly id: string; readonly input?: readonly UserInput[] } =>
          Boolean(entry.id),
        )
        .map((entry) => ({ id: entry.id, input: entry.input ?? [] }));
      return [...remote, ...(localQueues.get(threadId) ?? [])];
    },

    async removeQueuedInput(threadId: string, id: string): Promise<boolean> {
      const local = localQueues.get(threadId) ?? [];
      if (local.some((entry) => entry.id === id)) {
        localQueues.set(
          threadId,
          local.filter((entry) => entry.id !== id),
        );
        return true;
      }
      const response = await callExperimental<{ readonly deleted?: boolean }>(
        EXPERIMENTAL_METHOD.threadQueueDelete,
        { threadId, queuedSubmissionId: id },
        () => ({ deleted: false }),
      );
      return response.deleted === true;
    },

    async updateQueuedInput(
      threadId: string,
      id: string,
      text: string,
      references: readonly UserInput[] = [],
    ): Promise<boolean> {
      const input: readonly UserInput[] = [
        ...(text.trim() ? [{ type: 'text' as const, text }] : []),
        ...references.filter((part) => part.type !== 'text'),
      ];
      const local = localQueues.get(threadId) ?? [];
      const localIndex = local.findIndex((entry) => entry.id === id);
      if (localIndex >= 0) {
        localQueues.set(
          threadId,
          local.map((entry, index) => (index === localIndex ? { ...entry, input } : entry)),
        );
        return true;
      }
      const response = await callExperimental<{ readonly queuedSubmission?: unknown } | false>(
        EXPERIMENTAL_METHOD.threadQueueUpdate,
        { threadId, queuedSubmissionId: id, input },
        () => false,
      );
      return response !== false;
    },

    async reorderQueuedInputs(threadId: string, ids: readonly string[]): Promise<boolean> {
      const local = localQueues.get(threadId) ?? [];
      const localById = new Map(local.map((entry) => [entry.id, entry]));
      const localIds = ids.filter((id) => localById.has(id));
      if (localIds.length > 0) {
        const mentioned = new Set(localIds);
        localQueues.set(threadId, [
          ...localIds.map((id) => localById.get(id)!).filter(Boolean),
          ...local.filter((entry) => !mentioned.has(entry.id)),
        ]);
      }

      const remoteIds = ids.filter((id) => !localById.has(id));
      if (remoteIds.length === 0) return true;
      const response = await callExperimental<{ readonly reordered?: boolean } | false>(
        EXPERIMENTAL_METHOD.threadQueueReorder,
        { threadId, queuedSubmissionIds: remoteIds },
        () => false,
      );
      return response !== false && response.reordered !== false;
    },

    /**
     * 当前回合结束后启动下一条**本机降级队列**输入。
     *
     * 当前 app-server 的持久队列由 queue extension 在 thread idle 生命周期中自动
     * 出队。这里若同时调用 `thread/queue/start`，会与内核的自动出队竞争：通知先到、
     * idle 状态稍后落定时请求会报“仍有 active turn”，并产生一次假失败。
     * `thread/queue/add` 降级时才由 EvoWork 自己持有输入，因此只消费 `localQueues`。
     */
    async startNextQueued(threadId: string): Promise<void> {
      const queued = localQueues.get(threadId) ?? [];
      const next = queued[0];
      if (!next) return;
      const row = store.threads.get(threadId);
      const scenario =
        scenarios.find((candidate) => candidate.id === row?.scenario_id) ??
        scenarios.find((candidate) => candidate.default) ??
        scenarios[0];
      if (!scenario) return;
      const overrides: ComposerOverrides = {
        ...(row?.mode_id ? { modeId: resolveModeId(row.mode_id) } : {}),
        ...(row?.permission_id ? { permissions: row.permission_id } : {}),
        ...(row?.model ? { model: row.model } : {}),
      };
      requireResolvedModel(overrides.model ?? scenario.model);
      const expanded = expandTurnStart({
        threadId,
        input: next.input,
        scenario,
        overrides,
        readInstructions: options.readInstructions ?? (() => undefined),
        collaborationModeAvailable: capabilities.isUsable('turn/start.collaborationMode'),
        permissionsFieldAvailable: capabilities.isUsable('turn/start.permissions'),
        approvalsReviewerAvailable: capabilities.isUsable('turn/start.approvalsReviewer'),
      });
      session.openThreads.add(threadId);
      await session.peer.request(METHOD.turnStart, expanded.params);
      // 请求成功后再移除；失败时保留，避免一次暂时故障把用户排队的输入吞掉。
      localQueues.set(threadId, queued.slice(1));
    },

    /** 中断（04 §5.5）。 */
    async interrupt(threadId: string): Promise<void> {
      await session.peer.request(METHOD.turnInterrupt, { threadId });
    },

    /** 把持久化对话截到某回合之前；内核明确保证它不改工作区文件。 */
    async revertTask(threadId: string, beforeTurnId: string): Promise<void> {
      await session.peer.request(METHOD.threadRevert, { threadId, beforeTurnId });
    },

    /**
     * 打开任务（04 §9：< 300ms 出内容）。
     *
     * 先返回投影表缓存的摘要让 UI 立刻渲染，再用分页历史校正 ——
     * 摘要**不是权威副本**（09 §4.2），所以调用方必须用第二个返回值覆盖第一个。
     *
     * 内核默认一页 25 条、上限 100（`THREAD_ITEMS_DEFAULT_LIMIT` /
     * `THREAD_ITEMS_MAX_LIMIT`），条目形状是 `{ turnId, item }` 不是裸 `ThreadItem`。
     * 这里按页拉完并解开，否则长对话只看到第一页，或整页都因没有顶层 `type` 画不出来。
     */
    async openTask(threadId: string): Promise<{
      readonly cached: ReturnType<Store['readItemDigest']>;
      readonly items: Promise<readonly ThreadItem[]>;
      readonly latestTurn: Promise<Turn | undefined>;
    }> {
      session.openThreads.add(threadId);
      const ephemeral = ephemeralThreads.get(threadId);
      if (ephemeral) {
        const turns = ephemeral.turns ?? [];
        return {
          cached: [],
          items: Promise.resolve(itemsFromTurns(turns)),
          latestTurn: Promise.resolve(turns.at(-1)),
        };
      }
      const cached = store.readItemDigest(threadId);
      const resumed = session.peer
        .request<ThreadResumeResponse>(METHOD.threadResume, { threadId })
        .catch(() => undefined);
      const items = (async () => {
        const response = await resumed;
        return listAllThreadItemsWithFallback(
          (method, params) => session.peer.request(method, params),
          threadId,
          response?.thread.turns,
        );
      })();
      const latestTurn = session.peer
        .request<{ readonly data?: readonly Turn[] }>(METHOD.threadTurnsList, {
          threadId,
          limit: 1,
          sortDirection: 'desc',
          itemsView: 'summary',
        })
        .then(async (response) => response.data?.[0] ?? (await resumed)?.thread.turns.at(-1))
        .catch(async () => (await resumed)?.thread.turns.at(-1));
      return { cached, items, latestTurn };
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

    async getGoal(threadId: string): Promise<ThreadGoal | undefined> {
      const response = await session.peer.request<{ readonly goal?: ThreadGoal | null }>(
        METHOD.threadGoalGet,
        { threadId },
      );
      return response.goal ?? undefined;
    },

    async setGoal(
      threadId: string,
      changes: {
        readonly objective?: string;
        readonly status?: ThreadGoalStatus;
        readonly tokenBudget?: number | null;
      },
    ): Promise<ThreadGoal | undefined> {
      const response = await session.peer.request<{ readonly goal?: ThreadGoal }>(
        METHOD.threadGoalSet,
        { threadId, ...changes },
      );
      return response.goal;
    },

    async clearGoal(threadId: string): Promise<void> {
      await session.peer.request(METHOD.threadGoalClear, { threadId });
      store.threads.setTaskSettings(threadId, { budgetLimit: null });
    },

    /** 设定预算（Q11：用内核的 `ThreadGoal.tokenBudget`，不自建）。 */
    async setBudget(threadId: string, budget: number): Promise<void> {
      const currentResponse = await session.peer.request<{ readonly goal?: ThreadGoal | null }>(
        METHOD.threadGoalGet,
        { threadId },
      );
      await session.peer.request(METHOD.threadGoalSet, {
        threadId,
        ...(!currentResponse.goal
          ? {
              objective: store.threads.get(threadId)?.first_message?.trim() || '完成当前任务',
              status: 'active' as const,
            }
          : {}),
        tokenBudget: budget,
      });
      store.threads.setTaskSettings(threadId, { budgetLimit: budget });
    },

    /** 当前不可用的能力，供设置页「本机能力」列出（09 §3.3：降级一律显式）。 */
    /**
     * 「本次任务内都允许」能不能给（10 §3.3）。
     *
     * 转发审批路由的判断而不是让 UI 自己算：那条规则（批量变更与删除不给）
     * 只该有一个定义处 —— 复制到前端去，两边迟早会不一致，而不一致的那一侧
     * 是"多给了一个一键放开写权限的按钮"。
     */
    allowsAcceptForSession(approval: PendingApproval): boolean {
      return approvals.allowsAcceptForSession(approval);
    },

    degradations(): CapabilityReport[] {
      return capabilities.unavailable();
    },

    /*
     * ── 内核镜像（spec §2.3）────────────────────────────────────────────
     *
     * 本机 `project_local` 是真源，这三个方法是**尽力而为**的同步。
     * 全部走 `callExperimental`：不可用或调用失败时走 fallback，**不抛错** ——
     * 用户点「新建空间」看到的应该是空间建好了，而不是一个他无法处理的错误。
     * 失败进结构化日志（方法名 + 错误码，无路径正文，见 `callExperimental`）。
     *
     * 但只吞**降级**：`callExperimental` 只在 `classifyFailure().degraded` 为 true
     * （目前只有 -32601 method not found）时才走 fallback，其余错误原样抛出 ——
     * 内核进程崩了不是"镜像没同步"，那是 App 出事了。
     */

    /** 成功返回内核 project id；不可用或失败返回 undefined。 */
    async mirrorProjectCreate(input: {
      readonly name: string;
      readonly rootPath: string;
      readonly idempotencyKey: string;
    }): Promise<string | undefined> {
      const params: ProjectCreateParams = {
        name: input.name,
        roots: [{ path: input.rootPath }],
        // 必填字段（`v2/project.rs:92` 是 String 不是 Option）：漏了它是参数解析错误，
        // 而镜像调用失败是静默的，于是"内核那边永远建不出空间"会没有任何征兆
        idempotencyKey: input.idempotencyKey,
      };
      const result = await callExperimental<{ project?: { id?: string } } | undefined>(
        EXPERIMENTAL_METHOD.projectCreate,
        params,
        () => undefined,
      );
      return result?.project?.id;
    },

    async mirrorProjectUpdate(input: {
      readonly kernelId: string;
      readonly name: string;
    }): Promise<void> {
      const params: ProjectUpdateParams = { projectId: input.kernelId, name: input.name };
      await callExperimental<unknown>(EXPERIMENTAL_METHOD.projectUpdate, params, () => undefined);
    },

    async mirrorProjectDelete(kernelId: string): Promise<void> {
      const params: ProjectDeleteParams = { projectId: kernelId };
      await callExperimental<unknown>(EXPERIMENTAL_METHOD.projectDelete, params, () => undefined);
    },
  };
}

export type Adapter = ReturnType<typeof createAdapter>;

/** 内核 `THREAD_ITEMS_MAX_LIMIT`（app-server `thread_processor.rs`）。 */
const ITEM_LIST_PAGE_SIZE = 100;
/** 防止 `nextCursor` 永远非空时死循环。50 页 × 100 = 5000 条，远超当前对话长度。 */
const ITEM_LIST_PAGE_CAP = 50;

/**
 * `thread/items/list` 的 `data[]` 是 `{ turnId, item }`（`ThreadItemEntry`）。
 *
 * 解开 `.item`。顺带接受测试夹具里直接塞 `ThreadItem` 的旧形状 —— 两种都没有
 * 顶层 `type` 时返回 undefined，让调用方跳过，而不是把包装对象当成一条消息。
 */
function itemFromListEntry(entry: ThreadItemEntry | ThreadItem | unknown): ThreadItem | undefined {
  if (!entry || typeof entry !== 'object') return undefined;
  const rec = entry as Record<string, unknown>;
  const nested = rec.item;
  if (nested && typeof nested === 'object') {
    const item = nested as ThreadItem;
    if (typeof item.id === 'string' && typeof item.type === 'string') {
      return typeof rec.turnId === 'string'
        ? ({ ...item, _turnId: rec.turnId } as unknown as ThreadItem)
        : item;
    }
  }
  if (typeof rec.id === 'string' && typeof rec.type === 'string' && rec.item === undefined) {
    return rec as ThreadItem;
  }
  return undefined;
}

async function listAllThreadItems(
  request: <T>(method: string, params?: unknown) => Promise<T>,
  threadId: string,
): Promise<readonly ThreadItem[]> {
  const items: ThreadItem[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < ITEM_LIST_PAGE_CAP; page += 1) {
    const response = await request<ThreadItemsListResponse>(METHOD.threadItemsList, {
      threadId,
      limit: ITEM_LIST_PAGE_SIZE,
      ...(cursor !== undefined ? { cursor } : {}),
    });
    for (const entry of response.data ?? []) {
      const item = itemFromListEntry(entry);
      if (item) items.push(item);
    }
    const next = response.nextCursor;
    if (next === undefined || next === null || next === '') return items;
    cursor = next;
  }
  return items;
}

/**
 * `thread/items/list` 已进入协议，但内核会在当前 ThreadStore 不支持分页时回 -32601。
 * 这不是“任务没有历史”，而是该后端仍要求用兼容的 `thread/read(includeTurns)` 一次性读取。
 * 只对 method-not-found 回退；连接中断、损坏响应等真实故障仍原样交给 UI。
 */
async function listAllThreadItemsWithFallback(
  request: <T>(method: string, params?: unknown) => Promise<T>,
  threadId: string,
  resumedTurns?: readonly Turn[],
): Promise<readonly ThreadItem[]> {
  try {
    return await listAllThreadItems(request, threadId);
  } catch (err: unknown) {
    if (!(err instanceof JsonRpcCallError) || !err.isMethodNotFound) throw err;
    if (resumedTurns && resumedTurns.length > 0) return itemsFromTurns(resumedTurns);
    const response = await request<ThreadReadResponse>(METHOD.threadRead, {
      threadId,
      includeTurns: true,
    });
    return itemsFromTurns(response.thread.turns);
  }
}

/** 保留每个 item 的回合归属：过程分组、单回合 diff 与回滚都依赖它。 */
function itemsFromTurns(turns: readonly Turn[]): readonly ThreadItem[] {
  return turns.flatMap((turn) =>
    turn.items.map((item) => ({ ...item, _turnId: turn.id }) as unknown as ThreadItem),
  );
}
