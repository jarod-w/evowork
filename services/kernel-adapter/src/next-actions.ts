import { NextActionStore, type NextAction, type Store } from '@evowork/store';
import type { Adapter } from './adapter.js';
import type { UiEvent } from './events.js';

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
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('建议参数无效。');
      const input = raw as Record<string, unknown>;
      if (
        Object.keys(input).some((key) => !['outcome', 'actions'].includes(key)) ||
        !['delivered', 'needs_input'].includes(String(input.outcome)) ||
        !Array.isArray(input.actions) ||
        input.actions.length > 3
      )
        throw new Error('建议参数无效。');
      const actions: NextAction[] = input.actions.map((item: unknown, index: number) => {
        if (!item || typeof item !== 'object' || Array.isArray(item))
          throw new Error('建议参数无效。');
        const action = item as Record<string, unknown>;
        if (
          Object.keys(action).some((key) => !['title', 'prompt', 'reason'].includes(key)) ||
          typeof action.title !== 'string' ||
          !action.title.trim() ||
          action.title.length > 80 ||
          typeof action.prompt !== 'string' ||
          !action.prompt.trim() ||
          action.prompt.length > 2000 ||
          (action.reason !== undefined &&
            (typeof action.reason !== 'string' || action.reason.length > 300))
        )
          throw new Error('建议参数无效。');
        return {
          id: bound.callId + ':' + index,
          threadId,
          sourceTurnId: bound.turnId,
          title: action.title.trim(),
          prompt: action.prompt.trim(),
          ...(typeof action.reason === 'string' ? { reason: action.reason.trim() } : {}),
        };
      });
      if (input.outcome === 'needs_input' && actions.length)
        throw new Error('等待用户输入时不应提交下一步建议。');
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
