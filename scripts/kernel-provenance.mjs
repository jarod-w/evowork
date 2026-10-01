/**
 * 「这个内核二进制是不是用**现在的** `patches/evowork/` 编出来的」—— 打包前置检查与 E2E 夹具共用。
 *
 * 内核补丁（K1）只在 `scripts/build-kernel.mjs` 编出来的二进制里存在；直接编 `../codex`、
 * 拷一份旧的、或补丁改了没重编，得到的内核都**能正常跑**，只是少了那项修复 —— 打包会把它发出去，
 * E2E 会在一个不发货的内核上判红判绿（P6 的用例在没补丁的内核上会报"没有审批卡"，看上去像代码写错了）。
 * 所以判据是 build-kernel 写在二进制旁边的 `KERNEL_PROVENANCE.json`，三项都要对：
 * 文件在、二进制哈希与它记的一致（没被换过）、补丁清单与当前目录逐个同名同哈希。
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');

/** `patches/evowork/*.patch`，按文件名排序 —— build-kernel 打补丁的顺序。 */
export function currentPatches(root) {
  const dir = join(root, 'patches', 'evowork');
  return readdirSync(dir)
    .filter((name) => name.endsWith('.patch'))
    .sort()
    .map((name) => ({ name, sha256: sha256(join(dir, name)) }));
}

/** 有问题返回一句能照着做的说明，没问题返回 `null`。 */
export function kernelProvenanceProblem(kernelBin, root) {
  const rebuild = '用 node scripts/build-kernel.mjs 重编';
  const file = join(dirname(kernelBin), 'KERNEL_PROVENANCE.json');
  if (!existsSync(file)) {
    return `${kernelBin} 旁边没有 KERNEL_PROVENANCE.json，不知道它打没打内核补丁 —— ${rebuild}`;
  }
  const provenance = JSON.parse(readFileSync(file, 'utf8'));
  if (provenance.binarySha256 !== sha256(kernelBin)) {
    return `${kernelBin} 与 KERNEL_PROVENANCE.json 记的不是同一个二进制（被换过）—— ${rebuild}`;
  }
  const list = (patches) =>
    patches.map((p) => `${p.name}@${p.sha256.slice(0, 12)}`).join(', ') || '（无）';
  const built = list(provenance.patches ?? []);
  const now = list(currentPatches(root));
  if (built !== now) {
    return `${kernelBin} 编的时候的补丁与现在的 patches/evowork/ 不一致（编时：${built}；现在：${now}）—— ${rebuild}`;
  }
  return null;
}
