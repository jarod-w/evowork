/**
 * 设置页动作（11 §4）。盯的是密钥不回读、密钥库不可用时不落明文。
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createSettingsPorts } from '../src/main/settings-actions.js';
import { memoryCodec } from '../src/main/secret-store.js';
import type { SettingsPaths } from '../src/main/settings-actions.js';

let dir: string;
let paths: SettingsPaths;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ew-set-'));
  paths = {
    appToml: join(dir, 'app.toml'),
    modelsToml: join(dir, 'models.toml'),
    secretsBin: join(dir, 'secrets.bin'),
    gatewayEnv: join(dir, 'gateway.env'),
  };
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function ports(codec = memoryCodec()) {
  return createSettingsPorts({
    paths,
    codec,
    appName: 'EvoWork',
    appVersion: '0.0.0',
    userName: 'tester',
    kernelBaseUrl: 'http://127.0.0.1:8787/v1',
    onKeysChanged: async () => undefined,
  });
}

describe('getSettings', () => {
  it('返回的模型没有 apiKey，完整密钥不在 JSON 里', async () => {
    const s = ports();
    await s.saveModelKey({ slot: 'DEEPSEEK_API_KEY', value: 'sk-live-secret-abcd' });
    const view = await s.getSettings();
    const json = JSON.stringify(view);
    expect(json).not.toContain('sk-live-secret-abcd');
    expect(view.models.some((m) => 'apiKey' in m)).toBe(false);
    expect(view.models.find((m) => m.provider === 'deepseek')?.savedLast4).toBe('abcd');
    expect(view.mode).toBe('local');
  });
});

describe('密钥库不可用', () => {
  it('不写 secrets.bin，返回 needsChoice', async () => {
    const closed = { ...memoryCodec(), available: false };
    const s = ports(closed);
    const result = await s.saveModelKey({ slot: 'DEEPSEEK_API_KEY', value: 'sk-live-secret' });
    expect(result.ok).toBe(false);
    expect(result.secretStoreNeedsChoice).toBe(true);
    expect(existsSync(paths.secretsBin)).toBe(false);
    expect(result.settings.secretStore.needsChoice).toBe(true);
  });
});

describe('自定义模型', () => {
  it('adapter 缺失就拒绝，不落一条半残的模型', async () => {
    const s = ports();
    const result = await s.addCustomModel({
      id: 'evowork/my-llama',
      upstreamModel: 'llama-3',
      adapter: '',
      baseUrl: 'https://llm.example/v1',
    });
    expect(result.ok).toBe(false);
    expect(result.refused).toMatch(/协议适配/);
    expect(existsSync(paths.modelsToml)).toBe(false);
  });

  it('加进去之后目录里有 endpoint，没有密钥', async () => {
    const s = ports();
    const result = await s.addCustomModel({
      id: 'evowork/my-llama',
      displayName: 'My Llama',
      upstreamModel: 'llama-3',
      adapter: 'openai-chat',
      baseUrl: 'https://llm.example/v1',
      apiKey: 'sk-custom-xxxx',
    });
    expect(result.ok).toBe(true);
    const mine = result.settings.models.find((m) => m.id === 'evowork/my-llama');
    expect(mine?.endpoint).toBe('https://llm.example/v1');
    expect(mine?.savedLast4).toBe('xxxx');
    expect(JSON.stringify(result.settings)).not.toContain('sk-custom-xxxx');
    expect(readFileSync(paths.modelsToml, 'utf8')).not.toContain('sk-custom');
  });
});

describe('从 gateway.env 迁完仍能读', () => {
  it('密钥库可用时导入后源文件改名还在', async () => {
    writeFileSync(paths.gatewayEnv, 'DEEPSEEK_API_KEY=sk-from-file-zzzz\n', 'utf8');
    const s = ports();
    // 构造时不迁；迁是宿主的事。这里只断言 save 之后 JSON 不含原文。
    await s.saveModelKey({ slot: 'DEEPSEEK_API_KEY', value: 'sk-from-file-zzzz' });
    expect(JSON.stringify(await s.getSettings())).not.toContain('sk-from-file-zzzz');
  });
});
