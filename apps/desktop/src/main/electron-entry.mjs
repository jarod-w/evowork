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
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { join } from 'node:path';

/*
 * 引的是 **esbuild 打出的单文件**，不是 tsc 产出的 `bootstrap.js`。
 * 后者会顺着 workspace 包的 `exports`（都指向 `./src/index.ts`）去加载 TS 然后炸掉 ——
 * 报错是 `ERR_MODULE_NOT_FOUND: .../src/fields.js`，跟真正的原因看不出关系
 * （build-and-deploy §3.1 记过一次）。
 */
import { bootstrap } from './bootstrap.bundle.js';

/*
 * **两个独立的问题，此前被压成了一个开关。**
 *
 * ① 随包资源（内核 / 网关 / config）在哪？—— 由**是不是装出来的应用**决定。
 * ② 渲染层从哪来（vite dev server 还是 loadFile）？—— 由**开发者起没起 vite** 决定。
 *
 * 原先两个都看 `EVOWORK_DEV`，于是"用仓库里构建好的产物直接跑一次"这种最常见的
 * 验证方式**没有任何表示法**：不设 `EVOWORK_DEV` 就去 `process.resourcesPath` 找内核，
 * 而那时它指向 **Electron 自己的 app 包**：
 *
 *   Error: spawn .../electron/dist/Electron.app/Contents/Resources/kernel/codex-app-server ENOENT
 *
 * 设了 `EVOWORK_DEV=1` 又会去连一个没起的 vite（白屏）。两条路都不通。
 * 现在 ① 看 `app.isPackaged`（Electron 自己知道这件事），② 才看 `EVOWORK_DEV`。
 */
const isPackaged = app.isPackaged;
const useDevServer = process.env.EVOWORK_DEV === '1';

/**
 * 仓库根。`import.meta.dirname` 是 `<repo>/apps/desktop/dist/main`，往上四层。
 *
 * 内核不在仓库里，在它**旁边**（CLAUDE.md 第 1 节：`../codex` 是只读的执行内核签出），
 * 所以另有一个 `kernelCheckout`。
 */
const repoRoot = join(import.meta.dirname, '../../../..');
const kernelCheckout = join(repoRoot, '..', 'codex');

/**
 * 随包资源的根。
 *
 * 未打包时用**相对入口文件**的路径而不是 `process.cwd()`：从哪个目录敲的命令
 * 不该改变内核在哪 —— 那会让"在仓库根跑没事、在 apps/desktop 里跑就 ENOENT"，
 * 而这两次跑的是同一个产物。
 */
const resourceRoot = isPackaged ? process.resourcesPath : repoRoot;

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
    // 首运行第②步的目录选择框。**只有主进程能开系统对话框**
    showOpenDialog: (options) => dialog.showOpenDialog(options),
    // 「项目」页的「打开文件夹」（清单 §4.5）。同样只有主进程能调 shell
    openPath: (path) => shell.openPath(path),
  },
  /*
   * 打包时内核二进制随包（M9）；开发时用仓库里构建出来的那个。
   *
   * `EVOWORK_APP_SERVER` 可以覆盖两者。加它是因为开发机上常常没有 debug 构建
   * （`cargo build -p codex-app-server` 要几分钟），而这时**唯一的症状是启动失败**——
   * 与"代码写错了"区分不开。企业离线部署换内核路径也走这个变量。
   */
  appServerPath:
    process.env.EVOWORK_APP_SERVER ??
    (isPackaged
      ? join(resourceRoot, 'kernel', 'codex-app-server')
      : join(kernelCheckout, 'codex-rs/target/debug/codex-app-server')),
  /*
   * 随包的 `config/`（electron-builder.yml 的 extraResources 把它放在 resources 下）。
   * 首次运行时 `[permissions.*]` 四个档位从这里装进内核家目录 ——
   * 少了它，**每一次新建任务都会被内核拒掉**，而 UI 上只表现为"回车没反应"。
   */
  /*
   * 网关单文件产物。开发时在仓库的 dist/，打包后随 extraResources 进 Resources/gateway/。
   * 只在 config.toml 的 base_url 指向本机时才会被执行（gateway-process.ts 的判据）。
   */
  gatewayEntryPath: isPackaged
    ? join(resourceRoot, 'gateway', 'main.js')
    : join(repoRoot, 'dist/gateway/main.js'),
  configDir: isPackaged ? join(resourceRoot, 'config') : join(repoRoot, 'config'),
  preloadPath: join(import.meta.dirname, '../preload/index.bundle.cjs'),
  rendererHtmlPath: join(import.meta.dirname, '../renderer/index.html'),
  // 只有"开发者真的起了 vite"才连它。与随包资源在哪**无关**（见文件头）
  devServerUrl: useDevServer ? 'http://localhost:5173' : undefined,
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
