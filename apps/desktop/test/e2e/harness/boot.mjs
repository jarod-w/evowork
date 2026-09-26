/**
 * 把 App **启动起来**，一句断言都不做。
 *
 * 这是「启动」与「驱动」的分界线。在这之前，两份 E2E 各抄了一份约 40 行的 bootstrap 注入缝
 * （四个 Electron 接缝 + 四条路径 + 宿主环境），抄漏一处的表现不是报错，而是
 * 「窗口起来了但少一条链路」—— 而断言写在别的文件里，不会指向这儿。
 *
 * 驱动方式有两种，共用这个文件：断言型 E2E（`*.e2e.mjs`，经 preload 桥说话，窗口隐藏）
 * 与真交互 UI 测试（`ui/*.spec.mjs`，Playwright 从进程外点 DOM，窗口显示）。
 * 区别只是 `show` 这一个参数 —— 启动链路两边一模一样，这正是拆出这个文件的目的。
 */
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { app, BrowserWindow, ipcMain } from 'electron';

import { bootstrap, createServiceHost } from '../../../dist/main/bootstrap.bundle.js';
import { publishControls, waitFor } from './runner.mjs';

/**
 * 一次性的 EVOWORK_HOME：产物、本机 sqlite、内核配置全在里面。
 *
 * 用临时目录而不是固定路径，是为了让每次跑都从**真的空**开始 —— 首运行引导、迁移器、
 * 「还没有任何任务」这些分支只在空 home 上走得到，复用一个目录会让它们永远没人验。
 */
export function createE2EHome(prefix) {
  const home = mkdtempSync(join(tmpdir(), prefix));
  const workspace = join(home, 'workspace');
  const kernelHome = join(home, '.evowork', 'kernel');
  mkdirSync(workspace, { recursive: true });
  mkdirSync(kernelHome, { recursive: true });
  return { home, workspace, kernelHome };
}

/**
 * 内核配置原样落盘。
 *
 * **刻意不做模板拼装**：两份 E2E 的 config.toml 差的不只是几个值（记忆开关、重试上限、
 * 审批档位），而 TOML 里一个键属于哪张表取决于它写在哪个表头之后 —— 拼装器一旦把某行
 * 放进了错误的段落，配置会**静默生效在另一张表上**，既不报错也不生效。
 * 所以由调用方给完整正文，这里只负责写。
 */
export function writeKernelConfig(kernelHome, toml) {
  writeFileSync(join(kernelHome, 'config.toml'), toml);
}

/**
 * 启动桌面 App 的真窗口：真 Electron 进程、真 preload、真渲染层、真 app-server 子进程。
 *
 * 返回的 `evaluate` 在渲染层求值，`killKernel` 在主进程里动手；两者同时挂到
 * `globalThis.__evoworkE2E`（见 runner.mjs 的 `publishControls`）。
 */
export async function bootApp({
  repoRoot,
  appServerPath,
  home,
  hostEnv = {},
  preloadTimeoutMs = 15_000,
  captureKernelProcess = false,
  show = false,
}) {
  /*
   * 拿到内核子进程才杀得掉它（`skill-reference` 靠 SIGKILL 验「崩了会自己起来」）。
   *
   * **默认不包这一层**：给宿主传 `spawnFn` 有一个隐藏后果 —— 回收端口上残留网关时
   * 会被换成「不扫描」（service-host.ts:1124 的 `listListeners: () => []`）。
   * 假网关那条 E2E 本来就传，不受影响；真网关那条现在没传，这次拆分不动它。
   */
  let kernelChild;
  const spawnSeam = captureKernelProcess
    ? {
        spawnFn: (command, args, spawnOptions) => {
          const child = spawn(command, args, spawnOptions);
          if (command === appServerPath) kernelChild = child;
          return child;
        },
      }
    : {};

  const result = await bootstrap({
    electron: {
      app: {
        whenReady: () => app.whenReady(),
        on: (event, handler) => app.on(event, handler),
        quit: () => app.quit(),
        getVersion: () => app.getVersion(),
        getPath: () => home,
      },
      /*
       * 断言型 E2E 用隐藏窗口就够（它只经 preload 桥说话）；**真交互必须显示出来** ——
       * 焦点、hover、滚动进视野这些动作在隐藏窗口上语义不同，Playwright 的
       * actionability 检查会一直等不到「可点击」。
       */
      createWindow: (options) => new BrowserWindow({ ...options, show }),
      ipcMain: { handle: (channel, handler) => ipcMain.handle(channel, handler) },
      openExternal: async () => undefined,
    },
    appServerPath,
    configDir: join(repoRoot, 'config'),
    pluginsDir: join(repoRoot, 'plugins'),
    preloadPath: join(repoRoot, 'apps/desktop/dist/preload/index.bundle.cjs'),
    rendererHtmlPath: join(repoRoot, 'apps/desktop/dist/renderer/index.html'),
    createHost: (options) =>
      createServiceHost({
        ...options,
        env: { ...process.env, ...hostEnv },
        ...spawnSeam,
      }),
  });

  const window = result.window;
  const evaluate = (source) => window.webContents.executeJavaScript(source, true);
  /*
   * 等 preload 桥挂上，而不是等窗口 `did-finish-load`：这条 E2E 的每一个动作都经
   * `window.evowork.*`，桥没挂上时后面每一条断言都会以一句没用的 `undefined` 失败。
   */
  await waitFor(
    () => evaluate('Boolean(window.evowork)'),
    'preload bridge 没有加载',
    preloadTimeoutMs,
  );

  const booted = {
    host: result.host,
    window,
    evaluate,
    /** 当前内核子进程的 pid。重启后会换一个，所以每次都重新读，不要缓存 */
    kernelPid: () => kernelChild?.pid,
    killKernel: () => {
      if (!kernelChild)
        throw new Error('没有捕获内核子进程（bootApp 要传 captureKernelProcess）。');
      kernelChild.kill('SIGKILL');
    },
  };
  publishControls({ home, ...booted });
  return booted;
}
