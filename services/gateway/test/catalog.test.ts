/**
 * 模型目录的线上形状（11 §4.2 / 验收口径 9 · 13）。
 *
 * 改坏了的表现：用户以为在用自己的密钥、实际走了托管；或租户的厂商 key
 * 落到每一台客户机。
 */
import { describe, expect, it } from 'vitest';

import { P0_MODELS } from '../src/capabilities.js';
import { toCatalogEntry } from '../src/catalog.js';
import type { ResolvedModel } from '../src/layers.js';

function resolved(over: Partial<ResolvedModel> = {}): ResolvedModel {
  return {
    ...P0_MODELS[0]!,
    credentialSource: 'byok',
    layer: 'builtin',
    ...over,
  };
}

describe('目录条目不带密钥、不带上游', () => {
  it('每一条都有 credentialSource，类型里没有 apiKey / baseUrl', () => {
    const entry = toCatalogEntry(resolved());
    expect(entry.credentialSource).toBe('byok');
    expect(JSON.stringify(entry)).not.toContain('apiKey');
    expect(entry).not.toHaveProperty('baseUrl');
    expect(entry).not.toHaveProperty('apiKey');
  });

  it('hosted 条目如实标 hosted，且 JSON 里没有上游地址字段', () => {
    const entry = toCatalogEntry(resolved({ credentialSource: 'hosted', layer: 'tenant' }));
    expect(entry.credentialSource).toBe('hosted');
    expect(JSON.stringify(entry)).not.toContain('apiKey');
    expect(entry).not.toHaveProperty('baseUrl');
  });

  it('自定义模型进目录时也不带 baseUrl 或密钥', () => {
    const entry = toCatalogEntry(
      resolved({
        id: 'evowork/my-llama',
        displayName: 'My Llama',
        layer: 'custom',
        credentialSource: 'byok',
        verified: false,
      }),
    );
    expect(entry.layer).toBe('custom');
    expect(entry.credentialSource).toBe('byok');
    expect(JSON.stringify(entry)).not.toContain('apiKey');
    expect(entry).not.toHaveProperty('baseUrl');
  });
});
