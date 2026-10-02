/**
 * 真起一个本机 HTTP 服务当 Hub：断的是「请求里只带了什么」「坏的东西进不来」，
 * 这两件事用假的 fetch 断不出来（fetch 自己会加什么头，只有真请求看得见）。
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { generateEs256KeyPair } from '@evowork/account';
import {
  packTarGz,
  sha256Hex,
  signHubIndex,
  treeSha256,
  type HubIndexPayload,
  type HubItem,
} from '@evowork/hub-protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createNodeHubPorts,
  downloadItem,
  readCachedIndex,
  refreshIndex,
  type HubClientPorts,
  type HubSource,
} from '../src/index.js';

const keys = generateEs256KeyPair();
const enc = new TextEncoder();
const SKILL_FILES = [
  { path: 'SKILL.md', bytes: enc.encode('---\nname: minutes\ndescription: 纪要\n---\n') },
];
const ARCHIVE = packTarGz(SKILL_FILES);

function item(over: Partial<HubItem> = {}): HubItem {
  return {
    id: 'minutes',
    kind: 'skill',
    version: '1.0.0',
    package: {
      path: 'pkgs/skill/minutes/1.0.0.tar.gz',
      sha256: sha256Hex(ARCHIVE),
      size: ARCHIVE.length,
    },
    defaultEnabled: true,
    promptVisible: true,
    interface: { displayName: '会议纪要', description: '整理纪要', category: '办公' },
    audit: { level: 'p0', rulesVersion: 'r1', network: [], commands: [], hooks: false },
    license: { spdx: 'MIT' },
    ...over,
  };
}

function payload(sequence: number, over: Partial<HubIndexPayload> = {}): HubIndexPayload {
  return {
    schemaVer: 1,
    source: { id: 'evowork', displayName: 'EvoWork 精选' },
    sequence,
    issuedAt: 1_000,
    expiresAt: 10_000,
    items: [item()],
    revoked: [],
    ...over,
  };
}

let server: Server;
let base: string;
let cacheRoot: string;
let routes: Map<
  string,
  { status: number; body?: Uint8Array | string; headers?: Record<string, string> }
>;
let seen: { url: string; headers: IncomingHttpHeaders }[];
let now = 2_000;

beforeEach(async () => {
  cacheRoot = mkdtempSync(join(tmpdir(), 'ew-hub-client-'));
  routes = new Map();
  seen = [];
  now = 2_000;
  server = createServer((req, res) => {
    seen.push({ url: req.url ?? '', headers: req.headers });
    const route = routes.get(req.url ?? '');
    if (route === undefined) {
      res.statusCode = 404;
      res.end();
      return;
    }
    const etag = route.headers?.etag;
    if (etag !== undefined && req.headers['if-none-match'] === etag) {
      res.statusCode = 304;
      res.end();
      return;
    }
    res.statusCode = route.status;
    for (const [k, v] of Object.entries(route.headers ?? {})) res.setHeader(k, v);
    res.end(route.body ?? '');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  base = `http://127.0.0.1:${String(typeof address === 'object' && address ? address.port : 0)}/v1`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(cacheRoot, { recursive: true, force: true });
});

function ports(): HubClientPorts {
  return { ...createNodeHubPorts({ cacheRoot }), now: () => now };
}

function source(trusted = [{ kid: 'k1', publicPem: keys.publicPem }]): HubSource {
  return { id: 'evowork', baseUrl: base, trustedKeys: trusted };
}

function serveIndex(
  p: HubIndexPayload,
  etag = `"${String(p.sequence)}"`,
  privatePem = keys.privatePem,
) {
  routes.set('/v1/evowork/index.json', {
    status: 200,
    body: JSON.stringify(signHubIndex(privatePem, p, 'k1')),
    headers: { etag },
  });
}

describe('拉索引（13 §4.4 / §4.5）', () => {
  it('第一次 200，第二次带 If-None-Match 拿到 304；请求里不带任何能关联到人的东西', async () => {
    serveIndex(payload(1));
    const first = await refreshIndex(ports(), source());
    expect(first.status).toBe('updated');
    const second = await refreshIndex(ports(), source());
    expect(second.status).toBe('not-modified');
    expect(seen[1]?.headers['if-none-match']).toBe('"1"');
    for (const req of seen) {
      expect(req.headers.authorization).toBeUndefined();
      expect(req.headers.cookie).toBeUndefined();
      // 4.6：不带 App 版本、设备标识 —— 除了 HTTP 本身的头，只多了 If-None-Match
      const custom = Object.keys(req.headers).filter(
        (h) =>
          ![
            'host',
            'connection',
            'accept',
            'accept-language',
            'accept-encoding',
            'user-agent',
            'sec-fetch-mode',
            // undici 给条件请求自己加的，不带任何信息
            'pragma',
            'cache-control',
            'if-none-match',
          ].includes(h),
      );
      expect(custom).toEqual([]);
    }
  });

  it('序号回退 → 丢弃新索引，继续用缓存（防拿旧的合法索引回滚）', async () => {
    serveIndex(payload(5));
    await refreshIndex(ports(), source());
    serveIndex(payload(4), '"other"');
    const result = await refreshIndex(ports(), source());
    expect(result.status).toBe('rejected');
    expect(result.index?.payload.sequence).toBe(5);
    expect(readCachedIndex(ports(), source())?.payload.sequence).toBe(5);
  });

  it('同一个序号两份不同内容 → 不认', async () => {
    serveIndex(payload(5));
    await refreshIndex(ports(), source());
    serveIndex(payload(5, { expiresAt: 20_000 }), '"x"');
    expect((await refreshIndex(ports(), source())).status).toBe('rejected');
  });

  it('别人的钥匙签的、或签名不在信任列表里 → 不认，也不提供「仍然使用」', async () => {
    const stranger = generateEs256KeyPair();
    serveIndex(payload(1), '"1"', stranger.privatePem);
    const result = await refreshIndex(ports(), source());
    expect(result.status).toBe('rejected');
    expect(result.index).toBeUndefined();
    expect(readCachedIndex(ports(), source())).toBeUndefined();
  });

  it('索引声明的来源和请求的不一致 → 不认（不能拿 A 源的索引冒充 B 源）', async () => {
    serveIndex(payload(1, { source: { id: 'other', displayName: 'x' } }));
    expect((await refreshIndex(ports(), source())).status).toBe('rejected');
  });

  it('磁盘上的缓存被改过 → 读出来就是没有缓存', async () => {
    serveIndex(payload(1));
    await refreshIndex(ports(), source());
    const path = join(cacheRoot, 'evowork', 'index.json');
    writeFileSync(path, readFileSync(path, 'utf8').replace('会议纪要', '会议纪要!'));
    expect(readCachedIndex(ports(), source())).toBeUndefined();
  });

  it('连不上 → unreachable，照样给缓存', async () => {
    serveIndex(payload(1));
    await refreshIndex(ports(), source());
    routes.clear();
    routes.set('/v1/evowork/index.json', { status: 503 });
    const result = await refreshIndex(ports(), source());
    expect(result.status).toBe('unreachable');
    expect(result.index?.payload.sequence).toBe(1);
  });

  it('过了 expiresAt 照样能读，但标成过期（4.5：禁止新装）', async () => {
    serveIndex(payload(1));
    await refreshIndex(ports(), source());
    now = 20_000;
    expect(readCachedIndex(ports(), source())?.expired).toBe(true);
  });
});

describe('下载内容包（13 §4.2 / §5.3）', () => {
  it('哈希对得上 → 解出来的就是打进去的', async () => {
    routes.set('/v1/evowork/pkgs/skill/minutes/1.0.0.tar.gz', { status: 200, body: ARCHIVE });
    const result = await downloadItem(ports(), source(), item());
    expect(result.ok && result.files.map((f) => f.path)).toEqual(['SKILL.md']);
  });

  it('内容被换了 → integrity（拒装，不提供重试）', async () => {
    const other = packTarGz([{ path: 'SKILL.md', bytes: enc.encode('---\nname: evil\n---\n') }]);
    routes.set('/v1/evowork/pkgs/skill/minutes/1.0.0.tar.gz', { status: 200, body: other });
    const result = await downloadItem(ports(), source(), item());
    expect(result.ok).toBe(false);
    expect(!result.ok && result.kind).toBe('integrity');
  });

  it('上游固定提交：去掉归档的顶层目录、取 subdir、比文件树哈希', async () => {
    const upstream = packTarGz([
      { path: 'repo-abc/skills/minutes/SKILL.md', bytes: SKILL_FILES[0]!.bytes },
      { path: 'repo-abc/README.md', bytes: enc.encode('other') },
    ]);
    routes.set('/archive.tar.gz', { status: 200, body: upstream });
    const upstreamItem = item({
      license: { spdx: 'NOASSERTION' },
      package: {
        // 测试服务器是 http；上游只认 https，所以这里先断「http 不去取」
        url: `${base.replace('/v1', '')}/archive.tar.gz`,
        subdir: 'skills/minutes',
        treeSha256: treeSha256(SKILL_FILES),
      },
    });
    const refused = await downloadItem(ports(), source(), upstreamItem);
    expect(refused.ok).toBe(false);
    expect(!refused.ok && refused.kind).toBe('unreachable');
  });

  it('上游 https 取到：去掉顶层目录、取 subdir、树哈希对上才算数；重定向到 http 不跟', async () => {
    const upstream = packTarGz([
      { path: 'repo-abc/skills/minutes/SKILL.md', bytes: SKILL_FILES[0]!.bytes },
      { path: 'repo-abc/README.md', bytes: enc.encode('other') },
    ]);
    const hits: string[] = [];
    const fake: HubClientPorts = {
      ...ports(),
      fetch: async (url) => {
        hits.push(url);
        if (url === 'https://github.example/o/r/archive/abc.tar.gz') {
          return {
            status: 302,
            headers: { get: (n) => (n === 'location' ? 'https://codeload.example/abc' : null) },
            arrayBuffer: async () => new ArrayBuffer(0),
          };
        }
        if (url === 'https://evil.example/x') {
          return {
            status: 302,
            headers: { get: (n) => (n === 'location' ? 'http://plain.example/x' : null) },
            arrayBuffer: async () => new ArrayBuffer(0),
          };
        }
        return {
          status: 200,
          headers: { get: () => null },
          arrayBuffer: async () => upstream.slice().buffer,
        };
      },
    };
    const good = item({
      license: { spdx: 'NOASSERTION' },
      package: {
        url: 'https://github.example/o/r/archive/abc.tar.gz',
        subdir: 'skills/minutes',
        treeSha256: treeSha256(SKILL_FILES),
      },
    });
    const ok = await downloadItem(fake, source(), good);
    expect(ok.ok && ok.files.map((f) => f.path)).toEqual(['SKILL.md']);
    expect(hits).toEqual([
      'https://github.example/o/r/archive/abc.tar.gz',
      'https://codeload.example/abc',
    ]);

    const wrongTree = await downloadItem(fake, source(), {
      ...good,
      package: { ...good.package, subdir: '' } as never,
    });
    expect(!wrongTree.ok && wrongTree.kind).toBe('integrity');

    const downgraded = await downloadItem(fake, source(), {
      ...good,
      package: { ...good.package, url: 'https://evil.example/x' } as never,
    });
    expect(downgraded.ok).toBe(false);
    expect(hits).not.toContain('http://plain.example/x');
  });

  it('上游连不上时说要能访问哪台主机，不退回我们的 CDN', async () => {
    const upstreamItem = item({
      license: { spdx: 'NOASSERTION' },
      package: {
        url: 'https://127.0.0.1:1/archive.tar.gz',
        subdir: '',
        treeSha256: treeSha256(SKILL_FILES),
      },
    });
    const result = await downloadItem(ports(), source(), upstreamItem);
    expect(!result.ok && result.host).toBe('127.0.0.1:1');
    expect(seen.some((r) => r.url.includes('/pkgs/'))).toBe(false);
  });
});
