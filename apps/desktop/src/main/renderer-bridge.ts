/**
 * 渲染进程能做的六件事，以及推给它的三种事件。
 *
 * ## 为什么单独一个文件
 *
 * 这是 09 §3 那条边界**朝 UI 的那一半**：适配层把内核说的话翻译成语义化事件，
 * 这里再把它翻译成"界面上要变什么"。两次翻译不是重复 ——
 * 适配层的 `UiEvent` 是**任务视角**（task-status / item-delta / plan-updated…），
 * 渲染层要的是**组件视角**（哪一行要更新、哪条消息要重画）。
 * 把它们混成一层，就会出现"为了 UI 方便"往适配层加字段的压力，那正是 K2 被磨掉的方式。
 *
 * ## 这里修掉的是一条断了的链路
 *
 * `preload` 声明了六个动作、`bootstrap` 只注册了审批一个 —— 界面能渲染，
 * 但任何操作都得到 `No handler registered`，表现是**回车没有任何反应**
 * （连报错都没有：`void send()` 把 rejection 吞了）。
 * 它一直没被发现，是因为这条链路从来没有被真正拉起来过。
 */
import type {
  Adapter,
  ApprovalDecision,
  ApprovalReply,
  PendingApproval,
  UiEvent,
} from '@evowork/kernel-adapter';
import type { Logger } from '@evowork/logging';
import type { ProjectionRow, Store } from '@evowork/store';

import type {
  ApprovalDecisionInput,
  ApprovalView,
  CaseView,
  RenderItemView,
  RendererEvent,
  RowActionInput,
  SendInput,
  StartupInfo,
  TaskRowView,
} from '../shared/ipc.js';

/** 增量能安全累加的两个通道：它们的 item 都用 `text` 承载正文。 */
const TEXT_DELTA_FIELD: Readonly<Record<string, string | undefined>> = {
  agentMessage: 'text',
  reasoning: 'text',
};

/** 相对时间（01 §5.5 的时间戳位）。**只到"天"**，再细就要每分钟重渲染整张列表。 */
export function timeLabel(at: number | null, now: number): string {
  if (at === null) return '';
  const diff = Math.max(0, now - at);
  const minute = 60_000;
  if (diff < minute) return '刚刚';
  if (diff < 60 * minute) return `${Math.floor(diff / minute)} 分钟前`;
  if (diff < 24 * 60 * minute) return `${Math.floor(diff / (60 * minute))} 小时前`;
  return `${Math.floor(diff / (24 * 60 * minute))} 天前`;
}

export function toTaskRow(row: ProjectionRow, now: number): TaskRowView {
  return {
    id: row.thread_id,
    title: row.title,
    status: row.derived_status,
    timeLabel: timeLabel(row.recency_at ?? row.updated_at, now),
    sectionId: row.section_id ?? 'ungrouped',
    parentThreadId: row.parent_thread_id,
    hasArtifacts: row.artifact_count > 0,
    source: row.automation_id ? 'automation' : 'manual',
    ...(row.cwd !== null ? { cwd: row.cwd } : {}),
  };
}

export interface RendererBridgeOptions {
  readonly adapter: Adapter;
  readonly store: Store;
  /** 把用户的决定交回给挂起的审批（F14：审批是**服务端发起的请求**，必须有人回复） */
  readonly resolveApproval?: ((id: string, reply: ApprovalReply) => void) | undefined;
  readonly logger?: Logger | undefined;
  readonly appName: string;
  readonly appVersion: string;
  readonly userName?: string | undefined;
  /** 随包分发的案例池（03 §5）。真源是 `config/showcase/*.toml`，缺省用内置兜底 */
  readonly cases?: readonly CaseView[] | undefined;
  readonly now?: (() => number) | undefined;
}

/**
 * 适配层事件 → 渲染层事件。
 *
 * 返回数组而不是单个：一条 `task-created` 在渲染层要同时给出整行数据，
 * 而有些适配层事件（`skills-changed` 这类）在当前 UI 上没有落点 —— 返回空数组，
 * **不是丢弃**：它们已经在适配层落过库、记过日志了。
 */
export function createEventTranslator(store: Store, now: () => number) {
  /** 增量累加的暂存。key = itemId，随 `item-completed` 清掉 */
  const streaming = new Map<string, { taskId: string; item: Record<string, unknown> }>();

  return function translate(event: UiEvent): readonly RendererEvent[] {
    switch (event.type) {
      case 'task-created': {
        const row = store.threads.get(event.threadId);
        if (!row) return [];
        return [{ type: 'task-created', task: toTaskRow(row, now()) }];
      }
      case 'task-status':
        return [{ type: 'task-updated', taskId: event.threadId, status: event.status }];
      case 'task-renamed':
        return [{ type: 'task-updated', taskId: event.threadId, title: event.title }];
      case 'item-started':
      case 'item-completed': {
        const item = event.item as unknown as Record<string, unknown> & {
          id: string;
          type: string;
        };
        if (event.type === 'item-completed') streaming.delete(item.id);
        else streaming.set(item.id, { taskId: event.threadId, item: { ...item } });
        return [{ type: 'item', taskId: event.threadId, item }];
      }
      case 'item-delta': {
        const field = TEXT_DELTA_FIELD[event.channel];
        const held = streaming.get(event.itemId);
        // 没见过 item-started 的增量不猜形状：等 item-completed 给出完整条目
        if (field === undefined || held === undefined) return [];
        const merged = {
          ...held.item,
          [field]: `${String(held.item[field] ?? '')}${event.delta}`,
        };
        streaming.set(event.itemId, { taskId: held.taskId, item: merged });
        return [{ type: 'item', taskId: held.taskId, item: merged as unknown as RenderItemView }];
      }
      default:
        // 其余事件在当前 UI 上没有落点。适配层已经落库并记过日志，这里不再重复
        return [];
    }
  };
}

