import { readMeta, writeMeta, type Store } from '@evowork/store';

export interface AutoApprovalReview {
  readonly reviewId: string;
  readonly turnId: string;
  readonly targetItemId?: string;
  readonly status: 'inProgress' | 'approved' | 'denied' | 'timedOut' | 'aborted' | 'unknown';
  readonly riskLevel?: string;
  readonly rationale?: string;
  readonly startedAtMs: number;
  readonly completedAtMs?: number;
}

const keyFor = (threadId: string) => `evowork.auto-review.${threadId}`;
const statuses = new Set(['inProgress', 'approved', 'denied', 'timedOut', 'aborted']);

/** Store only local review evidence, never the action, tool arguments or transcript. */
export function parseAutoApprovalReview(value: unknown): AutoApprovalReview | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const p = value as Record<string, unknown>;
  if (typeof p.reviewId !== 'string' || !p.reviewId || typeof p.turnId !== 'string' || !p.turnId)
    return undefined;
  if (typeof p.startedAtMs !== 'number' || !Number.isFinite(p.startedAtMs)) return undefined;
  const review = p.review as Record<string, unknown> | undefined;
  if (!review || typeof review !== 'object') return undefined;
  return {
    reviewId: p.reviewId,
    turnId: p.turnId,
    startedAtMs: p.startedAtMs,
    status: statuses.has(String(review.status))
      ? (review.status as AutoApprovalReview['status'])
      : 'unknown',
    ...(typeof p.targetItemId === 'string' ? { targetItemId: p.targetItemId } : {}),
    ...(typeof p.completedAtMs === 'number' && Number.isFinite(p.completedAtMs)
      ? { completedAtMs: p.completedAtMs }
      : {}),
    ...(['low', 'medium', 'high', 'critical'].includes(String(review.riskLevel))
      ? { riskLevel: String(review.riskLevel) }
      : {}),
    ...(typeof review.rationale === 'string' ? { rationale: review.rationale.slice(0, 4000) } : {}),
  };
}

export function readAutoApprovalReviews(store: Store, threadId: string): AutoApprovalReview[] {
  const raw = store.db ? readMeta(store.db, keyFor(threadId)) : undefined;
  if (!raw) return [];
  try {
    const entries: unknown = JSON.parse(raw);
    if (!Array.isArray(entries)) return [];
    return entries.flatMap((entry: unknown) => {
      if (!entry || typeof entry !== 'object') return [];
      const parsed = parseAutoApprovalReview({ ...entry, review: entry });
      return parsed ? [parsed] : [];
    });
  } catch {
    return [];
  }
}

export function saveAutoApprovalReview(
  store: Store,
  threadId: string,
  review: AutoApprovalReview,
): boolean {
  // A completed deletion wins over delayed kernel events.
  if (!store.threads.get(threadId)) return false;
  const entries = readAutoApprovalReviews(store, threadId);
  const index = entries.findIndex((entry) => entry.reviewId === review.reviewId);
  const previous = entries[index];
  if (previous && (previous.turnId !== review.turnId || previous.status !== 'inProgress'))
    return false;
  if (index < 0) entries.push(review);
  else entries[index] = review;
  writeMeta(store.db, keyFor(threadId), JSON.stringify(entries.slice(-512)));
  return true;
}

export function deleteAutoApprovalReviews(store: Store, threadId: string): void {
  store.db.prepare('DELETE FROM meta WHERE key = ?').run(keyFor(threadId));
}

export function interruptAutoApprovalReviews(
  store: Store,
  threadId: string,
  at: number,
  turnId?: string,
): AutoApprovalReview[] {
  const pending = readAutoApprovalReviews(store, threadId).filter(
    (review) =>
      review.status === 'inProgress' && (turnId === undefined || review.turnId === turnId),
  );
  return pending.map((review) => {
    const ended: AutoApprovalReview = {
      ...review,
      status: 'aborted',
      completedAtMs: at,
      rationale: '任务已结束或连接已中断，未收到审查通过结果。',
    };
    saveAutoApprovalReview(store, threadId, ended);
    return ended;
  });
}
