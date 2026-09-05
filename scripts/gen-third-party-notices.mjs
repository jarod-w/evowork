#!/usr/bin/env node
/**
 * 生成 THIRD_PARTY_NOTICES.md（K5：「保留内核的 LICENSE/NOTICE，建并维护 THIRD_PARTY_NOTICES」）。
 *
 * 两个来源：
 *   ① **执行内核**（`../codex`，Apache-2.0）—— 它随产品分发（Q1=A 的桌面包里有内核二进制），
 *      所以 LICENSE 与 NOTICE 必须原文保留。这一段是**法务要求的最低限**，不是可选项。
 *   ② **npm 依赖**（`pnpm licenses list --json`）—— 随渲染层与服务层分发的那些。
 *
 * 为什么现在就做（而不是等 M9 打包）：P4-2「法务过审」是**外部等待**，而外部等待的前置是
 * 先有一份可送审的清单。等到 M9 再生成，就变成"发布前一周才发现有个 GPL 依赖"。
 * 脚本每次 CI 跑一遍并断言文件与依赖树一致（--check），依赖一变清单就变红。
 *
 * 用法：
 *   node scripts/gen-third-party-notices.mjs            # 写入 THIRD_PARTY_NOTICES.md
 *   node scripts/gen-third-party-notices.mjs --check     # 只校验是否最新（CI 用），不写盘
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const KERNEL_DIR = resolve(process.env.EVOWORK_KERNEL_DIR ?? join(REPO_ROOT, '..', 'codex'));
const OUT = join(REPO_ROOT, 'THIRD_PARTY_NOTICES.md');
const checkOnly = process.argv.includes('--check');

/**
 * 需要人工过一遍的许可证类别。不是"禁止"清单 —— 是"不许悄悄进来"清单：
 * copyleft 传染性许可证在桌面分发（M9 把依赖打进安装包）下的义务与 MIT/Apache 完全不同。
 */
const NEEDS_REVIEW = /\b(GPL|AGPL|LGPL|SSPL|CDDL|EPL|MPL|CC-BY-NC|BUSL|Commons Clause)/i;

function readKernelLicenseInfo() {
  const licensePath = join(KERNEL_DIR, 'LICENSE');
  const noticePath = join(KERNEL_DIR, 'NOTICE');
  if (!existsSync(licensePath)) {
    return { available: false, kernelDir: KERNEL_DIR };
  }
  const license = readFileSync(licensePath, 'utf8');
  const firstLine =
    license
      .split('\n')
      .find((l) => l.trim().length > 0)
      ?.trim() ?? '';
  let commit = null;
  try {
    commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: KERNEL_DIR,
      encoding: 'utf8',
    }).trim();
  } catch {
    commit = null;
  }
  return {
    available: true,
    kernelDir: KERNEL_DIR,
    commit,
    licenseFirstLine: firstLine,
    licenseBytes: license.length,
    notice: existsSync(noticePath) ? readFileSync(noticePath, 'utf8').trim() : null,
  };
}

