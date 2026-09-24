/**
 * 未签名 macOS 包的 ad-hoc 重签。
 *
 * `mac.identity=null` 不会把签名「拿掉」，只会跳过 electron-builder 自己签。
 * Electron 官方 zip 里的主二进制带着 linker-signed ad-hoc 残签，
 * `spctl` 报 `code has no resources but signature indicates they must be present`。
 * 另一台 Mac 再叠上 Chrome 的隔离标记，系统文案就是「已损坏，无法打开」——
 * 不是文件坏了。U4 没有 Developer ID 之前，正式公证做不了；这一步只把残签补成
 * 完整的 ad-hoc bundle 签名，对方机器仍要清隔离标记才能双击。
 */
import { execFileSync } from 'node:child_process';

/** codesign 参数。`--force --deep -s -` 从内往外盖掉残签，含 Helper 与 extraResources 里的 .app。 */
export function adhocSignArgs(appPath) {
  return ['--force', '--deep', '--sign', '-', appPath];
}

export function adhocSign(appPath, run = execFileSync) {
  run('codesign', adhocSignArgs(appPath), { stdio: 'inherit' });
}

/** electron-builder afterPack：只在未签名降级时动手。identity=null 与环境变量两路都认，避免 CLI 把 null 传成字符串。 */
export function shouldAdhocSign(platform, identity, autoDiscovery) {
  if (platform !== 'darwin') return false;
  if (identity === null || identity === 'null') return true;
  return autoDiscovery === 'false';
}
