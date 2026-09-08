/**
 * 第③层「本机自定义模型」的**线上形状**（11 §4.1，M10a）。
 *
 * ## 为什么形状定在网关这一侧，而文件在桌面那一侧
 *
 * 用户加的模型存在 `~/.evowork/models.toml`（元数据）+ `safeStorage`（密钥）里，
 * 而网关**只从进程环境读配置，不读配置文件、不落盘任何密钥**（Q14 / K6，见 `main.ts`）。
 * 所以中间一定有一次翻译：宿主解密密钥 → 拼进子进程环境 → 网关解析。
 *
 * 这次翻译的两侧共用**这一个模块**，理由与 `catalog.ts` 完全一样：
 * 一份手抄的类型两边都能编译，改一个字段名就在运行时静默断掉
 * （多的字段被忽略、少的字段是 `undefined`）—— CLAUDE.md §9.1 的标准形状。
 * 所以宿主用 `encodeCustomModels()` 写，网关用 `parseCustomModels()` 读，
 * 而 `validateCustomModel()` 是它们共用的那道校验。
 *
 * ## 密钥**不在** JSON 里
 *
 * `EVOWORK_CUSTOM_MODELS` 只有元数据；每把密钥单独一个 `EVOWORK_CUSTOM_KEY_<n>`，
 * JSON 里存的是**变量名**。这不是洁癖：进程环境的这一个变量会被日志、崩溃报告、
 * `ps e` 一起带走，而把 N 把密钥塞进一个 JSON 意味着任何一次"打印一下配置"
 * 都是 N 把密钥同时泄漏。分开之后，日志里出现的是变量名。
 */
import type { ModelCapabilities, ModelRegistryEntry, ProviderId } from './capabilities.js';
import type { ProviderConfig } from './providers/types.js';

/** 环境变量名。两侧共用常量，拼错就不会各拼各的。 */
export const CUSTOM_MODELS_ENV = 'EVOWORK_CUSTOM_MODELS';
export const CUSTOM_KEY_ENV_PREFIX = 'EVOWORK_CUSTOM_KEY_';
/** 第②层（企业覆盖）。M10c 的签名策略包接上时换来源，形状不变 */
export const MODEL_POLICY_ENV = 'EVOWORK_MODEL_POLICY';

/**
 * 用户能选的**协议适配类型**。这就是 `ProviderId`，不是另起一套枚举 ——
 * 加一条自定义模型时必须选它（11 §4.1），因为"这个 endpoint 说哪种方言"
 * 无法从 URL 推断，而猜错的表现是流式解析出来是空的。
 */
export const PROTOCOL_ADAPTERS: readonly ProviderId[] = [
  'deepseek',
  'moonshot',
  'zhipu',
  'private',
];

/** 一条自定义模型（元数据；密钥在 `keyEnv` 指向的环境变量里）。 */
export interface CustomModelSpec {
  /** 对外的 model id。内核发过来的就是这个 */
  readonly id: string;
  readonly displayName: string;
  /** 协议适配类型（见 `PROTOCOL_ADAPTERS`） */
  readonly provider: ProviderId;
  /** 上游真实模型名 */
  readonly upstreamModel: string;
  readonly baseUrl: string;
  /** 密钥所在的环境变量名。**值不在这里** */
  readonly keyEnv: string;
  /** 自定义鉴权头（Q29 保留的配置项）。给了就整条覆盖 Authorization */
  readonly authHeaderEnv?: string;
  readonly capabilities: ModelCapabilities;
}

/**
 * 一条自定义模型能不能存。返回**一句要显示给用户的话**，`undefined` = 可以。
 *
 * 与 `ProjectMutationResult.refused` 同一条纪律：抛错在界面上的表现是
 * "点了保存转一下然后什么都没发生"。
 */
export function validateCustomModel(input: {
  readonly id?: string | undefined;
  readonly provider?: string | undefined;
  readonly baseUrl?: string | undefined;
  readonly upstreamModel?: string | undefined;
}): string | undefined {
  const id = (input.id ?? '').trim();
  if (id === '') return '给这个模型起一个 id（任务里就用它指定模型）。';
  // 与 packages/logging 的 token 形状一致：它会作为 `model` 字段进日志
  if (!/^[A-Za-z][A-Za-z0-9_./:-]{0,63}$/.test(id)) {
    return 'id 只能用字母、数字与 `_ - . / :`，且以字母开头。';
  }
  if ((input.upstreamModel ?? '').trim() === '') {
    return '填上上游真实的模型名（发给厂商时用的那个）。';
  }
  const provider = (input.provider ?? '').trim();
  if (provider === '') {
    // 11 §4.1：追加时**必须选协议适配类型**
    return '选一个协议适配类型：不同 endpoint 的流式与工具调用格式不同，这个猜不出来。';
  }
  if (!PROTOCOL_ADAPTERS.includes(provider as ProviderId)) {
    return `不认识的协议适配类型「${provider}」。可选：${PROTOCOL_ADAPTERS.join(' / ')}。`;
  }
  const baseUrl = (input.baseUrl ?? '').trim();
  if (baseUrl === '') return '填上这个模型的 endpoint 地址。';
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    return 'endpoint 地址不是一个合法的 URL。';
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return 'endpoint 只能是 http 或 https。';
  }
  return undefined;
}

