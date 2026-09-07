/**
 * 离线包打包脚本（08 §4「企业离线部署提供全量包」）。
 *
 * 这里只测一件事，但它是这个脚本最容易坏的一件：**脚本读出来的清单必须与
 * `manifest.ts` 完全一致**。脚本是用正则读 TS 源码的（为了在没跑过 tsc 的干净签出上
 * 也能用），而正则会被一次无害的格式化悄悄改坏 —— 那时打出来的离线包与在线装出来的
 * 是两套环境，而"两条路径装出来必须一样"正是那份清单存在的理由。
 *
 * 坏掉的表现不在打包机上，而在**客户机器上**：`--no-index` 找不到 wheel，
 * 或者装出来的 matplotlib 版本对不上。所以这条断言要在打包之前就红。
 */
import { describe, expect, it } from 'vitest';

import {
  FONT_ASSET,
  PYTHON_RELEASE,
  PYTHON_VERSION,
  REQUIREMENTS,
  TRIPLE_BY_PLATFORM,
} from '../../services/runtime-installer/src/manifest.js';
import { PIP_PLATFORMS, readManifest } from '../build-office-bundle.mjs';

describe('离线包脚本与清单是同一份事实', () => {
  const parsed = readManifest();

  it('python 版本与 release 读得对', () => {
    expect(parsed.pythonVersion).toBe(PYTHON_VERSION);
    expect(parsed.pythonRelease).toBe(PYTHON_RELEASE);
  });

  it('六个包一个不多一个不少，版本逐字相同', () => {
    expect(parsed.requirements).toEqual([...REQUIREMENTS]);
  });

  it('平台列表与 TRIPLE_BY_PLATFORM 覆盖同一组 triple', () => {
    expect([...parsed.triples].sort()).toEqual(
      [...new Set(Object.values(TRIPLE_BY_PLATFORM))].sort(),
    );
  });

  it('字体地址与哈希读得对 —— 读错的话离线包里是一份校验不过的字体', () => {
    expect(parsed.font.url).toBe(FONT_ASSET.url);
    expect(parsed.font.sha256).toBe(FONT_ASSET.sha256);
  });

  /**
   * pip 的平台标签与 rust 风格的 triple 是两套命名。少一项的表现是
   * 那个平台打出来的包**没有 wheel**，而脚本本身不会报错。
   */
  it('每个支持的 triple 都有对应的 pip 平台标签', () => {
    for (const triple of new Set(Object.values(TRIPLE_BY_PLATFORM))) {
      expect(PIP_PLATFORMS[triple], `${triple} 没有 pip 平台标签`).toBeDefined();
      expect(PIP_PLATFORMS[triple].length).toBeGreaterThan(0);
    }
  });
});
