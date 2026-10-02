/**
 * 发布脚本里决定「发不发、按什么顺序发」的那几段（在线升级提案 §4 B2）。
 * 真上传与 git 状态不在这里测 —— 它们要一台服务器和一个干净的签出；
 * `--dry-run` 在真仓库上跑一次就能看到每一项检查的结论。
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  checkReleaseFiles,
  checkSigningKeys,
  compareVersions,
  MANIFEST_NAME,
  parseLatestYml,
  uploadPlan,
  uploadRelease,
} from '../publish-release.mjs';
import { signatureNameFor } from '../update-signing.mjs';

/** 照 electron-builder 26 实际写出来的样子（dist/release/latest-mac.yml，0.0.4） */
const REAL_SHAPE = `version: 0.0.4
files:
  - url: EvoWork-0.0.4-mac-arm64-unsigned.zip
    sha512: Cl5iz2nTJSCGgWre/4rGbPKEHxv4JXzMfH4iBoiki8yU5RNVLwxAqxZivG1smh2bBLYv4XmuMUr2s1XAKVuemw==
    size: 223597718
  - url: EvoWork-0.0.4-mac-arm64-unsigned.dmg
    sha512: OVOYuKjGAv8FLOKKYhzHS5GtK6BCUg6KJLFrSSe+nRX21ZCsGW9DXiJF56S+6j/mI6PrHwQggdIhYQmGsy9VXQ==
    size: 223369465
path: EvoWork-0.0.4-mac-arm64-unsigned.zip
sha512: Cl5iz2nTJSCGgWre/4rGbPKEHxv4JXzMfH4iBoiki8yU5RNVLwxAqxZivG1smh2bBLYv4XmuMUr2s1XAKVuemw==
releaseDate: '2026-10-01T23:50:01.429Z'
`;

describe('解析 latest-mac.yml', () => {
  it('electron-builder 写出来的形状能读出版本与每个文件的 sha512 / 大小', () => {
    const m = parseLatestYml(REAL_SHAPE);
    expect(m.version).toBe('0.0.4');
    expect(m.files.map((f) => [f.url, f.size])).toEqual([
      ['EvoWork-0.0.4-mac-arm64-unsigned.zip', 223597718],
      ['EvoWork-0.0.4-mac-arm64-unsigned.dmg', 223369465],
    ]);
    expect(m.releaseDate).toBe('2026-10-01T23:50:01.429Z');
  });

  it('认不出的行直接报错 —— 宽容的解析器会把写错的清单也发出去', () => {
    expect(() => parseLatestYml(`${REAL_SHAPE}stagingPercentage: 10\n`)).toThrow(/认不出/);
  });
});

describe('版本比较', () => {
  it('按数字比，不按字符串比：0.0.10 比 0.0.9 新', () => {
    expect(compareVersions('0.0.10', '0.0.9')).toBe(1);
    expect(compareVersions('0.0.4', '0.0.5')).toBe(-1);
    expect(compareVersions('0.0.5', '0.0.5')).toBe(0);
  });

  it('预发布版排在同号正式版之前：0.0.5-beta.1 < 0.0.5', () => {
    expect(compareVersions('0.0.5-beta.1', '0.0.5')).toBe(-1);
    expect(compareVersions('0.0.5', '0.0.5-beta.1')).toBe(1);
  });
});

