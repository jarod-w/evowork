/**
 * `GET /v1/evowork/models` 的**线上契约**（D2「降级必须显式」的数据面）。
 *
 * ## 为什么它是一个具名类型，而不是 server.ts 里一段内联字面量
 *
 * 这个端点有两个消费者：网关自己（生产它）与桌面 App 的模型下拉（消费它）。
 * 在此之前它只在 `server.ts` 的 handler 里以对象字面量存在 —— 那意味着消费侧只能
 * **照着抄一份自己的类型**，而 CLAUDE.md §9.1 的「两个模块各自对，合起来可能不对」
 * 说的正是这种形状：两边各自都能编译，字段名改一个就在运行时断掉，且没有任何一层会报错
 * （多出来的字段被忽略，少掉的字段是 `undefined`）。所以把它提出来，让这条缝
 * **出现在类型层面** —— 与 `apps/desktop/src/shared/ipc.ts` 的做法是同一条纪律。
 *
 * ## 为什么模型下拉的真源是这里，而不是内核的 `model/list`（F24）
 *
 * 09 §3.2 第 6 步原先写的是「握手时调 `model/list` + `modelProvider/capabilities/read`」。
 * **那条不成立**，三个理由，第一个是决定性的：
 *
 *   ① **只有网关知道哪家厂商的密钥真的配好了**（`main.ts` 的 `availableModels()` 按
 *      密钥存在与否过滤模型表）。内核对此一无所知，它会把连不上的模型也列进下拉 ——
 *      用户选中之后要等到发出一句话、任务失败，才知道那个模型根本不可用。
 *      03 §8 要求的恰恰相反：**模型不可用要在发送之前就说**。
 *   ② 不配 `model_catalog_json` 时，内核的 `model/list` 走 `OpenAiModelsManager` +
 *      `OpenAiModelsEndpoint`（`model-provider/src/provider.rs:444-466`），返回的是
 *      **OpenAI 的型号清单** —— 那是对外可见的品牌字符串（K5），而且是一条没登记过的
 *      出网路径（K6）。
 *   ③ 内核的 `Model` 结构里与我们的能力徽标对得上的只有 `input_modalities` 一项；
 *      reasoning / parallelToolCalls / promptCache 都没有对应字段。
 *
 * 详见 §4 的 F24 与 09 §3.2 的修订。
 */
import type { ModelCapabilities, ProviderId } from './capabilities.js';
import type { CredentialSource, ResolvedModel } from './layers.js';
import { capabilityNotices } from './pipeline.js';

/** 端点路径。客户端与服务端**共用这一个常量**，拼错就不会各拼各的。 */
export const MODELS_ENDPOINT_PATH = '/v1/evowork/models';

/**
 * 一个模型在下拉里需要的全部信息。
 *
 * ## 这个类型里**没有 `apiKey`，hosted 条目也没有上游 `baseUrl`**（11 §12 第 13 条）
 *
 * 不是"运行时过滤掉了"，是**类型层面就没有那个字段**。区别在失败方式上：
 * 过滤是一行可以被漏掉、被绕过、被"临时调试一下"注释掉的代码；类型没有那个字段，
 * 想把 key 发给客户端就得先改这个类型，而改它会被 review 看见。
 * 要防的具体后果是：租户共享的厂商 key 落到每一台客户机 —— 一台泄漏 = 整租户额度泄漏，
 * 而计量同时失真（谁用的都算不清）。
 */
export interface ModelCatalogEntry {
  readonly id: string;
  readonly displayName: string;
  readonly provider: ProviderId;
  /** 上游真实模型名。下拉里显示成 `provider/upstreamModel`（01 §5.15 的等宽标签） */
  readonly upstreamModel: string;
  readonly tier: 'flagship' | 'standard' | 'light';
  readonly capabilities: ModelCapabilities;
  /**
   * 这一行的能力位是否被真实 endpoint 验证过。
   *
   * 与 `unverified` 一起透出而不是只给一个布尔值：一行"大部分实测过、上下文长度没测"的
   * 记录，在只有布尔值时只能在撒谎与自我否定之间二选一（见 `capabilities.ts` 的头注释）。
   */
  readonly verified: boolean;
  readonly verifiedAt?: string;
  readonly unverified: readonly (keyof ModelCapabilities)[];
  readonly notes: string;
  /** 缺失能力的用户可见文案（03 §4.5 徽标 + 03 §8 拒绝说明） */
  readonly notices: readonly string[];
  /**
   * 用谁的凭据（11 §4.2）。**下拉里跟着 `provider/model` 一起显示** ——
   * 它同时回答"这次调用花谁的钱"和"数据过谁的境"，后者是 K6 隐私叙事的一部分。
   */
  readonly credentialSource: CredentialSource;
  /** 来自哪一层（11 §4.1）。设置页据此决定这一条能不能被用户删 */
  readonly layer: 'builtin' | 'tenant' | 'custom';
  /**
   * 被企业策略停用的原因。**有值时这一条仍然要显示**（划除 + 这句话），
   * 不隐藏 —— 同 10 §2.2「未知 profile 显示 id 本身」。
   */
  readonly denied?: string;
}

