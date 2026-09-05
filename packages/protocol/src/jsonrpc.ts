/**
 * JSON-RPC 2.0 over 换行分隔的 JSON（NDJSON）。
 *
 * 帧格式来自内核实测（`app-server-transport/src/transport/stdio.rs`：`BufReader::lines()`）——
 * **一行一条消息**，没有 Content-Length 头。这条事实很重要：它意味着任何消息里的换行都必须
 * 被 JSON 转义（`JSON.stringify` 天然满足），也意味着我们可以按行做背压与重放。
 *
 * 这一层刻意不知道任何 EvoWork 概念，也不知道任何具体方法。它只做四件事：
 *   ① 编解码与 id 分配；
 *   ② 把响应路由回 Promise；
 *   ③ 把通知分发给订阅者；
 *   ④ 把**服务端发起的请求**（F14：审批）分发给处理器，并保证一定回复。
 *
 * 第 ④ 条是这个文件存在的主要理由：审批不是通知，内核发出后会一直等。
 * 忘记回复不会报错，只会让那个任务永远停在那里 —— 所以「没有注册处理器」必须是
 * 一个**显式的错误回复**，而不是静默丢弃。
 */

export const JSONRPC_VERSION = '2.0';

/** 标准 JSON-RPC 错误码。内核用的就是这三个（`app-server/src/error_code.rs`）。 */
export const ERROR_CODE = {
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
} as const;

export type RequestId = string | number;

export interface JsonRpcRequestMessage {
  readonly id: RequestId;
  readonly method: string;
  readonly params?: unknown;
}

export interface JsonRpcNotificationMessage {
  readonly method: string;
  readonly params?: unknown;
}

export interface JsonRpcErrorPayload {
  readonly code: number;
  readonly message: string;
  readonly data?: unknown;
}

export interface JsonRpcResponseMessage {
  readonly id: RequestId;
  readonly result: unknown;
}

export interface JsonRpcErrorMessage {
  readonly id: RequestId;
  readonly error: JsonRpcErrorPayload;
}

export type JsonRpcMessage =
  JsonRpcRequestMessage | JsonRpcNotificationMessage | JsonRpcResponseMessage | JsonRpcErrorMessage;

/** 协议层错误。**不携带 params/result 正文**（Q14：错误上报不得带请求体）。 */
export class JsonRpcCallError extends Error {
  override readonly name = 'JsonRpcCallError';
  constructor(
    readonly method: string,
    readonly code: number,
    /** 内核的错误 message。它可能含正文，因此调用方要用 errorFields() 处理后才可入日志 */
    readonly rpcMessage: string,
    readonly data?: unknown,
  ) {
    super(`${method} 失败（code ${code}）`);
  }

  /** 上游移除了这个方法 —— 09 §3.3 的降级触发条件之一 */
  get isMethodNotFound(): boolean {
    return this.code === ERROR_CODE.methodNotFound;
  }

  /**
   * 我们忘了声明 `capabilities.experimentalApi`（K2）。
   *
   * 这**不是**降级信号而是我们自己的 bug，必须响亮地失败：把它当降级处理会让
   * 「实验方法全部不可用」以静默的方式变成常态。
   */
  get isExperimentalGating(): boolean {
    return (
      this.code === ERROR_CODE.invalidRequest &&
      this.rpcMessage.includes('requires experimentalApi capability')
    );
  }
}

export class TransportClosedError extends Error {
  override readonly name = 'TransportClosedError';
  constructor(readonly reason: string) {
    super(`与执行内核的连接已断开：${reason}`);
  }
}

export interface JsonRpcTransport {
  /** 写一行（实现负责补换行） */
  send(line: string): void;
  /** 关闭底层连接 */
  close?(): void;
}

export type NotificationHandler = (params: unknown, method: string) => void;
/** 服务端请求的处理器。返回值就是 result；抛错会被转成 JSON-RPC error 回复。 */
export type ServerRequestHandler = (params: unknown, method: string) => Promise<unknown> | unknown;

export interface JsonRpcPeerOptions {
  readonly transport: JsonRpcTransport;
  /**
   * 客户端请求的超时。默认 **不超时**。
   *
   * 为什么默认不超时：内核的 `turn/start` 在长任务里可以跑很久，给它设超时会把
   * 「任务还在跑」误判成「连接坏了」。失联判定由心跳负责（09 §5：30s 心跳 + 连续 3 次超时），
   * 那是一条独立且更准的信号。
   */
  readonly requestTimeoutMs?: number;
  /** 收到无法解析的行时调用（R2 雷达：上游改了帧格式也要看得见） */
  readonly onMalformedLine?: (line: string, err: unknown) => void;
  /** 收到没有处理器的通知时调用（09 §3.4 的 `unknown_event` 表） */
  readonly onUnhandledNotification?: (method: string, params: unknown) => void;
}

