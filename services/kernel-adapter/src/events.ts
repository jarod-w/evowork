/**
 * 事件流 → UI 状态（09 §3.4）。
 *
 * **顺序是固定的：先落库、再更新 UI、最后触发副作用。**
 * 文档说这是"刻意的"，理由是 UI 崩溃/刷新后能从投影表恢复，反之不行。
 * 这里把它做成结构上的保证：每个 handler 返回一个"待执行副作用"列表，
 * 由路由器在落库与 UI 更新之后统一执行 —— handler 里没有直接触发副作用的入口。
 *
 * 三个消费者的分工（对应 09 §3.4 的三列）：
 *   · **投影表** —— 状态、用量、摘要（`@evowork/store`）
 *   · **UI** —— 一个语义化事件（前端不认识协议方法名）
 *   · **副作用** —— 通知、并发计数、预算闸门、产物识别、automation_run 落库
 */
import {
  NOTIFICATION,
  type Thread,
  type ThreadItem,
  type ThreadStatus,
  type ThreadTokenUsage,
  type Turn,
} from '@evowork/protocol';
import type { Logger } from '@evowork/logging';
import type { DerivedStatus, Store } from '@evowork/store';

/** 前端消费的语义化事件。**不包含协议方法名** —— 前端不该知道那些（K2）。 */
export type UiEvent =
  | { readonly type: 'task-created'; readonly threadId: string; readonly title: string | null }
  | {
      readonly type: 'task-status';
      readonly threadId: string;
      readonly status: DerivedStatus;
    }
  | { readonly type: 'task-renamed'; readonly threadId: string; readonly title: string | null }
  | { readonly type: 'task-removed'; readonly threadId: string }
  | { readonly type: 'turn-started'; readonly threadId: string; readonly turnId: string }
  | {
      readonly type: 'turn-completed';
      readonly threadId: string;
      readonly turnId: string;
      readonly status: Turn['status'];
      readonly durationMs?: number | null;
    }
  | { readonly type: 'item-started'; readonly threadId: string; readonly item: ThreadItem }
  | { readonly type: 'item-completed'; readonly threadId: string; readonly item: ThreadItem }
  | {
      readonly type: 'item-delta';
      readonly threadId: string;
      readonly itemId: string;
      readonly channel: 'agentMessage' | 'plan' | 'reasoning' | 'commandOutput';
      readonly delta: string;
    }
  | { readonly type: 'plan-updated'; readonly threadId: string; readonly hasSteps: boolean }
  | { readonly type: 'diff-updated'; readonly threadId: string; readonly turnId: string }
  | {
      readonly type: 'token-usage';
      readonly threadId: string;
      readonly usage: ThreadTokenUsage;
    }
  | { readonly type: 'queue-changed'; readonly threadId: string }
  | { readonly type: 'skills-changed' }
  | { readonly type: 'connectors-changed' }
  | { readonly type: 'projects-changed' }
  | { readonly type: 'workspace-files-changed'; readonly threadId?: string }
  | { readonly type: 'rate-limits-updated' }
  | {
      readonly type: 'kernel-warning';
      readonly text: string;
    }
  | {
      /** 上游新增的、我们还不认识的事件（04 §5.2 最后一段：绝不静默丢弃） */
      readonly type: 'unknown-event';
      readonly method: string;
    };

/** 流式增量的四个通道（04 §5.1：按 item id 合并，60fps 节流由前端做）。 */
export type DeltaChannel = Extract<UiEvent, { type: 'item-delta' }>['channel'];

/** 副作用。**在落库与 UI 更新之后**执行（09 §3.4 的第三列）。 */
export type SideEffect =
  | { readonly kind: 'notify'; readonly reason: 'PENDING_APPROVAL' | 'TURN_DONE' | 'TURN_FAILED' }
  | { readonly kind: 'concurrency'; readonly delta: 1 | -1 }
  | { readonly kind: 'budget-check'; readonly threadId: string }
  | { readonly kind: 'artifact-scan'; readonly threadId: string; readonly item: ThreadItem }
  | {
      readonly kind: 'automation-run-finished';
      readonly threadId: string;
      readonly status: Turn['status'];
    }
  | { readonly kind: 'index-title'; readonly threadId: string };

