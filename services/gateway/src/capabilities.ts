/**
 * 能力声明（D2 的语义矩阵 + Q16 的 P0 三家）。
 *
 * ## 为什么能力声明是**声明式**的而不是**流式**的
 *
 * D2 要求「降级必须显式：网关在响应里标注能力缺失，前端据此隐藏对应 UI」。
 * 实测发现"在响应里标注"这条路走不通：内核对未知 SSE 事件只记 trace 日志
 * （`sse/responses.rs:548`），自定义事件到不了前端；响应头也不透传。
 *
 * 所以落法改成：**桌面 App 直接读网关的能力端点**（`GET /v1/evowork/models`），
 * 按 model 拿到能力位，据此隐藏/划除 UI（03 §4.5 的能力徽标：「缺失能力必须显示为灰色划除
 * 而非隐藏」）。per-response 的降级仍然会发一条自定义事件 + 记一条 metric，
 * 但那是**诊断用途**，不是 UI 数据源 —— 这个区分必须写在这里，否则以后有人会去实现
 * 一个永远不会被前端收到的"降级提示"。
 *
 * ## 六项能力对应 D2 的矩阵
 *
 * | 能力 | 缺失时的后果 | 前端行为 |
 * |---|---|---|
 * | `streaming` | 只能整体返回 | 无（网关会把整体响应切成事件流） |
 * | `toolCalls` | 不能用任何工具 | 该模型在下拉里标注"不支持工具"，办公场景直接不可用 |
 * | `parallelToolCalls` | 一次只能调一个工具 | 无（网关串行化并合并，见 `from-chat.ts`） |
 * | `reasoning` | 无思维链 | **推理过程折叠区整体不渲染**（04 §5.2 #3），**不留空壳** |
 * | `promptCache` | 无缓存命中 | 用量视图里 cache 命中如实显示 0（10 §5.2） |
 * | `imageInput` | 不能收图片 | 附件区拒绝图片并说明"当前模型不支持图片输入"（03 §8） |
 */

export interface ModelCapabilities {
  readonly streaming: boolean;
  readonly toolCalls: boolean;
  readonly parallelToolCalls: boolean;
  readonly reasoning: boolean;
  readonly promptCache: boolean;
  readonly imageInput: boolean;
  readonly maxContextTokens: number;
}

export interface ModelEntry {
  /** 对外的模型 id（内核 `config.toml` 里配的就是这个） */
  readonly id: string;
  /** 厂商 */
  readonly provider: ProviderId;
  /** 上游真实模型名 */
  readonly upstreamModel: string;
  readonly displayName: string;
  readonly capabilities: ModelCapabilities;
  /**
   * 这一档在 EvoWork 里的定位。`light` 档要在 UI 上说清它的取舍 ——
   * Q16 把 GLM-5.3-flash 列进 P0 就是为了**用它验证产物质量的下限**（R4），
   * 而不是因为它足够好。
   */
  readonly tier: 'flagship' | 'standard' | 'light';
}

export type ProviderId = 'deepseek' | 'moonshot' | 'zhipu' | 'private';

/**
 * P0 三家（Q16）。**能力位分两种来源**：真实 endpoint 实测，与公开文档。
 *
 * ⚠️ 这张表里的每一个 `true` 都需要被真实 endpoint 验证过才算成立（work-priority §10 的 U2）。
 *
 * ## `verified` 为什么不是一个布尔值就够
 *
 * 2026-09-05 拿到 DeepSeek 的 key 后跑了一遍探针（`scripts/verify-provider.mjs`），
 * 发现"这个模型验过了吗"这个问题**没有整块的答案**：流式语义、工具调用、reasoning、
 * cache 口径都实测了，但 `maxContextTokens` 要塞满上下文才能测，探针不会去做。
 *
 * 如果只有一个布尔值，这种情况下的诚实选择只剩两个：标 false（抹掉已经拿到的结论），
 * 或标 true（把一个没测过的数字说成测过了）。所以改成 `verifiedAt` + `unverified` 列表：
 * **说清验过什么、没验什么**。能力端点把这两个字段一起吐给前端与运维。
 */
export interface ModelRegistryEntry extends ModelEntry {
  readonly verified: boolean;
  /** 实测日期（ISO 日期）。`verified: false` 时为 undefined */
  readonly verifiedAt?: string;
  /** 仍未被真实 endpoint 证实的能力键。空数组 = 整行都实测过 */
  readonly unverified: readonly (keyof ModelCapabilities)[];
  readonly notes: string;
}

