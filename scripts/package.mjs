#!/usr/bin/env node
/**
 * M9 打包驱动：把 `scripts/package-plan.mjs` 的四条规则接到真正的 electron-builder 上。
 *
 * 那个文件里的 `planSigning` / `checkTierPlacement` / `checkSizeBudget` / `artifactName`
 * 写完之后**一个调用方都没有**——有测试、有断言、但打包时不生效。这个脚本就是调用方。
 * 直接 `electron-builder --mac dmg` 也能出包，区别在于那样出的包：
 *
 *   · 缺证书时静默产出一个**名字看起来像正式包**的未签名 dmg（U4 明确要求标注进文件名）；
 *   · 体积超预算、或者办公运行时混进基础包（08 §4），都要等用户下载时才发现（R10）。
 *
 * 用法：
 *   node scripts/package.mjs              # 当前平台当前架构
 *   node scripts/package.mjs --arch x64   # 交叉架构（macOS 上可出 x64 包）
 *   node scripts/package.mjs --dry-run    # 只跑前置检查，不真打包
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { artifactName, checkSizeBudget, checkTierPlacement, planSigning } from './package-plan.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/*
 * electron-builder 的 `${os}` 展开的是 `Platform.buildConfigurationKey`
 * （app-builder-lib/out/core.js：MAC = ("mac","mac","darwin")），**不是** node 的
 * `process.platform`。`build/kernel/<os>-<arch>/` 的目录名必须照它来，否则
 * extraResources 会静默拷贝一个空目录 —— 应用装上了，一启动找不到内核。
 */
const OS_KEY = { darwin: 'mac', win32: 'win', linux: 'linux' }[process.platform];
if (!OS_KEY) {
  console.error(`不支持的平台：${process.platform}`);
  process.exit(1);
}

const argv = process.argv.slice(2);
const arch = argv.includes('--arch') ? argv[argv.indexOf('--arch') + 1] : process.arch;
const dryRun = argv.includes('--dry-run');

/** 每个平台的默认目标。与 build/electron-builder.yml 的 target 列表一致。 */
const TARGETS = { mac: ['dmg', 'zip'], win: ['nsis'], linux: ['AppImage', 'deb'] }[OS_KEY];

const problems = [];

// ── 前置检查 ①：产品侧构建产物 ─────────────────────────────────────────────
/*
 * electron-builder 对着一个空的 dist 目录会**成功**产出一个打不开的应用。
 * 四个入口缺任何一个的表现都是"装上了，白屏或秒退"，而那时已经离构建很远了。
 */
const REQUIRED_ARTIFACTS = [
  'apps/desktop/dist/main/electron-entry.mjs',
  'apps/desktop/dist/main/bootstrap.bundle.js',
  'apps/desktop/dist/preload/index.bundle.cjs',
  'apps/desktop/dist/renderer/index.html',
  'plugins/hooks/evowork-policy/vendor/policy.mjs',
];
for (const rel of REQUIRED_ARTIFACTS) {
  if (!existsSync(join(ROOT, rel))) problems.push(`缺产物 ${rel} —— 先跑 pnpm run build`);
}

// ── 前置检查 ②：内核二进制 ────────────────────────────────────────────────
const kernelDir = join(ROOT, 'build/kernel', `${OS_KEY}-${arch}`);
const kernelBin = join(kernelDir, OS_KEY === 'win' ? 'codex-app-server.exe' : 'codex-app-server');
if (!existsSync(kernelBin)) {
  problems.push(
    `缺内核二进制 ${relative(ROOT, kernelBin)} —— ` +
      `(cd ../codex/codex-rs && cargo build -p codex-app-server --release) 后拷进去`,
  );
} else if (OS_KEY !== 'win' && !(statSync(kernelBin).mode & 0o111)) {
  // 拷贝丢执行位这件事只在用户双击应用时才表现出来
  problems.push(`${relative(ROOT, kernelBin)} 没有执行位 —— chmod +x`);
}

if (problems.length > 0) {
  console.error('打包前置条件不满足：');
  for (const p of problems) console.error(`  · ${p}`);
  process.exit(1);
}

// ── 签名计划（U4）────────────────────────────────────────────────────────
const signing = planSigning(process.env, OS_KEY);
if (signing.sign) {
  console.log(`签名：启用${signing.notarize ? '（含公证）' : ''}`);
} else {
  console.warn(`⚠ ${signing.message}`);
}

/*
 * 把 package-plan 的命名函数直接当 electron-builder 的 pattern 用 ——
 * 传入宏占位符而不是具体值，产物名的唯一定义处就还是那一个函数。
 */
const pattern = artifactName(
  '${productName}',
  '${version}',
  '${os}',
  '${arch}',
  '${ext}',
  signing.suffix,
);

const args = [
  `--${OS_KEY}`,
  ...TARGETS,
  `--${arch}`,
  '--config',
  'build/electron-builder.yml',
  `--config.artifactName=${pattern}`,
];
if (!signing.sign) {
  // 不是"跳过签名"，是**明确关掉自动发现**：否则 electron-builder 会摸到钥匙串里
  // 任意一张证书然后签出一个我们没打算签的包
  args.push('--config.mac.identity=null');
}

console.log(`\n$ electron-builder ${args.join(' ')}`);
if (dryRun) {
  console.log('（--dry-run：前置检查通过，未执行打包）');
  process.exit(0);
}
execFileSync(join(ROOT, 'node_modules/.bin/electron-builder'), args, {
  cwd: ROOT,
  stdio: 'inherit',
  env: signing.sign ? process.env : { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' },
});

// ── 事后预算（R10）───────────────────────────────────────────────────────
const outDir = join(ROOT, 'dist/release');
const appDir = join(outDir, arch === 'x64' ? 'mac' : `mac-${arch}`, 'EvoWork.app');

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

/*
 * 档位检查看的是**文件名**，所以对着解压后的 .app 跑：办公库混进来时它长的样子是
 * `Resources/.../site-packages/openpyxl/...`，在 dmg 里看不见。
 */
if (OS_KEY === 'mac' && existsSync(appDir)) {
  const tier = checkTierPlacement(walk(appDir).map((f) => relative(appDir, f)));
  console.log(`\n档位检查：${tier.message}`);
  if (!tier.ok) process.exitCode = 1;
}

/*
 * 体积预算量的是**安装包**，不是解压后的 .app。
 *
 * 口径来自 R10 与 08 §4 的原话（「首次下载 300MB+ 挡在体验前面」「安装包 +100–300MB」）——
 * 约束的是用户下载多少。解压后的 .app 一定更大：Electron 的 framework 单独就 250MB 上下，
 * 拿它去比 220MB 会永远红，而那个红不指向任何可以做的事。
 */
const installers = readdirSync(outDir).filter((f) => /\.(dmg|exe|AppImage|deb)$/.test(f));
for (const f of installers) {
  const budget = checkSizeBudget('base', statSync(join(outDir, f)).size);
  console.log(`体积预算（${f}）：${budget.message}`);
  if (!budget.ok) process.exitCode = 1;
}

console.log('\n产物：');
for (const f of readdirSync(outDir)) {
  if (/\.(dmg|zip|exe|AppImage|deb)$/.test(f)) {
    console.log(
      `   dist/release/${f}  ${(statSync(join(outDir, f)).size / 1024 / 1024).toFixed(1)}MB`,
    );
  }
}
