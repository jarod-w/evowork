#!/usr/bin/env node
/**
 * K1 自检：内核补丁的硬上限（≤ 5 个文件、≤ 500 行）+ 每个补丁必须有「为什么扩展点做不到」的说明。
 *
 * 为什么要脚本：K1 的代价不是「代码丑」，而是**每次上游 rebase 都要重付一遍**。这种成本
 * 是渐进的 —— 没有哪一次加补丁的人觉得自己越界了，越界是第 7 个补丁累积出来的。
 * 所以让 CI 在每次提交时算这笔账。
 *
 * 说明文件的要求（D7 原话「每个补丁必须有 issue 说明为什么无法通过扩展点实现」）：
 * 每个 `foo.patch` 必须有同名的 `foo.md`，且其中要出现「为什么扩展点做不到」这一节 ——
 * 不接受只写「上游没提供」，因为那句话对四个扩展点（技能/MCP/hooks/extension-api）
 * 逐一说明才算成立。脚本只能检查这一节存在；内容质量靠 review。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PATCH_DIR = join(REPO_ROOT, 'patches/evowork');

/** CLAUDE.md K1 的硬上限。改这两个数字要先改 CLAUDE.md 与总纲 G3。 */
const MAX_FILES = 5;
const MAX_LINES = 500;

const RATIONALE_HEADING = /为什么扩展点做不到/;

function parsePatch(text) {
  const files = new Set();
  let changed = 0;
  for (const line of text.split('\n')) {
    // diff --git a/x b/x —— 统计被改的内核文件数
    const m = /^diff --git a\/(\S+)/.exec(line);
    if (m?.[1]) {
      files.add(m[1]);
      continue;
    }
    if (/^\+\+\+ |^--- /.test(line)) continue; // 文件头不算改动行
    if (/^[+-]/.test(line)) changed += 1;
  }
  return { files: [...files], changed };
}

const patches = existsSync(PATCH_DIR)
  ? readdirSync(PATCH_DIR)
      .filter((f) => f.endsWith('.patch'))
      .sort()
  : [];

const problems = [];
const rows = [];
const allFiles = new Set();
let totalLines = 0;

for (const name of patches) {
  const text = readFileSync(join(PATCH_DIR, name), 'utf8');
  const { files, changed } = parsePatch(text);
  files.forEach((f) => allFiles.add(f));
  totalLines += changed;
  rows.push({ name, files: files.length, changed });

  const rationale = join(PATCH_DIR, `${name.replace(/\.patch$/, '')}.md`);
  if (!existsSync(rationale)) {
    problems.push(`\`${name}\` 缺少同名说明文件 \`${name.replace(/\.patch$/, '')}.md\`（D7 要求）`);
  } else if (!RATIONALE_HEADING.test(readFileSync(rationale, 'utf8'))) {
    problems.push(
      `\`${name}\` 的说明文件里没有「为什么扩展点做不到」这一节 —— 要对技能 / MCP / hooks / extension-api 四个扩展点逐一说明（K3）`,
    );
  }
}

console.log('# 内核补丁预算（K1）');
console.log('');
if (patches.length === 0) {
  console.log(
    '补丁清单为空。当前设计判定真正需要的补丁只剩 **P4（对外可见品牌字符串）** 一项，尚未落成。',
  );
  console.log('');
  console.log(`预算：文件 0 / ${MAX_FILES} · 行数 0 / ${MAX_LINES}`);
} else {
  console.log('| 补丁 | 改动文件数 | 改动行数 |');
  console.log('|---|---|---|');
  for (const r of rows) console.log(`| \`${r.name}\` | ${r.files} | ${r.changed} |`);
  console.log('');
  console.log(
    `合计：**去重后文件 ${allFiles.size} / ${MAX_FILES}** · **行数 ${totalLines} / ${MAX_LINES}**`,
  );
  console.log('');
  console.log('被改的内核文件：');
  for (const f of [...allFiles].sort()) console.log(`- \`${f}\``);
}
console.log('');

if (allFiles.size > MAX_FILES) {
  problems.push(`超出 K1 文件上限：${allFiles.size} > ${MAX_FILES}`);
}
if (totalLines > MAX_LINES) {
  problems.push(`超出 K1 行数上限：${totalLines} > ${MAX_LINES}`);
}

if (problems.length) {
  console.log('## ❌ 不合规');
  console.log('');
  for (const p of problems) console.log(`- ${p}`);
  console.log('');
  console.log(
    '处理顺序（CLAUDE.md §4）：先回到决策树看能不能往**外**推 —— 技能 → MCP → hooks → extension-api；',
  );
  console.log('确实都做不到时，先在 docs/ 里写清「为什么扩展点做不到」，再改补丁。');
  process.exit(1);
}

console.log('✅ 符合 K1。');
