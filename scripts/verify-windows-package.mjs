#!/usr/bin/env node
/** Windows 成品结构与运行时检查。不能替代安装、UAC、DPAPI、GUI 与隔离真机验收。 */
import { execFileSync } from 'node:child_process';
import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { kernelBinaryNames } from './package-plan.mjs';
import { kernelProvenanceProblem } from './kernel-provenance.mjs';
import { verifyPrebuiltRuntime } from './build-office-runtime.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function isWindowsX64Executable(path) {
  let fd;
  try {
    fd = openSync(path, 'r');
    const header = Buffer.alloc(64);
    if (readSync(fd, header, 0, 64, 0) !== 64 || header.toString('ascii', 0, 2) !== 'MZ')
      return false;
    const offset = header.readUInt32LE(60);
    if (offset < 64 || offset > statSync(path).size - 6) return false;
    const pe = Buffer.alloc(6);
    return (
      readSync(fd, pe, 0, 6, offset) === 6 &&
      pe.readUInt32LE(0) === 0x4550 &&
      pe.readUInt16LE(4) === 0x8664
    );
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function windowsPackageProblems(appDir, root = ROOT) {
  const resources = join(appDir, 'resources');
  const problems = [];
  for (const name of [
    'app.asar',
    'gateway/main.js',
    'config/config.toml.template',
    'plugins/hooks/evowork-policy/vendor/policy.mjs',
    'office/runtime/.evowork-bundle.json',
  ]) {
    if (!existsSync(join(resources, name))) problems.push(`缺少随包资源 ${name}`);
  }
  for (const path of [
    join(appDir, 'EvoWork.exe'),
    join(resources, 'office/runtime/python.exe'),
    ...kernelBinaryNames('win32').map((name) => join(resources, 'kernel', name)),
  ]) {
    if (!isWindowsX64Executable(path)) problems.push(`不是 Windows x64 可执行文件：${path}`);
  }
  const kernel = join(resources, 'kernel/codex-app-server.exe');
  if (existsSync(kernel)) {
    try {
      const problem = kernelProvenanceProblem(kernel, root);
      if (problem) problems.push(problem);
    } catch {
      problems.push('Windows 内核来源文件损坏');
    }
  }
  return problems;
}

async function main(args) {
  const at = args.indexOf('--app-dir');
  const app = resolve(at < 0 ? join(ROOT, 'dist/release/win-unpacked') : args[at + 1]);
  const problems = windowsPackageProblems(app);
  if (problems.length) throw new Error(problems.join('\n'));
  if (!args.includes('--static')) {
    if (process.platform !== 'win32' || process.arch !== 'x64')
      throw new Error('运行验收需要 Windows x64；仅检查文件结构可加 --static');
    await verifyPrebuiltRuntime(join(app, 'resources/office/runtime'), 'x64-win32');
    const result = execFileSync(
      join(app, 'EvoWork.exe'),
      ['-e', 'require("node:sqlite"); process.stdout.write("ELECTRON_NODE_OK")'],
      {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        encoding: 'utf8',
        timeout: 30_000,
        windowsHide: true,
      },
    );
    if (!result.includes('ELECTRON_NODE_OK')) throw new Error('随包 Electron Node/SQLite 启动失败');
  }
  console.log(
    'Windows x64 成品检查通过；安装、GUI、安全边界与签名验收仍须逐项完成，见 docs/windows-x64.md。',
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
