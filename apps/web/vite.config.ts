import { resolve } from 'node:path';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * 两个入口，**刻意不共享 chunk**。
 *
 * `index.html` 是账号页与管理端；`share.html` 是给链接接收方的 `/s/<id>`。
 * 后者不读账号会话、不带 `authorization`（11 §13.10 C 第 1 条），
 * 所以它要是独立的一份 —— 共享 chunk 会把账号那一侧的代码拖进这一页，
 * 而"这一页里没有令牌"就得靠读代码来确认，而不是靠结构。
 *
 * `manualChunks: () => undefined` 关掉**我们自己的**拆包策略。
 *
 * 说清楚它做到与没做到什么：rollup 仍然会把两个入口共同依赖的 **react** 提成一个
 * 共享 chunk（构建产物里那个 ~198kB 的），这没问题 —— 那里面是框架，没有账号代码。
 * 它**没有**保证"分享页里一定没有账号代码"：真正守着这条的是
 * `test/share-isolation.test.ts`，它直接扫 `src/share/**` 的 import 图，
 * 越界到 `../api.js` / `../components.js` / 任何 screens 就红。
 *
 * 关掉自定义拆包只是让越界在产物体积上也看得见，是第二道，不是第一道。
 */
export default defineConfig({
  plugins: [react()],
  server: { port: 5174, strictPort: true },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        index: resolve(import.meta.dirname, 'index.html'),
        share: resolve(import.meta.dirname, 'share.html'),
      },
      output: {
        manualChunks: () => undefined,
      },
    },
  },
});
