#!/usr/bin/env node
/**
 * 把打好的包发到更新源（在线升级提案 §4 B2；总纲 Q46 与 D9 的 K6 登记）。
 *
 *   node scripts/publish-release.mjs --dest <目录 | user@host:/路径> --kid evowork-update-1 [--channel latest] [--key-file <pem>] [--dry-run]
 *
 * 2026-10-02 定：试点阶段更新源沿用现有服务器（Apache + 子域名 + HTTPS），上传权限是那台机器的
 * ssh key，只放在发版机上。**域名还没定**，所以这里只认一个目标路径：本地目录（先在本机摆出
 * 服务器上的布局看一眼）或 `user@host:/路径`（rsync over ssh）。客户端从
 * `https://<域名>/<channel>/` 取文件，对应目标路径下的 `<channel>/`。
 *
 * ## 先查后传，查不过一个字节都不传
 *
 * 发出去一份客户端验不过、或者跟源码对不上的清单，比不发更糟：前者让每个用户的「检查更新」
 * 都报错，后者是把一个说不清来源的包推给所有人。检查项见 `checkRelease`。
 *
 * ## 上传顺序：安装包 → 签名 → 清单
 *
 * 客户端先拉清单，再按清单内容的 sha256 去取签名（`signatures/<sha256>.sig`，见
 * `update-signing.mjs`），再下清单里写的安装包。所以**清单必须最后一个到**：它一出现，
 * 它指向的签名和安装包都已经在了。旧版本的文件一律不删（不带 `--delete`），出问题时能对照。
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { build } from 'esbuild';

import { readPrivateKey, signatureNameFor, signManifest } from './update-signing.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
export const MANIFEST_NAME = 'latest-mac.yml';

/* ───────────────────────────── 纯函数（有测试） ───────────────────────────── */

/**
 * 上传分三批，顺序就是正确性的一部分（见文件头）。
 * `blockmap` 跟着安装包走：electron-updater 的差量下载要它，缺了只是退回整包下载。
 */
export function uploadPlan(manifest, available) {
  const packages = [];
  for (const file of manifest.files) {
    packages.push(file.url);
    if (available.includes(`${file.url}.blockmap`)) packages.push(`${file.url}.blockmap`);
  }
  return [
    { phase: 'packages', files: packages },
    { phase: 'signature', files: [`signatures/${signatureNameFor(manifest.raw)}`] },
    { phase: 'manifest', files: [MANIFEST_NAME] },
  ];
}

/** 清单里每个文件都在、大小与 sha512 都对得上。返回问题列表，空 = 通过 */
export function checkReleaseFiles(distDir, manifest) {
  const problems = [];
  for (const file of manifest.files) {
    const path = join(distDir, file.url);
    if (!existsSync(path)) {
      problems.push(`${file.url} 不在 ${distDir}`);
      continue;
    }
    if (statSync(path).size !== file.size) problems.push(`${file.url} 的大小与清单不符`);
    const sha512 = createHash('sha512').update(readFileSync(path)).digest('base64');
    if (sha512 !== file.sha512)
      problems.push(`${file.url} 的 sha512 与清单不符（包被换过，或清单是另一次打包的）`);
  }
  return problems;
}

/**
 * 客户端内嵌的公钥够不够发这一版：要有日常与备用各一把（B3），签名用的 kid 要在里面。
 * 少了备用那把，日常私钥一丢，已装的客户端就再也验不过新版本。
 */
export function checkSigningKeys(keys, kid) {
  const problems = [];
  if (!keys.some((k) => k.role === 'daily'))
    problems.push('update-keys.ts 里没有日常（daily）公钥');
  if (!keys.some((k) => k.role === 'backup'))
    problems.push('update-keys.ts 里没有离线备用（backup）公钥');
  if (!keys.some((k) => k.kid === kid))
    problems.push(`签名用的 kid=${kid} 不在 update-keys.ts 里：客户端会报 unknown-key`);
  return problems;
}

/* ───────────────────────────── 读环境 ───────────────────────────── */

const git = (...args) => execFileSync('git', args, { cwd: REPO, encoding: 'utf8' }).trim();

