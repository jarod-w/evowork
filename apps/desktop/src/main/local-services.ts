/**
 * 把五个本机服务接到一起（09 §1）。
 *
 * `service-host.ts` 负责"起内核、推事件给 UI"；这个文件负责**它们之间的接线**：
 *
 * ```
 * scheduler ──startRun──▶ kernel-adapter ──创建 thread──▶ 内核
 *     ▲                        │
 *     └──onTurnFinished────────┘        （失败分类 → 连败计数 → 自动暂停）
 *
 * 文件变化 ──▶ artifact watcher ──▶ 产物索引 ──▶ 结果区
 * 技能上报 ──┘                          （信号 ① 带类型，扩展名推不出来）
 * ```
 *
 * ## 为什么单独一个文件
 *
 * 这些接线**没有一行是协议**，全是"谁调谁"。混进 `service-host.ts` 会让那个文件
 * 同时承担"起进程"与"编排"两件事，而它们的失败方式完全不同：
 * 起进程失败要中止启动，编排出错只该让某一个功能不可用。
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, normalize, relative, resolve } from 'node:path';

import {
  createArtifactWatcher,
  createPollingFileSystem,
  taskTitleFromArtifact,
  type ArtifactRecord,
  type IndexPort,
} from '@evowork/artifacts';
import type { Adapter } from '@evowork/kernel-adapter';
import type { Logger } from '@evowork/logging';
import { createRuntimeProbe } from '@evowork/ingest';
import { RUNTIME_TIERS } from '@evowork/ingest/runtime.js';
import {
  installOfficeRuntime,
  PHASE_LABEL,
  totalDownloadBytes,
  TRIPLE_BY_PLATFORM,
} from '@evowork/runtime-installer';
import { createKernelBridge, createScheduler, type AutomationDefinition } from '@evowork/scheduler';
import {
  canOverrideTitle,
  createArtifactRepo,
  createAutomationRepo,
  type ArtifactRow,
  type Store,
} from '@evowork/store';

import type {
  RuntimeInstallResultView,
  RuntimeProgressView,
  RuntimeStatusView,
} from '../shared/ipc.js';

export interface LocalServicesOptions {
  readonly store: Store;
  readonly adapter: Adapter;
  readonly notify: (text: string) => void;
  readonly logger?: Logger | undefined;
  /**
   * 办公扩展安装进度往哪儿推（08 §4）。宿主把它接到 `runtimeProgress` 频道上。
   *
   * 与 `notify` 分开：notice 是一条会消失的提示，而安装进度要在**同一个位置**
   * 连续更新几分钟。混用的话界面上会堆出几十条"正在下载 3%…4%…"。
   */
  readonly onRuntimeProgress?: ((progress: RuntimeProgressView) => void) | undefined;
  /** 产物真正入库后通知宿主刷新该任务的结果区。 */
  readonly onArtifactChanged?: ((threadId: string) => void) | undefined;
  readonly now?: (() => number) | undefined;
}

/** 产物索引的 `IndexPort` 由 store 的 repo 实现 —— 两边的形状本来就一样。 */
function toIndexPort(repo: ReturnType<typeof createArtifactRepo>): IndexPort {
  return {
    latestFor: (path) => repo.latestFor(path) as ArtifactRecord | undefined,
    insert: (record) => repo.insert(record as unknown as ArtifactRow),
    update: (record) => repo.update(record as unknown as ArtifactRow),
    listPresent: (root) => repo.listPresent(root) as unknown as readonly ArtifactRecord[],
    setFileState: (id, state, path) => repo.setFileState(id, state, path),
  };
}

/**
 * 真实文件系统的读取。
 *
 * 内容哈希用**前 64KB + 大小**而不是整文件：产物动辄几十 MB，
 * 而这里要回答的问题只是"它变了没有""它是不是被挪走的那一个"。
 * 整文件哈希在一次对账里会读掉几百 MB。
 */
const HASH_PREFIX_BYTES = 64 * 1024;

function hashFile(path: string): { sizeBytes: number; contentHash: string } | undefined {
  try {
    const stat = statSync(path);
    if (!stat.isFile()) return undefined;
    const buffer = readFileSync(path);
    const head = buffer.subarray(0, HASH_PREFIX_BYTES);
    const hash = createHash('sha256').update(head).update(String(stat.size)).digest('hex');
    return { sizeBytes: stat.size, contentHash: hash.slice(0, 32) };
  } catch {
    return undefined;
  }
}

