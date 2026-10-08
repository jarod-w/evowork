import { join } from 'node:path';
import { JSON_SCHEMA, load } from 'js-yaml';

import { auditSkillFiles, type AuditFile } from './audit.js';
import type { SkillInterface, SkillRecord, SkillSource } from './types.js';

export interface DirEntry {
  readonly name: string;
  readonly isDirectory: boolean;
}

export interface CatalogIo {
  readonly readDir: (path: string) => readonly DirEntry[];
  readonly readText: (path: string) => string | undefined;
  readonly listFiles: (dir: string, maxDepth?: number) => readonly AuditFile[];
}

export interface SkillRoots {
  /** 随包 `plugins/skills` */
  readonly official: string;
  /** `~/.evowork/skills` */
  readonly user: string;
}

const SKIP_DIRS = new Set(['_shared', 'node_modules', '.git', 'test']);

/** 安装时写下的来源，扫描用户根时读它。 */
export const SOURCE_MARKER_FILE = '.evowork-source';
/** Hub 条目被吊销后改写的来源标记（13 §5.4：停用、不删）。 */
export const HUB_REVOKED_MARKER = 'hub-revoked';

export function parseFrontmatter(text: string): { name: string; description: string } {
  const empty = { name: '', description: '' };
  const match = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!match) return empty;
  const block = match[1] ?? '';
  let parsed: unknown;
  try {
    parsed = load(block, { schema: JSON_SCHEMA });
  } catch {
    // 与内核一致：容忍普通说明标量里的未引用冒号，但不改写多行正文或结构化值。
    let blockIndent: number | undefined;
    const repaired = block
      .split('\n')
      .map((line) => {
        const indent = line.length - line.trimStart().length;
        if (blockIndent !== undefined) {
          if (!line.trim() || indent > blockIndent) return line;
          blockIndent = undefined;
        }
        const scalar = /^([ ]*)([\w-]+):[ \t]+(.*)$/.exec(line);
        if (!scalar) return line;
        const value = scalar[3]!.trim();
        if (/^[|>]/.test(value)) blockIndent = indent;
        if (/^["'|>[{]/.test(value) || !/:\s/.test(value)) return line;
        return `${scalar[1]}${scalar[2]}: ${JSON.stringify(value.replace(/[ \t]+#.*$/, '').trim())}`;
      })
      .join('\n');
    try {
      parsed = load(repaired, { schema: JSON_SCHEMA });
    } catch {
      return empty;
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return empty;
  const data = parsed as Record<string, unknown>;
  if (data.name != null && typeof data.name !== 'string') return empty;
  if (typeof data.description !== 'string') return empty;
  if (data.metadata != null) {
    if (typeof data.metadata !== 'object' || Array.isArray(data.metadata)) return empty;
    const short = (data.metadata as Record<string, unknown>)['short-description'];
    if (short != null && typeof short !== 'string') return empty;
  }
  const clean = (value: string) => value.trim().replace(/\s+/g, ' ');
  return {
    name: clean(typeof data.name === 'string' ? data.name : ''),
    description: clean(data.description),
  };
}

export function parseInterfaceJson(
  text: string | undefined,
  fallback: SkillInterface,
): SkillInterface {
  if (text === undefined || text.trim() === '') return fallback;
  try {
    const raw = JSON.parse(text) as Record<string, unknown>;
    const displayName =
      typeof raw.displayName === 'string' && raw.displayName.trim() !== ''
        ? raw.displayName.trim()
        : fallback.displayName;
    const category =
      typeof raw.category === 'string' && raw.category.trim() !== ''
        ? raw.category.trim()
        : fallback.category;
    const brandColor = typeof raw.brandColor === 'string' ? raw.brandColor : fallback.brandColor;
    const defaultPrompt =
      typeof raw.defaultPrompt === 'string' ? raw.defaultPrompt : fallback.defaultPrompt;
    return {
      displayName,
      category,
      ...(brandColor !== undefined ? { brandColor } : {}),
      ...(defaultPrompt !== undefined ? { defaultPrompt } : {}),
    };
  } catch {
    return fallback;
  }
}

export function listSkills(roots: SkillRoots, io: CatalogIo): readonly SkillRecord[] {
  const official = scanRoot(roots.official, 'official', true, io);
  const user = scanRoot(roots.user, 'local', false, io);
  // 5.5（HUB-Q7=A）：Hub 发布了随包技能的新版本时，Hub 那份生效；卸载后回落到随包版本。
  // 「版本高的才装」由安装方判，这里只认来源标记：只有 `hub` 能盖过随包，`local` / `git` 不能
  // 吊销了的 Hub 版本不再盖过随包版本：内核那边已经回落到随包那份，目录要说同一件事
  const hubOverrides = new Map(
    user.filter((s) => s.source === 'hub' && s.hubRevoked !== true).map((s) => [s.id, s] as const),
  );
  const merged = official.map((s) => hubOverrides.get(s.id) ?? s);
  const seen = new Set(official.map((s) => s.id));
  const extra = user.filter((s) => !seen.has(s.id));
  return [...merged, ...extra];
}

function scanRoot(
  root: string,
  source: SkillSource,
  featuredPool: boolean,
  io: CatalogIo,
): SkillRecord[] {
  const entries = safeReadDir(io, root);
  const records: SkillRecord[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory || SKIP_DIRS.has(entry.name)) continue;
    const dir = join(root, entry.name);
    const skillMd = io.readText(join(dir, 'SKILL.md'));
    if (skillMd === undefined) continue;
    const fm = parseFrontmatter(skillMd);
    const id = fm.name || entry.name;
    const description = fm.description;
    const fallback: SkillInterface = {
      displayName: id,
      category: '未分类',
    };
    const iface = parseInterfaceJson(io.readText(join(dir, 'interface.json')), fallback);
    const files = io.listFiles(dir, 3);
    const audit = auditSkillFiles(files);
    const markerText = io.readText(join(dir, SOURCE_MARKER_FILE))?.trim();
    const marked = readSourceMarker(markerText, source);
    const hubRevoked = source !== 'official' && markerText === HUB_REVOKED_MARKER;
    records.push({
      id,
      path: dir,
      name: iface.displayName,
      description,
      source: marked,
      installed: true,
      featured: featuredPool,
      interface: iface,
      audit,
      ...(hubRevoked ? { hubRevoked: true } : {}),
    });
  }
  return records.sort((a, b) => a.id.localeCompare(b.id));
}

function safeReadDir(io: CatalogIo, path: string): readonly DirEntry[] {
  try {
    return io.readDir(path);
  } catch {
    return [];
  }
}

/** 安装时写下的来源标记。官方根不读它，避免用户文件覆盖「官方内置」。 */
function readSourceMarker(text: string | undefined, fallback: SkillSource): SkillSource {
  if (fallback === 'official') return fallback;
  const raw = text?.trim();
  if (raw === 'git' || raw === 'private' || raw === 'local' || raw === 'hub') return raw;
  if (raw === HUB_REVOKED_MARKER) return 'hub';
  return fallback;
}

/** 「换一换」：从精选池里取 3 个，offset 循环。不够 3 个就全给。 */
export function rotateFeatured(
  skills: readonly SkillRecord[],
  offset: number,
): readonly SkillRecord[] {
  const pool = skills.filter((s) => s.featured);
  if (pool.length <= 3) return pool;
  const start = ((offset % pool.length) + pool.length) % pool.length;
  const out: SkillRecord[] = [];
  for (let i = 0; i < 3; i += 1) {
    const item = pool[(start + i) % pool.length];
    if (item !== undefined) out.push(item);
  }
  return out;
}

export function filterSkills(
  skills: readonly SkillRecord[],
  query: string,
  options: {
    readonly installedOnly: boolean;
    readonly category?: string | undefined;
    readonly bundleOnly?: boolean | undefined;
  },
): readonly SkillRecord[] {
  const q = query.trim().toLowerCase();
  return skills.filter((s) => {
    if (options.installedOnly && !s.installed) return false;
    if (
      options.category !== undefined &&
      options.category !== '' &&
      s.interface.category !== options.category
    )
      return false;
    if (options.bundleOnly === true) return false;
    if (q === '') return true;
    return (
      s.name.toLowerCase().includes(q) ||
      s.id.toLowerCase().includes(q) ||
      s.description.toLowerCase().includes(q) ||
      s.interface.category.toLowerCase().includes(q)
    );
  });
}

export function categoriesOf(skills: readonly SkillRecord[]): readonly string[] {
  return [...new Set(skills.map((s) => s.interface.category))].sort((a, b) => a.localeCompare(b));
}
