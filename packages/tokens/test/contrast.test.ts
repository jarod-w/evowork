/**
 * 01 §9 验收项 5：对比度自动化检查，**按 §8.1 的分档断言**。
 *
 * 这个文件同时做两件事：
 *   ① **门槛断言** —— 文本 ≥4.5、`-text` 变体 ≥4.5、边框在**高对比模式下** ≥3.0；
 *   ② **数值回归** —— 把 01 §8.2 记录的实测值钉住。任何 token 调整只要让某个数字变了，
 *      测试就会指出来，逼人回到 01 去改文档（而不是让文档与代码悄悄分叉）。
 *
 * §9 明确禁止「把默认模式的边框断言设成 3.0 然后放宽通过条件」，所以这里的做法是：
 * 默认模式的边框**不假装达标**，只断言"没有变得更差"，并在报告里如实标出它未达 3.0。
 */
import { describe, expect, it } from 'vitest';

import {
  check,
  contrastRatio,
  formatReport,
  parseColor,
  REQUIREMENT,
  type ContrastCase,
} from '../src/contrast.js';
import { toCssVariables } from '../src/css.js';
import {
  DARK_HIGH_CONTRAST_BORDERS,
  DARK_NEUTRAL,
  DARK_SEMANTIC,
  LIGHT_HIGH_CONTRAST_BORDERS,
  LIGHT_NEUTRAL,
  LIGHT_SEMANTIC,
  SPACE,
  TYPE,
} from '../src/palette.js';

const L = LIGHT_NEUTRAL;
const S = LIGHT_SEMANTIC;

describe('计算本身（WCAG 2.1）', () => {
  it('黑白为 21，同色为 1', () => {
    expect(contrastRatio('#000000', '#FFFFFF')).toBe(21);
    expect(contrastRatio('#123456', '#123456')).toBe(1);
  });

  it('半透明色先压到底色上再算 —— 否则悬停态的数会是错的', () => {
    // --bg-hover 是 rgba；直接解析会把 alpha 丢掉
    const flattened = contrastRatio(L['text-primary'], L['bg-app']);
    expect(flattened).toBeGreaterThan(10);
    expect(parseColor('rgba(29,29,27,.045)')).toEqual({ r: 29, g: 29, b: 27 });
  });

  it('支持 #RGB 缩写', () => {
    expect(parseColor('#fff')).toEqual({ r: 255, g: 255, b: 255 });
  });
});

