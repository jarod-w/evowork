import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  test: {
    name: 'desktop',
    include: ['test/**/*.test.{ts,tsx}'],
    environment: 'jsdom',
    globals: false,
    // 显式接上 DOM 清理（globals: false 下 testing-library 不会自动注册）
    setupFiles: ['./test/setup.ts'],
  },
});