/**
 * 六个渲染动作的实现。
 *
 * 不 import electron：`bootstrap.ts` 负责把它们挂到 `ipcMain` 上，
 * 这样"发送一条需求会发生什么"能在测试里跑完整条链路（这正是它此前从未被验证的原因）。
 */
export function createRendererActions(options: RendererBridgeOptions) {
  const { adapter, store } = options;
  const now = options.now ?? (() => Date.now());

  return {
    /** 03 §1：没有 threadId 就是首页的第一条 —— 此时才 `thread/start`，所以首页不产生空任务 */
    async send(input: SendInput): Promise<{ threadId: string }> {
      const text = input.text.trim();
      if (text === '') throw new Error('空需求');
      const content = [{ type: 'text' as const, text }];

      if (input.threadId !== undefined) {
        await adapter.sendMessage({ threadId: input.threadId, input: content });
        return { threadId: input.threadId };
      }
      const created = await adapter.createTask({
        input: content,
        ...(input.scenarioId !== undefined ? { scenarioId: input.scenarioId } : {}),
      });
      return { threadId: created.threadId };
    },

    async interrupt(threadId: string): Promise<void> {
      await adapter.interrupt(threadId);
    },

    async decideApproval(input: ApprovalDecisionInput): Promise<void> {
      options.resolveApproval?.(input.id, {
        decision: input.decision as ApprovalDecision,
        ...(input.answer !== undefined ? { answer: input.answer } : {}),
        ...(input.optionId !== undefined ? { optionId: input.optionId } : {}),
      });
      return Promise.resolve();
    },

    /**
     * 行操作（04 §3.3）。
     *
     * **本期只接了不需要内核参与的那几个**，其余如实记一条日志并返回 ——
     * 悄悄什么都不做会让用户以为点错了位置（09 §3.3 的同一条纪律）。
     */
    async rowAction(input: RowActionInput): Promise<void> {
      if (input.action === 'archive' || input.action === 'delete') {
        store.threads.remove(input.threadId);
        return;
      }
      options.logger?.info('desktop.row_action.unimplemented', { reason: input.action });
      return Promise.resolve();
    },

    /** 04 §3.4 第②步：只对可见页做权威字段校正（**有界**，不然筛出 800 条就是 800 个请求） */
    async refreshVisible(ids: readonly string[]): Promise<void> {
      if (ids.length === 0) return;
      await adapter.refreshAuthoritative(ids);
    },

    /** 首页要渲染的一切，一次给全 */
    async getStartup(): Promise<StartupInfo> {
      const catalog = adapter.catalog();
      const at = now();
      return Promise.resolve({
        appName: options.appName,
        appVersion: options.appVersion,
        /*
         * 用户名取本机账号。
         *
         * Q1=A 之下没有登录态（identity 服务还没开始），而 01 §5.7 的用户区要一个名字。
         * 取本机账号是唯一诚实的答案：这就是"谁在用这台电脑"。它不出本机（K6）。
         */
        userName: options.userName ?? '本机用户',
        scenarios: (catalog?.scenarios ?? []).map((s) => ({
          id: s.id,
          name: s.name,
          icon: s.icon,
          chips: (s.chips ?? []).map((c) => ({
            label: c.label,
            icon: c.icon,
            prompt: c.prompt,
            requiresFile: c.requiresFile,
          })),
          defaults: {
            modelId: s.model,
            permissionId: s.permissions,
            mode: s.mode,
          },
        })),
        // F4：`allowed:false` 的档位**保留**，由 UI 禁用并给原因
        permissions: (catalog?.permissionProfiles ?? []).map((p) => ({
          id: p.id,
          label: p.id,
          ...(p.description ? { description: p.description } : {}),
          allowed: p.allowed,
        })),
        cases: options.cases ?? [],
        tasks: adapter
          .listTasks({})
          .map((t) => store.threads.get(t.threadId))
          .filter((row): row is ProjectionRow => row !== undefined)
          .map((row) => toTaskRow(row, at)),
      });
    },
  };
}

export type RendererActions = ReturnType<typeof createRendererActions>;

/**
 * `PendingApproval` → 审批卡视图（10 §3.2）。
 *
 * 适配层刻意把 `params` 原样带过来（它不知道 UI 要画什么），翻译在这里做。
 * **`reason` 缺失时不编一个** —— 审批卡自己会显式说明"没有给出原因"，
 * 而这正是我们希望在内核少给字段时看到的表现。
 */
export function toApprovalView(
  approval: PendingApproval,
  allowAcceptForSession: boolean,
  now: number,
): ApprovalView {
  const p = approval.params;
  const str = (key: string): string | undefined =>
    typeof p[key] === 'string' ? (p[key] as string) : undefined;
  const changes = Array.isArray(p.changes)
    ? (p.changes as readonly Record<string, unknown>[]).map((c) => ({
        path: String(c.path ?? ''),
        ...(typeof c.kind === 'string' ? { kind: c.kind } : {}),
      }))
    : undefined;

  return {
    id: approval.id,
    kind: approval.kind,
    threadId: approval.threadId,
    ...(str('reason') !== undefined ? { reason: str('reason') } : {}),
    ...(str('command') !== undefined ? { command: str('command') } : {}),
    ...(str('cwd') !== undefined ? { cwd: str('cwd') } : {}),
    ...(str('question') !== undefined ? { question: str('question') } : {}),
    ...(changes ? { changes } : {}),
    allowAcceptForSession,
    waitedMs: Math.max(0, now - approval.receivedAtMs),
    unattended: approval.unattended,
  };
}
