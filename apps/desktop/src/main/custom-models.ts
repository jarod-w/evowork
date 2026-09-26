/**
 * `~/.evowork/models.toml` —— 第③层「本机自定义模型」的**元数据**（11 §4.1，M10a）。
 *
 * ## 文件里没有密钥
 *
 * 密钥在 `secret-store.ts`（系统钥匙串）。这个文件只有"这个模型长什么样、
 * 它的 endpoint 在哪、用哪个协议适配"，以及**密钥的变量名**。
 * 分开的理由写在 `@evowork/gateway` 的 `custom-models.ts` 里：
 * 一个 JSON 里塞 N 把密钥意味着任何一次"打印下配置"都是 N 把同时泄漏。
 *
 * ## 为什么解析在这里，形状在网关那边
 *
 * 形状（`CustomModelSpec`）是**宿主与网关共用的线上契约**，所以定在网关包里；
 * 而"读一个 TOML 文件"是本机的事，网关连配置文件都不读（Q14 / K6）。
 * 两边共用一个类型 + 一个 `validateCustomModel`，是为了让那条缝出现在类型层面。
 *
 * ## 为什么手写 TOML 而不是引一个解析器
 *
 * 与 `parseGatewayBaseUrl` / `parseAppConfig` 同一条：需要的是一张
 * `[[models]]` 表的几个字符串字段。引一棵依赖树的代价还包括 K5 的
 * `THIRD_PARTY_NOTICES`（企业合规要逐个过），而这里的语法面窄到可以枚举。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

import {
  CUSTOM_KEY_ENV_PREFIX,
  findKnownModel,
  validateCustomModel,
  type CustomModelSpec,
} from '@evowork/gateway';
import type { ModelCapabilities } from '@evowork/gateway';

/**
 * **不在能力表里的**自定义模型的能力位默认值：只承诺最基本的两项。
 *
 * 认得出来的型号（`findKnownModel`）不走这里 —— 见 `capabilitiesFor`。
 */
export const DEFAULT_CUSTOM_CAPABILITIES: ModelCapabilities = Object.freeze({
  streaming: true,
  toolCalls: true,
  /*
   * 三个"高级"能力默认 false，方向是刻意的：能力位标 true 而上游没有，
   * 后果是推理区空壳、图片传上去看不见、并行工具调用被静默串行 —— 都由用户承担。
   * 标 false 而上游其实有，后果只是少一个徽标。**失败朝保守侧**（D2 的降级必须显式）。
   */
  parallelToolCalls: false,
  reasoning: false,
  promptCache: false,
  imageInput: false,
  maxContextTokens: 32_000,
});

/**
 * 一条自定义模型该带什么能力位。
 *
 * **认得出来的型号以 `known-models.ts` 为准，认不出来的才用保守默认 + 用户声明。**
 *
 * 2026-09-26 的缺陷就出在这里缺了一层：设置页的「添加模型」对话框**根本没有能力位的
 * 输入项**（11 §4.4 只问供应商 / 密钥 / 模型名 / endpoint），所以每一条自定义模型
 * 存下来的都是 `DEFAULT_CUSTOM_CAPABILITIES` —— 用户加了 `moonshot/kimi-k3`，
 * 拿到的是一条"不会读图、不会推理、不能并行调工具"的 Kimi K3。
 *
 * ## 为什么**读文件时也要再解析一次**，而不是只在写入时种一次
 *
 * 缺陷发生在先：用户机器上的 `models.toml` 里已经躺着 `image_input = false`。
 * 只改写入路径的话，那两条要用户去删了重加才会好 —— 而他不会知道要这么做
 * （界面上没有任何东西提示这个值是我们种的）。
 *
 * 覆盖掉文件里的值也不会抹掉"用户的声明"：那个对话框从来没让用户声明过能力位。
 * 等到它真的有开关那天，这里要改成"用户显式改过的才压过表" —— 到时候文件里
 * 需要多一个"这条是谁写的"的标记，而不是继续靠猜。
 */
export function capabilitiesFor(
  provider: string,
  upstreamModel: string,
  declared?: Partial<ModelCapabilities> | undefined,
): ModelCapabilities {
  const known = findKnownModel(provider, upstreamModel);
  if (known) return known.capabilities;
  return { ...DEFAULT_CUSTOM_CAPABILITIES, ...declared };
}

/** 一条自定义模型在文件里的样子（= `CustomModelSpec`，只是 keyEnv 由我们分配）。 */
export type CustomModelRecord = CustomModelSpec;

/** 第 n 条自定义模型的密钥变量名。**按 id 的稳定序号分配**，见 `assignKeyEnv`。 */
export function keyEnvFor(index: number): string {
  return `${CUSTOM_KEY_ENV_PREFIX}${index + 1}`;
}

/**
 * 解析 `models.toml`。
 *
 * **一条读不懂就丢那一条**，不是整个文件失败：用户手改坏一条不该让另外几条
 * 也用不了。但必须能被看见 —— 返回 `dropped` 让调用方记一条
 * （CLAUDE.md §9.1「认不出来也要如实说」）。
 */
