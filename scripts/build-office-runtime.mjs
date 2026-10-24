#!/usr/bin/env node
/**
 * 构建已安装全部依赖的办公运行时；下载与 pip 只发生在构建机器。
 * node scripts/build-office-runtime.mjs [--bundle <旧式离线包>] [--from-runtime <完整目录>]
 * 每个目标平台/架构须在可执行该解释器的构建机上单独运行。
 */
import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { build } from 'esbuild';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const officeOsKey = (platform) =>
  ({ darwin: 'mac', win32: 'win', linux: 'linux' })[platform];

/** 无需先跑 tsc；生产安装器和构建共用清单、字体处理与验收。 */
export async function withRuntimeInstaller(callback) {
  const scratch = await mkdtemp(join(tmpdir(), 'evowork-runtime-api-'));
  try {
    const outfile = join(scratch, 'installer.mjs');
    await build({
      entryPoints: [join(ROOT, 'services/runtime-installer/src/install.ts')],
      outfile,
      bundle: true,
      platform: 'node',
      format: 'esm',
    });
    return await callback(await import(pathToFileURL(outfile).href));
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

export async function verifyPrebuiltRuntime(
  root,
  platformKey = `${process.arch}-${process.platform}`,
) {
  return withRuntimeInstaller(async (api) => {
    const problem = await api.prebuiltRuntimeProblem(root, platformKey);
    if (problem) throw new Error(problem);
    const result = await api.verifyOfficeRuntime(root, platformKey);
    if (!result.ok) throw new Error(result.message);
  });
}

/** pip 生成的 console script 会写构建目录的绝对 shebang，改为同目录解释器。 */
export async function relocatePythonLaunchers(root) {
  const bin = join(root, 'bin');
  if (!existsSync(bin)) return;
  const launcher = `#!/bin/sh\n'''exec' "$(dirname -- "$0")/python3" "$0" "$@"\n' '''\n`;
  for (const entry of await readdir(bin, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const file = join(bin, entry.name);
    const bytes = await readFile(file);
    if (bytes[0] !== 35 || bytes[1] !== 33) continue;
    const text = bytes.toString('utf8');
    const absolutePython = /^#![^\n]*python[^\n]*\n/;
    const standaloneLauncher = /^#!\/bin\/sh\n'''exec'[^\n]*python[^\n]*\n' '''\n/;
    const header = absolutePython.test(text) ? absolutePython : standaloneLauncher;
    if (header.test(text)) await writeFile(file, text.replace(header, launcher));
  }
}

export async function buildOfficeRuntime({ bundleDir, fromRuntime, arch = process.arch } = {}) {
  if (arch !== process.arch) {
    throw new Error('完整运行时必须在目标架构构建并执行验收；请在对应架构的 Node/CI 上构建。');
  }
  const os = officeOsKey(process.platform);
  if (!os) throw new Error(`不支持的平台：${process.platform}`);
  const platformKey = `${arch}-${process.platform}`;
  const out = join(ROOT, 'build/office', `${os}-${arch}`, 'runtime');
  await mkdir(dirname(out), { recursive: true });
  const scratch = await mkdtemp(join(dirname(out), 'runtime-build-'));
  const prepared = join(scratch, 'prepared');
  try {
    await withRuntimeInstaller(async (api) => {
      if (fromRuntime) {
        // 来源必须是安装器生成、与当前清单相符的完整运行时；仍需搬迁后实际验收。
        await cp(resolve(fromRuntime), prepared, { recursive: true, verbatimSymlinks: true });
      } else {
        const result = await api.installOfficeRuntime({
          home: scratch,
          ...(bundleDir ? { bundleDir: resolve(bundleDir) } : {}),
          bundledFontPath: join(ROOT, 'build/office/NotoSansSC.ttf'),
          onProgress: (p) =>
            console.log(`${p.percent}% ${api.PHASE_LABEL[p.phase]} ${p.detail ?? ''}`),
        });
        if (!result.ok) throw new Error(result.message);
        await rename(api.officeRoot(scratch), prepared);
      }
      await writeFile(
        join(prepared, api.RUNTIME_BUNDLE_FILE),
        api.runtimeBundleMetadata(platformKey),
      );
      const problem = await api.prebuiltRuntimeProblem(prepared, platformKey);
      if (problem) throw new Error(problem);
      const verified = await api.verifyOfficeRuntime(prepared, platformKey);
      if (!verified.ok) throw new Error(verified.message);
    });
    // 生成依赖版本清单，记录全部传递依赖；无需在用户机器调用 pip。
    const python = join(prepared, process.platform === 'win32' ? 'python.exe' : 'bin/python3');
    execFileSync(python, ['-I', '-m', 'pip', 'check'], { stdio: 'inherit', timeout: 120_000 });
    const inventory = execFileSync(
      python,
      [
        '-c',
        'import json; from importlib.metadata import distributions; print(json.dumps(sorted([{"name": d.metadata["Name"], "version": d.version} for d in distributions()], key=lambda d:d["name"].lower()), indent=2))',
      ],
      { encoding: 'utf8', timeout: 120_000 },
    );
    await writeFile(join(prepared, 'installed-packages.json'), inventory);
    // 保存旧成品以便最终路径搬迁验收失败时恢复。
    const old = join(scratch, 'previous');
    if (existsSync(out)) await rename(out, old);
    try {
      await rename(prepared, out);
      await verifyPrebuiltRuntime(out, platformKey);
    } catch (error) {
      await rm(out, { recursive: true, force: true });
      if (existsSync(old)) await rename(old, out);
      throw error;
    }
    console.log(`完整办公运行时：${out}`);
    return out;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const value = (flag) => {
    const at = args.indexOf(flag);
    if (at < 0) return undefined;
    if (!args[at + 1] || args[at + 1].startsWith('--')) throw new Error(`${flag} 缺少参数`);
    return args[at + 1];
  };
  await buildOfficeRuntime({
    bundleDir: value('--bundle'),
    fromRuntime: value('--from-runtime'),
    arch: value('--arch'),
  });
}
