/**
 * Electron 引导（Q23）。
 *
 * 这组测试存在的唯一理由是**窗口的安全参数必须能被钉住**：
 * `contextIsolation` 被谁改成 false 不会有任何开发期症状，它只在有人往渲染进程
 * 注入内容那天表现出来（R5）。同理还有 window.open 与导航。
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  bootstrap,
  WINDOW_SECURITY,
  WINDOW_SIZE,
  type BrowserWindowOptions,
  type ElectronApi,
  type ElectronWindow,
} from '../src/main/bootstrap.js';
import { SchemaNewerThanApp } from '@evowork/store';

import { RENDERER_ACTIONS, RENDERER_CHANNELS } from '../src/preload/index.js';
import { IPC, type ServiceHost } from '../src/main/service-host.js';

let home: string;
let sent: { channel: string; payload: unknown }[];
let handlers: Map<string, (event: unknown, payload: unknown) => Promise<unknown>>;
let windowOptions: BrowserWindowOptions | undefined;
let navigate: ((event: { preventDefault(): void }, url: string) => void) | undefined;
let openHandler: ((details: { url: string }) => { action: string }) | undefined;
let registeredScheme: string | undefined;
let openUrl: ((url: string) => void) | undefined;
let secondInstance: ((argv: readonly string[]) => void) | undefined;
/** 设了它，假 electron 就在 bootstrap 接线的同一刻把这条 URL 交出来（模拟 macOS 冷启动） */
let earlyUrl: string | undefined;
let subscribed = false;
let hostOptions: Parameters<typeof import('../src/main/service-host.js').createServiceHost>[0];
let queued: unknown[] = [];

