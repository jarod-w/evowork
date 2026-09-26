/**
 * 能力位的唯一真源（`known-models.ts`）。
 *
 * 这个文件存在的原因是 2026-09-26 的一个缺陷：用户在设置页加了
 * `deepseek/deepseek-flash` 与 `moonshot/kimi-k3`，两条在下拉里都把「读图」
 * 画成灰色划除 —— 而 `kimi-k3` 的读图能力是 2026-09-05 我们自己对着真实
 * endpoint 测出来的，结论一直就在这个仓库里。
 *
 * 所以下面每条断言守的都不是"某个值等于某个值"，而是**同一个型号不该因为
 * 从哪一层进来而改变结论**，以及**认不出来时不许乱猜**。
 */
import { describe, expect, it } from 'vitest';

import { P0_MODELS } from '../src/capabilities.js';
import { ALL_CAPABILITY_KEYS, findKnownModel, KNOWN_MODELS } from '../src/known-models.js';

describe('认得出来的型号：结论只有一份', () => {
  it('Kimi K3 与 GLM-5.3-flash 能读图（2026-09-05 实测，32×32 纯红图答"红色"）', () => {
    expect(findKnownModel('moonshot', 'kimi-k3')?.capabilities.imageInput).toBe(true);
    expect(findKnownModel('zhipu', 'glm-5.3-flash')?.capabilities.imageInput).toBe(true);
  });

  it('deepseek-flash 能读图（2026-09-26 实测，32×32 纯红图答"红"）', () => {
    const model = findKnownModel('deepseek', 'deepseek-flash');
    expect(model?.capabilities.imageInput).toBe(true);
    expect(model?.evidence).toBe('probe');
    expect(model?.verifiedAt).toBe('2026-09-26');
  });

  it('**deepseek-v4-flash 仍然不能读图** —— 它收下图、回 200、然后说看不见', () => {
    const model = findKnownModel('deepseek', 'deepseek-v4-flash');
    expect(model?.capabilities.imageInput).toBe(false);
    /*
     * 这条是整张表里最容易被"顺手改对"的一条：名字像、厂商一样、文档说 DeepSeek 支持视觉。
     * 但实测结论是第三种结局（接受但看不见），而那一种**不报错**——
     * 改成 true 的代价是用户发了图、模型说"我没看到"，没有任何地方会提示出了什么事。
     */
    expect(model?.evidence).toBe('probe');
    expect(model?.notes).toContain('无法识别');
  });

  it('视觉实验名是同一个型号的别名，不该被当成陌生型号', () => {
    expect(findKnownModel('deepseek', 'deepseek-v4-flash-vision-exp')?.upstreamModel).toBe(
      'deepseek-flash',
    );
  });

  it('大小写与空格不影响识别（厂商控制台里复制出来的常带这些）', () => {
    expect(findKnownModel('moonshot', '  Kimi-K3 ')?.builtinId).toBe('evowork/kimi-k3');
  });
});

describe('认不出来的一律不猜', () => {
  it('`private` 永远认不出来 —— 同名模型后面可能是任何东西', () => {
    // 自建代理 / 微调版 / 换了权重的同名模型：按名字安上官方能力位 = 替陌生 endpoint 担保
    expect(findKnownModel('private', 'kimi-k3')).toBeUndefined();
  });

  it('没听说过的模型名返回 undefined，而不是一条"看起来合理"的条目', () => {
    expect(findKnownModel('moonshot', 'kimi-k9')).toBeUndefined();
  });
});

describe('P0_MODELS 是派生的', () => {
  it('内置目录 = 表里带 builtinId 的那几条（下架 = 去掉 builtinId，不是删能力知识）', () => {
    const builtin = KNOWN_MODELS.filter((m) => m.builtinId !== undefined).map((m) => m.builtinId);
    expect(P0_MODELS.map((m) => m.id)).toEqual(builtin);
    // 下架的 deepseek-v4-flash 不在目录里，但能力知识还在
    expect(P0_MODELS.map((m) => m.upstreamModel)).not.toContain('deepseek-v4-flash');
    expect(findKnownModel('deepseek', 'deepseek-v4-flash')).toBeDefined();
  });

  it('能力位与表里一字不差 —— 两处"保持一致"靠人记着，派生不用', () => {
    for (const entry of P0_MODELS) {
      const known = findKnownModel(entry.provider, entry.upstreamModel);
      expect(known?.capabilities, entry.id).toEqual(entry.capabilities);
      expect(known?.evidence === 'probe', `${entry.id} 的 verified 跟着 evidence 走`).toBe(
        entry.verified,
      );
    }
  });
});

describe('每一条结论都得说清是怎么来的', () => {
  it('实测的给日期，只读过文档的不许有日期、也不许说自己验过', () => {
    for (const model of KNOWN_MODELS) {
      if (model.evidence === 'probe') {
        expect(model.verifiedAt, `${model.upstreamModel} 实测过就要给日期`).toMatch(
          /^\d{4}-\d{2}-\d{2}$/,
        );
        expect(model.notes).toContain('实测');
      } else {
        expect(model.verifiedAt, `${model.upstreamModel} 没实测就不该有日期`).toBeUndefined();
        expect(model.unverified, `${model.upstreamModel} 一项都没验就该整组列出来`).toEqual(
          ALL_CAPABILITY_KEYS,
        );
      }
    }
  });

  it('`maxContextTokens` 始终在未验证列表里（要塞满上下文才能测，探针不做）', () => {
    for (const model of KNOWN_MODELS) {
      expect(model.unverified, model.upstreamModel).toContain('maxContextTokens');
    }
  });

  it('同一个 (适配类型, 模型名) 只许出现一次，别名也不许撞', () => {
    const seen = new Set<string>();
    for (const model of KNOWN_MODELS) {
      for (const name of [model.upstreamModel, ...(model.aliases ?? [])]) {
        const key = `${model.provider}/${name.toLowerCase()}`;
        expect(seen.has(key), `${key} 出现了两次`).toBe(false);
        seen.add(key);
      }
    }
  });
});
