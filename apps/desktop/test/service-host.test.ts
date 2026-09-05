/**
 * 本机服务宿主（09 §1）的接线。
 *
 * 这一层的测试回答的问题是"**启动顺序与故障路径对不对**"，而不是"某个函数返回什么"：
 * 先开库再起内核、库开不了就中止启动、崩溃后有恢复、UI 事件真的推给渲染进程、
 * 审批真的走到 UI 再回内核。这些只能在宿主这一层测 —— 拆开看每个模块都是对的。
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createServiceHost,
  IPC,
  resolvePaths,
  type ServiceHost,
} from '../src/main/service-host.js';

/**
 * 一个假的 app-server 子进程。
 *
 * 它比 kernel-adapter 里的 FakeAppServer 更薄：这里只需要"能握手、能收发行、能退出"，
 * 协议行为的细节已经在适配层测过了。重复测一遍只会让两处都难改。
 */
class FakeChild extends EventEmitter {
  readonly stdin = { write: (line: string) => this.#handle(line) };
  readonly stdout = new EventEmitter() as EventEmitter & {
    setEncoding: (enc: string) => void;
  };
  readonly stderr = { resume: () => undefined };
  readonly received: string[] = [];

  constructor() {
    super();
    (this.stdout as { setEncoding: (enc: string) => void }).setEncoding = () => undefined;
  }

  #handle(line: string): void {
    this.received.push(line);
    const message = JSON.parse(line) as { id?: number; method: string };
    if (message.id === undefined) return; // 通知
    const results: Record<string, unknown> = {
      initialize: { userAgent: 'fake' },
      'permissionProfile/list': { data: [{ id: ':workspace', allowed: true }] },
      'experimentalFeature/list': { data: [] },
      'project/list': { data: [] },
      'thread/list': { data: [], nextCursor: null },
    };
    const result = results[message.method] ?? {};
    this.reply({ jsonrpc: '2.0', id: message.id, result });
  }

  reply(message: unknown): void {
    this.stdout.emit('data', `${JSON.stringify(message)}\n`);
  }

  /** 主动发一个服务端请求（审批） */
  requestClient(id: number, method: string, params: unknown): void {
    this.reply({ jsonrpc: '2.0', id, method, params });
  }

  kill(): void {
    this.emit('exit', 0, null);
  }
}

let dir: string;
let host: ServiceHost | undefined;
let child: FakeChild;
let emitted: { channel: string; payload: unknown }[];

type HostOptions = Parameters<typeof createServiceHost>[0];

/** spawn 的调用记录：只关心可执行文件 */
function spawnSpy(value: unknown) {
  return vi.fn((..._args: unknown[]) => value) as unknown as ReturnType<typeof vi.fn> & {
    mock: { calls: [string, readonly string[], Record<string, unknown>][] };
  };
}

/**
 * `exactOptionalPropertyTypes` 下 `Partial<T>` 的可选属性会带上 undefined，
 * 而目标类型不接受显式 undefined。测试的覆盖参数因此用"确定有值"的形状。
 */
type HostOverride = { [K in keyof HostOptions]?: NonNullable<HostOptions[K]> };

function makeHost(over: HostOverride = {}): ServiceHost {
  const paths = resolvePaths(dir);
  mkdirSync(join(dir, 'modes'), { recursive: true });
  writeFileSync(join(dir, 'modes', 'craft.md'), '你可以动手。', 'utf8');

  child = new FakeChild();
  return createServiceHost({
    paths,
    appServerPath: '/fake/codex-app-server',
    appVersion: '0.0.0-test',
    emitToRenderer: (channel, payload) => emitted.push({ channel, payload }),
    askRenderer: async () => ({ decision: 'accept' }),
    spawnFn: (() => child) as unknown as HostOptions['spawnFn'],
    ...over,
  } as HostOptions);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'evowork-host-'));
  emitted = [];
});

