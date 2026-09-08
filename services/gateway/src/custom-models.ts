/**
 * 本机宿主注入的自定义模型（11 §4.1 第 ③ 层）。
 *
 * 网关**不读文件**：元数据走 `EVOWORK_CUSTOM_MODELS`（JSON，不含密钥），
 * 密钥走 `EVOWORK_MODEL_KEY_<id>`。密钥与元数据拆开，这样一份泄漏的 JSON
 * 日志里仍然没有 key。
 */
import type { CredentialSource, ModelRegistryEntry } from './capabilities.js';

export type { CredentialSource };

export function customModelKeyEnv(id: string): string {
  return `EVOWORK_MODEL_KEY_${id.replace(/[^A-Za-z0-9]/g, '_')}`;
}

export interface CustomModelEnvEntry {
  readonly id: string;
  readonly displayName: string;
  readonly upstreamModel: string;
  readonly adapter: string;
  readonly baseUrl: string;
}

const DEFAULT_CAPS = {
  streaming: true,
  toolCalls: true,
  parallelToolCalls: false,
  reasoning: false,
  promptCache: false,
  imageInput: false,
  maxContextTokens: 128_000,
} as const;

function adapterToProvider(adapter: string): ModelRegistryEntry['provider'] {
  if (adapter === 'deepseek' || adapter === 'moonshot' || adapter === 'zhipu') return adapter;
  return 'private';
}

export function toRegistryEntry(entry: CustomModelEnvEntry): ModelRegistryEntry {
  return {
    id: entry.id,
    provider: adapterToProvider(entry.adapter),
    upstreamModel: entry.upstreamModel,
    displayName: entry.displayName,
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
    capabilities: DEFAULT_CAPS,
    credentialSource: 'byok',
    baseUrl: entry.baseUrl,
  };
}

export function parseCustomModelsJson(raw: string | undefined): CustomModelEnvEntry[] {
  if (!raw || raw.trim().length === 0) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const out: CustomModelEnvEntry[] = [];
    for (const item of parsed) {
      if (typeof item !== 'object' || item === null) continue;
      const rec = item as Record<string, unknown>;
      if (typeof rec.id !== 'string' || typeof rec.baseUrl !== 'string') continue;
      if (typeof rec.upstreamModel !== 'string' || typeof rec.adapter !== 'string') continue;
      if (typeof rec.displayName !== 'string') continue;
      // 密钥字段即使有人也丢掉 —— 这条 JSON 会进进程环境，有人误把 key 塞进来
      out.push({
        id: rec.id,
        displayName: rec.displayName,
        upstreamModel: rec.upstreamModel,
        adapter: rec.adapter,
        baseUrl: rec.baseUrl,
      });
    }
    return out;
  } catch {
    return [];
  }
}
