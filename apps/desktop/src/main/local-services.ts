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
import { join, relative } from 'node:path';

import {
  createArtifactWatcher,
  createPollingFileSystem,
  type ArtifactRecord,
  type IndexPort,
} from '@evowork/artifacts';
import type { Adapter } from '@evowork/kernel-adapter';
import type { Logger } from '@evowork/logging';
import { createRuntimeProbe } from '@evowork/ingest';
import { createKernelBridge, createScheduler, type AutomationDefinition } from '@evowork/scheduler';
import {
  createArtifactRepo,
  createAutomationRepo,
  type ArtifactRow,
  type Store,
} from '@evowork/store';

export interface LocalServicesOptions {
  readonly store: Store;
  readonly adapter: Adapter;
  readonly notify: (text: string) => void;
  readonly logger?: Logger | undefined;
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
  let artifactSeq = 0;

  function watchWorkspace(root: string, threadId?: string): void {
    if (watchers.has(root)) return;
    const watcher = createArtifactWatcher({
      fs,
      index,
      now,
      newId: () => `af_${now()}_${(artifactSeq += 1)}`,
      ...(threadId ? { threadId } : {}),
    });
    watcher.start(root);
    watchers.set(root, watcher);
    options.logger?.info('artifacts.watch.started', { pathKind: 'workspace' });
  }

  return {
    automations,
    artifacts,
    bridge,
    scheduler,
    probe,

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

    /** 技能上报（信号 ①）。宿主从 `EVOWORK_ARTIFACT_LOG` 或 socket 收到后调这里。 */
    reportArtifact(report: {
      readonly skill: string;
      readonly path: string;
      readonly outputFormat: string;
      readonly operationKind: 'create' | 'edit';
      readonly title?: string | undefined;
      readonly threadId?: string | undefined;
    }): void {
      const root = [...watchers.keys()].find((path) => report.path.startsWith(path));
      const watcher = watchers.get(root ?? '');
      if (!watcher) {
        // 没在盯的目录里产出的产物：先建一个 watcher 再上报，否则这条记录之后无人维护
        const parent = report.path.slice(0, report.path.lastIndexOf('/'));
        watchWorkspace(parent, report.threadId);
        watchers.get(parent)?.ingestSkillReport(report);
        return;
      }
      watcher.ingestSkillReport(report);
    },

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
