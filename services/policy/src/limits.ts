/**
 * 并发与预算闸门（10 §5，Q11）。
 *
 * ## 并发上限**不可上调**
 *
 * 10 §5.1 的原话：Q1=A 下机器就是资源上限（D9），让用户把并发调到 8 然后抱怨卡顿，
 * 不如直接不给这个选项。所以 `applyUserPreference` 只接受"更小"。
 *
 * ## 预算耗尽是**暂停并询问**，不是失败
 *
 * Q11：超预算暂停询问，**不自动降级、不静默失败**。这两个"不"分别对应两种偷懒实现：
 * 悄悄换个便宜模型继续（用户拿到质量更差的产物却不知道为什么），
 * 或者直接报错结束（用户丢掉已经跑了一半的工作）。
 */

export interface MachineResources {
  readonly totalMemoryBytes: number;
  readonly cpuCount: number;
}

export const MAX_CONCURRENCY = 3;

/**
 * `min(3, floor(可用内存GB / 2), CPU核数 - 1)`，最低 1（10 §5.1 的公式）。
 */
export function computeConcurrencyLimit(resources: MachineResources): number {
  const byMemory = Math.floor(resources.totalMemoryBytes / (2 * 1024 * 1024 * 1024));
  const byCpu = resources.cpuCount - 1;
  return Math.max(1, Math.min(MAX_CONCURRENCY, byMemory, byCpu));
}

/** 用户只能往下调。传大于计算值的数会被夹回去，而不是报错 —— 这不是用户的错。 */
export function applyUserPreference(computed: number, preference: number | undefined): number {
  if (preference === undefined) return computed;
  return Math.max(1, Math.min(computed, Math.floor(preference)));
}

export type ConcurrencyVerdict =
  | { readonly allowed: true; readonly running: number; readonly limit: number }
  | {
      readonly allowed: false;
      readonly running: number;
      readonly limit: number;
      /** 排在第几个（03 §8 的「排队中（前面 N 个）」） */
      readonly queuePosition: number;
      readonly reason: string;
    };

export function checkConcurrency(
  running: number,
  queued: number,
  limit: number,
): ConcurrencyVerdict {
  if (running < limit) return { allowed: true, running, limit };
  return {
    allowed: false,
    running,
    limit,
    queuePosition: queued + 1,
    reason: `本机同时最多跑 ${limit} 个任务（按这台机器的内存与核数算出来的）。新任务会排队，不会丢。`,
  };
}

/** 子 agent 派生也受同一个上限约束（总纲 §6.12：用 subagent_start hook 拒绝超限派生）。 */
export function checkSubagentSpawn(
  activeSubagents: number,
  limit: number,
): { readonly allow: boolean; readonly reason?: string } {
  if (activeSubagents < limit) return { allow: true };
  return {
    allow: false,
    reason: `已经有 ${activeSubagents} 个子任务在跑，达到本机上限 ${limit}。等一个跑完再派新的。`,
  };
}

export interface BudgetState {
  /** 已用 token */
  readonly used: number;
  /** 硬预算。未设时为 undefined —— 定时任务**必须**设（07 §3.2） */
  readonly budget?: number | undefined;
}

export type BudgetVerdict = 'ok' | 'warn' | 'exceeded';

/** >80% 转 warning（10 §5.2 的进度条规则）。 */
export function checkBudget(state: BudgetState): {
  readonly verdict: BudgetVerdict;
  readonly ratio?: number;
} {
  if (state.budget === undefined || state.budget <= 0) return { verdict: 'ok' };
  const ratio = state.used / state.budget;
  if (ratio >= 1) return { verdict: 'exceeded', ratio };
  if (ratio > 0.8) return { verdict: 'warn', ratio };
  return { verdict: 'ok', ratio };
}

/**
 * 预算耗尽时给用户的两个动作。
 *
 * 只有两个，且**都不是"继续但用便宜模型"** —— 那是自动降级，Q11 明确不要。
 */
export const BUDGET_ACTIONS = Object.freeze(['追加预算', '结束任务'] as const);

/**
 * 成本显示的诚实要求（10 §5.2）。
 *
 * 显示 token 数为主、估算金额为辅，且金额旁标「估算」。各家计量口径不同（D2），
 * 把估算值显示得像账单会造成信任问题。
 */
export function formatCost(tokens: number, estimatedCny?: number): string {
  const base = `${tokens.toLocaleString('zh-CN')} tokens`;
  return estimatedCny === undefined ? base : `${base}（估算 ¥${estimatedCny.toFixed(2)}）`;
}
