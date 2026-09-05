import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'store',
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
});
