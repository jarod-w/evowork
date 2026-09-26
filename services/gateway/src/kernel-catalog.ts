/**
 * 给内核的模型目录（`model_catalog_json`）。
 *
 * ## 为什么需要它
 *
 * 内核不认识我们的任何一个模型 —— 用户机器上的内核日志里是这句：
 * `Unknown model deepseek/deepseek-flash is used. This will use fallback model metadata.`
 * 兜底元数据把**每一个**模型都按 `context_window: 272_000` 对待
 * （`models-manager/src/model_info.rs:99-137`），而内核的上下文压缩是**提前触发**的：
 * 到 `context_window × effective_context_window_percent(95%)` 就压缩。于是：
 *
 *   · **GLM 只有 128k** → 内核要等到 ~258k 才压缩，厂商在 128k 就拒了
 *     —— **压缩永远等不到**，长任务必然硬失败；
 *   · Kimi 256k → 阈值同样落在真实上限之外；
 *   · DeepSeek 1M → 反过来浪费掉七成多。
 *
 * `model_catalog_json` 是内核给的正规入口（F24 已经写过这条路），它**整份替换**内核自带的
 * 目录 —— 对我们正好：我们本来就不用它自带的那些型号。
 *
 * ## 为什么每一项都照着兜底值写，而不是"填得更好看"
 *
 * 这份 JSON 里的每个字段都会改变内核对这个模型的行为。我们要的只有一件事：
 * **让它知道上下文有多大**。所以除了 slug / 名字 / 上下文，其余全部逐字复刻
 * `model_info_from_slug` 今天已经在用的兜底值 —— 这样这次改动的行为差分**只有上下文**，
 * 出了问题也只可能出在这一处。
 *
 * 尤其是 `input_modalities`：兜底值是 `["text","image"]`，**这里必须原样保留**。
 * 按我们能力表把看不见图的模型改成 `["text"]` 看着更"准确"，实际后果是
 * **内核会在发给网关之前把图片悄悄摘掉** —— 而 D2 / `to-chat.ts` 坑 3 要求的是
 * **显式拒绝并告诉用户**。那是一次把文档承诺换成静默降级的"改进"。
 *
 * ## 上游改了这个结构怎么办
 *
 * `ModelInfo` 有 17 个必填字段（`protocol/src/openai_models.rs`）。上游加一个必填字段，
 * 内核就会**拒绝加载整份配置**，表现是所有任务都起不来。两道防线：
 *   ① 漂移雷达 F34 钉住必填字段集合与我们依赖的几个枚举拼法，上游一改就红；
 *   ② 写入方（`service-host.ts`）生成失败时**不写 `model_catalog_json` 这个键** ——
 *      没有目录只是回到今天的行为，而一份坏目录是全线停摆。
 */

/** 内核 `TruncationPolicyConfig`（`mode` 是 snake_case 枚举）。 */
interface TruncationPolicy {
  readonly mode: 'bytes' | 'tokens';
  readonly limit: number;
}

/**
 * 我们发给内核的一条模型元数据。
 *
 * **只列我们真的要发的字段**：带 `#[serde(default)]` 的一律不发，让内核用它自己的默认值 ——
 * 少发一个字段是安全的，发错一个值不是。
 */
