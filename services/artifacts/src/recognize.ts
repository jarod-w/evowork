/**
 * 产物识别（08 §2.2）：三个互补信号 → 一条索引记录。
 *
 * ```
 * ① 技能显式上报（主）   mark_artifact → 意图、期望数量、格式，元数据最全
 * ② FileChange item     agent 用 shell/python 直接写出的文件
 * ③ post_tool_use hook  绕过前两者的情况（脚本内部批量生成）
 * ```
 *
 * **任一命中即入索引，按绝对路径去重。** 优先级 ① > ② > ③：
 * 技能上报带着扩展名推不出来的东西（chart 还是 image、create 还是 edit、显示名）。
 *
 * ## 索引里没有内容
 *
 * D6：文件系统是真源。所以这里只存"指向文件的元数据"，
 * 而"删除索引 ≠ 删除文件"就成了自然结果，不需要额外约定。
 */

import {
  isIgnored,
  typeFromPath,
  type ArtifactType,
  type FileState,
  type OperationKind,
  type SourceSignal,
} from './types.js';

export interface ArtifactRecord {
  readonly id: string;
  readonly threadId?: string | undefined;
  readonly turnId?: string | undefined;
  readonly automationId?: string | undefined;
  /** 工作空间内绝对路径。真源在文件系统 */
  readonly path: string;
  readonly artifactType: ArtifactType;
  readonly outputFormat: string;
  /** 显示名。默认取文件名，**可重命名而不改文件名**（08 §2.4） */
  readonly title: string;
  readonly operationKind: OperationKind;
  readonly sizeBytes?: number | undefined;
  readonly contentHash?: string | undefined;
  readonly version: number;
  readonly supersedesId?: string | undefined;
  readonly sourceSignal: SourceSignal;
  readonly fileState: FileState;
  readonly shareId?: string | undefined;
  readonly createdAt: number;
}

/** 信号 ①：技能上报（`mark_artifact` 的那行 JSON）。 */
export interface SkillReport {
  readonly signal: 'SKILL_REPORT';
  readonly skill: string;
  readonly path: string;
  readonly outputFormat: string;
  readonly operationKind: OperationKind;
  readonly title?: string | undefined;
  readonly expectedOutputCount?: number | undefined;
}

/** 信号 ②：`FileChange` item。 */
export interface FileChangeSignal {
  readonly signal: 'FILE_CHANGE';
  readonly path: string;
  readonly kind: 'add' | 'modify' | 'delete';
}

/** 信号 ③：`post_tool_use` hook 扫到的新增文件。 */
export interface HookScanSignal {
  readonly signal: 'HOOK_SCAN';
  readonly path: string;
}

export type RecognitionSignal = SkillReport | FileChangeSignal | HookScanSignal;

/** 技能名 → 产物类型。这就是"png 到底是 chart 还是 image"的答案来源。 */
const SKILL_TYPE: Readonly<Record<string, ArtifactType>> = {
  documents: 'document',
  spreadsheets: 'spreadsheet',
  presentations: 'presentation',
  charts: 'chart',
  'image-generation': 'image',
};

const SIGNAL_PRIORITY: Readonly<Record<SourceSignal, number>> = {
  SKILL_REPORT: 3,
  FILE_CHANGE: 2,
  HOOK_SCAN: 1,
};

export interface RecognizeContext {
  readonly threadId?: string | undefined;
  readonly turnId?: string | undefined;
  readonly automationId?: string | undefined;
  readonly now: () => number;
  readonly newId: () => string;
  /** 文件的当前大小与内容哈希；文件不在时返回 undefined */
  readonly statFile: (path: string) => { sizeBytes: number; contentHash: string } | undefined;
  /** 这个路径已有的最新版本（用来算 version 与 supersedes） */
  readonly latestFor: (path: string) => ArtifactRecord | undefined;
}

export type RecognizeOutcome =
  | { readonly kind: 'ignored'; readonly reason: 'not-artifact' | 'deleted' | 'unchanged' }
  | { readonly kind: 'inserted'; readonly record: ArtifactRecord }
  | { readonly kind: 'superseded'; readonly record: ArtifactRecord }
  /**
   * **同一份内容、更高优先级的信号来了** —— 这是一次元数据订正，不是新版本。
   *
   * 典型场景：`charts` 技能画了一张 png，文件先被 watcher 扫到（信号 ③，按扩展名判成
   * `image`），技能的上报（信号 ①）随后到达。内容哈希没变，所以它不该产生 v2；
   * 但类型、标题、来源都该按信号 ① 改过来 —— 否则这张图会永远显示成"图片"而不是"图表"。
   *
   * 第一版没有这个分支，于是上报被"内容没变"挡掉了。是接线时的端到端测试抓出来的。
   */
  | { readonly kind: 'corrected'; readonly record: ArtifactRecord };

