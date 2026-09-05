/**
 * 审批路由与超时策略（10 §3，F14）。
 *
 * ## 为什么这个文件不能被简化成"把请求转给 UI"
 *
 * 审批是 **server→client request**，内核发出后**会一直等**（10 §3.1 原话）。这一条事实
 * 决定了三件必须在这一层解决的事：
 *
 * 1. **必须有超时策略** —— 但两类任务的策略相反（10 §3.6）：
 *    · 交互式任务：**不自动拒绝**（用户回来还能继续，自动拒绝会白白丢掉进度）；
 *    · 定时任务：**超时 10 分钟自动 Decline**，run 记 `FAILED / APPROVAL_TIMEOUT`
 *      （没人看着，挂在审批上会一直占着并发额度）。
 * 2. **必须能在任何页面看到待审批** —— 所以这里维护一个跨任务的待审批队列（10 §3.5）。
 * 3. **Cancel 与 Decline 要分清** —— 前者结束整个动作，后者只拒绝这一次、agent 可换路。
 *    这个区分要透到 UI 的按钮上，所以类型里就分开。
 */
import { SERVER_REQUEST } from '@evowork/protocol';
import type { Logger } from '@evowork/logging';

export type ApprovalKind = 'command' | 'fileChange' | 'permissions' | 'userInput';

export type ApprovalDecision =
  /** 允许这一次 */
  | 'accept'
  /** 本次任务内都允许（10 §3.3：批量变更时**不提供**这一项） */
  | 'acceptForSession'
  /** 只拒绝这一次，agent 可以换路 */
  | 'decline'
  /** 结束整个动作 */
  | 'cancel';

export interface PendingApproval {
  readonly id: string;
  readonly kind: ApprovalKind;
  readonly threadId: string;
  readonly turnId?: string;
  readonly itemId?: string;
  /** 原始 params，交给 UI 渲染审批卡（10 §3.2–3.4） */
  readonly params: Record<string, unknown>;
  readonly receivedAtMs: number;
  /** 是否是无人值守的定时任务（决定超时策略） */
  readonly unattended: boolean;
}

export interface ApprovalReply {
  readonly decision: ApprovalDecision;
  /** 追问卡（`item/tool/requestUserInput`）的自由文本或选项 id */
  readonly answer?: string;
  readonly optionId?: string;
}

export interface ApprovalTimeoutPolicy {
  /** 提醒一次（发系统通知）。10 §3.6：5 分钟 */
  readonly remindAfterMs: number;
  /** 标记为"已等待很久"并在列表里置顶。10 §3.6：30 分钟 */
  readonly escalateAfterMs: number;
  /** 无人值守时自动拒绝。10 §3.6：定时任务 10 分钟；交互式为 `null`（**不自动拒绝**） */
  readonly autoDeclineAfterMs: number | null;
}

export const INTERACTIVE_POLICY: ApprovalTimeoutPolicy = {
  remindAfterMs: 5 * 60_000,
  escalateAfterMs: 30 * 60_000,
  autoDeclineAfterMs: null,
};

export const UNATTENDED_POLICY: ApprovalTimeoutPolicy = {
  remindAfterMs: 60_000,
  escalateAfterMs: 5 * 60_000,
  autoDeclineAfterMs: 10 * 60_000,
};

export interface ApprovalRouterOptions {
  /** 把审批交给 UI；resolve 即用户的决定。UI 不回复时这个 Promise 就一直悬着（正常） */
  readonly ask: (approval: PendingApproval) => Promise<ApprovalReply>;
  /** 这个 thread 是不是定时任务（无人值守）。默认按交互式处理 —— 更保守 */
  readonly isUnattended?: (threadId: string) => boolean;
  readonly onPendingChanged?: (pending: readonly PendingApproval[]) => void;
  /** 到点提醒 / 升级 / 自动拒绝时回调，供通知中心与 automation_run 落库使用 */
  readonly onTimeoutStage?: (
    approval: PendingApproval,
    stage: 'remind' | 'escalate' | 'auto-decline',
  ) => void;
  readonly logger?: Logger;
  readonly now?: () => number;
  readonly setTimeoutFn?: typeof setTimeout;
  readonly clearTimeoutFn?: typeof clearTimeout;
}

const KIND_BY_METHOD: Readonly<Record<string, ApprovalKind>> = {
  [SERVER_REQUEST.commandExecutionRequestApproval]: 'command',
  [SERVER_REQUEST.fileChangeRequestApproval]: 'fileChange',
  [SERVER_REQUEST.permissionsRequestApproval]: 'permissions',
  [SERVER_REQUEST.toolRequestUserInput]: 'userInput',
};

/**
 * 内核对回复的形状要求（`v2/item.rs`）。
 *
 * 审批类回复 `{ decision }`；追问类回复的是答案而不是决定 ——
 * 混用会让内核收到一个它不认识的形状，而那个错误要等到真实运行时才出现。
 */
function toWireReply(kind: ApprovalKind, reply: ApprovalReply): Record<string, unknown> {
  if (kind === 'userInput') {
    return {
      ...(reply.optionId ? { optionId: reply.optionId } : {}),
      ...(reply.answer ? { answer: reply.answer } : {}),
      ...(reply.optionId || reply.answer ? {} : { decision: reply.decision }),
    };
  }
  return { decision: reply.decision };
}

