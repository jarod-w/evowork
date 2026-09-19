/**
 * 下拉里选中哪一个（`renderer/model-selection.ts`）。
 *
 * 盯两件事：用户自己选过的模型不许悄悄换掉；场景包里的型号不在目录里时，
 * 第一个可用的模型就是这台机器上的默认（Q30），不要再弹「场景默认不可用」。
 */
import { describe, expect, it } from 'vitest';

import { resolveModelChoice } from '../src/renderer/model-selection.js';
import type { ModelOptionView } from '../src/shared/ipc.js';

function model(id: string, label = id): ModelOptionView {
  return {
    id,
    label,
    provider: id.split('/')[0] ?? 'x',
    capabilities: [],
    notices: [],
    credentialSource: 'byok',
    verified: true,
  };
}

const MODELS = [
  model('evowork/deepseek-v4-flash', 'deepseek/deepseek-v4-flash'),
  model('evowork/kimi-k3', 'moonshot/kimi-k3'),
];

describe('选中项：用户已选 > 场景偏好（目录里有才算）> 第一个可用', () => {
  it('用户显式选过就一直用他选的 —— 切场景也不改回去（03 §2.5）', () => {
    expect(resolveModelChoice(MODELS, 'evowork/kimi-k3', 'evowork/deepseek-v4-flash').modelId).toBe(
      'evowork/kimi-k3',
    );
  });

  it('用户没选过时用场景偏好（目录里有才算）', () => {
    expect(resolveModelChoice(MODELS, undefined, 'evowork/kimi-k3').modelId).toBe(
      'evowork/kimi-k3',
    );
  });

  it('场景也没给偏好时用第一个可用的', () => {
    expect(resolveModelChoice(MODELS, undefined, undefined).modelId).toBe(
      'evowork/deepseek-v4-flash',
    );
  });

  /**
   * Q30 未登录只能用自定义模型。场景包里写着 `evowork/deepseek-v4-flash`，
   * 那是托管偏好，不是这台机器上用户配过的东西。目录里没有它时，第一个
   * 配置的模型**就是**默认 —— 再弹「场景默认不可用」是在陈述一件用户从未配置过的事。
   */
  it('场景偏好不在可用列表里 → 用第一个配置的模型，不弹「场景默认不可用」', () => {
    const choice = resolveModelChoice(MODELS, undefined, 'evowork/不存在的模型');
    expect(choice.modelId).toBe('evowork/deepseek-v4-flash');
    expect(choice.notice).toBeUndefined();
  });

  it('用户选的那个消失了（网关重启后少了一家密钥）—— 换一个并且说出来', () => {
    const choice = resolveModelChoice(MODELS, 'evowork/glm-flash', 'evowork/glm-flash');
    expect(choice.modelId).toBe('evowork/deepseek-v4-flash');
    expect(choice.notice).toContain('evowork/glm-flash');
    expect(choice.notice).toContain('deepseek/deepseek-v4-flash');
  });

  it('一个模型都没有时不挑 —— 挑一个不存在的 id 只会让失败晚一步发生', () => {
    expect(resolveModelChoice([], 'evowork/kimi-k3', 'evowork/kimi-k3')).toEqual({});
  });
});
