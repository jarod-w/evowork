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

/** 附件说明的第一行：告诉模型、记忆提取与用户，这段不是用户自己写的。 */
export const ATTACHMENT_NOTE_LABEL = '【附件说明 · 由 EvoWork 自动生成，不是用户的原话】';

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
  const { body, description } = splitFrontmatter(markdown);
  const lines = body.split('\n');

  // 开头的 YAML frontmatter 不是正文：2026-10-07 用户上传 SKILL.md，摘要首段就是一个「---」。
  // 有 description 时它就是作者写的那句"这是什么"，比正文首段更准
  const firstParagraph =
    description ??
    lines
      .find(
        (line) =>
          line.trim() !== '' &&
          !line.startsWith('#') &&
          !line.startsWith('|') &&
          !line.startsWith('>') &&
          !/^\s*([-*_])\1{2,}\s*$/.test(line),
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

  // 各段自带的句末标点先去掉再用「。」接：首段多半以句号结尾，原先拼出来是「提纲。。包含章节」
  const summary = parts.map((part) => part.replace(/[。．.！!？?；;]+$/u, '')).join('。');
  return summary.length <= limit ? summary : `${summary.slice(0, limit - 1)}…`;
}

/** 只认文件开头那一段 `---` … `---`；`description:` 只取单行写法，多行的不猜。 */
function splitFrontmatter(markdown: string): { body: string; description?: string } {
  const match = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(markdown);
  if (!match) return { body: markdown };
  const body = markdown.slice(match[0].length);
  const line = /^description:[ \t]*(.+)$/m.exec(match[1] ?? '')?.[1]?.trim();
  const description = line?.replace(/^(['"])(.*)\1$/, '$2').trim();
  return description && !/^[|>]/.test(description) ? { body, description } : { body };
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

  /*
   * **第三人称，并在第一行写明出处**（2026-10-22）。这段文字和用户输入的话同在一条 user 消息里，
   * 内核的记忆提取只认得 AGENTS.md 与 `<skill>` 两类附注、会把其余内容都当用户原话 ——
   * 旧版写成「不要让我把全文贴出来」，被记成了用户偏好。它也原样显示在用户的气泡里，
   * 所以标注用中文写给人看，不用标签。
   */
  const text =
    `${ATTACHMENT_NOTE_LABEL}\n` +
    `用户上传了《${fileName}》，EvoWork 已在本机解析，正文在 ${uploadDir}content.md（${scaleOf(result)}）。` +
    (summary ? `\n摘要：${summary}` : '') +
    (caveats.length > 0 ? `\n注意：${caveats.join('；')}。` : '') +
    '\n需要细节时直接读该文件，不必请用户粘贴全文。';

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
