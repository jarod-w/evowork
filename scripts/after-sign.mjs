/** Authenticode 改变二进制字节；保留签名前哈希，同时登记最终随包哈希。 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { kernelBinaryNames } from './package-plan.mjs';

export function recordSignedWindowsKernel(directory) {
  const file = join(directory, 'KERNEL_PROVENANCE.json');
  const provenance = JSON.parse(readFileSync(file, 'utf8'));
  // afterPack 对构建源的补丁与所有组件逐一核对，并确认来源清单原样复制。
  const unsignedBinaries = provenance.unsignedBinaries ?? provenance.binaries;
  const binaries = Object.fromEntries(
    kernelBinaryNames('win32').map((name) => {
      if (!unsignedBinaries?.[name]) throw new Error(`缺少签名前内核来源：${name}`);
      return [
        name,
        createHash('sha256')
          .update(readFileSync(join(directory, name)))
          .digest('hex'),
      ];
    }),
  );
  writeFileSync(
    file,
    JSON.stringify(
      { ...provenance, unsignedBinaries, binaries, binarySha256: binaries['codex-app-server.exe'] },
      null,
      2,
    ) + '\n',
  );
}

export default async function afterSign(context) {
  if (context.electronPlatformName === 'win32')
    recordSignedWindowsKernel(join(context.appOutDir, 'resources/kernel'));
}
