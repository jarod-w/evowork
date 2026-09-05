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
import { IPC, type ServiceHost } from '../src/main/service-host.js';

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

  it('审批：主进程发问 → 渲染进程回答 → promise 兑现（F14 的完整回路）', async () => {
    await boot();
    const answer = hostOptions.askRenderer(IPC.askApproval, { kind: 'command' });

    const asked = sent.find((s) => s.channel === IPC.askApproval);
    const id = (asked?.payload as { id: string }).id;
    expect(id).toMatch(/^apv_/);

    await handlers.get(IPC.askApproval)?.(null, { id, decision: 'decline' });
    await expect(answer).resolves.toEqual({ decision: 'decline' });
  });

  it('渲染进程不回复时 promise 就一直悬着（10 §3.6：交互式任务不自动拒绝）', async () => {
    await boot();
    const answer = hostOptions.askRenderer(IPC.askApproval, {});
    const settled = await Promise.race([
      answer.then(() => 'settled'),
      new Promise((r) => setTimeout(() => r('pending'), 20)),
    ]);
    expect(settled).toBe('pending');
  });
});
