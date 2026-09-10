import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import type { AuditFile, CatalogIo, DirEntry } from '../src/index.js';

/** 测试用真实 fs。生产路径由桌面宿主注入同一形状。 */
export const nodeCatalogIo: CatalogIo = {
  readDir(path) {
    return readdirSync(path, { withFileTypes: true }).map((e) => ({
      name: e.name,
      isDirectory: e.isDirectory(),
    })) satisfies DirEntry[];
  },
  readText(path) {
    try {
      return readFileSync(path, 'utf8');
    } catch {
      return undefined;
    }
  },
  listFiles(dir, maxDepth = 3) {
    return walk(dir, '', maxDepth);
  },
};

function walk(root: string, rel: string, depth: number): AuditFile[] {
  if (depth < 0) return [];
  const here = rel === '' ? root : join(root, rel);
  let names: string[] = [];
  try {
    names = readdirSync(here);
  } catch {
    return [];
  }
  const out: AuditFile[] = [];
  for (const name of names) {
    if (name === 'node_modules' || name === '.git') continue;
    const childRel = rel === '' ? name : join(rel, name);
    const full = join(root, childRel);
    let dir = false;
    try {
      dir = statSync(full).isDirectory();
    } catch {
      continue;
    }
    if (dir) {
      out.push(...walk(root, childRel, depth - 1));
      continue;
    }
    const text = isText(name) ? readFileSync(full, 'utf8') : undefined;
    out.push({ relativePath: childRel, ...(text !== undefined ? { text } : {}) });
  }
  return out;
}

function isText(name: string): boolean {
  return /\.(md|json|py|mjs|js|ts|toml|txt|yml|yaml)$/i.test(name);
}
