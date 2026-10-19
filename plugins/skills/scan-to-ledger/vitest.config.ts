import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'skill-scan-to-ledger',
    include: ['test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 20_000,
  },
});
