/**
 * scheduler ↔ 内核的接线。
 *
 * `scheduler.ts` 只认 `SchedulerPorts` 这个接口（为了让 misfire 的整套规格能用可控时钟测）。
 * 这里是它跑在真机上的实现：把一次触发变成一个真实的 thread，并把结果回写。
 *
 * ## 为什么 `TaskRunner` 是结构类型而不是 import 适配层
 *
 * 依赖 `@evowork/kernel-adapter` 会让 scheduler 的测试拖上整个协议栈。
 * 而这里真正需要的只有三个方法，结构类型足够表达 —— 宿主把 adapter 传进来即可
 * （TypeScript 的结构化类型让它天然匹配）。K2 没有被绕过：
 * 说协议的仍然只有适配层，这里说的是它的语义化 API。
 *
 * ## 定时任务与交互式任务的三处不同
 *
 * 1. **必须有硬预算**（07 §8-3）。没有的话一个失控循环会在夜里烧完配额，
 *    而没有人在旁边看着。`startRun` 里它是必填的。
 * 2. **审批 10 分钟后自动取消**（10 §3.6）。交互式任务不自动拒绝（一直等），
 *    但无人值守时"一直等"等于这个任务永远卡住。
 * 3. **失败要分类**（07 §8-2）。交互式任务失败了用户就在旁边；
 *    定时任务的失败要能自动区分"任务自身的问题"与"环境的问题"，
 *    因为只有前者才计入连败并触发自动暂停。
 */

import type { Logger } from '@evowork/logging';

import { classifyFailure, UNATTENDED_APPROVAL_TIMEOUT_MS, type FailureClass } from './failure.js';
import type { AutomationDefinition, RunRecord, SchedulerPorts } from './scheduler.js';

/** 适配层里我们用得到的那部分（结构类型，见文件头）。 */
export interface TaskRunner {
  createTask(args: {
    readonly input: readonly { readonly type: 'text'; readonly text: string }[];
    readonly scenarioId?: string;
    readonly overrides?: {
      readonly cwd?: string;
      readonly model?: string;
      readonly permissions?: string;
      readonly modeId?: 'craft' | 'plan' | 'ask';
    };
    readonly automationId?: string;
  }): Promise<{ threadId: string }>;
  setBudget(threadId: string, budget: number): Promise<void>;
  interrupt(threadId: string): Promise<void>;
}

/** 本机 sqlite 里 automation 相关的读写（结构类型，宿主传 store 进来）。 */
export interface AutomationStore {
  insertRun(record: RunRecord & { readonly startedAt: number }): boolean;
  finishRun(input: {
    readonly automationId: string;
    readonly fireTime: number;
    readonly status: 'SUCCEEDED' | 'FAILED';
    readonly failureClass?: FailureClass | undefined;
    readonly threadId?: string | undefined;
    readonly tokenUsage?: number | undefined;
    readonly errorSummary?: string | undefined;
    readonly finishedAt: number;
  }): void;
  updateAutomation(
    id: string,
    patch: {
      readonly status?: 'ACTIVE' | 'PAUSED';
      readonly consecutiveFailures?: number;
      readonly lastFireTime?: number;
    },
  ): void;
  listActive(deviceId: string): readonly AutomationDefinition[];
  get(id: string): AutomationDefinition | undefined;
}

export interface BridgeOptions {
  readonly runner: TaskRunner;
  readonly store: AutomationStore;
  readonly deviceId: string;
  readonly notify: (text: string) => void;
  readonly now?: (() => number) | undefined;
  /** 工作空间在不在。路径失效是 `ENVIRONMENT` 类失败（不计连败） */
  readonly workspaceExists?: ((path: string) => boolean) | undefined;
  readonly logger?: Logger | undefined;
}

/** 正在跑的 run：`isRunning` 与超时取消都要用它。 */
interface ActiveRun {
  readonly automationId: string;
  readonly fireTime: number;
  readonly threadId: string;
  readonly startedAt: number;
  approvalTimer?: ReturnType<typeof setTimeout>;
}

