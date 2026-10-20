import type { Store } from './store.js';

export interface NextAction {
  readonly id: string;
  readonly threadId: string;
  readonly sourceTurnId: string;
  readonly title: string;
  readonly prompt: string;
  readonly reason?: string;
}
export type NextActionState = 'proposed' | 'available' | 'accepted' | 'dismissed' | 'expired';
export interface NextActionRecord {
  readonly turnId: string;
  readonly state: NextActionState;
  readonly actions: readonly NextAction[];
}
/** Suggestions contain local text, never a dispatch instruction or a projection. */
export class NextActionStore {
  constructor(private readonly store: Store) {}
  get(threadId: string): NextActionRecord | undefined {
    const row = this.store.db
      .prepare('SELECT turn_id, state, payload FROM next_action WHERE thread_id = ?')
      .get(threadId) as { turn_id: string; state: NextActionState; payload: string } | undefined;
    return row
      ? { turnId: row.turn_id, state: row.state, actions: JSON.parse(row.payload) as NextAction[] }
      : undefined;
  }
  propose(threadId: string, turnId: string, actions: readonly NextAction[]): void {
    this.store.db
      .prepare(
        `INSERT INTO next_action(thread_id,turn_id,state,payload) VALUES(?,?,'proposed',?)
      ON CONFLICT(thread_id) DO UPDATE SET turn_id=excluded.turn_id,state=excluded.state,payload=excluded.payload`,
      )
      .run(threadId, turnId, JSON.stringify(actions));
  }
  transition(
    threadId: string,
    turnId: string,
    from: NextActionState,
    to: NextActionState,
  ): boolean {
    const result = this.store.db
      .prepare('UPDATE next_action SET state = ? WHERE thread_id = ? AND turn_id = ? AND state = ?')
      .run(to, threadId, turnId, from) as { changes: number | bigint };
    return result.changes > 0;
  }
  expire(threadId?: string): void {
    if (threadId !== undefined)
      this.store.db
        .prepare(
          "UPDATE next_action SET state = 'expired' WHERE thread_id = ? AND state IN ('proposed','available')",
        )
        .run(threadId);
    else this.store.db.exec("UPDATE next_action SET state = 'expired' WHERE state = 'proposed'");
  }
  remove(threadId: string): void {
    this.store.db.prepare('DELETE FROM next_action WHERE thread_id = ?').run(threadId);
  }
}
