/**
 * 下拉里选中哪一个（`renderer/model-selection.ts`）。
 *
 * 全部四条都指向同一件事：**换模型这件事永远不许悄悄发生**。
 * 用户以为在用 A、实际在用 B，账单与产物质量都不一样（U1 未关闭）。
 */
import { describe, expect, it } from 'vitest';

import { resolveModelChoice } from '../src/renderer/model-selection.js';
import type { ModelOptionView } from '../src/shared/ipc.js';

function model(id: string, label = id): ModelOptionView {
  return { id, label, provider: id.split('/')[0] ?? 'x', capabilities: [], notices: [] };
}

const MODELS = [
  model('evowork/deepseek-v4-flash', 'deepseek/deepseek-v4-flash'),
  model('evowork/kimi-k3', 'moonshot/kimi-k3'),
];

describe('选中项：用户已选 > 场景默认 > 第一个可用', () => {
  it('用户显式选过就一直用他选的 —— 切场景也不改回去（03 §2.5）', () => {
    expect(resolveModelChoice(MODELS, 'evowork/kimi-k3', 'evowork/deepseek-v4-flash').modelId).toBe(
      'evowork/kimi-k3',
    );
  });

  it('用户没选过时用场景默认值', () => {
    expect(resolveModelChoice(MODELS, undefined, 'evowork/kimi-k3').modelId).toBe(
      'evowork/kimi-k3',
    );
  });

  it('场景也没给默认值时用第一个可用的', () => {
    expect(resolveModelChoice(MODELS, undefined, undefined).modelId).toBe(
      'evowork/deepseek-v4-flash',
    );
  });

  /**
   * **这一条是这个文件存在的理由。**
   *
   * 场景默认值写在随包的 `config/scenarios/*.toml` 里，而"哪些模型可用"取决于
   * 网关配了哪几家的密钥 —— 两者必然会对不上（例如只配了 Kimi 的密钥）。
   * 此时换一个是对的，**但必须说出来**：静默换模型正是 03 §8 与 D2 禁止的那件事。
   */
  it('场景默认的模型不在可用列表里 → 换一个**并且给出一句话**', () => {
    const choice = resolveModelChoice(MODELS, undefined, 'evowork/不存在的模型');
    expect(choice.modelId).toBe('evowork/deepseek-v4-flash');
    expect(choice.notice).toContain('不存在的模型');
    expect(choice.notice).toContain('deepseek/deepseek-v4-flash');
  });

  it('用户选的那个也可能消失（网关重启后少了一家密钥）—— 同样要换并说明', () => {
    const choice = resolveModelChoice(MODELS, 'evowork/glm-flash', 'evowork/glm-flash');
    expect(choice.modelId).toBe('evowork/deepseek-v4-flash');
    expect(choice.notice).toBeTruthy();
  });

  it('一个模型都没有时不挑 —— 挑一个不存在的 id 只会让失败晚一步发生', () => {
    expect(resolveModelChoice([], 'evowork/kimi-k3', 'evowork/kimi-k3')).toEqual({});
  });
});
