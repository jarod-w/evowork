import { describe, expect, it } from 'vitest';

import { customModelKeyEnv, parseCustomModelsJson } from '../src/custom-models.js';

describe('自定义模型环境注入', () => {
  it('id 里的斜线变成下划线，两边用同一个函数就不会对不上', () => {
    expect(customModelKeyEnv('evowork/my-llama')).toBe('EVOWORK_MODEL_KEY_evowork_my_llama');
  });

  it('JSON 里即使有人塞了 apiKey 也丢掉', () => {
    const parsed = parseCustomModelsJson(
      JSON.stringify([
        {
          id: 'evowork/my-llama',
          displayName: 'My Llama',
          upstreamModel: 'llama-3',
          adapter: 'openai-chat',
          baseUrl: 'https://llm.example/v1',
          apiKey: 'sk-should-never-land',
        },
      ]),
    );
    expect(parsed).toHaveLength(1);
    expect(JSON.stringify(parsed)).not.toContain('sk-should-never-land');
    expect(parsed[0]).not.toHaveProperty('apiKey');
  });

  it('坏 JSON 当成没有，不让网关起不来', () => {
    expect(parseCustomModelsJson('{')).toEqual([]);
    expect(parseCustomModelsJson(undefined)).toEqual([]);
  });
});
