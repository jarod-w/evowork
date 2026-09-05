import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { availableModels, buildConfigResolver, staticTokenAuth } from '../src/main.js';
import { P0_MODELS } from '../src/capabilities.js';

const SAVED = { ...process.env };

beforeEach(() => {
  for (const key of Object.keys(process.env)) {
    if (key.endsWith('_API_KEY') || key.endsWith('_BASE_URL')) delete process.env[key];
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