/**
 * 用 esbuild 现编一个客户端模块，拿到的就是客户端编进去的那一份代码：
 * `update-keys.ts` 的公钥、`update-manifest.ts` 的清单解析与版本比较。
 * 不在脚本里另写一份 —— 两份解析器会各自走样，而「发得出去」与「客户端认得」必须是同一个判据。
 */
export async function loadClientModule(relativePath) {
  const result = await build({
    entryPoints: [join(REPO, relativePath)],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'node',
    logLevel: 'silent',
  });
  const code = result.outputFiles[0].text;
  return import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
}

function isRemote(dest) {
  return /^[^/:]+:/.test(dest);
}

function readPublishedManifest(dest, channel) {
  try {
    if (isRemote(dest)) {
      const [host, base] = splitRemote(dest);
      return execFileSync('ssh', [host, 'cat', `${base}/${channel}/${MANIFEST_NAME}`], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    }
    const path = join(dest, channel, MANIFEST_NAME);
    return existsSync(path) ? readFileSync(path, 'utf8') : undefined;
  } catch {
    return undefined; // 第一次发布：线上还没有清单
  }
}

function splitRemote(dest) {
  const i = dest.indexOf(':');
  return [dest.slice(0, i), dest.slice(i + 1).replace(/\/$/, '')];
}

/** 每一项都要过；返回 [{ ok, label, detail? }] */
export async function checkRelease({ distDir, kid, dest, channel }) {
  const { parseUpdateManifest, compareVersions } = await loadClientModule(
    'apps/desktop/src/main/update-manifest.ts',
  );
  const version = JSON.parse(readFileSync(join(REPO, 'apps/desktop/package.json'), 'utf8')).version;
  const results = [];
  const add = (ok, label, detail) => results.push({ ok, label, ...(detail ? { detail } : {}) });

  // 多个会话共用这一棵工作树：不干净就说不清 dist/ 里打进去的是谁的在制品
  add(git('status', '--porcelain') === '', '工作树干净', '有未提交的改动');
  const tags = git('tag', '--points-at', 'HEAD').split('\n');
  add(
    tags.includes(`v${version}`),
    `HEAD 打了 v${version} 的 tag`,
    `HEAD 上的 tag：${tags.join(' ') || '无'}`,
  );

  const manifestPath = join(distDir, MANIFEST_NAME);
  let manifest;
  if (!existsSync(manifestPath)) {
    add(false, `${MANIFEST_NAME} 存在`, `${distDir} 下没有，先跑 pnpm run package`);
  } else {
    const raw = readFileSync(manifestPath);
    const parsed = parseUpdateManifest(raw.toString('utf8'));
    if (!parsed.ok) add(false, '清单的格式客户端认得', parsed.reason);
    else manifest = { ...parsed.manifest, raw };
  }
  if (manifest) {
    add(
      manifest.version === version,
      '清单版本与 package.json 一致',
      `清单 ${manifest.version} · package.json ${version}`,
    );
    const fileProblems = checkReleaseFiles(distDir, manifest);
    add(
      fileProblems.length === 0,
      '清单里的每个文件都在，大小与 sha512 对得上',
      fileProblems.join('；'),
    );
  }

  const fixtures = join(REPO, 'apps/desktop/test/fixtures/upgrade');
  const hasFixture = readdirSync(fixtures).some((name) => {
    const meta = join(fixtures, name, 'FIXTURE.json');
    return existsSync(meta) && JSON.parse(readFileSync(meta, 'utf8')).appVersion === version;
  });
  add(
    hasFixture,
    `有 ${version} 的升级兼容夹具`,
    `node scripts/build-upgrade-fixture.mjs WORKTREE v${version}`,
  );

  const keys = await loadClientModule('apps/desktop/src/main/update-keys.ts');
  const keyProblems = checkSigningKeys(keys.UPDATE_PUBLIC_KEYS, kid);
  add(keyProblems.length === 0, '客户端内嵌的公钥够发这一版', keyProblems.join('；'));

  // 源码里有这把 key 不等于打出来的包里有：dist/ 可能是更早一次打包留下的
  const asar = join(distDir, 'mac-arm64/EvoWork.app/Contents/Resources/app.asar');
  const embedded = existsSync(asar) && readFileSync(asar).includes(Buffer.from(kid));
  add(
    embedded,
    `打包产物里嵌着 kid=${kid}`,
    existsSync(asar) ? '包是没带这把公钥的那次打出来的，重新打包' : `${asar} 不存在`,
  );

  const published = readPublishedManifest(dest, channel);
  if (manifest) {
    const parsedOnline = published ? parseUpdateManifest(published) : undefined;
    const online = parsedOnline?.ok ? parsedOnline.manifest.version : undefined;
    add(
      online === undefined || compareVersions(manifest.version, online) > 0,
      '比线上的版本新',
      `线上已经是 ${online}（客户端不降级，发了也没人收得到）`,
    );
  }
  return { results, manifest };
}

/* ───────────────────────────── 上传 ───────────────────────────── */

/** 按 `uploadPlan` 的顺序一批一批传。`dest` 是本地目录或 `user@host:/路径` */
export function uploadRelease(distDir, dest, channel, plan) {
  const target = isRemote(dest) ? `${dest.replace(/\/$/, '')}/${channel}` : join(dest, channel);
  if (isRemote(dest)) {
    const [host, base] = splitRemote(dest);
    execFileSync('ssh', [host, 'mkdir', '-p', `${base}/${channel}/signatures`], {
      stdio: 'inherit',
    });
  } else {
    mkdirSync(join(target, 'signatures'), { recursive: true });
  }
  for (const step of plan) {
    // 一批一条 rsync：rsync 先写临时文件再改名，每个文件单独看是原子的；批与批之间靠这里的顺序
    const subdir = step.phase === 'signature' ? '/signatures/' : '/';
    const sources = step.files.map((f) => join(distDir, f));
    // -rlt 而不是 -a：不带本机的属主与权限过去（-a 会在服务器上留下发版机的 uid 501），
    // 远端以 ssh 登录的用户身份按它自己的 umask 落盘
    execFileSync('rsync', ['-rlt', ...sources, `${target}${subdir}`], { stdio: 'inherit' });
    console.log(`  ✓ ${step.phase}：${step.files.join(' · ')}`);
  }
}

/* ───────────────────────────── CLI ───────────────────────────── */

function option(args, name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

async function main(argv) {
  const dest = option(argv, '--dest');
  const kid = option(argv, '--kid');
  const channel = option(argv, '--channel') ?? 'latest';
  const keyFile = option(argv, '--key-file');
  const dryRun = argv.includes('--dry-run');
  if (!dest || !kid)
    throw new Error(
      '用法：publish-release.mjs --dest <目录|user@host:/路径> --kid <kid> [--dry-run]',
    );
  const distDir = join(REPO, 'dist/release');

  console.log(`发布前检查（channel=${channel} → ${dest}）`);
  const { results, manifest } = await checkRelease({ distDir, kid, dest, channel });
  for (const r of results)
    console.log(`  ${r.ok ? '✅' : '❌'} ${r.label}${r.ok || !r.detail ? '' : `：${r.detail}`}`);
  if (results.some((r) => !r.ok)) throw new Error('有检查没过，一个文件都没传');

  console.log('提醒：verify-packaged-app.mjs 会真的启动应用，这里不替你跑 —— 发版前确认它是绿的。');
  const plan = uploadPlan(manifest, readdirSync(distDir));
  if (dryRun) {
    for (const step of plan) console.log(`  · ${step.phase}：${step.files.join(' · ')}`);
    console.log('--dry-run：没有签名、没有上传。');
    return;
  }

  const sigDir = join(distDir, 'signatures');
  mkdirSync(sigDir, { recursive: true });
  writeFileSync(
    join(sigDir, signatureNameFor(manifest.raw)),
    signManifest(manifest.raw, { privateKeyPem: readPrivateKey({ kid, keyFile }), kid }),
  );
  uploadRelease(distDir, dest, channel, plan);
  console.log(`✅ ${manifest.version} 已发布到 ${dest}/${channel}/`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(`❌ ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
