#!/usr/bin/env node
/** 只验证运行进程的签名和 App 元数据，不激活窗口、不读 AX、不请求 TCC。 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'darwin') throw new Error('应用身份探针仅支持 macOS');
const requestedApps = process.argv.slice(2);
if (requestedApps.some((id) => !/^[A-Za-z0-9]+(?:[.][A-Za-z0-9_-]+)+$/.test(id)))
  throw new Error('参数必须是已运行应用的 bundle id');
const root = fileURLToPath(new URL('..', import.meta.url));
const source = readFileSync(
  join(root, 'apps/computer-use-macos/Sources/EvoWorkComputerUse/HelperMain.swift'),
  'utf8',
);
const proof = source.match(/struct AppProof[\s\S]*?(?=\n\/\/ 私有继承)/)?.[0];
if (!proof) throw new Error('找不到生产签名验证函数');
const directory = mkdtempSync(join(tmpdir(), 'ew-cu-apps-'));
try {
  const main = join(directory, 'main.swift');
  writeFileSync(
    main,
    `import AppKit\nimport Security\n${proof}\n
var verified = 0, rejected = 0, finder = false
var kinds: [String: Int] = [:]
let requested = Set(CommandLine.arguments.dropFirst())
var requestedVerified = Set<String>()
var requestedStatuses = Dictionary(uniqueKeysWithValues: requested.map { ($0, "not-running") })
for app in NSWorkspace.shared.runningApplications where app.activationPolicy == .regular {
    if let id = app.bundleIdentifier, requested.contains(id) { requestedStatuses[id] = "identity-rejected" }
    if let result = proof(app) {
        verified += 1; kinds[result.kind, default: 0] += 1
        if app.bundleIdentifier == "com.apple.finder" { finder = result.kind == "ordinary" }
        if result.kind == "ordinary", let id = app.bundleIdentifier, requested.contains(id) { requestedVerified.insert(id) }
        if let id = app.bundleIdentifier, requested.contains(id) { requestedStatuses[id] = result.kind }
    } else { rejected += 1 }
}
precondition(finder, "Finder 的实际进程未通过生产签名准入函数")
var summary: [String: Any] = ["verified": verified, "rejected": rejected, "kinds": kinds, "finderVerified": finder]
if !requested.isEmpty { summary["requestedVerified"] = requestedVerified.count; summary["requestedStatuses"] = requestedStatuses }
print(String(data: try JSONSerialization.data(withJSONObject: summary, options: [.sortedKeys]), encoding: .utf8)!)
fflush(stdout)
if !requested.isSubset(of: requestedVerified) { fputs("指定应用未运行或未通过生产签名准入函数\\n", stderr); exit(1) }
`,
    { mode: 0o600 },
  );
  const executable = join(directory, 'identity-probe');
  execFileSync(
    'swiftc',
    [
      main,
      join(root, 'apps/computer-use-macos/Sources/EvoWorkComputerUsePolicy/AppPolicy.swift'),
      '-o',
      executable,
    ],
    { stdio: ['ignore', 'ignore', 'pipe'], timeout: 120000 },
  );
  process.stdout.write(
    execFileSync(executable, requestedApps, { timeout: 30000, encoding: 'utf8' }),
  );
} finally {
  rmSync(directory, { recursive: true, force: true });
}
