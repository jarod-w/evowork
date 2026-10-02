// @vitest-environment node
/**
 * 更新清单的形状（在线升级提案 §4 B4）。验签在 scripts/test/update-signing.test.mjs；
 * 这里管的是「验过签之后，清单里写的东西被读成了什么」。
 *
 * 发布脚本也用这一份解析器（经 esbuild 现编），所以这里认不出的，也发不出去。
 */
import { describe, expect, it } from 'vitest';

import {
  compareVersions,
  manifestNameFor,
  parseUpdateManifest,
  pickPackageFor,
} from '../src/main/update-manifest.js';

/** electron-builder 26 实际写出来的样子（dist/release/latest-mac.yml，0.0.4） */
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

function parsed(text: string) {
  const result = parseUpdateManifest(text);
  if (!result.ok) throw new Error(result.reason);
  return result.manifest;
}

describe('解析 electron-builder 的清单', () => {
  it('真实形状：版本、两个文件、发布时间；没写更新说明时 notes 是空的', () => {
    const m = parsed(REAL_SHAPE);
    expect(m.version).toBe('0.0.4');
    expect(m.files.map((f) => [f.url, f.size])).toEqual([
      ['EvoWork-0.0.4-mac-arm64-unsigned.zip', 223597718],
      ['EvoWork-0.0.4-mac-arm64-unsigned.dmg', 223369465],
    ]);
    expect(m.releaseDate).toBe('2026-10-01T23:50:01.429Z');
    expect(m.notes).toEqual([]);
  });

  it('build/release-notes.md 写进来的块：每行一条，去掉「- 」前缀与空行', () => {
    const m = parsed(
      `${REAL_SHAPE}releaseNotes: |-\n  - 修复插件页为空\n\n  - 办公扩展会提示需要更新\n`,
    );
    expect(m.notes).toEqual(['修复插件页为空', '办公扩展会提示需要更新']);
  });

  it('折叠块、单引号、双引号三种写法都认（js-yaml 会按内容挑一种）', () => {
    expect(parsed(`${REAL_SHAPE}releaseNotes: >-\n  第一条\n\n  第二条\n`).notes).toEqual([
      '第一条',
      '第二条',
    ]);
    expect(parsed(`${REAL_SHAPE}releaseNotes: '它''s 一条'\n`).notes).toEqual(["它's 一条"]);
    expect(parsed(`${REAL_SHAPE}releaseNotes: "一\\n二"\n`).notes).toEqual(['一', '二']);
  });

  it('认不出的行直接拒：宽容的解析器会把写错的清单也放过去', () => {
    expect(parseUpdateManifest(`${REAL_SHAPE}stagingPercentage: 10\n`)).toMatchObject({
      ok: false,
    });
  });

  it('文件缺 sha512 或版本号不像版本号：拒，不猜一个', () => {
    expect(
      parseUpdateManifest('version: 0.0.5\nfiles:\n  - url: a.dmg\n    size: 1\n'),
    ).toMatchObject({ ok: false });
    expect(parseUpdateManifest(REAL_SHAPE.replace('0.0.4', 'latest'))).toMatchObject({ ok: false });
  });
});

describe('版本比较', () => {
  it('按数字比：0.0.10 比 0.0.9 新，相同为 0', () => {
    expect(compareVersions('0.0.10', '0.0.9')).toBe(1);
    expect(compareVersions('0.0.4', '0.0.5')).toBe(-1);
    expect(compareVersions('0.0.5', '0.0.5')).toBe(0);
  });

  it('预发布版排在同号正式版之前', () => {
    expect(compareVersions('0.0.5-beta.1', '0.0.5')).toBe(-1);
  });
});

describe('这台机器下哪个包', () => {
  it('mac 下 dmg（用户要手动替换，dmg 是他们认得的形状），不下 zip', () => {
    expect(pickPackageFor(parsed(REAL_SHAPE), 'darwin', 'arm64')?.url).toBe(
      'EvoWork-0.0.4-mac-arm64-unsigned.dmg',
    );
  });

  it('清单里有两个架构的 dmg：取名字里带本机架构的；都不带就不猜', () => {
    const two = parsed(
      REAL_SHAPE.replace(
        'path:',
        '  - url: EvoWork-0.0.4-mac-x64-unsigned.dmg\n    sha512: x\n    size: 1\npath:',
      ),
    );
    expect(pickPackageFor(two, 'darwin', 'x64')?.url).toBe('EvoWork-0.0.4-mac-x64-unsigned.dmg');
    expect(pickPackageFor(two, 'darwin', 'riscv64')).toBeUndefined();
  });

  it('每个平台读自己的清单文件（electron-builder 的命名）', () => {
    expect([manifestNameFor('darwin'), manifestNameFor('win32'), manifestNameFor('linux')]).toEqual(
      ['latest-mac.yml', 'latest.yml', 'latest-linux.yml'],
    );
  });
});
