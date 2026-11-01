import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NOTIFICATION } from '@evowork/protocol';
import { openStore, type Store } from '@evowork/store';
import { readAutoApprovalReviews, saveAutoApprovalReview } from '../src/auto-review.js';
import { createEventRouter, type UiEvent } from '../src/events.js';
import { makeThread, makeTurn } from './fake-app-server.js';

let store: Store;
let events: UiEvent[];
let router: ReturnType<typeof createEventRouter>;
const started = (over: Record<string, unknown> = {}) => ({
  threadId: 't1',
  turnId: 'turn1',
  reviewId: 'r1',
  targetItemId: 'command1',
  startedAtMs: 100,
  review: { status: 'inProgress' },
  ...over,
});
beforeEach(() => {
  store = openStore({ path: ':memory:' });
  events = [];
  router = createEventRouter({ store, now: () => 200, onUiEvent: (event) => events.push(event) });
  router.handle(NOTIFICATION.threadStarted, { thread: makeThread({ id: 't1' }) });
});
afterEach(() => store.close());

describe('自动审批独立证据', () => {
  it('关闭并重新打开实际 SQLite 后仍保留审查终态', () => {
    const directory = mkdtempSync(join(tmpdir(), 'ew-review-history-'));
    let disk: Store | undefined;
    try {
      const path = join(directory, 'history.db');
      disk = openStore({ path });
      disk.threads.upsertFromThread(makeThread({ id: 'durable' }));
      saveAutoApprovalReview(disk, 'durable', {
        reviewId: 'review1',
        turnId: 'turn1',
        status: 'denied',
        startedAtMs: 1,
        completedAtMs: 2,
        rationale: '未执行',
      });
      disk.close();
      disk = openStore({ path });
      expect(readAutoApprovalReviews(disk, 'durable')).toEqual([
        expect.objectContaining({ status: 'denied', rationale: '未执行' }),
      ]);
    } finally {
      disk?.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it('按 reviewId 合并并持久化，action 与工具参数不复制到本机 meta', () => {
    router.handle(
      NOTIFICATION.itemAutoApprovalReviewStarted,
      started({ action: { secret: 'ACTION_SECRET' } }),
    );
    router.handle(
      NOTIFICATION.itemAutoApprovalReviewCompleted,
      started({
        completedAtMs: 150,
        review: { status: 'approved', riskLevel: 'low', rationale: '明确授权' },
      }),
    );
    expect(readAutoApprovalReviews(store, 't1')).toEqual([
      expect.objectContaining({ reviewId: 'r1', status: 'approved', rationale: '明确授权' }),
    ]);
    expect(
      JSON.stringify(
        store.db.prepare('SELECT value FROM meta WHERE key = ?').get('evowork.auto-review.t1'),
      ),
    ).not.toContain('ACTION_SECRET');
    expect(events.filter((event) => event.type === 'approval-review')).toHaveLength(2);
  });

  it('不同 review 并发互不覆盖，终态不被迟到的 started 或不同回合覆盖', () => {
    router.handle(
      NOTIFICATION.itemAutoApprovalReviewCompleted,
      started({ review: { status: 'denied' } }),
    );
    router.handle(NOTIFICATION.itemAutoApprovalReviewStarted, started());
    router.handle(NOTIFICATION.itemAutoApprovalReviewStarted, started({ reviewId: 'r2' }));
    router.handle(
      NOTIFICATION.itemAutoApprovalReviewCompleted,
      started({ turnId: 'other', review: { status: 'approved' } }),
    );
    expect(readAutoApprovalReviews(store, 't1').map((review) => review.status)).toEqual([
      'denied',
      'inProgress',
    ]);
  });

  it('任务删除清理证据，迟到通知不能重建', () => {
    router.handle(NOTIFICATION.itemAutoApprovalReviewStarted, started());
    router.handle(NOTIFICATION.threadDeleted, { threadId: 't1' });
    router.handle(
      NOTIFICATION.itemAutoApprovalReviewCompleted,
      started({ review: { status: 'approved' } }),
    );
    expect(readAutoApprovalReviews(store, 't1')).toEqual([]);
  });

  it('没有完成审查就结束任务时标记取消，不继续显示审查中或编造通过', () => {
    router.handle(NOTIFICATION.itemAutoApprovalReviewStarted, started());
    router.handle(NOTIFICATION.turnCompleted, {
      threadId: 't1',
      turn: makeTurn({ id: 'turn1', status: 'interrupted' }),
    });
    expect(readAutoApprovalReviews(store, 't1')[0]).toMatchObject({
      status: 'aborted',
      completedAtMs: 200,
    });
  });

  it('陌生状态和畸形事件不被当作通过', () => {
    router.handle(
      NOTIFICATION.itemAutoApprovalReviewCompleted,
      started({ review: { status: 'newFutureStatus' } }),
    );
    router.handle(NOTIFICATION.itemAutoApprovalReviewStarted, null);
    router.handle(NOTIFICATION.itemAutoApprovalReviewStarted, started({ reviewId: 123 }));
    expect(readAutoApprovalReviews(store, 't1')).toHaveLength(1);
    expect(readAutoApprovalReviews(store, 't1')[0]?.status).toBe('unknown');
  });
});
