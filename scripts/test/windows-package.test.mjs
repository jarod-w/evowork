import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { kernelBinaryNames, packagedAppDirectory } from '../package-plan.mjs';
import { currentPatches } from '../kernel-provenance.mjs';
import { recordSignedWindowsKernel } from '../after-sign.mjs';
import { isWindowsX64Executable, windowsPackageProblems } from '../verify-windows-package.mjs';

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const pe = (machine = 0x8664) => {
  const bytes = Buffer.alloc(80);
  bytes.write('MZ');
  bytes.writeUInt32LE(64, 60);
  bytes.writeUInt32LE(0x4550, 64);
  bytes.writeUInt16LE(machine, 68);
  return bytes;
};
it('Windows 成品缺沙箱辅助程序、来源不匹配或错架构时拒绝', () => {
  const root = mkdtempSync(join(tmpdir(), 'evowork-win-package-'));
  roots.push(root);
  mkdirSync(join(root, 'patches/evowork'), { recursive: true });
  const app = packagedAppDirectory(root, 'win32', 'x64'),
    resources = join(app, 'resources');
  const write = (file, content) => {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  };
  const files = [
    'app.asar',
    'gateway/main.js',
    'config/config.toml.template',
    'plugins/hooks/evowork-policy/vendor/policy.mjs',
    'office/runtime/.evowork-bundle.json',
  ];
  for (const name of files) write(join(resources, name), 'fixture');
  write(join(app, 'EvoWork.exe'), pe());
  write(join(resources, 'office/runtime/python.exe'), pe());
  const binaries = kernelBinaryNames('win32');
  for (const name of binaries) write(join(resources, 'kernel', name), pe());
  write(
    join(resources, 'kernel/KERNEL_PROVENANCE.json'),
    JSON.stringify({
      patches: currentPatches(root),
      binarySha256: createHash('sha256').update(pe()).digest('hex'),
      binaries: Object.fromEntries(
        binaries.map((name) => [name, createHash('sha256').update(pe()).digest('hex')]),
      ),
    }),
  );
  expect(windowsPackageProblems(app, root)).toEqual([]);
  // 模拟签名给 PE 增加证书数据：最终哈希更新，同时不丢弃构建来源。
  write(
    join(resources, 'kernel/codex-app-server.exe'),
    Buffer.concat([pe(), Buffer.from('certificate')]),
  );
  expect(windowsPackageProblems(app, root).join()).toContain('被换过');
  recordSignedWindowsKernel(join(resources, 'kernel'));
  expect(windowsPackageProblems(app, root)).toEqual([]);
  rmSync(join(resources, 'kernel/codex-command-runner.exe'));
  expect(windowsPackageProblems(app, root).join()).toContain('codex-command-runner.exe');
  write(join(resources, 'kernel/codex-command-runner.exe'), pe(0xaa64));
  expect(isWindowsX64Executable(join(resources, 'kernel/codex-command-runner.exe'))).toBe(false);
  expect(windowsPackageProblems(app, root).join()).toContain('被换过');
});
