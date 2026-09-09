/**
 * 结构扫描：管理端与账号协议类型里没有任务 / 产物 / prompt（11 §12 第 15 条）。
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '../src');

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, name.name);
    if (name.isDirectory()) out.push(...walk(path));
    else if (name.name.endsWith('.ts') || name.name.endsWith('.tsx')) out.push(path);
  }
  return out;
}

describe('WEB 没有内容面', () => {
  it('src/ 的类型声明没有 threadId / artifact / prompt', () => {
    const hits: string[] = [];
    for (const file of walk(SRC)) {
      const text = readFileSync(file, 'utf8');
      if (/readonly threadId\b|readonly artifact\b|readonly prompt\b/.test(text)) {
        hits.push(file);
      }
    }
    expect(hits, `WEB 类型出现了内容面字段：${hits.join(', ')}`).toEqual([]);
  });

  it('没有分享路由实现', () => {
    const app = readFileSync(join(SRC, 'app.tsx'), 'utf8');
    expect(app).not.toMatch(/\/s\//);
    expect(app).toContain('没有任务 / 产物 / 分享页');
  });
});
