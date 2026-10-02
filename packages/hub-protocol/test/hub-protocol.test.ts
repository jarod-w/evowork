import { gzipSync } from 'node:zlib';

import { generateEs256KeyPair } from '@evowork/account';
import { describe, expect, it } from 'vitest';

import {
  compareVersions,
  matchesRange,
  packTarGz,
  parseHubIndexPayload,
  signHubIndex,
  treeSha256,
  unpackTarGz,
  verifyHubIndex,
  type HubIndexPayload,
  type HubItem,
} from '../src/index.js';

const SHA = 'a'.repeat(64);

export function item(over: Partial<HubItem> = {}): HubItem {
  return {
    id: 'meeting-minutes',
    kind: 'skill',
    version: '1.3.0',
    package: { path: 'pkgs/skill/meeting-minutes/1.3.0.tar.gz', sha256: SHA, size: 100 },
    defaultEnabled: true,
    promptVisible: true,
    interface: { displayName: '会议纪要', description: '把会议记录整理成纪要', category: '办公' },
    audit: { level: 'p0', rulesVersion: 'r1', network: [], commands: [], hooks: false },
    license: { spdx: 'MIT', upstream: 'github.com/o/r', commit: 'abc', modified: true },
    ...over,
  };
}

function payload(over: Partial<HubIndexPayload> = {}): HubIndexPayload {
  return {
    schemaVer: 1,
    source: { id: 'evowork', displayName: 'EvoWork 精选' },
    sequence: 7,
    issuedAt: 1_790_000_000,
    expiresAt: 1_790_604_800,
    items: [item()],
    revoked: [],
    ...over,
  };
}

describe('索引签名（13 §4.1 / §4.3）', () => {
  const keys = generateEs256KeyPair();
  const trusted = [{ kid: 'hub-a', publicPem: keys.publicPem }];

  it('签了能验，验出来的就是签进去的', () => {
    const env = signHubIndex(keys.privatePem, payload(), 'hub-a');
    const result = verifyHubIndex(env, trusted);
    expect(result.ok && result.payload.sequence).toBe(7);
  });

  it('改一个字节就验不过：验的是原文，不重新编码', () => {
    const env = signHubIndex(keys.privatePem, payload(), 'hub-a');
    const tampered = {
      ...env,
      payloadJson: env.payloadJson.replace('"sequence":7', '"sequence":8'),
    };
    expect(verifyHubIndex(tampered, trusted)).toEqual({ ok: false, reason: 'bad-sig' });
  });

  it('kid 不在钉死列表里就不认，不会退而求其次去试别的钥匙', () => {
    const other = generateEs256KeyPair();
    const env = signHubIndex(other.privatePem, payload(), 'hub-b');
    expect(verifyHubIndex(env, trusted)).toEqual({ ok: false, reason: 'bad-kid' });
    // 拿我们 kid 的名字、用别人的钥匙签：照样不过
    const forged = signHubIndex(other.privatePem, payload(), 'hub-a');
    expect(verifyHubIndex(forged, trusted)).toEqual({ ok: false, reason: 'bad-sig' });
  });

  it('签名对、形状不对（schemaVer 不认识）= bad-payload', () => {
    const env = signHubIndex(keys.privatePem, { ...payload(), schemaVer: 2 } as never, 'hub-a');
    expect(verifyHubIndex(env, trusted)).toEqual({ ok: false, reason: 'bad-payload' });
  });
});

describe('索引解析是白名单式的', () => {
  const parse = (p: unknown) => parseHubIndexPayload(JSON.stringify(p));

  it('合法的能解', () => {
    expect(parse(payload())?.items).toHaveLength(1);
  });

  it('没写许可的条目只能指向上游固定提交，不能指向我们的 CDN（HUB-Q5a=A）', () => {
    const hosted = item({ license: { spdx: 'NOASSERTION' } });
    expect(parse(payload({ items: [hosted] }))).toBeUndefined();
    const upstream = item({
      license: { spdx: 'NOASSERTION', upstream: 'github.com/o/r', commit: 'abc' },
      package: {
        url: 'https://codeload.github.com/o/r/tar.gz/abc',
        subdir: 'skills/x',
        treeSha256: SHA,
      },
    });
    expect(parse(payload({ items: [upstream] }))?.items).toHaveLength(1);
  });

  it('内容包路径带 .. 或是绝对路径 → 整份不认', () => {
    for (const path of ['../x.tar.gz', 'pkgs/../../x.tar.gz', '/etc/x.tar.gz']) {
      const bad = item({ package: { path, sha256: SHA, size: 1 } });
      expect(parse(payload({ items: [bad] }))).toBeUndefined();
    }
  });

  it('上游地址只认 https', () => {
    const bad = item({
      license: { spdx: 'NOASSERTION' },
      package: { url: 'http://example.com/a.tar.gz', subdir: '', treeSha256: SHA },
    });
    expect(parse(payload({ items: [bad] }))).toBeUndefined();
  });

  it('同一个 kind:id 出现两次 → 不认（哪个才算数说不清）', () => {
    expect(parse(payload({ items: [item(), item({ version: '1.4.0' })] }))).toBeUndefined();
  });

  it('连接器必须写传输方式；非连接器不许写', () => {
    expect(parse(payload({ items: [item({ kind: 'connector' })] }))).toBeUndefined();
    expect(
      parse(payload({ items: [item({ kind: 'connector', connector: { transport: 'stdio' } })] })),
    ).toBeDefined();
    expect(parse(payload({ items: [item({ connector: { transport: 'http' } })] }))).toBeUndefined();
  });

  it('吊销范围写错一个字符 → 整份不认（宁可不更新，也不能当成没吊销）', () => {
    expect(
      parse(payload({ revoked: [{ id: 'x', versions: ['<1.2'], reason: '诱导安装' }] })),
    ).toBeUndefined();
  });
});

