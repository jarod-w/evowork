/**
 * 失败语义（Q8 + 07 §8-2 的细化）。
 *
 * ## 一条对 Q8 的关键细化
 *
 * Q8 定的是「失败不自动重试 + 连续 3 次自动 PAUSE」。07 §8-2 加了一句：
 * **环境原因失败不计入 `consecutive_failures`**。
 *
 * 理由值得原样记住：电脑关机导致执行中断、工作空间路径失效这类失败，
 * 在笔记本用户身上每周都会发生几次。如果它们计数，笔记本用户的自动化
 * **会在三天内全部被自动暂停** —— 而用户完全不知道为什么。
 *
 * 只有任务自身失败（模型报错、脚本崩了、审批超时）才计数。
 */

export type FailureClass = 'MODEL' | 'SCRIPT' | 'APPROVAL_TIMEOUT' | 'ENVIRONMENT' | 'QUOTA';

/** 计入连续失败的类别。**ENVIRONMENT 与 QUOTA 不计**。 */
const COUNTED: readonly FailureClass[] = ['MODEL', 'SCRIPT', 'APPROVAL_TIMEOUT'];

export const CONSECUTIVE_FAILURE_LIMIT = 3;

export function countsTowardPause(failureClass: FailureClass): boolean {
  return COUNTED.includes(failureClass);
}

export interface FailureOutcome {
  readonly consecutiveFailures: number;
  /** 达到上限，自动置 PAUSED（Q8） */
  readonly shouldPause: boolean;
  /** 暂停时给用户的通知文案。**必须说清怎么恢复** */
  readonly notice?: string;
}

export function applyFailure(
  current: number,
  failureClass: FailureClass,
  automationName: string,
): FailureOutcome {
  if (!countsTowardPause(failureClass)) {
    // 环境原因不计数，也**不清零** —— 清零会让"每次失败之间夹一次关机"变成永不暂停
    return { consecutiveFailures: current, shouldPause: false };
  }
  const next = current + 1;
  if (next < CONSECUTIVE_FAILURE_LIMIT) return { consecutiveFailures: next, shouldPause: false };
  return {
    consecutiveFailures: next,
    shouldPause: true,
    notice:
      `「${automationName}」连续失败 ${next} 次，已自动暂停。` +
      '打开它看看最近几次的失败原因，改好之后在详情页点「恢复」即可。',
  };
}

/** 成功时清零。 */
export function applySuccess(): { readonly consecutiveFailures: number } {
  return { consecutiveFailures: 0 };
}

/**
 * 从一次执行的结果推断失败类别。
 *
 * 分不出来时归到 `SCRIPT`（计数）而不是 `ENVIRONMENT`（不计数）——
 * 猜成不计数的那一侧，等于让一个真实故障永远不触发自动暂停。
 */
export function classifyFailure(signals: {
  readonly kernelExited?: boolean;
  readonly workspaceMissing?: boolean;
  readonly approvalTimedOut?: boolean;
  readonly budgetExceeded?: boolean;
  readonly modelErrorCode?: string | undefined;
  readonly exitCode?: number | undefined;
}): FailureClass {
  if (signals.workspaceMissing || signals.kernelExited) return 'ENVIRONMENT';
  if (signals.approvalTimedOut) return 'APPROVAL_TIMEOUT';
  if (signals.budgetExceeded) return 'QUOTA';
  if (signals.modelErrorCode) return 'MODEL';
  return 'SCRIPT';
}

/**
 * 无人值守的审批超时（10 §3.6 / 总纲 §10-2）：**10 分钟后自动取消**。
 * 交互式任务不自动拒绝 —— 那条在 `services/kernel-adapter` 的审批策略里。
 */
export const UNATTENDED_APPROVAL_TIMEOUT_MS = 10 * 60_000;
