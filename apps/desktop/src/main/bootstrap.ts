/**
 * Electron 主进程的引导（Q23：桌面壳用 Electron）。
 *
 * ## 为什么 electron 是**注入**进来的
 *
 * 这个文件不 `import 'electron'`：它接收一个结构化的 `ElectronApi`。
 * 两个理由，第二个才是主要的：
 *
 *   ① `electron` 包会下载上百 MB 的运行时，而它真正被需要是在 M9（打包与分发）；
 *   ② **窗口的安全参数必须能被测试钉住**。`contextIsolation` 被谁不小心改成 false 这种事，
 *      不会在开发时表现出任何症状 —— 它只在有人往渲染进程注入内容那天表现出来（R5）。
 *      注入之后，"我们到底用什么参数开的窗口"就成了一条可断言的事实。
 *
 * M9 只需要加一个十行的 `electron-entry.ts`：`import { app, BrowserWindow } from 'electron'`
 * 然后把它们传进 `bootstrap()`。
 */
import { join } from 'node:path';

import { RENDERER_ACTIONS } from '../preload/index.js';
import { createServiceHost, resolvePaths, type ServiceHost } from './service-host.js';

/** 只声明我们真正用到的那部分 Electron API。 */
export interface ElectronWindow {
  readonly webContents: {
    send(channel: string, payload: unknown): void;
    setWindowOpenHandler(handler: (details: { url: string }) => { action: 'deny' | 'allow' }): void;
    on(
      event: 'will-navigate',
      handler: (event: { preventDefault(): void }, url: string) => void,
    ): void;
  };
  loadURL(url: string): Promise<void>;
  loadFile(path: string): Promise<void>;
  on(event: 'closed', handler: () => void): void;
}

export interface BrowserWindowOptions {
  readonly width: number;
  readonly height: number;
  readonly minWidth: number;
  readonly minHeight: number;
  /** macOS：交通灯浮在内容上（01 §3.2：页面控件在标题栏行内，没有独立 header） */
  readonly titleBarStyle?: 'hiddenInset' | undefined;
  readonly webPreferences: {
    readonly preload: string;
    readonly contextIsolation: boolean;
    readonly nodeIntegration: boolean;
    readonly sandbox: boolean;
    readonly webviewTag: boolean;
  };
}

export interface ElectronApi {
  readonly app: {
    whenReady(): Promise<void>;
    on(event: 'window-all-closed' | 'before-quit', handler: () => void): void;
    quit(): void;
    getVersion(): string;
    getPath(name: 'home'): string;
  };
  createWindow(options: BrowserWindowOptions): ElectronWindow;
  readonly ipcMain: {
    handle(channel: string, handler: (event: unknown, payload: unknown) => Promise<unknown>): void;
  };
  /**
   * 选一个目录（首运行第②步的工作空间）。
   *
   * **只有主进程能开系统对话框**，所以它必须从这里注入。没有它的话，
   * 首运行会卡在"选一个工作空间"那一步 —— `blockingReason` 要求至少有一个，
   * 而干净机器上一个都没有：整个应用打不开。2026-09-06 打开引导门禁时实测撞到。
   */
  readonly showOpenDialog?:
    | ((options: {
        properties: readonly ('openDirectory' | 'createDirectory')[];
      }) => Promise<{ canceled: boolean; filePaths: readonly string[] }>)
    | undefined;
  /**
   * 在访达 / 资源管理器里打开一个目录（「项目」页的「打开文件夹」，清单 §4.5）。
   *
   * 同样只有主进程能调 `shell.openPath`，所以走同一条注入路径。没有它时
   * `openProjectFolder` 静默什么都不做 —— 见 `service-host.ts` 的 `openPath` 选项。
   */
  readonly openPath?: ((path: string) => Promise<string>) | undefined;
}

/**
 * 窗口的安全参数。
 *
 * 这五项**没有一项可以为了方便而放宽**：
 *   · `contextIsolation: true` + `nodeIntegration: false` —— 渲染进程拿不到 Node，
 *     所以模型生成的内容即使被渲染出来也读不到文件系统（R5）
 *   · `sandbox: true` —— 渲染进程跑在 OS 沙箱里
 *   · `webviewTag: false` —— 04 §6.4 的内置浏览器**不用 webview**，它要的是独立 origin 的
 *     WebContentsView；开着 webviewTag 只会多一个逃逸面
 *   · preload 是渲染进程与主进程之间唯一的通道
 */
export const WINDOW_SECURITY = Object.freeze({
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
  webviewTag: false,
});

/** 01 §3.1：最小窗口 1024 宽。 */
export const WINDOW_SIZE = Object.freeze({
  width: 1280,
  height: 800,
  minWidth: 1024,
  minHeight: 640,
});

