/**
 * 跨任务待办。人离开当前对话之后，批准、预算和被拦住的访问仍要能点回去。
 * 不建通知中心：一条列表，侧栏和首页共用。
 */
import type { TaskStatusView } from '../shared/ipc.js';

export type AttentionKind = 'approval' | 'budget' | 'blocked' | 'automation';

export interface AttentionItem {
  readonly id: string;
  readonly kind: AttentionKind;
  readonly title: string;
  readonly detail: string;
  readonly threadId?: string | undefined;
  readonly automationId?: string | undefined;
}

export interface HomePulse {
  readonly hasHistory: boolean;
  readonly running: number;
  readonly waiting: number;
  readonly pausedAutomations: number;
}

export interface AttentionTask {
  readonly id: string;
  readonly title: string | null;
  readonly status: TaskStatusView;
  readonly updatedAt: number;
  readonly parentThreadId?: string | null | undefined;
}

export interface AttentionApproval {
  readonly threadId: string;
  readonly impact?: string | undefined;
  readonly reason?: string | undefined;
  readonly question?: string | undefined;
}

export interface AttentionGoal {
  readonly threadId: string;
  readonly status: 'active' | 'paused' | 'blocked' | 'usageLimited' | 'budgetLimited' | 'complete';
  readonly tokenBudget: number | null;
  readonly tokensUsed: number;
}

export interface AttentionAudit {
  readonly occurredAt: number;
  readonly action: string;
  readonly threadId?: string | undefined;
  readonly pathKind?: string | undefined;
}

export interface AttentionAutomation {
  readonly id: string;
  readonly name: string;
  readonly status: string;
  readonly consecutiveFailures?: number | undefined;
}

export interface AttentionInput {
  readonly tasks: readonly AttentionTask[];
  readonly approvals: readonly AttentionApproval[];
  readonly goals: readonly AttentionGoal[];
  readonly audits: readonly AttentionAudit[];
  readonly automations: readonly AttentionAutomation[];
}

/** 还没结束、人可能还要处理的任务。已完成的历史拦截不再占待办。 */
const OPEN_STATUS = new Set<TaskStatusView>([
  'running',
  'planning',
  'pending',
  'failed',
  'interrupted',
]);

/** 与审计页同一套分类名。不把路径或摘要原文放进待办。 */
const BLOCKED_PLACE: Readonly<Record<string, string>> = {
  'system-dirs': '系统目录',
  credentials: '密钥与凭据',
  'evowork-self': 'EvoWork 自身配置',
  'evowork-history': '任务对话记录',
  'personal-dir': '个人目录',
  'outside-workspace': '工作空间之外',
  workspace: '工作空间内',
};

export interface WorkSummary {
  readonly items: readonly AttentionItem[];
  readonly pulse: HomePulse;
}

function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > 80 ? `${flat.slice(0, 80)}…` : flat;
}

function taskTitle(task: AttentionTask | undefined): string {
  const title = task?.title?.trim();
  return title ? title : '未命名任务';
}

function goalExhausted(goal: AttentionGoal): boolean {
  if (goal.status === 'complete') return false;
  if (goal.status === 'budgetLimited' || goal.status === 'usageLimited') return true;
  return goal.tokenBudget != null && goal.tokensUsed >= goal.tokenBudget;
}

function budgetDetail(goal: AttentionGoal | undefined): string {
  if (goal?.status === 'usageLimited') return '用量达到上限，任务已暂停';
  if (goal?.tokenBudget != null) return `预算已用完（${goal.tokensUsed} / ${goal.tokenBudget}）`;
  return '预算已用完，任务已暂停';
}

function blockedDetail(pathKind: string | undefined): string {
  const place = pathKind ? BLOCKED_PLACE[pathKind] : undefined;
  return place ? `已拦住对${place}的访问` : '有一次访问被拦住了';
}

