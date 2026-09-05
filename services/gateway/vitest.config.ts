import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'gateway',
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
});