/**
 * 一端 JSON-RPC。既能发请求也能收请求（双向），因为 app-server 就是双向的（F14）。
 */
export class JsonRpcPeer {
  #nextId = 1;
  #pending = new Map<
    RequestId,
    {
      method: string;
      resolve: (value: unknown) => void;
      reject: (err: unknown) => void;
      timer?: ReturnType<typeof setTimeout>;
    }
  >();
  #notificationHandlers = new Map<string, Set<NotificationHandler>>();
  #requestHandlers = new Map<string, ServerRequestHandler>();
  #closed = false;
  #transport: JsonRpcTransport;

  constructor(private readonly options: JsonRpcPeerOptions) {
    this.#transport = options.transport;
  }

  /**
   * 换底层连接，**保留全部订阅与请求处理器**。
   *
   * 这是内核崩溃重启时用的（09 §1）：进程换了，但审批处理器不能跟着换 ——
   * 重建 peer 会丢掉 `onRequest`，于是重启后的第一个审批请求没人接，
   * 而"没人接"的表现是那个任务静静地停在那里（F14：内核会一直等）。
   */
  setTransport(transport: JsonRpcTransport): void {
    this.#transport = transport;
    this.#closed = false;
  }

  get pendingCount(): number {
    return this.#pending.size;
  }

  request<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (this.#closed) {
      return Promise.reject(new TransportClosedError('peer 已关闭'));
    }
    const id = this.#nextId++;
    const message: JsonRpcRequestMessage & { jsonrpc: string } = {
      jsonrpc: JSONRPC_VERSION,
      id,
      method,
      ...(params === undefined ? {} : { params }),
    };