/** 没实测过的能力位一律**标未验证**：自定义模型我们没有任何依据说它验过（同 `verified` 的设计）。 */
export function toRegistryEntry(spec: CustomModelSpec): ModelRegistryEntry {
  return {
    id: spec.id,
    provider: spec.provider,
    upstreamModel: spec.upstreamModel,
    displayName: spec.displayName,
    tier: 'standard',
    capabilities: spec.capabilities,
    verified: false,
    unverified: [
      'streaming',
      'toolCalls',
      'parallelToolCalls',
      'reasoning',
      'promptCache',
      'imageInput',
      'maxContextTokens',
    ],
    notes:
      '这台电脑上自己添加的模型。能力位是添加时手填的，**没有经过实测** ——' +
      '徽标显示的是你的声明，不是我们的验证结论。',
  };
}

export function encodeCustomModels(specs: readonly CustomModelSpec[]): string {
  return JSON.stringify(specs);
}

/**
 * 解析 `EVOWORK_CUSTOM_MODELS`。**坏数据不让网关起不来**：整条丢掉并让调用方记一条。
 *
 * 理由与 `readGatewayEnvFile` 一样 —— 一条损坏的自定义模型不该让用户连内置三家都用不了。
 * 但**不能静默**：返回 `dropped` 让调用方报出来（CLAUDE.md §9.1「认不出来也要如实说」）。
 */
export function parseCustomModels(raw: string | undefined): {
  readonly specs: readonly CustomModelSpec[];
  readonly dropped: number;
} {
  if (!raw || raw.trim() === '') return { specs: [], dropped: 0 };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { specs: [], dropped: 1 };
  }
  if (!Array.isArray(parsed)) return { specs: [], dropped: 1 };
  const specs: CustomModelSpec[] = [];
  let dropped = 0;
  for (const item of parsed) {
    const spec = item as Partial<CustomModelSpec>;
    if (
      typeof spec.id !== 'string' ||
      typeof spec.baseUrl !== 'string' ||
      typeof spec.keyEnv !== 'string' ||
      typeof spec.upstreamModel !== 'string' ||
      typeof spec.provider !== 'string' ||
      validateCustomModel(spec) !== undefined ||
      spec.capabilities === undefined
    ) {
      dropped += 1;
      continue;
    }
    specs.push({
      id: spec.id,
      displayName: spec.displayName ?? spec.id,
      provider: spec.provider,
      upstreamModel: spec.upstreamModel,
      baseUrl: spec.baseUrl,
      keyEnv: spec.keyEnv,
      ...(spec.authHeaderEnv ? { authHeaderEnv: spec.authHeaderEnv } : {}),
      capabilities: spec.capabilities,
    });
  }
  return { specs, dropped };
}

/** 第②层的解析。同样**坏数据不阻塞启动**，但坏的策略包要按"更严"的方向处理 —— 见下。 */
export function parseModelPolicy(raw: string | undefined): {
  readonly disabledModelIds: readonly string[];
  readonly allowCustomModels: boolean;
  readonly reason?: string;
  readonly malformed: boolean;
} {
  const allow = { disabledModelIds: [], allowCustomModels: true, malformed: false } as const;
  if (!raw || raw.trim() === '') return allow;
  try {
    const parsed = JSON.parse(raw) as {
      disabledModelIds?: unknown;
      allowCustomModels?: unknown;
      reason?: unknown;
    };
    const ids = Array.isArray(parsed.disabledModelIds)
      ? parsed.disabledModelIds.filter((x): x is string => typeof x === 'string')
      : [];
    return {
      disabledModelIds: ids,
      /*
       * **坏值按"锁"处理**，与自定义模型的"坏值丢掉"方向相反。
       *
       * 这不是不一致：一条坏的自定义模型丢掉，用户少一个模型可用；
       * 一份读不懂的企业策略若按"不锁"处理，企业的禁令就被一个 JSON 语法错误绕过了。
       * 失败方向永远朝更严的那一侧（同 `services/policy` 的路径判定）。
       */
      allowCustomModels:
        parsed.allowCustomModels === undefined ? true : parsed.allowCustomModels === true,
      ...(typeof parsed.reason === 'string' ? { reason: parsed.reason } : {}),
      malformed: false,
    };
  } catch {
    return { disabledModelIds: [], allowCustomModels: false, malformed: true };
  }
}

/** 自定义模型的上游配置（key 从它自己的环境变量取）。 */
export function customModelConfig(
  spec: CustomModelSpec,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): ProviderConfig {
  const authHeader = spec.authHeaderEnv ? env[spec.authHeaderEnv]?.trim() : undefined;
  return {
    baseUrl: spec.baseUrl,
    apiKey: env[spec.keyEnv]?.trim() ?? '',
    ...(authHeader ? { extraHeaders: { authorization: authHeader } } : {}),
    timeoutMs,
  };
}
