import type { UserInput } from '@evowork/protocol';
import type { Store } from './store.js';

export interface FollowUpResult {
  queued: boolean;
  steered?: boolean;
  unconfirmed?: boolean;
  degradations: readonly string[];
}
export interface FollowUpReceipt {
  fingerprint: string;
  route?: 'queue' | 'steer' | 'start';
  result?: FollowUpResult;
}
export interface StoredFollowUp {
  readonly id: string;
  readonly input: readonly UserInput[];
  readonly nativeId?: string;
  readonly clientId?: string;
  readonly dispatchId?: string;
}

/** 权威待发状态；正文仅存未执行队列，回执不复制正文。 */
export class FollowUpStore {
  constructor(
    private readonly store: Store,
    restoreQueues = true,
  ) {
    // 冷启动恢复的本机队列默认暂停，不能由启动期间的完成通知消费。
    if (restoreQueues)
      store.db.exec(`INSERT INTO follow_up_control(thread_id, paused)
      SELECT DISTINCT thread_id, 1 FROM follow_up_queue WHERE true
      ON CONFLICT(thread_id) DO UPDATE SET paused = 1`);
  }
  savePending(id: string, draftId: string, threadId: string | undefined, payload: unknown): void {
    this.store.transaction(() => {
      this.store.db
        .prepare('DELETE FROM follow_up_composer WHERE draft_id = ? AND id != ?')
        .run(draftId, id);
      this.store.db
        .prepare(
          `INSERT INTO follow_up_composer(id,draft_id,thread_id,payload) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET payload = excluded.payload`,
        )
        .run(id, draftId, threadId ?? null, JSON.stringify(payload));
    });
  }
  pending<T>(): T | undefined {
    const row = this.store.db
      .prepare('SELECT payload FROM follow_up_composer ORDER BY rowid DESC LIMIT 1')
      .get() as { payload: string } | undefined;
    return row ? (JSON.parse(row.payload) as T) : undefined;
  }
  acknowledge(id: string): void {
    this.store.db.prepare('DELETE FROM follow_up_composer WHERE id = ?').run(id);
  }
  bindPending(id: string, threadId: string): void {
    this.store.db
      .prepare('UPDATE follow_up_composer SET thread_id = ? WHERE id = ?')
      .run(threadId, id);
  }
  receipt(id: string): FollowUpReceipt | undefined {
    const row = this.store.db
      .prepare('SELECT receipt FROM follow_up_receipt WHERE id = ?')
      .get(id) as { receipt: string } | undefined;
    return row ? (JSON.parse(row.receipt) as FollowUpReceipt) : undefined;
  }
  saveReceipt(id: string, threadId: string, value: FollowUpReceipt): void {
    this.store.db
      .prepare(
        `INSERT INTO follow_up_receipt(id, thread_id, receipt) VALUES(?,?,?)
      ON CONFLICT(id) DO UPDATE SET receipt = excluded.receipt`,
      )
      .run(id, threadId, JSON.stringify(value));
  }
  removeReceipt(id: string): void {
    this.store.db.prepare('DELETE FROM follow_up_receipt WHERE id = ?').run(id);
  }
  get(threadId: string): StoredFollowUp[] | undefined {
    const rows = this.store.db
      .prepare('SELECT entry FROM follow_up_queue WHERE thread_id = ? ORDER BY position')
      .all(threadId) as { entry: string }[];
    return rows.length ? rows.map((row) => JSON.parse(row.entry) as StoredFollowUp) : undefined;
  }
  set(threadId: string, entries: readonly StoredFollowUp[]): void {
    this.store.transaction(() => {
      this.store.db.prepare('DELETE FROM follow_up_queue WHERE thread_id = ?').run(threadId);
      for (const [position, entry] of entries.entries())
        this.store.db
          .prepare('INSERT INTO follow_up_queue(id, thread_id, position, entry) VALUES(?,?,?,?)')
          .run(entry.id, threadId, position, JSON.stringify(entry));
    });
  }
  delete(threadId: string): void {
    this.store.transaction(() => {
      for (const table of [
        'follow_up_queue',
        'follow_up_receipt',
        'follow_up_control',
        'follow_up_composer',
      ])
        this.store.db.prepare(`DELETE FROM ${table} WHERE thread_id = ?`).run(threadId);
    });
  }
  has(threadId: string): boolean {
    return (
      (
        this.store.db
          .prepare('SELECT paused FROM follow_up_control WHERE thread_id = ?')
          .get(threadId) as { paused: number } | undefined
      )?.paused === 1
    );
  }
  pause(threadId: string): void {
    this.store.db
      .prepare(
        'INSERT INTO follow_up_control(thread_id, paused) VALUES(?,1) ON CONFLICT(thread_id) DO UPDATE SET paused = 1',
      )
      .run(threadId);
  }
  resume(threadId: string): void {
    this.store.db
      .prepare('UPDATE follow_up_control SET paused = 0 WHERE thread_id = ?')
      .run(threadId);
  }
  paused(): string[] {
    return (
      this.store.db.prepare('SELECT thread_id FROM follow_up_control WHERE paused = 1').all() as {
        thread_id: string;
      }[]
    ).map((row) => row.thread_id);
  }
}
