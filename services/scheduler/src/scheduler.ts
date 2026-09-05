/**
 * 调度循环（总纲 §6.9 的「执行（Q1=A 版本）」）。
 *
 * ```
 * 启动 → ① misfire 扫描（先写 MISSED 再补跑）
 *      → ② 循环：到点 → 幂等落库 → 并发检查 → 起 thread
 *      → ③ 结果回写：成功清零 / 失败按类别计数 / 连续 3 次自动 PAUSE
 * ```
 *
 * ## 单机单进程，不需要分布式锁
 *
 * 幂等键 `automation_id + fire_time` 已经是 sqlite 的唯一索引（09 §6.2）。
 * 插入冲突 = 这一次已经被处理过，直接跳过 —— 比先查后写少一个竞态。
 *
 * ## 时钟注入
 *
 * `now` 与 `setTimer` 都是注入的。misfire 的整个规格（关机一夜、跨 DST、补偿窗口）
 * 只能用可控时钟测 —— 真机关机一夜属于 U3，单测证明不了 OS 行为，
 * 但**能证明"给定这样的时间线，落库顺序与文案是对的"**，那正是 R9 里我们能负责的一半。
 */

import { nextFire } from './cron.js';
import { applyFailure, applySuccess, type FailureClass } from './failure.js';
import {
  planMisfire,
  type MisfireAction,
  type MisfirePolicy,
  type SkipReason,
  type TriggerKind,
} from './misfire.js';

export interface AutomationDefinition {
  readonly id: string;
  readonly name: string;
  /** 自然语言任务描述（总纲 §6.9）。触发时它就是第一条用户消息 */
  readonly prompt: string;
  readonly deviceId: string;
  readonly schedule: string;
  readonly timezone: string;
  readonly status: 'ACTIVE' | 'PAUSED';
  readonly misfirePolicy: MisfirePolicy;
  readonly catchupWindowMs: number;
  readonly consecutiveFailures: number;
  readonly lastFireTime?: number | undefined;
  readonly validFrom?: number | undefined;
  readonly validUntil?: number | undefined;
  /** 07 §8-3：定时任务**强制**硬预算 */
  readonly budgetLimit: number;
  readonly workspaces: readonly string[];
}

export interface RunRecord {
  readonly automationId: string;
  readonly fireTime: number;
  readonly status: 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'SKIPPED' | 'MISSED';
  readonly trigger: TriggerKind;
  readonly skipReason?: SkipReason | undefined;
  readonly originalFireTime?: number | undefined;
  readonly threadId?: string | undefined;
}

export interface SchedulerPorts {
  readonly now: () => number;
  /** 落一条执行记录。返回 false 表示幂等键冲突（这一次已经处理过） */
  readonly insertRun: (record: RunRecord) => boolean;
  readonly updateAutomation: (
    id: string,
    patch: {
      readonly status?: 'ACTIVE' | 'PAUSED';
      readonly consecutiveFailures?: number;
      readonly lastFireTime?: number;
    },
  ) => void;
  /** 起一个 thread 执行它。返回 threadId */
  readonly startRun: (automation: AutomationDefinition, fireTime: number) => Promise<string>;
  /** 这个 automation 现在有没有在跑（Q8：SKIP 而不是并行） */
  readonly isRunning: (automationId: string) => boolean;
  readonly notify: (text: string) => void;
  /** 本机设备 id：不是绑定设备就**只读**（Q15） */
  readonly deviceId: string;
}

export interface FireOutcome {
  readonly fired: boolean;
  readonly reason?: 'NOT_THIS_DEVICE' | 'PAUSED' | 'OUT_OF_WINDOW' | 'CONCURRENCY' | 'DUPLICATE';
}

