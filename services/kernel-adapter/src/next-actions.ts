import { NextActionStore, type NextAction, type Store } from '@evowork/store';
import type { Adapter } from './adapter.js';
import type { UiEvent } from './events.js';

/** Only fixed field paths and expectations enter errors; never echo user values or keys. */
function proposalIssues(raw: unknown): string[] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return ['arguments 必须是对象'];
  const input = raw as Record<string, unknown>;
  const issues: string[] = [];
  if (Object.keys(input).some((key) => !['outcome', 'actions'].includes(key)))
    issues.push('arguments 包含不支持的字段，仅允许 outcome、actions');
  if (input.outcome !== 'delivered' && input.outcome !== 'needs_input')
    issues.push('outcome 必须是 delivered 或 needs_input');
  if (!Array.isArray(input.actions) || input.actions.length > 3) {
    issues.push('actions 必须是最多 3 条的数组');
    return issues;
  }
  if (input.outcome === 'needs_input' && input.actions.length)
    issues.push('needs_input 时 actions 必须为空数组');
  input.actions.forEach((item: unknown, index: number) => {
    const path = `actions[${index}]`;
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      issues.push(`${path} 必须是对象`);
      return;
    }
    const action = item as Record<string, unknown>;
    if (Object.keys(action).some((key) => !['title', 'prompt', 'reason'].includes(key)))
      issues.push(`${path} 包含不支持的字段，仅允许 title、prompt、reason`);
    for (const [field, max] of [
      ['title', 80],
      ['prompt', 2000],
    ] as const) {
      const value = action[field];
      if (typeof value !== 'string' || !value.trim() || value.length > max)
        issues.push(`${path}.${field} 必须是 1–${max} 字符的非空字符串`);
    }
    if (
      action.reason !== undefined &&
      (typeof action.reason !== 'string' || action.reason.length > 300)
    )
      issues.push(`${path}.reason 必须是不超过 300 字符的字符串`);
  });
  return issues;
}

