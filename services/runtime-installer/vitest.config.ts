import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'runtime-installer',
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
});