export function parseModelsToml(text: string): {
  readonly models: readonly CustomModelRecord[];
  readonly dropped: number;
} {
  const models: CustomModelRecord[] = [];
  let dropped = 0;
  let current: Record<string, string> | undefined;

  const flush = (): void => {
    if (!current) return;
    // 认得出来的型号以能力表为准，文件里那几行只对表外的型号起作用（见 `capabilitiesFor`）
    const capabilities = capabilitiesFor(current.provider ?? '', current.upstream_model ?? '', {
      ...(current.reasoning !== undefined ? { reasoning: current.reasoning === 'true' } : {}),
      ...(current.image_input !== undefined ? { imageInput: current.image_input === 'true' } : {}),
      ...(current.parallel_tool_calls !== undefined
        ? { parallelToolCalls: current.parallel_tool_calls === 'true' }
        : {}),
      ...(current.prompt_cache !== undefined
        ? { promptCache: current.prompt_cache === 'true' }
        : {}),
      ...(current.max_context_tokens !== undefined &&
      Number.isFinite(Number(current.max_context_tokens))
        ? { maxContextTokens: Number(current.max_context_tokens) }
        : {}),
    });
    const record = {
      id: current.id ?? '',
      displayName: current.display_name ?? current.id ?? '',
      provider: current.provider as CustomModelSpec['provider'],
      upstreamModel: current.upstream_model ?? '',
      baseUrl: current.base_url ?? '',
      keyEnv: current.key_env ?? '',
      ...(current.auth_header_env ? { authHeaderEnv: current.auth_header_env } : {}),
      capabilities,
    };
    current = undefined;
    if (validateCustomModel(record) !== undefined || record.keyEnv === '') {
      dropped += 1;
      return;
    }
    models.push(record);
  };

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    if (line === '[[models]]') {
      flush();
      current = {};
      continue;
    }
    if (line.startsWith('[')) {
      flush();
      continue;
    }
    if (!current) continue;
    const m = /^([a-z_]+)\s*=\s*(.*)$/.exec(line);
    if (!m?.[1]) continue;
    let value = (m[2] ?? '').trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    current[m[1]] = value;
  }
  flush();
  return { models, dropped };
}

export function serializeModelsToml(models: readonly CustomModelRecord[]): string {
  const lines = [
    '# EvoWork 自定义模型（第③层，11 §4.1）。**这个文件里没有密钥** ——',
    '# 密钥在系统钥匙串里，这里只写它的环境变量名（key_env）。',
    '# 由设置页写入；手改也可以，读不懂的条目会被丢掉并在日志里报一条。',
    '',
  ];
  for (const model of models) {
    lines.push(
      '[[models]]',
      `id = "${model.id}"`,
      `display_name = "${model.displayName}"`,
      `provider = "${model.provider}"`,
      `upstream_model = "${model.upstreamModel}"`,
      `base_url = "${model.baseUrl}"`,
      `key_env = "${model.keyEnv}"`,
      ...(model.authHeaderEnv ? [`auth_header_env = "${model.authHeaderEnv}"`] : []),
      `reasoning = ${String(model.capabilities.reasoning)}`,
      `image_input = ${String(model.capabilities.imageInput)}`,
      `parallel_tool_calls = ${String(model.capabilities.parallelToolCalls)}`,
      `prompt_cache = ${String(model.capabilities.promptCache)}`,
      `max_context_tokens = ${String(model.capabilities.maxContextTokens)}`,
      '',
    );
  }
  return lines.join('\n');
}

export function readModelsFile(path: string): {
  readonly models: readonly CustomModelRecord[];
  readonly dropped: number;
} {
  if (!existsSync(path)) return { models: [], dropped: 0 };
  try {
    return parseModelsToml(readFileSync(path, 'utf8'));
  } catch {
    return { models: [], dropped: 1 };
  }
}

export function writeModelsFile(path: string, models: readonly CustomModelRecord[]): void {
  writeFileSync(path, serializeModelsToml(models), { encoding: 'utf8', mode: 0o600 });
}

/**
 * 给一条新模型分配密钥变量名。
 *
 * **不复用已被占用的号**：删掉第 2 条再加一条时如果重发 `_2`，
 * 而钥匙串里那把旧的 `_2` 还在（删模型时清了才没有），新模型就会静默地
 * 用上一个模型的密钥 —— 两个模块各自都对，合起来不对的标准形状。
 */
export function assignKeyEnv(existing: readonly CustomModelRecord[]): string {
  const used = new Set(existing.map((m) => m.keyEnv));
  for (let i = 0; i < 1000; i += 1) {
    const candidate = keyEnvFor(i);
    if (!used.has(candidate)) return candidate;
  }
  // 1000 条自定义模型不是真实场景；到这里说明有别的东西错了，明确报出来
  throw new Error('自定义模型太多了（超过 1000 条），无法再分配密钥槽位。');
}
