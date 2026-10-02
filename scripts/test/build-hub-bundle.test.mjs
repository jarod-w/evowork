/**
 * 插件 Hub 的企业离线包（13 §4.7 ③）。整条链一起跑：
 * 在线源（本机 HTTP）→ 打包脚本 → 离线目录 → hub-client 只读目录 → 验签 / 校验。
 *
 * 断的是承诺本身：**签名照验**（包在内网被改过就装不上）、**一个字节都不出网**、
 * 白名单**只能减不能加**、没写许可的条目**不进包**。
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { generateEs256KeyPair } from '../../packages/account/src/jwt.js';
import {
  packTarGz,
  sha256Hex,
  signHubIndex,
  treeSha256,
} from '../../packages/hub-protocol/src/index.js';
import {
  BUNDLE_BASE_URL,
  createBundleFetch,
  downloadItem,
  readBundleManifest,
  refreshIndex,
} from '../../services/hub-client/src/index.js';
import { buildHubBundle } from '../build-hub-bundle.mjs';

const keys = generateEs256KeyPair();
const enc = new TextEncoder();
const NOW = 1_800_000_000;

let root;
let server;
let origin;
let files;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'ew-hub-bundle-'));
  files = new Map();
  server = createServer((req, res) => {
    const body = files.get(req.url ?? '');
    res.statusCode = body === undefined ? 404 : 200;
    res.end(body ?? '');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
});

afterEach(async () => {
  await new Promise((resolve) => server.close(() => resolve()));
  rmSync(root, { recursive: true, force: true });
});

function item(id, extra = {}) {
  const archive = packTarGz([
    { path: 'SKILL.md', bytes: enc.encode(`---\nname: ${id}\ndescription: d\n---\n`) },
  ]);
  const path = `pkgs/skill/${id}/1.0.0.tar.gz`;
  files.set(`/v1/evowork/${path}`, Buffer.from(archive));
  return {
    id,
    kind: 'skill',
    version: '1.0.0',
    package: { path, sha256: sha256Hex(archive), size: archive.length },
    defaultEnabled: true,
    promptVisible: true,
    interface: { displayName: id, description: 'd', category: '办公' },
    audit: { level: 'p0', rulesVersion: 'r', network: [], commands: [], hooks: false },
    license: { spdx: 'MIT' },
    ...extra,
  };
}

function publishOffline(items, name = 'index.offline.json') {
  const payload = {
    schemaVer: 1,
    source: { id: 'evowork', displayName: 'EvoWork 精选' },
    sequence: 9,
    issuedAt: NOW - 10,
    expiresAt: NOW + 180 * 24 * 3600,
    items,
    revoked: [],
  };
  files.set(`/v1/evowork/${name}`, JSON.stringify(signHubIndex(keys.privatePem, payload, 'k1')));
}

const source = {
  id: 'evowork',
  baseUrl: BUNDLE_BASE_URL,
  trustedKeys: [{ kid: 'k1', publicPem: keys.publicPem }],
};

function offlinePorts(dir) {
  const cache = new Map();
  return {
    fetch: createBundleFetch(dir),
    fs: {
      readText: (p) => cache.get(p),
      writeTextAtomic: (p, t) => cache.set(p, t),
    },
    cacheRoot: '/cache',
    now: () => NOW,
  };
}

describe('企业离线包（13 §4.7 ③）', () => {
  it('打出来的包离线可用：签名照验、内容照校，读的全是本机目录', async () => {
    const minutes = item('minutes');
    publishOffline([minutes]);
    const out = join(root, 'bundle');
    const manifest = await buildHubBundle({ origin, out, now: () => NOW, log: () => {} });
    expect(manifest.offlineIndex).toBe(true);
    expect(readBundleManifest(out)?.builtAt).toBe(NOW);

    const ports = offlinePorts(out);
    const refreshed = await refreshIndex(ports, source);
    expect(refreshed.status).toBe('updated');
    const downloaded = await downloadItem(ports, source, minutes);
    expect(downloaded.ok).toBe(true);
  });

  it('离线包在内网被改过 → 装不上（不是「离线就不验」）', async () => {
    const minutes = item('minutes');
    publishOffline([minutes]);
    const out = join(root, 'bundle');
    await buildHubBundle({ origin, out, log: () => {} });
    writeFileSync(
      join(out, minutes.package.path),
      packTarGz([{ path: 'SKILL.md', bytes: enc.encode('evil') }]),
    );
    const ports = offlinePorts(out);
    await refreshIndex(ports, source);
    const result = await downloadItem(ports, source, minutes);
    expect(result.ok).toBe(false);
    expect(result.kind).toBe('integrity');

    // 索引被改：验签失败
    const indexPath = join(out, 'index.json');
    const envelope = JSON.parse(readFileSync(indexPath, 'utf8'));
    envelope.payloadJson = envelope.payloadJson.replace('"sequence":9', '"sequence":99');
    expect(envelope.payloadJson).toContain('"sequence":99');
    writeFileSync(indexPath, JSON.stringify(envelope));
    expect((await refreshIndex(offlinePorts(out), source)).status).toBe('rejected');
  });

  it('离线模式下一个字节都不出网：上游地址直接失败，不退回去联网', async () => {
    const out = join(root, 'bundle');
    publishOffline([]);
    await buildHubBundle({ origin, out, log: () => {} });
    const fetchBundle = createBundleFetch(out);
    await expect(
      fetchBundle('https://github.com/o/r/archive/x.tar.gz', { headers: {}, redirect: 'manual' }),
    ).rejects.toThrow(/不访问网络/);
    // 路径穿越也出不去
    const escaped = await fetchBundle(`${BUNDLE_BASE_URL}/evowork/../../etc/passwd`, {
      headers: {},
      redirect: 'manual',
    });
    expect(escaped.status).toBe(404);
  });

  it('白名单只收列出来的；没写许可的条目不进包，并写进 MANIFEST', async () => {
    const upstream = item('unlicensed', {
      license: { spdx: 'NOASSERTION' },
      package: {
        url: 'https://codeload.example/o/r/tar.gz/abc',
        subdir: '',
        treeSha256: treeSha256([]),
      },
    });
    publishOffline([item('a'), item('b'), upstream]);
    const allow = join(root, 'allow.json');
    writeFileSync(
      allow,
      JSON.stringify({ items: ['skill:a', 'skill:unlicensed', 'skill:not-in-index'] }),
    );
    const out = join(root, 'bundle');
    const manifest = await buildHubBundle({ origin, out, allowlistPath: allow, log: () => {} });
    expect(manifest.included.map((i) => i.key)).toEqual(['skill:a']);
    expect(manifest.skipped.map((s) => s.key)).toEqual(['skill:unlicensed']);
    expect(files.has('/v1/evowork/pkgs/skill/b/1.0.0.tar.gz')).toBe(true);
    expect(() => readFileSync(join(out, 'pkgs/skill/b/1.0.0.tar.gz'))).toThrow();
    expect(readFileSync(join(out, 'allowlist.json'), 'utf8')).toContain('skill:a');
  });

  it('源上没有离线索引 → 退回在线索引，并在 MANIFEST 里如实标出来', async () => {
    publishOffline([item('a')], 'index.json');
    const lines = [];
    const manifest = await buildHubBundle({
      origin,
      out: join(root, 'b'),
      log: (l) => lines.push(l),
    });
    expect(manifest.offlineIndex).toBe(false);
    expect(lines.join('\n')).toMatch(/有效期很短/);
  });

  it('打包时内容包与索引不一致 → 在打包的人这边失败，不是在用户那边', async () => {
    const a = item('a');
    publishOffline([{ ...a, package: { ...a.package, sha256: 'b'.repeat(64) } }]);
    await expect(buildHubBundle({ origin, out: join(root, 'b'), log: () => {} })).rejects.toThrow(
      /不一致/,
    );
  });
});
