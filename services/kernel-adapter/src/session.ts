/**
 * 内核会话：进程生命周期 · 握手 · 心跳 · 崩溃退避重启 · 会话恢复（09 §1 / §5）。
 *
 * 三条文档明写的行为，这里逐条落实：
 *
 * 1. **退避重启**：1s / 2s / 4s…上限 30s（09 §1）。
 * 2. **重启后恢复**：对所有打开的 thread 做 `thread/resume` + `thread/items/list` 补齐。
 * 3. **不静默重启**：UI 顶部显示一次「执行内核已重启，会话已恢复」——
 *    用户需要知道刚才那个中断的任务发生了什么（09 §1 原话）。
 *
 * 进程启动被抽象成 `KernelLauncher`，理由不是"为了可测试"这种泛泛之词，而是具体的：
 * 崩溃恢复与会话补齐是**治理路径上最容易变成死代码**的一段（本项目在 Sandbox::spawn
 * 与 Tauri capabilities 上都栽过同一类），只有能在测试里随时杀掉内核，这段代码才会被真正走到。
 */
import {
  JsonRpcPeer,
  LineFramer,
  METHOD,
  TransportClosedError,
  type ClientInfo,
  type InitializeResponse,
  type JsonRpcTransport,
} from '@evowork/protocol';
import { errorFields, type Logger } from '@evowork/logging';

/** 一个已启动的内核进程。 */
export interface KernelProcess {
  /** 往 stdin 写一行（实现负责补换行） */
  writeLine(line: string): void;
  /** 订阅 stdout 的原始 chunk */
  onStdout(handler: (chunk: string) => void): void;
  /** 进程退出（正常或崩溃） */
  onExit(handler: (info: { code: number | null; signal: string | null }) => void): void;
  kill(): void;
}

export interface KernelLauncher {
  launch(): Promise<KernelProcess> | KernelProcess;
}

export type SessionPhase =
  | 'stopped'
  | 'starting'
  | 'ready'
  /** 崩溃后等待退避 */
  | 'restarting'
  /** 连续重启失败，停止尝试 */
  | 'failed';

export interface SessionNotice {
  readonly kind: 'kernel-restarted' | 'kernel-lost' | 'kernel-failed';
  readonly text: string;
  /** 恢复了几个会话（kernel-restarted 时有值） */
  readonly recoveredThreads?: number;
}

export interface KernelSessionOptions {
  readonly launcher: KernelLauncher;
  readonly clientInfo: ClientInfo;
  readonly logger?: Logger;
  /** 心跳间隔，默认 30s（09 §5） */
  readonly heartbeatIntervalMs?: number;
  /** 单次心跳超时，默认 10s；连续 3 次超时判定失联（09 §5） */
  readonly heartbeatTimeoutMs?: number;
  readonly maxHeartbeatMisses?: number;
  /** 退避序列上限，默认 30s（09 §1） */
  readonly maxBackoffMs?: number;
  /** 连续重启失败多少次后放弃，默认 6（约覆盖 1+2+4+8+16+30 秒） */
  readonly maxRestartAttempts?: number;
  /** 定时器注入，便于测试用假时钟 */
  readonly setTimeoutFn?: typeof setTimeout;
  readonly clearTimeoutFn?: typeof clearTimeout;
  /** 恢复钩子：重启后需要补齐哪些 thread 由调用方（adapter）决定 */
  readonly recover?: (peer: JsonRpcPeer) => Promise<number>;
  readonly onNotice?: (notice: SessionNotice) => void;
  readonly onPhaseChange?: (phase: SessionPhase) => void;
  readonly onMalformedLine?: (line: string) => void;
  readonly onUnhandledNotification?: (method: string, params: unknown) => void;
}

export class KernelSession {
  #peer: JsonRpcPeer | undefined;
  #process: KernelProcess | undefined;
  #phase: SessionPhase = 'stopped';
  #restartAttempt = 0;
  #heartbeatTimer: ReturnType<typeof setTimeout> | undefined;
  #heartbeatMisses = 0;
  #stopping = false;
  #initializeResult: InitializeResponse | undefined;
  /** 打开中的 thread（重启后要补齐它们）。由 adapter 维护。 */
  readonly openThreads = new Set<string>();

  constructor(private readonly options: KernelSessionOptions) {}

