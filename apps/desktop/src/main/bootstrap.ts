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

import { createServiceHost, IPC, resolvePaths, type ServiceHost } from './service-host.js';

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

export interface BootstrapOptions {
  readonly electron: ElectronApi;
  /** app-server 可执行文件（M9 打包时随内核二进制分发） */
  readonly appServerPath: string;
  readonly preloadPath: string;
  /** 开发时指向 vite dev server；生产为 undefined，走 loadFile */
  readonly devServerUrl?: string | undefined;
  readonly rendererHtmlPath: string;
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
    webPreferences: { preload: options.preloadPath, ...WINDOW_SECURITY },
  });

  // 外链一律不在应用窗口里打开：应用窗口有 preload，等于把桥暴露给任意页面
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => {
    event.preventDefault();
  });

  const pendingApproval = new Map<string, (value: unknown) => void>();
  let seq = 0;

  const create = options.createHost ?? createServiceHost;
  const host = create({
    paths,
    appServerPath: options.appServerPath,
    appVersion: electron.app.getVersion(),
    emitToRenderer: (channel, payload) => window.webContents.send(channel, payload),
    askRenderer: (channel, payload) => {
      // 审批是**服务端发起的请求**（F14），最终落在用户身上。
      // 这里把它变成一个 promise，等渲染进程通过 ipc 回来才 resolve ——
      // 渲染进程不回复时它就一直悬着，那是对的：交互式任务不自动拒绝（10 §3.6）
      const id = `apv_${(seq += 1)}`;
      return new Promise((resolve) => {
        pendingApproval.set(id, resolve);
        window.webContents.send(channel, { id, ...(payload as object) });
      });
    },
  });

  electron.ipcMain.handle(IPC.askApproval, async (_event, payload) => {
    const { id, ...rest } = payload as { id: string };
    pendingApproval.get(id)?.(rest);
    pendingApproval.delete(id);
    return undefined;
  });

  await host.start();

  if (options.devServerUrl) await window.loadURL(options.devServerUrl);
  else await window.loadFile(options.rendererHtmlPath);

  // macOS 首发（Q26），但"关掉最后一个窗口就退出"在三个平台上都是对的：
  // 这是一个本机服务宿主，留一个没有窗口的后台进程只会让人以为它挂了
  electron.app.on('window-all-closed', () => electron.app.quit());
  electron.app.on('before-quit', () => void host.stop());

  return { window, host };
}
