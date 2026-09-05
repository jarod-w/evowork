/**
 * 资料库的视图逻辑（06 §3）。
 *
 * ## 「文件系统是真源」在资料库里意味着什么
 *
 * 06 §3.2：资料库不是独立存储，只是本机文件的一个视图 + 索引。所以两种删除**语义不同**：
 *
 *   · 「我的资料」里删除 = **真删磁盘文件**（二次确认要说清）
 *   · 「本地产物」里删除 = **只移除索引条目**，并询问是否同时删文件（**默认不删**）
 *
 * 把这两条写反的代价是用户丢文件，所以它们在这里是两个不同的函数而不是一个带布尔的函数。
 */

import type { ArtifactType } from './types.js';

export type LibrarySource = 'artifact' | 'mine' | 'team';

export interface LibraryRow {
  readonly id: string;
  readonly name: string;
  readonly source: LibrarySource;
  /** 显示用的所有者。本地产物与我的资料恒为「我」 */
  readonly owner: string;
  /** 位置（工作空间名或目录） */
  readonly location: string;
  readonly accessedAt: number;
  readonly artifactType?: ArtifactType | undefined;
  readonly extension?: string | undefined;
}

/**
 * 「所有者」列的显隐规则（06 §3.3）。
 *
 * 当前视图内所有行的所有者相同时**自动隐藏该列** —— 把宽度让给名称。
 * Q17/Q19 都不做的话，个人版里这一列几乎恒为「我」，留着就是一整列废信息。
 */
export function shouldShowOwnerColumn(rows: readonly LibraryRow[]): boolean {
  if (rows.length === 0) return false;
  const first = rows[0]?.owner;
  return rows.some((row) => row.owner !== first);
}

export type TypeFilter =
  | 'all'
  | 'document'
  | 'spreadsheet'
  | 'presentation'
  | 'pdf'
  | 'image'
  | 'markdown'
  | 'data'
  | 'other';

export const TYPE_FILTER_LABEL: Readonly<Record<TypeFilter, string>> = Object.freeze({
  all: '全部类型',
  document: '文档',
  spreadsheet: '表格',
  presentation: '幻灯片',
  pdf: 'PDF',
  image: '图片',
  markdown: 'Markdown',
  data: '数据',
  other: '其他',
});

/** 筛选来自产物索引的 `artifact_type` **与文件扩展名**（06 §3.3 最后一句）。 */
export function matchesTypeFilter(row: LibraryRow, filter: TypeFilter): boolean {
  if (filter === 'all') return true;
  if (filter === 'markdown') return row.extension === 'md' || row.extension === 'markdown';
  if (row.artifactType) {
    if (filter === 'other') {
      return !['document', 'spreadsheet', 'presentation', 'pdf', 'image'].includes(
        row.artifactType,
      );
    }
    // markdown 走扩展名，所以 document 这一档要把 .md 让出去
    if (filter === 'document') {
      return row.artifactType === 'document' && row.extension !== 'md';
    }
    return row.artifactType === filter;
  }
  return filter === 'other';
}

export function filterRows(
  rows: readonly LibraryRow[],
  options: { readonly filter?: TypeFilter | undefined; readonly query?: string | undefined },
): readonly LibraryRow[] {
  const query = (options.query ?? '').trim().toLowerCase();
  return rows.filter((row) => {
    if (!matchesTypeFilter(row, options.filter ?? 'all')) return false;
    if (query && !row.name.toLowerCase().includes(query)) return false;
    return true;
  });
}

/** 三个 Tab（06 §3.3）。「与我共享」**v1 不渲染**（Q19 决策为只读订阅，收件箱不做）。 */
export const RECENT_TABS = Object.freeze([
  { id: 'recent', label: '最近访问' },
  { id: 'shared-by-me', label: '我分享的' },
] as const);

export type RecentTab = (typeof RECENT_TABS)[number]['id'];

export interface DeleteIntent {
  readonly kind: 'delete-file' | 'remove-index';
  readonly title: string;
  readonly body: string;
  /** 是否额外提供「同时删除磁盘文件」选项，**默认不勾** */
  readonly offersFileDeletion: boolean;
}

/** 「我的资料」里删除 = 真删磁盘文件。 */
export function describeDeleteMine(name: string): DeleteIntent {
  return {
    kind: 'delete-file',
    title: `删除「${name}」？`,
    body: '这会把文件从磁盘上删掉，**不进回收站**，找不回来。',
    offersFileDeletion: false,
  };
}

/** 「本地产物」里删除 = 只移除索引条目，磁盘文件默认保留。 */
export function describeRemoveArtifact(name: string, path: string): DeleteIntent {
  return {
    kind: 'remove-index',
    title: `从资料库移除「${name}」？`,
    body: `只是不再在资料库里显示它。**磁盘上的文件会保留**（${path}）。`,
    offersFileDeletion: true,
  };
}

/**
 * 本机磁盘占用（Q17 / 01 §5.27）。
 *
 * **不是云配额**：这里展示的是本机占用，右侧动作是「清理」而不是「升级」。
 * 摆一个「升级」按钮会承诺一个不存在的东西（Q17 决定不做个人云盘）。
 */
export interface DiskUsage {
  readonly artifactsBytes: number;
  readonly parseCacheBytes: number;
  readonly indexBytes: number;
  readonly diskFreeBytes: number;
}

export function describeDiskUsage(usage: DiskUsage): {
  readonly label: string;
  readonly percent: number;
  readonly cleanable: number;
} {
  const used = usage.artifactsBytes + usage.parseCacheBytes + usage.indexBytes;
  const gb = (bytes: number): string => `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
  const total = used + usage.diskFreeBytes;
  return {
    label: `本机占用 ${gb(used)}（磁盘剩余 ${gb(usage.diskFreeBytes)}）`,
    percent: total === 0 ? 0 : Math.round((used / total) * 100),
    // 只有解析缓存能安全清理：产物是用户的东西，索引清了要重建
    cleanable: usage.parseCacheBytes,
  };
}

export const CLEANUP_HINT = '可清理的是解析缓存。产物文件本身不会被删除。';
