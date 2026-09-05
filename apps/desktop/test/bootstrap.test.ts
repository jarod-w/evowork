/**
 * Electron 引导（Q23）。
 *
 * 这组测试存在的唯一理由是**窗口的安全参数必须能被钉住**：
 * `contextIsolation` 被谁改成 false 不会有任何开发期症状，它只在有人往渲染进程
 * 注入内容那天表现出来（R5）。同理还有 window.open 与导航。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  bootstrap,
  WINDOW_SECURITY,
  WINDOW_SIZE,
  type BrowserWindowOptions,
  type ElectronApi,
  type ElectronWindow,
} from '../src/main/bootstrap.js';
import { RENDERER_ACTIONS } from '../src/preload/index.js';
import { type ServiceHost } from '../src/main/service-host.js';

let home: string;
let sent: { channel: string; payload: unknown }[];
let handlers: Map<string, (event: unknown, payload: unknown) => Promise<unknown>>;
let windowOptions: BrowserWindowOptions | undefined;
let navigate: ((event: { preventDefault(): void }, url: string) => void) | undefined;
let openHandler: ((details: { url: string }) => { action: string }) | undefined;
let hostOptions: Parameters<typeof import('../src/main/service-host.js').createServiceHost>[0];

function fakeElectron(): ElectronApi {
  return {
    app: {
      whenReady: () => Promise.resolve(),
      on: () => undefined,
      quit: () => undefined,
      getVersion: () => '0.0.0-test',
      getPath: () => home,
    },
    createWindow: (options): ElectronWindow => {
      windowOptions = options;
      return {
        webContents: {
          send: (channel, payload) => sent.push({ channel, payload }),
          setWindowOpenHandler: (handler) => (openHandler = handler),
          on: (_event, handler) => (navigate = handler),
        },
        loadURL: () => Promise.resolve(),
        loadFile: () => Promise.resolve(),
        on: () => undefined,
      };
    },
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
  };
}

function fakeHost(): ServiceHost {
  return {
    store: {} as ServiceHost['store'],
    adapter: {} as ServiceHost['adapter'],
    logger: {} as ServiceHost['logger'],
    services: {} as ServiceHost['services'],
    actions: {
      send: vi.fn(async () => ({ threadId: 't1' })),
      interrupt: vi.fn(async () => undefined),
      decideApproval: vi.fn(async () => undefined),
      rowAction: vi.fn(async () => undefined),
      refreshVisible: vi.fn(async () => undefined),
      getStartup: vi.fn(async () => ({}) as never),
    } as unknown as ServiceHost['actions'],
    resolveApproval: vi.fn(),
    reconcileIntervalMs: 0,
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
  };
}

async function boot() {
  return bootstrap({
    electron: fakeElectron(),
    appServerPath: '/fake/app-server',
    preloadPath: '/fake/preload.js',
    rendererHtmlPath: '/fake/index.html',
    createHost: (options) => {
      hostOptions = options;
      return fakeHost();
    },
  });
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'evowork-boot-'));
  sent = [];
  handlers = new Map();
  windowOptions = undefined;
  navigate = undefined;
  openHandler = undefined;
});

afterEach(() => rmSync(home, { recursive: true, force: true }));

describe('窗口安全参数（R5）', () => {
  it('五项全开且方向正确', async () => {
    await boot();
    expect(windowOptions?.webPreferences).toMatchObject({
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
      preload: '/fake/preload.js',
    });
  });

  it('常量本身也钉住 —— 有人改这里比改调用点更省事', () => {
    expect(WINDOW_SECURITY).toEqual({
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
    });
  });

  it('最小窗口宽 1024（01 §3.1）', async () => {
    await boot();
    expect(windowOptions?.minWidth).toBe(1024);
    expect(WINDOW_SIZE.minWidth).toBe(1024);
  });

  it('**外链一律不在应用窗口里打开** —— 应用窗口带 preload，等于把桥交出去', async () => {
    await boot();
    expect(openHandler?.({ url: 'https://example.com' })).toEqual({ action: 'deny' });
  });

  it('**任何导航都被阻止** —— 页面只能是我们打包的那一个', async () => {
    await boot();
    const event = { preventDefault: vi.fn() };
    navigate?.(event, 'https://example.com');
    expect(event.preventDefault).toHaveBeenCalled();
  });
});

describe('接线', () => {
  it('内核家目录挂在 `~/.evowork/` 下，且宿主拿到的是路径不是环境变量名', async () => {
    await boot();
    expect(hostOptions.paths.home).toBe(join(home, '.evowork'));
    expect(hostOptions.paths.kernelHome).toBe(join(home, '.evowork', 'kernel'));
  });

  /**
   * 这条守的是一次真实故障：preload 声明了六个动作，而这里只注册了审批一个。
   * 表现是**界面完全正常、回车没有任何反应** —— 渲染层用 `void send()` 发起调用，
   * `No handler registered for 'evowork:send'` 这个 rejection 无人接管，
   * 既不弹窗也不进日志。
   */
  it('preload 声明的每个动作都注册了 ipcMain handler', async () => {
    const { host } = await boot();
    for (const action of RENDERER_ACTIONS) {
      expect(handlers.has(`evowork:${action}`), `evowork:${action} 没有 handler`).toBe(true);
    }
    // 少一个都不行；多一个说明有人绕过了 RENDERER_ACTIONS
    expect([...handlers.keys()].sort()).toEqual(RENDERER_ACTIONS.map((a) => `evowork:${a}`).sort());
    expect(host.actions.send).toBeDefined();
  });

  it('动作的载荷原样交给宿主（回车 = 一次 send）', async () => {
    const { host } = await boot();
    await handlers.get('evowork:send')?.(null, { text: '做个周报' });
    expect(host.actions.send).toHaveBeenCalledWith({ text: '做个周报' });
  });
});
