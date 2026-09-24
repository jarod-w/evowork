import { join } from 'node:path';

import { adhocSign, shouldAdhocSign } from './adhoc-sign.mjs';

/** electron-builder `afterPack`：打 dmg 之前把未签名的 .app 补成完整 ad-hoc 签名。 */
export default async function afterPack(context) {
  const identity = context.packager.platformSpecificBuildOptions.identity;
  if (!shouldAdhocSign(process.platform, identity, process.env.CSC_IDENTITY_AUTO_DISCOVERY)) {
    return;
  }
  const app = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  console.log(`ad-hoc 重签 ${app}（U4：无 Developer ID，不能公证）`);
  adhocSign(app);
}