export function createApprovalRouter(options: ApprovalRouterOptions) {
  const now = options.now ?? (() => Date.now());
  const setTimeoutFn = options.setTimeoutFn ?? setTimeout;
  const clearTimeoutFn = options.clearTimeoutFn ?? clearTimeout;

  const pending = new Map<string, PendingApproval>();
  const timers = new Map<string, ReturnType<typeof setTimeout>[]>();
  let counter = 0;

  function emitPending(): void {
    // 按到达顺序（10 §3.5：多个待审批按到达顺序逐个处理，**不做"全部允许"**）
    const list = [...pending.values()].sort((a, b) => a.receivedAtMs - b.receivedAtMs);
    options.onPendingChanged?.(list);
  }

  function clearTimers(id: string): void {
    for (const timer of timers.get(id) ?? []) clearTimeoutFn(timer);
    timers.delete(id);
  }

  async function handle(method: string, rawParams: unknown): Promise<Record<string, unknown>> {
    const kind = KIND_BY_METHOD[method];
    if (!kind) {
      throw new Error(`未支持的服务端请求：${method}`);
    }
    const params = (rawParams ?? {}) as Record<string, unknown>;
    const threadId = typeof params.threadId === 'string' ? params.threadId : '';
    const unattended = threadId ? (options.isUnattended?.(threadId) ?? false) : false;
    const id = `apv_${++counter}`;

    const approval: PendingApproval = {
      id,
      kind,
      threadId,
      ...(typeof params.turnId === 'string' ? { turnId: params.turnId } : {}),
      ...(typeof params.itemId === 'string' ? { itemId: params.itemId } : {}),
      params,
      receivedAtMs: now(),
      unattended,
    };
    pending.set(id, approval);
    emitPending();

    options.logger?.info('adapter.approval.received', {
      threadId: threadId || undefined,
      reason: kind.toUpperCase(),
      // **不记 command / diff / question 正文**（10 §6 的"不记什么"）
    });

    const policy = unattended ? UNATTENDED_POLICY : INTERACTIVE_POLICY;
    const stageTimers: ReturnType<typeof setTimeout>[] = [];
    let autoDeclined = false;

    const decided = new Promise<ApprovalReply>((resolve) => {
      stageTimers.push(
        setTimeoutFn(() => options.onTimeoutStage?.(approval, 'remind'), policy.remindAfterMs),
      );
      stageTimers.push(
        setTimeoutFn(() => options.onTimeoutStage?.(approval, 'escalate'), policy.escalateAfterMs),
      );
      if (policy.autoDeclineAfterMs !== null) {
        stageTimers.push(
          setTimeoutFn(() => {
            autoDeclined = true;
            options.onTimeoutStage?.(approval, 'auto-decline');
            options.logger?.warn('adapter.approval.auto_declined', {
              threadId: threadId || undefined,
              failureClass: 'APPROVAL_TIMEOUT',
              waitedMs: policy.autoDeclineAfterMs ?? 0,
            });
            resolve({ decision: 'decline' });
          }, policy.autoDeclineAfterMs),
        );
      }
      timers.set(id, stageTimers);
    });

    try {
      const reply = await Promise.race([options.ask(approval), decided]);
      return toWireReply(kind, reply);
    } catch (err) {
      // UI 侧出错（比如窗口被关掉）——**必须回复**，否则内核永远等下去。
      // 回 decline 而不是 accept：出错时选择不做，而不是选择做。
      options.logger?.error('adapter.approval.ask_failed', {
        threadId: threadId || undefined,
        errorClass: err instanceof Error ? err.name : 'UnknownError',
      });
      return toWireReply(kind, { decision: 'decline' });
    } finally {
      clearTimers(id);
      pending.delete(id);
      emitPending();
      if (autoDeclined) {
        options.logger?.info('adapter.approval.resolved', {
          threadId: threadId || undefined,
          approved: false,
          reason: 'APPROVAL_TIMEOUT',
        });
      }
    }
  }

  return {
    /** 注册到 session 的服务端请求处理器上（每个方法一个） */
    methods(): string[] {
      return Object.keys(KIND_BY_METHOD);
    },
    handle,
    pendingList(): readonly PendingApproval[] {
      return [...pending.values()].sort((a, b) => a.receivedAtMs - b.receivedAtMs);
    },
    /**
     * 「本次任务内都允许」对批量变更**默认不提供**（10 §3.3）——
     * 一次点击放开整个会话的写权限风险过高。这个判断放在这里而不是 UI，
     * 是为了让"哪些情况能给这个按钮"只有一个定义处。
     */
    allowsAcceptForSession(approval: PendingApproval): boolean {
      if (approval.kind !== 'fileChange') return approval.kind === 'command';
      const changes = approval.params.changes;
      if (!Array.isArray(changes)) return false;
      if (changes.length !== 1) return false;
      const only = changes[0] as { kind?: string; path?: string } | undefined;
      // 删除操作不给（10 §3.3：删除单独着色且不折叠，更不该被一键放开）
      return only?.kind !== 'delete';
    },
  };
}

export type ApprovalRouter = ReturnType<typeof createApprovalRouter>;