  get phase(): SessionPhase {
    return this.#phase;
  }

  get peer(): JsonRpcPeer {
    if (!this.#peer) throw new TransportClosedError('内核尚未启动');
    return this.#peer;
  }

  get initializeResult(): InitializeResponse | undefined {
    return this.#initializeResult;
  }

  /** 订阅通知。**在重启后依然有效** —— peer 被复用，订阅不重建。 */
  onNotification(method: string, handler: (params: unknown, method: string) => void): () => void {
    this.#ensurePeer();
    return this.peer.onNotification(method, handler);
  }

  onRequest(
    method: string,
    handler: (params: unknown, method: string) => Promise<unknown> | unknown,
  ): () => void {
    this.#ensurePeer();
    return this.peer.onRequest(method, handler);
  }

  async start(): Promise<void> {
    this.#stopping = false;
    await this.#launchAndHandshake();
  }

  async stop(): Promise<void> {
    this.#stopping = true;
    this.#stopHeartbeat();
    this.#peer?.close('正常关闭');
    this.#process?.kill();
    this.#setPhase('stopped');
  }

  /**
   * 握手序列（09 §3.2 的第 1–4 步）。
   *
   * 第 4 步的方法名是 **`initialized`**，不是 `notifications/initialized` ——
   * 09 §3.2 写错了，已按实测（`app-server-test-client/src/lib.rs:1773`）回写文档（F17）。
   */
  async #launchAndHandshake(): Promise<void> {
    this.#setPhase('starting');
    const proc = await this.options.launcher.launch();
    this.#process = proc;

    const transport: JsonRpcTransport = {
      send: (line) => proc.writeLine(line),
      close: () => proc.kill(),
    };

    // 复用 peer：订阅（含审批处理器）不重建，只把新进程的 transport 装上去。
    // 重建 peer 会丢掉 onRequest，于是重启后的第一个审批请求没人接（F14：内核会一直等）。
    this.#ensurePeer();
    const peer = this.peer;
    peer.resetPending('内核重启');
    peer.setTransport(transport);

    const framer = new LineFramer((line) => peer.handleLine(line));
    proc.onStdout((chunk) => framer.push(chunk));
    proc.onExit((info) => this.#handleExit(info));

    this.#initializeResult = await peer.request<InitializeResponse>(METHOD.initialize, {
      clientInfo: this.options.clientInfo,
      // K2：不声明它，所有实验方法都会被拒
      capabilities: { experimentalApi: true },
    });
    peer.notify(METHOD.initialized);