export function summarizeWork(input: AttentionInput): WorkSummary {
  const byId = new Map(input.tasks.map((task) => [task.id, task]));
  const topLevel = input.tasks.filter((task) => task.parentThreadId == null);
  const items: AttentionItem[] = [];

  const approvalsByThread = new Map<string, AttentionApproval[]>();
  for (const approval of input.approvals) {
    const group = approvalsByThread.get(approval.threadId) ?? [];
    group.push(approval);
    approvalsByThread.set(approval.threadId, group);
  }
  const approvalThreads = [...approvalsByThread.entries()].sort(
    (a, b) => (byId.get(b[0])?.updatedAt ?? 0) - (byId.get(a[0])?.updatedAt ?? 0),
  );
  for (const [threadId, group] of approvalThreads) {
    const first = group[0];
    if (!first) continue;
    const lead = oneLine(first.impact ?? first.reason ?? first.question ?? '需要你确认后才能继续');
    items.push({
      id: `approval:${threadId}`,
      kind: 'approval',
      title: taskTitle(byId.get(threadId)),
      detail: group.length > 1 ? `${lead} · 共 ${group.length} 项` : lead,
      threadId,
    });
  }

  for (const task of topLevel
    .filter((row) => row.status === 'pending' && !approvalsByThread.has(row.id))
    .sort((a, b) => b.updatedAt - a.updatedAt)) {
    items.push({
      id: `pending:${task.id}`,
      kind: 'approval',
      title: taskTitle(task),
      detail: '任务停在需要你确认的地方',
      threadId: task.id,
    });
  }

  const goalsByThread = new Map(input.goals.map((goal) => [goal.threadId, goal]));
  const budgetThreads: string[] = [];
  const seenBudget = new Set<string>();
  const audits = [...input.audits].sort((a, b) => b.occurredAt - a.occurredAt);
  const rememberBudget = (threadId: string): void => {
    const task = byId.get(threadId);
    if (!task || !OPEN_STATUS.has(task.status) || seenBudget.has(threadId)) return;
    seenBudget.add(threadId);
    budgetThreads.push(threadId);
  };
  for (const record of audits) {
    if (record.action === 'budget.exceeded' && record.threadId) rememberBudget(record.threadId);
  }
  for (const goal of input.goals) {
    if (goalExhausted(goal)) rememberBudget(goal.threadId);
  }
  for (const threadId of budgetThreads) {
    items.push({
      id: `budget:${threadId}`,
      kind: 'budget',
      title: taskTitle(byId.get(threadId)),
      detail: budgetDetail(goalsByThread.get(threadId)),
      threadId,
    });
  }

  const seenBlocked = new Set<string>();
  for (const record of audits) {
    if (record.action !== 'path.blocked' || !record.threadId || seenBlocked.has(record.threadId))
      continue;
    const task = byId.get(record.threadId);
    if (!task || !OPEN_STATUS.has(task.status)) continue;
    seenBlocked.add(record.threadId);
    items.push({
      id: `blocked:${record.threadId}`,
      kind: 'blocked',
      title: taskTitle(task),
      detail: blockedDetail(record.pathKind),
      threadId: record.threadId,
    });
  }

  const paused = input.automations.filter((row) => row.status === 'PAUSED');
  for (const row of paused) {
    const failures = row.consecutiveFailures ?? 0;
    items.push({
      id: `automation:${row.id}`,
      kind: 'automation',
      title: row.name,
      detail: failures >= 3 ? `连续失败 ${failures} 次后自动暂停` : '已暂停，不会按计划运行',
      automationId: row.id,
    });
  }

  return {
    items,
    pulse: {
      hasHistory: input.tasks.length > 0 || input.automations.length > 0,
      running: topLevel.filter((task) => task.status === 'running' || task.status === 'planning')
        .length,
      waiting: items.filter((item) => item.kind !== 'automation').length,
      pausedAutomations: paused.length,
    },
  };
}

export function newestActiveTask(tasks: readonly AttentionTask[]): AttentionTask | undefined {
  return [...tasks]
    .filter(
      (task) =>
        task.parentThreadId == null && (task.status === 'running' || task.status === 'planning'),
    )
    .sort((a, b) => b.updatedAt - a.updatedAt)[0];
}
