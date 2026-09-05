#!/usr/bin/env node
/**
 * 上游漂移雷达（R2 的缓解措施，P0-3 的交付项之一）。
 *
 * 它做三件事，每天一次（.github/workflows/kernel-drift.yml），也可以本地手跑：
 *
 *   ① **提交量与影响面**：HEAD..origin/main 有多少提交，其中有多少落在 EvoWork 真正依赖的
 *      子目录上（app-server-protocol / extension-api / hooks / skills / core-plugins /
 *      protocol / collaboration-mode-templates）。总提交数没有意义 —— 一天 50 个提交里
 *      49 个改 TUI 与我们无关，剩下 1 个改 v2 协议才是要看的。
 *   ② **断言复核**：把 scripts/kernel-assertions.json（= 设计文档 F1–F16 的机器孪生）逐条
 *      在**当前签出**上重跑。行号漂移只报不failed；needle 消失或枚举变体数变化才算 BROKEN。
 *   ③ **补丁试合并**：patches/evowork/*.patch 能否干净地打到 origin/main 上（K1、D7）。
 *      现在补丁清单只剩 P4，所以通常是空跑 —— 但这个 job 必须在**有补丁之前**就存在，
 *      否则它永远会被推迟到「等有补丁再说」。
 *
 * 退出码：0 = 无 BROKEN；1 = 有 BROKEN 或补丁冲突。行号漂移不影响退出码（那是常态）。
 *
 * 用法：
 *   node scripts/kernel-drift.mjs                  # 人读的 markdown 报告
 *   node scripts/kernel-drift.mjs --json           # 机器读
 *   node scripts/kernel-drift.mjs --no-fetch       # 不联网，只在当前签出上复核断言
 *   EVOWORK_KERNEL_DIR=/path/to/codex node scripts/kernel-drift.mjs
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const KERNEL_DIR = resolve(process.env.EVOWORK_KERNEL_DIR ?? join(REPO_ROOT, '..', 'codex'));

/** EvoWork 真正依赖的内核子目录。改这张表要同时改总纲附录 A。 */
const WATCHED_PATHS = [
  'codex-rs/app-server-protocol',
  'codex-rs/app-server',
  'codex-rs/protocol',
  'codex-rs/ext/extension-api',
  'codex-rs/hooks',
  'codex-rs/skills',
  'codex-rs/core-plugins',
  'codex-rs/collaboration-mode-templates',
  'codex-rs/models-manager',
  'codex-rs/execpolicy',
  'codex-rs/sandboxing',
  'codex-rs/model-provider-info',
  'sdk/typescript',
];

const args = new Set(process.argv.slice(2));
const asJson = args.has('--json');
const noFetch = args.has('--no-fetch');