/**
 * 01 §3.2：**页面级控件放在窗口标题栏行内，没有独立的页面 header**。
 *
 * 这要求内容延伸到标题栏下面，所以 macOS 上用 `hiddenInset`（交通灯保留、标题栏消失）。
 * 用系统标题栏的话，侧边栏那条 52 高的图标带下面会再压一条系统栏 ——
 * 界面矮一截、且顶部凭空多出一条与设计稿无关的横带。
 *
 * 侧边栏的三个图标是**右对齐**的（01 §3.2 给的中心 x = 161/197/233），
 * 所以 Windows / Linux 上窗口控件跑到右上角也不会打架，不需要按平台分支。
 */
export const WINDOW_CHROME = Object.freeze({
  titleBarStyle: 'hiddenInset' as const,
});

export interface BootstrapOptions {
  readonly electron: ElectronApi;
  /** app-server 可执行文件（M9 打包时随内核二进制分发） */
  readonly appServerPath: string;
  /** 网关单文件产物。只在 `base_url` 指向本机时才被执行（见 `gateway-process.ts`） */
  readonly gatewayEntryPath?: string | undefined;
  readonly preloadPath: string;
  /** 开发时指向 vite dev server；生产为 undefined，走 loadFile */
  readonly devServerUrl?: string | undefined;
  readonly rendererHtmlPath: string;
  /** 随包的 `config/` 目录。首次运行时内核配置从这里装（见 `ensureKernelConfig`） */
  readonly configDir?: string | undefined;
  /** 注入以便测试；默认用真的宿主 */
  readonly createHost?:
    ((options: Parameters<typeof createServiceHost>[0]) => ServiceHost) | undefined;
}

export interface BootstrapResult {
  readonly window: ElectronWindow;
  readonly host: ServiceHost;
}

export async function bootstrap(options: BootstrapOptions): Promise<BootstrapResult> {
  const { electron } = options;
  await electron.app.whenReady();

  const paths = resolvePaths(join(electron.app.getPath('home'), '.evowork'));
  const window = electron.createWindow({
    ...WINDOW_SIZE,
    ...(process.platform === 'darwin' ? WINDOW_CHROME : {}),
    webPreferences: { preload: options.preloadPath, ...WINDOW_SECURITY },
  });

  // 外链一律不在应用窗口里打开：应用窗口有 preload，等于把桥暴露给任意页面
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => {
    event.preventDefault();
  });

  const create = options.createHost ?? createServiceHost;
  const host = create({
    paths,
    appServerPath: options.appServerPath,
    ...(options.gatewayEntryPath !== undefined
      ? { gatewayEntryPath: options.gatewayEntryPath }
      : {}),
    appVersion: electron.app.getVersion(),
    ...(options.configDir !== undefined ? { configDir: options.configDir } : {}),
    /*
     * 目录选择框。`showOpenDialog` 是可选注入，缺了就**没有这个能力**（返回 undefined），
     * 而不是崩 —— 测试里不需要真开一个系统对话框。
     */
    ...(electron.showOpenDialog
      ? {
          pickDirectory: async (): Promise<string | undefined> => {
            const r = await electron.showOpenDialog?.({
              properties: ['openDirectory', 'createDirectory'],
            });
            return r && !r.canceled ? r.filePaths[0] : undefined;
          },
        }
      : {}),
    ...(electron.openPath
      ? {
          openPath: async (path: string): Promise<void> => {
            await electron.openPath?.(path);
          },
        }
      : {}),
    emitToRenderer: (channel, payload) => window.webContents.send(channel, payload),
  });

  /*
   * 六个渲染动作。
   *
   * **在此之前这里只注册了审批一个** —— 于是界面能画出来，但回车、中断、行操作、
   * 场景列表全都得到 `No handler registered for 'evowork:send'`，
   * 而渲染层用 `void send()` 发起调用，rejection 无人接管：**表现就是"点了没反应"**。
   *
   * 循环遍历 `RENDERER_ACTIONS` 而不是逐个手写，是为了让"preload 声明了什么"
   * 与"主进程实现了什么"没有分叉的余地 —— 少一个就是编译期的类型错误，
   * 而不是运行期一句没人看见的报错（bootstrap.test.ts 有一条断言在扫它）。
   */
  for (const action of RENDERER_ACTIONS) {
    electron.ipcMain.handle(`evowork:${action}`, async (_event, payload) =>
      (host.actions[action] as (arg: never) => Promise<unknown>)(payload as never),
    );
  }

  await host.start();

  if (options.devServerUrl) await window.loadURL(options.devServerUrl);
  else await window.loadFile(options.rendererHtmlPath);

  // macOS 首发（Q26），但"关掉最后一个窗口就退出"在三个平台上都是对的：
  // 这是一个本机服务宿主，留一个没有窗口的后台进程只会让人以为它挂了
  electron.app.on('window-all-closed', () => electron.app.quit());
  electron.app.on('before-quit', () => void host.stop());

  return { window, host };
}
