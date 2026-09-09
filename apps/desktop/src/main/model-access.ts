/**
 * 「模型接入」的本机状态机（M10a = 11 §4 的全部）。
 *
 * 它把四件此前散在各处、且**各自都是过渡方案**的事收拢到一处：
 *
 *   ① 厂商密钥       —— 从 `gateway.env`（明文）搬进 `secret-store.ts`（系统钥匙串）
 *   ② 网关访问令牌   —— 从 `gateway-token`（明文）搬进同一个密钥库
 *   ③ 拓扑（上游在哪）—— 从 `isLocalGateway(base_url)` 的 URL 反推改成 `app.toml` 的 `mode`（D11）
 *   ④ 有哪些模型     —— 从"硬编码三家 + 按密钥过滤"改成四层合并（11 §4.1）
 *
 * ## 为什么是一个模块而不是散在 `service-host.ts` 里
 *
 * 这四件事之间有**顺序与耦合**：拓扑决定要不要自签令牌；密钥与自定义模型一起
 * 决定网关子进程的环境；改任何一样都要重启网关再重拉目录。
 * 散在宿主里的话，"改一把密钥之后会发生什么"这条链路只能靠真跑一次来验，
 * 而它恰恰是用户在设置页每按一次保存都要走的那条。
 *
 * ## 密钥的流向（只有一个方向）
 *
 * ```
 * 渲染层（用户粘贴） ──IPC一次──▶ 主进程 ──safeStorage──▶ secrets.bin
 *                                    │
 *                                    └─解密─▶ 网关子进程的**进程环境**
 * ```
 *
 * **没有反向箭头**：`view()` 只给后四位，没有任何方法把明文交回渲染层
 * （11 §12 第 2 条）。网关只从进程环境读密钥，这条路径是现成的，全程不落明文盘。
 */
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';

import {
  encodeCustomModels,
  MODEL_POLICY_ENV,
  CUSTOM_MODELS_ENV,
  validateCustomModel,
  type CustomModelSpec,
  type ProviderId,
} from '@evowork/gateway';
import type { Logger } from '@evowork/logging';

import type {
  CustomModelInput,
  ModelAccessView,
  ModelCatalogResult,
  ModelProbeResult,
  ProviderKeyStateView,
  SaveProviderKeyInput,
} from '../shared/ipc.js';
import { resolveAppConfig, type GatewayMode } from './app-config.js';
import { ACCOUNT_SECRET_PREFIX, type AccountVault } from './account.js';
import {
  assignKeyEnv,
  DEFAULT_CUSTOM_CAPABILITIES,
  readModelsFile,
  writeModelsFile,
  type CustomModelRecord,
} from './custom-models.js';
import { isLocalGateway } from './gateway-process.js';
import { parseGatewayEnv } from './gateway-env.js';
import {
  createSecretStore,
  migratePlaintextSecrets,
  NO_KEYRING_NOTICE,
  type SafeStorageLike,
  type SecretStore,
} from './secret-store.js';

/** 内置三家（Q16 的 P0 名单）。**顺序就是设置页与引导里的顺序**。 */
export const KEY_PROVIDERS: readonly {
  readonly id: string;
  readonly label: string;
  readonly env: string;
}[] = [
  { id: 'deepseek', label: 'DeepSeek', env: 'DEEPSEEK_API_KEY' },
  { id: 'moonshot', label: 'Kimi（Moonshot）', env: 'MOONSHOT_API_KEY' },
  { id: 'zhipu', label: 'GLM（智谱）', env: 'ZHIPU_API_KEY' },
];

/** 网关访问令牌在密钥库里的名字。与内核读的那个环境变量同名，少一次映射。 */
export const GATEWAY_TOKEN_SECRET = 'EVOWORK_GATEWAY_TOKEN';

/** `meta` 表里记"用户显式同意明文兜底"的键（11 §4.3）。 */
export const PLAINTEXT_FALLBACK_KEY = 'evowork.secrets.plaintext_fallback';

export interface ModelAccessDeps {
  readonly paths: {
    readonly home: string;
    readonly kernelHome: string;
    readonly secrets: string;
    readonly secretsPlain: string;
    readonly appConfig: string;
    readonly modelsFile: string;
    readonly gatewayEnv: string;
    readonly gatewayToken: string;
    readonly requirements: string;
  };
  readonly safeStorage?: SafeStorageLike | undefined;
  readonly logger?: Logger | undefined;
  /** 进程环境（开发时从终端起会带着 key，测试里注入） */
  readonly baseEnv: NodeJS.ProcessEnv;
  /** 内核 `config.toml` 里的 `base_url` —— **只在 `app.toml` 缺席时被看一眼**（D11） */
  readonly kernelBaseUrl: string;
  readonly readFlag: (key: string) => string | undefined;
  readonly writeFlag: (key: string, value: string) => void;
}