describe('上传顺序', () => {
  const raw = Buffer.from(REAL_SHAPE);
  const manifest = { ...parseLatestYml(REAL_SHAPE), raw };
  const available = [
    MANIFEST_NAME,
    'EvoWork-0.0.4-mac-arm64-unsigned.zip',
    'EvoWork-0.0.4-mac-arm64-unsigned.zip.blockmap',
    'EvoWork-0.0.4-mac-arm64-unsigned.dmg',
  ];

  it('安装包 → 签名 → 清单：清单一出现，它指向的东西都已经在了', () => {
    const plan = uploadPlan(manifest, available);
    expect(plan.map((s) => s.phase)).toEqual(['packages', 'signature', 'manifest']);
    expect(plan.at(-1)?.files).toEqual([MANIFEST_NAME]);
  });

  it('签名文件名按清单原始字节算，与客户端去取的是同一个', () => {
    const plan = uploadPlan(manifest, available);
    expect(plan[1]?.files).toEqual([`signatures/${signatureNameFor(raw)}`]);
  });

  it('有 blockmap 就带上（差量下载要它），没有也不报错', () => {
    const packages = uploadPlan(manifest, available)[0]?.files ?? [];
    expect(packages).toContain('EvoWork-0.0.4-mac-arm64-unsigned.zip.blockmap');
    expect(packages).not.toContain('EvoWork-0.0.4-mac-arm64-unsigned.dmg.blockmap');
  });
});

describe('发之前的检查', () => {
  let dir;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'evowork-publish-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function manifestFor(content) {
    writeFileSync(join(dir, 'a.zip'), content);
    return {
      files: [
        {
          url: 'a.zip',
          size: Buffer.byteLength(content),
          sha512: createHash('sha512').update(content).digest('base64'),
        },
      ],
    };
  }

  it('清单与包对得上：没有问题', () => {
    expect(checkReleaseFiles(dir, manifestFor('zip'))).toEqual([]);
  });

  it('包被换过（dist/ 里是另一次打包的）：指出是哪个文件', () => {
    const manifest = manifestFor('zip');
    writeFileSync(join(dir, 'a.zip'), 'zop');
    expect(checkReleaseFiles(dir, manifest).join()).toMatch(/a\.zip 的 sha512/);
  });

  it('客户端只内嵌了日常那把：拒绝发布 —— 日常私钥一丢，已装的客户端就再也验不过新版', () => {
    expect(checkSigningKeys([{ kid: 'd1', role: 'daily', jwk: {} }], 'd1').join()).toMatch(
      /backup/,
    );
  });

  it('签名用的 kid 不在客户端里：拒绝发布，否则每个客户端都报 unknown-key', () => {
    const keys = [
      { kid: 'd1', role: 'daily', jwk: {} },
      { kid: 'b1', role: 'backup', jwk: {} },
    ];
    expect(checkSigningKeys(keys, 'd2').join()).toMatch(/kid=d2/);
    expect(checkSigningKeys(keys, 'd1')).toEqual([]);
  });
});

describe('传到本地目录（服务器上的布局）', () => {
  let root;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'evowork-publish-'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('文件落在客户端会去找的位置：<channel>/ 下放包与清单，签名在 signatures/', () => {
    const dist = join(root, 'dist');
    mkdirSync(join(dist, 'signatures'), { recursive: true });
    const raw = Buffer.from(REAL_SHAPE);
    for (const name of [
      'EvoWork-0.0.4-mac-arm64-unsigned.zip',
      'EvoWork-0.0.4-mac-arm64-unsigned.zip.blockmap',
      'EvoWork-0.0.4-mac-arm64-unsigned.dmg',
    ]) {
      writeFileSync(join(dist, name), name);
    }
    writeFileSync(join(dist, MANIFEST_NAME), raw);
    writeFileSync(join(dist, 'signatures', signatureNameFor(raw)), '{}');

    const plan = uploadPlan({ ...parseLatestYml(REAL_SHAPE), raw }, readdirSync(dist));
    const dest = join(root, 'server');
    uploadRelease(dist, dest, 'latest', plan);

    expect(readdirSync(join(dest, 'latest')).sort()).toEqual(
      [
        'EvoWork-0.0.4-mac-arm64-unsigned.dmg',
        'EvoWork-0.0.4-mac-arm64-unsigned.zip',
        'EvoWork-0.0.4-mac-arm64-unsigned.zip.blockmap',
        MANIFEST_NAME,
        'signatures',
      ].sort(),
    );
    expect(existsSync(join(dest, 'latest', 'signatures', signatureNameFor(raw)))).toBe(true);
  });
});
