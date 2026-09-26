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
import { builtinModelEntries } from './known-models.js';

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
 *
 * 已下架型号的实测记录保留在总纲 §D2；运行时目录只列当前仍存在的型号。
 * 场景不再绑定具体模型，避免以后每次模型下架都同时修改三份场景配置。
 */
export interface ModelRegistryEntry extends ModelEntry {
  /**
   * 这个模型**不许用**，且这句话可以直接显示给用户（如"已被你所在组织停用"）。
   *
   * 只由 `mergeModelLayers`（`layers.ts` 的第②层）写。**缺席 = 允许** ——
   * 方向是刻意的：一台没有企业策略包的个人机器必须能用 BYOK（Q30=A），
   * 默认成"禁"会让个人用户一个模型都选不了。
   *
   * 被停用的模型**仍然出现在目录里**（11 §4.1）：消失的东西无法被排查。
   * 拦截点在 `server.ts` 的 `/v1/responses` —— 目录列它、请求拒它。
   */
  readonly denied?: string;
  readonly verified: boolean;
  /** 实测日期（ISO 日期）。`verified: false` 时为 undefined */
  readonly verifiedAt?: string;
  /** 仍未被真实 endpoint 证实的能力键。空数组 = 整行都实测过 */
  readonly unverified: readonly (keyof ModelCapabilities)[];
  readonly notes: string;
}

/**
 * P0 三家里**当前仍在目录中**的型号（Q16）。
 *
 * **它是派生的，不是手写的** —— 真源是 `known-models.ts` 里那张按
 * (协议适配类型, 上游模型名) 索引的表。2026-09-26 改成派生的理由写在那个文件头：
 * 在此之前，同一个 `kimi-k3` 从内置目录进来能读图、被用户加成自定义模型就不能了，
 * 因为能力位有两条互不相通的来路。
 *
 * 已下架型号的实测记录保留在 `known-models.ts`（以及总纲 §D2）；
 * 目录里只列当前仍存在的型号 —— 下架 = 去掉那条的 `builtinId`，**不是删掉能力知识**。
 */
export const P0_MODELS: readonly ModelRegistryEntry[] = builtinModelEntries();

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

/**
 * 泛型是为了让**合并层的结果不丢类型**：`services/gateway/src/layers.ts` 的
 * `ResolvedModel` 多带 `credentialSource` 与 `layer`，而模型目录端点必须透出前者
 * （11 §4.2：用户要能看出这次调用花谁的钱、数据过谁的境）。
 * 写成非泛型的话，`server.ts` 拿到的 `list()` 就退化成基类型，
 * 那个字段只能靠一次 `as` 找回来 —— 而 `as` 正是"两个模块各自对、合起来不对"的入口。
 */
export interface CapabilityLookup<T extends ModelRegistryEntry = ModelRegistryEntry> {
  find(modelId: string): T | undefined;
  list(): readonly T[];
}

/**
 * 从**一份确定的清单**建注册表。`list()` 返回的就是它，一条不多。
 *
 * ## 为什么需要这个而不是只有 `createModelRegistry`
 *
 * 2026-09-06 接模型下拉时实测发现的缺陷：`main.ts` 拿 `availableModels()`（按密钥
 * 过滤过的子集）当 `extra` 传给 `createModelRegistry`，而后者的实现是
 * `[...P0_MODELS, ...extra]` —— 于是
 *
 *   ① 每个模型在 `list()` 里出现**两次**；
 *   ② 更糟的是 **`P0_MODELS` 被无条件加了回来**：只配了 DeepSeek 密钥时，
 *      端点照样列出 Kimi 与 GLM。用户选中它、发出去、拿到一个 401 ——
 *      而"按密钥过滤"这件事正是模型下拉不走内核 `model/list` 的**决定性理由**（F24）。
 *
 * 两个函数各自都是对的（过滤对、组合对），合起来是错的
 * （CLAUDE.md §9.1）。这个缺陷在此之前看不见，因为没有任何 UI 消费过 `list()`。
 *
 * **同 id 后来者覆盖前者**（企业用私有 endpoint 覆盖某个内置型号是实际场景），
 * 位置保持第一次出现时的位置 —— 下拉的顺序不该因为一次覆盖而跳动。
 */
export function createModelRegistryFrom<T extends ModelRegistryEntry>(
  models: readonly T[],
): CapabilityLookup<T> {
  const byId = new Map<string, T>();
  for (const model of models) byId.set(model.id, model);
  const all = [...byId.values()];
  return {
    find: (modelId) => byId.get(modelId) ?? byId.get(`evowork/${modelId}`),
    list: () => all,
  };
}

/** P0 三家 + 额外条目（企业自定义 / 测试用）。**要"只有这些"时用 `createModelRegistryFrom`**。 */
export function createModelRegistry(extra: readonly ModelRegistryEntry[] = []): CapabilityLookup {
  return createModelRegistryFrom([...P0_MODELS, ...extra]);
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
