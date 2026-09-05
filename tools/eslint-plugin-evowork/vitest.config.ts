import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'eslint-plugin',
    include: ['test/**/*.test.js'],
    environment: 'node',
  },
});