export interface EventRouterOptions {
  readonly store: Store;
  readonly onUiEvent: (event: UiEvent) => void;
  readonly onSideEffect?: (effect: SideEffect) => void;
  readonly logger?: Logger;
  readonly now?: () => number;
}

type Handler = (params: unknown) => SideEffect[];

/**
 * 一个通知路由器。用 `attach()` 把它挂到 session 上。
 *
 * 分成 `handle(method, params)` 与 `attach(session)` 两层，是为了让**每一条映射规则都能
 * 被单独测**，而不必起一个内核进程。09 §3.4 那张表有 17 行，逐行测才有意义。
 */
export function createEventRouter(options: EventRouterOptions) {
  const { store, onUiEvent, logger } = options;
  const now = options.now ?? (() => Date.now());
  /** thread → 已落库的 item 序号。item_digest 的 seq 需要单调递增 */
  const seqByThread = new Map<string, number>();

  function nextSeq(threadId: string): number {
    const next = (seqByThread.get(threadId) ?? 0) + 1;
    seqByThread.set(threadId, next);
    return next;
  }

  /** 一行摘要。**不存完整内容**（09 §4.2） */
  function summarize(item: ThreadItem): string | null {
    switch (item.type) {
      case 'userMessage':
      case 'agentMessage': {
        const text = typeof item.text === 'string' ? item.text : '';
        // 摘要长度上限刻意很短：它是"快显"用的，不是内容副本。
        // 顺带也把它挡在"投影表变成正文仓库"这条路之外。
        return text.slice(0, 80) || null;
      }
      case 'commandExecution': {
        const command = typeof item.command === 'string' ? item.command : '';
        return command ? `$ ${command.slice(0, 60)}` : null;
      }
      case 'fileChange': {
        const changes = Array.isArray(item.changes) ? item.changes.length : 0;
        return `改动 ${changes} 个文件`;
      }
      default:
        return null;
    }
  }

  const handlers: Record<string, Handler> = {
    [NOTIFICATION.threadStarted]: (params) => {
      const p = params as { thread?: Thread };
      if (!p.thread) return [];
      const status = store.threads.upsertFromThread(p.thread);
      onUiEvent({ type: 'task-created', threadId: p.thread.id, title: p.thread.name ?? null });
      onUiEvent({ type: 'task-status', threadId: p.thread.id, status });
      return [];
    },

    [NOTIFICATION.threadStatusChanged]: (params) => {
      const p = params as { threadId?: string; status?: ThreadStatus };
      if (!p.threadId || p.status === undefined) return [];
      const status = store.threads.applyStatusChanged(p.threadId, p.status, now());
      onUiEvent({ type: 'task-status', threadId: p.threadId, status });
      // 待处理时发通知（09 §3.4）：用户可能在别的页面，甚至不在 App 里（10 §3.5）
      return status === 'pending' ? [{ kind: 'notify', reason: 'PENDING_APPROVAL' }] : [];
    },

    [NOTIFICATION.threadNameUpdated]: (params) => {
      const p = params as { threadId?: string; name?: string | null };
      if (!p.threadId) return [];
      store.db
        .prepare('UPDATE thread_projection SET title = ?, updated_at = ? WHERE thread_id = ?')
        .run(p.name ?? null, now(), p.threadId);
      onUiEvent({ type: 'task-renamed', threadId: p.threadId, title: p.name ?? null });
      return [{ kind: 'index-title', threadId: p.threadId }];
    },

    [NOTIFICATION.threadArchived]: (params) => {
      const p = params as { threadId?: string };
      if (!p.threadId) return [];
      const status = store.threads.setArchived(p.threadId, true, now());
      onUiEvent({ type: 'task-status', threadId: p.threadId, status });
      return [];
    },

    [NOTIFICATION.threadUnarchived]: (params) => {
      const p = params as { threadId?: string };
      if (!p.threadId) return [];
      const status = store.threads.setArchived(p.threadId, false, now());
      onUiEvent({ type: 'task-status', threadId: p.threadId, status });
      return [];
    },

    [NOTIFICATION.threadDeleted]: (params) => {
      const p = params as { threadId?: string };
      if (!p.threadId) return [];
      store.threads.remove(p.threadId);
      onUiEvent({ type: 'task-removed', threadId: p.threadId });
      return [];
    },

    [NOTIFICATION.turnStarted]: (params) => {
      const p = params as { threadId?: string; turn?: Turn };
      if (!p.threadId || !p.turn) return [];
      onUiEvent({ type: 'turn-started', threadId: p.threadId, turnId: p.turn.id });
      return [{ kind: 'concurrency', delta: 1 }];
    },

    [NOTIFICATION.turnCompleted]: (params) => {
      const p = params as { threadId?: string; turn?: Turn };
      if (!p.threadId || !p.turn) return [];
      const status = store.threads.applyTurnCompleted(p.threadId, p.turn, now());
      onUiEvent({
        type: 'turn-completed',
        threadId: p.threadId,
        turnId: p.turn.id,
        status: p.turn.status,
        durationMs: p.turn.durationMs ?? null,
      });
      onUiEvent({ type: 'task-status', threadId: p.threadId, status });

      const effects: SideEffect[] = [
        { kind: 'concurrency', delta: -1 },
        {
          kind: 'notify',
          reason: p.turn.status === 'failed' ? 'TURN_FAILED' : 'TURN_DONE',
        },
      ];
      // 来自定时任务的回合要落 automation_run（09 §3.4 第 7 行）
      const row = store.threads.get(p.threadId);
      if (row?.automation_id) {
        effects.push({
          kind: 'automation-run-finished',
          threadId: p.threadId,
          status: p.turn.status,
        });
      }
      return effects;
    },

    [NOTIFICATION.turnPlanUpdated]: (params) => {
      const p = params as { threadId?: string; steps?: unknown[] };
      if (!p.threadId) return [];
      const hasSteps = Array.isArray(p.steps) && p.steps.length > 0;
      const status = store.threads.applyPlanUpdated(p.threadId, hasSteps, now());
      onUiEvent({ type: 'plan-updated', threadId: p.threadId, hasSteps });
      onUiEvent({ type: 'task-status', threadId: p.threadId, status });
      return [];
    },

    [NOTIFICATION.turnDiffUpdated]: (params) => {
      const p = params as { threadId?: string; turnId?: string };
      if (!p.threadId || !p.turnId) return [];
      // 不落库：聚合 diff 可能很大，而它随时可以从 turn/diff/updated 再拿一次（09 §3.4）
      onUiEvent({ type: 'diff-updated', threadId: p.threadId, turnId: p.turnId });
      return [];
    },

    [NOTIFICATION.itemStarted]: (params) => {
      const p = params as { threadId?: string; item?: ThreadItem };
      if (!p.threadId || !p.item) return [];
      onUiEvent({ type: 'item-started', threadId: p.threadId, item: p.item });
      return [];
    },

    [NOTIFICATION.itemCompleted]: (params) => {
      const p = params as { threadId?: string; item?: ThreadItem; completedAtMs?: number };
      if (!p.threadId || !p.item) return [];
      store.putItemDigest({
        threadId: p.threadId,
        seq: nextSeq(p.threadId),
        itemId: p.item.id,
        itemType: p.item.type,
        summary: summarize(p.item),
        createdAt: p.completedAtMs ?? now(),
      });
      onUiEvent({ type: 'item-completed', threadId: p.threadId, item: p.item });
      // FileChange → 产物识别的信号 ②（08 §2.2）
      return p.item.type === 'fileChange'
        ? [{ kind: 'artifact-scan', threadId: p.threadId, item: p.item }]
        : [];
    },

    [NOTIFICATION.threadTokenUsageUpdated]: (params) => {
      const p = params as { threadId?: string; tokenUsage?: ThreadTokenUsage };
      if (!p.threadId || !p.tokenUsage) return [];
      store.threads.applyTokenUsage(p.threadId, p.tokenUsage, now());
      onUiEvent({ type: 'token-usage', threadId: p.threadId, usage: p.tokenUsage });
      // 预算闸门（Q11 / 10 §5）：耗尽要暂停并询问，不自动降级
      return [{ kind: 'budget-check', threadId: p.threadId }];
    },

    [NOTIFICATION.threadQueueChanged]: (params) => {
      const p = params as { threadId?: string };
      if (!p.threadId) return [];
      onUiEvent({ type: 'queue-changed', threadId: p.threadId });
      return [];
    },

    [NOTIFICATION.skillsChanged]: () => {
      onUiEvent({ type: 'skills-changed' });
      return [];
    },

    [NOTIFICATION.mcpServerStartupStatusUpdated]: () => {
      onUiEvent({ type: 'connectors-changed' });
      return [];
    },

    [NOTIFICATION.projectChanged]: () => {
      onUiEvent({ type: 'projects-changed' });
      return [];
    },

    [NOTIFICATION.fsChanged]: (params) => {
      const p = params as { threadId?: string };
      onUiEvent({
        type: 'workspace-files-changed',
        ...(p.threadId ? { threadId: p.threadId } : {}),
      });
      return [];
    },

    [NOTIFICATION.accountRateLimitsUpdated]: () => {
      onUiEvent({ type: 'rate-limits-updated' });
      return [];
    },

    [NOTIFICATION.warning]: (params) => {
      const p = params as { message?: string };
      // 内核的 warning 正文可能含路径与命令，但它是**面向用户的提示**，UI 要显示它。
      // 它不进日志（那才是 Q14 管的地方）——这个区分很重要：不落盘 ≠ 不显示。
      onUiEvent({ type: 'kernel-warning', text: p.message ?? '执行内核报告了一个警告' });
      return [];
    },
  };

  // 流式增量（09 §3.4：不落库，只更新 UI）
  const deltaChannels: Record<string, DeltaChannel> = {
    [NOTIFICATION.itemAgentMessageDelta]: 'agentMessage',
    [NOTIFICATION.itemPlanDelta]: 'plan',
    [NOTIFICATION.itemReasoningTextDelta]: 'reasoning',
    [NOTIFICATION.itemReasoningSummaryTextDelta]: 'reasoning',
    [NOTIFICATION.itemCommandExecutionOutputDelta]: 'commandOutput',
  } as const;

  for (const [method, channel] of Object.entries(deltaChannels)) {
    handlers[method] = (params) => {
      const p = params as { threadId?: string; itemId?: string; delta?: string; text?: string };
      if (!p.threadId || !p.itemId) return [];
      onUiEvent({
        type: 'item-delta',
        threadId: p.threadId,
        itemId: p.itemId,
        channel,
        delta: p.delta ?? p.text ?? '',
      });
      return [];
    };
  }

  return {
    /** 我们订阅的方法清单（attach 用它注册，测试用它断言覆盖面） */
    methods(): string[] {
      return Object.keys(handlers);
    },

    /**
     * 处理一条通知。**顺序：落库 → UI → 副作用**（09 §3.4）。
     *
     * handler 内部完成前两步（它拿到 store 与 onUiEvent），副作用以返回值的形式交出来，
     * 由这里统一执行。这样"副作用先于落库"这种错误在结构上就写不出来。
     */
    handle(method: string, params: unknown): SideEffect[] {
      const handler = handlers[method];
      if (!handler) {
        // 未识别通知：记形状（不记正文）+ 让 UI 显示一行，绝不静默丢弃（R2 / 04 §5.2）
        store.recordUnknownEvent(method, params, now());
        onUiEvent({ type: 'unknown-event', method });
        logger?.warn('adapter.event.unknown', { method });
        return [];
      }

      let effects: SideEffect[] = [];
      try {
        effects = handler(params);
      } catch (err) {
        // 一条坏通知不该让整个事件流停下来
        logger?.error('adapter.event.handler_failed', {
          method,
          errorClass: err instanceof Error ? err.name : 'UnknownError',
        });
        return [];
      }
      for (const effect of effects) options.onSideEffect?.(effect);
      return effects;
    },
  };
}

export type EventRouter = ReturnType<typeof createEventRouter>;
