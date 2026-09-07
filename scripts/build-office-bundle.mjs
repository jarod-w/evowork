#!/usr/bin/env node
/**
 * 打一份**离线安装包**（08 §4 的"企业离线部署提供全量包"）。
 *
 * ```bash
 * # 给这台机器的架构打一份
 * node scripts/build-office-bundle.mjs --out ~/evowork-office-bundle
 *
 * # 给一台不在手边的机器打（下发前在有网的机器上做）
 * node scripts/build-office-bundle.mjs --triple x86_64-pc-windows-msvc --out ./bundle-win
 * ```
 *
 * 产出的目录直接交给 `EVOWORK_OFFICE_BUNDLE`：
 *
 * ```
 * <out>/python-<triple>.tar.gz     解释器（自包含、位置无关）
 * <out>/wheels/*.whl               六个包及其全部依赖
 * <out>/NotoSansSC.ttf             中文字体（安装时切成静态实例）
 * <out>/MANIFEST.json              打的是什么版本、给哪个平台、什么时候打的
 * ```
 *
 * ## 为什么需要它
 *
 * 很多企业机器上不去 GitHub 与 PyPI（这不是假设：`pipMessage` 里"公司代理挡了 PyPI"
 * 是安装失败里最常见的一类）。没有离线包的话，这些机器上 Word / Excel / PPT / PDF
 * **永远不可用**，而且没有任何出路。
 *
 * ## 一条容易踩的：wheel 是**分平台**的
 *
 * matplotlib / pillow / lxml 都带原生扩展，wheel 文件名里钉着平台与 ABI。
 * 所以一份 bundle 只服务**一个 triple**，跨平台要各打一份 —— 脚本因此拒绝
 * "一次打全平台"：那样打出来的包在目标机器上会以 `--no-index` 找不到 wheel 失败，
 * 而错误信息出现在用户那边，不是在打包的人这边。
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 清单从 TS 源码里读，**不在这里抄一份**。
 *
 * 抄一份的代价是确定的：改了 `manifest.ts` 的版本却忘了改脚本，打出来的离线包
 * 与在线装出来的是两套环境，而"两条路径装出来必须一样"正是那份清单存在的理由。
 * 用正则读而不是 import：这个脚本要能在没跑过 `tsc -b` 的干净签出上直接跑。
 */
export function readManifest() {
  const source = readFileSync(
    join(REPO_ROOT, 'services/runtime-installer/src/manifest.ts'),
    'utf8',
  );

  const pick = (name) => {
    const match = source.match(new RegExp(`${name} = '([^']+)'`));
    if (!match) throw new Error(`清单里读不到 ${name} —— manifest.ts 的写法变了？`);
    return match[1];
  };

  const requirements = [...source.matchAll(/'([a-z0-9-]+==[\d.]+)'/g)].map((m) => m[1]);
  if (requirements.length === 0) throw new Error('清单里一个依赖都没读到');

  const triples = [...source.matchAll(/'([a-z0-9_]+-[a-z0-9-]+)':\s*pythonAsset\(/g)].map(
    (m) => m[1],
  );

  /*
   * python 的哈希也读出来。不读的话大文件没法"重跑不重下"——
   * 而它正是最值得跳过的那一个（25–110MB）。
   */
  const pythonSha = Object.fromEntries(
    [
      ...source.matchAll(
        /'([a-z0-9_]+-[a-z0-9-]+)':\s*pythonAsset\(\s*'[^']+',\s*'([0-9a-f]{64})'/g,
      ),
    ].map((m) => [m[1], m[2]]),
  );

  const fontUrl = source
    .match(/FONT_ASSET[\s\S]*?url:\s*\n?\s*'([^']+)'\s*\+\s*\n?\s*'([^']+)'/)
    ?.slice(1, 3)
    .join('');
  const fontSha = source.match(/FONT_ASSET[\s\S]*?sha256: '([0-9a-f]{64})'/)?.[1];
  if (!fontUrl || !fontSha) throw new Error('清单里读不到字体资产');

  return {
    pythonVersion: pick('PYTHON_VERSION'),
    pythonRelease: pick('PYTHON_RELEASE'),
    requirements,
    triples,
    pythonSha,
    font: { url: fontUrl, sha256: fontSha },
  };
}

function parseArgs(argv) {
  const args = { out: undefined, triple: undefined };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--out') args.out = argv[++i];
    else if (argv[i] === '--triple') args.triple = argv[++i];
    else if (argv[i] === '--help' || argv[i] === '-h') args.help = true;
  }
  return args;
}