export function createNextActions(options: {
  store: Store;
  adapter: () => Adapter;
  changed: (threadId: string) => void;
}) {
  const repo = new NextActionStore(options.store);
  repo.expire(); // A crashed, unfinished proposal is never published on recovery.
  const turns = new Map<string, { turnId: string; attempted: boolean; reminded: boolean }>();
  const runningRoot = (threadId: string, turnId: string) => {
    const row = options.store.threads.get(threadId);
    return (
      row &&
      !row.archived &&
      !row.parent_thread_id &&
      !row.automation_id &&
      row.last_turn_id === turnId &&
      row.last_turn_status === 'inProgress'
    );
  };
  const eligible = (threadId: string, turnId: string) => {
    const row = options.store.threads.get(threadId);
    return (
      row &&
      !row.archived &&
      !row.parent_thread_id &&
      !row.automation_id &&
      row.last_turn_id === turnId &&
      row.last_turn_status === 'completed' &&
      row.derived_status === 'completed'
    );
  };
  return {
    propose(threadId: string, raw: unknown) {
      const bound = options
        .adapter()
        .resolveLocalToolCall(threadId, 'next_actions', 'propose_next_actions', raw);
      if (!bound) throw new Error('无法核对本次建议的来源回合。');
      const turn = turns.get(threadId);
      if (turn?.turnId === bound.turnId) turn.attempted = true;
      const issues = proposalIssues(raw);
      if (issues.length)
        throw new Error(`建议参数无效：${issues.join('；')}。继续交付当前任务，不重试。`);
      const input = raw as { actions: { title: string; prompt: string; reason?: string }[] };
      const actions: NextAction[] = input.actions.map((action, index) => {
        return {
          id: bound.callId + ':' + index,
          threadId,
          sourceTurnId: bound.turnId,
          title: action.title.trim(),
          prompt: action.prompt.trim(),
          ...(typeof action.reason === 'string' ? { reason: action.reason.trim() } : {}),
        };
      });
      repo.propose(threadId, bound.turnId, actions);
      return {
        saved: true,
        instruction: '候选已保存，回合完成后由宿主筛选展示；继续完成当前请求，不执行这些候选。',
      };
    },
    async checkStop(
      threadId: string,
      turnId: string,
      stopHookActive: boolean,
    ): Promise<{
      decision?: 'block';
      reason?: string;
    }> {
      const turn = turns.get(threadId);
      const eligible = () =>
        !stopHookActive &&
        turns.get(threadId) === turn &&
        turn?.turnId === turnId &&
        !turn.attempted &&
        !turn.reminded &&
        runningRoot(threadId, turnId) &&
        repo.get(threadId)?.turnId !== turnId;
      if (!eligible()) return {};
      try {
        const adapter = options.adapter();
        const [goal, queue] = await Promise.all([
          adapter.getGoal(threadId),
          adapter.listQueuedInputs(threadId),
        ]);
        if ((goal && goal.status !== 'complete') || queue.length || !eligible()) return {};
      } catch {
        return {}; // Optional guidance must never block completion on unknown state.
      }
      turn!.reminded = true;
      return {
        decision: 'block',
        reason:
          '本回合尚未登记下一步状态。若用户没有禁止工具且 propose_next_actions 可用，请现在仅调用该本机工具一次：已交付（包括只在回复中交付的计划/说明）用 outcome=delivered，优先将用户明确说出的下一阶段目标作为候选；等待补充用 outcome=needs_input、actions=[]；确无后续或用户不要建议则 actions=[]。不执行候选、不重复已交付正文、不重试失败工具。用户禁止工具或工具不可用则直接结束。此提醒仅一次，随后正常结束本回合。',
      };
    },
    async list(threadId: string): Promise<readonly NextAction[]> {
      const record = repo.get(threadId);
      if (
        !record ||
        record.state !== 'available' ||
        !record.actions.length ||
        !eligible(threadId, record.turnId)
      )
        return [];
      const adapter = options.adapter();
      const [goal, queue] = await Promise.all([
        adapter.getGoal(threadId),
        adapter.listQueuedInputs(threadId),
      ]);
      if (
        (goal && goal.status !== 'complete') ||
        queue.length ||
        !eligible(threadId, record.turnId)
      )
        return [];
      const current = repo.get(threadId);
      return current?.state === 'available' && current.turnId === record.turnId
        ? current.actions.slice(0, 1)
        : [];
    },
    async act(threadId: string, id: string, action: 'accepted' | 'dismissed'): Promise<NextAction> {
      const candidate = (await this.list(threadId)).find((item) => item.id === id);
      if (!candidate) throw new Error('这条建议已失效。');
      if (!repo.transition(threadId, candidate.sourceTurnId, 'available', action))
        throw new Error('这条建议已失效。');
      options.changed(threadId);
      return candidate;
    },
    onEvent(event: UiEvent) {
      if (event.type === 'item-started' || event.type === 'item-completed') {
        const turn = turns.get(event.threadId);
        if (
          turn &&
          turn.turnId === event.turnId &&
          event.item.type === 'mcpToolCall' &&
          event.item.server === 'next_actions' &&
          event.item.tool === 'propose_next_actions'
        )
          turn.attempted = true;
        return;
      }
      if (event.type === 'task-removed') {
        turns.delete(event.threadId);
        repo.remove(event.threadId);
      } else if (event.type === 'turn-started') {
        turns.set(event.threadId, { turnId: event.turnId, attempted: false, reminded: false });
        repo.expire(event.threadId);
      } else if (event.type === 'turn-completed') {
        if (turns.get(event.threadId)?.turnId === event.turnId) turns.delete(event.threadId);
        if (event.status === 'completed')
          repo.transition(event.threadId, event.turnId, 'proposed', 'available');
        else if (repo.get(event.threadId)?.turnId === event.turnId) repo.expire(event.threadId);
      } else if (
        event.type !== 'task-status' &&
        event.type !== 'task-goal-changed' &&
        event.type !== 'queue-changed'
      )
        return;
      options.changed(event.threadId);
    },
    interrupted() {
      turns.clear();
      repo.expire();
    },
  };
}
export type NextActions = ReturnType<typeof createNextActions>;