export function createScheduler(ports: SchedulerPorts) {
  /**
   * 启动时的 misfire 扫描。**返回落库顺序**，调用方按序执行。
   *
   * 非绑定设备直接返回空：其他电脑能看见这个 automation，但不会重复执行（Q15）。
   */
  function scanOnStart(automation: AutomationDefinition): readonly MisfireAction[] {
    if (automation.deviceId !== ports.deviceId) return [];
    if (automation.status === 'PAUSED') return [];
    return planMisfire({
      schedule: automation.schedule,
      timezone: automation.timezone,
      policy: automation.misfirePolicy,
      catchupWindowMs: automation.catchupWindowMs,
      lastFireTime: automation.lastFireTime,
      now: ports.now(),
      validFrom: automation.validFrom,
      validUntil: automation.validUntil,
    });
  }

  /** 把 misfire 计划落库并补跑。**先写 MISSED 再补跑**（07 §8-1 的落库顺序）。 */
  async function applyMisfirePlan(
    automation: AutomationDefinition,
    plan: readonly MisfireAction[],
  ): Promise<void> {
    for (const action of plan) {
      if (action.status === 'MISSED') {
        ports.insertRun({
          automationId: automation.id,
          fireTime: action.fireTime,
          status: 'MISSED',
          trigger: action.trigger,
          skipReason: action.skipReason,
        });
        continue;
      }
      await fire(automation, action.fireTime, 'CATCHUP', action.originalFireTime);
    }
  }

  /**
   * 到点执行一次。
   *
   * 顺序：设备 → 暂停 → 生效期 → 并发 → 幂等 → 起 thread。
   * 并发在幂等之前，是因为 SKIP 也要落一条记录（用户要能看到"这次被跳过了"）。
   */
  async function fire(
    automation: AutomationDefinition,
    fireTime: number,
    trigger: TriggerKind = 'SCHEDULED',
    originalFireTime?: number,
  ): Promise<FireOutcome> {
    if (automation.deviceId !== ports.deviceId) return { fired: false, reason: 'NOT_THIS_DEVICE' };
    if (automation.status === 'PAUSED' && trigger === 'SCHEDULED') {
      return { fired: false, reason: 'PAUSED' };
    }
    if (
      (automation.validFrom !== undefined && fireTime < automation.validFrom) ||
      (automation.validUntil !== undefined && fireTime > automation.validUntil)
    ) {
      ports.insertRun({
        automationId: automation.id,
        fireTime,
        status: 'SKIPPED',
        trigger,
        skipReason: 'OUT_OF_WINDOW',
      });
      return { fired: false, reason: 'OUT_OF_WINDOW' };
    }

    // Q8：上次没跑完又到点 → SKIP（不并行、不排队）
    if (ports.isRunning(automation.id)) {
      ports.insertRun({
        automationId: automation.id,
        fireTime,
        status: 'SKIPPED',
        trigger,
        skipReason: 'CONCURRENCY',
      });
      return { fired: false, reason: 'CONCURRENCY' };
    }

    const inserted = ports.insertRun({
      automationId: automation.id,
      fireTime,
      status: 'RUNNING',
      trigger,
      ...(originalFireTime !== undefined ? { originalFireTime } : {}),
    });
    // 幂等键冲突 = 这一次已经被处理过（比先查后写少一个竞态）
    if (!inserted) return { fired: false, reason: 'DUPLICATE' };

    const threadId = await ports.startRun(automation, fireTime);
    ports.updateAutomation(automation.id, { lastFireTime: fireTime });
    void threadId;
    return { fired: true };
  }

  /** 执行结束后的回写（Q8 + 07 §8-2）。 */
  function complete(
    automation: AutomationDefinition,
    result: { readonly ok: true } | { readonly ok: false; readonly failureClass: FailureClass },
  ): void {
    if (result.ok) {
      ports.updateAutomation(automation.id, applySuccess());
      return;
    }
    const outcome = applyFailure(
      automation.consecutiveFailures,
      result.failureClass,
      automation.name,
    );
    ports.updateAutomation(automation.id, {
      consecutiveFailures: outcome.consecutiveFailures,
      ...(outcome.shouldPause ? { status: 'PAUSED' as const } : {}),
    });
    if (outcome.notice) ports.notify(outcome.notice);
  }

  /** 下一次该在什么时候醒。返回 undefined 表示不再触发。 */
  function nextWakeup(automation: AutomationDefinition): number | undefined {
    if (automation.status === 'PAUSED' || automation.deviceId !== ports.deviceId) return undefined;
    const next = nextFire(automation.schedule, ports.now(), automation.timezone);
    if (next === undefined) return undefined;
    if (automation.validUntil !== undefined && next > automation.validUntil) return undefined;
    return next;
  }

  return { scanOnStart, applyMisfirePlan, fire, complete, nextWakeup };
}
