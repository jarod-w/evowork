/**
 * 打包计划（M9 / R10）。
 *
 * 两条断言在这里最有价值：**按需下载的东西不许进基础包**（混进去不报错，只是悄悄胖 200MB），
 * 以及**缺证书时整体降级为未签名并把标注写进文件名**（半签名的产物比未签名的更危险）。
 */
import { describe, expect, it } from 'vitest';

import {
  artifactName,
  checkSizeBudget,
  checkTierPlacement,
  HOOK_VENDOR,
  planSigning,
  SIZE_BUDGET,
} from '../package-plan.mjs';

describe('三档运行时的边界（08 §4 / R10）', () => {
  it('**Python 办公库不许进基础包** —— 混进去不会报错，只会让安装包胖一倍', () => {
    const result = checkTierPlacement([
      'dist/main/index.js',
      'resources/kernel/codex-app-server',
      'resources/python/site-packages/openpyxl/__init__.py',
    ]);
    expect(result.ok).toBe(false);
    expect(result.message).toContain('按需下载');
  });

  it('干净的基础包通过', () => {
    expect(
      checkTierPlacement(['dist/main/index.js', 'resources/plugins/skills/charts/SKILL.md']).ok,
    ).toBe(true);
  });

  it('预算超了要红，且提示先查是不是有东西混进了基础包', () => {
    const result = checkSizeBudget('base', SIZE_BUDGET.base + 1);
    expect(result.ok).toBe(false);
    expect(result.message).toContain('按需下载');
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
});

describe('策略包的 vendor 步骤', () => {
  it('指向 hook 运行器会去找的那个路径', () => {
    expect(HOOK_VENDOR.to).toBe('plugins/hooks/evowork-policy/vendor/policy.mjs');
  });
});
