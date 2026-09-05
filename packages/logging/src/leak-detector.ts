/**
 * 泄露检测器 —— 09 §8 明写的那条 CI 断言的实现：
 *
 *   > 配套一个 CI 测试：跑一次真实任务，断言日志与 trace 里不出现输入文本的任何 8 字以上片段。
 *
 * 为什么是"8 字以上片段"而不是"整段文本"：真实泄露几乎从不是整段原文出现，而是
 * 错误消息里带了一句、trace attribute 里带了个标题、异常堆栈里带了半个参数。整段匹配全都测不到。
 *
 * 中英文都按**字符**（code point）滑窗，不按字节也不按词：中文 8 个字已经能唯一识别一份文档
 * （「鹏程公司二季度逾期」），英文 8 个字符偏短但会被归一化后的空白折叠抵消一部分误报。
 */

export interface LeakOptions {
  /** 滑窗长度（字符）。默认 8，与 09 §8 的措辞一致 */
  readonly minGram?: number;
  /** 最多返回几条命中（避免报告爆炸） */
  readonly maxFindings?: number;
  /**
   * 是否把「纯数字与标点」的片段也算泄露。**默认 false**，理由见下。
   *
   * 时间戳是这条断言最大的误报源：上传目录叫 `20260905-093012-q2`，而同一条日志里
   * 合法地记着 `requestId: req-20260905-01` —— 两者共享 8 个字符 `20260905`，
   * 但那不是泄露，只是同一天。
   *
   * 这个默认值是**明确的取舍，不是疏忽**：误报会让人整体关掉这条断言，那时真泄露也一起放行；
   * 而漏掉"纯数字的秘密"（如一个金额）可以通过给那类断言显式开 `includeNumericGrams: true`
   * 来覆盖。取舍写在这里，不写在某次 code review 的对话里。
   */
  readonly includeNumericGrams?: boolean;
}

/** 片段是否只由数字与路径/日期常见标点组成 —— 这类片段的信息量太低，撞车概率太高。 */
function isLowEntropyGram(gram: string): boolean {
  return /^[0-9\-_/:.+#]+$/.test(gram);
}

export interface Leak {
  /** 命中的片段（原文中的字符窗口） */
  readonly gram: string;
  /** 它在被检查文本中的位置（归一化后的索引，仅供定位） */
  readonly index: number;
}

/**
 * 归一化：折叠所有空白、去掉常见的转义与引号噪声。
 *
 * 必要性：日志是 JSON，正文若泄露会带上 `\n` `\"` 这类转义；不归一化就会漏掉
 * 「转义之后不再逐字相同」的泄露 —— 而那恰恰是最常见的形态。
 */
function normalize(text: string): string {
  return text
    .replaceAll('\\n', '\n')
    .replaceAll('\\r', '\r')
    .replaceAll('\\t', '\t')
    .replaceAll('\\"', '"')
    .replaceAll('\\\\', '\\')
    .replace(/\s+/gu, '');
}

/**
 * 找出 `secret` 中长度 ≥ minGram 的片段在 `haystack` 里的出现。
 *
 * 返回空数组 = 没找到泄露。**注意它是必要条件不是充分条件**：它证明"原文的连续片段没出现"，
 * 不证明"没有任何信息泄露"（比如把标题逐字打乱后写进日志它测不到）。
 * 所以它是防线之一，另一条防线是 `fields.ts` 的注册表（结构上就写不进去）。
 */
export function findLeaks(haystack: string, secret: string, options: LeakOptions = {}): Leak[] {
  const minGram = options.minGram ?? 8;
  const maxFindings = options.maxFindings ?? 5;
  const includeNumeric = options.includeNumericGrams ?? false;

  const hay = normalize(haystack);
  const needleChars = [...normalize(secret)];
  if (needleChars.length < minGram || hay.length === 0) return [];

  const found: Leak[] = [];
  const seen = new Set<string>();

  for (let i = 0; i + minGram <= needleChars.length; i += 1) {
    const gram = needleChars.slice(i, i + minGram).join('');
    if (seen.has(gram)) continue;
    seen.add(gram);
    if (!includeNumeric && isLowEntropyGram(gram)) continue;
    const at = hay.indexOf(gram);
    if (at >= 0) {
      found.push({ gram, index: at });
      if (found.length >= maxFindings) break;
    }
  }
  return found;
}

export class LeakDetected extends Error {
  override readonly name = 'LeakDetected';
  constructor(
    readonly leaks: readonly Leak[],
    readonly where: string,
  ) {
    super(
      `在 ${where} 里发现了输入文本的片段（${leaks.length} 处）：` +
        leaks.map((l) => `「${l.gram}」@${l.index}`).join('、') +
        `。Q14 要求日志 / APM trace / 错误上报三条路径都不带正文；` +
        `记路径用 pathFields()，记错误用 errorFields()，记同一性用 digest()。`,
    );
  }
}

/**
 * 断言若干段敏感文本都没有泄露到 `haystack` 里。
 *
 * 典型用法（测试与 M0 的可审计手段）：把一次真实任务的输入文本全部收集起来，
 * 对「本机日志文件全文 + 导出的 trace + 上报的错误 payload」逐一断言。
 */
export function assertNoLeak(
  haystack: string,
  secrets: readonly string[],
  where = '日志输出',
  options: LeakOptions = {},
): void {
  const all: Leak[] = [];
  for (const secret of secrets) {
    all.push(...findLeaks(haystack, secret, options));
  }
  if (all.length > 0) throw new LeakDetected(all, where);
}
