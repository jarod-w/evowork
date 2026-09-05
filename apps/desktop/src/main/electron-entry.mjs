/**
 * Electron 的真实入口 —— **整个 M9 打包链路里唯一 import electron 的文件**。
 *
 * `bootstrap.ts` 刻意不 import electron（见那个文件的头注释：窗口的安全参数必须能被测），
 * 所以这里的职责只有一件：把真的 `app` / `BrowserWindow` / `ipcMain` 塞进去。
 *
 * ## 为什么是 .mjs 而不是 .ts
 *
 * `electron` 这个依赖会下载上百 MB 的运行时，它属于 M9 打包。
 * 仓库里现在没装它，写成 .ts 会让 `pnpm typecheck` 因为找不到模块而红 ——
 * 而那个红没有任何信息量（我们知道它没装）。写成 .mjs 让类型检查跳过这一个文件，
 * 其余全部照常受约束。装上 electron 之后可以原样改名成 .ts。
 */
import { app, BrowserWindow, ipcMain } from 'electron';
import { join } from 'node:path';

import { bootstrap } from './bootstrap.js';

const isDev = process.env.EVOWORK_DEV === '1';

await bootstrap({
  electron: {
    app: {
      whenReady: () => app.whenReady(),
      on: (event, handler) => app.on(event, handler),
      quit: () => app.quit(),
      getVersion: () => app.getVersion(),
      getPath: (name) => app.getPath(name),
    },
    createWindow: (options) => new BrowserWindow(options),
    ipcMain: { handle: (channel, handler) => ipcMain.handle(channel, handler) },
  },
  // 打包时内核二进制随包（M9）；开发时用仓库里构建出来的那个
  appServerPath: isDev
    ? join(process.cwd(), '../codex/codex-rs/target/debug/codex-app-server')
    : join(process.resourcesPath, 'kernel', 'codex-app-server'),
  preloadPath: join(import.meta.dirname, '../preload/index.js'),
  rendererHtmlPath: join(import.meta.dirname, '../renderer/index.html'),
  devServerUrl: isDev ? 'http://localhost:5173' : undefined,
});
