#!/usr/bin/env node
/** Native acceptance prerequisites only. Never grants TCC, signs code or opens application content. */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const root = fileURLToPath(new URL('..', import.meta.url));
const targets = [
  ['wechat', 'com.tencent.xinWeChat', '/Applications/WeChat.app'],
  ['textedit', 'com.apple.TextEdit', '/System/Applications/TextEdit.app'],
  ['wps', 'com.kingsoft.wpsoffice.mac', '/Applications/wpsoffice.app'],
  ['word', 'com.microsoft.Word', '/Applications/Microsoft Word.app'],
  ['excel', 'com.microsoft.Excel', '/Applications/Microsoft Excel.app'],
  ['powerpoint', 'com.microsoft.Powerpoint', '/Applications/Microsoft PowerPoint.app'],
];

function command(file, args) {
  return spawnSync(file, args, { encoding: 'utf8', timeout: 30_000 });
}
function plist(app, key) {
  const result = command('/usr/bin/plutil', [
    '-extract',
    key,
    'raw',
    '-o',
    '-',
    join(app, 'Contents/Info.plist'),
  ]);
  return result.status === 0 ? result.stdout.trim() : undefined;
}
function signature(app) {
  if (!existsSync(app)) return { path: app, installed: false, trusted: false };
  const result = command('/usr/bin/codesign', ['-dv', '--verbose=4', app]);
  const description = result.stderr ?? '';
  const identifier = /^Identifier=(.+)$/m.exec(description)?.[1];
  const team = /^TeamIdentifier=([A-Z0-9]{10})$/m.exec(description)?.[1];
  const verified = command('/usr/bin/codesign', [
    '--verify',
    '--deep',
    '--strict',
    '-R',
    '=anchor apple generic',
    app,
  ]);
  return {
    path: app,
    installed: true,
    identifier,
    team,
    trusted: verified.status === 0,
    version: plist(app, 'CFBundleShortVersionString'),
  };
}

export function decodeProbeFrame(output) {
  if (output.length < 4 || output.length > 16 * 1024 * 1024 + 4)
    throw new Error('Invalid Helper frame size');
  if (output.readUInt32BE(0) !== output.length - 4) throw new Error('Invalid Helper frame length');
  const response = JSON.parse(output.subarray(4).toString('utf8'));
  if (!response || typeof response !== 'object' || typeof response.ok !== 'boolean')
    throw new Error('Invalid Helper result');
  return response;
}

function probe(executable, version, method, params = {}) {
  const body = Buffer.from(JSON.stringify({ method, params }));
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length);
  const result = spawnSync(executable, [], {
    input: Buffer.concat([header, body]),
    env: { EVOWORK_CUA_BUILD_VERSION: version },
    timeout: 10_000,
    maxBuffer: 16 * 1024 * 1024 + 4,
  });
  if (result.error || result.status !== 0) throw new Error('Helper probe did not exit normally');
  return decodeProbeFrame(result.stdout);
}

