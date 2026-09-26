/**
 * **我们对具体上游型号知道些什么** —— 能力位的唯一真源（D2 的语义矩阵）。
 *
 * ## 为什么需要这张表，而不是让每一层各自写一遍
 *
 * 2026-09-26 的缺陷：用户在设置页把 `moonshot/kimi-k3` 加成一条自有密钥模型，
 * 下拉里的「读图」是灰色划除的 —— 而**同一个仓库里的 `P0_MODELS` 早就写着
 * `imageInput: true`，还附着 2026-09-05 的实测记录**（32×32 纯红图答"红色"）。
 *
 * 原因是能力位当时有两条互不相通的来路：
 *   · 内置目录（① 层）走 `P0_MODELS`，能力位是实测出来的；
 *   · 自定义模型（③ 层）走 `DEFAULT_CUSTOM_CAPABILITIES`，**三个"高级"能力一律 false**。
 *
 * 那个保守默认本身没错（对一个我们没听说过的 endpoint，标 true 的代价由用户承担）。
 * 错的是它盖过了我们**确实知道**的事实：`kimi-k3` 就是 `kimi-k3`，不因为它从哪一层
 * 进来而改变能不能读图。两个模块各自都对、合起来不对（CLAUDE.md §9.1）。
 *
 * 所以能力位收敛到这一张按 **(协议适配类型, 上游真实模型名)** 索引的表：
 * 认得出来的按这里的结论，认不出来的才落到调用方的保守默认。
 * `P0_MODELS` 也从这里派生 —— 派生而不是"两处保持一致"，是因为后者靠人记着。
 *
 * ## `evidence` 为什么必须逐条写
 *
 * 这张表里既有**我们自己对着真实 endpoint 测出来的**结论，也有**只读了厂商文档**的。
 * 两者的可信度不一样，而 U2 的教训正是"文档说支持"与"真的能用"能差出一个缺陷：
 * `deepseek-v4-flash` 收下图片、回 HTTP 200、然后说"无法识别" —— 既不报错也看不见。
 * 它仍然留在这张表里且 `imageInput: false`，**就是为了让它不被"名字里有 flash"
 * 或者"DeepSeek 支持视觉"这类推断重新标成 true**。
 *
 * `evidence: 'probe'` → `verified: true` + `verifiedAt`；
 * `evidence: 'vendor-doc'` → `verified: false`，能力端点会如实告诉用户"这条没实测过"。
 */
import type { ModelCapabilities, ModelRegistryEntry, ProviderId } from './capabilities.js';

/** `ModelCapabilities` 的全部键。`unverified` 要"整组列出来"时用它，避免漏一项。 */
export const ALL_CAPABILITY_KEYS: readonly (keyof ModelCapabilities)[] = Object.freeze([
  'streaming',
  'toolCalls',
  'parallelToolCalls',
  'reasoning',
  'promptCache',
  'imageInput',
  'maxContextTokens',
]);

/** 这条结论是怎么来的。见文件头「`evidence` 为什么必须逐条写」。 */
export type CapabilityEvidence =
  /** `scripts/verify-provider.mjs` 打过真实 endpoint */
  | 'probe'
  /** 只读了厂商文档 —— 能力位可信，但**没有实测背书** */
  | 'vendor-doc';

export interface KnownModel {
  readonly provider: ProviderId;
  /** 上游真实模型名（厂商文档里的那个）。**索引键之一** */
  readonly upstreamModel: string;
  /**
   * 同一个型号的历史名 / 别名。厂商改名时老名字往往还能用一段时间，
   * 而用户 `models.toml` 里存的就是他当初填的那个。
   */
  readonly aliases?: readonly string[];
  readonly displayName: string;
  readonly tier: 'flagship' | 'standard' | 'light';
  /**
   * 进内置目录（① 层）时用的 id。**缺席 = 只有能力知识，不进目录** ——
   * 已下架的型号靠这个留在表里继续起作用（见文件头）。
   */
  readonly builtinId?: string;
  readonly capabilities: ModelCapabilities;
  readonly evidence: CapabilityEvidence;
  /** `evidence: 'probe'` 时的实测日期 */
  readonly verifiedAt?: string;
  /** 仍未被真实 endpoint 证实的能力键。`vendor-doc` 的一律整组列出 */
  readonly unverified: readonly (keyof ModelCapabilities)[];
  readonly notes: string;
}