export function createKernelBridge(options: BridgeOptions) {
  const now = options.now ?? (() => Date.now());
  const active = new Map<string, ActiveRun>();

  const ports: SchedulerPorts = {
    now,
    deviceId: options.deviceId,
    notify: options.notify,
    isRunning: (automationId) => active.has(automationId),
    insertRun: (record) => options.store.insertRun({ ...record, startedAt: now() }),
    updateAutomation: (id, patch) => options.store.updateAutomation(id, patch),

    async startRun(automation, fireTime) {
      // ① 工作空间不在 → 直接判 ENVIRONMENT，不去起 thread
      const missing = (automation.workspaces ?? []).filter(
        (path) => !(options.workspaceExists?.(path) ?? true),
      );
      if (missing.length > 0) {
        finish(automation, fireTime, undefined, {
          ok: false,
          failureClass: 'ENVIRONMENT',
          summary: '工作空间路径不存在',
        });
        // 抛出去让调用方知道这次没起来；scheduler 已经落了 RUNNING，finish 会改成 FAILED
        throw new Error('workspace-missing');
      }

      const created = await options.runner.createTask({
        input: [{ type: 'text', text: automation.prompt }],
        automationId: automation.id,
        overrides: {
          ...(automation.workspaces[0] ? { cwd: automation.workspaces[0] } : {}),
        },
      });

      // ② 硬预算（07 §8-3）：**先设预算再让它跑**，顺序反了就有一段没有预算保护的窗口
      await options.runner.setBudget(created.threadId, automation.budgetLimit);

      const run: ActiveRun = {
        automationId: automation.id,
        fireTime,
        threadId: created.threadId,
        startedAt: now(),
      };
      // ③ 无人值守的审批超时（10 §3.6）：10 分钟没人理就中断整个任务
      run.approvalTimer = setTimeout(() => {
        void options.runner.interrupt(created.threadId).catch(() => undefined);
        finish(automation, fireTime, created.threadId, {
          ok: false,
          failureClass: 'APPROVAL_TIMEOUT',
          summary: '等待确认超过 10 分钟，已自动取消',
        });
      }, UNATTENDED_APPROVAL_TIMEOUT_MS);
      if (typeof run.approvalTimer.unref === 'function') run.approvalTimer.unref();

      active.set(automation.id, run);
      return created.threadId;
    },
  };

  /** 一次执行的收尾。**幂等**：超时与正常结束可能同时到达。 */
  function finish(
    automation: AutomationDefinition,
    fireTime: number,
    threadId: string | undefined,
    result:
      | { readonly ok: true; readonly tokenUsage?: number }
      | { readonly ok: false; readonly failureClass: FailureClass; readonly summary: string },
  ): void {
    const run = active.get(automation.id);
    if (run?.fireTime === fireTime) {
      if (run.approvalTimer) clearTimeout(run.approvalTimer);
      active.delete(automation.id);
    }

    options.store.finishRun({
      automationId: automation.id,
      fireTime,
      status: result.ok ? 'SUCCEEDED' : 'FAILED',
      ...(result.ok ? {} : { failureClass: result.failureClass, errorSummary: result.summary }),
      ...(threadId ? { threadId } : {}),
      ...(result.ok && result.tokenUsage !== undefined ? { tokenUsage: result.tokenUsage } : {}),
      finishedAt: now(),
    });

    options.logger?.info('scheduler.run.finished', {
      // 只记码与计数，不记 prompt 与产物内容（Q14 同口径）
      reason: result.ok ? 'SUCCEEDED' : result.failureClass,
    });
  }

  return {
    ports,

    /**
     * 内核那边的回合结束了。宿主从事件流拿到 `turn/completed` / `turn/failed` 后调这里。
     *
     * 失败分类在这一步而不是在 scheduler 里，因为只有这里同时看得到
     * 内核的错误码、工作空间状态与审批超时。
     */
    onTurnFinished(input: {
      readonly threadId: string;
      readonly ok: boolean;
      readonly tokenUsage?: number | undefined;
      readonly modelErrorCode?: string | undefined;
      readonly exitCode?: number | undefined;
      readonly budgetExceeded?: boolean | undefined;
      readonly kernelExited?: boolean | undefined;
    }): void {
      const entry = [...active.values()].find((run) => run.threadId === input.threadId);
      if (!entry) return; // 不是定时任务的 thread
      const automation = options.store.get(entry.automationId);
      if (!automation) return;

      if (input.ok) {
        finish(automation, entry.fireTime, input.threadId, {
          ok: true,
          ...(input.tokenUsage !== undefined ? { tokenUsage: input.tokenUsage } : {}),
        });
        return;
      }

      const failureClass = classifyFailure({
        ...(input.kernelExited !== undefined ? { kernelExited: input.kernelExited } : {}),
        workspaceMissing: (automation.workspaces ?? []).some(
          (path) => !(options.workspaceExists?.(path) ?? true),
        ),
        ...(input.budgetExceeded !== undefined ? { budgetExceeded: input.budgetExceeded } : {}),
        ...(input.modelErrorCode !== undefined ? { modelErrorCode: input.modelErrorCode } : {}),
        ...(input.exitCode !== undefined ? { exitCode: input.exitCode } : {}),
      });
      finish(automation, entry.fireTime, input.threadId, {
        ok: false,
        failureClass,
        summary: failureSummary(failureClass),
      });
    },

    /**
     * 内核崩了：所有在跑的定时任务都判 `ENVIRONMENT`（不计连败）。
     *
     * 这条很重要 —— 内核崩溃是环境问题，把它算成任务失败会让用户的自动化
     * 在一次崩溃 + 两次别的失败之后被自动暂停。
     */
    onKernelExit(): void {
      for (const run of [...active.values()]) {
        const automation = options.store.get(run.automationId);
        if (!automation) continue;
        finish(automation, run.fireTime, run.threadId, {
          ok: false,
          failureClass: 'ENVIRONMENT',
          summary: '执行内核在任务进行中退出',
        });
      }
    },

    /** 当前在跑的定时任务数（并发上限与 UI 的 `2/3 运行中` 用它）。 */
    runningCount: () => active.size,

    /** 关停时清掉所有定时器，否则测试与热重载会泄漏。 */
    dispose(): void {
      for (const run of active.values()) if (run.approvalTimer) clearTimeout(run.approvalTimer);
      active.clear();
    },
  };
}

const FAILURE_SUMMARY: Readonly<Record<FailureClass, string>> = {
  MODEL: '模型调用失败',
  SCRIPT: '执行过程中出错',
  APPROVAL_TIMEOUT: '等待确认超时',
  ENVIRONMENT: '运行环境的问题（不计入连续失败）',
  QUOTA: '超出预算上限',
};

function failureSummary(failureClass: FailureClass): string {
  return FAILURE_SUMMARY[failureClass];
}
