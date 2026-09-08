/**
 * 模型注册表的四层合并（11 §4.1 / 验收口径第 6 条）。
 *
 * 这组断言守的是**合并顺序**与**"停用不等于消失"**这两件事。它们做错的后果各不相同：
 *   · 顺序反了 → 用户在 `models.toml` 里加一条就绕过企业策略，R11 的缓解手段作废；
 *   · 停用变成隐藏 → 模型静默消失，用户去问客服"我明明配了密钥为什么没有"。
 */
import { describe, expect, it } from 'vitest';

import type { ModelRegistryEntry } from '../src/capabilities.js';
import {
  CUSTOM_MODELS_LOCKED,
  DENIED_BY_POLICY,
  mergeModelLayers,
  type ModelLayers,
} from '../src/layers.js';

function entry(
  id: string,
  provider: ModelRegistryEntry['provider'] = 'deepseek',
): ModelRegistryEntry {
  return {
    id,
    provider,
    upstreamModel: id.split('/')[1] ?? id,
    displayName: id,
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
  };
}

function merge(over: Partial<ModelLayers> = {}) {
  return mergeModelLayers({
    builtin: [entry('evowork/deepseek-v4-flash'), entry('evowork/kimi-k3', 'moonshot')],
    builtinHasKey: () => true,
    ...over,
  });
}

describe('第①层：内置元数据不自带凭据', () => {
  it('没配那家密钥的内置条目**不进结果** —— 它是元数据，不是一个能选的模型', () => {
    const merged = merge({ builtinHasKey: (provider) => provider === 'deepseek' });
    expect(merged.map((m) => m.id)).toEqual(['evowork/deepseek-v4-flash']);
  });

  it('进了结果的内置条目标 byok —— 用的是用户自己的密钥', () => {
    expect(merge()[0]?.credentialSource).toBe('byok');
    expect(merge()[0]?.layer).toBe('builtin');
  });

  it('一家密钥都没有时结果为空（网关据此拒绝启动，而不是起一个必然失败的进程）', () => {
    expect(merge({ builtinHasKey: () => false })).toEqual([]);
  });
});

describe("合并顺序：② > ②' > ③ > ①", () => {
  it('③ 本机自定义覆盖 ① 同 id 的内置条目，**位置不变**', () => {
    const merged = merge({
      custom: [{ ...entry('evowork/deepseek-v4-flash', 'private'), displayName: '我改的' }],
    });
    // 位置：下拉的顺序不该因为一次覆盖而跳动
    expect(merged.map((m) => m.id)).toEqual(['evowork/deepseek-v4-flash', 'evowork/kimi-k3']);
    expect(merged[0]?.displayName).toBe('我改的');
    expect(merged[0]?.layer).toBe('custom');
    // private 适配的自定义条目是"私有 endpoint"，不是我们托管的
    expect(merged[0]?.credentialSource).toBe('private');
  });

  it("②' 租户默认模型压 ③ —— 同 id 冲突时租户口径优先，且它是 hosted", () => {
    const merged = merge({
      custom: [{ ...entry('evowork/shared'), displayName: '用户自己加的' }],
      tenant: [{ ...entry('evowork/shared'), displayName: '管理员配的' }],
    });
    const shared = merged.find((m) => m.id === 'evowork/shared');
    expect(shared?.displayName).toBe('管理员配的');
    expect(shared?.credentialSource).toBe('hosted');
  });

  it('② 企业覆盖压所有 —— 反过来的话用户加一条自定义模型就绕过了策略包', () => {
    const merged = merge({
      custom: [entry('evowork/private-llm', 'private')],
      tenant: [entry('evowork/private-llm')],
      policy: { disabledModelIds: ['evowork/private-llm'] },
    });
    expect(merged.find((m) => m.id === 'evowork/private-llm')?.denied).toBe(DENIED_BY_POLICY);
  });
});

describe('停用不是隐藏（同 10 §2.2「未知 profile 显示 id 本身」）', () => {
  it('被停用的模型**仍在列表里**，只是带上一句能直接显示的原因', () => {
    const merged = merge({ policy: { disabledModelIds: ['evowork/kimi-k3'] } });
    expect(merged.map((m) => m.id)).toContain('evowork/kimi-k3');
    expect(merged.find((m) => m.id === 'evowork/kimi-k3')?.denied).toContain('停用');
  });

  it('企业自定义的停用文案原样透出（"为什么"由发策略的人说）', () => {
    const merged = merge({
      policy: { disabledModelIds: ['evowork/kimi-k3'], reason: '合规部门未批准这家厂商。' },
    });
    expect(merged.find((m) => m.id === 'evowork/kimi-k3')?.denied).toBe('合规部门未批准这家厂商。');
  });

  it('锁了 allowCustomModels 时，自定义条目**留着但被停用** —— 不静默消失', () => {
    const merged = merge({
      custom: [entry('evowork/my-llm', 'private')],
      policy: { allowCustomModels: false },
    });
    const mine = merged.find((m) => m.id === 'evowork/my-llm');
    expect(mine).toBeDefined();
    expect(mine?.denied).toBe(CUSTOM_MODELS_LOCKED);
  });

  it('没有策略包时默认**不锁** —— 一台个人机器必须能用 BYOK（Q30=A）', () => {
    const merged = merge({ custom: [entry('evowork/my-llm', 'private')] });
    expect(merged.find((m) => m.id === 'evowork/my-llm')?.denied).toBeUndefined();
  });
});
