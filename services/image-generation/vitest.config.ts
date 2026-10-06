import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: { name: 'image-generation', include: ['test/**/*.test.ts'], environment: 'node' },
});
