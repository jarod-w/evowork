/**
 * 四层合并（11 §4.1）。盯的是「加一条就绕过企业策略」和「停用的模型消失」。
 */
import { describe, expect, it } from 'vitest';

import { P0_MODELS } from '@evowork/gateway';

import {
  assertCatalogSafe,
  CUSTOM_LOCKED,
  ENTERPRISE_DISABLED,
  mergeModelLayers,
} from '../src/main/model-registry.js';
import type { CustomModelSpec } from '../src/main/models-toml.js';

const CUSTOM: CustomModelSpec = {
  id: 'evowork/my-llama',
  displayName: 'My Llama',
  upstreamModel: 'llama-3',
  adapter: 'openai-chat',
  baseUrl: 'https://llm.example/v1',
};

describe('① + ③', () => {
  it('没填密钥的内置模型也列出来，只是 hasKey=false —— 设置页要能录入', () => {
    const merged = mergeModelLayers({ builtin: P0_MODELS });
    expect(merged.map((m) => m.id)).toEqual(P0_MODELS.map((m) => m.id));
    expect(merged.every((m) => m.credentialSource === 'byok')).toBe(true);
    expect(merged.every((m) => m.hasKey === false)).toBe(true);
    assertCatalogSafe(merged);
  });

  it('密钥只以 last4 出现，完整值不在结果里', () => {
    const secret = 'sk-live-secret-abcd';
    const merged = mergeModelLayers({
      builtin: P0_MODELS,
      keys: { DEEPSEEK_API_KEY: secret },
    });
    const deepseek = merged.find((m) => m.provider === 'deepseek');
    expect(deepseek?.hasKey).toBe(true);
    expect(deepseek?.savedLast4).toBe('abcd');
    expect(JSON.stringify(merged)).not.toContain(secret);
    expect(merged.some((m) => 'apiKey' in m)).toBe(false);
  });

  it('自定义模型带 endpoint，内置没有', () => {
    const merged = mergeModelLayers({ builtin: P0_MODELS, custom: [CUSTOM] });
    const mine = merged.find((m) => m.id === CUSTOM.id);
    expect(mine?.layer).toBe('custom');
    expect(mine?.adapter).toBe('openai-chat');
    expect(mine?.endpoint).toBe(CUSTOM.baseUrl);
    expect(merged.find((m) => m.layer === 'builtin')?.endpoint).toBeUndefined();
  });
});

describe("② / ②' 压过 ③", () => {
  it('同一 id 租户口径优先，自定义那条进不来', () => {
    const tenant = {
      ...P0_MODELS[0]!,
      id: CUSTOM.id,
      displayName: 'Tenant Llama',
    };
    const merged = mergeModelLayers({
      builtin: P0_MODELS,
      tenant: [tenant],
      custom: [CUSTOM],
    });
    const hit = merged.find((m) => m.id === CUSTOM.id);
    expect(hit?.layer).toBe('tenant');
    expect(hit?.credentialSource).toBe('hosted');
    expect(hit?.endpoint).toBeUndefined();
    assertCatalogSafe(merged);
  });

  it('企业停用的模型仍然显示，标停用原因', () => {
    const merged = mergeModelLayers({
      builtin: P0_MODELS,
      overlay: { disabledIds: ['evowork/kimi-k3'] },
    });
    const kimi = merged.find((m) => m.id === 'evowork/kimi-k3');
    expect(kimi).toBeDefined();
    expect(kimi?.disabled).toBe(true);
    expect(kimi?.disabledReason).toBe(ENTERPRISE_DISABLED);
    expect(merged.some((m) => m.id === 'evowork/kimi-k3')).toBe(true);
  });

  it('锁了自定义模型时，本机追加的那条还在，只是不能用', () => {
    const merged = mergeModelLayers({
      builtin: P0_MODELS,
      custom: [CUSTOM],
      overlay: { allowCustomModels: false },
    });
    const mine = merged.find((m) => m.id === CUSTOM.id);
    expect(mine?.disabled).toBe(true);
    expect(mine?.disabledReason).toBe(CUSTOM_LOCKED);
  });
});
