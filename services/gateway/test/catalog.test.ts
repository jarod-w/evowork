/**
 * 模型目录的线上形状（11 §4.2 / 验收口径 9 · 13）。
 *
 * 改坏了的表现：用户以为在用自己的密钥、实际走了托管；或租户的厂商 key
 * 落到每一台客户机。
 */
import { describe, expect, it } from 'vitest';

import { P0_MODELS } from '../src/capabilities.js';
import { toCatalogEntry } from '../src/catalog.js';
import { toRegistryEntry } from '../src/custom-models.js';

describe('目录条目不带密钥、不带上游', () => {
  it('每一条都有 credentialSource，缺省 byok', () => {
    const entry = toCatalogEntry(P0_MODELS[0]!);
    expect(entry.credentialSource).toBe('byok');
    expect(JSON.stringify(entry)).not.toContain('apiKey');
    expect(entry).not.toHaveProperty('baseUrl');
    expect(entry).not.toHaveProperty('apiKey');
  });

  it('hosted 条目如实标 hosted，且 JSON 里没有上游地址', () => {
    const entry = toCatalogEntry({
      ...P0_MODELS[0]!,
      credentialSource: 'hosted',
      baseUrl: 'https://internal-secret.example/v1',
    });
    expect(entry.credentialSource).toBe('hosted');
    const json = JSON.stringify(entry);
    expect(json).not.toContain('https://internal-secret.example');
    expect(json).not.toContain('apiKey');
    expect(entry).not.toHaveProperty('baseUrl');
  });

  it('自定义模型进目录时也不带 baseUrl 或密钥', () => {
    const model = toRegistryEntry({
      id: 'evowork/my-llama',
      displayName: 'My Llama',
      upstreamModel: 'llama-3',
      adapter: 'openai-chat',
      baseUrl: 'https://llm.example/v1',
    });
    const entry = toCatalogEntry(model);
    expect(entry.credentialSource).toBe('byok');
    const json = JSON.stringify(entry);
    expect(json).not.toContain('https://llm.example');
    expect(json).not.toContain('apiKey');
  });
});
