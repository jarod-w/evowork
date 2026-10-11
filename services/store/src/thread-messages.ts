import type { SqliteLike } from './migrate.js';

export type ThreadMessageStatus =
  | 'queued'
  | 'dispatching'
  | 'waiting'
  | 'reply-queued'
  | 'reply-dispatching'
  | 'completed'
  | 'failed'
  | 'unknown'
  | 'reply-unknown'
  | 'cancelled';
export interface ThreadMessage {
  id: string;
  source_thread_id: string;
  target_thread_id: string;
  dedupe_key: string;
  text: string;
  status: ThreadMessageStatus;
  request_turn_id: string | null;
  reply_turn_id: string | null;
  reply_text: string | null;
  error: string | null;
  created_at: number;
  updated_at: number;
}
export class ThreadMessages {
  constructor(private readonly db: SqliteLike) {}
  get(id: string): ThreadMessage | undefined {
    return this.db.prepare('SELECT * FROM thread_message WHERE id = ?').get(id) as
      ThreadMessage | undefined;
  }
  byKey(key: string): ThreadMessage | undefined {
    return this.db.prepare('SELECT * FROM thread_message WHERE dedupe_key = ?').get(key) as
      ThreadMessage | undefined;
  }
  list(threadId?: string): ThreadMessage[] {
    return (
      threadId
        ? this.db
            .prepare(
              "SELECT * FROM thread_message WHERE source_thread_id = ? OR target_thread_id = ? ORDER BY CASE WHEN status IN ('completed','failed','cancelled') THEN 1 ELSE 0 END, created_at DESC LIMIT 100",
            )
            .all(threadId, threadId)
        : this.db
            .prepare(
              "SELECT * FROM thread_message WHERE status NOT IN ('completed','failed','cancelled') ORDER BY created_at",
            )
            .all()
    ) as ThreadMessage[];
  }
  insert(message: ThreadMessage): void {
    this.db
      .prepare(
        'INSERT INTO thread_message(id,source_thread_id,target_thread_id,dedupe_key,text,status,request_turn_id,reply_turn_id,reply_text,error,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
      )
      .run(
        message.id,
        message.source_thread_id,
        message.target_thread_id,
        message.dedupe_key,
        message.text,
        message.status,
        message.request_turn_id,
        message.reply_turn_id,
        message.reply_text,
        message.error,
        message.created_at,
        message.updated_at,
      );
  }
  update(
    id: string,
    patch: Partial<
      Pick<ThreadMessage, 'status' | 'request_turn_id' | 'reply_turn_id' | 'reply_text' | 'error'>
    >,
    now: number,
  ): void {
    const current = this.get(id);
    if (!current) return;
    const next = { ...current, ...patch };
    this.db
      .prepare(
        'UPDATE thread_message SET status=?,request_turn_id=?,reply_turn_id=?,reply_text=?,error=?,updated_at=? WHERE id=?',
      )
      .run(
        next.status,
        next.request_turn_id,
        next.reply_turn_id,
        next.reply_text,
        next.error,
        now,
        id,
      );
  }
  removeThread(threadId: string): void {
    this.db
      .prepare('DELETE FROM thread_message WHERE source_thread_id = ? OR target_thread_id = ?')
      .run(threadId, threadId);
  }
}