function fakeElectron(): ElectronApi {
  return {
    app: {
      whenReady: () => Promise.resolve(),
      on: () => undefined,
      quit: () => undefined,
      getVersion: () => '0.0.0-test',
      getPath: () => home,
      setAsDefaultProtocolClient: (scheme) => {
        registeredScheme = scheme;
        return true;
      },
      /*
       * **注册的那一刻就回调**，这不是为了省事 —— 它就是 macOS 的真实形状：
       * 用户在应用没开着的时候点一条分享链接，系统的 `open-url` 会在 `whenReady`
       * 之前就来，`electron-entry.mjs` 把它存着，等 bootstrap 接上来一次性交出去。
       * 所以"接线的同一刻就收到一条 URL"是必然会发生的情况，不是边角。
       */
      onOpenUrl: (handler) => {
        openUrl = handler;
        if (earlyUrl) handler(earlyUrl);
      },
      onSecondInstance: (handler) => (secondInstance = handler),
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
    queueDeeplink: vi.fn((delivery) => queued.push(delivery)),
    // 渲染层挂载并订阅了事件没有 —— 深链推还是存，由它决定
    rendererSubscribed: () => subscribed,
    deeplinkLookup: {
      hasTask: () => false,
      hasAutomation: () => false,
      hasArtifact: () => false,
      hasShare: () => false,
    },
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
  registeredScheme = undefined;
  openUrl = undefined;
  secondInstance = undefined;
  earlyUrl = undefined;
  queued = [];
  subscribed = false;
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

  it('最小窗口 480×600（01 §1 / §4.2）', async () => {
    await boot();
    expect(windowOptions?.minWidth).toBe(480);
    expect(windowOptions?.minHeight).toBe(600);
    expect(WINDOW_SIZE.minWidth).toBe(480);
    expect(WINDOW_SIZE.height).toBe(820);
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
   * **`EVOWORK_HOME` 能把整个数据根目录挪走。**
   *
   * 它存在的理由是"没有它就没法安全地验打包产物"：应用的家目录跟着 `$HOME` 走，
   * 于是冒烟测试要么跑在用户的真实数据上（第一版真的跑上去了），要么改 `$HOME` ——
   * 而改 `$HOME` 会让 macOS 找不到登录钥匙串，弹模态框把应用卡死在启动。
   *
   * 断言两条路径**都**跟着走：只挪 `home` 而 `kernelHome` 仍指向真实家目录的话，
   * 表现是"数据隔离了但内核没有"，而那种半隔离比不隔离更难发现。
   */
  it('`EVOWORK_HOME` 覆盖数据根目录（企业部署与打包冒烟都靠它）', async () => {
    const overridden = join(home, 'elsewhere', 'evowork-data');
    process.env.EVOWORK_HOME = overridden;
    try {
      await boot();
      expect(hostOptions.paths.home).toBe(overridden);
      expect(hostOptions.paths.kernelHome).toBe(join(overridden, 'kernel'));
    } finally {
      delete process.env.EVOWORK_HOME;
    }
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

describe('深链：推还是存（02 §8）', () => {
  /*
   * 这一组守的是一件**在 2026-09-27 之前是坏的**的事。
   *
   * 当时 `handleDeeplink` 的判据是一个叫 `cold` 的布尔：只有 argv 那条路传 true，
   * `open-url` 一律直接推。在 Windows / Linux 上这是对的 —— 系统确实只用 argv。
   * **在 macOS 上它是错的**：系统用 `open-url`，而用户在应用没开着的时候点一条分享链接，
   * 那个事件会在 `whenReady` 之前就来。那同样是冷启动，只是不走 argv。
   *
   * 后果不是报错，是那条链接**无声地消失**——「点了什么都没发生」，
   * 而那正是 02 §8 这条特性存在的理由。
   */
  it('注册的同一刻就到的 open-url 要存下来，不能推 —— 那时渲染层还没订阅', async () => {
    earlyUrl = 'evowork://task/thr_early';
    await boot();

    expect(
      sent.filter((m) => (m.payload as { type?: string }).type === 'deeplink'),
      '早到的深链被推给了一个还没订阅事件的渲染层 —— 它会被丢掉，表现是「点了没反应」',
    ).toEqual([]);
    expect(queued, '早到的深链既没推也没存 —— 它就这么没了').toHaveLength(1);
  });

  it('渲染层订阅之后再来的 open-url 才走推，**而且推在渲染层真的在听的那个频道上**', async () => {
    await boot();
    subscribed = true;
    openUrl?.('evowork://task/thr_live');

    const pushed = sent.filter((m) => (m.payload as { type?: string }).type === 'deeplink');
    expect(pushed, '应用开着的时候收到深链，应该立刻推给渲染层').toHaveLength(1);
    /*
     * **频道名单独断一次。** 这里原本硬编码 `'evowork:event'`，而渲染层监听的是
     * `'evowork:ui-event'` —— 少三个字符，`send` 照常返回、不报错，
     * 热路径上的每一条深链都掉进一个没有监听者的频道。
     * 断 `RENDERER_CHANNELS.uiEvent` 而不是断字面量：那个常量是**渲染层这一侧的真源**。
     */
    expect(pushed[0]?.channel, '推到了一个渲染层没在听的频道上').toBe(RENDERER_CHANNELS.uiEvent);
    expect(queued, '已经订阅了还往队列里存，渲染层不会再来领第二次').toEqual([]);
  });

  it('第二个实例递过来的 argv 走同一条判据', async () => {
    await boot();
    subscribed = true;
    secondInstance?.(['/path/to/EvoWork', 'evowork://library/nod_second']);

    expect(
      sent.filter((m) => (m.payload as { type?: string }).type === 'deeplink'),
      '第二个实例的 argv 没有被送到渲染层 —— 点链接唤起已开着的应用时什么都不会发生',
    ).toHaveLength(1);
  });

  it('协议注册真的被调用了，而且注册的是 evowork', async () => {
    await boot();
    /*
     * 这一条看着像废话，但它红过：真入口从来没提供 `setAsDefaultProtocolClient`，
     * 而 bootstrap 用 `?.` 调它 —— **没提供就是静默跳过**。
     * 这里钉的是 bootstrap 这一侧；真入口那一侧由 `electron-entry-port.test.ts` 守。
     */
    expect(registeredScheme).toBe('evowork');
  });
});

describe('主进程与渲染层的频道名必须是同一个', () => {
  /*
   * 这两份常量各自都对，合起来才可能错 —— 而它们分别住在主进程与 preload 里，
   * 没有任何类型把它们拴在一起。2026-09-27 正是这条缝让深链的热路径整条失效。
   */
  it('service-host 的 IPC 与 preload 的 RENDERER_CHANNELS 一一相等', () => {
    for (const [name, channel] of Object.entries(RENDERER_CHANNELS)) {
      const mine = (IPC as Record<string, string | undefined>)[name];
      if (mine === undefined) continue; // preload 可以多几个（主进程不一定都发）
      expect(mine, `频道 ${name} 两边对不上：主进程 ${mine} / 渲染层 ${channel}`).toBe(channel);
    }
  });

  /**
   * **发送点一律走常量，不许手写频道字面量。**
   *
   * 上面两条各自漏了一半：「两边常量相等」管不到没进常量表的名字，
   * 「主进程发的每个频道渲染层都得在听」遍历的是 `IPC` —— 一个手写的字面量
   * 两条都绕得过去。而 #7 正是这么发生的（`'evowork:event'` 少三个字符，
   * `send` 照常返回）。补这一条之后，**下一个手写的字面量在写出来的时候就红**，
   * 不用等到有人在真 `.app` 上点一条链接。
   *
   * 2026-09-27 加它时立刻抓到一个已经在树里的：`service-host.ts` 的
   * `emitToRenderer('evowork:computer-use-status', …)` —— 名字碰巧是对的，
   * 但它是同一个名字的第三份手抄，且不在 `IPC` 里，上面两条都看不见它。
   */
  it('主进程的发送点不许手写频道字面量', () => {
    const MAIN = join(dirname(fileURLToPath(import.meta.url)), '../src/main');
    const offenders: string[] = [];
    for (const file of readdirSync(MAIN).filter((n) => n.endsWith('.ts'))) {
      const code = readFileSync(join(MAIN, file), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '');
      for (const m of code.matchAll(/(?:emitToRenderer|webContents\.send)\(\s*'([^']+)'/g)) {
        offenders.push(`${file}: '${m[1]}'`);
      }
    }
    expect(offenders, `这些发送点手写了频道名，改用 IPC.* 常量：${offenders.join(' / ')}`).toEqual(
      [],
    );
  });

  it('主进程发的每一个频道，渲染层都得在听', () => {
    const heard = new Set(Object.values(RENDERER_CHANNELS));
    const unheard = Object.entries(IPC).filter(([, channel]) => !heard.has(channel));
    expect(
      unheard.map(([name]) => name),
      `这些频道主进程在发、渲染层没在听：${unheard.map(([, c]) => c).join(' / ')}`,
    ).toEqual([]);
  });
});

describe('启动失败要让用户看见（在线升级提案 §4 A1）', () => {
  /** 带上错误对话框的假 electron；返回值收集弹过的每一次 */
  function bootFailing(fail: { atCreate?: unknown; atStart?: unknown }) {
    const shown: { title: string; content: string }[] = [];
    const run = bootstrap({
      electron: {
        ...fakeElectron(),
        showErrorBox: (title, content) => shown.push({ title, content }),
      },
      appServerPath: '/fake/app-server',
      preloadPath: '/fake/preload.js',
      rendererHtmlPath: '/fake/index.html',
      createHost: () => {
        if (fail.atCreate !== undefined) throw fail.atCreate;
        const host = fakeHost();
        if (fail.atStart !== undefined) {
          return { ...host, start: vi.fn(async () => Promise.reject(fail.atStart)) };
        }
        return host;
      },
    });
    return { run, shown };
  }

  it('开库时发现库比应用新：退出前弹一次说明，然后照样往外抛（真入口靠它退出）', async () => {
    const error = new SchemaNewerThanApp(4, 3, '0.0.9');
    const { run, shown } = bootFailing({ atCreate: error });
    await expect(run).rejects.toBe(error);
    expect(shown).toHaveLength(1);
    expect(shown[0]?.content).toContain('请安装 EvoWork 0.0.9 或更新的版本');
  });

  it('host.start() 里的同类失败走同一条路', async () => {
    const { run, shown } = bootFailing({ atStart: new SchemaNewerThanApp(4, 3, undefined) });
    await expect(run).rejects.toBeInstanceOf(SchemaNewerThanApp);
    expect(shown).toHaveLength(1);
  });

  it('认不出来的失败不弹框 —— 不把写给开发者的 message 拿去给用户看', async () => {
    const { run, shown } = bootFailing({ atStart: new Error('spawn ENOENT') });
    await expect(run).rejects.toThrow('spawn ENOENT');
    expect(shown).toEqual([]);
  });
});
