/**
 * 本机服务宿主（09 §1）。
 *
 * Q1=A 之后所有东西都在用户机器上，而进程边界按**崩溃域隔离**划：
 *
 * ```
 * ┌─ evowork-desktop（Electron 主进程）───────────────────────────┐
 * │  · 窗口与渲染进程（UI，L4）                                   │
 * │  · 本机服务宿主（L3，同进程内的模块，**不再拆进程**）           │
 * │      scheduler · ingest · artifacts · policy · index         │
 * └───────┬──────────────────────────────────────────────────────┘
 *         │ stdio JSON-RPC v2
 * ┌───────▼──────────────┐
 * │ codex-app-server     │（内核，L1，常驻 1 个）
 * └──────────────────────┘
 * ```
 *
 * **五个本机服务不拆进程**（09 §1 的决策）：它们加起来的状态就是一个 sqlite 加几个 watcher，
 * 拆进程要多付 IPC、崩溃恢复、双向同步三份复杂度，收益为零。
 *
 * 这个文件本身**不 import electron**：Electron 的 `app` / `BrowserWindow` 由
 * `bootstrap.ts` 注入。这样宿主的接线逻辑能在测试里跑，而不必起一个 Electron ——
 * 否则"启动顺序对不对""崩溃后有没有恢复"这类问题只能靠手点。
 */