export function recognize(signal: RecognitionSignal, context: RecognizeContext): RecognizeOutcome {
  if (signal.signal === 'FILE_CHANGE' && signal.kind === 'delete') {
    // 删除不产生新记录：`fs/watch` 会把已有记录标成 MISSING（08 §8）
    return { kind: 'ignored', reason: 'deleted' };
  }
  if (isIgnored(signal.path)) return { kind: 'ignored', reason: 'not-artifact' };

  const artifactType =
    signal.signal === 'SKILL_REPORT'
      ? (SKILL_TYPE[signal.skill] ?? typeFromPath(signal.path))
      : typeFromPath(signal.path);
  if (artifactType === undefined) return { kind: 'ignored', reason: 'not-artifact' };

  const stat = context.statFile(signal.path);
  const previous = context.latestFor(signal.path);

  /*
   * 版本（08 §2.5）：同一 path 再次写入且 content_hash 变化 → version + 1。
   *
   * 哈希没变就什么都不做 —— 三个信号会对同一次生成各报一次，
   * 不去重的话一个 pptx 会在结果区里出现三张卡。
   */
  if (previous && stat && previous.contentHash === stat.contentHash) {
    // 内容没变，但更高优先级的信号来了 → 订正元数据（见 RecognizeOutcome 的 'corrected'）
    if (SIGNAL_PRIORITY[signal.signal] > SIGNAL_PRIORITY[previous.sourceSignal]) {
      return {
        kind: 'corrected',
        record: {
          ...previous,
          artifactType,
          sourceSignal: signal.signal,
          ...(signal.signal === 'SKILL_REPORT'
            ? {
                outputFormat: signal.outputFormat,
                operationKind: signal.operationKind,
                ...(signal.title ? { title: signal.title } : {}),
              }
            : {}),
        },
      };
    }
    return { kind: 'ignored', reason: 'unchanged' };
  }

  const record: ArtifactRecord = {
    id: context.newId(),
    threadId: context.threadId,
    turnId: context.turnId,
    automationId: context.automationId,
    path: signal.path,
    artifactType,
    outputFormat:
      signal.signal === 'SKILL_REPORT'
        ? signal.outputFormat
        : (signal.path.split('.').pop() ?? '').toLowerCase(),
    title:
      signal.signal === 'SKILL_REPORT' && signal.title
        ? signal.title
        : (signal.path.split('/').pop() ?? signal.path),
    operationKind:
      signal.signal === 'SKILL_REPORT' ? signal.operationKind : previous ? 'edit' : 'create',
    sizeBytes: stat?.sizeBytes,
    contentHash: stat?.contentHash,
    version: (previous?.version ?? 0) + 1,
    supersedesId: previous?.id,
    sourceSignal: signal.signal,
    fileState: stat ? 'PRESENT' : 'MISSING',
    createdAt: context.now(),
  };

  return previous ? { kind: 'superseded', record } : { kind: 'inserted', record };
}

/**
 * 同一次生成里多个信号的合并：**优先级高的赢**。
 *
 * 典型场景：`charts` 技能画了一张 png，三个信号都报了。
 * 只按时间取最后一个的话，`HOOK_SCAN` 会把 `SKILL_REPORT` 带来的
 * "这是 chart 不是 image" 覆盖掉。
 */
export function mergeSignals(signals: readonly RecognitionSignal[]): readonly RecognitionSignal[] {
  const best = new Map<string, RecognitionSignal>();
  for (const signal of signals) {
    const current = best.get(signal.path);
    if (!current || SIGNAL_PRIORITY[signal.signal] > SIGNAL_PRIORITY[current.signal]) {
      best.set(signal.path, signal);
    }
  }
  return [...best.values()];
}

/**
 * 文件被外部删除/移动时的状态更新（08 §8）。
 *
 * 移动优先按 `content_hash` 重新定位 —— 用户在 Finder 里挪一下文件，
 * 产物卡不该直接变成"文件已不存在"。
 */
export function relocate(
  record: ArtifactRecord,
  candidates: readonly { readonly path: string; readonly contentHash: string }[],
): { readonly fileState: FileState; readonly path: string } {
  if (record.contentHash) {
    const match = candidates.find((c) => c.contentHash === record.contentHash);
    if (match) return { fileState: 'PRESENT', path: match.path };
  }
  return { fileState: 'MISSING', path: record.path };
}

/** 08 §2.5：磁盘上**只有最新版**，所以旧版的文案不能是「打开这一版文件」。 */
export const VERSION_ACTION_LABEL = '查看这一版的生成记录';
