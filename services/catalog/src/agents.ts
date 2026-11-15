import { join } from 'node:path';

import { parse, stringify, type TomlTable } from 'smol-toml';

import type { DirEntry } from './skills.js';
import type { ExpertRecord } from './types.js';

export interface ExpertRoots {
  readonly official: string;
  readonly user: string;
}

export interface ExpertIo {
  readonly readDir: (path: string) => readonly DirEntry[];
  readonly readText: (path: string) => string | undefined;
}

export function listExperts(roots: ExpertRoots, io: ExpertIo): readonly ExpertRecord[] {
  const official = scan(roots.official, 'official', io);
  const user = scan(roots.user, 'local', io);
  const seen = new Set(official.map((e) => e.id));
  return [...official, ...user.filter((e) => !seen.has(e.id))];
}

function scan(root: string, source: 'official' | 'local', io: ExpertIo): ExpertRecord[] {
  let entries: readonly DirEntry[] = [];
  try {
    entries = io.readDir(root);
  } catch {
    return [];
  }
  const out: ExpertRecord[] = [];
  for (const entry of entries) {
    if (entry.isDirectory || !entry.name.endsWith('.toml')) continue;
    const path = join(root, entry.name);
    const text = io.readText(path);
    if (text === undefined) continue;
    const parsed = parseAgentToml(text, path, source);
    if (parsed !== undefined) out.push(parsed);
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

export function parseAgentToml(
  text: string,
  path: string,
  source: 'official' | 'local',
): ExpertRecord | undefined {
  const config = readAgentToml(text);
  if (!config || typeof config.name !== 'string' || config.name.trim() === '') return undefined;
  const name = config.name;
  const description = typeof config.description === 'string' ? config.description : '';
  const model = typeof config.model === 'string' ? config.model : undefined;
  const details = config.interface as TomlTable | undefined;
  const displayName = typeof details?.display_name === 'string' ? details.display_name : name;
  const category = typeof details?.category === 'string' ? details.category : '未分类';
  const sampleTasks = Array.isArray(details?.sample_tasks)
    ? details.sample_tasks.filter((value): value is string => typeof value === 'string')
    : [];
  const instructions = [
    config.instructions,
    config.developer_instructions,
    details?.instructions,
  ].find((value): value is string => typeof value === 'string' && value.trim() !== '');
  const id = slug(name);
  return {
    id,
    path,
    name: displayName,
    description,
    source,
    installed: true,
    interface: { displayName, category, sampleTasks },
    ...(model !== undefined && model !== '' ? { model } : {}),
    ...(instructions !== undefined && instructions.trim() !== ''
      ? { instructions: instructions.trim() }
      : {}),
  };
}

export function renderAgentToml(input: {
  readonly name: string;
  readonly description: string;
  readonly category: string;
  readonly sampleTasks: readonly string[];
  readonly model?: string | undefined;
  readonly instructions?: string | undefined;
}): string {
  return stringify({
    name: input.name,
    description: input.description,
    ...(input.model ? { model: input.model } : {}),
    ...(input.instructions?.trim() ? { instructions: input.instructions.trim() } : {}),
    interface: {
      display_name: input.name,
      category: input.category,
      sample_tasks: [...input.sampleTasks],
    },
  });
}

export function slug(name: string): string {
  const s = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return s === '' ? 'expert' : s;
}

function readAgentToml(text: string): TomlTable | undefined {
  try {
    return parse(text);
  } catch {
    // 旧版「新建专家」把换行直接写进末尾的双引号字符串。只修复这个历史格式。
    const legacy = /^(\[interface\][^\S\r\n]*\r?\n[\s\S]*?^instructions = )"([\s\S]*)"\s*$/m.exec(
      text,
    );
    if (!legacy || legacy.index === undefined || !legacy[2]?.includes('\n')) return undefined;
    const value = legacy[2].replace(/\\(["\\])/g, '$1').replace(/\r\n/g, '\n');
    try {
      return parse(text.slice(0, legacy.index) + legacy[1] + JSON.stringify(value));
    } catch {
      return undefined;
    }
  }
}