function listFilesRecursively(root: string, depth = 0): string[] {
  if (depth > 8 || !existsSync(root)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      // 深目录（node_modules 之类）由 `isIgnored` 在上层过滤，这里先别递归进去
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      out.push(...listFilesRecursively(full, depth + 1));
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
  return out;
}

export function createLocalServices(options: LocalServicesOptions) {
  const now = options.now ?? (() => Date.now());
  const automations = createAutomationRepo(options.store.db);
  const artifacts = createArtifactRepo(options.store.db);
  const probe = createRuntimeProbe();

  /* ── scheduler ↔ 内核 ───────────────────────────────────────── */

  const bridge = createKernelBridge({
    runner: options.adapter,
    store: {
      insertRun: (record) => automations.insertRun(record),
      finishRun: (input) => automations.finishRun(input),
      updateAutomation: (id, patch) => automations.updateAutomation(id, patch),
      listActive: (deviceId) => automations.listActive(deviceId) as readonly AutomationDefinition[],
      get: (id) => automations.get(id) as AutomationDefinition | undefined,
    },
    deviceId: options.store.deviceId,
    notify: options.notify,
    now,
    workspaceExists: (path) => existsSync(path),
    ...(options.logger ? { logger: options.logger } : {}),
  });

  const scheduler = createScheduler(bridge.ports);
  let tick: ReturnType<typeof setInterval> | undefined;

  /* ── 文件变化 ↔ 产物索引 ─────────────────────────────────────── */

  const index = toIndexPort(artifacts);
  const fs = createPollingFileSystem({
    listFiles: (root) => listFilesRecursively(root).map((path) => path),
    stat: hashFile,
  });

  const watchers = new Map<string, ReturnType<typeof createArtifactWatcher>>();
  const workspaceThreads = new Map<string, string>();
  /** 最近一次 turn 的任务。桌面等 cwd 之外的上报 JSONL 里没有 threadId，靠这个认领。 */
  let lastActiveThreadId: string | undefined;
  let artifactSeq = 0;
  let artifactReportLog: string | undefined;
  let artifactReportOffset = 0;
  let artifactReportTimer: ReturnType<typeof setInterval> | undefined;

  function canonicalPath(path: string): string {
    return normalize(resolve(path));
  }

  function watchWorkspace(root: string, threadId?: string): void {
    const canonicalRoot = canonicalPath(root);
    if (threadId) {
      workspaceThreads.set(canonicalRoot, threadId);
      lastActiveThreadId = threadId;
    }
    if (watchers.has(canonicalRoot)) return;
    const watcher = createArtifactWatcher({
      fs,
      index,
      now,
      newId: () => `af_${now()}_${(artifactSeq += 1)}`,
    });
    watcher.start(canonicalRoot);
    watchers.set(canonicalRoot, watcher);
    options.logger?.info('artifacts.watch.started', { pathKind: 'workspace' });
  }

  function isInside(root: string, path: string): boolean {
    const rel = relative(root, path);
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
  }

  /**
   * 给一份绝对路径找到（或建）对应 watcher。产物经常写到 cwd 之外
   * （用户指定的桌面目录），不能因为「不在当前工作空间里」就丢掉。
   */
  function watcherFor(
    path: string,
    threadId?: string,
  ): ReturnType<typeof createArtifactWatcher> | undefined {
    const artifactPath = canonicalPath(path);
    const existingRoot = [...watchers.keys()].find((root) => isInside(root, artifactPath));
    if (existingRoot) {
      if (threadId) workspaceThreads.set(existingRoot, threadId);
      return watchers.get(existingRoot);
    }
    const parent = canonicalPath(dirname(artifactPath));
    watchWorkspace(parent, threadId);
    return watchers.get(parent);
  }

  /**
   * 产物给任务起名（`taskTitleFromArtifact`）。
   *
   * **不 await**：这是一次装饰性的改名，产物索引不该为它多等一次 JSON-RPC 往返。
   * `setTaskName` 自己吞掉失败并留日志，所以这里只兜住 promise 本身。
   *
   * 覆盖判断在 `canOverrideTitle` 里（用户改过名字就不再动）——
   * 读的是**当前**的 `title_source`，不是上报时的，所以并发的两条上报里
   * 第二条会看到第一条写下的 `'artifact'` 而放弃。
   */
  function renameTaskAfter(record: ArtifactRecord | undefined): void {
    if (!record) return;
    const candidate = taskTitleFromArtifact(record);
    if (!candidate) return;
    if (!canOverrideTitle(options.store.threads.titleSourceOf(candidate.threadId), 'artifact')) {
      return;
    }
    void options.adapter
      .setTaskName(candidate.threadId, candidate.title, 'artifact')
      .then((ok) => {
        if (ok) options.logger?.info('artifacts.task_renamed', { threadId: candidate.threadId });
      })
      .catch(() => {
        /* setTaskName 内部已经记过日志；这里只是不让 promise 裸奔 */
      });
  }

  function announceArtifact(record: ArtifactRecord | undefined): void {
    if (record?.threadId) options.onArtifactChanged?.(record.threadId);
  }

  function reportArtifact(report: {
    readonly skill: string;
    readonly path: string;
    readonly outputFormat: string;
    readonly operationKind: 'create' | 'edit';
    readonly title?: string | undefined;
    readonly threadId?: string | undefined;
  }): void {
    const artifactPath = canonicalPath(report.path);
    const normalizedReport = { ...report, path: artifactPath };
    const threadId = report.threadId ?? lastActiveThreadId;
    const watcher = watcherFor(artifactPath, threadId);
    const record = watcher?.ingestSkillReport(normalizedReport, { threadId });
    renameTaskAfter(record);
    announceArtifact(record);
  }

  /**
   * 技能上报是 JSONL。按字节偏移量只消费完整行，避免刚好在写入中间读到
   * 半个 UTF-8 字符或半条 JSON。损坏行只记分类，不把路径/标题写进日志。
   */
  function flushArtifactReports(fallbackThreadId?: string): number {
    const path = artifactReportLog;
    if (!path || !existsSync(path)) return 0;
    let bytes: Buffer;
    try {
      bytes = readFileSync(path);
    } catch {
      return 0;
    }
    if (bytes.length < artifactReportOffset) artifactReportOffset = 0;
    const pending = bytes.subarray(artifactReportOffset);
    const lastNewline = pending.lastIndexOf(10);
    if (lastNewline < 0) return 0;
    const chunk = pending.subarray(0, lastNewline + 1).toString('utf8');
    artifactReportOffset += lastNewline + 1;

    let accepted = 0;
    for (const line of chunk.split('\n')) {
      if (!line.trim()) continue;
      try {
        const raw = JSON.parse(line) as Record<string, unknown>;
        if (
          raw.kind !== 'artifact.mark' ||
          typeof raw.skill !== 'string' ||
          typeof raw.path !== 'string' ||
          typeof raw.outputFormat !== 'string' ||
          (raw.operationKind !== 'create' && raw.operationKind !== 'edit')
        ) {
          options.logger?.warn('artifacts.report.invalid', { reason: 'INVALID_RECORD' });
          continue;
        }
        reportArtifact({
          skill: raw.skill,
          path: raw.path,
          outputFormat: raw.outputFormat,
          operationKind: raw.operationKind,
          ...(typeof raw.title === 'string' ? { title: raw.title } : {}),
          // JSONL 本身没有 threadId。路径在 cwd 里时 watcher 能认领；写到桌面等
          // cwd 之外时必须用当前回合，否则索引有记录、结果区仍是空的。
          ...((fallbackThreadId ?? lastActiveThreadId)
            ? { threadId: fallbackThreadId ?? lastActiveThreadId }
            : {}),
        });
        accepted += 1;
      } catch {
        options.logger?.warn('artifacts.report.invalid', { reason: 'INVALID_JSON' });
      }
    }
    return accepted;
  }

  /* ── 办公扩展：探测 + 安装（08 §4）───────────────────────────── */

  /**
   * 扩展的状态与安装入口。
   *
   * 探测结果**不缓存在这一层**：`createRuntimeProbe()` 自己带缓存，而安装成功后
   * 必须 `invalidate()` —— 不失效的话界面会一直显示"没装"，用户刚装完就被告知没装，
   * 只能重启 App 才认。这正是 `probe.ts` 头注释里写的那个"安装流程结束时调用"。
   */
  const officeRuntime = {
    status: (): RuntimeStatusView => {
      const missing = RUNTIME_TIERS.office.probeModules.filter((m) => !probe.hasModule(m));
      const triple = TRIPLE_BY_PLATFORM[`${process.arch}-${process.platform}`];
      return {
        installed: missing.length === 0,
        missing,
        supported: triple !== undefined,
        ...(triple !== undefined
          ? { downloadSize: `约 ${Math.round(totalDownloadBytes(triple) / 1_000_000)} MB` }
          : {}),
      };
    },

    install: async (): Promise<RuntimeInstallResultView> => {
      const result = await installOfficeRuntime({
        ...(options.logger ? { logger: options.logger } : {}),
        ...(process.env.EVOWORK_OFFICE_BUNDLE
          ? { bundleDir: process.env.EVOWORK_OFFICE_BUNDLE }
          : {}),
        onProgress: (p) =>
          options.onRuntimeProgress?.({
            phase: p.phase,
            label: PHASE_LABEL[p.phase],
            percent: p.percent,
            ...(p.detail !== undefined ? { detail: p.detail } : {}),
          }),
      });
      // 成功与否都失效一次：失败也可能装进去了一部分，缓存住旧答案只会更乱
      probe.invalidate();
      return result.ok
        ? { ok: true }
        : { ok: false, failure: result.failure, message: result.message };
    },
  };

  return {
    automations,
    artifacts,
    bridge,
    scheduler,
    probe,
    officeRuntime,

    /**
     * 启动调度：先做一次 misfire 扫描（**先写 MISSED 再补跑**），再按分钟对表。
     *
     * 分钟粒度就够：cron 的最小单位就是分钟，而更细的 tick 只会在笔记本上白耗电。
     */
    async startScheduler(intervalMs = 60_000): Promise<void> {
      for (const automation of automations.listActive(options.store.deviceId)) {
        const definition = automation as unknown as AutomationDefinition;
        const plan = scheduler.scanOnStart(definition);
        await scheduler.applyMisfirePlan(definition, plan).catch((err: unknown) => {
          options.logger?.warn('scheduler.catchup.failed', {
            errorClass: err instanceof Error ? err.name : 'UnknownError',
          });
        });
      }

      tick = setInterval(() => {
        void (async () => {
          const at = now();
          for (const automation of automations.listActive(options.store.deviceId)) {
            const definition = automation as unknown as AutomationDefinition;
            const next = scheduler.nextWakeup(definition);
            // 到点了才触发：`nextWakeup` 给的是"下一次"，落在这一分钟里就跑
            if (next !== undefined && next <= at + intervalMs && next > at - intervalMs) {
              await scheduler.fire(definition, next).catch(() => undefined);
            }
          }
        })();
      }, intervalMs);
      if (typeof tick.unref === 'function') tick.unref();
    },

    /** 打开任务时开始盯它的工作空间；关掉任务不停 —— 产物可能在后台继续生成。 */
    watchWorkspace,

    /**
     * 内核 FileChange item 是“这个任务改了哪些文件”的权威信号。
     *
     * 必须逐条喂给识别器，不能只拿它当成“开始全盘扫描”的提示；后者会把工作区里原有的
     * README/package.json 等全部算成当前任务的产物。
     */
    ingestFileChanges(
      root: string,
      threadId: string,
      changes: readonly { readonly path: string; readonly kind?: string | undefined }[],
    ): void {
      const canonicalRoot = canonicalPath(root);
      watchWorkspace(canonicalRoot, threadId);
      for (const change of changes) {
        const path = canonicalPath(
          isAbsolute(change.path) ? change.path : join(canonicalRoot, change.path),
        );
        const watcher = watcherFor(path, threadId);
        if (!watcher) continue;
        const kind = change.kind === 'delete' ? 'delete' : change.kind === 'add' ? 'add' : 'modify';
        announceArtifact(watcher.ingestPath(path, kind, { threadId }));
      }
    },

    /** 技能上报（信号 ①）。宿主从 `EVOWORK_ARTIFACT_LOG` 或 socket 收到后调这里。 */
    reportArtifact,

    /**
     * 把技能的 `mark_artifact` 上报文件接入产物服务。启动时跳过历史行：
     * 它们已入库，重放只会把旧任务错绑到当前回合。
     */
    startArtifactReports(path: string, intervalMs = 250): void {
      artifactReportLog = path;
      artifactReportOffset = existsSync(path) ? statSync(path).size : 0;
      if (artifactReportTimer) clearInterval(artifactReportTimer);
      artifactReportTimer = setInterval(() => flushArtifactReports(), intervalMs);
      if (typeof artifactReportTimer.unref === 'function') artifactReportTimer.unref();
    },

    /** 回合结束前同步冲掉已写完的上报，确保 UI 随后重读时已经看得到。 */
    flushArtifactReports,

    /** 内核退出：在跑的定时任务全判 ENVIRONMENT（不计连败）。 */
    onKernelExit(): void {
      bridge.onKernelExit();
    },

    onTurnFinished(input: Parameters<typeof bridge.onTurnFinished>[0]): void {
      bridge.onTurnFinished(input);
    },

    stop(): void {
      if (tick) clearInterval(tick);
      tick = undefined;
      for (const watcher of watchers.values()) watcher.stop();
      watchers.clear();
      workspaceThreads.clear();
      if (artifactReportTimer) clearInterval(artifactReportTimer);
      artifactReportTimer = undefined;
      bridge.dispose();
    },
  };
}

export type LocalServices = ReturnType<typeof createLocalServices>;

/** 相对工作空间的展示路径（UI 用）。放这里是因为它与 watcher 的路径口径必须一致。 */
export function displayPath(root: string, absolute: string): string {
  const rel = relative(root, absolute);
  return rel.startsWith('..') ? absolute : rel;
}
