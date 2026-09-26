/**
 * 给内核的模型目录。
 *
 * 这份 JSON 的特别之处是**做错了会让内核拒绝加载整份配置** —— 表现不是"压缩点不对"，
 * 是所有任务都起不来。所以这里断言的不是"字段都在"，而是**两条后果**：
 *   ① 上下文大小按模型逐条给对（这是做这件事的全部意义）；
 *   ② 除了上下文，**行为与今天的兜底元数据一字不差**（改动面只有一处，出事也只能出在那儿）。
 */
import { describe, expect, it } from 'vitest';

import { buildKernelModelCatalog } from '../src/kernel-catalog.js';
import { P0_MODELS } from '../src/capabilities.js';

/** 产品身份底稿（`config/prompts/base-instructions.md` 的替身）。内核要求每条模型都带 */
const BASE = '你是 EvoWork 的执行智能体。';

describe('给内核的模型目录', () => {
  it('上下文大小逐条给对 —— GLM 的 128k 不能被当成兜底的 272k', () => {
    const catalog = buildKernelModelCatalog(
      [
        { id: 'evowork/glm-flash', displayName: 'GLM', maxContextTokens: 128_000 },
        { id: 'evowork/kimi-k3', displayName: 'Kimi', maxContextTokens: 256_000 },
      ],
      BASE,
    );
    const byId = new Map(catalog?.models.map((m) => [m.slug, m]));
    expect(byId.get('evowork/glm-flash')?.context_window).toBe(128_000);
    expect(byId.get('evowork/glm-flash')?.max_context_window).toBe(128_000);
    expect(byId.get('evowork/kimi-k3')?.context_window).toBe(256_000);
  });

  it('**除了上下文，其余逐字复刻内核的兜底值**（`model_info.rs:99-137`）', () => {
    const [entry] = buildKernelModelCatalog(
      [{ id: 'x/y', displayName: 'Y', maxContextTokens: 100_000 }],
      BASE,
    )!.models;
    expect(entry).toMatchObject({
      shell_type: 'unified_exec',
      visibility: 'none',
      supported_in_api: true,
      priority: 99,
      support_verbosity: false,
      truncation_policy: { mode: 'bytes', limit: 10_000 },
      tool_mode: null,
      multi_agent_version: null,
    });
  });

  it('**看不见图的模型也写 ["text","image"]** —— 收窄它等于让内核把图悄悄摘掉', () => {
    /*
     * 按能力表把它改成 `["text"]` 看起来更准确，后果却是内核在发给网关之前就把图片丢了。
     * 而 D2 / `to-chat.ts` 坑 3 要求的是**显式拒绝并告诉用户**：
     * 用户以为模型看过那张图，模型说"我没看到图片"，两边都不出声。
     */
    const [entry] = buildKernelModelCatalog(
      [{ id: 'blind/model', displayName: '看不见图的', maxContextTokens: 32_000 }],
      BASE,
    )!.models;
    expect(entry?.input_modalities).toEqual(['text', 'image']);
  });

  it('上下文大小不可信的**不进目录** —— 瞎填一个数比回到兜底更糟', () => {
    expect(
      buildKernelModelCatalog([{ id: 'a/b', displayName: 'B', maxContextTokens: 0 }], BASE),
    ).toBeUndefined();
    expect(
      buildKernelModelCatalog(
        [{ id: 'a/b', displayName: 'B', maxContextTokens: Number.NaN }],
        BASE,
      ),
    ).toBeUndefined();
  });

  it('**没有产品身份底稿就不生成** —— 内核会拒绝这份目录，而拿它自带的底稿会漏出 Codex（K5）', () => {
    expect(
      buildKernelModelCatalog([{ id: 'a/b', displayName: 'B', maxContextTokens: 32_000 }], '  '),
    ).toBeUndefined();
  });

  it('底稿逐条带上 —— 内核的自定义反序列化要求每条模型都有（缺了整份目录解析失败）', () => {
    const [entry] = buildKernelModelCatalog(
      [{ id: 'a/b', displayName: 'B', maxContextTokens: 32_000 }],
      BASE,
    )!.models;
    expect(entry?.base_instructions).toBe(BASE);
  });

  it('一条都没有时返回 undefined —— 内核会拒绝空目录，调用方据此不写那个键', () => {
    expect(buildKernelModelCatalog([], BASE)).toBeUndefined();
  });

  it('内置三家都能进目录，且用的是能力表里的真实上下文', () => {
    const catalog = buildKernelModelCatalog(
      P0_MODELS.map((m) => ({
        id: m.id,
        displayName: m.displayName,
        maxContextTokens: m.capabilities.maxContextTokens,
      })),
      BASE,
    );
    expect(catalog?.models.length).toBe(P0_MODELS.length);
    // 没有哪一条还停在兜底的 272k 上
    expect(catalog?.models.every((m) => m.context_window !== 272_000)).toBe(true);
  });
});
