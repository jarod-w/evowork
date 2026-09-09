/**
 * 第 ②' 层的线上形状（11 §12 第 13 条）：本机进程环境里的目录
 * **不能带 apiKey，也不能带上游 baseUrl**。
 */
import { describe, expect, it } from 'vitest';

import { encodeTenantModels, parseTenantModels } from '../src/tenant-models.js';

describe('租户目录：带密钥或上游地址的条目丢掉', () => {
  it('干净的条目能解析，类型里本来就没有 key', () => {
    const { specs, dropped } = parseTenantModels(
      JSON.stringify([
        {
          id: 'evowork/hosted-flash',
          displayName: '托管',
          provider: 'deepseek',
          upstreamModel: 'deepseek-v4-flash',
        },
      ]),
    );
    expect(dropped).toBe(0);
    expect(specs).toHaveLength(1);
    expect(specs[0]).not.toHaveProperty('apiKey');
    expect(specs[0]).not.toHaveProperty('baseUrl');
  });

  it('出现 apiKey 或 baseUrl 就丢那一条 —— 那是服务端内部形状漏到了本机', () => {
    const leaked = parseTenantModels(
      JSON.stringify([
        {
          id: 'evowork/leak-key',
          displayName: '漏',
          provider: 'deepseek',
          upstreamModel: 'x',
          apiKey: 'sk-should-never-land',
        },
        {
          id: 'evowork/leak-url',
          displayName: '漏',
          provider: 'deepseek',
          upstreamModel: 'x',
          baseUrl: 'https://api.deepseek.com',
        },
      ]),
    );
    expect(leaked.specs).toEqual([]);
    expect(leaked.dropped).toBe(2);
  });

  it('编码结果里同样没有那两项', () => {
    const encoded = encodeTenantModels([
      {
        id: 'evowork/hosted-flash',
        provider: 'deepseek',
        upstreamModel: 'deepseek-v4-flash',
        displayName: '托管',
        tier: 'standard',
        verified: false,
        unverified: [],
        notes: '',
        capabilities: {
          streaming: true,
          toolCalls: true,
          parallelToolCalls: false,
          reasoning: false,
          promptCache: false,
          imageInput: false,
          maxContextTokens: 8_000,
        },
      },
    ]);
    expect(encoded).not.toContain('apiKey');
    expect(encoded).not.toContain('baseUrl');
    expect(encoded).not.toContain('sk-');
  });
});
