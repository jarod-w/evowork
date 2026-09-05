/**
 * 文件系统 ↔ 产物索引的接线（08 §2.2 信号 ② / §8）。
 *
 * 两件事：
 *   · **新文件进索引** —— 信号 ②（`FileChange` item）与 ③（hook 扫描）都汇到这里；
 *   · **维护 `file_state`** —— 文件被外部删除/移动时，索引要如实反映（08 §8）。
 *
 * ## 为什么不用 `fs.watch` 的 recursive
 *
 * `fs.watch(dir, {recursive:true})` 在 Linux 上到 Node 20 才支持，且在所有平台上都会
 * **丢事件**（重命名整个目录、编辑器的原子保存、网络盘）。而这里丢一个事件的表现是
 * "产物没出现在结果区"，用户只会觉得产品不稳定。
 *
 * 所以策略是**事件 + 对账**：watcher 给出即时性，定期全量扫描保证最终一致。
 * 这与 09 §4.1 对任务列表的处理是同一条思路 —— 投影类数据靠对账兜底。
 *
 * ## 移动优先按内容哈希重新定位
 *
 * 08 §8：用户在 Finder 里挪一下文件，产物卡不该直接变成"文件已不存在"。
 * 所以扫描时先收集"新出现的文件"的哈希，再拿它去认领 MISSING 的记录。
 */

import { recognize, relocate, type ArtifactRecord, type RecognizeContext } from './recognize.js';
import { isIgnored } from './types.js';

/** 文件系统的最小抽象。注入以便测试，也让"用不用内核的 `fs/watch`"成为宿主的选择。 */
export interface FileSystemPort {
  /** 列出目录下的所有文件（相对或绝对路径都行，保持一致即可） */
  listFiles(root: string): readonly string[];
  stat(path: string): { readonly sizeBytes: number; readonly contentHash: string } | undefined;
  /** 订阅变化。返回退订函数。丢事件是允许的 —— 对账会兜底 */
  watch(
    root: string,
    onChange: (path: string, kind: 'add' | 'modify' | 'delete') => void,
  ): () => void;
}

export interface IndexPort {
  latestFor(path: string): ArtifactRecord | undefined;
  insert(record: ArtifactRecord): void;
  /** 元数据订正（同一条记录、同一版本）。见 `RecognizeOutcome` 的 `corrected` */
  update(record: ArtifactRecord): void;
  /** 列出这个工作空间下、当前认为存在的记录 */
  listPresent(root: string): readonly ArtifactRecord[];
  setFileState(id: string, state: ArtifactRecord['fileState'], path?: string): void;
}

export interface WatcherOptions {
  readonly fs: FileSystemPort;
  readonly index: IndexPort;
  readonly now: () => number;
  readonly newId: () => string;
  readonly threadId?: string | undefined;
  readonly turnId?: string | undefined;
  /** 对账间隔。默认 10 分钟，与任务列表的对账同一个节奏（09 §4.1） */
  readonly reconcileIntervalMs?: number | undefined;
}

export const DEFAULT_RECONCILE_INTERVAL_MS = 10 * 60_000;