function git(cwd, ...cmd) {
  return execFileSync('git', cmd, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim();
}

function gitSafe(cwd, ...cmd) {
  try {
    return { ok: true, out: git(cwd, ...cmd) };
  } catch (err) {
    return { ok: false, out: String(err?.stderr ?? err?.message ?? err).trim() };
  }
}

// ─────────────────────────────── ① 提交量与影响面 ───────────────────────────────

function collectCommitDrift() {
  if (!existsSync(join(KERNEL_DIR, '.git'))) {
    return {
      available: false,
      reason: `内核签出不存在：${KERNEL_DIR}（设 EVOWORK_KERNEL_DIR 指过去）`,
    };
  }

  const head = git(KERNEL_DIR, 'rev-parse', '--short', 'HEAD');
  const headDate = git(KERNEL_DIR, 'log', '-1', '--format=%ad', '--date=short');

  let fetched = false;
  let fetchError = null;
  if (!noFetch) {
    const r = gitSafe(KERNEL_DIR, 'fetch', '--quiet', 'origin', 'main');
    fetched = r.ok;
    if (!r.ok) fetchError = r.out;
  }

  const upstream = gitSafe(KERNEL_DIR, 'rev-parse', '--short', 'origin/main');
  if (!upstream.ok) {
    return { available: true, head, headDate, fetched, fetchError, upstream: null, behind: null };
  }

  const range = `HEAD..origin/main`;
  const countAll = Number(gitSafe(KERNEL_DIR, 'rev-list', '--count', range).out || '0');
  const watched = [];
  for (const p of WATCHED_PATHS) {
    const n = Number(gitSafe(KERNEL_DIR, 'rev-list', '--count', range, '--', p).out || '0');
    if (n > 0) watched.push({ path: p, commits: n });
  }
  watched.sort((a, b) => b.commits - a.commits);

  const subjects = gitSafe(
    KERNEL_DIR,
    'log',
    '--no-merges',
    '--format=%h %s',
    '-n',
    '20',
    range,
    '--',
    ...WATCHED_PATHS,
  ).out;

  return {
    available: true,
    head,
    headDate,
    fetched,
    fetchError,
    upstream: upstream.out,
    behind: countAll,
    watched,
    watchedSubjects: subjects ? subjects.split('\n').filter(Boolean) : [],
  };
}

// ─────────────────────────────── ② 断言复核 ───────────────────────────────

/**
 * 数一个 Rust enum 的顶层变体数。
 *
 * 判据：从 `pub enum <Name>` 那行的 `{` 开始，到缩进 0 的 `}` 结束；期间**缩进正好 4 空格
 * 且以大写字母开头**的行算一个变体。这条判据对 codex 的代码风格成立（rustfmt 强制），
 * 且能同时数对 `Foo {`、`Foo(Bar)`、`Foo,` 三种写法。属性行（`#[...]`）与文档注释被跳过。
 */
function countEnumVariants(source, name) {
  const lines = source.split('\n');
  const startIdx = lines.findIndex((l) => new RegExp(`\\bpub enum ${name}\\b`).test(l));
  if (startIdx < 0) return null;
  let count = 0;
  for (let i = startIdx + 1; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    if (/^\}/.test(line)) break;
    if (/^\s*(#|\/\/)/.test(line)) continue;
    if (/^ {4}[A-Z][A-Za-z0-9_]*\s*(\{|\(|,|$)/.test(line)) count += 1;
  }
  return count;
}

/** 取一个 struct 的字段名集合（同样依赖 rustfmt 的 4 空格缩进）。 */
function structFieldNames(source, name) {
  const lines = source.split('\n');
  const startIdx = lines.findIndex((l) => new RegExp(`\\bpub struct ${name}\\b`).test(l));
  if (startIdx < 0) return null;
  const fields = [];
  for (let i = startIdx + 1; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    if (/^\}/.test(line)) break;
    const m = /^ {4}(?:pub )?([a-z_][a-z0-9_]*)\s*:/.exec(line);
    if (m?.[1]) fields.push(m[1]);
  }
  return fields;
}

function lineOf(source, needle) {
  const idx = source.indexOf(needle);
  if (idx < 0) return null;
  return source.slice(0, idx).split('\n').length;
}

function checkAssertions() {
  const manifest = JSON.parse(
    readFileSync(join(REPO_ROOT, 'scripts/kernel-assertions.json'), 'utf8'),
  );
  const results = [];

  for (const a of manifest.assertions) {
    const abs = join(KERNEL_DIR, a.file);
    if (!existsSync(abs)) {
      results.push({
        id: a.id,
        status: 'BROKEN',
        detail: `文件不存在：${a.file}`,
        summary: a.summary,
        impact: a.impact,
      });
      continue;
    }
    const src = readFileSync(abs, 'utf8');
    const problems = [];

    const actualLine = lineOf(src, a.needle);
    if (actualLine == null) {
      problems.push(`needle 不存在：\`${a.needle}\``);
    }

    for (const must of a.mustContain ?? []) {
      if (!src.includes(must)) problems.push(`mustContain 缺失：\`${must}\``);
    }
    for (const mustNot of a.mustNotContain ?? []) {
      if (src.includes(mustNot))
        problems.push(`mustNotContain 命中（上游新增了它）：\`${mustNot}\``);
    }
    if (a.enumVariants) {
      const n = countEnumVariants(src, a.enumVariants.name);
      if (n == null) problems.push(`找不到 enum ${a.enumVariants.name}`);
      else if (n !== a.enumVariants.expected) {
        problems.push(`enum ${a.enumVariants.name} 变体数 ${a.enumVariants.expected} → **${n}**`);
      }
    }
    if (a.structFields) {
      const fields = structFieldNames(src, a.structFields.name);
      if (fields == null) problems.push(`找不到 struct ${a.structFields.name}`);
      else {
        for (const forbidden of a.structFields.mustNotHave ?? []) {
          if (fields.includes(forbidden)) {
            problems.push(
              `struct ${a.structFields.name} 新增了字段 \`${forbidden}\` —— 断言可能已被上游推翻（这是好消息，去掉自建部分）`,
            );
          }
        }
      }
    }

    const moved = actualLine != null && a.line != null && actualLine !== a.line;
    results.push({
      id: a.id,
      summary: a.summary,
      impact: a.impact,
      file: a.file,
      expectedLine: a.line ?? null,
      actualLine,
      status: problems.length ? 'BROKEN' : moved ? 'LINE-MOVED' : 'OK',
      detail: problems.join('；') || (moved ? `行号 ${a.line} → ${actualLine}` : ''),
    });
  }

  return { baseline: manifest.baseline, results };
}

// ─────────────────────────────── ③ 补丁试合并 ───────────────────────────────

function trialMergePatches() {
  const dir = join(REPO_ROOT, 'patches/evowork');
  const patches = existsSync(dir)
    ? readdirSync(dir)
        .filter((f) => f.endsWith('.patch'))
        .sort()
    : [];
  if (patches.length === 0) {
    return {
      patches: [],
      note: '补丁清单为空（当前设计只剩 P4 品牌字符串，尚未落成补丁）。job 先立住，等有补丁时零改动生效。',
    };
  }
  if (!existsSync(join(KERNEL_DIR, '.git'))) {
    return { patches, note: `内核签出不存在，跳过试合并：${KERNEL_DIR}` };
  }

  const target = gitSafe(KERNEL_DIR, 'rev-parse', 'origin/main').ok ? 'origin/main' : 'HEAD';
  const out = [];
  for (const p of patches) {
    const abs = join(dir, p);
    // --check 只检查能否应用，不改工作区；不切分支，避免污染开发者的签出
    const r = gitSafe(KERNEL_DIR, 'apply', '--check', '--3way', abs);
    out.push({
      patch: p,
      target,
      applies: r.ok,
      error: r.ok ? null : r.out.split('\n').slice(0, 4).join(' / '),
    });
  }
  return { patches: out, target };
}

// ─────────────────────────────── 报告 ───────────────────────────────

const drift = collectCommitDrift();
const assertions = checkAssertions();
const merge = trialMergePatches();

const broken = assertions.results.filter((r) => r.status === 'BROKEN');
const movedLines = assertions.results.filter((r) => r.status === 'LINE-MOVED');
const conflicts = Array.isArray(merge.patches)
  ? merge.patches.filter((p) => p.applies === false)
  : [];

if (asJson) {
  console.log(JSON.stringify({ kernelDir: KERNEL_DIR, drift, assertions, merge }, null, 2));
} else {
  const L = [];
  L.push('# 内核漂移报告');
  L.push('');
  L.push(`- 内核签出：\`${KERNEL_DIR}\``);
  if (drift.available) {
    L.push(`- 当前 HEAD：\`${drift.head}\`（${drift.headDate}）`);
    if (drift.upstream) {
      L.push(`- origin/main：\`${drift.upstream}\`，落后 **${drift.behind}** 个提交`);
    } else {
      L.push(
        `- origin/main 不可用${drift.fetchError ? `（fetch 失败：${drift.fetchError.split('\n')[0]}）` : ''}`,
      );
    }
  } else {
    L.push(`- ⚠️ ${drift.reason}`);
  }
  L.push(
    `- 断言基线：\`${assertions.baseline.commit}\`（核对于 ${assertions.baseline.verifiedAt}）`,
  );
  L.push('');

  L.push('## ① 影响面（只看 EvoWork 依赖的子目录）');
  L.push('');
  if (drift.watched?.length) {
    L.push('| 子目录 | 新提交数 |');
    L.push('|---|---|');
    for (const w of drift.watched) L.push(`| \`${w.path}\` | ${w.commits} |`);
    L.push('');
    if (drift.watchedSubjects.length) {
      L.push('最近 20 条（仅上述子目录）：');
      L.push('');
      for (const s of drift.watchedSubjects) L.push(`- ${s}`);
      L.push('');
    }
  } else if (drift.upstream) {
    L.push('EvoWork 依赖的子目录**没有**新提交。');
    L.push('');
  } else {
    L.push('无法计算（origin/main 不可用）。');
    L.push('');
  }

  L.push('## ② 断言复核（F1–F16）');
  L.push('');
  L.push(
    `OK ${assertions.results.length - broken.length - movedLines.length} · LINE-MOVED ${movedLines.length} · **BROKEN ${broken.length}**`,
  );
  L.push('');
  if (broken.length) {
    L.push('### ❌ BROKEN —— 设计文档里的判断可能已被上游推翻，动手前必须先改文档');
    L.push('');
    for (const r of broken) {
      L.push(`- **${r.id}** ${r.summary}`);
      L.push(`  - 位置：\`${r.file}\``);
      L.push(`  - 问题：${r.detail}`);
      L.push(`  - 波及：${r.impact}`);
    }
    L.push('');
  }
  if (movedLines.length) {
    L.push('### ⚠️ LINE-MOVED —— 断言仍成立，但文档里的行号该更新了');
    L.push('');
    for (const r of movedLines) L.push(`- **${r.id}** \`${r.file}\` ${r.detail}`);
    L.push('');
  }

  L.push('## ③ 补丁试合并（K1 / D7）');
  L.push('');
  if (merge.note) {
    L.push(merge.note);
  } else {
    L.push(`目标：\`${merge.target}\``);
    L.push('');
    for (const p of merge.patches) {
      L.push(`- ${p.applies ? '✅' : '❌'} \`${p.patch}\`${p.error ? ` —— ${p.error}` : ''}`);
    }
  }
  L.push('');
  console.log(L.join('\n'));
}

if (broken.length || conflicts.length) process.exit(1);
