import { join } from 'node:path';

import { adhocSign, shouldAdhocSign } from './adhoc-sign.mjs';
import { kernelProvenanceProblem } from './kernel-provenance.mjs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { recordSignedWindowsKernel } from './after-sign.mjs';

/** electron-builder `afterPack`：打 dmg 之前把未签名的 .app 补成完整 ad-hoc 签名。 */
export default async function afterPack(context) {
  if (context.electronPlatformName === 'win32') {
    const root = dirname(dirname(fileURLToPath(import.meta.url)));
    const source = join(root, 'build/kernel/win-x64');
    const packaged = join(context.appOutDir, 'resources/kernel');
    const problem = kernelProvenanceProblem(join(source, 'codex-app-server.exe'), root);
    if (problem) throw new Error(problem);
    if (
      !readFileSync(join(source, 'KERNEL_PROVENANCE.json')).equals(
        readFileSync(join(packaged, 'KERNEL_PROVENANCE.json')),
      )
    )
      throw new Error('随包 Windows 内核来源与本次构建不一致');
    // electron-builder 在复制 extraResources 时就会签名，不能拿签后字节比构建哈希。
    recordSignedWindowsKernel(packaged);
    return;
  }
  const identity = context.packager.platformSpecificBuildOptions.identity;
  if (!shouldAdhocSign(process.platform, identity, process.env.CSC_IDENTITY_AUTO_DISCOVERY)) {
    return;
  }
  const app = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  console.log(`ad-hoc 重签 ${app}（U4：无 Developer ID，不能公证）`);
  adhocSign(app);
}
