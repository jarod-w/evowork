/**
 * 模型注册表四层合并（11 §4.1）。
 *
 * 合并顺序：② 企业覆盖 > ②' 租户默认 > ③ 本机自定义 > ① 内置元数据。
 * M10a 只接通 ① 与 ③；② / ②' 的参数留着，空输入时就是「这一层没有」。
 *
 * **被企业停用的模型仍然出现在结果里**，带着停用原因。消失的东西无法被排查，
 * 用户会去问客服「我明明配了密钥为什么没有」。
 *
 * 返回值类型上没有 `apiKey`，hosted 条目没有 `endpoint`（11 验收口径 13）。
 */
import {
  capabilityNotices,
  type ModelCapabilities,
  type ModelRegistryEntry,
} from '@evowork/gateway';

import { customKeySlot, type CustomModelSpec, type ProtocolAdapter } from './models-toml.js';
import { last4 } from './secret-store.js';

export type CredentialSource = 'byok' | 'hosted' | 'private';
export type ModelLayer = 'builtin' | 'tenant' | 'custom' | 'enterprise';

export const PROVIDER_KEY_SLOT: Readonly<Record<string, string>> = Object.freeze({
  deepseek: 'DEEPSEEK_API_KEY',
  moonshot: 'MOONSHOT_API_KEY',
  zhipu: 'ZHIPU_API_KEY',
});

export interface EnterpriseOverlay {
  readonly disabledIds?: readonly string[] | undefined;
  readonly allowCustomModels?: boolean | undefined;
}

export interface MergedModel {
  readonly id: string;
  readonly displayName: string;
  readonly provider: string;
  readonly upstreamModel: string;
  readonly credentialSource: CredentialSource;
  readonly layer: ModelLayer;
  readonly disabled: boolean;
  readonly disabledReason?: string | undefined;
  readonly hasKey: boolean;
  readonly savedLast4?: string | undefined;
  readonly adapter?: ProtocolAdapter | undefined;
  /** 仅 byok 自定义模型。hosted 条目类型上就没有这个字段。 */
  readonly endpoint?: string | undefined;
  readonly capabilities: ModelCapabilities;
  readonly notices: readonly string[];
}

export const ENTERPRISE_DISABLED = '这个模型已被你所在组织停用。';
export const CUSTOM_LOCKED = '你所在组织要求登录后使用统一配置的模型。';

const CUSTOM_DEFAULT_CAPABILITIES: ModelCapabilities = Object.freeze({
  streaming: true,
  toolCalls: true,
  parallelToolCalls: false,
  reasoning: false,
  promptCache: false,
  imageInput: false,
  maxContextTokens: 128_000,
});

function slotFor(provider: string, id: string, layer: ModelLayer): string {
  if (layer === 'custom') return customKeySlot(id);
  return PROVIDER_KEY_SLOT[provider] ?? customKeySlot(id);
}

function keyState(
  keys: Readonly<Record<string, string>>,
  slot: string,
): { readonly hasKey: boolean; readonly savedLast4?: string } {
  const value = keys[slot]?.trim();
  if (!value) return { hasKey: false };
  return { hasKey: true, savedLast4: last4(value) };
}

function fromBuiltin(
  model: ModelRegistryEntry,
  keys: Readonly<Record<string, string>>,
): MergedModel {
  const slot = slotFor(model.provider, model.id, 'builtin');
  const key = keyState(keys, slot);
  return {
    id: model.id,
    displayName: model.displayName,
    provider: model.provider,
    upstreamModel: model.upstreamModel,
    credentialSource: 'byok',
    layer: 'builtin',
    disabled: false,
    hasKey: key.hasKey,
    ...(key.savedLast4 !== undefined ? { savedLast4: key.savedLast4 } : {}),
    capabilities: model.capabilities,
    notices: capabilityNotices(model),
  };
}

function fromTenant(model: ModelRegistryEntry): MergedModel {
  return {
    id: model.id,
    displayName: model.displayName,
    provider: model.provider,
    upstreamModel: model.upstreamModel,
    credentialSource: 'hosted',
    layer: 'tenant',
    disabled: false,
    hasKey: false,
    capabilities: model.capabilities,
    notices: capabilityNotices(model),
  };
}

function fromCustom(spec: CustomModelSpec, keys: Readonly<Record<string, string>>): MergedModel {
  const slot = customKeySlot(spec.id);
  const key = keyState(keys, slot);
  const fake: ModelRegistryEntry = {
    id: spec.id,
    provider: 'private',
    upstreamModel: spec.upstreamModel,
    displayName: spec.displayName,
    tier: 'standard',
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
    notes: '',
    capabilities: CUSTOM_DEFAULT_CAPABILITIES,
  };
  return {
    id: spec.id,
    displayName: spec.displayName,
    provider: 'private',
    upstreamModel: spec.upstreamModel,
    credentialSource: 'byok',
    layer: 'custom',
    disabled: false,
    hasKey: key.hasKey,
    ...(key.savedLast4 !== undefined ? { savedLast4: key.savedLast4 } : {}),
    adapter: spec.adapter,
    endpoint: spec.baseUrl,
    capabilities: CUSTOM_DEFAULT_CAPABILITIES,
    notices: capabilityNotices(fake),
  };
}

export function mergeModelLayers(input: {
  readonly builtin: readonly ModelRegistryEntry[];
  readonly tenant?: readonly ModelRegistryEntry[] | undefined;
  readonly custom?: readonly CustomModelSpec[] | undefined;
  readonly overlay?: EnterpriseOverlay | undefined;
  readonly keys?: Readonly<Record<string, string>> | undefined;
}): MergedModel[] {
  const keys = input.keys ?? {};
  const byId = new Map<string, MergedModel>();

  for (const model of input.builtin) byId.set(model.id, fromBuiltin(model, keys));

  // ②' 压 ③ 与 ①：同一 id 租户口径优先
  for (const model of input.tenant ?? []) byId.set(model.id, fromTenant(model));

  for (const spec of input.custom ?? []) {
    const existing = byId.get(spec.id);
    if (existing?.layer === 'tenant') continue;
    byId.set(spec.id, fromCustom(spec, keys));
  }

  const overlay = input.overlay;
  const disabled = new Set(overlay?.disabledIds ?? []);
  const lockCustom = overlay?.allowCustomModels === false;

  const merged = [...byId.values()].map((model) => {
    if (disabled.has(model.id)) {
      return {
        ...model,
        disabled: true,
        disabledReason: ENTERPRISE_DISABLED,
        layer: 'enterprise' as const,
      };
    }
    if (lockCustom && model.layer === 'custom') {
      return { ...model, disabled: true, disabledReason: CUSTOM_LOCKED };
    }
    return model;
  });

  return merged;
}

/** 设置页 / IPC 用。断言：结果里没有 apiKey，hosted 没有 endpoint。 */
export function assertCatalogSafe(models: readonly MergedModel[]): void {
  for (const model of models) {
    if ('apiKey' in model) throw new Error(`目录条目 ${model.id} 带了 apiKey`);
    if (model.credentialSource === 'hosted' && model.endpoint !== undefined) {
      throw new Error(`hosted 条目 ${model.id} 带了上游 endpoint`);
    }
  }
}
