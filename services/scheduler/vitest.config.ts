import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'scheduler',
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
});
