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
 * 2026-09-05 的 `deepseek-v4-flash` 收下图片、回 HTTP 200、然后说"无法识别" —— 既不报错也看不见。
 * 判据因此是**答没答对图里的颜色**，不是状态码（`verify-provider.mjs --image true`）。
 *
 * 那个型号 2026-10-05 已被厂商退役：旧名仍然收，但请求由 DeepSeek-V4.1-Flash
 * （即 `deepseek-flash`）处理（api-docs.deepseek.com 的 Models & Pricing）。所以旧名现在是
 * `deepseek-flash` 的别名 —— **改它的依据是厂商的路由声明，不是"名字里有 flash"这类推断**。
 * 继续把旧名记成看不见图，后果是 Composer 把一个能读图的模型的图片拦掉（03 §8）。
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
      '`prompt_tokens_details.cache_write_tokens`，**那是写入不是命中，不能当命中读**。' +
      '上下文 1,048,576 取自厂商文档（platform.kimi.com，2026-10-05 核对：快速开始写「100 万 token」，' +
      '同站的接入指南给的精确值是 `model_context_window = 1048576`）；' +
      '原表的 256k 没有出处，**这一项仍没实测**（要塞满上下文才能测）。',
    capabilities: {
      streaming: true,
      toolCalls: true,
      parallelToolCalls: true,
      reasoning: true,
      promptCache: true,
      imageInput: true,
      maxContextTokens: 1_048_576,
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
      '**产物质量本身仍未评估**（U1）—— 这里验的是协议语义，不是它写得好不好。' +
      '上下文取自厂商文档（docs.bigmodel.cn 与 docs.z.ai 的 GLM-5.3-Flash/FlashX 页，2026-10-05 核对）：' +
      '两处都只写「1M」、没有精确 token 数，**按小的那种读法记 1,000,000**（估大比估小危险：' +
      '估大了内核等不到压缩、厂商先拒）；原表的 128k 没有出处，**这一项仍没实测**。',
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
    upstreamModel: 'deepseek-flash',
    /*
     * 两个旧名，厂商文档（Models & Pricing，2026-10-05 核对）原话：
     * "The legacy names `deepseek-v4-flash` and `deepseek-v4-flash-vision-exp` are still accepted,
     * but the corresponding models have been retired, their requests are served by the
     * DeepSeek-V4.1-Flash model" —— 也就是本条。用户 `models.toml` 里存的可能就是老名字，
     * 漏了的话同一个型号会按"不认识"落到表外默认（不读图、上下文按默认值），或者按退役前的结论拦掉图片。
     * 页面没写旧名哪天停收。
     */
    aliases: ['deepseek-v4-flash', 'deepseek-v4-flash-vision-exp'],
    /*
     * 2026-09-27 进内置目录。此前两条 DeepSeek 都没有 `builtinId`，而按本文件的约定
     * 那等于"已下架" —— 于是只配 `DEEPSEEK_API_KEY` 时网关以 `no_models` 拒绝启动，
     * 用户那一侧是「我配了 DeepSeek，应用说没有可用模型」。
     * 而 Q16 把 DeepSeek 列为三家 P0 之一，总纲 D2 也说目录里该留一个 ——
     * 代码与设计对不上，缺的是这一行。
     *
     * 选 `deepseek-flash` 而不是 `deepseek-v4-flash`：后者 2026-09-06 已明确下架，
     * 且当时**收下图、回 200、却说"无法识别"**；前者 2026-09-26 实测 23 条全通过，
     * 是真能看图的那个。（2026-10-05 起后者已被厂商退役、旧名路由到前者，见上面的别名。）
     */
    builtinId: 'evowork/deepseek-flash',
    displayName: 'DeepSeek Flash',
    tier: 'standard',
    evidence: 'probe',
    verifiedAt: '2026-10-05',
    unverified: [],
    notes:
      '2026-09-26 实测（`verify-provider.mjs`，23 条全通过）：**真的能看图** ——' +
      '32×32 纯红图答"红"，与 2026-09-05 测的 `deepseek-v4-flash`（收下图、回 200、说"无法识别"）' +
      '当时**不是同一个型号**；' +
      '是推理模型（66 帧里 65 帧 reasoning_content）；一轮给出两个 tool_call，并行成立；' +
      'cache 命中同时给**顶层 `prompt_cache_hit_tokens`** 与嵌套的 ' +
      '`prompt_tokens_details.cached_tokens`（同 prompt 发两次，都是 896）；' +
      '未知模型 400 + error.code=invalid_request_error。' +
      '2026-10-05 厂商文档：`deepseek-v4-flash` 与 `deepseek-v4-flash-vision-exp` 两个旧名仍收，' +
      '对应型号已退役、请求由本条（V4.1-Flash）处理，故都列为别名；' +
      '2026-10-05 复测：新旧两个名字各跑 `verify-provider.mjs` 23 条全通过，**旧名同样答出纯红图的颜色**、' +
      '帧数与 cache 命中数（896）一致 —— 厂商的路由声明成立。' +
      '**上下文上限实测为 1,048,576**：发约 115 万 token 的合成填充请求，两个名字都回 400 + ' +
      '`code=invalid_request_error`，原话 "This model\'s maximum context length is 1048576 tokens"' +
      '（厂商文档只写「1M」）。**注意超长的错误码与未知模型是同一个**，网关现在把它映射成 invalid_prompt，' +
      '内核认不出是超长（见 status.md 2026-10-05）。',
    capabilities: {
      streaming: true,
      toolCalls: true,
      parallelToolCalls: true,
      reasoning: true,
      promptCache: true,
      imageInput: true,
      maxContextTokens: 1_048_576,
    },
  },
  /*
   * 原先这里还有一条 `deepseek-v4-flash`（2026-09-05 实测"接受但看不见"，imageInput: false）。
   * 2026-10-05 厂商退役了那个型号、旧名路由到 `deepseek-flash`，所以并成上面那条的别名 ——
   * 留着它等于对一个已经不存在的型号下结论，而且结论与旧名现在背后的型号相反。
   * 那次实测的结果仍记在总纲 D2 的表里。
   */
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

/** 能力表里一个名字（正名或别名）对应的上下文。 */
export interface KnownContextEntry {
  readonly provider: ProviderId;
  /** 用户可能填的那个名字，小写（与 `findKnownModel` 的比较口径一致） */
  readonly name: string;
  /** 这个名字背后的正名。`name` 是别名时与它不同 */
  readonly upstreamModel: string;
  readonly maxContextTokens: number;
  /** 上下文**实测过**时的日期；缺席 = 只有厂商文档 */
  readonly measuredAt?: string;
}

/**
 * 能力表里每个名字（含别名）的上下文 —— 设置页「添加模型」用：用户填到这些型号时，
 * 上下文锁定为表里的值（保存时 `capabilitiesFor` 本来就按表覆盖，让人改了却不生效是静默降级）。
 * `private` 不在里面：它一律认不出来（见 `findKnownModel`）。
 */
export function knownContextEntries(): readonly KnownContextEntry[] {
  return KNOWN_MODELS.flatMap((model) => {
    const measured =
      !model.unverified.includes('maxContextTokens') && model.verifiedAt !== undefined
        ? { measuredAt: model.verifiedAt }
        : {};
    return [model.upstreamModel, ...(model.aliases ?? [])].map((name) => ({
      provider: model.provider,
      name: name.toLowerCase(),
      upstreamModel: model.upstreamModel,
      maxContextTokens: model.capabilities.maxContextTokens,
      ...measured,
    }));
  });
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