function readNpmLicenses() {
  try {
    const raw = execFileSync('pnpm', ['licenses', 'list', '--json', '--prod'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    // 没有生产依赖时 pnpm 打印一句人话而不是 JSON（"No license information available"）。
    // 这是骨架阶段的正常状态，不是错误 —— 报成错误会让 CI 从第一天起就红着，
    // 而"CI 一直是红的"比没有 CI 更糟。
    if (!raw.trimStart().startsWith('{')) {
      return { available: true, packages: [] };
    }
    /** @type {Record<string, Array<{name:string, version?:string, versions?:string[]}>>} */
    const byLicense = JSON.parse(raw);
    const out = [];
    for (const [license, pkgs] of Object.entries(byLicense)) {
      for (const p of pkgs) {
        const versions = p.versions ?? (p.version ? [p.version] : []);
        out.push({ name: p.name, versions: versions.sort(), license });
      }
    }
    out.sort((a, b) => a.name.localeCompare(b.name));
    return { available: true, packages: out };
  } catch (err) {
    return { available: false, reason: String(err?.message ?? err).split('\n')[0] };
  }
}

const kernel = readKernelLicenseInfo();
const npm = readNpmLicenses();

const L = [];
L.push('# THIRD PARTY NOTICES');
L.push('');
L.push('> **本文件由 `scripts/gen-third-party-notices.mjs` 生成，不要手改。**');
L.push(
  '> 依据 CLAUDE.md **K5**（许可与品牌）：保留内核的 `LICENSE` / `NOTICE`，并建立与维护本清单。',
);
L.push('> 它同时是 P4-2（法务过审）的送审输入 —— 法务排期是外部等待，清单必须先于它存在。');
L.push('');

L.push('## 1. 执行内核（随产品分发）');
L.push('');
if (kernel.available) {
  L.push(
    'EvoWork 把 `openai/codex` 当作**不可变的执行内核**，桌面安装包内含其编译产物（Q1=A / D9）。',
  );
  L.push('');
  L.push('| 项 | 值 |');
  L.push('|---|---|');
  L.push('| 项目 | openai/codex |');
  L.push('| 许可证 | Apache License 2.0 |');
  L.push(`| 签出 | \`${kernel.commit ?? '未知'}\` |`);
  L.push(`| LICENSE 首行 | ${kernel.licenseFirstLine} |`);
  L.push('');
  L.push('**分发义务（Apache-2.0 §4）**：');
  L.push('');
  L.push('1. 安装包内保留 `LICENSE` 原文与 `NOTICE`（若存在）；');
  L.push(
    '2. 修改过的文件需标注（本项目的修改全部集中在 `patches/evowork/`，见 K1 与 `scripts/patch-budget.mjs`）；',
  );
  L.push(
    '3. **不得使用 Codex / OpenAI 商标**做产品标识（K5，且 Apache-2.0 §6 本身不授予商标许可）。',
  );
  L.push('');
  if (kernel.notice) {
    L.push('内核 `NOTICE` 原文：');
    L.push('');
    L.push('```text');
    L.push(kernel.notice);
    L.push('```');
    L.push('');
  } else {
    L.push('内核当前签出**没有** `NOTICE` 文件；分发时仅需随附 `LICENSE`。');
    L.push('');
  }
} else {
  L.push(`⚠️ 未找到内核签出（\`${kernel.kernelDir}\`），本节无法生成。`);
  L.push('设 `EVOWORK_KERNEL_DIR` 后重跑。');
  L.push('');
}

L.push('## 2. 运行时依赖（npm，生产依赖）');
L.push('');
if (npm.available) {
  if (npm.packages.length === 0) {
    L.push('当前没有生产依赖（仓库尚处骨架阶段，所有依赖都是 devDependencies）。');
    L.push('');
  } else {
    const review = npm.packages.filter((p) => NEEDS_REVIEW.test(p.license));
    L.push(`共 ${npm.packages.length} 个包。`);
    L.push('');
    if (review.length) {
      L.push('### ⚠️ 需要法务单独看的许可证');
      L.push('');
      L.push('| 包 | 版本 | 许可证 |');
      L.push('|---|---|---|');
      for (const p of review)
        L.push(`| \`${p.name}\` | ${p.versions.join(', ')} | **${p.license}** |`);
      L.push('');
      L.push(
        '这些许可证在**桌面分发**（依赖被打进安装包）下的义务与 MIT/Apache 不同，需逐个确认。',
      );
      L.push('');
    }
    L.push('### 全部');
    L.push('');
    L.push('| 包 | 版本 | 许可证 |');
    L.push('|---|---|---|');
    for (const p of npm.packages)
      L.push(`| \`${p.name}\` | ${p.versions.join(', ')} | ${p.license} |`);
    L.push('');
  }
} else {
  L.push(`⚠️ 无法读取依赖许可证：${npm.reason}`);
  L.push('');
}

L.push('## 3. 解析与产物运行时（按需下载，不随主程序）');
L.push('');
L.push('08 §4 的三档运行时（办公扩展、OCR 扩展）**不随主程序分发**，在用户显式同意后下载。');
L.push('它们各自的许可证清单在下载包内随附，并在下载前的确认界面里给出链接：');
L.push('');
L.push('| 档位 | 主要组件 | 许可证 |');
L.push('|---|---|---|');
L.push(
  '| 办公扩展 | CPython · python-docx · openpyxl · python-pptx · pdfplumber | PSF-2.0 · MIT · MIT · MIT · MIT |',
);
L.push('| OCR 扩展 | tesseract + 中文语言模型 | Apache-2.0 |');
L.push('');
L.push('> 这一节的具体版本号在 M3 落地运行时分发时由同一脚本补全（目前尚无这些依赖）。');
L.push('');

const content = `${L.join('\n')}\n`;

if (checkOnly) {
  const existing = existsSync(OUT) ? readFileSync(OUT, 'utf8') : '';
  if (existing !== content) {
    console.error('❌ THIRD_PARTY_NOTICES.md 与当前依赖树不一致。跑 `pnpm notices` 重新生成。');
    process.exit(1);
  }
  console.log('✅ THIRD_PARTY_NOTICES.md 是最新的。');
} else {
  writeFileSync(OUT, content, 'utf8');
  console.log(`✅ 已写入 ${OUT}`);
}