    return new Promise<T>((resolve, reject) => {
      const timeoutMs = this.options.requestTimeoutMs;
      const entry = {
        method,
        resolve: resolve as (value: unknown) => void,
        reject,
        ...(timeoutMs
          ? {
              timer: setTimeout(() => {
                this.#pending.delete(id);
                reject(
                  new JsonRpcCallError(method, ERROR_CODE.internalError, `请求超时 ${timeoutMs}ms`),
                );
              }, timeoutMs),
            }
          : {}),
      };
      this.#pending.set(id, entry);
      try {
        this.#transport.send(JSON.stringify(message));
      } catch (err) {
        this.#pending.delete(id);
        if (entry.timer) clearTimeout(entry.timer);
        reject(err);
      }
    });
  }

  notify(method: string, params?: unknown): void {
    if (this.#closed) throw new TransportClosedError('peer 已关闭');
    this.#transport.send(
      JSON.stringify({
        jsonrpc: JSONRPC_VERSION,
        method,
        ...(params === undefined ? {} : { params }),
      }),
    );
  }

  /** 订阅通知。返回取消订阅函数。 */
  onNotification(method: string, handler: NotificationHandler): () => void {
    const set = this.#notificationHandlers.get(method) ?? new Set<NotificationHandler>();
    set.add(handler);
    this.#notificationHandlers.set(method, set);
    return () => {
      set.delete(handler);
    };
  }

  /**
   * 注册服务端请求的处理器（F14）。同一方法只能有一个 —— 审批必须有唯一归属，
   * 两个处理器同时回复会让内核收到两个 response 而其中一个被当成协议错误。
   */
  onRequest(method: string, handler: ServerRequestHandler): () => void {
    if (this.#requestHandlers.has(method)) {
      throw new Error(`${method} 已有处理器：服务端请求必须有唯一归属（F14）`);
    }
    this.#requestHandlers.set(method, handler);
    return () => {
      this.#requestHandlers.delete(method);
    };
  }

  /** 喂一行原始文本。由 transport 侧调用。 */
  handleLine(line: string): void {
    const trimmed = line.trim();
    if (trimmed.length === 0) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (err) {
      this.options.onMalformedLine?.(trimmed, err);
      return;
    }
    this.handleMessage(parsed);
  }

  handleMessage(message: unknown): void {
    if (typeof message !== 'object' || message === null) {
      this.options.onMalformedLine?.(String(message), new Error('不是对象'));
      return;
    }
    const m = message as Record<string, unknown>;

    // 响应（成功或失败）
    if ('id' in m && ('result' in m || 'error' in m) && !('method' in m)) {
      const id = m.id as RequestId;
      const entry = this.#pending.get(id);
      if (!entry) return; // 迟到的响应（重启前发出的），丢弃即可
      this.#pending.delete(id);
      if (entry.timer) clearTimeout(entry.timer);
      if ('error' in m) {
        const err = m.error as JsonRpcErrorPayload;
        entry.reject(
          new JsonRpcCallError(
            entry.method,
            err?.code ?? ERROR_CODE.internalError,
            err?.message ?? '',
            err?.data,
          ),
        );
      } else {
        entry.resolve(m.result);
      }
      return;
    }

    // 服务端请求：**必须回复**
    if ('id' in m && 'method' in m) {
      void this.#dispatchServerRequest(m.id as RequestId, String(m.method), m.params);
      return;
    }

    // 通知
    if ('method' in m) {
      const method = String(m.method);
      const handlers = this.#notificationHandlers.get(method);
      if (!handlers || handlers.size === 0) {
        this.options.onUnhandledNotification?.(method, m.params);
        return;
      }
      for (const handler of handlers) {
        try {
          handler(m.params, method);
        } catch (err) {
          // 一个订阅者抛错不该影响其他订阅者，也不该杀掉事件循环
          this.options.onMalformedLine?.(method, err);
        }
      }
      return;
    }

    this.options.onMalformedLine?.(JSON.stringify(m), new Error('既不是请求也不是响应'));
  }

  async #dispatchServerRequest(id: RequestId, method: string, params: unknown): Promise<void> {
    const handler = this.#requestHandlers.get(method);
    if (!handler) {
      // 没有处理器 → 显式错误回复。静默丢弃会让内核永远等下去（F14）。
      this.#respondError(
        id,
        ERROR_CODE.methodNotFound,
        `客户端没有 ${method} 的处理器：审批是 server→client request，必须回复（F14）`,
      );
      return;
    }
    try {
      const result = await handler(params, method);
      this.#respondResult(id, result ?? {});
    } catch (err) {
      this.#respondError(
        id,
        ERROR_CODE.internalError,
        // 只回类名，不回 message：内核会把它记进 rollout，而 message 可能含正文（Q14）
        `处理 ${method} 时出错：${err instanceof Error ? err.name : 'UnknownError'}`,
      );
    }
  }

  #respondResult(id: RequestId, result: unknown): void {
    this.#transport.send(JSON.stringify({ jsonrpc: JSONRPC_VERSION, id, result }));
  }

  #respondError(id: RequestId, code: number, message: string): void {
    this.#transport.send(
      JSON.stringify({ jsonrpc: JSONRPC_VERSION, id, error: { code, message } }),
    );
  }

  /**
   * 断开：把所有 in-flight 请求拒掉。
   *
   * 不这么做的后果是 UI 上的按钮永远转圈 —— 09 §5 要求断连**显式**提示，
   * 而"显式"的前提是等待中的调用会有一个结论。
   */
  close(reason = '正常关闭'): void {
    this.#closed = true;
    const err = new TransportClosedError(reason);
    for (const [, entry] of this.#pending) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.reject(err);
    }
    this.#pending.clear();
    this.#transport.close?.();
  }

  /** 重连后复用同一个 peer 时调用：清掉旧的 in-flight，但保留订阅。 */
  resetPending(reason: string): void {
    const err = new TransportClosedError(reason);
    for (const [, entry] of this.#pending) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.reject(err);
    }
    this.#pending.clear();
    this.#closed = false;
  }
}

/**
 * NDJSON 拆行器。
 *
 * 单独一个类是因为 stdout 的 chunk 边界与消息边界无关：一条 200KB 的 diff 通知会被拆成
 * 十几个 chunk，而一个 chunk 里也可能有三条消息加半条。把这件事和 peer 分开，
 * 让「帧」这一层可以被独立测试（也可以被换成 WebSocket 而不动 peer）。
 */
export class LineFramer {
  #buffer = '';

  constructor(
    private readonly onLine: (line: string) => void,
    /** 单行上限，防御性。超限时丢弃该行并报告 —— 内核不会发这么大的单条消息 */
    private readonly maxLineBytes = 64 * 1024 * 1024,
    private readonly onOverflow?: (bytes: number) => void,
  ) {}

  push(chunk: string): void {
    this.#buffer += chunk;
    if (this.#buffer.length > this.maxLineBytes) {
      this.onOverflow?.(this.#buffer.length);
      this.#buffer = '';
      return;
    }
    let idx = this.#buffer.indexOf('\n');
    while (idx >= 0) {
      const line = this.#buffer.slice(0, idx);
      this.#buffer = this.#buffer.slice(idx + 1);
      this.onLine(line);
      idx = this.#buffer.indexOf('\n');
    }
  }

  /** 连接结束时把残留的半行交出去（内核正常退出时不会有残留） */
  flush(): void {
    const rest = this.#buffer;
    this.#buffer = '';
    if (rest.trim().length > 0) this.onLine(rest);
  }
}
