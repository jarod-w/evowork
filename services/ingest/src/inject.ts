/**
 * 注入 `turn/start` 的载荷（08 §3.2 第 ⑤ 步）。
 *
 * ## 一条设计要点：**不把全文塞进 prompt**
 *
 * 08 §3.2 的原话，也是总纲 §6.7 的原话：塞全文会在长文档上炸上下文且浪费 token。
 * 给的是**路径 + 摘要 + 关键页**，agent 需要细节时用 shell 读 `content.md`。
 *
 * 这条约束在这里是可执行的：`buildInjection` 只能拿到摘要长度上限内的文本，
 * 它没有把全文放进去的能力 —— 而不是"约定不要那么做"。
 *
 * ## 摘要**不调模型**
 *
 * 同一段原话：「摘要由解析器用启发式规则生成（首段 + 各级标题 + 表格清单），不调模型」。
 * 理由不只是省钱：解析发生在用户还没发出第一条消息之前，那时还没有 thread、没有模型选择，
 * 调模型会把一个本地动作变成一次网络往返 —— 而 K6 的整个立点就是本地。
 */

import type { ParseResult } from './parsers/builtin.js';

/** 摘要上限。200 字是 08 §3.2 给的数。 */
export const SUMMARY_LIMIT = 200;

/** 关键页图片上限（08 §3.2：关键页 ≤ 4 张）。 */
export const MAX_KEY_IMAGES = 4;

/**
 * `UserInput` 的三种形态（F6：协议里**没有文档类型**，所以文档只能落成这三种之一）。
 * 这里只造语义化的中间形状，转成协议形状是适配层的事（K2）。
 */
export type InjectionItem =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'localImage'; readonly path: string }
  | { readonly type: 'mention'; readonly name: string; readonly path: string };

export interface InjectionInput {
  readonly fileName: string;
  /** `uploads/<dir>/` 相对工作空间的路径 */
  readonly uploadDir: string;
  readonly result: ParseResult;
  readonly keyImages?: readonly string[];
}

/**
 * 启发式摘要：**首段 + 各级标题 + 表格清单**。
 *
 * 顺序是刻意的 —— 首段说"这是什么"，标题说"讲了哪几块"，表格清单说"有哪些数据"。
 * 三者合起来足够 agent 判断要不要去读全文，而这正是摘要唯一的用途。
 */
export function summarize(markdown: string, limit = SUMMARY_LIMIT): string {
  const lines = markdown.split('\n');

  const firstParagraph = lines
    .find(
      (line) =>
        line.trim() !== '' &&
        !line.startsWith('#') &&
        !line.startsWith('|') &&
        !line.startsWith('>'),
    )
    ?.trim();

  const headings = lines
    .filter((line) => /^#{1,4}\s/.test(line))
    .map((line) => line.replace(/^#+\s*/, '').trim())
    .slice(0, 8);

  const tableCount = lines.filter((line) => /^\|\s*-{3}/.test(line)).length;

  const parts: string[] = [];
  if (firstParagraph) parts.push(firstParagraph);
  if (headings.length > 0) parts.push(`包含章节：${headings.join('、')}`);
  if (tableCount > 0) parts.push(`含 ${tableCount} 张表格`);

  const summary = parts.join('。');
  return summary.length <= limit ? summary : `${summary.slice(0, limit - 1)}…`;
}

/** 正文规模的描述。页数缺失时退回字数 —— 不编一个页数出来。 */
function scaleOf(result: ParseResult): string {
  const { pages, chars } = result.meta;
  return pages !== undefined ? `${pages} 页 / ${chars} 字` : `${chars} 字`;
}

export function buildInjection(input: InjectionInput): readonly InjectionItem[] {
  const { fileName, uploadDir, result } = input;
  const summary = summarize(result.markdown);

  const caveats: string[] = [];
  if (result.meta.partial) {
    caveats.push('这份解析不完整（解析超时，已保留已完成的部分）');
  }
  if (result.meta.confidence < 0.8) {
    // 08 §8：扫描件 OCR 置信度低时**如实写**，不静默当作正常文本
    caveats.push('这是扫描件，本机 OCR 识别可能有误，关键数字请以原件为准');
  }
  if (result.meta.note) caveats.push(result.meta.note);

  const text =
    `已上传《${fileName}》，解析后的正文在 ${uploadDir}content.md（${scaleOf(result)}）。` +
    (summary ? `\n摘要：${summary}` : '') +
    (caveats.length > 0 ? `\n注意：${caveats.join('；')}。` : '') +
    '\n需要细节时直接读那个文件，不要让我把全文贴出来。';

  const items: InjectionItem[] = [{ type: 'text', text }];
  for (const image of (input.keyImages ?? []).slice(0, MAX_KEY_IMAGES)) {
    items.push({ type: 'localImage', path: image });
  }
  // Mention 指向目录而不是 content.md：agent 常常还要看 assets/ 里的页图
  items.push({ type: 'mention', name: fileName, path: uploadDir });
  return items;
}

/** 代码文件与图片走的是**不解析**这条路（08 §3.3 的最后两行）。 */
export function buildPassThrough(
  kind: 'code' | 'image',
  fileName: string,
  path: string,
): readonly InjectionItem[] {
  return kind === 'image'
    ? [{ type: 'localImage', path }]
    : [{ type: 'mention', name: fileName, path }];
}
