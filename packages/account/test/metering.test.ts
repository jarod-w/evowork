import { describe, expect, it } from 'vitest';

import { METERING_KEYS, parseMeteringDay } from '../src/metering.js';

describe('计量类型没有 threadId（11 §12 第 3 条）', () => {
  it('允许的键里没有 threadId / 任何自由字符串', () => {
    expect([...METERING_KEYS]).not.toContain('threadId');
    expect([...METERING_KEYS]).not.toContain('prompt');
    expect([...METERING_KEYS]).not.toContain('title');
    expect([...METERING_KEYS]).not.toContain('path');
  });

  it('带 threadId 的载荷解析后没有这个字段 —— 类型层面丢掉，不是运行时过滤漏了一次', () => {
    const parsed = parseMeteringDay({
      day: '2026-09-08',
      tenant: 'ten_1',
      model: 'evowork/deepseek-v4-flash',
      provider: 'deepseek',
      tokensIn: 10,
      tokensOut: 20,
      tokensCached: 0,
      durationMs: 300,
      threadId: 'thr_secret',
      title: '周报',
    });
    expect(parsed).toEqual({
      day: '2026-09-08',
      tenant: 'ten_1',
      model: 'evowork/deepseek-v4-flash',
      provider: 'deepseek',
      tokensIn: 10,
      tokensOut: 20,
      tokensCached: 0,
      durationMs: 300,
    });
    expect(parsed).not.toHaveProperty('threadId');
    expect(parsed).not.toHaveProperty('title');
  });
});