/** 本机的 triple。与 `manifest.ts` 的 `TRIPLE_BY_PLATFORM` 是同一张表。 */
export function currentTriple() {
  return {
    'arm64-darwin': 'aarch64-apple-darwin',
    'x64-darwin': 'x86_64-apple-darwin',
    'x64-win32': 'x86_64-pc-windows-msvc',
    'arm64-win32': 'aarch64-pc-windows-msvc',
    'x64-linux': 'x86_64-unknown-linux-gnu',
    'arm64-linux': 'aarch64-unknown-linux-gnu',
  }[`${process.arch}-${process.platform}`];
}

function sha256Of(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/**
 * 下载一个文件，**带重试与断点续跑**。
 *
 * 两条都是被实际打包过程逼出来的（2026-09-07）：python 与 31 个 wheel 都下完了，
 * 最后一步字体一次 `fetch failed` 就让整个包作废，重来要再拖 85MB。
 * 打包的人多半在一条不稳的网上，而这个脚本一次要拉一百多兆。
 *
 *   · **已经在盘上且哈希对**：直接跳过（重跑不重下）；
 *   · **临时失败**：退避重试 3 次。校验失败**不重试** —— 再下一遍还是同样的内容。
 */
async function download(url, dest, expectedSha) {
  if (expectedSha && existsSync(dest) && sha256Of(dest) === expectedSha) {
    console.log('     已在本地且校验通过，跳过');
    return expectedSha;
  }

  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(url, { redirect: 'follow' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      mkdirSync(dirname(dest), { recursive: true });
      const hash = createHash('sha256');
      const source = Readable.fromWeb(response.body);
      source.on('data', (chunk) => hash.update(chunk));
      await pipeline(source, createWriteStream(dest));

      const actual = hash.digest('hex');
      if (expectedSha && actual !== expectedSha) {
        await rm(dest, { force: true });
        // 打包阶段就必须拦下来：带着一个坏文件的离线包会在**每一台**目标机器上失败。
        // 直接抛出去，不进重试 —— 内容不对不是运气问题
        throw Object.assign(
          new Error(`校验不通过，已丢弃：${url}\n  期望 ${expectedSha}\n  实际 ${actual}`),
          { fatal: true },
        );
      }
      return actual;
    } catch (err) {
      if (err?.fatal) throw err;
      lastError = err;
      await rm(dest, { force: true });
      if (attempt < 3) {
        console.log(`     第 ${attempt} 次失败（${err.message}），${attempt} 秒后重试 …`);
        await new Promise((r) => setTimeout(r, attempt * 1000));
      }
    }
  }
  throw new Error(`下载失败（重试 3 次）：${url}\n  ${lastError?.message ?? ''}`);
}

/**
 * pip 的平台标签。
 *
 * `pip download --platform` 要的是 wheel 文件名里的那个标签，与 rust 风格的 triple
 * 不是一回事。写错的表现是"下不到 wheel"，而不是报错说标签错了。
 */
export const PIP_PLATFORMS = {
  'aarch64-apple-darwin': ['macosx_11_0_arm64'],
  'x86_64-apple-darwin': ['macosx_10_13_x86_64'],
  'x86_64-pc-windows-msvc': ['win_amd64'],
  'aarch64-pc-windows-msvc': ['win_arm64'],
  'x86_64-unknown-linux-gnu': ['manylinux2014_x86_64', 'manylinux_2_28_x86_64'],
  'aarch64-unknown-linux-gnu': ['manylinux2014_aarch64', 'manylinux_2_28_aarch64'],
};

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0]);
    return 0;
  }

  const manifest = readManifest();
  const triple = args.triple ?? currentTriple();
  if (!triple) {
    console.error(`✗ 这台机器的架构（${process.arch}-${process.platform}）不在支持列表里。`);
    return 1;
  }
  if (!manifest.triples.includes(triple)) {
    console.error(`✗ 清单里没有 ${triple}。支持的是：\n  ${manifest.triples.join('\n  ')}`);
    return 1;
  }
  if (!args.out) {
    console.error('✗ 要 --out <目录>。');
    return 1;
  }

  const out = resolve(args.out);
  const wheels = join(out, 'wheels');
  mkdirSync(wheels, { recursive: true });

  const [major, minor] = manifest.pythonVersion.split('.');
  console.log(`打包 ${triple}，python ${manifest.pythonVersion}+${manifest.pythonRelease}`);

  /* ① 解释器 */
  const archiveName = `python-${triple}.tar.gz`;
  const url =
    `https://github.com/astral-sh/python-build-standalone/releases/download/` +
    `${manifest.pythonRelease}/cpython-${manifest.pythonVersion}%2B${manifest.pythonRelease}` +
    `-${triple}-install_only.tar.gz`;
  console.log(`  ① 解释器 …`);
  const pythonSha = await download(url, join(out, archiveName), manifest.pythonSha[triple]);

  /* ② wheel —— 分平台，且**只要二进制包** */
  console.log(`  ② wheel（${manifest.requirements.length} 个包及其依赖）…`);
  const platformFlags = (PIP_PLATFORMS[triple] ?? []).flatMap((p) => ['--platform', p]);
  try {
    execFileSync(
      process.env.EVOWORK_BUNDLE_PYTHON ?? 'python3',
      [
        '-m',
        'pip',
        'download',
        '--dest',
        wheels,
        // 必须只要 wheel：源码包要在目标机器上编译，而那台机器多半没有编译器，
        // 也正是因为上不了网才在用离线包
        '--only-binary=:all:',
        '--python-version',
        `${major}.${minor}`,
        ...platformFlags,
        ...manifest.requirements,
      ],
      { stdio: 'inherit' },
    );
  } catch {
    console.error(
      '\n✗ 下载 wheel 失败。常见原因：本机 pip 太旧（`--platform` 需要 pip ≥ 20），' +
        '或者这个平台的某个包没有预编译 wheel。\n' +
        '  可以用 EVOWORK_BUNDLE_PYTHON 指定一个新一点的解释器。',
    );
    return 1;
  }

  /* ③ 字体 */
  console.log('  ③ 中文字体 …');
  const fontSha = await download(
    manifest.font.url,
    join(out, 'NotoSansSC.ttf'),
    manifest.font.sha256,
  );

  /* ④ 清单 —— 让收到包的人知道自己拿到的是什么 */
  writeFileSync(
    join(out, 'MANIFEST.json'),
    `${JSON.stringify(
      {
        triple,
        pythonVersion: manifest.pythonVersion,
        pythonRelease: manifest.pythonRelease,
        requirements: manifest.requirements,
        builtAt: new Date().toISOString(),
        sha256: { [archiveName]: pythonSha, 'NotoSansSC.ttf': fontSha },
      },
      null,
      2,
    )}\n`,
  );

  const wheelCount = existsSync(wheels)
    ? readdirSync(wheels).filter((f) => f.endsWith('.whl')).length
    : 0;
  if (wheelCount === 0) {
    // 空的 wheels/ 目录在目标机器上表现为"装不上"，而那时已经晚了
    console.error('✗ 一个 wheel 都没下到，这份离线包是坏的。');
    return 1;
  }

  console.log(`\n✓ 打好了：${out}`);
  console.log(`  ${archiveName} · wheels/ ${wheelCount} 个 · NotoSansSC.ttf`);
  console.log(`\n目标机器上：`);
  console.log(`  export EVOWORK_OFFICE_BUNDLE=${out}`);
  console.log(`  然后在 EvoWork 里点「现在安装」—— 这条路径**一个字节都不出网**。`);
  return 0;
}

/*
 * 只有被直接执行时才跑。**被 import 时不能有副作用** ——
 * 测试要拿 `readManifest` 与 TS 清单对账，而一个 import 就开始下载 100MB 的模块没法测。
 */
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error(`✗ ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    },
  );
}