/** 第②层（企业覆盖）在本机的落点。M10c 接上签名下发通道时只换来源。 */
export interface LocalModelPolicy {
  readonly disabledModelIds: readonly string[];
  readonly allowCustomModels: boolean;
  readonly reason?: string | undefined;
}

/**
 * 从 `requirements.toml` 读第②层。
 *
 * **不新建下发通道**（11 §7）：策略包已经有一条通道（R11 的签名 → 校验 → 写
 * `requirements.toml`），模型锁定复用它。这里只读那一段：
 *
 * ```toml
 * [models]
 * disabled = ["evowork/glm-flash"]
 * allow_custom = false
 * reason = "..."
 * ```
 */
export function parseModelPolicyToml(text: string): LocalModelPolicy {
  let inSection = false;
  let disabled: string[] = [];
  let allowCustom = true;
  let reason: string | undefined;
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    if (line.startsWith('[')) {
      inSection = line === '[models]';
      continue;
    }
    if (!inSection) continue;
    const list = /^disabled\s*=\s*\[(.*)\]/.exec(line);
    if (list) {
      disabled = (list[1] ?? '')
        .split(',')
        .map((part) => part.trim().replace(/^["']|["']$/g, ''))
        .filter((part) => part !== '');
    }
    const allow = /^allow_custom\s*=\s*(true|false)/.exec(line);
    if (allow) allowCustom = allow[1] === 'true';
    const why = /^reason\s*=\s*["']([^"']*)["']/.exec(line);
    if (why?.[1]) reason = why[1];
  }
  return {
    disabledModelIds: disabled,
    allowCustomModels: allowCustom,
    ...(reason ? { reason } : {}),
  };
}

export interface ModelAccess {
  readonly mode: GatewayMode;
  /** 拓扑是被 URL 反推出来的（老装机）。宿主据此记一条日志 —— 静默反推在排查时看不见 */
  readonly inferredMode: boolean;
  readonly secretBackend: SecretStore['backend'];
  /** 本机网关该不该起。D11 之后恒为 true：内核 base_url 永远是 loopback */
  readonly runsLocalGateway: boolean;
  /** 默认模型的上游。`private` 时是客户机房那台；内核看不到这个值 */
  readonly upstreamBaseUrl: string;
  /** 网关访问令牌。本机网关常驻，没有就现签一个（用户不该知道有这么个东西） */
  token(): string | undefined;
  /** 网关子进程与内核的环境（密钥、自定义模型、策略）。**每次重启都重新算** */
  env(): NodeJS.ProcessEnv;
  /** 账号 refresh 与厂商密钥共用密钥库，由 `account.ts` 读写 */
  readonly accountVault: AccountVault;
  /** 设置页要画的一切。`catalog` 由宿主刚拉的那一份传进来，不在这里再发一次请求 */
  view(catalog: ModelCatalogResult): ModelAccessView;
  saveProviderKey(input: SaveProviderKeyInput): boolean;
  clearProviderKey(providerId: string): boolean;
  addCustomModel(input: CustomModelInput): string | undefined;
  removeCustomModel(id: string): boolean;
  /** 用户对"钥匙串不可用"的选择（11 §4.3）。选明文之后要重建密钥库 */
  setPlaintextFallback(accept: boolean): void;
}

export function createModelAccess(deps: ModelAccessDeps): ModelAccess {
  const { config, inferred } = resolveAppConfig({
    path: deps.paths.appConfig,
    kernelBaseUrl: deps.kernelBaseUrl,
    isLoopback: isLocalGateway,
  });

  let store = buildStore();
  let models = readModelsFile(deps.paths.modelsFile);
  if (models.dropped > 0) {
    // 静默丢掉 = 用户在文件里看到它、在设置页看不到它，且没有任何线索
    deps.logger?.warn('desktop.models_file.dropped', { itemCount: models.dropped });
  }

  function buildStore(): SecretStore {
    return createSecretStore({
      encryptedPath: deps.paths.secrets,
      plaintextPath: deps.paths.secretsPlain,
      ...(deps.safeStorage ? { safeStorage: deps.safeStorage } : {}),
      allowPlaintext: deps.readFlag(PLAINTEXT_FALLBACK_KEY) === '1',
      ...(deps.logger ? { logger: deps.logger } : {}),
    });
  }

  /*
   * 一次性迁移两个明文文件（见 `migratePlaintextSecrets`）。
   *
   * 白名单沿用 `gateway-env.ts` 的 `parseGatewayEnv` —— 那个文件由用户编辑，
   * 不能把任意 `PATH=` 灌进来，而这条纪律在搬进密钥库之后同样成立。
   */
  migratePlaintextSecrets({
    store,
    sources: [
      {
        path: deps.paths.gatewayEnv,
        values: existsSync(deps.paths.gatewayEnv)
          ? parseGatewayEnv(safeRead(deps.paths.gatewayEnv))
          : {},
      },
      {
        path: deps.paths.gatewayToken,
        values: existsSync(deps.paths.gatewayToken)
          ? {
              [GATEWAY_TOKEN_SECRET]:
                safeRead(deps.paths.gatewayToken).split('\n')[0]?.trim() ?? '',
            }
          : {},
      },
    ],
    ...(deps.logger ? { logger: deps.logger } : {}),
  });

  /**
   * 钥匙串不可用时的**旧明文文件回退**。
   *
   * 这一段是被一条测试逼出来的（`service-host.test.ts`「从访达启动也能拿到厂商密钥」）：
   * 迁移要求密钥库可用，而 Linux 上没有 keyring 时它不可用 —— 于是升级之后
   * 一台老机器会**静默失去所有已配置的密钥**，用户看到的是"一家密钥都没配"，
   * 而他的 `gateway.env` 明明还在那儿。
   *
   * 所以此时的处理是：**不迁移、不改名、继续读它**。这不违反"密钥不落明文盘" ——
   * 那条说的是我们不再**写**明文；已经在用户磁盘上的那个文件继续可用，
   * 而设置页会显示 11 §4.3 的那段话让他做选择（存明文 or 每次手填）。
   * 悄悄让产品不可用，比继续读一个用户自己创建的文件糟得多。
   */
  const legacyEnv: Record<string, string> = store.available
    ? {}
    : {
        ...(existsSync(deps.paths.gatewayEnv)
          ? parseGatewayEnv(safeRead(deps.paths.gatewayEnv))
          : {}),
        ...(existsSync(deps.paths.gatewayToken)
          ? {
              [GATEWAY_TOKEN_SECRET]:
                safeRead(deps.paths.gatewayToken).split('\n')[0]?.trim() ?? '',
            }
          : {}),
      };

  const policy: LocalModelPolicy = existsSync(deps.paths.requirements)
    ? parseModelPolicyToml(safeRead(deps.paths.requirements))
    : { disabledModelIds: [], allowCustomModels: true };

  const runsLocalGateway = true;
  const upstreamBaseUrl =
    config.mode === 'private' && config.upstreamBaseUrl
      ? config.upstreamBaseUrl
      : deps.kernelBaseUrl;

  function token(): string | undefined {
    // ① 进程环境优先（开发时从终端起、企业用 launchd 注入）
    const fromEnv = deps.baseEnv.EVOWORK_GATEWAY_TOKEN?.trim();
    if (fromEnv) return fromEnv;
    const stored = store.toEnv()[GATEWAY_TOKEN_SECRET]?.trim();
    if (stored) return stored;
    // 密钥库不可用时的旧文件（见 `legacyEnv`）。**不新签**：那会写不进去
    const legacy = legacyEnv[GATEWAY_TOKEN_SECRET]?.trim();
    if (legacy) return legacy;
    /*
     * ② 本机网关常驻（D11）：内核永远打 loopback，所以这里总是自签一把给内核用的
     * 静态 token。云端 JWT 是另一回事，走 `account.ts`，不写进这个密钥槽。
     */
    if (!store.available) return undefined;
    const minted = randomBytes(24).toString('base64url');
    if (!store.set(GATEWAY_TOKEN_SECRET, minted)) return undefined;
    deps.logger?.info('desktop.gateway_token.minted', {
      reason: 'LOCAL',
      secretStore: store.backend,
    });
    return minted;
  }

  function customSpecs(): readonly CustomModelSpec[] {
    return models.models;
  }

  function env(): NodeJS.ProcessEnv {
    const secrets = withoutAccountSecrets(store.toEnv());
    const specs = customSpecs();
    return {
      ...deps.baseEnv,
      // 旧明文文件（只在密钥库不可用时非空）—— 让密钥库里的值盖住它，见 `legacyEnv`
      ...legacyEnv,
      // 密钥：**解密之后只进子进程环境**，不落盘。账号 refresh 不在这里（见 withoutAccountSecrets）
      ...secrets,
      ...(specs.length > 0 ? { [CUSTOM_MODELS_ENV]: encodeCustomModels(specs) } : {}),
      [MODEL_POLICY_ENV]: JSON.stringify({
        disabledModelIds: policy.disabledModelIds,
        allowCustomModels: policy.allowCustomModels,
        ...(policy.reason ? { reason: policy.reason } : {}),
      }),
      ...(token() ? { EVOWORK_GATEWAY_TOKEN: token() as string } : {}),
    };
  }

  function providerStates(): readonly ProviderKeyStateView[] {
    const described = new Map(store.describe().map((d) => [d.name, d.last4]));
    return KEY_PROVIDERS.map((provider) => {
      const last4 =
        described.get(provider.env) ??
        envLast4(legacyEnv[provider.env]) ??
        envLast4(deps.baseEnv[provider.env]);
      return {
        id: provider.id,
        label: provider.label,
        saved: last4 !== undefined,
        ...(last4 !== undefined ? { last4 } : {}),
      };
    });
  }

  return {
    mode: config.mode,
    inferredMode: inferred,
    get secretBackend() {
      return store.backend;
    },
    runsLocalGateway,
    upstreamBaseUrl,
    token,
    env,
    accountVault: {
      get: (name) => store.toEnv()[name] ?? legacyEnv[name],
      set: (name, value) => store.set(name, value),
      remove: (name) => store.remove(name),
    },

    view(catalog) {
      const described = new Map(store.describe().map((d) => [d.name, d.last4]));
      return {
        mode: config.mode,
        secretBackend: store.backend,
        // 有值 = 现在保存不了密钥，页面给两条并列的路（11 §4.3），**不替用户选**
        ...(store.available ? {} : { secretNotice: NO_KEYRING_NOTICE }),
        providers: providerStates(),
        customModels: models.models.map((model) => {
          const last4 = described.get(model.keyEnv);
          return {
            id: model.id,
            displayName: model.displayName,
            provider: model.provider,
            upstreamModel: model.upstreamModel,
            baseUrl: model.baseUrl,
            keySaved: last4 !== undefined,
            ...(last4 !== undefined ? { keyLast4: last4 } : {}),
          };
        }),
        models: catalog.models,
        allowCustomModels: policy.allowCustomModels,
        ...(policy.allowCustomModels
          ? {}
          : {
              lockedReason:
                policy.reason ?? '你所在组织要求使用统一配置的模型，这台电脑上不能自己添加模型。',
            }),
        // 账号会话由 `account.ts` 叠上来。这里如实是未登录，避免本模块去出网。
        signedIn: false,
        ...(catalog.unavailable !== undefined ? { catalogUnavailable: catalog.unavailable } : {}),
      };
    },

    saveProviderKey(input) {
      const provider = KEY_PROVIDERS.find((p) => p.id === input.providerId);
      if (!provider) return false;
      return store.set(provider.env, input.apiKey);
    },

    clearProviderKey(providerId) {
      const provider = KEY_PROVIDERS.find((p) => p.id === providerId);
      if (!provider) return false;
      return store.remove(provider.env);
    },

    /** 返回**拒绝的理由**（一句给用户看的话），`undefined` = 加成功了。 */
    addCustomModel(input) {
      if (!policy.allowCustomModels) {
        return policy.reason ?? '你所在组织要求使用统一配置的模型，这台电脑上不能自己添加模型。';
      }
      const refusal = validateCustomModel(input);
      if (refusal) return refusal;
      if (models.models.some((m) => m.id === input.id)) {
        return `已经有一个叫「${input.id}」的模型了，换个 id 或先删掉它。`;
      }
      if (input.apiKey.trim() === '') return '填上这个 endpoint 的 API 密钥。';
      if (!store.available) return NO_KEYRING_NOTICE;

      const keyEnv = assignKeyEnv(models.models);
      const record: CustomModelRecord = {
        id: input.id,
        displayName: (input.displayName ?? '').trim() || input.id,
        provider: input.provider as ProviderId,
        upstreamModel: input.upstreamModel,
        baseUrl: input.baseUrl,
        keyEnv,
        capabilities: {
          ...DEFAULT_CUSTOM_CAPABILITIES,
          ...(input.reasoning !== undefined ? { reasoning: input.reasoning } : {}),
          ...(input.imageInput !== undefined ? { imageInput: input.imageInput } : {}),
          ...(input.parallelToolCalls !== undefined
            ? { parallelToolCalls: input.parallelToolCalls }
            : {}),
          ...(input.promptCache !== undefined ? { promptCache: input.promptCache } : {}),
          ...(input.maxContextTokens !== undefined && input.maxContextTokens > 0
            ? { maxContextTokens: Math.floor(input.maxContextTokens) }
            : {}),
        },
      };
      /*
       * **先存密钥再写文件。** 反过来的话，密钥存失败会留下一条"有模型没密钥"的记录，
       * 而它在设置页看起来是正常的一条、发过去却 401 —— 而那种状态用户无法自己修
       * （他会以为密钥填过了）。
       */
      if (!store.set(keyEnv, input.apiKey)) return NO_KEYRING_NOTICE;
      const next = [...models.models, record];
      writeModelsFile(deps.paths.modelsFile, next);
      models = { models: next, dropped: 0 };
      return undefined;
    },

    removeCustomModel(id) {
      const target = models.models.find((m) => m.id === id);
      if (!target) return false;
      const next = models.models.filter((m) => m.id !== id);
      writeModelsFile(deps.paths.modelsFile, next);
      models = { models: next, dropped: 0 };
      /*
       * **密钥跟着删。** 留着的话它会在 `assignKeyEnv` 复用槽位时变成
       * "新模型静默用了旧模型的密钥"（`assignKeyEnv` 因此不复用槽位，两道防线）。
       */
      store.remove(target.keyEnv);
      return true;
    },

    setPlaintextFallback(accept) {
      deps.writeFlag(PLAINTEXT_FALLBACK_KEY, accept ? '1' : '0');
      // 重建：backend 是建库时算出来的，不重建的话这个选择要等下次启动才生效
      store = buildStore();
      deps.logger?.info('desktop.secrets.fallback_choice', { secretStore: store.backend });
    },
  };
}

function safeRead(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

function envLast4(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed !== '' ? trimmed.slice(-4) : undefined;
}

/** 账号 refresh 与厂商密钥共用密钥库，但不能进网关子进程环境。 */
function withoutAccountSecrets(env: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter(([key]) => !key.startsWith(ACCOUNT_SECRET_PREFIX)),
  );
}

/**
 * 连通性检查（设置页的「检查」按钮）。
 *
 * **它真的发一次请求，而且要说清这一点**：只查"目录里有没有这个 id"证明不了
 * 密钥是对的 —— 而用户按这个按钮想知道的正是"我贴的 key 能不能用"。
 * 所以这里往网关发一个最小请求（一句 ping、一 token 输出上限），
 * 并在 UI 上写明"会消耗极少 token"。
 *
 * 失败**不显示原始响应体**：它可能带上游的诊断信息（11 §4.3 的同一条纪律）。
 */
export async function probeModel(options: {
  readonly baseUrl: string;
  readonly token: string | undefined;
  readonly modelId: string;
  readonly fetchFn?: typeof fetch | undefined;
  readonly timeoutMs?: number | undefined;
}): Promise<ModelProbeResult> {
  if (!options.token) {
    return { ok: false, message: '还没有网关访问令牌，检查不了。' };
  }
  const fetchFn = options.fetchFn ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 30_000);
  try {
    const response = await fetchFn(`${options.baseUrl.replace(/\/$/, '')}/responses`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${options.token}`,
        'content-type': 'application/json',
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: options.modelId,
        input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'ping' }] }],
        stream: true,
      }),
    });
    if (response.status === 200) {
      // 不读完流：目的只是确认上游接受了这次调用（读完等于多烧几十个 token）
      await response.body?.cancel();
      return { ok: true, message: '通了：这个模型现在可以用。' };
    }
    if (response.status === 401) {
      return { ok: false, message: '网关拒绝了访问令牌（401）。' };
    }
    if (response.status === 403) {
      const body = (await response.json().catch(() => ({}))) as { error?: { message?: string } };
      // 403 是"被企业策略停用"，那句话本来就是给用户看的，原样透出
      return { ok: false, message: body.error?.message ?? '这个模型被策略停用了。' };
    }
    return {
      ok: false,
      message: `没通：网关返回 ${response.status}。密钥不对或上游地址填错时都是这个结果。`,
    };
  } catch {
    return { ok: false, message: '没通：连不上网关或上游超时。' };
  } finally {
    clearTimeout(timer);
  }
}
