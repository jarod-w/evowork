/**
 * 派生任务状态（04 §2.2）。
 *
 * 这是整个投影表存在的核心理由。实测（F7/F8）：
 *   · `ThreadStatus` 只有 `notLoaded | idle | systemError | active{activeFlags}`；
 *   · **已完成 / 失败 / 已中断都不在里面** —— 它们只出现在 `turn/completed` 的 `TurnStatus` 里；
 *   · 未加载的 thread 状态恒为 `notLoaded`，**不携带上次执行结果**。
 *
 * 所以"这个任务现在是什么状态"这个最基本的问题，必须由**实时状态 + 投影表记录**共同回答。
 * 少了任何一半都会得出错误答案：只看 `ThreadStatus`，所有历史任务都是 `notLoaded`；
 * 只看投影表，正在跑的任务看不出来。
 */
import type { ThreadActiveFlag, ThreadStatus, TurnStatus } from '@evowork/protocol';

import type { DerivedStatus } from './schema.js';

export interface DeriveInput {
  /** 内核的实时状态（来自 `thread/status/changed` 或 `thread/list`） */
  readonly threadStatus?: ThreadStatus | null;
  /** 投影表记录的上一个回合结果（来自 `turn/completed`） */
  readonly lastTurnStatus?: TurnStatus | null;
  /** 归档是内核的权威字段 */
  readonly archived?: boolean;
  /** 工作模式：plan 模式下未确认的计划算"规划中" */
  readonly modeId?: string | null;
  readonly hasPlanItem?: boolean;
  readonly planConfirmed?: boolean;
}

function activeFlags(status: ThreadStatus | null | undefined): readonly ThreadActiveFlag[] | null {
  if (status && typeof status === 'object' && 'active' in status) {
    return status.active.activeFlags ?? [];
  }
  return null;
}

/**
 * 判定顺序即优先级，每一条都对应 04 §2.2 表里的一行。
 *
 * 顺序里有两处是刻意的：
 *
 * ① **归档最先**。归档任务即使内核那边还是 active（比如刚归档但 turn 没停），
 *    在列表里也应该按已归档呈现 —— 用户的动作优先于系统状态。
 *
 * ② **「待处理」优先于「进行中」**。它在内核层面同样是 active（是 active 的子态），
 *    但它是唯一需要用户**立刻行动**的状态，在任务列表里必须提到最前面（04 §2.3）。
 *    把它并进"进行中"会让用户找不到那个卡住的任务。
 */
export function deriveStatus(input: DeriveInput): DerivedStatus {
  if (input.archived) return 'archived';

  const flags = activeFlags(input.threadStatus);
  if (flags !== null) {
    if (flags.includes('waitingOnApproval') || flags.includes('waitingOnUserInput')) {
      return 'pending';
    }
    return 'running';
  }

  if (input.threadStatus === 'systemError') return 'failed';

  // 规划中：mode=plan 且有 plan item 且用户尚未确认执行。
  // 注意它排在 last_turn_status 之后判断会出错 —— plan 模式下产出计划的那个回合本身是
  // completed，所以若先看 last_turn_status，"规划中"永远不会出现。
  if (input.modeId === 'plan' && input.hasPlanItem && !input.planConfirmed) {
    return 'planning';
  }

  switch (input.lastTurnStatus) {
    case 'completed':
      return 'completed';
    case 'failed':
      return 'failed';
    case 'interrupted':
      return 'interrupted';
    case 'inProgress':
      // 投影表说还在跑，但内核说不 active —— 典型情况是内核重启过。
      // 报"已中断"而不是"进行中"：进行中是谎话，用户会一直等一个不会来的结果。
      return 'interrupted';
    default:
      return 'idle';
  }
}

/** 六态 + 已中断 的中文文案（01 §6.1）。「待你确认」用第二人称，因为它要求用户行动。 */
export const STATUS_LABEL: Readonly<Record<DerivedStatus, string>> = Object.freeze({
  running: '进行中',
  planning: '规划中',
  pending: '待你确认',
  completed: '已完成',
  failed: '失败',
  interrupted: '已中断，可继续',
  archived: '已归档',
  idle: '还没有开始',
});
