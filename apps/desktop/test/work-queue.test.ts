import { afterEach, describe, expect, it, vi } from 'vitest';

import { createWorkQueue } from '../src/renderer/work-queue.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('环境锁放开后补做排队的附件', () => {
  it('锁占着时先排上，放开后按顺序做', () => {
    vi.useFakeTimers();
    const queue = createWorkQueue<string>();
    const started: string[] = [];
    queue.push('第一张');
    queue.push('第二张');
    queue.release(
      () => false,
      (item) => started.push(item),
    );
    expect(started).toEqual([]);
    vi.runAllTimers();
    expect(started).toEqual(['第一张']);
    queue.release(
      () => false,
      (item) => started.push(item),
    );
    vi.runAllTimers();
    expect(started).toEqual(['第一张', '第二张']);
  });

  it('放开的同一轮里锁又被占上时，附件回到队首，不丢掉', () => {
    vi.useFakeTimers();
    const queue = createWorkQueue<string>();
    const started: string[] = [];
    queue.push('截图');
    queue.release(
      () => true,
      (item) => started.push(item),
    );
    vi.runAllTimers();
    expect(started).toEqual([]);
    queue.release(
      () => false,
      (item) => started.push(item),
    );
    vi.runAllTimers();
    expect(started).toEqual(['截图']);
  });
});
