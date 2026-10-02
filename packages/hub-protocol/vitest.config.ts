import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'hub-protocol',
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
});
