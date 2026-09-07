import { describe, expect, it } from 'vitest';

import {
  FONT_ASSET,
  FONT_FILE_NAME,
  FONT_WEIGHT_AXIS,
  PYTHON_ASSETS,
  PYTHON_RELEASE,
  PYTHON_VERSION,
  REQUIREMENTS,
  totalDownloadBytes,
  TRIPLE_BY_PLATFORM,
} from '../src/manifest.js';

describe('清单：每一项都能被下载并校验', () => {
  it('支持的每个平台都有对应的 python 资产 —— 否则那台机器上按钮点了没反应', () => {
    for (const [platform, triple] of Object.entries(TRIPLE_BY_PLATFORM)) {
      expect(PYTHON_ASSETS[triple], `${platform} → ${triple} 没有资产`).toBeDefined();
    }
  });

  it('所有哈希都是 64 位十六进制 —— 占位符会让校验永远失败，而失败信息看起来像网络问题', () => {
    for (const asset of [...Object.values(PYTHON_ASSETS), FONT_ASSET]) {
      expect(asset.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(asset.bytes).toBeGreaterThan(0);
    }
  });

  it('URL 里的 + 转义成 %2B —— 不转义 GitHub 返回 404，而 404 看起来像网络故障', () => {
    for (const asset of Object.values(PYTHON_ASSETS)) {
      expect(asset.url).not.toContain('+');
      expect(asset.url).toContain(`%2B${PYTHON_RELEASE}`);
      expect(asset.url).toContain(PYTHON_VERSION);
    }
  });

  it('字体钉在 commit 上，不指向 main —— main 是移动靶，Google 一更新全体用户同时装不上', () => {
    expect(FONT_ASSET.url).toMatch(/raw\.githubusercontent\.com\/google\/fonts\/[0-9a-f]{40}\//);
    expect(FONT_ASSET.url).not.toContain('/main/');
  });

  /**
   * 这条守的是 08 §4 点名的那种不一致：探针查五个模块说"装好了"，
   * 而技能因为缺 jsonschema 报"没装扩展"。
   */
  it('要装的包覆盖探针查的五个模块，外加技能校验用的 jsonschema', () => {
    const names = REQUIREMENTS.map((r) => r.split('==')[0]);
    for (const pkg of [
      'python-docx',
      'openpyxl',
      'python-pptx',
      'matplotlib',
      'pdfplumber',
      'jsonschema',
    ]) {
      expect(names).toContain(pkg);
    }
  });

  it('每个包都钉死版本 —— 不钉的话"图表生成失败"这类报告没法复现', () => {
    for (const requirement of REQUIREMENTS) {
      expect(requirement).toMatch(/^[a-z0-9-]+==\d+\.\d+(\.\d+)?$/);
    }
  });

  it('字体切的是 wght=400 的静态实例：可变字体会被 matplotlib 登记成 weight 100（偏细）', () => {
    expect(FONT_WEIGHT_AXIS).toBe('wght=400');
    expect(FONT_FILE_NAME).toMatch(/Regular\.ttf$/);
  });

  it('下载总量按平台算，不是一个常数 —— linux x64 比 macOS arm64 多四倍', () => {
    const mac = totalDownloadBytes('aarch64-apple-darwin');
    const linux = totalDownloadBytes('x86_64-unknown-linux-gnu');
    expect(mac).toBeGreaterThan(FONT_ASSET.bytes);
    expect(linux).toBeGreaterThan(mac);
    // 不认识的 triple 不该崩，返回的是"只有字体"这个显然偏小的值
    expect(totalDownloadBytes('nope')).toBe(FONT_ASSET.bytes);
  });
});
