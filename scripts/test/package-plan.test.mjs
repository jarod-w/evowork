/**
 * 打包计划（M9 / R10）。
 *
 * 两条断言在这里最有价值：**完整办公运行时允许随包，OCR 仍须独立**，
 * 以及**缺证书时整体降级为未签名并把标注写进文件名**（半签名的产物比未签名的更危险）。
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  artifactName,
  checkSizeBudget,
  checkTierPlacement,
  HOOK_VENDOR,
  planSigning,
  SIZE_BUDGET,
} from '../package-plan.mjs';

const BUILD_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../build');

describe('三档运行时的边界（08 §4 / R10）', () => {
  it('完整 Python 办公库允许随基础包分发', () => {
    const result = checkTierPlacement([
      'dist/main/index.js',
      'resources/kernel/codex-app-server',
      'resources/python/site-packages/openpyxl/__init__.py',
    ]);
    expect(result.ok).toBe(true);
  });

  it('OCR 仍独立发行，混入基础包会拒绝', () => {
    expect(checkTierPlacement(['Resources/ocr/tessdata/eng.traineddata']).ok).toBe(false);
  });

  it('干净的基础包通过，中文字体随基础包走不算越界', () => {
    expect(
      checkTierPlacement([
        'dist/main/index.js',
        'resources/plugins/skills/charts/SKILL.md',
        'resources/office/NotoSansSC.ttf',
      ]).ok,
    ).toBe(true);
  });

  it('预算超了要红，且提示先查是不是有东西混进了基础包', () => {
    const result = checkSizeBudget('base', SIZE_BUDGET.base + 1);
    expect(result.ok).toBe(false);
    expect(result.message).toContain('重复依赖');
  });

  it('三档各有预算，基础包最大', () => {
    expect(SIZE_BUDGET.base).toBeGreaterThan(SIZE_BUDGET.office);
    expect(SIZE_BUDGET.office).toBeGreaterThan(SIZE_BUDGET.ocr);
  });
});

describe('签名：没有证书就产出未签名包（U4）', () => {
  it('macOS 缺任何一个 secret 都**整体降级** —— 半签名的产物看起来像正式包', () => {
    const plan = planSigning({ APPLE_ID: 'x', CSC_LINK: 'y' }, 'mac');
    expect(plan.sign).toBe(false);
    expect(plan.notarize).toBe(false);
    expect(plan.missing).toContain('APPLE_TEAM_ID');
  });

  it('**标注进文件名**，否则没人会注意到', () => {
    const plan = planSigning({}, 'mac');
    expect(plan.suffix).toBe('-unsigned');
    expect(artifactName('EvoWork', '0.1.0', 'mac', 'arm64', 'dmg', plan.suffix)).toBe(
      'EvoWork-0.1.0-mac-arm64-unsigned.dmg',
    );
  });

  it('secrets 齐全时签名并公证', () => {
    const plan = planSigning(
      {
        APPLE_ID: 'a',
        APPLE_APP_SPECIFIC_PASSWORD: 'b',
        APPLE_TEAM_ID: 'c',
        CSC_LINK: 'd',
      },
      'mac',
    );
    expect(plan.sign).toBe(true);
    expect(plan.notarize).toBe(true);
    expect(plan.suffix).toBe('');
  });

  it('Linux 不需要签名 secrets', () => {
    expect(planSigning({}, 'linux').sign).toBe(true);
  });

  it('未签名降级把「已损坏」与 xattr 写进打包警告 —— 对方机器上那句不指向文件坏了', () => {
    const plan = planSigning({}, 'mac');
    expect(plan.message).toContain('已损坏');
    expect(plan.message).toContain('xattr -cr');
  });
});

describe('策略包的 vendor 步骤', () => {
  it('指向 hook 运行器会去找的那个路径', () => {
    expect(HOOK_VENDOR.to).toBe('plugins/hooks/evowork-policy/vendor/policy.mjs');
  });
});

describe('Windows NSIS 安装向导配置（协议确认 · 目录选择 · 快捷方式勾选 · 品牌图标）', () => {
  it('关闭一键静默塞 C 盘，开放安装目录修改并挂载自定义附加任务脚本与品牌图标', () => {
    const yml = readFileSync(join(BUILD_DIR, 'electron-builder.yml'), 'utf8');
    expect(yml).toMatch(/^\s*icon:\s*build\/icon\.ico$/m);
    expect(yml).toMatch(/^\s*oneClick:\s*false$/m);
    expect(yml).toMatch(/^\s*perMachine:\s*false$/m);
    expect(yml).toMatch(/^\s*allowToChangeInstallationDirectory:\s*true$/m);
    expect(yml).toMatch(/^\s*include:\s*build\/installer\.nsh$/m);

    for (const asset of [
      'icon.ico',
      'installerHeader.bmp',
      'installerSidebar.bmp',
      'installer.nsh',
    ]) {
      expect(existsSync(join(BUILD_DIR, asset)), `build/${asset} 缺失`).toBe(true);
    }
    const nsh = readFileSync(join(BUILD_DIR, 'installer.nsh'), 'utf8');
    expect(nsh).toContain('MUI_LICENSEPAGE_RADIOBUTTONS');
    expect(nsh).toContain('customPageAfterChangeDir');
  });

  it('中英文许可协议带 UTF-8 BOM 且不含上游内核品牌（防 NSIS 乱码、防打包时改脏工作区、守 K5）', () => {
    for (const name of ['license_zh_CN.txt', 'license_en.txt']) {
      const bytes = readFileSync(join(BUILD_DIR, name));
      expect(
        bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])),
        `${name} 缺少 UTF-8 BOM`,
      ).toBe(true);
      const text = bytes.subarray(3).toString('utf8');
      expect(text).not.toMatch(/codex|openai/i);
      expect(text).toContain('THIRD_PARTY_NOTICES.md');
    }
  });
});
