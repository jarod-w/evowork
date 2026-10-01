/**
 * 打包与 E2E 用的内核必须是 build-kernel 用**当前**补丁编出来的。没打补丁的内核照样能跑，
 * 所以这道检查是唯一能把它拦下的地方（K1：补丁只存在于 build-kernel 的产物里）。
 */
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { currentPatches, kernelProvenanceProblem } from '../kernel-provenance.mjs';

const sha256 = (text) => createHash('sha256').update(text).digest('hex');

let root;
let kernel;

function writeProvenance(fields) {
  writeFileSync(
    join(root, 'build/kernel/mac-arm64/KERNEL_PROVENANCE.json'),
    JSON.stringify({ codexCommit: 'abc', profile: 'release', ...fields }),
  );
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'kernel-provenance-'));
  mkdirSync(join(root, 'patches/evowork'), { recursive: true });
  mkdirSync(join(root, 'build/kernel/mac-arm64'), { recursive: true });
  writeFileSync(join(root, 'patches/evowork/0001-a.patch'), 'patch a');
  writeFileSync(join(root, 'patches/evowork/0001-a.md'), '说明不算补丁');
  kernel = join(root, 'build/kernel/mac-arm64/codex-app-server');
  writeFileSync(kernel, 'binary');
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('内核来源检查（K1 补丁只在 build-kernel 的产物里）', () => {
  it('补丁清单只认 .patch，按文件名排序 —— 与 build-kernel 打补丁的顺序一致', () => {
    writeFileSync(join(root, 'patches/evowork/0000-z.patch'), 'patch z');
    expect(currentPatches(root).map((p) => p.name)).toEqual(['0000-z.patch', '0001-a.patch']);
  });

  it('用当前补丁编的、没被换过的内核才放行', () => {
    writeProvenance({ patches: currentPatches(root), binarySha256: sha256('binary') });
    expect(kernelProvenanceProblem(kernel, root)).toBeNull();
  });

  it('没有来源文件的内核（直接编 ../codex 再拷过来的那种）不放行', () => {
    expect(kernelProvenanceProblem(kernel, root)).toMatch(/没有 KERNEL_PROVENANCE\.json/);
  });

  it('补丁改了没重编：拦下，并把编时与现在两份清单都说出来', () => {
    writeProvenance({ patches: currentPatches(root), binarySha256: sha256('binary') });
    writeFileSync(join(root, 'patches/evowork/0001-a.patch'), 'patch a v2');
    expect(kernelProvenanceProblem(kernel, root)).toMatch(
      /编时：0001-a\.patch@.*；现在：0001-a\.patch@/,
    );
  });

  it('新加了一个补丁没重编：同样拦下', () => {
    writeProvenance({ patches: currentPatches(root), binarySha256: sha256('binary') });
    writeFileSync(join(root, 'patches/evowork/0002-b.patch'), 'patch b');
    expect(kernelProvenanceProblem(kernel, root)).toMatch(/补丁与现在的 patches\/evowork\/ 不一致/);
  });

  it('来源文件对、二进制被换成别的：拦下 —— 来源文件跟着目录走，不跟着二进制走', () => {
    writeProvenance({ patches: currentPatches(root), binarySha256: sha256('binary') });
    writeFileSync(kernel, 'upstream binary copied over');
    expect(kernelProvenanceProblem(kernel, root)).toMatch(/被换过/);
  });
});
