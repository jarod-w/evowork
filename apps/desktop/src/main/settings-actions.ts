/**
 * 设置页用的本机动作（11 §4）。
 *
 * 密钥只在这一层解密，灌进网关子进程环境。返回值类型上没有完整密钥，
 * 只有后四位（hosted 条目连后四位都没有）。
 */
import { P0_MODELS } from '@evowork/gateway';
import type { Logger } from '@evowork/logging';

import { ensureAppConfig, readAppConfig, writeSecretFallback } from './app-config.js';
import {
  assertCatalogSafe,
  mergeModelLayers,
  PROVIDER_KEY_SLOT,
  type MergedModel,
} from './model-registry.js';
import {
  customKeySlot,
  readModelsToml,
  validateCustomModel,
  writeModelsToml,
  type CustomModelSpec,
} from './models-toml.js';
import {
  keyLooksValid,
  loadSecrets,
  memoryCodec,
  migrateGatewayEnv,
  plaintextCodec,
  removeKey,
  saveSecrets,
  secretsToEnv,
  secretStoreStatus,
  SECRET_STORE_UNAVAILABLE,
  upsertKey,
  type SecretCodec,
} from './secret-store.js';
import type {
  AddCustomModelInput,
  ChooseSecretFallbackInput,
  ClearModelKeyInput,
  SaveModelKeyInput,
  SettingsModelRow,
  SettingsMutationResult,
  SettingsView,
} from '../shared/ipc.js';

export interface SettingsPaths {
  readonly appToml: string;
  readonly modelsToml: string;
  readonly secretsBin: string;
  readonly gatewayEnv: string;
}

export interface SettingsPorts {
  getSettings(): Promise<SettingsView>;
  saveModelKey(input: SaveModelKeyInput): Promise<SettingsMutationResult>;
  clearModelKey(input: ClearModelKeyInput): Promise<SettingsMutationResult>;
  addCustomModel(input: AddCustomModelInput): Promise<SettingsMutationResult>;
  removeCustomModel(input: { id: string }): Promise<SettingsMutationResult>;
  chooseSecretFallback(input: ChooseSecretFallbackInput): Promise<SettingsView>;
  /** 宿主灌进网关子进程用。不是 IPC。 */
  currentKeys(): Record<string, string>;
  saveKeys(keys: Readonly<Record<string, string>>): Promise<SettingsMutationResult>;
}

function toRow(model: MergedModel): SettingsModelRow {
  return {
    id: model.id,
    displayName: model.displayName,
    provider: model.provider,
    upstreamModel: model.upstreamModel,
    credentialSource: model.credentialSource,
    layer: model.layer,
    disabled: model.disabled,
    ...(model.disabledReason !== undefined ? { disabledReason: model.disabledReason } : {}),
    ...(model.savedLast4 !== undefined ? { savedLast4: model.savedLast4 } : {}),
    ...(model.adapter !== undefined ? { adapter: model.adapter } : {}),
    ...(model.endpoint !== undefined ? { endpoint: model.endpoint } : {}),
    capabilities: model.capabilities,
    notices: model.notices,
  };
}

function writeCodec(
  injected: SecretCodec | undefined,
  fallback: 'plaintext' | 'ephemeral' | undefined,
): SecretCodec | undefined {
  if (injected?.available) return injected;
  if (fallback === 'plaintext') return plaintextCodec();
  if (fallback === 'ephemeral') return memoryCodec();
  return undefined;
}

export function customModelsPayload(models: readonly CustomModelSpec[]): string {
  return JSON.stringify(
    models.map((m) => ({
      id: m.id,
      displayName: m.displayName,
      upstreamModel: m.upstreamModel,
      adapter: m.adapter,
      baseUrl: m.baseUrl,
    })),
  );
}

