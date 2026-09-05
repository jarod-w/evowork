import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'logging',
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
});
