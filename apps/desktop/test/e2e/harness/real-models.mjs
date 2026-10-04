/**
 * 真模型 UI 测试可选的模型（`EVOWORK_UI_MODEL_PRESET`，默认 `deepseek-flash`）。
 *
 * 按**用户在设置页加自定义模型**那条路走（11 §4.1）：网关从 `EVOWORK_CUSTOM_MODELS` 读元数据，
 * 密钥在 `keyEnv` 指向的环境变量里（值由 `EVOWORK_UI_MODEL_KEY` 给，不写进任何文件）。
 *
 * 放在一个模块里是因为两处要用同一份：`ui-entry.mjs` 把它交给网关，
 * 验收 spec 的 preflight 用同一个 `baseUrl` 探上游 —— 两处各写一份的话，换了模型只改了一处，
 * preflight 就会去探一个根本没在用的 endpoint。
 *
 * 能力位一律来自实测（`scripts/verify-provider.mjs`），不是照厂商文档抄的：
 * 写错的后果是静默的（比如声明支持看图，内核就会把图发过去，模型却在编）。
 */
export const REAL_MODEL_PRESETS = Object.freeze({
  /** 能力位抄自 `known-models.ts` 的 `deepseek-flash`（2026-09-26 实测 23 条全通过） */
  'deepseek-flash': {
    id: 'deepseek/deepseek-flash',
    displayName: 'DeepSeek Flash',
    provider: 'deepseek',
    upstreamModel: 'deepseek-flash',
    baseUrl: 'https://api.deepseek.com',
    probeUrl: 'https://api.deepseek.com/models',
    capabilities: {
      streaming: true,
      toolCalls: true,
      parallelToolCalls: true,
      reasoning: true,
      promptCache: true,
      imageInput: true,
      maxContextTokens: 128_000,
    },
  },
  /**
   * 硅基流动上的腾讯混元 Hy4 预览版，走通用 OpenAI 兼容适配（`private`）。
   * 2026-10-01 `verify-provider.mjs` 实测：流式 · 工具调用（含一轮两个）· usage 带 cache 口径字段 ·
   * **会吐 reasoning_content**（所以 reasoning 是 true）。看图没测，按保守侧关掉；
   * 上下文长度没有实测依据，按 128k 保守写。
   */
  'hy4-preview': {
    id: 'siliconflow/hy4-preview',
    displayName: 'Hunyuan Hy4 Preview',
    provider: 'private',
    upstreamModel: 'tencent/Hy4-preview',
    baseUrl: 'https://api.siliconflow.cn/v1',
    probeUrl: 'https://api.siliconflow.cn/v1/models',
    capabilities: {
      streaming: true,
      toolCalls: true,
      parallelToolCalls: true,
      reasoning: true,
      promptCache: true,
      imageInput: false,
      maxContextTokens: 128_000,
    },
  },
  /**
   * 小米 MiMo v2.6 Flash，走通用 OpenAI 兼容适配（`private`）。
   * 2026-10-01 `verify-provider.mjs` 实测 21/21：流式 · reasoning_content · 工具调用（含一轮两个）·
   * 第二次同 prompt 报出 cache 命中（`prompt_tokens_details.cached_tokens`）· 未知模型回 4xx 且可识别。
   * 看图 2026-10-04 补测（`--image true`，23/23）：纯红图答出了「红」。之前按保守侧关着，
   * 结果多附件那条整轮被网关拒掉（「当前模型不支持图片输入」）—— 拒得对，是能力位写错了。
   * 上下文长度没有实测依据，按 128k 保守写（厂商文档写的是 1M）。
   */
  'mimo-v2.6-flash': {
    id: 'xiaomi/mimo-v2.6-flash',
    displayName: 'MiMo v2.6 Flash',
    provider: 'private',
    upstreamModel: 'mimo-v2.6-flash',
    baseUrl: 'https://api.xiaomimimo.com/v1',
    probeUrl: 'https://api.xiaomimimo.com/v1/models',
    capabilities: {
      streaming: true,
      toolCalls: true,
      parallelToolCalls: true,
      reasoning: true,
      promptCache: true,
      imageInput: true,
      maxContextTokens: 128_000,
    },
  },
});

/** 选中的预设。拼错就当场报错 —— 静默回落到默认模型会让人以为测的是另一个 */
export function selectRealModel(env = process.env) {
  const name = env.EVOWORK_UI_MODEL_PRESET ?? 'deepseek-flash';
  const preset = REAL_MODEL_PRESETS[name];
  if (!preset) {
    throw new Error(
      `不认识的 EVOWORK_UI_MODEL_PRESET「${name}」。可选：${Object.keys(REAL_MODEL_PRESETS).join(' / ')}`,
    );
  }
  return { name, ...preset };
}