export const KNOWN_MODELS: readonly KnownModel[] = [
  {
    provider: 'moonshot',
    upstreamModel: 'kimi-k3',
    displayName: 'Kimi K3',
    tier: 'flagship',
    builtinId: 'evowork/kimi-k3',
    evidence: 'probe',
    verifiedAt: '2026-09-05',
    unverified: ['maxContextTokens'],
    notes:
      '2026-09-05 实测：**是推理模型**（64 帧里 61 帧 reasoning_content，原表按 K2 写的 false 已订正）；' +
      '并行工具调用成立；**真的能看图**（32×32 纯红图答"红色"）；' +
      '未知模型返回 404 且 **error 里没有 code、语义在 type** —— 这条暴露了错误映射的一个真缺陷（见 registry.ts）。' +
      '厂商文档（platform.kimi.com，kimi-k3 快速开始）同样写明原生视觉理解，' +
      '但**只接受 base64 与 `ms://` file id，不接公网图片 URL** —— 我们本来就只发 data: URL（K6）。' +
      '2026-09-26 复测 23 条全通过，并**订正一条 cache 口径**：命中时它现在' +
      '**同时**给顶层 `cached_tokens` 与嵌套的 `prompt_tokens_details.cached_tokens`（都是 1024），' +
      '不再是 2026-09-05 记的"顶层，与另两家都不同"；未命中时给的是 ' +
      '`prompt_tokens_details.cache_write_tokens`，**那是写入不是命中，不能当命中读**。',
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
    provider: 'zhipu',
    upstreamModel: 'glm-5.3-flash',
    displayName: 'GLM 5.3 Flash',
    tier: 'light',
    builtinId: 'evowork/glm-flash',
    evidence: 'probe',
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
  {
    provider: 'deepseek',
    upstreamModel: 'deepseek-flash',
    /*
     * 视觉能力最早以 `deepseek-v4-flash-vision-exp` 这个实验名发布，厂商文档现在说
     * 它"仍可用但已废弃"。用户 `models.toml` 里存的可能就是老名字，所以列进别名 ——
     * 漏了的话同一个型号会按"不认识"落到保守默认，表现就是这次的缺陷再来一遍。
     */
    aliases: ['deepseek-v4-flash-vision-exp'],
    displayName: 'DeepSeek Flash',
    tier: 'standard',
    evidence: 'probe',
    verifiedAt: '2026-09-26',
    unverified: ['maxContextTokens'],
    notes:
      '2026-09-26 实测（`verify-provider.mjs`，23 条全通过）：**真的能看图** ——' +
      '32×32 纯红图答"红"，与同厂的 `deepseek-v4-flash`（收下图、回 200、说"无法识别"）' +
      '**不是同一个型号**，后者在本表里 imageInput 仍是 false；' +
      '是推理模型（66 帧里 65 帧 reasoning_content）；一轮给出两个 tool_call，并行成立；' +
      'cache 命中同时给**顶层 `prompt_cache_hit_tokens`** 与嵌套的 ' +
      '`prompt_tokens_details.cached_tokens`（同 prompt 发两次，都是 896）；' +
      '未知模型 400 + error.code=invalid_request_error。' +
      '视觉能力最早以 `deepseek-v4-flash-vision-exp` 发布（厂商文档标已废弃），故列为别名。',
    capabilities: {
      streaming: true,
      toolCalls: true,
      parallelToolCalls: true,
      reasoning: true,
      promptCache: true,
      imageInput: true,
      maxContextTokens: 1_000_000,
    },
  },
  {
    provider: 'deepseek',
    upstreamModel: 'deepseek-v4-flash',
    displayName: 'DeepSeek V4 Flash',
    tier: 'standard',
    /*
     * 2026-09-06 从内置目录下架（总纲 §D2），但**能力知识必须留着**：
     * 它是"接受但看不见"那一类的唯一样本，删掉之后没有任何东西拦得住
     * 下一个人按"DeepSeek 支持视觉"把它标成 true。
     */
    evidence: 'probe',
    verifiedAt: '2026-09-05',
    unverified: ['maxContextTokens'],
    notes:
      '2026-09-05 实测：**是推理模型**（65 帧里 44 帧 reasoning_content）；并行工具调用成立；' +
      'cache 口径是顶层 `prompt_cache_hit_tokens`；未知模型 400 + code=invalid_request_error。' +
      '**图片输入是第三种结局**：HTTP 200 收下了，然后回"无法识别" —— 不报错、也看不见，' +
      '所以 imageInput 必须是 false（D2「降级必须显式」要防的正是这一形态）。' +
      '2026-09-06 已从内置目录下架，这里只保留能力结论。',
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
];

/** 按 (协议适配类型, 上游模型名) 建索引，别名一起进去。**大小写不敏感**：厂商文档与控制台大小写不一。 */
const BY_KEY: ReadonlyMap<string, KnownModel> = (() => {
  const map = new Map<string, KnownModel>();
  for (const model of KNOWN_MODELS) {
    for (const name of [model.upstreamModel, ...(model.aliases ?? [])]) {
      map.set(`${model.provider}\u0000${name.toLowerCase()}`, model);
    }
  }
  return map;
})();

/**
 * 我们认得这个型号吗？
 *
 * **`private` 一律认不出来**：那是"其他 OpenAI 兼容 endpoint"，同一个模型名后面
 * 可能是任何东西（自建代理、微调版、换了权重的同名模型）。按名字给它安上
 * 官方型号的能力位，就是在替一个我们完全不了解的 endpoint 做担保。
 */
export function findKnownModel(provider: string, upstreamModel: string): KnownModel | undefined {
  if (provider === 'private') return undefined;
  return BY_KEY.get(`${provider}\u0000${upstreamModel.trim().toLowerCase()}`);
}

/** 进内置目录（① 层）的那几条。`P0_MODELS` 就是它。 */
export function builtinModelEntries(): readonly (ModelRegistryEntry & {
  readonly evidence: CapabilityEvidence;
})[] {
  return KNOWN_MODELS.filter((model) => model.builtinId !== undefined).map((model) => ({
    id: model.builtinId as string,
    provider: model.provider,
    upstreamModel: model.upstreamModel,
    displayName: model.displayName,
    tier: model.tier,
    capabilities: model.capabilities,
    evidence: model.evidence,
    verified: model.evidence === 'probe',
    ...(model.verifiedAt !== undefined ? { verifiedAt: model.verifiedAt } : {}),
    unverified: model.unverified,
    notes: model.notes,
  }));
}
