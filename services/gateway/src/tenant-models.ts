/**
 * 第 ②' 层「租户默认模型」的线上形状（11 §4.1，M10b）。
 *
 * 客户端与本机网关看到的 JSON **没有 apiKey，也没有上游 baseUrl**（11 §12 第 13 条）。
 * 真要转发时，本机网关把整段请求转到 `EVOWORK_UPSTREAM_BASE_URL`，由**云端网关**持 key。
 */
import type { ModelRegistryEntry, ProviderId } from './capabilities.js';

export const TENANT_MODELS_ENV = 'EVOWORK_TENANT_MODELS';
export const UPSTREAM_BASE_URL_ENV = 'EVOWORK_UPSTREAM_BASE_URL';
export const ACCESS_JWT_ENV = 'EVOWORK_ACCESS_JWT';
export const AUTH_MODE_ENV = 'EVOWORK_AUTH_MODE';

const PROVIDERS: readonly ProviderId[] = ['deepseek', 'moonshot', 'zhipu', 'private'];

export function parseTenantModels(raw: string | undefined): {
  readonly specs: readonly ModelRegistryEntry[];
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
  const specs: ModelRegistryEntry[] = [];
  let dropped = 0;
  for (const item of parsed) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      dropped += 1;
      continue;
    }
    const rec = item as Record<string, unknown>;
    // 类型上就不该有这两项。出现了 = 有人把服务端内部形状发到了本机进程环境
    if ('apiKey' in rec || 'baseUrl' in rec) {
      dropped += 1;
      continue;
    }
    const id = typeof rec.id === 'string' ? rec.id : '';
    const provider = PROVIDERS.find((p) => p === rec.provider);
    const upstreamModel = typeof rec.upstreamModel === 'string' ? rec.upstreamModel : '';
    const displayName = typeof rec.displayName === 'string' ? rec.displayName : id;
    if (!id || !provider || !upstreamModel) {
      dropped += 1;
      continue;
    }
    specs.push({
      id,
      provider,
      upstreamModel,
      displayName,
      tier: rec.tier === 'flagship' || rec.tier === 'light' ? rec.tier : 'standard',
      verified: rec.verified === true,
      unverified: [],
      notes: typeof rec.notes === 'string' ? rec.notes : '',
      capabilities: {
        streaming: true,
        toolCalls: true,
        parallelToolCalls: false,
        reasoning: false,
        promptCache: false,
        imageInput: false,
        maxContextTokens: 8_000,
      },
    });
  }
  return { specs, dropped };
}

export function encodeTenantModels(specs: readonly ModelRegistryEntry[]): string {
  return JSON.stringify(
    specs.map((s) => ({
      id: s.id,
      displayName: s.displayName,
      provider: s.provider,
      upstreamModel: s.upstreamModel,
      tier: s.tier,
      verified: s.verified,
    })),
  );
}