export function createArtifactWatcher(options: WatcherOptions) {
  const context = (): RecognizeContext => ({
    threadId: options.threadId,
    turnId: options.turnId,
    now: options.now,
    newId: options.newId,
    statFile: (path) => options.fs.stat(path),
    latestFor: (path) => options.index.latestFor(path),
  });

  /** 一个文件变化 → 可能的一条索引记录。 */
  function ingestPath(path: string, kind: 'add' | 'modify' | 'delete'): void {
    if (kind === 'delete') {
      const existing = options.index.latestFor(path);
      // 08 §8：文件被外部删除 → 标 MISSING，**不删索引条目**
      // （用户可能只是挪走了；而且"重新生成"要靠这条记录里的来源信息）
      if (existing) options.index.setFileState(existing.id, 'MISSING');
      return;
    }
    apply(recognize({ signal: 'FILE_CHANGE', path, kind }, context()));
  }

  /**
   * 全量对账：补上丢掉的事件，并处理删除/移动。
   *
   * 顺序是刻意的：**先认领移动，再标缺失**。反过来的话一个被挪走的文件会先被标 MISSING，
   * UI 上闪一下"文件已不存在"再变回来。
   */
  function reconcile(root: string): { added: number; moved: number; missing: number } {
    const onDisk = options.fs.listFiles(root).filter((path) => !isIgnored(path));
    const onDiskSet = new Set(onDisk);
    const indexed = options.index.listPresent(root);
    const indexedPaths = new Set(indexed.map((record) => record.path));

    // ① 磁盘上有、索引里没有 → 补进去（丢掉的 add 事件）
    let added = 0;
    for (const path of onDisk) {
      if (indexedPaths.has(path)) continue;
      if (apply(recognize({ signal: 'HOOK_SCAN', path }, context()))) added += 1;
    }

    // ② 索引里有、磁盘上没有 → 先按内容哈希在"新出现的文件"里找它
    const candidates = onDisk
      .filter((path) => !indexedPaths.has(path))
      .map((path) => ({ path, hash: options.fs.stat(path)?.contentHash }))
      .filter((entry): entry is { path: string; hash: string } => entry.hash !== undefined)
      .map((entry) => ({ path: entry.path, contentHash: entry.hash }));

    let moved = 0;
    let missing = 0;
    for (const record of indexed) {
      if (onDiskSet.has(record.path)) continue;
      const located = relocate(record, candidates);
      if (located.fileState === 'PRESENT') {
        options.index.setFileState(record.id, 'PRESENT', located.path);
        moved += 1;
      } else {
        options.index.setFileState(record.id, 'MISSING');
        missing += 1;
      }
    }
    return { added, moved, missing };
  }

  /** 把识别结果落库。返回是否真的写了一条。 */
  function apply(outcome: ReturnType<typeof recognize>): boolean {
    if (outcome.kind === 'inserted' || outcome.kind === 'superseded') {
      options.index.insert(outcome.record);
      return true;
    }
    if (outcome.kind === 'corrected') {
      options.index.update(outcome.record);
      return true;
    }
    return false;
  }

  const stops: (() => void)[] = [];
  let timer: ReturnType<typeof setInterval> | undefined;

  return {
    /** 开始盯一个工作空间：先对账一次，再订阅变化。 */
    start(root: string): void {
      reconcile(root);
      stops.push(options.fs.watch(root, ingestPath));
      if (timer === undefined) {
        timer = setInterval(
          () => reconcile(root),
          options.reconcileIntervalMs ?? DEFAULT_RECONCILE_INTERVAL_MS,
        );
        if (typeof timer.unref === 'function') timer.unref();
      }
    },
    reconcile,
    ingestPath,
    /** 技能显式上报（信号 ①）走这条 —— 它带着扩展名推不出来的类型信息 */
    ingestSkillReport(report: {
      readonly skill: string;
      readonly path: string;
      readonly outputFormat: string;
      readonly operationKind: 'create' | 'edit';
      readonly title?: string | undefined;
    }): ArtifactRecord | undefined {
      const outcome = recognize({ signal: 'SKILL_REPORT', ...report }, context());
      return apply(outcome) ? (outcome as { record: ArtifactRecord }).record : undefined;
    },
    stop(): void {
      for (const stop of stops.splice(0)) stop();
      if (timer) clearInterval(timer);
      timer = undefined;
    },
  };
}

/**
 * 基于 `node:fs` 的实现。
 *
 * 用轮询而不是 `fs.watch`：这个 watcher 盯的是**工作空间里的产物**，
 * 数量是几十到几百，而不是 node_modules 那种量级。轮询的代价可以接受，
 * 换来的是三个平台上行为一致、不丢事件、也不需要处理编辑器的原子保存。
 *
 * （真的遇到大目录时，宿主可以换成内核的 `fs/watch` —— 端口就是为此留的。）
 */
export function createPollingFileSystem(io: {
  readonly listFiles: (root: string) => readonly string[];
  readonly stat: (path: string) => { sizeBytes: number; contentHash: string } | undefined;
  readonly intervalMs?: number;
}): FileSystemPort {
  return {
    listFiles: io.listFiles,
    stat: io.stat,
    watch(root, onChange) {
      let previous = new Map<string, string>();
      for (const path of io.listFiles(root)) {
        const stat = io.stat(path);
        if (stat) previous.set(path, stat.contentHash);
      }

      const timer = setInterval(() => {
        const current = new Map<string, string>();
        for (const path of io.listFiles(root)) {
          const stat = io.stat(path);
          if (stat) current.set(path, stat.contentHash);
        }
        for (const [path, hash] of current) {
          const before = previous.get(path);
          if (before === undefined) onChange(path, 'add');
          else if (before !== hash) onChange(path, 'modify');
        }
        for (const path of previous.keys()) {
          if (!current.has(path)) onChange(path, 'delete');
        }
        previous = current;
      }, io.intervalMs ?? 2_000);
      if (typeof timer.unref === 'function') timer.unref();

      return () => clearInterval(timer);
    },
  };
}
