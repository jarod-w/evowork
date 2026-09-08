/**
 * 模型注册表的四层与合并顺序（[11 §4.1](../../../docs/design/11-account-and-models.md)，M10a）。
 *
 * ## 为什么"内置三家"不等于"能用三家"
 *
 * 在此之前模型表只有一层：`P0_MODELS` 按"env 里有没有那家密钥"过滤（`main.ts`）。
 * 那对个人 BYOK 够用，但三个已定需求都要求这张表**可以被覆盖**：
 * 企业要锁模型（R11）· 用户要加私有 endpoint（Q29 保留的配置项）· 托管与 BYOK 要共存（Q36=A）。
 * 而"可覆盖"一旦有两个以上的来源，**合并顺序就是一条必须写下来的语义** ——
 * 否则它会以"谁最后 push 进数组"的形式存在，而那不是任何人能读出来的规则。
 *
 * | 层 | 来源 | 谁能改 | 能做什么 |
 * |---|---|---|---|
 * | ① 内置元数据 | `P0_MODELS` | 我们 | **只有元数据**：能力徽标、上下文长度、`verified`。不自带凭据 |
 * | ②' 租户默认模型 | 云端网关的目录端点（**M10b**） | 租户管理员 | 增删默认模型、上游 key（key 从不下发到客户端） |
 * | ② 企业覆盖 | 签名策略包（R11 已有通道，不新建） | 租户管理员 | 停用某模型、锁 `allowCustomModels` |
 * | ③ 本机自定义 | `~/.evowork/models.toml` + `safeStorage` | 用户 | **只能追加**私有 endpoint |
 *
 * **合并顺序：② > ②' > ③ > ①。**
 *
 *   · **② 压所有**，因为它是禁令 —— 反过来的话用户在 `models.toml` 里加一条就绕过了策略包，
 *     R11 的整个缓解手段就没了；
 *   · **②' 压 ③**：同一个 model id 冲突时租户口径优先；
 *   · **① 垫底**：它只是元数据 —— 这也是"内置三家 ≠ 能用三家"的出处。
 *
 * ## 被停用的模型**留在列表里**
 *
 * 与 [10 §2.2](../../../docs/design/10-security-permissions-ux.md) 的「未知 profile 显示 id
 * 本身，不隐藏」是同一条纪律：消失的东西无法被排查，而用户会去问客服"我明明配了密钥
 * 为什么没有"。所以停用表现为 `denied`（一句能直接显示的话），不是从数组里删掉。
 */
import type { ModelRegistryEntry } from './capabilities.js';

/**
 * 这个模型用谁的凭据、花谁的钱、数据过谁的境。
 *
 * **它必须对用户可见**（11 §4.2）：一个用户以为在用自己的密钥、实际走了我们的托管调用，
 * 是**隐私承诺层面**的问题，不是计费问题。它同时是 Q36=A（共存）的数据面 ——
 * 登录用户的下拉里会同时出现 hosted 的默认模型与 byok 的自定义模型，靠这个标签区分。
 */
export type CredentialSource =
  /** 用户自己的厂商密钥（`safeStorage`），本机直连厂商。**断网时唯一还能用的一条** */
  | 'byok'
  /** 管理员配置的默认模型。key 只在服务端，**从不下发到这台机器**（11 §13.2） */
  | 'hosted'
  /** 企业私有网关 / 私有 endpoint */
  | 'private';

/** 一条被解析过的模型：知道自己来自哪一层、用谁的凭据、有没有被停用。 */
export interface ResolvedModel extends ModelRegistryEntry {
  readonly credentialSource: CredentialSource;
  readonly layer: 'builtin' | 'tenant' | 'custom';
}

/**
 * 第②层：企业覆盖。**它只有禁令，没有增项** —— 加模型是 ②' 的事。
 *
 * 真源是签名策略包（M10c 的下发通道）。M10a 里它来自本机 `requirements.toml`
 * 的同名字段，形状先钉死在这里，通道接上时不必改调用方。
 */