export const P0_MODELS: readonly ModelRegistryEntry[] = [
  {
    id: 'evowork/deepseek-chat',
    provider: 'deepseek',
    upstreamModel: 'deepseek-chat',
    displayName: 'DeepSeek Chat',
    tier: 'standard',
    verified: true,
    verifiedAt: '2026-09-05',
    // 上下文长度要塞满才能测，探针不做；其余五项都是实测
    unverified: ['maxContextTokens'],
    notes:
      '基准实现（D2）。2026-09-05 实测：流式增量在 choices[0].delta.content；' +
      '**不吐 reasoning_content**（与 reasoning:false 一致）；并行工具调用成立' +
      '（一次返回 get_weather + get_time 两个 tool_calls）；usage 带 ' +
      'prompt_cache_hit_tokens / prompt_cache_miss_tokens。',
    capabilities: {
      streaming: true,
      toolCalls: true,
      parallelToolCalls: true,
      reasoning: false,
      promptCache: true,
      imageInput: false,
      maxContextTokens: 128_000,
    },
  },
  {
    id: 'evowork/deepseek-reasoner',
    provider: 'deepseek',
    upstreamModel: 'deepseek-reasoner',
    displayName: 'DeepSeek Reasoner',
    tier: 'flagship',
    verified: true,
    verifiedAt: '2026-09-05',
    unverified: ['maxContextTokens'],
    notes:
      '推理型号：思维链走 delta.reasoning_content，映射为 reasoning item（D2）。' +
      '2026-09-05 实测**订正了一处**：原表写 parallelToolCalls: false，实测一次返回两个 ' +
      'tool_calls，改为 true。推理帧占比很高（20 帧里 17 帧是 reasoning_content），' +
      '这决定了 04 §5.2 #3 的折叠区默认必须是折叠的。',
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
  {
    /*
     * 2026-09-05 探针发现的型号：**它是个推理模型**，尽管名字里带 flash。
     *
     * 这条记下来是因为它推翻了一个很自然的假设："带 flash 的是轻量非推理档"。
     * 实测 18 帧里 15 帧是 reasoning_content —— 如果按名字猜着填 reasoning: false，
     * `from-chat.ts` 会走进"上游给了思维链但能力表说没有"的分支：
     * 推理区整块不显示，而用户只会觉得"这个模型怎么想都不想就答"。
     */
    id: 'evowork/deepseek-v4-flash',
    provider: 'deepseek',
    upstreamModel: 'deepseek-v4-flash',
    displayName: 'DeepSeek V4 Flash',
    tier: 'standard',
    verified: true,
    verifiedAt: '2026-09-05',
    unverified: ['maxContextTokens'],
    notes:
      '快档推理模型。2026-09-05 实测：流式 65 帧里 44 帧 reasoning_content、21 帧 content；' +
      '并行工具调用成立（index 0/1 两个函数）；usage 帧**同时带 choices 与 finish_reason**' +
      '（与 OpenAI 的空 choices 不同，`from-chat.ts` 先取 usage 再遍历 choices，两者都不丢）。' +
      '**图片：接受请求形状但看不见** —— 发一张 32×32 纯红图，它 HTTP 200 然后回"无法识别"。' +
      '所以 imageInput 标 false：这是三家里唯一"不报错但也看不见"的，' +
      '标 true 的代价是用户传了图、等了半天、拿到一句无法识别（D2「降级必须显式」）。',
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
  {
    id: 'evowork/kimi-k3',
    provider: 'moonshot',
    upstreamModel: 'kimi-k3',
    displayName: 'Kimi K3',
    tier: 'flagship',
    verified: true,
    verifiedAt: '2026-09-05',
    unverified: ['maxContextTokens'],
    notes:
      '2026-09-05 实测：**是推理模型**（64 帧里 61 帧 reasoning_content，原表按 K2 写的 false 已订正）；' +
      '并行工具调用成立；**真的能看图**（32×32 纯红图答"红色"）；' +
      'cache 计数在 usage 的**顶层 `cached_tokens`**，与另两家都不同；' +
      '未知模型返回 404 且 **error 里没有 code、语义在 type** —— 这条暴露了错误映射的一个真缺陷（见 registry.ts）。',
    capabilities: {
      streaming: true,
      toolCalls: true,
      parallelToolCalls: true,
      reasoning: true,
      promptCache: true,
      imageInput: true,
      maxContextTokens: 256_000,
    },
  },
  {
    id: 'evowork/glm-flash',
    provider: 'zhipu',
    upstreamModel: 'glm-5.3-flash',
    displayName: 'GLM 5.3 Flash',
    tier: 'light',
    verified: true,
    verifiedAt: '2026-09-05',
    unverified: ['maxContextTokens'],
    notes:
      'Q16 把它列入 P0 是为了验证产物质量的**下限**（R4）——不达标就换旗舰档，**不靠加模板硬扛**（总纲原话）。' +
      '2026-09-05 实测：**是推理模型**（65 帧里 64 帧 reasoning_content，原表 false 已订正）；' +
      '并行工具调用成立；**能看图**（答"红色"）；cache 走嵌套的 prompt_tokens_details.cached_tokens；' +
      '未知模型 400 + error.code="1214"（不在已知码表里，靠状态码兜底到 invalid_prompt）。' +
      '**产物质量本身仍未评估**（U1）—— 这里验的是协议语义，不是它写得好不好。',
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
];

/** 缺失能力的用户可见文案（03 §8 / 04 §5.2 #3）。 */
export const CAPABILITY_COPY: Readonly<Record<keyof ModelCapabilities, string>> = Object.freeze({
  streaming: '这个模型不支持流式输出，回复会一次性出现。',
  toolCalls: '这个模型不支持调用工具，无法完成需要读写文件或执行命令的任务。',
  parallelToolCalls: '这个模型一次只能调用一个工具，复杂任务会更慢。',
  reasoning: '这个模型没有可展示的推理过程。',
  promptCache: '这个模型不支持提示缓存，重复上下文不会更便宜。',
  imageInput: '这个模型不支持图片输入，可切换模型。',
  maxContextTokens: '',
});

export interface CapabilityLookup {
  find(modelId: string): ModelRegistryEntry | undefined;
  list(): readonly ModelRegistryEntry[];
}

export function createModelRegistry(extra: readonly ModelRegistryEntry[] = []): CapabilityLookup {
  const all = [...P0_MODELS, ...extra];
  const byId = new Map(all.map((m) => [m.id, m]));
  return {
    find: (modelId) => byId.get(modelId) ?? byId.get(`evowork/${modelId}`),
    list: () => all,
  };
}

/**
 * 一次请求里发生的降级。
 *
 * 每一项都是"我们做了什么与请求不完全一致的事"，用于：
 *   ① 一条自定义 SSE 事件（诊断，内核会忽略）；
 *   ② metrics 计数（运维看趋势）；
 *   ③ 日志字段 `degradeReason`（Q14 允许：它是码不是正文）。
 */
export type DegradeReason =
  /** 请求要求并行工具调用，上游不支持 → 串行化 */
  | 'PARALLEL_TOOLS_SERIALIZED'
  /** 请求带图片，上游不支持 → **拒绝请求**（不静默丢图） */
  | 'IMAGE_INPUT_UNSUPPORTED'
  /** 上游没有思维链 → reasoning 段留空，不伪造 */
  | 'NO_REASONING'
  /** 上游不报 cache 命中 → 如实上报 0 */
  | 'NO_PROMPT_CACHE'
  /** 上游不报用量 → 省略 usage 而不是编一个 */
  | 'NO_USAGE_REPORTED'
  /** 上游不支持流式 → 网关把整体响应切成事件流 */
  | 'NON_STREAMING_UPSTREAM';

export const DEGRADE_COPY: Readonly<Record<DegradeReason, string>> = Object.freeze({
  PARALLEL_TOOLS_SERIALIZED: '上游不支持并行工具调用，已改为串行执行（会更慢）。',
  IMAGE_INPUT_UNSUPPORTED: '这个模型不支持图片输入。',
  NO_REASONING: '这个模型没有推理过程可展示。',
  NO_PROMPT_CACHE: '这个模型不支持提示缓存，缓存命中如实记为 0。',
  NO_USAGE_REPORTED: '上游没有返回用量数据，本次用量未计入。',
  NON_STREAMING_UPSTREAM: '上游不支持流式，回复会一次性出现。',
});
