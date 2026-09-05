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

/*
 * 引的是 **esbuild 打出的单文件**，不是 tsc 产出的 `bootstrap.js`。
 * 后者会顺着 workspace 包的 `exports`（都指向 `./src/index.ts`）去加载 TS 然后炸掉 ——
 * 报错是 `ERR_MODULE_NOT_FOUND: .../src/fields.js`，跟真正的原因看不出关系
 * （build-and-deploy §3.1 记过一次）。
 */
import { bootstrap } from './bootstrap.bundle.js';

const isDev = process.env.EVOWORK_DEV === '1';

/*
 * **不要在这里用顶层 await。**
 *
 * ESM 入口的模块求值必须先结束，Electron 才会发 `ready`；而 `bootstrap()` 内部第一件事
 * 就是 `await app.whenReady()` —— 顶层 await 它就是互相等：进程活着、没有窗口、
 * 没有任何输出，看起来像"点了没反应"。2026-09-06 实测到这个死锁，探针停在
 * `whenReady()` 那一行再也没往下走。
 *
 * 所以这里把 promise 放走，让模块求值立刻结束。
 */
bootstrap({
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
  preloadPath: join(import.meta.dirname, '../preload/index.bundle.cjs'),
  rendererHtmlPath: join(import.meta.dirname, '../renderer/index.html'),
  devServerUrl: isDev ? 'http://localhost:5173' : undefined,
}).catch((error) => {
  /*
   * 启动失败必须**响亮**。
   *
   * 不 catch 的话，一个 rejected promise 在 Electron 主进程里既不打印也不退出 ——
   * 表现同样是"点了没反应"，而那正是这次排查花掉最多时间的地方（差别只在
   * 一个是死锁、一个是异常）。所以这里既往 stderr 打，也把进程带走：
   * 一个起不来的壳子留在那儿只会让下一次排查更难。
   */
  console.error('[evowork] 启动失败：', error);
  app.exit(1);
});