export interface ModelCatalogResponse {
  readonly data: readonly ModelCatalogEntry[];
}

/**
 * 把上游网关的目录应答收成我们的线上形状。
 *
 * 出现 `apiKey` / `baseUrl` 的条目丢掉（11 §12 第 13 条）。
 * 远程条目一律标 `hosted` + `layer=tenant`：本机 registry 里没有它们，
 * 请求要走转发，不能被看成 BYOK 去碰本机密钥。
 */
export function parseRemoteCatalog(json: unknown): readonly ModelCatalogEntry[] {
  if (json === null || typeof json !== 'object' || Array.isArray(json)) return [];
  const data = (json as { data?: unknown }).data;
  if (!Array.isArray(data)) return [];
  const providers: readonly ProviderId[] = ['deepseek', 'moonshot', 'zhipu', 'private'];
  const out: ModelCatalogEntry[] = [];
  for (const item of data) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) continue;
    const rec = item as Record<string, unknown>;
    if ('apiKey' in rec || 'baseUrl' in rec) continue;
    const id = typeof rec.id === 'string' ? rec.id : '';
    const provider = providers.find((p) => p === rec.provider);
    const upstreamModel = typeof rec.upstreamModel === 'string' ? rec.upstreamModel : '';
    const displayName = typeof rec.displayName === 'string' ? rec.displayName : id;
    if (!id || !provider || !upstreamModel) continue;
    const capabilities = rec.capabilities;
    if (capabilities === null || typeof capabilities !== 'object' || Array.isArray(capabilities)) {
      continue;
    }
    out.push({
      id,
      displayName,
      provider,
      upstreamModel,
      tier: rec.tier === 'flagship' || rec.tier === 'light' ? rec.tier : 'standard',
      capabilities: capabilities as ModelCapabilities,
      verified: rec.verified === true,
      unverified: Array.isArray(rec.unverified)
        ? (rec.unverified.filter((k) => typeof k === 'string') as ModelCatalogEntry['unverified'])
        : [],
      notes: typeof rec.notes === 'string' ? rec.notes : '',
      notices: Array.isArray(rec.notices)
        ? rec.notices.filter((n): n is string => typeof n === 'string')
        : [],
      credentialSource: 'hosted',
      layer: 'tenant',
      ...(typeof rec.denied === 'string' ? { denied: rec.denied } : {}),
    });
  }
  return out;
}

/** 本机条目优先；远程同 id 的丢掉。 */
export function mergeCatalog(
  local: readonly ModelCatalogEntry[],
  remote: readonly ModelCatalogEntry[],
): readonly ModelCatalogEntry[] {
  const ids = new Set(local.map((entry) => entry.id));
  return [...local, ...remote.filter((entry) => !ids.has(entry.id))];
}

/**
 * 注册表条目 → 线上形状。
 *
 * `verified` **如实透出**：未经真实 endpoint 验证的能力位不该在 UI 上看起来像已验证的。
 */
export function toCatalogEntry(model: ResolvedModel): ModelCatalogEntry {
  return {
    id: model.id,
    displayName: model.displayName,
    provider: model.provider,
    upstreamModel: model.upstreamModel,
    tier: model.tier,
    capabilities: model.capabilities,
    verified: model.verified,
    ...(model.verifiedAt ? { verifiedAt: model.verifiedAt } : {}),
    unverified: model.unverified,
    notes: model.notes,
    notices: capabilityNotices(model),
    credentialSource: model.credentialSource,
    layer: model.layer,
    ...(model.denied ? { denied: model.denied } : {}),
  };
}
