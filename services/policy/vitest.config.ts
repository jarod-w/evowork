import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'policy',
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
});
