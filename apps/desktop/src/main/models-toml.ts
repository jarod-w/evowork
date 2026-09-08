/**
 * `~/.evowork/models.toml` —— 本机自定义模型（11 §4.1 第 ③ 层）。
 *
 * 只能追加私有 endpoint。密钥不进这个文件，进 `secrets.bin`（`secret-store.ts`）。
 * **协议适配类型必填**：`base_url + key` 不足以决定怎么跟对面说话（D2 的语义矩阵）。
 * 缺它时网关只能猜，猜错的表现是「配好了但流式输出是乱的」。
 */
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';

import { customModelKeyEnv } from '@evowork/gateway';

export const PROTOCOL_ADAPTERS = ['openai-chat', 'deepseek', 'moonshot', 'zhipu'] as const;
export type ProtocolAdapter = (typeof PROTOCOL_ADAPTERS)[number];

export interface CustomModelSpec {
  readonly id: string;
  readonly displayName: string;
  readonly upstreamModel: string;
  readonly adapter: ProtocolAdapter;
  readonly baseUrl: string;
}

export const ADAPTER_REQUIRED =
  '必须选择协议适配类型。只填地址和密钥的话，网关不知道对面说的是哪家的协议。';

const ADAPTER_SET = new Set<string>(PROTOCOL_ADAPTERS);

function unquote(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

export function isProtocolAdapter(value: string): value is ProtocolAdapter {
  return ADAPTER_SET.has(value);
}

export function looksLikeUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * 自定义模型 id。允许 `evowork/` 前缀或裸 slug。空白、路径穿越都不行 ——
 * 这个 id 会进环境变量名与下拉，脏了两边一起脏。
 */
export function isCustomModelId(id: string): boolean {
  return /^[A-Za-z][A-Za-z0-9._/-]{0,63}$/.test(id) && !id.includes('..');
}

export function validateCustomModel(raw: {
  readonly id?: string | undefined;
  readonly displayName?: string | undefined;
  readonly upstreamModel?: string | undefined;
  readonly adapter?: string | undefined;
  readonly baseUrl?: string | undefined;
}):
  | { readonly ok: true; readonly model: CustomModelSpec }
  | { readonly ok: false; readonly refused: string } {
  const id = raw.id?.trim() ?? '';
  const adapter = raw.adapter?.trim() ?? '';
  const baseUrl = raw.baseUrl?.trim() ?? '';
  const upstreamModel = raw.upstreamModel?.trim() ?? '';
  if (!id) return { ok: false, refused: '模型 id 不能空。' };
  if (!isCustomModelId(id))
    return { ok: false, refused: '模型 id 只能用字母、数字、点、下划线、斜线。' };
  if (!adapter) return { ok: false, refused: ADAPTER_REQUIRED };
  if (!isProtocolAdapter(adapter)) {
    return { ok: false, refused: `不认识的协议适配类型「${adapter}」。` };
  }
  if (!baseUrl) return { ok: false, refused: '自定义模型必须填写 endpoint 地址。' };
  if (!looksLikeUrl(baseUrl)) return { ok: false, refused: 'endpoint 不是一个 http(s) 地址。' };
  if (!upstreamModel) return { ok: false, refused: '上游模型名不能空。' };
  return {
    ok: true,
    model: {
      id,
      displayName: raw.displayName?.trim() || id,
      upstreamModel,
      adapter,
      baseUrl,
    },
  };
}

export function parseModelsToml(text: string): CustomModelSpec[] {
  const models: CustomModelSpec[] = [];
  let current:
    | {
        id?: string;
        displayName?: string;
        upstreamModel?: string;
        adapter?: string;
        baseUrl?: string;
      }
    | undefined;

  const flush = (): void => {
    if (!current) return;
    const parsed = validateCustomModel(current);
    if (parsed.ok) models.push(parsed.model);
    current = undefined;
  };

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    if (line === '[[model]]') {
      flush();
      current = {};
      continue;
    }
    if (!current) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    const value = unquote(line.slice(eq + 1).trim());
    if (key === 'id') current.id = value;
    else if (key === 'display_name') current.displayName = value;
    else if (key === 'upstream_model') current.upstreamModel = value;
    else if (key === 'adapter') current.adapter = value;
    else if (key === 'base_url') current.baseUrl = value;
  }
  flush();
  return models;
}

export function readModelsToml(path: string): CustomModelSpec[] {
  if (!existsSync(path)) return [];
  try {
    return parseModelsToml(readFileSync(path, 'utf8'));
  } catch {
    return [];
  }
}

export function serializeModelsToml(models: readonly CustomModelSpec[]): string {
  const lines = [
    '# EvoWork 本机自定义模型。密钥不在这里，在系统密钥库里。',
    '# 每一条都必须有 adapter（协议适配类型）。',
  ];
  for (const model of models) {
    lines.push(
      '',
      '[[model]]',
      `id = "${model.id}"`,
      `display_name = "${model.displayName}"`,
      `upstream_model = "${model.upstreamModel}"`,
      `adapter = "${model.adapter}"`,
      `base_url = "${model.baseUrl}"`,
    );
  }
  lines.push('');
  return lines.join('\n');
}

export function writeModelsToml(path: string, models: readonly CustomModelSpec[]): void {
  writeFileSync(path, serializeModelsToml(models), { encoding: 'utf8', mode: 0o600 });
  chmodSync(path, 0o600);
}

/** 自定义模型密钥进进程环境时的键名。与网关的 `customModelKeyEnv` 同一口径。 */
export const customKeyEnvName = customModelKeyEnv;

export function customKeySlot(id: string): string {
  return `custom:${id}`;
}
