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
      if (event.type === 'task-removed') repo.remove(event.threadId);
      else if (event.type === 'turn-started') repo.expire(event.threadId);
      else if (event.type === 'turn-completed') {
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
      repo.expire();
    },
  };
}
export type NextActions = ReturnType<typeof createNextActions>;
