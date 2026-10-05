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
import {
  ALL_CAPABILITY_KEYS,
  builtinModelEntries,
  findKnownModel,
  KNOWN_MODELS,
} from '../src/known-models.js';

describe('认得出来的型号：结论只有一份', () => {
  it('Kimi K3 与 GLM-5.3-flash 能读图（2026-09-05 实测，32×32 纯红图答"红色"）', () => {
    expect(findKnownModel('moonshot', 'kimi-k3')?.capabilities.imageInput).toBe(true);
    expect(findKnownModel('zhipu', 'glm-5.3-flash')?.capabilities.imageInput).toBe(true);
  });

  it('deepseek-flash 能读图（2026-09-26 实测、2026-10-05 新旧两个名字复测，32×32 纯红图答"红"）', () => {
    const model = findKnownModel('deepseek', 'deepseek-flash');
    expect(model?.capabilities.imageInput).toBe(true);
    expect(model?.evidence).toBe('probe');
    expect(model?.verifiedAt).toBe('2026-10-05');
  });

  it('**旧名 deepseek-v4-flash 认作 deepseek-flash** —— 厂商退役了原型号，旧名的请求由 V4.1-Flash 处理', () => {
    /*
     * 2026-09-05 那个型号"收下图、回 200、说看不见"，所以它曾单独一条且不读图。
     * 2026-10-05 厂商文档：旧名仍收，但请求由 DeepSeek-V4.1-Flash（= deepseek-flash）处理。
     * 还按退役前的结论记，后果是 Composer 把一个能读图的模型的图片拦掉（03 §8）。
     * 依据是厂商的路由声明，notes 里要写明，免得下一个人以为这是按名字猜的。
     */
    const legacy = findKnownModel('deepseek', 'deepseek-v4-flash');
    expect(legacy?.upstreamModel).toBe('deepseek-flash');
    expect(legacy?.capabilities.imageInput).toBe(true);
    expect(legacy?.notes).toContain('已退役');
  });

  it('视觉实验名同样是 deepseek-flash 的别名，不该被当成陌生型号', () => {
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
    // 旧名只是别名：认得出来，但不会在目录里多出一条
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

  it('`maxContextTokens` 移出未验证列表，notes 里必须写着实测出的上限', () => {
    /*
     * 探针不测上下文（要塞满才能测）。2026-10-05 起有了第二条路：发一个超长的合成请求，
     * 厂商在 400 里报出上限（DeepSeek 原话 "maximum context length is 1048576 tokens"）。
     * 厂商文档常常只写「1M」，两种读法差 4.8 万 —— 所以没实测过的必须留在未验证列表里，
     * 实测过的要把读出来的数写进 notes，不能只是悄悄把它从列表里删掉。
     */
    for (const model of KNOWN_MODELS) {
      if (model.unverified.includes('maxContextTokens')) continue;
      expect(model.notes, model.upstreamModel).toContain('上下文上限实测为');
      expect(model.notes, model.upstreamModel).toContain(
        model.capabilities.maxContextTokens.toLocaleString('en-US'),
      );
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

describe('内置目录（Q16 的三家 P0）', () => {
  /**
   * **三家 P0 都必须在内置目录里。**
   *
   * 2026-09-27 实测缺陷：两条 DeepSeek 都没有 `builtinId`，而按本文件的约定
   * 那等于"已下架"。后果不是少一个选项 —— 只配 `DEEPSEEK_API_KEY` 时网关会以
   * `gateway.boot.no_models / NO_PROVIDER_KEYS` **拒绝启动**，
   * 用户那一侧是「我配了 DeepSeek，应用说没有可用模型」。
   *
   * 这条钉的是 Q16 的决定本身，不是某个型号：哪天换型号，改的是下面那个 id，
   * 而"三家都得在"这件事不该跟着型号一起消失。
   */
  it('deepseek / moonshot / zhipu 各有一条进了内置目录', () => {
    const byProvider = new Map(builtinModelEntries().map((m) => [m.provider, m.id]));
    expect([...byProvider.keys()].sort()).toEqual(['deepseek', 'moonshot', 'zhipu']);
    expect(byProvider.get('deepseek')).toBe('evowork/deepseek-flash');
  });

  /**
   * 2026-09-06 从目录下架的 `deepseek-v4-flash` **不许**回到目录里；2026-10-05 起它也不再有
   * 自己的能力结论 —— 厂商退役了那个型号，旧名背后就是 `deepseek-flash`，两者必须是同一条，
   * 否则同一个请求会因为用户填的是哪个名字而得到两套能力位。
   */
  it('退役的旧名不回到目录，且与 deepseek-flash 是同一条能力知识', () => {
    expect(builtinModelEntries().some((m) => m.upstreamModel === 'deepseek-v4-flash')).toBe(false);
    expect(findKnownModel('deepseek', 'deepseek-v4-flash')).toBe(
      findKnownModel('deepseek', 'deepseek-flash'),
    );
  });
});