import type { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import {
  createAdapter,
  createSpawnLauncher,
  type Adapter,
  type SessionNotice,
  type UiEvent,
} from '@evowork/kernel-adapter';
import { createLogger, jsonLinesSink, type Logger } from '@evowork/logging';
import { openStore, type Store } from '@evowork/store';

import { createLocalServices, type LocalServices } from './local-services.js';

/** `~/.evowork/` 的布局（09 §7）。 */
export interface EvoworkPaths {
  readonly home: string;
  readonly db: string;
  readonly config: string;
  readonly requirements: string;
  readonly modes: string;
  readonly scenarios: string;
  readonly logs: string;
  /**
   * 内核的家目录（`~/.evowork/kernel/`）。
   *
   * 宿主只知道"内核的家在这儿"，**不知道那个环境变量叫什么** ——
   * 那是适配层的知识（见 `createSpawnLauncher` 的头注释：这条边界是被 lint 规则纠正出来的）。
   */
  readonly kernelHome: string;
}

export function resolvePaths(root = join(homedir(), '.evowork')): EvoworkPaths {
  return {
    home: root,
    db: join(root, 'evowork.db'),
    config: join(root, 'config.toml'),
    requirements: join(root, 'requirements.toml'),
    modes: join(root, 'modes'),
    scenarios: join(root, 'scenarios'),
    logs: join(root, 'logs'),
    kernelHome: join(root, 'kernel'),
  };
}

export interface ServiceHostOptions {
  readonly paths: EvoworkPaths;
  /** app-server 可执行文件路径。M9 打包时随内核二进制一起分发 */
  readonly appServerPath: string;
  readonly appVersion: string;
  readonly logger?: Logger;
  /** 把 UI 事件推给渲染进程（Electron 里是 `webContents.send`） */
  readonly emitToRenderer: (channel: string, payload: unknown) => void;
  /** 向渲染进程发起请求并等回复（审批要用：F14 的可回复处理器最终落在 UI 上） */
  readonly askRenderer: (channel: string, payload: unknown) => Promise<unknown>;
  /** 注入 spawn，便于测试（见文件头：宿主的接线逻辑必须能被测） */
  readonly spawnFn?: typeof spawn;
}

export interface ServiceHost {
  readonly store: Store;
  readonly adapter: Adapter;
  readonly logger: Logger;
  /** 五个本机服务之间的接线（scheduler / 产物索引 / 解析运行时探测） */
  readonly services: LocalServices;
  start(): Promise<void>;
  stop(): Promise<void>;
  /** 对账定时器（09 §4.1：启动时 + 每 10 分钟一次） */
  readonly reconcileIntervalMs: number;
}

/** IPC 频道名。渲染进程只认这几个，不认协议方法名（K2）。 */
export const IPC = {
  uiEvent: 'evowork:ui-event',
  notice: 'evowork:notice',
  degrade: 'evowork:degrade',
  pendingApprovals: 'evowork:pending-approvals',
  askApproval: 'evowork:ask-approval',
} as const;

const RECONCILE_INTERVAL_MS = 10 * 60_000;

/**
 * 启动本机服务宿主。
 *
 * 顺序是刻意的：**先开库、再起内核**。库开不了（权威表迁移失败）时要中止启动
 * （09 §4.6：宁可启动失败也不丢定时任务定义），此时不该已经起了一个内核进程在那儿等着。
 */
export function createServiceHost(options: ServiceHostOptions): ServiceHost {
  const logger =
    options.logger ??
    createLogger({
      service: 'desktop',
      // 生产用 drop：日志不该让业务失败
      onViolation: 'drop',
      sink: jsonLinesSink((line) => process.stdout.write(`${line}\n`)),
      base: { appVersion: options.appVersion, platform: process.platform },
    });

  // ① 先开库。migrateAuthoritative 失败会抛错，启动就此中止（这是设计要求）
  const store = openStore({ path: options.paths.db, logger });

  const readInstructions = (file: string): string | undefined => {
    // `config/modes/*.md` 随产品分发（取代原 P3 补丁，F1）
    const path = join(options.paths.home, file);
    return existsSync(path) ? readFileSync(path, 'utf8') : undefined;
  };

  const adapter = createAdapter({
    store,
    logger,
    readInstructions,
    sessionOptions: {
      clientInfo: { name: 'evowork-desktop', version: options.appVersion },
      logger,
      // 具体怎么起内核（可执行文件、环境变量、stdio 帧）全在适配层里 ——
      // 宿主只传路径。下一个需要起内核的地方（EvoWork CLI，Q13）复用同一个 launcher
      launcher: createSpawnLauncher({
        appServerPath: options.appServerPath,
        kernelHome: options.paths.kernelHome,
        ...(options.spawnFn ? { spawnFn: options.spawnFn } : {}),
      }),
    },
    onUiEvent: (event: UiEvent) => options.emitToRenderer(IPC.uiEvent, event),
    onNotice: (notice: SessionNotice) => options.emitToRenderer(IPC.notice, notice),
    // 降级一律显式（09 §3.3）：推给 UI，让它在设置里列出"当前不可用的能力"
    onDegrade: (report) => options.emitToRenderer(IPC.degrade, report),
    onPendingApprovalsChanged: (pending) => options.emitToRenderer(IPC.pendingApprovals, pending),
    // 审批最终落在用户身上（F14）。渲染进程不回复时这个 Promise 就一直悬着 ——
    // 那是正确的：交互式任务**不自动拒绝**（10 §3.6），超时策略在适配层里
    askApproval: async (approval) => {
      const reply = await options.askRenderer(IPC.askApproval, approval);
      return reply as { decision: 'accept' | 'acceptForSession' | 'decline' | 'cancel' };
    },
    onSideEffect: (effect) => {
      // 副作用的落点：通知中心、并发计数、预算闸门、产物识别、automation_run。
      logger.debug('desktop.side_effect', { reason: effect.kind.toUpperCase().replace(/-/g, '_') });
      routeSideEffect(effect);
    },
  });

  /**
   * 事件流的副作用 → 本机服务。
   *
   * 适配层刻意把副作用做成**数据**（`SideEffect[]`）而不是回调，这样"先落库、再推 UI、
   * 最后做副作用"的顺序是结构性的（09 §3.4）。这里是那些副作用真正被执行的地方。
   */
  function routeSideEffect(effect: {
    readonly kind: string;
    readonly threadId?: string;
    readonly status?: string;
    readonly item?: unknown;
  }): void {
    if (effect.kind === 'automation-run-finished' && effect.threadId) {
      // 定时任务的回合结束了 → 失败分类 → 连败计数 → 可能自动暂停（Q8 / 07 §8-2）
      services.onTurnFinished({
        threadId: effect.threadId,
        ok: effect.status === 'completed',
      });
      return;
    }
    if (effect.kind === 'artifact-scan' && effect.threadId) {
      // 信号 ②：`FileChange` item。真正的识别在 watcher 里，这里只保证那个目录被盯着
      const cwd = store.threads.get(effect.threadId)?.cwd;
      if (cwd) services.watchWorkspace(cwd, effect.threadId);
    }
  }

  const services = createLocalServices({
    store,
    adapter,
    notify: (text) => options.emitToRenderer(IPC.notice, { kind: 'automation', text }),
    logger,
  });

  let reconcileTimer: ReturnType<typeof setInterval> | undefined;

  return {
    store,
    adapter,
    logger,
    services,
    reconcileIntervalMs: RECONCILE_INTERVAL_MS,

    async start() {
      const catalog = await adapter.start();
      logger.info('desktop.host.started', {
        itemCount: catalog.permissionProfiles.length,
        concurrency: catalog.scenarios.length,
      });

      // 09 §4.1 的一致性校正：启动时一次 + 每 10 分钟一次
      await adapter.reconcile().catch((err: unknown) => {
        // 对账失败不该阻塞启动：投影表可以晚一点补齐（它是投影类，真源在内核）
        logger.warn('desktop.reconcile.failed', {
          errorClass: err instanceof Error ? err.name : 'UnknownError',
        });
      });
      reconcileTimer = setInterval(() => {
        void adapter.reconcile().catch(() => undefined);
      }, RECONCILE_INTERVAL_MS);

      /*
       * 定时调度最后启动，且**不阻塞 start()**。
       *
       * 它启动时会做一次 misfire 扫描并可能立刻补跑几个任务（D5）——
       * 那件事可能很慢（要起 thread、调模型），而用户此刻正等着窗口出来。
       * 补跑失败也不该让应用起不来：那是任务的问题，不是应用的问题。
       */
      void services.startScheduler().catch((err: unknown) => {
        logger.warn('desktop.scheduler.start_failed', {
          errorClass: err instanceof Error ? err.name : 'UnknownError',
        });
      });
    },

    async stop() {
      if (reconcileTimer) clearInterval(reconcileTimer);
      services.stop();
      await adapter.stop();
      store.close();
      logger.info('desktop.host.stopped', {});
    },
  };
}