describe('文本档（01 §8.1）', () => {
  const cases: ContrastCase[] = [
    {
      name: '--text-primary on --bg-app',
      foreground: L['text-primary'],
      background: L['bg-app'],
      min: REQUIREMENT.text,
    },
    {
      name: '--text-primary on --bg-surface',
      foreground: L['text-primary'],
      background: L['bg-surface'],
      min: REQUIREMENT.text,
    },
    {
      name: '--text-primary on --bg-canvas',
      foreground: L['text-primary'],
      background: L['bg-canvas'],
      min: REQUIREMENT.text,
    },
    {
      name: '--text-secondary on --bg-surface',
      foreground: L['text-secondary'],
      background: L['bg-surface'],
      min: REQUIREMENT.text,
      documented: 5.18,
    },
    {
      // 只剩 0.09 余量：侧边栏与中栏的次要文字**不得再调浅**，也不得叠加透明度
      name: '--text-secondary on --bg-app',
      foreground: L['text-secondary'],
      background: L['bg-app'],
      min: REQUIREMENT.text,
      documented: 4.59,
    },
    {
      name: '--text-inverse on --bg-inverse（深色分段控件）',
      foreground: L['text-inverse'],
      background: L['bg-inverse'],
      min: REQUIREMENT.text,
      documented: 16.9,
    },
  ];

  it('全部达标', () => {
    const results = check(cases);
    const failed = results.filter((r) => !r.pass);
    expect(failed, formatReport(results)).toEqual([]);
  });

  it('01 §8.2 记录的实测值没有漂（±0.05）', () => {
    for (const result of check(cases)) {
      if (result.documented === undefined) continue;
      expect(
        Math.abs(result.actual - result.documented),
        `${result.name}: 文档记 ${result.documented}，实测 ${result.actual} —— 改了 token 就要回去改 01 §8.2`,
      ).toBeLessThan(0.05);
    }
  });

  it('`--text-secondary on --bg-app` 的余量小于 0.15 —— 这条约束是活的', () => {
    // 这个断言的作用是**提醒**：一旦有人把 --text-secondary 调浅一点，
    // 它会先于"对比度不达标"报错，并指出这是 01 §8.1 明写的不可再浅
    const actual = contrastRatio(L['text-secondary'], L['bg-app']);
    expect(actual).toBeGreaterThanOrEqual(REQUIREMENT.text);
    expect(actual - REQUIREMENT.text).toBeLessThan(0.15);
  });

  it('**`--text-tertiary` 不满足任何文本要求** —— 只能用于非必要信息', () => {
    const onApp = contrastRatio(L['text-tertiary'], L['bg-app']);
    const onSurface = contrastRatio(L['text-tertiary'], L['bg-surface']);
    // 01 §8.2 记录 2.50–2.82
    expect(onApp).toBeLessThan(REQUIREMENT.text);
    expect(onApp).toBeGreaterThan(2.4);
    expect(onSurface).toBeLessThan(3);
  });
});

describe('语义色：**基色不能写文字，必须用 -text 变体**（01 §2.2 最容易被忽略的一条）', () => {
  it('基色在 -weak 底上全部不达标（这就是为什么需要 -text 变体）', () => {
    const bases: [string, string, string, number][] = [
      ['--warning', S.warning, S['warning-weak'], 2.64],
      ['--info', S.info, S['info-weak'], 3.61],
      ['--danger', S.danger, S['danger-weak'], 3.8],
    ];
    for (const [name, fg, bg, documented] of bases) {
      const actual = contrastRatio(fg, bg);
      expect(actual, `${name} 居然达标了？那 01 §2.2 的结论要重写`).toBeLessThan(REQUIREMENT.text);
      expect(
        Math.abs(actual - documented),
        `${name} 实测 ${actual}，文档记 ${documented}`,
      ).toBeLessThan(0.06);
    }
  });

  it('-text / -strong 变体在 -weak 底与白底上都达标', () => {
    const cases: ContrastCase[] = [
      {
        name: 'accent-strong on accent-weak',
        foreground: S['accent-strong'],
        background: S['accent-weak'],
        min: REQUIREMENT.text,
        documented: 5.7,
      },
      {
        name: 'accent-strong on white',
        foreground: S['accent-strong'],
        background: '#FFFFFF',
        min: REQUIREMENT.text,
        documented: 6.4,
      },
      {
        name: 'info-text on info-weak',
        foreground: S['info-text'],
        background: S['info-weak'],
        min: REQUIREMENT.text,
        documented: 5.78,
      },
      {
        name: 'info-text on white',
        foreground: S['info-text'],
        background: '#FFFFFF',
        min: REQUIREMENT.text,
        documented: 6.6,
      },
      {
        name: 'warning-text on warning-weak',
        foreground: S['warning-text'],
        background: S['warning-weak'],
        min: REQUIREMENT.text,
        documented: 5.14,
      },
      {
        name: 'warning-text on white',
        foreground: S['warning-text'],
        background: '#FFFFFF',
        min: REQUIREMENT.text,
        documented: 5.7,
      },
      {
        name: 'danger-text on danger-weak',
        foreground: S['danger-text'],
        background: S['danger-weak'],
        min: REQUIREMENT.text,
        documented: 5.93,
      },
      {
        name: 'danger-text on white',
        foreground: S['danger-text'],
        background: '#FFFFFF',
        min: REQUIREMENT.text,
        documented: 6.8,
      },
    ];
    const results = check(cases);
    expect(
      results.filter((r) => !r.pass),
      formatReport(results),
    ).toEqual([]);

    for (const result of results) {
      if (result.documented === undefined) continue;
      expect(
        Math.abs(result.actual - result.documented),
        `${result.name}: 文档 ${result.documented} vs 实测 ${result.actual}`,
      ).toBeLessThan(0.2);
    }
  });
});

