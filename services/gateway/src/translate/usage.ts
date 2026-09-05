/**
 * 用量规范化（D2 语义矩阵的第六行：token 用量口径）。
 *
 * ## 为什么这个小文件值得单独存在
 *
 * 内核对 `usage` 的反序列化有三条**会让整条流失败**的硬约束（见 `protocol.ts` 的头注释）：
 * `input_tokens_details` 一旦出现必须带 `cached_tokens`、`output_tokens_details` 一旦出现
 * 必须带 `reasoning_tokens`、`usage` 一旦出现三个总数必须齐。
 *
 * 而国内三家的用量字段参差不齐（有的没有 `prompt_cache_hit_tokens`，有的把它叫别的名字，
 * 有的干脆不报）。把"拼装 usage"这件事散落在各个 provider 适配里，等于给每家一次
 * 踩这三条约束的机会 —— 所以收敛到这里，并逐条钉住测试。
 *
 * ## 一条诚实性要求（Q14 / 10 §5.2）
 *
 * 不支持 cache 的模型**如实上报 0 命中**，不猜、不按比例估算。
 * 10 §5.2 的原话：「cache 命中率在不支持的模型上如实显示 0（避免配额口径失真）」。
 * 同理，上游完全不报用量时**省略 `usage` 字段**而不是编一个 —— 编出来的数字会进配额，
 * 而配额是要向用户结算的东西。
 */
import type { DegradeReason } from '../capabilities.js';
import type { ResponsesUsage } from '../protocol.js';

/** Chat Completions 的用量形状（各家的并集，字段都可能缺）。 */
export interface ChatUsage {
  readonly prompt_tokens?: number;
  readonly completion_tokens?: number;
  readonly total_tokens?: number;
  /** DeepSeek：命中缓存的 prompt token 数（实测 2026-09-05） */
  readonly prompt_cache_hit_tokens?: number;
  readonly prompt_cache_miss_tokens?: number;
  /**
   * Kimi：**顶层** `cached_tokens`（实测 2026-09-05，流式的 usage 帧里）。
   *
   * 三家给了三种写法：DeepSeek 用 `prompt_cache_hit_tokens`、GLM 用嵌套的
   * `prompt_tokens_details.cached_tokens`、Kimi 用顶层 `cached_tokens`。
   * 少认一种的后果不是报错，而是**这家的 cache 命中永远显示 0** ——
   * 而 0 是"不支持 cache"的合法取值，所以没人会发现它是漏读。
   */
  readonly cached_tokens?: number;
  /** OpenAI 兼容层常见的嵌套形状（GLM 实测走这个） */
  readonly prompt_tokens_details?: { readonly cached_tokens?: number };
  readonly completion_tokens_details?: { readonly reasoning_tokens?: number };
}

export interface NormalizedUsage {
  readonly usage: ResponsesUsage | undefined;
  readonly degradations: readonly DegradeReason[];
}

export interface NormalizeOptions {
  readonly supportsPromptCache: boolean;
  readonly supportsReasoning: boolean;
}

function nonNegativeInt(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined;
  return Math.round(value);
}

export function normalizeUsage(
  raw: ChatUsage | undefined | null,
  options: NormalizeOptions,
): NormalizedUsage {
  const degradations: DegradeReason[] = [];

  if (!raw) {
    // **不编数字**：省略 usage 是合法的（内核侧是 Option），编一个会进用户的配额
    return { usage: undefined, degradations: ['NO_USAGE_REPORTED'] };
  }

  const input = nonNegativeInt(raw.prompt_tokens);
  const output = nonNegativeInt(raw.completion_tokens);
  if (input === undefined || output === undefined) {
    // 三个总数必须齐（硬约束 3）。缺任何一个就整体省略 —— 半个 usage 会让内核解析失败，
    // 那比没有 usage 严重得多（整个回合失败 vs 用量少记一次）
    return { usage: undefined, degradations: ['NO_USAGE_REPORTED'] };
  }
  const total = nonNegativeInt(raw.total_tokens) ?? input + output;

  // cache：只有上游真的报了才填非零；不支持时如实 0（10 §5.2）
  const cachedRaw =
    nonNegativeInt(raw.prompt_cache_hit_tokens) ??
    nonNegativeInt(raw.prompt_tokens_details?.cached_tokens) ??
    nonNegativeInt(raw.cached_tokens);
  const cached = options.supportsPromptCache ? (cachedRaw ?? 0) : 0;
  if (!options.supportsPromptCache) degradations.push('NO_PROMPT_CACHE');

  const reasoningRaw = nonNegativeInt(raw.completion_tokens_details?.reasoning_tokens);
  const reasoning = options.supportsReasoning ? (reasoningRaw ?? 0) : 0;
  if (!options.supportsReasoning && reasoningRaw === undefined) {
    // 无思维链不算"用量降级"，它在能力声明里已经表达过，这里不重复报
  }

  return {
    usage: {
      input_tokens: input,
      output_tokens: output,
      total_tokens: total,
      // 硬约束 1：给了 details 就必须带 cached_tokens
      input_tokens_details: { cached_tokens: cached },
      // 硬约束 2：给了 details 就必须带 reasoning_tokens
      output_tokens_details: { reasoning_tokens: reasoning },
    },
    degradations,
  };
}
