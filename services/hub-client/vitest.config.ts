import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'hub-client',
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
});