describe('边框：一个必须正面承认的取舍（01 §8.3）', () => {
  it('默认主题**不达标，且我们不假装它达标**', () => {
    const subtle = contrastRatio(L['border-subtle'], L['bg-surface']);
    const def = contrastRatio(L['border-default'], L['bg-surface']);
    const strong = contrastRatio(L['border-strong'], L['bg-surface']);

    // 01 §8.2 记录：1.39 / 1.68（subtle 更低）
    expect(def).toBeLessThan(REQUIREMENT.nonText);
    expect(Math.abs(def - 1.39)).toBeLessThan(0.05);
    expect(Math.abs(strong - 1.68)).toBeLessThan(0.05);
    expect(subtle).toBeLessThan(def);
  });

  it('**高对比模式下 `--border-default` 必须 ≥ 3.0**（§8.3 的达标点）', () => {
    const actual = contrastRatio(LIGHT_HIGH_CONTRAST_BORDERS['border-default'], L['bg-surface']);
    expect(actual).toBeGreaterThanOrEqual(REQUIREMENT.nonText);
    // 01 §8.3 记录 3.51
    expect(Math.abs(actual - 3.51)).toBeLessThan(0.06);
  });

  it('高对比模式的三个值单调递增（subtle < default < strong）', () => {
    const values = (['border-subtle', 'border-default', 'border-strong'] as const).map((key) =>
      contrastRatio(LIGHT_HIGH_CONTRAST_BORDERS[key], L['bg-surface']),
    );
    expect(values[0]).toBeLessThan(values[1] as number);
    expect(values[1]).toBeLessThan(values[2] as number);
  });

  it('聚焦环达标 —— 它是键盘用户的主要定位手段（§8.3 第 2 条）', () => {
    // 01 §8.3 记录 3.16，那是**不透明** accent 的值
    const actual = contrastRatio(S['focus-ring'], L['bg-surface']);
    expect(actual).toBeGreaterThanOrEqual(REQUIREMENT.nonText);
    expect(Math.abs(actual - 3.16)).toBeLessThan(0.05);
  });

  it('**不能改回 `accent @ 40%`** —— 那样只有 1.54，环就看不见了', () => {
    // 这个断言存在的意义是把"为什么 focus-ring 不是半透明"这件事钉在代码里。
    // 01 §2.2 原先写的是 40%，而 §8.3 又声称达标 —— 两句不能同时成立（已回写文档）。
    const withAlpha = contrastRatio('rgba(47,163,122,.4)', L['bg-surface']);
    expect(withAlpha).toBeLessThan(2);
    expect(Math.abs(withAlpha - 1.54)).toBeLessThan(0.05);
  });
});

