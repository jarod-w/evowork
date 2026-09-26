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

/**
 * 处理器抛出它 = 回一个**指定 code** 的错误。
 *
 * 普通 `throw` 一律变成 -32603，而客户端对错误码是分情况处理的（-32601 触发降级、
 * -32600 里还分"参数不合法"与"没有活动回合"）。区分不出来，那些分支就没法测。
 */
export class FakeRpcError extends Error {
  override readonly name = 'FakeRpcError';
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

export class FakeAppServer {
  #stdoutHandlers: ((chunk: string) => void)[] = [];
  #exitHandlers: ((info: { code: number | null; signal: string | null }) => void)[] = [];
  #alive = true;
  #serverRequestId = 1000;
  #pendingServerRequests = new Map<number, (result: unknown) => void>();

  /** 收到的请求（method 序列），用于断言握手顺序等 */
  readonly received: { method: string; params: Record<string, unknown> }[] = [];
  readonly threadMemoryModes = new Map<string, string>();
  memoryResetCount = 0;
  memoryConfig: {
    enabled: boolean;
    version?: 'v1' | 'v2';
    useMemories: boolean;
    generateMemories: boolean;
    disableOnExternalContext: boolean;
  } = {
    enabled: true,
    version: 'v2',
    useMemories: true,
    generateMemories: true,
    disableOnExternalContext: true,
  };
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
    this.handlers.set('skills/extraRoots/set', () => ({}));
    this.handlers.set('skills/list', (ctx) => ({
      data: ((ctx.params.cwds as readonly string[] | undefined) ?? ['/w']).map((cwd) => ({
        cwd,
        skills: [],
        errors: [],
      })),
    }));
    this.handlers.set('fuzzyFileSearch', () => ({ files: [] }));
    this.handlers.set('skills/config/write', (ctx) => ({
      effectiveEnabled: Boolean(ctx.params.enabled),
    }));
    this.handlers.set('plugin/list', () => ({
      marketplaces: [],
      marketplaceLoadErrors: [],
      featuredPluginIds: [],
    }));
    this.handlers.set('plugin/install', () => ({ authPolicy: 'ON_USE', appsNeedingAuth: [] }));
    this.handlers.set('plugin/uninstall', () => ({}));
    this.handlers.set('mcpServerStatus/list', () => ({ data: [], nextCursor: null }));
    this.handlers.set('mcpServer/oauth/login', () => ({
      authorizationUrl: 'https://auth.example/authorize',
    }));
    this.handlers.set('config/mcpServer/reload', () => ({}));
    this.handlers.set('config/read', () => ({
      config: {
        features: { memories: this.memoryConfig.enabled },
        memories: {
          version: this.memoryConfig.version,
          use_memories: this.memoryConfig.useMemories,
          generate_memories: this.memoryConfig.generateMemories,
          disable_on_external_context: this.memoryConfig.disableOnExternalContext,
        },
      },
      origins: {},
    }));
    this.handlers.set('config/batchWrite', (ctx) => {
      for (const raw of (ctx.params.edits as readonly Record<string, unknown>[] | undefined) ??
        []) {
        const key = raw.keyPath;
        if (key === 'features.memories') this.memoryConfig.enabled = Boolean(raw.value);
        if (key === 'memories.use_memories') this.memoryConfig.useMemories = Boolean(raw.value);
        if (key === 'memories.generate_memories')
          this.memoryConfig.generateMemories = Boolean(raw.value);
        if (key === 'memories.disable_on_external_context')
          this.memoryConfig.disableOnExternalContext = Boolean(raw.value);
      }
      return {
        status: 'ok',
        version: 'fake-v1',
        filePath: '/fake/config.toml',
        overriddenMetadata: null,
      };
    });
    this.handlers.set('memory/status', () => ({
      v2ConsolidatedThreads: 4,
      v2Ready: true,
    }));
    this.handlers.set('memory/reset', () => {
      this.memoryResetCount += 1;
      return {};
    });
    this.handlers.set('thread/memoryMode/set', (ctx) => {
      this.threadMemoryModes.set(String(ctx.params.threadId), String(ctx.params.mode));
      return {};
    });
    this.handlers.set('project/list', () => ({ data: [] }));
    this.handlers.set('thread/start', (ctx) => {
      const threadId = `thread_${this.received.length}`;
      return {
        thread: makeThread({
          id: threadId,
          cwd: (ctx.params.cwd as string) ?? '/w',
        }),
        model: 'deepseek-v4-flash',
        modelProvider: 'evowork',
        cwd: (ctx.params.cwd as string) ?? '/w',
      };
    });
    this.handlers.set('turn/start', (ctx) => ({
      turn: makeTurn({ id: `turn_${this.received.length}`, status: 'inProgress' }),
      threadId: ctx.params.threadId,
    }));
    /*
     * 内核的 `TurnInterruptParams` 两个字段都没有 `Option`
     * （`app-server-protocol/src/protocol/v2/turn.rs:327-330`），少一个在反序列化阶段
     * 就被打回 -32600。假内核不照做的代价已经付过一次：适配层只传了 `threadId`，
     * 测试照样全绿，而用户那边「停止」从来没成功过。
     */
    this.handlers.set('turn/interrupt', (ctx) => {
      if (typeof ctx.params.threadId !== 'string' || typeof ctx.params.turnId !== 'string') {
        throw new FakeRpcError(
          ERROR_CODE.invalidRequest,
          'Invalid request: missing field `turnId`',
        );
      }
      return {};
    });
    /*
     * 同上：`expectedTurnId` 是必填的活动回合前置条件，而且内核**额外拒绝空串**
     * （`turn_processor.rs:1038`）。这两条都照做，否则漏传一样测不出来。
     */
    this.handlers.set('turn/steer', (ctx) => {
      if (typeof ctx.params.threadId !== 'string' || !Array.isArray(ctx.params.input)) {
        throw new FakeRpcError(ERROR_CODE.invalidRequest, 'Invalid request: bad turn/steer params');
      }
      if (typeof ctx.params.expectedTurnId !== 'string') {
        throw new FakeRpcError(
          ERROR_CODE.invalidRequest,
          'Invalid request: missing field `expectedTurnId`',
        );
      }
      if (ctx.params.expectedTurnId === '') {
        throw new FakeRpcError(ERROR_CODE.invalidRequest, 'expectedTurnId must not be empty');
      }
      return { turnId: ctx.params.expectedTurnId };
    });
    this.handlers.set('thread/resume', (ctx) => ({
      thread: makeThread({ id: String(ctx.params.threadId ?? 'thread_0') }),
    }));
    this.handlers.set('thread/items/list', () => ({ data: [] }));
    this.handlers.set('thread/turns/list', () => ({ data: [], nextCursor: null }));
    this.handlers.set('thread/revert', () => ({}));
    this.handlers.set('thread/read', (ctx) => ({
      thread: makeThread({ id: String(ctx.params.threadId ?? 'thread_0') }),
    }));
    /*
     * `sortKey` / `sortDirection` 是枚举，内核认不出来就整个请求打回 -32600
     * —— 而不是"忽略这个字段"。`ThreadSortKey` 是 **snake_case**
     * （`v2/thread.rs:1506`），和协议里其余的驼峰不一样，正是最容易写错的那种。
     */
    this.handlers.set('thread/list', (ctx) => {
      const sortKey = ctx.params.sortKey;
      if (
        sortKey !== undefined &&
        !['created_at', 'updated_at', 'recency_at', 'section_position'].includes(String(sortKey))
      ) {
        throw new FakeRpcError(
          ERROR_CODE.invalidRequest,
          `Invalid request: unknown variant \`${String(sortKey)}\`, expected one of \`created_at\`, \`updated_at\`, \`recency_at\`, \`section_position\``,
        );
      }
      const dir = ctx.params.sortDirection;
      if (dir !== undefined && !['asc', 'desc'].includes(String(dir))) {
        throw new FakeRpcError(ERROR_CODE.invalidRequest, 'Invalid request: bad sortDirection');
      }
      return { data: [], nextCursor: null };
    });
    this.handlers.set('thread/goal/get', () => ({ goal: null }));
    this.handlers.set('thread/goal/set', (ctx) => ({
      goal: {
        threadId: ctx.params.threadId,
        objective: ctx.params.objective ?? '完成当前任务',
        status: ctx.params.status ?? 'active',
        tokenBudget: ctx.params.tokenBudget ?? null,
        tokensUsed: 0,
        timeUsedSeconds: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    }));
    this.handlers.set('thread/goal/clear', () => ({}));
    /*
     * `thread/name/set` 照抄内核的**两个**行为，因为它们各自都藏过一个缺陷：
     *
     *   ① 空名字回 invalid_request（`thread_processor.rs:1788` 的 `normalize_thread_name`）；
     *   ② 成功后跟一条 `thread/name/updated`，字段是 **`threadName`**
     *      （`v2/thread.rs:1982-1988`），不是 `name`。
     *
     * 第②条是这个假内核最该照抄的一处：我们的路由此前读 `p.name`，读到 undefined
     * 就把标题抹成 null，而假内核当时根本不发这条通知，所以测试全绿。
     */
    this.handlers.set('thread/name/set', (ctx) => {
      const name = String(ctx.params.name ?? '').trim();
      if (name === '') throw new Error('thread name must not be empty');
      // 内核是**先回响应再发通知**（`thread_processor.rs:1799-1817`）。照抄这个顺序：
      // 反过来的话，通知会先于 `setTaskName` 的 resolve 到达，测试就看不出真实时序
      queueMicrotask(() => {
        this.notify('thread/name/updated', {
          threadId: ctx.params.threadId,
          threadName: name,
        });
      });
      return {};
    });
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
          code: err instanceof FakeRpcError ? err.code : ERROR_CODE.internalError,
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
    model: 'deepseek-v4-flash',
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