export interface EnterpriseModelPolicy {
  /** 停用这些 model id。**不隐藏**，标原因 */
  readonly disabledModelIds?: readonly string[];
  /**
   * 允不允许用户自己加模型。**默认 true** —— 缺省不该等于"被锁"：
   * 一个没有策略包的个人用户必须能用 BYOK（Q30=A 的字面意思）。
   */
  readonly allowCustomModels?: boolean;
  /** 停用原因的自定义文案。不给就用默认那句 */
  readonly reason?: string;
}

/** 被企业策略停用时给用户看的话（11 §8）。**说清是企业策略，不是"你没配密钥"**。 */
export const DENIED_BY_POLICY = '这个模型已被你所在组织停用。';

/** 企业锁了自定义模型时的话。用户会去翻设置页找一个已经被锁掉的入口，所以要说清原因。 */
export const CUSTOM_MODELS_LOCKED =
  '你所在组织要求使用统一配置的模型，这台电脑上自己添加的模型已被停用。';

export interface ModelLayers {
  /** ① 内置元数据 */
  readonly builtin: readonly ModelRegistryEntry[];
  /** ②' 租户默认模型（M10b 才会非空） */
  readonly tenant?: readonly ModelRegistryEntry[] | undefined;
  /** ③ 本机自定义 */
  readonly custom?: readonly ModelRegistryEntry[] | undefined;
  /** ② 企业覆盖 */
  readonly policy?: EnterpriseModelPolicy | undefined;
  /**
   * ① 层的某家厂商**有没有可用密钥**。
   *
   * 必须由调用方给：只有网关自己的进程环境知道这件事，而这正是模型下拉不走内核
   * `model/list` 的决定性理由（F24）。没有密钥的内置条目**不进结果** ——
   * 它是元数据，不是一个能选的模型；列出来的代价是用户选中、发出去、拿到 401。
   */
  readonly builtinHasKey: (providerId: string) => boolean;
}

/**
 * 四层合并。返回的顺序 = 各 id 第一次出现的顺序（下拉不该因为一次覆盖而跳动）。
 *
 * 覆盖时**只换条目、不换位置**，与 `createModelRegistryFrom` 同一条：
 * 企业用私有 endpoint 覆盖 `evowork/deepseek-v4-flash` 是真实场景，
 * 而位置跳动会让用户以为列表里少了一个。
 */
export function mergeModelLayers(layers: ModelLayers): readonly ResolvedModel[] {
  const order: string[] = [];
  const byId = new Map<string, ResolvedModel>();

  const put = (entry: ResolvedModel): void => {
    if (!byId.has(entry.id)) order.push(entry.id);
    byId.set(entry.id, entry);
  };

  // ① 垫底：只有配了密钥的那几家才是"能选的模型"
  for (const entry of layers.builtin) {
    if (!layers.builtinHasKey(entry.provider)) continue;
    put({ ...entry, credentialSource: 'byok', layer: 'builtin' });
  }

  // ③ 本机自定义：只能追加，同 id 覆盖 ①
  const customLocked = layers.policy?.allowCustomModels === false;
  for (const entry of layers.custom ?? []) {
    put({
      ...entry,
      credentialSource: entry.provider === 'private' ? 'private' : 'byok',
      layer: 'custom',
      // 锁了自定义模型时**保留条目并说明原因**，不静默消失（见文件头）
      ...(customLocked ? { denied: layers.policy?.reason ?? CUSTOM_MODELS_LOCKED } : {}),
    });
  }

  // ②' 租户默认模型压 ③（同 id 冲突时租户口径优先）
  for (const entry of layers.tenant ?? []) {
    put({ ...entry, credentialSource: 'hosted', layer: 'tenant' });
  }

  // ② 企业覆盖压所有 —— 它是禁令，所以最后一道
  const disabled = new Set(layers.policy?.disabledModelIds ?? []);
  const merged = order.map((id) => byId.get(id) as ResolvedModel);
  return merged.map((entry) =>
    disabled.has(entry.id)
      ? { ...entry, denied: layers.policy?.reason ?? DENIED_BY_POLICY }
      : entry,
  );
}
