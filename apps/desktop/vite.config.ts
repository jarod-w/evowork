import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  root: 'src/renderer',
  /*
   * **必须是相对路径。**
   *
   * 打包后的窗口用 `loadFile` 打开 `file://.../dist/renderer/index.html`，
   * 而 vite 默认的 `base: '/'` 会生成 `<script src="/assets/xxx.js">` ——
   * 在 file:// 下那是**文件系统根目录**，脚本 404。
   * 表现是窗口正常打开、标题栏正常、**整页全白**，且主进程一切正常：
   * 2026-09-06 装完 dmg 第一次打开就是这样。
   */
  base: './',
  plugins: [react()],
  build: {
    outDir: '../../dist/renderer',
    emptyOutDir: true,
  },
});
