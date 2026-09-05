import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'skill-documents',
    include: ['test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 20_000,
  },
});
