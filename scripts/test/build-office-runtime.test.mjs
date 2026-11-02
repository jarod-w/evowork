import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { beforeAll, describe, expect, it } from 'vitest';

import {
  buildOfficeRuntime,
  relocatePythonLaunchers,
  verifyPrebuiltRuntime,
} from '../build-office-runtime.mjs';

describe('完整办公运行时构建', () => {
  let posixShell;
  beforeAll(() => {
    if (process.platform !== 'win32') return;
    // Discover and initialize the foreign shell as fixture setup. The test's
    // original 5 s budget covers relocation and execution, not Git discovery.
    posixShell = resolve(
      execFileSync('git', ['--exec-path'], { encoding: 'utf8' }).trim(),
      '../../../bin/bash.exe',
    );
    execFileSync(posixShell, ['--noprofile', '--norc', '-c', ':']);
  });
  it('拒绝用本机架构构造未经执行验证的另一架构成品', async () => {
    await expect(
      buildOfficeRuntime({ arch: process.arch === 'arm64' ? 'x64' : 'arm64' }),
    ).rejects.toThrow('目标架构');
  });

  it('缺成品时打包前拒绝，不尝试重新下载依赖', async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'evowork-missing-office-'));
    try {
      await expect(verifyPrebuiltRuntime(join(scratch, 'absent'))).rejects.toThrow('重新安装');
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });

  it('搬迁后 console script 仍使用同目录解释器，路径有空格也可用', async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'evowork-launcher-'));
    try {
      const old = join(scratch, 'build staging');
      await mkdir(join(old, 'bin'), { recursive: true });
      const interpreter = join(old, 'bin/python3');
      await writeFile(interpreter, '#!/bin/sh\nprintf "%s\\n" "$0"\n');
      await chmod(interpreter, 0o755);
      const script = join(old, 'bin/fonttools');
      await writeFile(script, '#!/gone/build-machine/python3\nprint("hello")\n');
      await chmod(script, 0o755);
      await relocatePythonLaunchers(old);
      const moved = join(scratch, 'app resources');
      await rename(old, moved);
      const launcher = join(moved, 'bin/fonttools');
      // This tests the shipped POSIX launcher. Windows cannot execute a shebang;
      // use the Bash distributed with Git, which the repository checks require.
      const output =
        process.platform === 'win32'
          ? execFileSync(posixShell, ['--noprofile', '--norc', launcher.replaceAll('\\', '/')], {
              encoding: 'utf8',
            })
          : execFileSync(launcher, { encoding: 'utf8' });
      expect(output.trim().replaceAll('\\', '/')).toBe(
        join(moved, 'bin/python3').replaceAll('\\', '/'),
      );
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });
});
