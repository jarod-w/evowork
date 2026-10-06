import type { TurnView } from './ipc.js';

/** 历史是顺序真源；在途历史响应不能把实时终态退回进行中。 */
export function mergeTurnViews(
  live: readonly TurnView[],
  history: readonly TurnView[],
): readonly TurnView[] {
  const byId = new Map(live.map((turn) => [turn.id, turn]));
  const ids = new Set(history.map((turn) => turn.id));
  return [
    ...history.map((turn) => {
      const current = byId.get(turn.id);
      if (!current) return turn;
      const newer =
        current.status === 'inProgress' && turn.status !== 'inProgress' ? turn : current;
      const older = newer === current ? turn : current;
      return {
        ...older,
        ...Object.fromEntries(Object.entries(newer).filter(([, value]) => value !== undefined)),
      };
    }),
    ...live.filter((turn) => !ids.has(turn.id)),
  ];
}
