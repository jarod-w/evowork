#!/usr/bin/env node
/**
 * 构建 EvoWork 用的内核二进制：`../codex` 的 HEAD **导出副本** + `patches/evowork/*.patch`。
 *
 * ## 为什么不直接在 `../codex` 里编
 *
 * K1：内核不可变。补丁只能落在 `patches/evowork/`，**不能改 `../codex` 的工作树** —— 那是上游签出，
 * 改了之后 `git log HEAD..origin/main`、漂移雷达、下一次 rebase 都会被一份没人记得的本地改动搅乱。
 * 所以这里用 `git archive HEAD` 导出一份干净源码到 `build/.kernel-src/`，在副本上打补丁、编译，
 * 产物放进 `build/kernel/<平台>/`（E2E 与打包都从这里取），同目录写一份来源说明。
 *
 * 编译缓存放在 `build/.kernel-target/`：源码路径固定，第二次起是增量编译。
 * 内核提交与补丁都没变时**不重新导出**（`.evowork-stamp` 记着上次的组合）：`git archive` 给文件的
 * mtime 是提交时间，但 `git apply` 写出的补丁文件是"现在"，每次重导都会让 cargo 把 `codex-core`
 * 及其下游整片重编一遍。
 * （不与 `../codex/codex-rs/target` 共用：那样会把上游自己的 `codex-app-server` 覆盖成打过补丁的版本。）
 *
 * 用法：
 *   node scripts/build-kernel.mjs              # release，产物到 build/kernel/<平台>/codex-app-server
 *   node scripts/build-kernel.mjs --debug      # debug（约 1 GB，编得快，只给本机调试）
 *   node scripts/build-kernel.mjs --check      # 只导出并试打补丁，不编译（补丁还打不打得上）
 *
 * 补丁打不上时**直接失败**并说是哪一个 —— 上游改了那几行，补丁要重做，不能跳过它编一个"差不多"的内核。
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { arch, platform } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CODEX = resolve(process.env.EVOWORK_CODEX_DIR ?? join(ROOT, '..', 'codex'));
const SRC = join(ROOT, 'build', '.kernel-src');
const TARGET = join(ROOT, 'build', '.kernel-target');
const PATCHES = join(ROOT, 'patches', 'evowork');

const args = new Set(process.argv.slice(2));
const profile = args.has('--debug') ? 'debug' : 'release';
const checkOnly = args.has('--check');

const platformKey =
  platform() === 'darwin'
    ? `mac-${arch()}`
    : platform() === 'win32'
      ? `win-${arch()}`
      : `linux-${arch()}`;
const binaryName = platform() === 'win32' ? 'codex-app-server.exe' : 'codex-app-server';

function step(message) {
  process.stdout.write(`▸ ${message}\n`);
}

if (!existsSync(join(CODEX, '.git'))) {
  throw new Error(`找不到内核签出：${CODEX}（或设 EVOWORK_CODEX_DIR）`);
}
const commit = execFileSync('git', ['-C', CODEX, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const dirty = execFileSync('git', ['-C', CODEX, 'status', '--porcelain'], {
  encoding: 'utf8',
}).trim();
if (dirty) {
  // 导出的是 HEAD，工作树里的改动不会进来 —— 说一声，免得有人以为本地改动编进去了
  process.stdout.write(`⚠ ${CODEX} 有未提交改动，它们不会进这次构建（导出的是 HEAD）。\n`);
}

const sha = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
const patches = readdirSync(PATCHES)
  .filter((name) => name.endsWith('.patch'))
  .sort();
const patchList = patches.map((name) => ({ name, sha256: sha(join(PATCHES, name)) }));
const STAMP = join(SRC, '.evowork-stamp');
const stamp = JSON.stringify({ commit, patches: patchList });
const upToDate = !checkOnly && existsSync(STAMP) && readFileSync(STAMP, 'utf8') === stamp;

if (upToDate) {
  step(`${SRC} 已是 ${commit.slice(0, 10)} + ${patches.length} 个补丁，沿用（增量编译）`);
} else {
  step(`导出 ${CODEX} @ ${commit.slice(0, 10)} → ${SRC}`);
  rmSync(SRC, { recursive: true, force: true });
  mkdirSync(SRC, { recursive: true });
  const archive = spawnSync('git', ['-C', CODEX, 'archive', '--format=tar', 'HEAD'], {
    maxBuffer: 2 * 1024 ** 3,
  });
  if (archive.status !== 0) throw new Error(`git archive 失败：${archive.stderr}`);
  const untar = spawnSync('tar', ['-x', '-C', SRC], { input: archive.stdout });
  if (untar.status !== 0) throw new Error(`解包失败：${untar.stderr}`);

  for (const name of patches) {
    step(`打补丁 ${name}`);
    const patchPath = join(PATCHES, name);
    /*
     * `build/.kernel-src` 在 evowork 仓库里面。`git apply` 在某个仓库的子目录里跑时，补丁路径按
     * **仓库根**解释，落在当前目录之外的文件被**静默跳过、退出码照样是 0** —— 2026-10-01 第一次
     * 编 P6 就是这样：日志写着「打补丁」，来源文件记着补丁，二进制却是原样的上游内核
     * （E2E 的 P6 用例抓到的）。所以：不让 git 往上找仓库，并且打完按内容核对。
     */
    const touched = [...readFileSync(patchPath, 'utf8').matchAll(/^\+\+\+ b\/(.+)$/gm)].map(
      (match) => match[1],
    );
    const fingerprint = (rel) => (existsSync(join(SRC, rel)) ? sha(join(SRC, rel)) : null);
    const before = new Map(touched.map((rel) => [rel, fingerprint(rel)]));
    const applied = spawnSync('git', ['apply', '--whitespace=nowarn', patchPath], {
      cwd: SRC,
      encoding: 'utf8',
      env: { ...process.env, GIT_CEILING_DIRECTORIES: dirname(SRC) },
    });
    if (applied.status !== 0) {
      throw new Error(
        `${name} 打不上（上游改了补丁所在的那几行）：\n${applied.stderr}\n` +
          '补丁要按新代码重做，并重新核对它的 .md 说明 —— 不要跳过它编一个没有这项修复的内核。',
      );
    }
    const unchanged = touched.filter((rel) => fingerprint(rel) === before.get(rel));
    if (touched.length === 0 || unchanged.length > 0) {
      throw new Error(
        `${name}：git apply 说打上了，但${touched.length === 0 ? '补丁里一个文件都没认出来' : `这些文件一个字节都没变：${unchanged.join('、')}`}` +
          ' —— 编出来的会是没有这项修复的内核。',
      );
    }
  }
  // 最后写：中途失败的导出不会被下次当成"已是最新"
  if (!checkOnly) writeFileSync(STAMP, stamp);
}
if (checkOnly) {
  step(`--check：${patches.length} 个补丁都打得上（已按内容核对），不编译。`);
  process.exit(0);
}

step(`cargo build -p codex-app-server（${profile}）`);
const build = spawnSync(
  'cargo',
  ['build', '-p', 'codex-app-server', ...(profile === 'release' ? ['--release'] : [])],
  {
    cwd: join(SRC, 'codex-rs'),
    stdio: 'inherit',
    env: { ...process.env, CARGO_TARGET_DIR: TARGET },
  },
);
if (build.status !== 0) throw new Error('cargo build 失败，见上面的输出。');

const built = join(TARGET, profile, binaryName);
const outDir = join(ROOT, 'build', 'kernel', platformKey);
mkdirSync(outDir, { recursive: true });
copyFileSync(built, join(outDir, binaryName));
writeFileSync(
  join(outDir, 'KERNEL_PROVENANCE.json'),
  `${JSON.stringify(
    {
      codexCommit: commit,
      profile,
      patches: patchList,
      binarySha256: sha(join(outDir, binaryName)),
      builtAt: new Date().toISOString(),
    },
    null,
    2,
  )}\n`,
);
step(`完成：${join(outDir, binaryName)}（来源见同目录 KERNEL_PROVENANCE.json）`);
