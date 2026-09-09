import { join } from 'node:path';

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
  const name = tomlString(text, 'name');
  if (name === undefined || name.trim() === '') return undefined;
  const description = tomlString(text, 'description') ?? '';
  const model = tomlString(text, 'model');
  const interfaceBlock = section(text, 'interface');
  const displayName = tomlString(interfaceBlock, 'display_name') ?? name;
  const category = tomlString(interfaceBlock, 'category') ?? '未分类';
  const sampleTasks = tomlStringArray(interfaceBlock, 'sample_tasks');
  const instructions = section(text, 'instructions') || tomlString(text, 'instructions');
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
  const lines = [
    `name = ${tomlQuote(input.name)}`,
    `description = ${tomlQuote(input.description)}`,
  ];
  if (input.model !== undefined && input.model !== '') {
    lines.push(`model = ${tomlQuote(input.model)}`);
  }
  lines.push('');
  lines.push('[interface]');
  lines.push(`display_name = ${tomlQuote(input.name)}`);
  lines.push(`category = ${tomlQuote(input.category)}`);
  lines.push(`sample_tasks = [${input.sampleTasks.map(tomlQuote).join(', ')}]`);
  if (input.instructions !== undefined && input.instructions.trim() !== '') {
    lines.push('');
    lines.push(`instructions = ${tomlQuote(input.instructions.trim())}`);
  }
  return `${lines.join('\n')}\n`;
}

export function slug(name: string): string {
  const s = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return s === '' ? 'expert' : s;
}

function section(text: string, name: string): string {
  const re = new RegExp(`\\[${name}\\]\\s*\\n([\\s\\S]*?)(?=\\n\\[|$)`);
  return re.exec(text)?.[1] ?? '';
}

function tomlString(text: string, key: string): string | undefined {
  const re = new RegExp(`^\\s*${key}\\s*=\\s*(.+)$`, 'm');
  const raw = re.exec(text)?.[1]?.trim();
  if (raw === undefined) return undefined;
  if (raw.startsWith('"') && raw.endsWith('"')) return unquote(raw.slice(1, -1));
  if (raw.startsWith("'") && raw.endsWith("'")) return raw.slice(1, -1);
  return raw;
}

function tomlStringArray(text: string, key: string): readonly string[] {
  const re = new RegExp(`^\\s*${key}\\s*=\\s*\\[([\\s\\S]*?)\\]`, 'm');
  const inner = re.exec(text)?.[1];
  if (inner === undefined) return [];
  const out: string[] = [];
  const item = /"((?:\\.|[^"\\])*)"/g;
  let m: RegExpExecArray | null;
  while ((m = item.exec(inner)) !== null) {
    out.push(unquote(m[1] ?? ''));
  }
  return out;
}

function tomlQuote(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function unquote(value: string): string {
  return value.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
}