describe('版本与吊销范围', () => {
  it('预发布比正式版小，数字段按数值比', () => {
    expect(compareVersions('1.2.0-rc.1', '1.2.0')).toBeLessThan(0);
    expect(compareVersions('1.10.0', '1.9.0')).toBeGreaterThan(0);
    expect(compareVersions('1.2.0-rc.10', '1.2.0-rc.9')).toBeGreaterThan(0);
  });

  it('范围是 AND；* 命中一切', () => {
    expect(matchesRange('1.2.0', '<1.2.1')).toBe(true);
    expect(matchesRange('1.2.1', '<1.2.1')).toBe(false);
    expect(matchesRange('1.1.0', '>=1.0.0 <1.2.0')).toBe(true);
    expect(matchesRange('9.9.9', '*')).toBe(true);
  });

  it('认不出的版本按命中处理（吊销只能多停，不能放过）', () => {
    expect(matchesRange('not-a-version', '<1.0.0')).toBe(true);
  });
});

describe('内容包 tar.gz', () => {
  const files = [
    { path: 'SKILL.md', bytes: new TextEncoder().encode('---\nname: a\n---\n') },
    { path: `deep/${'x'.repeat(120)}/f.txt`, bytes: new TextEncoder().encode('long name') },
  ];

  it('打包是确定的：同样的内容 → 同样的字节（sha256 只取决于内容）', () => {
    expect(Buffer.from(packTarGz(files)).equals(Buffer.from(packTarGz([...files].reverse())))).toBe(
      true,
    );
  });

  it('打了能解，长路径也对', () => {
    const result = unpackTarGz(packTarGz(files));
    expect(result.ok && result.files.map((f) => f.path).sort()).toEqual(
      files.map((f) => f.path).sort(),
    );
  });

  it('树哈希与文件顺序无关、与内容有关', () => {
    expect(treeSha256(files)).toBe(treeSha256([...files].reverse()));
    expect(treeSha256(files)).not.toBe(
      treeSha256([files[0]!, { ...files[1]!, bytes: new Uint8Array([1]) }]),
    );
  });

  it('符号链接 → 整包拒绝，不是跳过', () => {
    const tar = rawTar([
      { name: 'SKILL.md', type: '0', data: 'x' },
      { name: 'evil', type: '2', data: '', link: '/home/u/.ssh' },
    ]);
    const result = unpackTarGz(gzipSync(tar));
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toMatch(/符号链接/);
  });

  it('.. 与绝对路径 → 整包拒绝', () => {
    for (const name of ['../escape.txt', '/etc/passwd', 'a/../../b']) {
      const result = unpackTarGz(gzipSync(rawTar([{ name, type: '0', data: 'x' }])));
      expect(result.ok).toBe(false);
    }
  });

  it('解开后超过上限 → 拒绝（压缩炸弹）', () => {
    const big = packTarGz([{ path: 'a', bytes: new Uint8Array(2 * 1024 * 1024) }]);
    const result = unpackTarGz(big, { maxFiles: 10, maxTotalBytes: 1024 * 1024 });
    expect(result.ok).toBe(false);
  });
});

/** 手写一个 tar，用来构造 packTarGz 不会产出的条目（符号链接、坏路径）。 */
function rawTar(entries: { name: string; type: string; data: string; link?: string }[]): Buffer {
  const chunks: Buffer[] = [];
  for (const e of entries) {
    const data = Buffer.from(e.data);
    const h = Buffer.alloc(512);
    h.write(e.name, 0, 100);
    h.write('0000644\0', 100);
    h.write('0000000\0', 108);
    h.write('0000000\0', 116);
    h.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124);
    h.write('00000000000\0', 136);
    h.write('        ', 148);
    h.write(e.type, 156);
    if (e.link) h.write(e.link, 157, 100);
    h.write('ustar\0', 257);
    h.write('00', 263);
    let sum = 0;
    for (const b of h) sum += b;
    h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
    chunks.push(h, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  chunks.push(Buffer.alloc(1024));
  return Buffer.concat(chunks);
}
