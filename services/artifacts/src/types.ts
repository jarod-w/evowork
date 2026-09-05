/**
 * EvoWork 的产物类型体系（08 §2.3）。
 *
 * ## 为什么不用内核那四类
 *
 * 内核的 `artifact_operation.rs` 只认 `presentation` / `document` / `spreadsheet` / `pdf`，
 * **没有 chart**（README F11）。而且它的识别结果只喂 analytics、不进协议，
 * 还硬编码 OpenAI 的 marketplace 名（F10）—— 那条链路对我们完全无用，
 * 所以产物识别 100% 自建（D6 的 v0.4 修订）。
 *
 * ## `chart` 与 `image` 都可能是 png，靠**信号源**区分
 *
 * 这是这张表最需要说明的一条：`charts` 技能上报的是 chart，
 * 图片生成扩展产出的是 image，扩展名一样。所以信号 ①（技能显式上报）**必须存在** ——
 * 只靠扩展名分不清，而分不清的表现是结果区里图表和插图混成一堆。
 */

export type ArtifactType =
  | 'document'
  | 'spreadsheet'
  | 'presentation'
  | 'pdf'
  | 'chart'
  | 'image'
  | 'webpage'
  | 'data'
  | 'archive';

/** 三个互补的识别信号（08 §2.2）。任一命中即入索引，按绝对路径去重。 */
export type SourceSignal = 'SKILL_REPORT' | 'FILE_CHANGE' | 'HOOK_SCAN';

export type OperationKind = 'create' | 'edit';

/** `fs/watch` 维护的文件状态（08 §8）。 */
export type FileState = 'PRESENT' | 'MISSING' | 'MOVED';

/** 扩展名 → 类型。**只用于信号 ②/③**（信号 ① 直接带类型来）。 */
const EXTENSION_TYPE: Readonly<Record<string, ArtifactType>> = {
  doc: 'document',
  docx: 'document',
  md: 'document',
  rtf: 'document',
  csv: 'spreadsheet',
  tsv: 'spreadsheet',
  xls: 'spreadsheet',
  xlsx: 'spreadsheet',
  ppt: 'presentation',
  pptx: 'presentation',
  pdf: 'pdf',
  html: 'webpage',
  htm: 'webpage',
  json: 'data',
  parquet: 'data',
  sqlite: 'data',
  db: 'data',
  zip: 'archive',
  // svg 几乎只会是图表；png/jpg 无法从扩展名判断，见下
  svg: 'chart',
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  webp: 'image',
  gif: 'image',
};

export const ARTIFACT_TYPE_LABEL: Readonly<Record<ArtifactType, string>> = Object.freeze({
  document: '文档',
  spreadsheet: '表格',
  presentation: '幻灯片',
  pdf: 'PDF',
  chart: '图表',
  image: '图片',
  webpage: '网页',
  data: '数据',
  archive: '压缩包',
});

export function extensionOf(path: string): string {
  const name = path.split('/').pop() ?? path;
  const index = name.lastIndexOf('.');
  return index <= 0 ? '' : name.slice(index + 1).toLowerCase();
}

/**
 * 按扩展名推断类型。
 *
 * **只在没有技能上报时用**。png 会被推成 `image` —— 如果它其实是 `charts` 技能画的图，
 * 那条记录会由信号 ① 覆盖（`mergeSignals` 里技能上报优先）。
 */
export function typeFromPath(path: string): ArtifactType | undefined {
  return EXTENSION_TYPE[extensionOf(path)];
}

/** 不算产物的文件：中间产物、缓存、解析副本。进了索引只会污染结果区。 */
const IGNORED_PATTERNS: readonly RegExp[] = [
  /(^|\/)\./, // 隐藏文件与目录
  /(^|\/)node_modules\//,
  /(^|\/)__pycache__\//,
  /(^|\/)uploads\//, // 解析管道的落盘（08 §3.2），不是产物
  /\.(tmp|temp|log|lock|pyc|swp)$/i,
  /~\$/, // Office 的锁文件 ~$xxx.docx
];

export function isIgnored(path: string): boolean {
  return IGNORED_PATTERNS.some((pattern) => pattern.test(path));
}
