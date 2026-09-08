/**
 * 第③层的线上形状（11 §4.1）—— 宿主与网关共用的那个契约。
 *
 * 两条最要紧的断言：
 *   · **协议适配类型必选**：猜不出来，而猜错的表现是"回复是空的"；
 *   · **坏的企业策略按"锁"处理**：一个 JSON 语法错误不该让企业的禁令失效。
 */
import { describe, expect, it } from 'vitest';

import {
  CUSTOM_KEY_ENV_PREFIX,
  customModelConfig,
  encodeCustomModels,
  parseCustomModels,
  parseModelPolicy,
  toRegistryEntry,
  validateCustomModel,
  type CustomModelSpec,
} from '../src/custom-models.js';

const SPEC: CustomModelSpec = {
  id: 'my/llm',
  displayName: '我的模型',
  provider: 'private',
  upstreamModel: 'qwen3-max',
  baseUrl: 'https://example.com/v1',
  keyEnv: `${CUSTOM_KEY_ENV_PREFIX}1`,
  capabilities: {
    streaming: true,
    toolCalls: true,
    parallelToolCalls: false,
    reasoning: false,
    promptCache: false,
    imageInput: false,
    maxContextTokens: 32_000,
  },
};

describe('校验：拒绝的理由是一句能直接显示给用户的话', () => {
  it('不选协议适配类型就存不了 —— endpoint 说哪种方言猜不出来', () => {
    const refusal = validateCustomModel({ ...SPEC, provider: '' });
    expect(refusal).toContain('协议适配类型');
  });

  it('不认识的协议适配类型会把可选项列出来（不是一句"参数错误"）', () => {
    expect(validateCustomModel({ ...SPEC, provider: 'anthropic' })).toContain('deepseek');
  });

  it('id 的形状与日志字段一致 —— 它会作为 `model` 进日志，装不下自然语言', () => {
    expect(validateCustomModel({ ...SPEC, id: '我的模型' })).toContain('id 只能用');
    expect(validateCustomModel(SPEC)).toBeUndefined();
  });

  it('endpoint 必须是 http(s)，且给的是"填错了什么"而不是抛错', () => {
    expect(validateCustomModel({ ...SPEC, baseUrl: 'ftp://x/y' })).toContain('http');
    expect(validateCustomModel({ ...SPEC, baseUrl: '不是 URL' })).toContain('合法的 URL');
  });
});

describe('线上形状：密钥不在那个 JSON 里', () => {
  it('编码结果里只有变量名，没有密钥值', () => {
    const encoded = encodeCustomModels([SPEC]);
    expect(encoded).toContain(`${CUSTOM_KEY_ENV_PREFIX}1`);
    expect(encoded).not.toContain('sk-');
  });

  it('一条读不懂就丢那一条，其余照用，而且**报出丢了几条**', () => {
    const raw = JSON.stringify([SPEC, { id: 'broken' }]);
    const parsed = parseCustomModels(raw);
    expect(parsed.specs.map((s) => s.id)).toEqual(['my/llm']);
    expect(parsed.dropped).toBe(1);
  });

  it('整个 JSON 坏掉时也不抛错（网关不该因为一条自定义模型起不来）', () => {
    expect(parseCustomModels('{{{').specs).toEqual([]);
    expect(parseCustomModels('{{{').dropped).toBe(1);
  });

  it('自定义模型的能力位**一律标未实测** —— 那是用户的声明，不是我们的结论', () => {
    const registry = toRegistryEntry(SPEC);
    expect(registry.verified).toBe(false);
    expect(registry.unverified).toContain('reasoning');
    expect(registry.notes).toContain('没有经过实测');
  });

  it('上游配置的密钥来自它自己的那个变量（两条 private 模型不会共用一把 key）', () => {
    const config = customModelConfig(SPEC, { [`${CUSTOM_KEY_ENV_PREFIX}1`]: 'sk-a' }, 1_000);
    expect(config.apiKey).toBe('sk-a');
    expect(config.baseUrl).toBe('https://example.com/v1');
  });
});

describe('第②层：坏的策略包按"更严"的方向处理', () => {
  it('没有策略 = 不锁（个人机器必须能用 BYOK）', () => {
    expect(parseModelPolicy(undefined).allowCustomModels).toBe(true);
    expect(parseModelPolicy('').disabledModelIds).toEqual([]);
  });

  it('读得懂的策略照它说的办', () => {
    const policy = parseModelPolicy(
      JSON.stringify({ disabledModelIds: ['a', 1, 'b'], allowCustomModels: false, reason: '合规' }),
    );
    // 非字符串的项被丢掉，而不是让整份策略作废
    expect(policy.disabledModelIds).toEqual(['a', 'b']);
    expect(policy.allowCustomModels).toBe(false);
    expect(policy.reason).toBe('合规');
  });

  /*
   * **方向与自定义模型相反**，这不是不一致：一条坏的自定义模型丢掉，用户少一个模型；
   * 一份读不懂的企业策略若按"不锁"处理，企业的禁令就被一个 JSON 语法错误绕过了。
   */
  it('读不懂的策略 → 锁住自定义模型，并标 malformed 让调用方报出来', () => {
    const policy = parseModelPolicy('{ 坏 }');
    expect(policy.allowCustomModels).toBe(false);
    expect(policy.malformed).toBe(true);
  });
});
