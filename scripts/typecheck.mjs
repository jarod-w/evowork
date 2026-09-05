#!/usr/bin/env node
/**
 * 全仓库类型检查。
 *
 * 两趟，因为它们的目标不同：
 *   ① `tsconfig.build.json`（solution 风格）—— 产出 `.d.ts`，包与包之间靠它做类型边界；
 *   ② 每个包的 `tsconfig.spec.json` —— 只检查不产出，**把测试文件也纳入检查**。
 *
 * 第 ② 趟是刻意加的：composite 项目为了产出声明文件只能 include `src/`，
 * 于是测试代码天然逃过类型检查 —— 而测试恰恰是最容易积累 `as any` 的地方，
 * 那些 any 会让"测试通过"这件事失去意义。
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WORKSPACE_DIRS = ['packages', 'services', 'apps', 'tools'];
/**
 * 技能包不在 pnpm workspace 里（它们随产品分发，不是 npm 包），但它们的测试
 * 一样有 `tsconfig.spec.json`。漏掉这一段的后果与第 ② 趟要防的事情完全一样：
 * 测试代码逃过类型检查。2026-09-05 补。
 */
const NESTED_DIRS = ['plugins/skills'];

function tsc(...args) {
  execFileSync('node', [join(REPO_ROOT, 'node_modules/typescript/bin/tsc'), ...args], {
    cwd: REPO_ROOT,
    stdio: 'inherit',
  });
}

console.log('① 构建（含声明文件）');
tsc('--build', 'tsconfig.build.json');

const specs = [];
for (const group of [...WORKSPACE_DIRS, ...NESTED_DIRS]) {
  const abs = join(REPO_ROOT, group);
  if (!existsSync(abs)) continue;
  for (const pkg of readdirSync(abs, { withFileTypes: true })) {
    if (!pkg.isDirectory()) continue;
    const spec = join(abs, pkg.name, 'tsconfig.spec.json');
    if (existsSync(spec)) specs.push(relative(REPO_ROOT, spec));
  }
}

if (specs.length === 0) {
  console.log('② 没有 tsconfig.spec.json，跳过测试类型检查');
} else {
  console.log(`② 测试类型检查（${specs.length} 个包）`);
  for (const spec of specs) {
    console.log(`   - ${spec}`);
    tsc('-p', spec);
  }
}
console.log('✅ 类型检查通过');