afterEach(async () => {
  await host?.stop().catch(() => undefined);
  host = undefined;
  rmSync(dir, { recursive: true, force: true });
});

describe('路径布局（09 §7）', () => {
  it('内核家目录指向 `~/.evowork/kernel/`（环境变量名归适配层，桌面层不该知道）', () => {
    const paths = resolvePaths('/home/u/.evowork');
    expect(paths.kernelHome).toBe('/home/u/.evowork/kernel');
    expect(paths.db).toBe('/home/u/.evowork/evowork.db');
    // EvoWork 自己的配置与内核配置分开放（09 §7：不混进 config.toml）
    expect(paths.modes).toBe('/home/u/.evowork/modes');
    expect(paths.scenarios).toBe('/home/u/.evowork/scenarios');
  });
});

describe('启动顺序：**先开库、再起内核**（09 §4.6 的直接后果）', () => {
  it('库开好后才 spawn 内核', () => {
    host = makeHost();
    // 构造时库就开了（openStore 在 createServiceHost 里同步执行）
    expect(host.store.migrations.length).toBeGreaterThan(0);
    // 但内核还没起（start() 才起）
    expect(child.received).toHaveLength(0);
  });

  it('start() 完成握手并拉目录', async () => {
    host = makeHost();
    await host.start();

    const methods = child.received.map((line) => (JSON.parse(line) as { method: string }).method);
    expect(methods.slice(0, 2)).toEqual(['initialize', 'initialized']);
    expect(methods).toContain('permissionProfile/list');
    // 启动时做一次对账（09 §4.1）
    expect(methods).toContain('thread/list');
  });

  it('spawn 的是 appServerPath 指向的可执行文件（环境变量由适配层负责，见 launcher 测试）', async () => {
    const spawnFn = spawnSpy(child);
    host = makeHost({ spawnFn: spawnFn as unknown as NonNullable<HostOptions['spawnFn']> });
    await host.start();

    expect(spawnFn.mock.calls[0]?.[0]).toBe('/fake/codex-app-server');
    // 宿主**不知道**内核的环境变量叫什么 —— 那是 createSpawnLauncher 的知识（K2 边界）。
    // 直接扫源码：这条断言的对象是"这个文件里不该出现那个名字"，
    // 而 lint 规则已经在管它 —— 这里是第二道，确保重构时不会悄悄搬回来
    const hostSource = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), '../src/main/service-host.ts'),
      'utf8',
    );
    expect(hostSource).not.toContain('CODEX_' + 'HOME');
  });

  it('对账失败不阻塞启动（投影表是投影类，真源在内核，可以晚点补）', async () => {
    host = makeHost();
    const originalHandle = child.stdin.write;
    // 让 thread/list 报错
    child.stdin.write = (line: string) => {
      const message = JSON.parse(line) as { id?: number; method: string };
      if (message.method === 'thread/list' && message.id !== undefined) {
        child.received.push(line);
        child.reply({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: 'boom' } });
        return;
      }
      originalHandle(line);
    };

    await expect(host.start()).resolves.toBeUndefined();
  });
});

