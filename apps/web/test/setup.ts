import { cleanup } from '@testing-library/react';
import { afterEach, beforeEach, vi } from 'vitest';

beforeEach(() => {
  /*
   * jsdom 没有 `URL.createObjectURL`。分享页用它做预览与"保存成正确的文件名"，
   * 而那两条正是这一页的要点 —— 不打桩的话它们在测试里会静默不发生。
   */
  let objectUrls = 0;
  vi.stubGlobal(
    'URL',
    Object.assign(globalThis.URL, {
      createObjectURL: vi.fn(() => `blob:test/${(objectUrls += 1)}`),
      revokeObjectURL: vi.fn(),
    }),
  );
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(JSON.stringify({ members: [], models: [], devices: [], used: 0, limit: 0 }), {
          status: 200,
        }),
    ),
  );
});

afterEach(() => {
  cleanup();
  sessionStorage.clear();
  vi.unstubAllGlobals();
});
