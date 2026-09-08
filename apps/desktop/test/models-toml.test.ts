/**
 * 自定义模型 toml（11 §4.1 第 ③ 层）。
 *
 * 缺 adapter 的条目直接丢掉 —— 让它出现在下拉里再报「流式输出是乱的」更糟。
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ADAPTER_REQUIRED,
  parseModelsToml,
  readModelsToml,
  validateCustomModel,
  writeModelsToml,
} from '../src/main/models-toml.js';

describe('validateCustomModel', () => {
  it('缺协议适配类型就拒绝，不让网关去猜', () => {
    const result = validateCustomModel({
      id: 'evowork/my-llama',
      upstreamModel: 'llama-3',
      baseUrl: 'https://llm.example/v1',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refused).toBe(ADAPTER_REQUIRED);
  });

  it('不认识的 adapter 也不收', () => {
    const result = validateCustomModel({
      id: 'evowork/my-llama',
      adapter: 'whatever',
      upstreamModel: 'llama-3',
      baseUrl: 'https://llm.example/v1',
    });
    expect(result.ok).toBe(false);
  });

  it('四项齐了才收', () => {
    const result = validateCustomModel({
      id: 'evowork/my-llama',
      displayName: 'My Llama',
      adapter: 'openai-chat',
      upstreamModel: 'llama-3',
      baseUrl: 'https://llm.example/v1',
    });
    expect(result).toEqual({
      ok: true,
      model: {
        id: 'evowork/my-llama',
        displayName: 'My Llama',
        adapter: 'openai-chat',
        upstreamModel: 'llama-3',
        baseUrl: 'https://llm.example/v1',
      },
    });
  });
});

describe('parseModelsToml', () => {
  it('缺 adapter 的块被丢掉，齐的留下', () => {
    const models = parseModelsToml(`
[[model]]
id = "evowork/broken"
upstream_model = "x"
base_url = "https://x.example/v1"

[[model]]
id = "evowork/ok"
display_name = "Mine"
upstream_model = "llama-3"
adapter = "openai-chat"
base_url = "https://llm.example/v1"
`);
    expect(models).toEqual([
      {
        id: 'evowork/ok',
        displayName: 'Mine',
        upstreamModel: 'llama-3',
        adapter: 'openai-chat',
        baseUrl: 'https://llm.example/v1',
      },
    ]);
  });
});

describe('读写往返', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ew-models-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('写出去的能原样读回来，且文件里没有密钥字段', () => {
    const path = join(dir, 'models.toml');
    writeModelsToml(path, [
      {
        id: 'evowork/ok',
        displayName: 'Mine',
        upstreamModel: 'llama-3',
        adapter: 'openai-chat',
        baseUrl: 'https://llm.example/v1',
      },
    ]);
    expect(readModelsToml(path)).toHaveLength(1);
    const text = readFileSync(path, 'utf8');
    expect(text).not.toMatch(/api[_-]?key/i);
    expect(text).toContain('adapter = "openai-chat"');
  });
});
