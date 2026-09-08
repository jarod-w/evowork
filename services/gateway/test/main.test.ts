import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  availableModelRegistry,
  availableModels,
  buildConfigResolver,
  staticTokenAuth,
} from '../src/main.js';
import { P0_MODELS } from '../src/capabilities.js';

const SAVED = { ...process.env };

beforeEach(() => {
  for (const key of Object.keys(process.env)) {
    if (
      key.endsWith('_API_KEY') ||
      key.endsWith('_BASE_URL') ||
      key.startsWith('EVOWORK_MODEL_KEY_') ||
      key === 'EVOWORK_CUSTOM_MODELS'
    ) {
      delete process.env[key];
    }
  }
});

afterEach(() => {
  process.env = { ...SAVED };
});

describe('配置解析（全部来自环境变量，不落盘）', () => {
  it('**只注册密钥齐了的厂商** —— 让不可用的模型出现在下拉里再报错更糟', () => {
    expect(availableModels()).toHaveLength(0);

    process.env.DEEPSEEK_API_KEY = 'sk-deepseek';
    const models = availableModels();
    expect(models.every((m) => m.provider === 'deepseek')).toBe(true);
    expect(models.length).toBeGreaterThan(0);
    expect(models.length).toBeLessThan(P0_MODELS.length);
  });

  /**
   * 2026-09-06 接模型下拉时实测到的缺陷的回归测试。
   *
   * 过滤是对的、组合也各自是对的，**合起来是错的**：`createModelRegistry(extra)` 的实现是
   * `[...P0_MODELS, ...extra]`，于是把过滤过的子集当 `extra` 传进去 =
   * 没配密钥的厂商被原样加回来 + 每条重复一次。
   *
   * 后果不是"下拉里多几行"：用户会选中一个**没有密钥**的模型，发出去，
   * 拿到一个上游 401。而"只列真的能用的"正是桌面 App 的下拉信任这个端点的理由（F24）。
   */
  it('端点列出的就是密钥齐了的那些 —— **没配密钥的不许出现，也不许重复**', () => {
    process.env.DEEPSEEK_API_KEY = 'sk-deepseek';
    const listed = availableModelRegistry().list();

    expect(listed.every((m) => m.provider === 'deepseek')).toBe(true);
    expect(listed.some((m) => m.provider === 'moonshot')).toBe(false);
    expect(listed.some((m) => m.provider === 'zhipu')).toBe(false);
    expect(new Set(listed.map((m) => m.id)).size).toBe(listed.length);
    expect(listed).toHaveLength(availableModels().length);
  });

  it('三家密钥都配上时三家都在，且仍然不重复', () => {
    process.env.DEEPSEEK_API_KEY = 'sk-a';
    process.env.MOONSHOT_API_KEY = 'sk-b';
    process.env.ZHIPU_API_KEY = 'sk-c';
    const listed = availableModelRegistry().list();

    expect(new Set(listed.map((m) => m.provider))).toEqual(
      new Set(['deepseek', 'moonshot', 'zhipu']),
    );
    expect(new Set(listed.map((m) => m.id)).size).toBe(listed.length);
    // 用户点名要的三个都在（需求：deepseek-v4-flash · kimi-k3 · glm-5.3-flash）
    expect(listed.map((m) => m.upstreamModel)).toEqual(
      expect.arrayContaining(['deepseek-v4-flash', 'kimi-k3', 'glm-5.3-flash']),
    );
  });

  it('base url 可被环境变量覆盖（企业私有部署，Q14）', () => {
    process.env.DEEPSEEK_API_KEY = 'sk-x';
    process.env.DEEPSEEK_BASE_URL = 'https://internal.corp/v1';
    const resolve = buildConfigResolver();
    const model = P0_MODELS.find((m) => m.provider === 'deepseek')!;
    expect(resolve(model).baseUrl).toBe('https://internal.corp/v1');
  });

  it('未覆盖时用默认 base url', () => {
    process.env.MOONSHOT_API_KEY = 'sk-y';
    const resolve = buildConfigResolver();
    const model = P0_MODELS.find((m) => m.provider === 'moonshot')!;
    expect(resolve(model).baseUrl).toContain('moonshot');
  });

  it('私有 endpoint 支持自定义鉴权头（Q29：保留配置项，成本≈0）', () => {
    process.env.PRIVATE_MODEL_API_KEY = 'k';
    process.env.PRIVATE_MODEL_AUTH_HEADER = 'ApiKey abc';
    const resolve = buildConfigResolver();
    const config = resolve({
      ...P0_MODELS[0]!,
      provider: 'private',
    });
    expect(config.extraHeaders?.authorization).toBe('ApiKey abc');
  });

  it('只有自定义模型密钥时也能进表，且目录 JSON 不含密钥', () => {
    process.env.EVOWORK_CUSTOM_MODELS = JSON.stringify([
      {
        id: 'evowork/my-llama',
        displayName: 'My Llama',
        upstreamModel: 'llama-3',
        adapter: 'openai-chat',
        baseUrl: 'https://llm.example/v1',
      },
    ]);
    process.env.EVOWORK_MODEL_KEY_evowork_my_llama = 'sk-custom-secret';
    const listed = availableModels();
    expect(listed.map((m) => m.id)).toContain('evowork/my-llama');
    expect(listed.find((m) => m.id === 'evowork/my-llama')?.credentialSource).toBe('byok');
    expect(JSON.stringify(listed.map((m) => ({ ...m, baseUrl: undefined })))).not.toContain(
      'sk-custom-secret',
    );

    const resolve = buildConfigResolver();
    const custom = listed.find((m) => m.id === 'evowork/my-llama')!;
    expect(resolve(custom).apiKey).toBe('sk-custom-secret');
    expect(resolve(custom).baseUrl).toBe('https://llm.example/v1');
  });

  it('自定义模型没配密钥就不出现 —— 让它出现在下拉里再 401 更糟', () => {
    process.env.EVOWORK_CUSTOM_MODELS = JSON.stringify([
      {
        id: 'evowork/my-llama',
        displayName: 'My Llama',
        upstreamModel: 'llama-3',
        adapter: 'openai-chat',
        baseUrl: 'https://llm.example/v1',
      },
    ]);
    expect(availableModels().some((m) => m.id === 'evowork/my-llama')).toBe(false);
  });
});

describe('鉴权', () => {
  it('校验 Bearer token，且长度不同直接拒（不做前缀匹配）', () => {
    const auth = staticTokenAuth(['token-a', 'token-b']);
    expect(auth('Bearer token-a')).toBe(true);
    expect(auth('Bearer token-b')).toBe(true);
    expect(auth('Bearer token-')).toBe(false);
    expect(auth('Bearer token-a-extra')).toBe(false);
    expect(auth('token-a')).toBe(false);
    expect(auth(undefined)).toBe(false);
  });

  it('空 token 列表 = 拒绝一切（不是放行一切）', () => {
    const auth = staticTokenAuth([]);
    expect(auth('Bearer anything')).toBe(false);
    expect(auth(undefined)).toBe(false);
  });
});