describe('UI 事件与审批的接线（K2：渲染进程不认协议方法名）', () => {
  it('内核通知 → 语义化 UI 事件推给渲染进程', async () => {
    host = makeHost();
    await host.start();
    emitted = [];

    child.reply({
      jsonrpc: '2.0',
      method: 'thread/started',
      params: {
        thread: {
          id: 't1',
          sessionId: 's1',
          preview: 'x',
          ephemeral: false,
          modelProvider: 'evowork',
          createdAt: 1,
          updatedAt: 1,
          status: 'idle',
          cwd: '/w',
          turns: [],
          name: '季度汇报',
        },
      },
    });
    await new Promise((r) => setImmediate(r));

    const uiEvents = emitted.filter((e) => e.channel === IPC.uiEvent);
    expect(uiEvents.map((e) => (e.payload as { type: string }).type)).toContain('task-created');
    // 推给渲染进程的东西里**没有协议方法名**
    expect(JSON.stringify(uiEvents)).not.toContain('thread/started');
  });

  it('审批请求 → 问渲染进程 → 回复内核（F14 的完整回路）', async () => {
    const askRenderer = vi.fn(async () => ({ decision: 'decline' as const }));
    host = makeHost({ askRenderer });
    await host.start();
    const before = child.received.length;

    child.requestClient(9001, 'item/commandExecution/requestApproval', {
      threadId: 't1',
      itemId: 'i1',
      command: 'rm -rf build',
      reason: '这个命令会删除文件',
    });
    await vi.waitFor(() => expect(child.received.length).toBeGreaterThan(before));

    // ① 问过渲染进程
    expect(askRenderer).toHaveBeenCalledWith(
      IPC.askApproval,
      expect.objectContaining({ kind: 'command', threadId: 't1' }),
    );
    // ② 把用户的决定回给了内核
    const reply = JSON.parse(child.received.at(-1) as string) as {
      id: number;
      result: { decision: string };
    };
    expect(reply.id).toBe(9001);
    expect(reply.result.decision).toBe('decline');
  });

  it('待审批列表变化推给渲染进程（10 §3.5 的全局可见性）', async () => {
    let resolveUser: (v: unknown) => void = () => {};
    host = makeHost({ askRenderer: () => new Promise((resolve) => (resolveUser = resolve)) });
    await host.start();
    emitted = [];

    child.requestClient(9002, 'item/fileChange/requestApproval', { threadId: 't1', itemId: 'i1' });
    await vi.waitFor(() =>
      expect(emitted.some((e) => e.channel === IPC.pendingApprovals)).toBe(true),
    );

    const pending = emitted.filter((e) => e.channel === IPC.pendingApprovals).at(-1);
    expect((pending?.payload as unknown[]).length).toBe(1);

    resolveUser({ decision: 'accept' });
    await vi.waitFor(() => {
      const last = emitted.filter((e) => e.channel === IPC.pendingApprovals).at(-1);
      expect((last?.payload as unknown[]).length).toBe(0);
    });
  });

  it('降级显式推给 UI（09 §3.3：不假装正常）', async () => {
    host = makeHost();
    // 让能力探测失败成 method-not-found
    const original = child.stdin.write;
    child.stdin.write = (line: string) => {
      const message = JSON.parse(line) as { id?: number; method: string };
      if (message.method === 'project/list' && message.id !== undefined) {
        child.received.push(line);
        child.reply({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'gone' } });
        return;
      }
      original(line);
    };

    await host.start();
    const degrades = emitted.filter((e) => e.channel === IPC.degrade);
    expect(degrades).toHaveLength(1);
    expect(
      (degrades[0]?.payload as { degradation?: { userVisible: string } }).degradation?.userVisible,
    ).toContain('项目');
  });
});

describe('崩溃恢复（09 §1）', () => {
  it('内核退出后重启并**显式通知**用户', async () => {
    host = makeHost();
    await host.start();
    emitted = [];

    // 内核崩溃。真实退避是 1s 起，这里用真实定时器等一下即可（第一次退避 1s）
    child.emit('exit', 1, null);
    await vi.waitFor(
      () => {
        const notices = emitted.filter((e) => e.channel === IPC.notice);
        expect(notices.length).toBeGreaterThan(0);
      },
      { timeout: 4000 },
    );

    const notice = emitted.filter((e) => e.channel === IPC.notice).at(-1);
    expect((notice?.payload as { kind: string }).kind).toBe('kernel-restarted');
    // **不静默重启**：文案要让用户知道刚才那个中断的任务发生了什么
    expect((notice?.payload as { text: string }).text).toContain('已重启');
  }, 10_000);
});

describe('对账定时器（09 §4.1：每 10 分钟）', () => {
  it('间隔就是文档里的 10 分钟', () => {
    host = makeHost();
    expect(host.reconcileIntervalMs).toBe(10 * 60_000);
  });
});