export function createSettingsPorts(options: {
  readonly paths: SettingsPaths;
  readonly codec?: SecretCodec | undefined;
  readonly appName: string;
  readonly appVersion: string;
  readonly userName: string;
  readonly kernelBaseUrl: string;
  readonly logger?: Logger | undefined;
  readonly onKeysChanged: () => Promise<void>;
}): SettingsPorts {
  const { paths } = options;
  let sessionKeys: Record<string, string> = {};

  const fallbackOf = (): 'plaintext' | 'ephemeral' | undefined =>
    readAppConfig(paths.appToml).secrets?.fallback;

  const codecOf = (): SecretCodec | undefined => writeCodec(options.codec, fallbackOf());

  const loadKeys = (): Record<string, string> => {
    const codec = codecOf();
    const fallback = fallbackOf();
    if (fallback === 'ephemeral') return { ...sessionKeys };
    const fromDisk = codec ? loadSecrets(paths.secretsBin, codec).keys : {};
    return { ...fromDisk, ...sessionKeys };
  };

  const persist = (
    keys: Record<string, string>,
  ): { readonly ok: true } | { readonly ok: false; readonly needsChoice: true } => {
    const fallback = fallbackOf();
    if (fallback === 'ephemeral') {
      sessionKeys = keys;
      return { ok: true };
    }
    const codec = codecOf();
    if (!codec) return { ok: false, needsChoice: true };
    const saved = saveSecrets(paths.secretsBin, keys, codec);
    if (!saved.ok) return saved;
    sessionKeys = {};
    return { ok: true };
  };

  const buildSettings = (): SettingsView => {
    ensureAppConfig(paths.appToml, options.kernelBaseUrl);
    const app = readAppConfig(paths.appToml);
    const status = secretStoreStatus(options.codec, app.secrets?.fallback);
    const custom = readModelsToml(paths.modelsToml);
    const merged = mergeModelLayers({
      builtin: P0_MODELS,
      custom,
      keys: loadKeys(),
    });
    assertCatalogSafe(merged);
    return {
      mode: app.gateway.mode,
      secretStore: status,
      ...(status.needsChoice ? { secretStoreCopy: SECRET_STORE_UNAVAILABLE } : {}),
      models: merged.map(toRow),
      appName: options.appName,
      appVersion: options.appVersion,
      userName: options.userName,
      allowCustomModels: true,
    };
  };

  const mutate = async (nextKeys: Record<string, string>): Promise<SettingsMutationResult> => {
    const saved = persist(nextKeys);
    if (!saved.ok) {
      return {
        ok: false,
        refused: SECRET_STORE_UNAVAILABLE,
        secretStoreNeedsChoice: true,
        settings: buildSettings(),
      };
    }
    options.logger?.info('desktop.secret_store.updated', {
      itemCount: Object.keys(nextKeys).length,
      secretStore: codecOf()?.kind ?? 'memory',
    });
    await options.onKeysChanged();
    return { ok: true, settings: buildSettings() };
  };

  return {
    async getSettings() {
      return buildSettings();
    },

    async saveModelKey(input: SaveModelKeyInput) {
      if (!keyLooksValid(input.value)) {
        return {
          ok: false,
          refused: '密钥太短或不该含空白。',
          settings: buildSettings(),
        };
      }
      if (!input.slot.trim()) {
        return { ok: false, refused: '不知道这条密钥属于哪个模型。', settings: buildSettings() };
      }
      return mutate(upsertKey(loadKeys(), input.slot, input.value));
    },

    async clearModelKey(input: ClearModelKeyInput) {
      return mutate(removeKey(loadKeys(), input.slot));
    },

    async addCustomModel(input: AddCustomModelInput) {
      const parsed = validateCustomModel(input);
      if (!parsed.ok) return { ok: false, refused: parsed.refused, settings: buildSettings() };
      const existing = readModelsToml(paths.modelsToml);
      if (existing.some((m) => m.id === parsed.model.id)) {
        return { ok: false, refused: '已经有这个模型 id 了。', settings: buildSettings() };
      }
      writeModelsToml(paths.modelsToml, [...existing, parsed.model]);
      if (input.apiKey?.trim()) {
        if (!keyLooksValid(input.apiKey)) {
          return {
            ok: false,
            refused: '密钥太短或不该含空白。',
            settings: buildSettings(),
          };
        }
        return mutate(upsertKey(loadKeys(), customKeySlot(parsed.model.id), input.apiKey));
      }
      await options.onKeysChanged();
      return { ok: true, settings: buildSettings() };
    },

    async removeCustomModel(input: { id: string }) {
      const next = readModelsToml(paths.modelsToml).filter((m) => m.id !== input.id);
      writeModelsToml(paths.modelsToml, next);
      return mutate(removeKey(loadKeys(), customKeySlot(input.id)));
    },

    async chooseSecretFallback(input: ChooseSecretFallbackInput) {
      writeSecretFallback(paths.appToml, input.fallback);
      options.logger?.info('desktop.secret_store.fallback', {
        secretStore: input.fallback === 'plaintext' ? 'plaintext-fallback' : 'memory',
      });
      if (input.fallback === 'plaintext') {
        migrateGatewayEnv({
          gatewayEnvPath: paths.gatewayEnv,
          secretsPath: paths.secretsBin,
          codec: plaintextCodec(),
        });
      }
      await options.onKeysChanged();
      return buildSettings();
    },

    currentKeys: loadKeys,

    async saveKeys(keys: Readonly<Record<string, string>>) {
      let next = loadKeys();
      for (const [slot, value] of Object.entries(keys)) {
        if (!keyLooksValid(value)) {
          return {
            ok: false,
            refused: '密钥太短或不该含空白。',
            settings: buildSettings(),
          };
        }
        next = upsertKey(next, slot, value);
      }
      return mutate(next);
    },
  };
}

export function providerKeysFromAccess(input: {
  readonly deepseekApiKey?: string | undefined;
  readonly moonshotApiKey?: string | undefined;
  readonly zhipuApiKey?: string | undefined;
}): Record<string, string> {
  const keys: Record<string, string> = {};
  if (input.deepseekApiKey?.trim()) keys[PROVIDER_KEY_SLOT.deepseek!] = input.deepseekApiKey.trim();
  if (input.moonshotApiKey?.trim()) keys[PROVIDER_KEY_SLOT.moonshot!] = input.moonshotApiKey.trim();
  if (input.zhipuApiKey?.trim()) keys[PROVIDER_KEY_SLOT.zhipu!] = input.zhipuApiKey.trim();
  return keys;
}

export function mergeSecretEnv(
  fileEnv: Record<string, string>,
  keys: Readonly<Record<string, string>>,
  custom: readonly CustomModelSpec[],
): Record<string, string> {
  return {
    ...fileEnv,
    ...secretsToEnv(keys),
    EVOWORK_CUSTOM_MODELS: customModelsPayload(custom),
  };
}

export { SECRET_STORE_UNAVAILABLE };