    this.#restartAttempt = 0;
    this.#heartbeatMisses = 0;
    this.#setPhase('ready');
    this.#startHeartbeat();
  }

  #ensurePeer(): void {
    if (!this.#peer) {
      // 允许在 start() 之前注册订阅：审批处理器必须在内核发出第一个请求之前就位，
      // 而"先 start 再注册"存在一个窗口期。
      this.#peer = new JsonRpcPeer({
        transport: {
          send: () => {
            throw new TransportClosedError('内核尚未启动');
          },
        },
        ...(this.options.onMalformedLine
          ? { onMalformedLine: (line: string) => this.options.onMalformedLine?.(line) }
          : {}),
        ...(this.options.onUnhandledNotification
          ? {
              onUnhandledNotification: (m: string, p: unknown) =>
                this.options.onUnhandledNotification?.(m, p),
            }
          : {}),
      });
    }
  }

  #handleExit(info: { code: number | null; signal: string | null }): void {
    this.#stopHeartbeat();
    if (this.#stopping) return;

    this.options.logger?.warn('adapter.kernel.exited', {
      exitCode: info.code ?? undefined,
      reason: info.signal ? 'SIGNAL' : 'EXIT',
    });
    // 把 in-flight 请求拒掉：否则 UI 上的按钮永远转圈
    this.#peer?.resetPending('内核退出');
    void this.#scheduleRestart();
  }

  async #scheduleRestart(): Promise<void> {
    if (this.#stopping) return;
    const maxAttempts = this.options.maxRestartAttempts ?? 6;
    if (this.#restartAttempt >= maxAttempts) {
      this.#setPhase('failed');
      this.options.onNotice?.({
        kind: 'kernel-failed',
        text: `执行内核连续 ${maxAttempts} 次启动失败，已停止重试。任务无法执行，请查看日志或重启应用。`,
      });
      return;
    }

    // 1s / 2s / 4s … 上限 30s（09 §1）
    const backoff = Math.min(1000 * 2 ** this.#restartAttempt, this.options.maxBackoffMs ?? 30_000);
    this.#restartAttempt += 1;
    this.#setPhase('restarting');

    await new Promise<void>((resolve) => {
      (this.options.setTimeoutFn ?? setTimeout)(resolve, backoff);
    });
    if (this.#stopping) return;

    try {
      await this.#launchAndHandshake();
      const recovered = (await this.options.recover?.(this.peer)) ?? 0;
      // **不静默重启**（09 §1）：用户需要知道刚才那个中断的任务发生了什么
      this.options.onNotice?.({
        kind: 'kernel-restarted',
        text:
          recovered > 0
            ? `执行内核已重启，${recovered} 个会话已恢复。中断处的进度可能需要你重新确认。`
            : '执行内核已重启。',
        recoveredThreads: recovered,
      });
      this.options.logger?.info('adapter.kernel.restarted', { itemCount: recovered });
    } catch (err) {
      this.options.logger?.error('adapter.kernel.restart_failed', errorFields(err));
      void this.#scheduleRestart();
    }
  }

  // ─────────────────────────── 心跳（09 §5） ───────────────────────────

  /**
   * 心跳用 `permissionProfile/list`。
   *
   * 选它的理由：稳定方法（不是实验方法，不会因为降级而失效）、返回小（内置 3 档 + 自定义）、
   * 且**无副作用**。`experimentalFeature/list` 返回 141 项，拿它当心跳是浪费；
   * `server/diagnostics` 是实验方法，心跳不该依赖可能被降级的东西。
   */
  #startHeartbeat(): void {
    const interval = this.options.heartbeatIntervalMs ?? 30_000;
    const tick = async (): Promise<void> => {
      if (this.#phase !== 'ready' || this.#stopping) return;
      const timeout = this.options.heartbeatTimeoutMs ?? 10_000;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        // `Promise.race` 的输家仍然会 settle。心跳请求在超时后往往会以
        // TransportClosedError 结束，若不挂一个空 catch，它就是一条**未处理的拒绝** ——
        // 在 Electron 主进程里那会打出一片噪音，最坏情况下（Node 的默认策略）直接杀进程。
        const probe = this.peer
          .request(METHOD.permissionProfileList, {})
          .catch((err: unknown) => Promise.reject(err));
        probe.catch(() => undefined);
        await Promise.race([
          probe,
          new Promise((_, reject) => {
            timer = (this.options.setTimeoutFn ?? setTimeout)(
              () => reject(new Error('heartbeat timeout')),
              timeout,
            );
          }),
        ]);
        this.#heartbeatMisses = 0;
      } catch {
        this.#heartbeatMisses += 1;
        const max = this.options.maxHeartbeatMisses ?? 3;
        this.options.logger?.warn('adapter.kernel.heartbeat_miss', {
          retryCount: this.#heartbeatMisses,
        });
        if (this.#heartbeatMisses >= max) {
          // stdio 管道阻塞：进程还活着但不回应。按崩溃路径处理（09 §5 第二行）
          this.options.onNotice?.({
            kind: 'kernel-lost',
            text: '与执行内核的连接中断，正在重连…',
          });
          this.#heartbeatMisses = 0;
          this.#process?.kill();
          return;
        }
      } finally {
        if (timer) (this.options.clearTimeoutFn ?? clearTimeout)(timer);
      }
      this.#heartbeatTimer = (this.options.setTimeoutFn ?? setTimeout)(() => void tick(), interval);
    };
    this.#heartbeatTimer = (this.options.setTimeoutFn ?? setTimeout)(() => void tick(), interval);
  }

  #stopHeartbeat(): void {
    if (this.#heartbeatTimer) {
      (this.options.clearTimeoutFn ?? clearTimeout)(this.#heartbeatTimer);
      this.#heartbeatTimer = undefined;
    }
  }

  #setPhase(phase: SessionPhase): void {
    if (this.#phase === phase) return;
    this.#phase = phase;
    this.options.onPhaseChange?.(phase);
  }
}
