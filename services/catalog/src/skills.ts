import { join } from 'node:path';

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

export function parseFrontmatter(text: string): { name: string; description: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (match === null) return { name: '', description: '' };
  const block = match[1] ?? '';
  const name = /^\s*name:\s*(.+)\s*$/m.exec(block)?.[1]?.trim() ?? '';
  const description = /^\s*description:\s*(.+)\s*$/m.exec(block)?.[1]?.trim() ?? '';
  return { name, description };
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
  const seen = new Set(official.map((s) => s.id));
  const extra = user.filter((s) => !seen.has(s.id));
  return [...official, ...extra];
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
    const marked = readSourceMarker(io.readText(join(dir, SOURCE_MARKER_FILE)), source);
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
  if (raw === 'git' || raw === 'private' || raw === 'local') return raw;
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
