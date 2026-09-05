#!/usr/bin/env node
/**
 * 构建产物装配（M9）。
 *
 * 三步，顺序是刻意的：
 *
 *   ① `tsc --build`   —— 产出所有包的 JS 与声明文件（含主进程、preload、服务层）
 *   ② vendor 策略包    —— 把 `@evowork/policy` 的产物放进 hook 插件目录
 *   ③ `vite build`    —— 渲染层打包（它 import 的是 TS 源码，不依赖 ①）
 *
 * ② 必须在 ① 之后：hook 运行器要找的是 `dist/index.js`。
 * ③ 与 ①② 无关，放最后只是为了让失败信息按层次出现。
 *
 * ## 为什么单独一个脚本而不是三条 npm script 串起来
 *
 * 因为 ② 不是一条命令 —— 它要检查源文件在不在、目标目录建没建，
 * 而"忘了跑 vendor"的表现是**策略在打包后的应用里静默失效**（hook 运行器会退回
 * 仓库路径，而打包产物里没有那个路径）。这种失败要在构建时就红，不能等到运行时。
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { HOOK_VENDOR } from './package-plan.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function run(command, args, cwd = ROOT) {
  console.log(`\n$ ${command} ${args.join(' ')}`);
  execFileSync(command, args, { cwd, stdio: 'inherit' });
}

console.log('① 编译 TypeScript（含声明文件）');
run('node', [join(ROOT, 'node_modules/typescript/bin/tsc'), '--build', 'tsconfig.build.json']);

console.log('\n② 复制 Electron 入口与 vendor 策略包');
/*
 * `electron-entry.mjs` 是 JS 不是 TS（见它的头注释：electron 依赖属 M9，
 * 写成 .ts 会让 typecheck 因为找不到模块而红），所以 tsc 不会把它带进 dist。
 * 漏了这一步的表现是打包出来的应用**没有入口** —— 而 electron-builder 不会告诉你为什么。
 */
const ENTRY = 'apps/desktop/src/main/electron-entry.mjs';
copyFileSync(join(ROOT, ENTRY), join(ROOT, 'apps/desktop/dist/main/electron-entry.mjs'));
console.log(`   ${ENTRY} → dist/main/`);

const from = join(ROOT, HOOK_VENDOR.from);
const to = join(ROOT, HOOK_VENDOR.to);
if (!existsSync(from)) {
  // 忘了这一步的表现是策略在打包后的应用里**静默失效**，所以这里必须响亮失败
  console.error(
    `找不到 ${HOOK_VENDOR.from}。策略包没有被编译 —— 检查 tsconfig.build.json 里有没有登记 services/policy。`,
  );
  process.exit(1);
}
mkdirSync(dirname(to), { recursive: true });
copyFileSync(from, to);
console.log(`   ${HOOK_VENDOR.from} → ${HOOK_VENDOR.to}（${statSync(to).size} 字节）`);

console.log('\n③ 打包可独立运行的入口（esbuild）');
/*
 * ## 为什么要打包，而不是直接跑 tsc 产出的 dist
 *
 * workspace 包的 `exports` 指向 **TS 源码**（`./src/index.ts`）——
 * 这让 vitest 与 tsc 都能直接吃到源码，是开发期正确的选择。
 * 但 `node services/gateway/dist/main.js` 会顺着同一个 exports 去加载 `.ts`，然后炸掉。
 *
 * 两条路：给每个包加条件 exports（dist 陈旧时测试会读到旧代码），或者把入口打成单文件。
 * 选后者，因为它顺带解决了部署侧的两个问题：
 *   · 网关变成一个文件 —— 不用把 pnpm 的 node_modules 结构搬到服务器上；
 *   · Electron 主进程不再依赖 workspace 链接 —— electron-builder 打包 pnpm workspace
 *     一直是个麻烦，打包之后它就只是一个普通文件。
 */
const BUNDLES = [
  { entry: 'services/gateway/src/main.ts', out: 'dist/gateway/main.js', platform: 'node' },
  {
    entry: 'apps/desktop/src/main/bootstrap.ts',
    out: 'apps/desktop/dist/main/bootstrap.bundle.js',
    platform: 'node',
  },
  {
    entry: 'apps/desktop/src/preload/index.ts',
    out: 'apps/desktop/dist/preload/index.bundle.js',
    platform: 'node',
  },
];
for (const bundle of BUNDLES) {
  run(join(ROOT, 'node_modules/.bin/esbuild'), [
    bundle.entry,
    '--bundle',
    `--outfile=${bundle.out}`,
    `--platform=${bundle.platform}`,
    '--format=esm',
    '--target=node22',
    /*
     * **只把 electron 排除在外**，workspace 包必须打进来 ——
     * 它们不是运行时能解析到的 npm 依赖，`--packages=external` 会让产物在服务器上
     * 找不到 `@evowork/logging`。node 内置模块由 `--platform=node` 自动外置。
     */
    '--external:electron',
    '--log-level=warning',
  ]);
  console.log(`   ${bundle.entry} → ${bundle.out}`);
}

console.log('\n④ 打包渲染层');
/*
 * 用 pnpm --filter 而不是直接跑 `node node_modules/vite/bin/vite.js`。
 *
 * pnpm 不做提升：vite 只装在 `apps/desktop/node_modules` 里，仓库根没有。
 * 写死根路径会在这里失败，而失败信息（"Command failed"）完全不解释原因 ——
 * 交给 pnpm 解析，它知道每个包各自的 bin 在哪。
 */
run('pnpm', ['--filter', '@evowork/desktop', 'run', 'build']);

console.log('\n✅ 构建完成。产物：');
console.log('   dist/gateway/main.js                             网关（单文件，可直接 node 运行）');
console.log('   apps/desktop/dist/renderer/                      渲染层（vite）');
console.log('   apps/desktop/dist/main/electron-entry.mjs        Electron 入口');
console.log('   apps/desktop/dist/main/bootstrap.bundle.js       主进程（单文件）');
console.log('   apps/desktop/dist/preload/index.bundle.js        preload（单文件）');
console.log('   plugins/hooks/evowork-policy/vendor/policy.mjs   策略包');
