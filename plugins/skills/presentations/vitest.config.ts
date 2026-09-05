import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'skill-presentations',
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // 这些测试会 spawn python3，比纯单测慢
    testTimeout: 20_000,
  },
});
