/**
 * 一个可脚本化的假 app-server。
 *
 * 它存在的理由不是"避免起真进程"这种便利性说法，而是三件**只能靠假内核才能测的事**：
 *
 *   ① **崩溃与恢复**：随时 `crash()`，验证退避重启 + 会话补齐 + 不静默重启（09 §1）。
 *   ② **服务端请求**：主动发出审批请求（F14），验证前端处理器一定回复、以及超时策略。
 *   ③ **降级**：让某个实验方法回 -32601，验证 09 §3.3 的兜底真的被走到。
 *
 * 这三条都是"治理路径"，而治理路径上的死代码是本项目栽过的坑：一段从没有测试走到过的
 * 恢复逻辑，等到真出事那天才第一次执行。
 *
 * **它不模仿内核的业务行为**，只模仿协议形状。业务正确性由真实内核在 M0 端到端验证。
 */
import { ERROR_CODE, type Thread, type Turn } from '@evowork/protocol';

import type { KernelLauncher, KernelProcess } from '../src/session.js';

export interface FakeHandlerContext {
  readonly method: string;
  readonly params: Record<string, unknown>;
  readonly server: FakeAppServer;
}

export type FakeHandler = (ctx: FakeHandlerContext) => unknown;

/**
 * 处理器抛出这个哨兵 = **不回复**（请求悬在那里）。
 *
 * 真实内核有两种"不回复"：长任务还在跑（正常），与管道阻塞（故障）。两者在客户端看起来
 * 一模一样，而客户端对它们的处理完全不同（前者要等，后者要重连）——
 * 所以必须能在测试里造出"不回复"这个状态本身。
 */
export const NO_REPLY = Symbol('fake-app-server:no-reply');

export class FakeAppServer {
  #stdoutHandlers: ((chunk: string) => void)[] = [];
  #exitHandlers: ((info: { code: number | null; signal: string | null }) => void)[] = [];
  #alive = true;
  #serverRequestId = 1000;
  #pendingServerRequests = new Map<number, (result: unknown) => void>();

  /** 收到的请求（method 序列），用于断言握手顺序等 */
  readonly received: { method: string; params: Record<string, unknown> }[] = [];
  /** 方法处理器。未注册的方法回 -32601（正好用来测降级） */
  readonly handlers = new Map<string, FakeHandler>();
  /** 启动次数，用于断言退避重启 */
  launches = 0;

  constructor(seed?: Record<string, FakeHandler>) {
    this.installDefaults();
    for (const [method, handler] of Object.entries(seed ?? {})) {
      this.handlers.set(method, handler);
    }
  }

  installDefaults(): void {
    this.handlers.set('initialize', () => ({
      userAgent: 'fake-app-server/0',
      serverInfo: { name: 'fake', version: '0.0.0' },
    }));
    this.handlers.set('permissionProfile/list', () => ({
      data: [
        { id: ':read-only', description: 'read only', allowed: true },
        { id: ':workspace', description: 'workspace write', allowed: true },
        // 企业策略锁定的档位（F4：allowed=false 就是"存在但你不能选"）
        { id: ':danger-full-access', description: 'full access', allowed: false },
      ],
    }));
    this.handlers.set('experimentalFeature/list', () => ({
      data: [
        { name: 'shell_tool', stage: 'stable', enabled: true },
        { name: 'unified_exec', stage: 'stable', enabled: true },
      ],
    }));
    this.handlers.set('project/list', () => ({ data: [] }));
    this.handlers.set('thread/start', (ctx) => {
      const threadId = `thread_${this.received.length}`;
      return {
        thread: makeThread({
          id: threadId,
          cwd: (ctx.params.cwd as string) ?? '/w',
        }),
        model: 'deepseek-chat',
        modelProvider: 'evowork',
        cwd: (ctx.params.cwd as string) ?? '/w',
      };
    });
    this.handlers.set('turn/start', (ctx) => ({
      turn: makeTurn({ id: `turn_${this.received.length}`, status: 'inProgress' }),
      threadId: ctx.params.threadId,
    }));
    this.handlers.set('turn/interrupt', () => ({}));
    this.handlers.set('turn/steer', () => ({}));
    this.handlers.set('thread/resume', (ctx) => ({
      thread: makeThread({ id: String(ctx.params.threadId ?? 'thread_0') }),
    }));
    this.handlers.set('thread/items/list', () => ({ data: [] }));
    this.handlers.set('thread/read', (ctx) => ({
      thread: makeThread({ id: String(ctx.params.threadId ?? 'thread_0') }),
    }));
    this.handlers.set('thread/list', () => ({ data: [], nextCursor: null }));
    this.handlers.set('thread/goal/set', () => ({}));
  }

