/**
 * 分享页与账号应用的隔离（11 §13.10 C 第 1 条 / 验收口径第 25 条）。
 *
 * 这一页要渲染的是**不可信来源的元数据**，它旁边不该放着一把令牌。
 * 靠"我们记得不调用"守不住 —— 所以这里扫 import 图：
 * `src/share/**` 只要 import 到账号那一侧（`../api.js` / `../components.js` / 任何 screens），
 * 这条就红。
 *
 * **改这条测试就是那次决策的登记动作。**
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SHARE_DIR = join(ROOT, 'src/share');

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(path));
    else if (/\.tsx?$/.test(entry.name)) out.push(path);
  }
  return out;
}

function importsOf(file: string): readonly string[] {
  const text = readFileSync(file, 'utf8');
  return [...text.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1] ?? '');
}

describe('分享页是独立入口', () => {
  const files = walk(SHARE_DIR);

  it('目录里有东西（防止这条测试在空目录上空转）', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it('不 import 账号应用的任何模块 —— 包括它的 api、组件与页面', () => {
    const offenders: string[] = [];
    for (const file of files) {
      for (const spec of importsOf(file)) {
        // 允许：相对本目录、react、@evowork/tokens、node 内置
        if (spec.startsWith('./')) continue;
        if (!spec.startsWith('.')) continue;
        offenders.push(`${file} → ${spec}`);
      }
    }
    expect(offenders, `分享页 import 到了账号那一侧：${offenders.join(', ')}`).toEqual([]);
  });

  it('代码里没有 session / authorization / Bearer', () => {
    for (const file of files) {
      const code = readFileSync(file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '');
      expect(code, `${file} 出现了 sessionStorage`).not.toMatch(/sessionStorage|localStorage/);
      expect(code, `${file} 出现了 authorization 头`).not.toMatch(/authorization/i);
      expect(code, `${file} 出现了 Bearer`).not.toMatch(/Bearer/);
      expect(code, `${file} 出现了 cookie`).not.toMatch(/cookie/i);
    }
  });

  it('share.html 与 index.html 是两个入口，且分享页不加载账号那一份', () => {
    const shareHtml = readFileSync(join(ROOT, 'share.html'), 'utf8');
    expect(shareHtml).toContain('/src/share/main.tsx');
    expect(shareHtml).not.toContain('/src/main.tsx');
    // 不给 referrer：分享链接会被转发到各种地方，别把来源带给我们自己
    expect(shareHtml).toContain('referrer');
  });

  it('vite 配了两个入口且关掉了公共 chunk', () => {
    const config = readFileSync(join(ROOT, 'vite.config.ts'), 'utf8');
    expect(config).toContain("'share.html'");
    expect(config).toContain('manualChunks');
  });
});

describe('账号应用里没有分享路由', () => {
  it('app.tsx 的代码里不出现 /s/，注释仍说明这件事', () => {
    const raw = readFileSync(join(ROOT, 'src/app.tsx'), 'utf8');
    const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(code).not.toMatch(/\/s\//);
    expect(raw).toContain('没有任务 / 产物');
  });
});
