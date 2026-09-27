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
import { app, BrowserWindow, dialog, ipcMain, safeStorage, shell } from 'electron';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/*
 * 引的是 **esbuild 打出的单文件**，不是 tsc 产出的 `bootstrap.js`。
 * 后者会顺着 workspace 包的 `exports`（都指向 `./src/index.ts`）去加载 TS 然后炸掉 ——
 * 报错是 `ERR_MODULE_NOT_FOUND: .../src/fields.js`，跟真正的原因看不出关系
 * （build-and-deploy §3.1 记过一次）。
 */
import { bootstrap } from './bootstrap.bundle.js';
/*
 * 早到事件的缓冲。**单独一个模块是为了能被测** —— 它跟 `import 'electron'` 绑在
 * 一起就一行测试都盖不到，而「早到了会不会丢」恰好是这条链路最容易坏的地方。
 * 这个文件没有任何 import，tsc 产出是自包含的，所以从这里引它是安全的
 * （不像 `bootstrap.js`，见上面那段）。
 */
import { createEarlyBuffer } from './early-events.js';

/*
 * **单实例锁必须在这里，而且必须在 `bootstrap()` 之前。**
 *
 * 不要锁的话，点一条 `evowork://` 会再开一个应用，两个进程抢同一个 sqlite ——
 * 那比深链不工作糟得多。bootstrap 的端口注释一直是这么写的，但那个方法
 * **从来没有被任何人调用过**，注释描述的是一个没实现的行为（2026-09-27 补上）。
 *
 * **退出方式踩过一次坑，写清楚。** 第一版用的是 `app.exit(0)`，理由是 `quit()` 是
 * 异步的优雅退出、**不会打断模块求值**，第二个进程会照样往下跑到 `bootstrap()` 去开库。
 * 那个理由本身是对的，但 `exit()` 太快了：`requestSingleInstanceLock()` 把这个实例的
 * argv 交给第一个实例是**跨进程的异步投递**，`exit()` 在它送达之前就把进程杀了 ——
 * 表现是第二个实例干净地退了、第一个实例什么都没收到（2026-09-27 在真 `.app` 上实测到，
 * `verify-packaged-app.mjs` 第 ⑦ 段报的就是这一句）。
 *
 * 所以改成 `quit()`（让事件循环把那条消息送出去）**加一个显式守卫**：
 * 下面的 `bootstrap()` 只在拿到锁时才调用。不能只靠 `quit()` —— 它不打断模块求值，
 * 而"第二个进程别去开库"正是这把锁的全部意义。
 */
const isPrimaryInstance = app.requestSingleInstanceLock();
if (!isPrimaryInstance) {
  app.quit();
}

/*
 * **macOS 的 `open-url` 会在 `whenReady` 之前来。**
 *
 * 用户在应用没开着的时候点一条分享链接：LaunchServices 拉起应用 →
 * Electron 很早就发 `open-url` → 而 `bootstrap()` 的第一件事是 `await app.whenReady()`，
 * 接线在那之后很远。**那条链接会丢**，表现正是这个特性要防的「点了什么都没发生」。
 *
 * 所以监听挂在模块顶层，早到的先存着，等 bootstrap 接上来再一次性交出去。
 * 这与冷启动时「渲染层还没订阅」是同一类故障，只是发生在主进程这一层。
 *
 * `event.preventDefault()` 不能省：macOS 上不调它，系统认为这条 URL 没人处理。
 */
const openUrls = createEarlyBuffer();
app.on('open-url', (event, url) => {
  event.preventDefault();
  openUrls.push(url);
});

/* 第二个实例的 argv 同理 —— 它同样可能在 bootstrap 接线之前就到。 */
const secondInstanceArgv = createEarlyBuffer();
app.on('second-instance', (_event, argv) => {
  secondInstanceArgv.push(argv);
});

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
const officeFontPath = isPackaged
  ? join(resourceRoot, 'office', 'NotoSansSC.ttf')
  : join(repoRoot, 'build/office/NotoSansSC.ttf');