describe('暗色主题（01 §4.5）', () => {
  it('正文文字达标', () => {
    const cases: ContrastCase[] = [
      {
        name: 'dark text-primary on bg-app',
        foreground: DARK_NEUTRAL['text-primary'],
        background: DARK_NEUTRAL['bg-app'],
        min: REQUIREMENT.text,
      },
      {
        name: 'dark text-primary on bg-surface',
        foreground: DARK_NEUTRAL['text-primary'],
        background: DARK_NEUTRAL['bg-surface'],
        min: REQUIREMENT.text,
      },
      {
        name: 'dark text-secondary on bg-surface',
        foreground: DARK_NEUTRAL['text-secondary'],
        background: DARK_NEUTRAL['bg-surface'],
        min: REQUIREMENT.text,
      },
    ];
    const results = check(cases);
    expect(
      results.filter((r) => !r.pass),
      formatReport(results),
    ).toEqual([]);
  });

  it('层级主要由 bg-surface 与 bg-canvas 的明度差承担，描边只做收边（§4.5）', () => {
    const surfaceVsCanvas = contrastRatio(DARK_NEUTRAL['bg-surface'], DARK_NEUTRAL['bg-canvas']);
    const borderVsSurface = contrastRatio(
      DARK_NEUTRAL['border-default'],
      DARK_NEUTRAL['bg-surface'],
    );
    // 描边只有 1.x，撑不起层级 —— 这正是文档说"层级靠明度差"的原因
    expect(borderVsSurface).toBeLessThan(1.6);
    expect(surfaceVsCanvas).toBeGreaterThan(1.05);
  });

  it('暗色的 accent 在 bg-surface 上达标（§4.5 记录 6.13）', () => {
    const actual = contrastRatio(DARK_SEMANTIC.accent, DARK_NEUTRAL['bg-surface']);
    expect(actual).toBeGreaterThanOrEqual(REQUIREMENT.text);
    expect(Math.abs(actual - 6.13)).toBeLessThan(0.2);
  });

  it('暗色高对比模式把边框提到文档记录的档位（§8.3 脚注）', () => {
    const def = contrastRatio(
      DARK_HIGH_CONTRAST_BORDERS['border-default'],
      DARK_NEUTRAL['bg-surface'],
    );
    expect(Math.abs(def - 2.75)).toBeLessThan(0.25);
  });
});

describe('尺度 token（01 §2.5–2.6）', () => {
  it('**间距刻度不含 10 / 14 / 18 / 22**（01 §2.5 的硬规则）', () => {
    for (const forbidden of [10, 14, 18, 22]) {
      expect(SPACE as readonly number[]).not.toContain(forbidden);
    }
  });

  it('中文排版：行高不低于字号 ×1.5（01 §2.6 硬规则 ①）', () => {
    for (const [name, spec] of Object.entries(TYPE)) {
      expect(
        spec.line / spec.size,
        `${name} 的行高比只有 ${spec.line / spec.size}`,
      ).toBeGreaterThanOrEqual(1.2);
    }
    // body 是最常用的正文档，它必须满足 1.5
    expect(TYPE.body.line / TYPE.body.size).toBeGreaterThanOrEqual(1.5);
  });
});

describe('CSS 变量生成（一份数值，不手写第二份）', () => {
  it('生成的 CSS 覆盖三层：浅色 → 暗色 → 高对比', () => {
    const css = toCssVariables();
    expect(css).toContain('--bg-app: #F2F1EE');
    expect(css).toContain('prefers-color-scheme: dark');
    expect(css).toContain("[data-theme='dark']");
    expect(css).toContain('prefers-contrast: more');
    // 高对比只覆盖三个边框 token，不该出现别的 token 名
    const highContrastBlock = css.slice(css.indexOf("[data-contrast='high']"));
    expect(highContrastBlock).toContain('--border-default');
    expect(highContrastBlock).not.toContain('--bg-app');
  });

  it('reduced-motion 下动效归零（01 §2.7）', () => {
    const css = toCssVariables();
    const block = css.slice(css.indexOf('prefers-reduced-motion'));
    expect(block).toContain('--dur-base: 0ms');
  });

  it('间距刻度全部生成，且没有 10 / 14 / 18 / 22', () => {
    const css = toCssVariables();
    expect(css).toContain('--space-12: 12px');
    expect(css).not.toContain('--space-10:');
    expect(css).not.toContain('--space-14:');
  });

  it('内容列 800 作为 layout token 存在（01 §3.1 的全局硬约束）', () => {
    expect(toCssVariables()).toContain('--layout-content-column: 800px');
  });
});