export interface KernelCatalogModel {
  readonly slug: string;
  readonly display_name: string;
  /**
   * 模型底稿。**内核要求每条模型都带**（`openai_models.rs:802-830` 的自定义反序列化：
   * `base_instructions` 与 `model_messages.instructions_template` 至少要有一个，
   * 否则整份目录解析失败 → 内核拒绝加载配置 → 所有任务都起不来）。
   *
   * 这里放的是**我们自己的那份**（`config/prompts/base-instructions.md`，F25 每次
   * `thread/start` 也传同一份）。不放内核自带的 `BASE_INSTRUCTIONS`：那段话里写着
   * "You are a coding agent running in the Codex CLI"，K5 的破口就是从这种地方漏的。
   */
  readonly base_instructions: string;
  readonly description: string | null;
  readonly supported_reasoning_levels: readonly never[];
  readonly shell_type: 'unified_exec';
  readonly visibility: 'none';
  readonly supported_in_api: boolean;
  readonly priority: number;
  readonly availability_nux: null;
  readonly upgrade: null;
  readonly support_verbosity: boolean;
  readonly default_verbosity: null;
  readonly apply_patch_tool_type: null;
  readonly truncation_policy: TruncationPolicy;
  readonly experimental_supported_tools: readonly never[];
  readonly tool_mode: null;
  readonly multi_agent_version: null;
  /** **这次改动的全部意义**：模型真实的上下文大小 */
  readonly context_window: number;
  readonly max_context_window: number;
  readonly input_modalities: readonly ['text', 'image'];
}

export interface KernelModelCatalog {
  readonly models: readonly KernelCatalogModel[];
}

/** 目录里一条模型需要的最少信息。 */
export interface CatalogSource {
  readonly id: string;
  readonly displayName: string;
  readonly maxContextTokens: number;
}

/**
 * 内核兜底元数据里与行为相关的那些值（`model_info.rs:99-137`，2026-09-26 逐字核对）。
 *
 * 抽成常量是为了让"我们没有改它"这件事在代码里看得见：每一项旁边都能对上内核那一行。
 */
const FALLBACK_BEHAVIOUR = {
  supported_reasoning_levels: [] as const,
  // `ConfigShellToolType::UnifiedExec`
  shell_type: 'unified_exec',
  // `ModelVisibility::None` —— 模型下拉读的是网关的能力端点，不是内核的清单（F24）
  visibility: 'none',
  supported_in_api: true,
  priority: 99,
  availability_nux: null,
  upgrade: null,
  support_verbosity: false,
  default_verbosity: null,
  apply_patch_tool_type: null,
  // `TruncationPolicyConfig::bytes(10_000)`
  truncation_policy: { mode: 'bytes', limit: 10_000 },
  experimental_supported_tools: [] as const,
  tool_mode: null,
  multi_agent_version: null,
  // `default_input_modalities()`。**不要按能力表收窄**，理由见文件头注释
  input_modalities: ['text', 'image'] as const,
} as const;

/** 上下文大小的下限。0 或负数进了目录，内核那边就是"这个模型装不下任何东西"。 */
const MIN_CONTEXT_TOKENS = 1_000;

/**
 * 把我们知道的模型翻译成内核的目录。
 *
 * 认不出上下文大小的（`maxContextTokens` 缺失或荒唐）**直接不进目录** ——
 * 那种模型回到内核的兜底值，也就是今天的行为；而瞎填一个数会让内核在错误的点压缩，
 * 那比不填更糟。
 *
 * `baseInstructions` 是产品身份底稿（F25 的同一份）。内核要求每条模型都带。
 */
export function buildKernelModelCatalog(
  models: readonly CatalogSource[],
  baseInstructions: string,
): KernelModelCatalog | undefined {
  // 没有底稿就别生成：内核会拒绝这份目录，而"没有目录"只是回到今天的行为
  if (baseInstructions.trim() === '') return undefined;
  const entries: KernelCatalogModel[] = [];
  const seen = new Set<string>();
  for (const model of models) {
    const window = model.maxContextTokens;
    if (!Number.isInteger(window) || window < MIN_CONTEXT_TOKENS) continue;
    if (model.id.trim() === '' || seen.has(model.id)) continue;
    seen.add(model.id);
    entries.push({
      slug: model.id,
      display_name: model.displayName === '' ? model.id : model.displayName,
      description: null,
      base_instructions: baseInstructions,
      ...FALLBACK_BEHAVIOUR,
      context_window: window,
      max_context_window: window,
    });
  }
  // 内核拒绝空目录（`config/mod.rs:2112`：must contain at least one model）。
  // 一条都没有时返回 undefined，调用方据此**不写那个配置键**
  return entries.length > 0 ? { models: entries } : undefined;
}