/*
 * 打包后这份必须在：漏了就让安装器报「安装包里没有中文字体」，不要改去 GitHub
 * （客户机器上 GitHub raw 同样打不开）。未打包时文件在仓库里才传路径，
 * 否则安装器回落到下载，方便还没拉这份二进制的开发机。
 */
const bundledFontPath = isPackaged || existsSync(officeFontPath) ? officeFontPath : undefined;

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
/*
 * **只有拿到锁的那个进程才往下走。** 见上面那段：第二个实例已经把 argv 交出去了，
 * 它唯一还该做的事就是消失 —— 走到这里就意味着它会去开同一个 sqlite。
 */
if (isPrimaryInstance) {
  bootstrap({
    electron: {
      app: {
        whenReady: () => app.whenReady(),
        on: (event, handler) => app.on(event, handler),
        quit: () => app.quit(),
        getVersion: () => app.getVersion(),
        getPath: (name) => app.getPath(name),
        /*
         * 深链（02 §8）。这三项此前**一项都没有提供过**，而 bootstrap 用 `?.` 调它们 ——
         * 漏填不报错、不打日志，只是 `evowork://` 静默地不工作。
         * `test/electron-entry-port.test.ts` 现在守着「端口上有的，真入口必须填」。
         *
         * macOS 上 `setAsDefaultProtocolClient` **只能注册已经写进 Info.plist 的 scheme**，
         * 所以它得配 `build/electron-builder.yml` 里的 `protocols:` 一起看，少一边都不工作。
         */
        setAsDefaultProtocolClient: (scheme) => app.setAsDefaultProtocolClient(scheme),
        onOpenUrl: (handler) => openUrls.connect(handler),
        onSecondInstance: (handler) => {
          secondInstanceArgv.connect(handler);
        },
      },
      createWindow: (options) => new BrowserWindow(options),
      ipcMain: { handle: (channel, handler) => ipcMain.handle(channel, handler) },
      // 首运行第②步 / Composer「添加本地文件」。挂到当前窗口上，否则 macOS
      // 上无主对话框会落到应用后面，表现同样是「点了没反应」。
      showOpenDialog: (options) => {
        const parent = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
        return parent ? dialog.showOpenDialog(parent, options) : dialog.showOpenDialog(options);
      },
      // 「项目」页的「打开文件夹」（清单 §4.5）。同样只有主进程能调 shell
      openPath: (path) => shell.openPath(path),
      openExternal: (url) => shell.openExternal(url),
      /*
       * 密钥加密（Q34=A / M10a）。**只有主进程有 safeStorage**。
       *
       * 不传的话密钥库永远不可用，用户在设置页只能选"明文保存"或"每次手填" ——
       * 而那正是 Q34 想终结的状态。Linux 上 `getSelectedStorageBackend()` 返回
       * `basic_text` 时我们**当成不可用**（固定密钥等价于明文），所以这里原样透出它。
       */
      safeStorage: {
        isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
        encryptString: (plain) => safeStorage.encryptString(plain),
        decryptString: (buf) => safeStorage.decryptString(buf),
        getSelectedStorageBackend: () =>
          typeof safeStorage.getSelectedStorageBackend === 'function'
            ? safeStorage.getSelectedStorageBackend()
            : undefined,
      },
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
     * 只在 `~/.evowork/app.toml` 的 `mode = "local"` 时才会被执行 ——
     * 判据是那个 mode，不是 base_url（D11 / M10a，见 gateway-process.ts 的头注释）。
     */
    gatewayEntryPath: isPackaged
      ? join(resourceRoot, 'gateway', 'main.js')
      : join(repoRoot, 'dist/gateway/main.js'),
    configDir: isPackaged ? join(resourceRoot, 'config') : join(repoRoot, 'config'),
    pluginsDir: join(resourceRoot, 'plugins'),
    ...(bundledFontPath !== undefined ? { bundledFontPath } : {}),
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
}
