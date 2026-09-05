/**
 * 错过补偿（D5 / 总纲 §6.9 / 07 §4.3）—— Q1=A 最特有的一块。
 *
 * ## 为什么它比看上去重要
 *
 * 云端调度器不会"错过"：机器一直开着。而 Q1=A 下调度器跑在用户的笔记本上，
 * 合盖一晚上就错过 8 次触发。用户第二天早上打开电脑，看到的应该是什么？
 *
 * 07 §8-1 给了答案，而且它决定的是**落库顺序**不只是 UI：
 * 历史里必须出现**两条**记录 —— 一条 `MISSED / MACHINE_OFFLINE` 指向原定时刻，
 * 一条 `SUCCEEDED` 标注「补跑（原定 …）」。**只留补跑那一条，用户永远不知道自己漏了。**
 *
 * 所以 `planMisfire` 返回的是一个**有序的动作列表**，而不是"要不要补跑"这个布尔。
 */

import { nextFire } from './cron.js';

export type MisfirePolicy = 'FIRE_ONCE_ON_WAKE' | 'FIRE_ALL' | 'DROP';

export type RunStatus = 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'SKIPPED' | 'MISSED';
export type SkipReason = 'CONCURRENCY' | 'MACHINE_OFFLINE' | 'OUT_OF_WINDOW' | 'QUOTA';
export type TriggerKind = 'SCHEDULED' | 'MANUAL' | 'MANUAL_TEST' | 'CATCHUP';

export interface MisfireAction {
  readonly fireTime: number;
  readonly status: Extract<RunStatus, 'MISSED'> | 'PENDING_RUN';
  readonly trigger: TriggerKind;
  readonly skipReason?: SkipReason;
  /** CATCHUP 时指向原定时刻（总纲 §6.9 的 `original_fire_time`） */
  readonly originalFireTime?: number;
}

export interface MisfireInput {
  readonly schedule: string;
  readonly timezone: string;
  readonly policy: MisfirePolicy;
  readonly catchupWindowMs: number;
  /** 上次真实触发的时刻；从未触发过时为 undefined */
  readonly lastFireTime?: number | undefined;
  /** 现在 */
  readonly now: number;
  /** 生效期（07 §3.2） */
  readonly validFrom?: number | undefined;
  readonly validUntil?: number | undefined;
}

/** 扫描区间：`[max(last_fire, now - catchup_window), now]`（总纲 §6.9 原文）。 */
export function scanWindow(input: MisfireInput): { readonly from: number; readonly to: number } {
  const windowStart = input.now - input.catchupWindowMs;
  const from = Math.max(input.lastFireTime ?? windowStart, windowStart);
  return { from, to: input.now };
}

/** 区间内所有应触发而未落库的时刻。 */
export function missedFireTimes(input: MisfireInput): readonly number[] {
  const { from, to } = scanWindow(input);
  const times: number[] = [];
  let cursor = from;
  // 上界防呆：一分钟一次也不会超过窗口的分钟数
  const limit = Math.ceil(input.catchupWindowMs / 60_000) + 2;
  for (let index = 0; index < limit; index += 1) {
    const next = nextFire(input.schedule, cursor, input.timezone);
    if (next === undefined || next > to) break;
    if (withinValidity(next, input)) times.push(next);
    cursor = next;
  }
  return times;
}

function withinValidity(at: number, input: MisfireInput): boolean {
  if (input.validFrom !== undefined && at < input.validFrom) return false;
  if (input.validUntil !== undefined && at > input.validUntil) return false;
  return true;
}

/**
 * 补偿计划。**顺序即落库顺序**：先写 MISSED，再写要补跑的那条。
 *
 * 三种策略（07 §4.3 的人话在括号里）：
 *   · `FIRE_ONCE_ON_WAKE`（开机后补跑一次）—— 全部记 MISSED，**最近的那次**改成补跑
 *   · `FIRE_ALL`（逐次补齐）—— 每一次都补跑
 *   · `DROP`（不补跑）—— 全部记 MISSED，一次都不跑
 */
export function planMisfire(input: MisfireInput): readonly MisfireAction[] {
  const missed = missedFireTimes(input);
  if (missed.length === 0) return [];

  if (input.policy === 'DROP') {
    return missed.map((fireTime) => offline(fireTime));
  }

  if (input.policy === 'FIRE_ALL') {
    return missed.flatMap((fireTime) => [
      // 即使马上要补跑，也**先记一条 MISSED** —— 用户要能看到"这一次原本是被错过的"
      offline(fireTime),
      {
        fireTime: fireTime,
        status: 'PENDING_RUN' as const,
        trigger: 'CATCHUP' as const,
        originalFireTime: fireTime,
      },
    ]);
  }

  // FIRE_ONCE_ON_WAKE：全部记 MISSED，只有最近的一次补跑
  const latest = missed[missed.length - 1] as number;
  return [
    ...missed.map((fireTime) => offline(fireTime)),
    {
      fireTime: latest,
      status: 'PENDING_RUN' as const,
      trigger: 'CATCHUP' as const,
      originalFireTime: latest,
    },
  ];
}

function offline(fireTime: number): MisfireAction {
  return {
    fireTime,
    status: 'MISSED',
    trigger: 'SCHEDULED',
    skipReason: 'MACHINE_OFFLINE',
  };
}

/**
 * 历史条目的文案（07 §8-1：补跑那条要标注原定时刻）。
 *
 * 放在这里而不是 UI 层，是因为它与 `planMisfire` 产出的动作一一对应 ——
 * 两边分开写，早晚会出现"跑了但历史里说没跑"这种自相矛盾的显示。
 */
export function describeRun(action: {
  readonly status: RunStatus;
  readonly trigger: TriggerKind;
  readonly skipReason?: SkipReason | undefined;
  readonly originalFireTime?: number | undefined;
  readonly formatTime: (at: number) => string;
}): string {
  if (action.status === 'MISSED' && action.skipReason === 'MACHINE_OFFLINE') {
    return '错过（电脑当时未开机）';
  }
  if (action.status === 'SKIPPED' && action.skipReason === 'CONCURRENCY') {
    return '跳过（上一次还没跑完）';
  }
  if (action.trigger === 'CATCHUP' && action.originalFireTime !== undefined) {
    return `补跑（原定 ${action.formatTime(action.originalFireTime)}）`;
  }
  if (action.trigger === 'MANUAL_TEST') return '试跑';
  if (action.trigger === 'MANUAL') return '手动执行';
  return '按计划执行';
}