/** Ready means prerequisites only; the real AX/action/TCC matrix must still be executed. */
export function evaluateNativePreflight(report) {
  const failures = [];
  const blockers = [];
  const health = report.health;
  if (
    health?.protocolVersion !== 1 ||
    health.buildVersion !== report.buildVersion ||
    typeof health.accessibility !== 'boolean' ||
    typeof health.screenRecording !== 'boolean'
  )
    failures.push('HELPER_HEALTH_INVALID');
  if (
    !report.untrustedReads?.length ||
    report.untrustedReads.some((read) => read.ok !== false || read.code !== 'POLICY_DENIED')
  )
    failures.push('UNTRUSTED_CALLER_NOT_DENIED');
  if (!(report.signingIdentityCount > 0)) blockers.push('NO_CODE_SIGNING_IDENTITY');
  if (
    !report.host?.trusted ||
    report.host.identifier !== 'com.evowork.desktop' ||
    !report.host.team
  )
    blockers.push('SIGNED_DESKTOP_HOST_REQUIRED');
  if (
    !report.helper?.trusted ||
    report.helper.identifier !== 'com.evowork.desktop.computer-use' ||
    !report.helper.team
  )
    blockers.push('SIGNED_NATIVE_HELPER_REQUIRED');
  if (report.host?.team && report.helper?.team && report.host.team !== report.helper.team)
    blockers.push('HOST_HELPER_TEAM_MISMATCH');
  if (health?.accessibility !== true) blockers.push('ACCESSIBILITY_TCC_REQUIRED');
  if (health?.screenRecording !== true) blockers.push('SCREEN_RECORDING_TCC_REQUIRED');
  for (const name of ['wechat', 'textedit'])
    if (
      !report.apps?.some(
        (app) =>
          app.name === name &&
          app.installed &&
          app.trusted &&
          app.identifier === app.expectedIdentifier,
      )
    )
      blockers.push(`TARGET_APP_UNVERIFIED:${name}`);
  if (
    !report.apps?.some(
      (app) =>
        ['wps', 'word', 'excel', 'powerpoint'].includes(app.name) &&
        app.installed &&
        app.trusted &&
        app.identifier === app.expectedIdentifier,
    )
  )
    blockers.push('OFFICE_APP_UNVERIFIED');
  return {
    status: failures.length ? 'failed' : blockers.length ? 'blocked' : 'ready',
    failures,
    blockers,
    nativeAcceptanceCompleted: false,
    publicationGateChanged: false,
  };
}

export function runNativePreflight({ hostApp, helperApp }) {
  const release = JSON.parse(
    readFileSync(join(helperApp, 'Contents/Resources/release.json'), 'utf8'),
  );
  const executable = join(helperApp, 'Contents/MacOS/EvoWorkComputerUse');
  const identities = command('/usr/bin/security', ['find-identity', '-v', '-p', 'codesigning']);
  if (identities.status !== 0) throw new Error('Unable to inspect code signing identities');
  const identityCount = /([0-9]+) valid identities found/.exec(identities.stdout)?.[1];
  if (identityCount === undefined) throw new Error('Unable to parse code signing identity count');
  const apps = targets.map(([name, expectedIdentifier, path]) => ({
    name,
    expectedIdentifier,
    ...signature(path),
  }));
  const health = probe(executable, release.buildVersion, 'health');
  const untrustedReads = apps
    .filter((app) => app.installed)
    .map((app) => {
      const result = probe(executable, release.buildVersion, 'get_app_state', {
        app: app.expectedIdentifier,
      });
      // Even an unexpected successful response must never copy AX text or screenshot content to this report.
      return { app: app.expectedIdentifier, ok: result.ok, code: result.code };
    });
  const report = {
    at: new Date().toISOString(),
    platform: `${process.platform}-${process.arch}`,
    buildVersion: release.buildVersion,
    releaseVerified: release.releaseVerified,
    helperSha256: createHash('sha256').update(readFileSync(executable)).digest('hex'),
    signingIdentityCount: Number(identityCount),
    host: signature(hostApp),
    helper: signature(helperApp),
    health: health.ok ? health.value : undefined,
    apps,
    untrustedReads,
    appContentRead: untrustedReads.some((read) => read.ok),
    tccChanged: false,
  };
  return { ...report, ...evaluateNativePreflight(report) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.platform !== 'darwin') throw new Error('Native preflight requires macOS');
  const { values } = parseArgs({
    options: {
      'host-app': { type: 'string', default: join(root, 'dist/release/mac-arm64/EvoWork.app') },
      'helper-app': {
        type: 'string',
        default: join(root, 'build/computer-use/EvoWork Computer Use.app'),
      },
      output: { type: 'string', default: join(root, 'dist/cu-native-validation/preflight.json') },
    },
  });
  const result = runNativePreflight({
    hostApp: resolve(values['host-app']),
    helperApp: resolve(values['helper-app']),
  });
  mkdirSync(dirname(resolve(values.output)), { recursive: true });
  writeFileSync(resolve(values.output), JSON.stringify(result, null, 2) + '\n');
  console.log(
    JSON.stringify(
      {
        status: result.status,
        failures: result.failures,
        blockers: result.blockers,
        nativeAcceptanceCompleted: false,
        output: resolve(values.output),
      },
      null,
      2,
    ),
  );
  process.exitCode = result.status === 'failed' ? 1 : result.status === 'blocked' ? 2 : 0;
}