  /** 作为 launcher 交给 KernelSession。每次 launch 都是"一个新进程"。 */
  launcher(): KernelLauncher {
    return {
      launch: (): KernelProcess => {
        this.launches += 1;
        this.#alive = true;
        this.#stdoutHandlers = [];
        this.#exitHandlers = [];
        return {
          writeLine: (line) => this.#handleLine(line),
          onStdout: (handler) => this.#stdoutHandlers.push(handler),
          onExit: (handler) => this.#exitHandlers.push(handler),
          kill: () => this.crash({ code: 0, signal: 'SIGTERM' }),
        };
      },
    };
  }

  /** 模拟崩溃（或被 kill）。 */
  crash(info: { code: number | null; signal: string | null } = { code: 1, signal: null }): void {
    if (!this.#alive) return;
    this.#alive = false;
    for (const handler of [...this.#exitHandlers]) handler(info);
  }

  /** 模拟"进程活着但不回应"（stdio 阻塞，09 §5 第二行）。 */
  freeze(): void {
    this.handlers.set('permissionProfile/list', () => {
      throw new Error('frozen');
    });
  }

  /** 主动发一条通知。 */
  notify(method: string, params: unknown): void {
    this.#write({ jsonrpc: '2.0', method, params });
  }

  /**
   * 主动发一个**服务端请求**（F14 的核心场景）。返回客户端的回复。
   * 如果客户端不回复，这个 Promise 就一直悬着 —— 与真实内核一样。
   */
  requestClient(method: string, params: unknown): Promise<unknown> {
    const id = this.#serverRequestId++;
    return new Promise((resolve) => {
      this.#pendingServerRequests.set(id, resolve);
      this.#write({ jsonrpc: '2.0', id, method, params });
    });
  }

  /** 让某个方法回 method-not-found（测降级）。 */
  removeMethod(method: string): void {
    this.handlers.delete(method);
  }

  /** 让某个方法**永不回复**（测 in-flight 请求在崩溃时被拒掉）。 */
  blackhole(method: string): void {
    this.handlers.set(method, () => {
      throw NO_REPLY;
    });
  }

  #handleLine(line: string): void {
    if (!this.#alive) return;
    const message = JSON.parse(line) as Record<string, unknown>;

    // 客户端对服务端请求的回复
    if ('id' in message && ('result' in message || 'error' in message) && !('method' in message)) {
      const resolve = this.#pendingServerRequests.get(message.id as number);
      if (resolve) {
        this.#pendingServerRequests.delete(message.id as number);
        resolve('error' in message ? { error: message.error } : message.result);
      }
      return;
    }

    const method = String(message.method);
    const params = (message.params ?? {}) as Record<string, unknown>;
    this.received.push({ method, params });

    if (!('id' in message)) return; // 通知（如 initialized），无需回复

    const handler = this.handlers.get(method);
    if (!handler) {
      this.#write({
        jsonrpc: '2.0',
        id: message.id,
        error: { code: ERROR_CODE.methodNotFound, message: `unknown method: ${method}` },
      });
      return;
    }
    try {
      const result = handler({ method, params, server: this });
      this.#write({ jsonrpc: '2.0', id: message.id, result: result ?? {} });
    } catch (err) {
      if (err === NO_REPLY) return; // 刻意不回复
      this.#write({
        jsonrpc: '2.0',
        id: message.id,
        error: {
          code: ERROR_CODE.internalError,
          message: err instanceof Error ? err.message : 'fake error',
        },
      });
    }
  }

  #write(message: unknown): void {
    const line = `${JSON.stringify(message)}\n`;
    for (const handler of [...this.#stdoutHandlers]) handler(line);
  }
}

export function makeThread(over: Partial<Thread> = {}): Thread {
  return {
    id: 'thread_0',
    sessionId: 'session_0',
    preview: '把 data/ 下的三张表合并',
    ephemeral: false,
    modelProvider: 'evowork',
    model: 'deepseek-chat',
    createdAt: 1_757_000_000,
    updatedAt: 1_757_000_100,
    recencyAt: 1_757_000_100,
    status: 'idle',
    cwd: '/w',
    turns: [],
    ...over,
  };
}

export function makeTurn(over: Partial<Turn> = {}): Turn {
  return {
    id: 'turn_0',
    items: [],
    status: 'inProgress',
    ...over,
  };
}
