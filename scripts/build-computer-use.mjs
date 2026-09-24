#!/usr/bin/env node
/** macOS Helper 装配；只用系统 SDK，不下载执行组件。产物默认不可启用。 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, copyFileSync, writeFileSync, readFileSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
if (process.platform !== 'darwin') throw new Error('Helper 必须在 macOS 14.4+ / Xcode SDK 上构建');
const version = JSON.parse(readFileSync(join(root, 'apps/desktop/package.json'), 'utf8')).version;
const source = join(root, 'apps/computer-use-macos');
execFileSync(
  'swift',
  ['build', '-c', 'release', '--product', 'EvoWorkComputerUse', '--package-path', source],
  { stdio: 'inherit' },
);
const bin = execFileSync(
  'swift',
  ['build', '-c', 'release', '--package-path', source, '--show-bin-path'],
  { encoding: 'utf8' },
).trim();
const app = join(root, 'build/computer-use/EvoWork Computer Use.app');
mkdirSync(join(app, 'Contents/MacOS'), { recursive: true });
mkdirSync(join(app, 'Contents/Resources'), { recursive: true });
copyFileSync(join(bin, 'EvoWorkComputerUse'), join(app, 'Contents/MacOS/EvoWorkComputerUse'));
if (statSync(join(app, 'Contents/MacOS/EvoWorkComputerUse')).size > 20 * 1024 * 1024)
  throw new Error('Helper 超过 20 MiB 预算');
writeFileSync(
  join(app, 'Contents/Info.plist'),
  `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>com.evowork.desktop.computer-use</string>
<key>CFBundleExecutable</key><string>EvoWorkComputerUse</string>
<key>CFBundleName</key><string>EvoWork Computer Use</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>${version}</string>
<key>CFBundleVersion</key><string>${version}</string>
<key>LSMinimumSystemVersion</key><string>14.4</string>
<key>LSUIElement</key><true/>
</dict></plist>\n`,
);
writeFileSync(
  join(app, 'Contents/Resources/release.json'),
  JSON.stringify({ protocolVersion: 1, buildVersion: version, releaseVerified: false }) + '\n',
);
console.log('Helper 已装配，releaseVerified=false；尚未签名、公证或通过原生验收。');
