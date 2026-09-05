/**
 * 对比度计算与分档断言（01 §8）。
 *
 * ## 为什么这不是"锦上添花"
 *
 * 01 §8.1 的几条规则**不是偏好而是约束**，它们依赖四个实测数字：
 *
 * | 组合 | 实测 | 后果 |
 * |---|---|---|
 * | `--text-secondary` on `--bg-app` | **4.59** | 只剩 0.09 余量 → 侧边栏次要文字**不得再调浅**，也不得叠加透明度 |
 * | `--text-tertiary` on `--bg-app` | 2.50 | 不满足任何文本要求 → 只能用于时间戳/占位符/版本号 |
 * | `--border-default` on `--bg-surface` | 1.39 | 目标 3.0 不达标 → 这是**刻意的取舍**（§8.3），靠高对比模式兜 |
 * | `--warning` on `--warning-weak` | 2.64 | 语义色基色**不能写文字**，必须用 `-text` 变体 |
 *
 * 01 §9 验收项 5 明确要求「对比度自动化检查按 §8.1 的分档断言」，并且
 * **「不允许把默认模式的边框断言设成 3.0 然后放宽通过条件」**。这个文件就是那条验收项，
 * 而不是一个可选的工具函数集。
 */

export interface Rgb {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

/** 解析 `#RGB` / `#RRGGBB` / `rgba(r,g,b,a)`。 */
export function parseColor(value: string): Rgb {
  const hex = value.trim();
  if (hex.startsWith('#')) {
    const body = hex.slice(1);
    if (body.length === 3) {
      const [r, g, b] = [...body].map((c) => parseInt(c + c, 16));
      return { r: r ?? 0, g: g ?? 0, b: b ?? 0 };
    }
    if (body.length === 6 || body.length === 8) {
      return {
        r: parseInt(body.slice(0, 2), 16),
        g: parseInt(body.slice(2, 4), 16),
        b: parseInt(body.slice(4, 6), 16),
      };
    }
    throw new Error(`无法解析颜色：${value}`);
  }
  const match = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/i.exec(hex);
  if (match) {
    return { r: Number(match[1]), g: Number(match[2]), b: Number(match[3]) };
  }
  throw new Error(`无法解析颜色：${value}`);
}

/**
 * 把半透明色压到底色上。
 *
 * 需要它是因为 `--bg-hover` / `--bg-active` 是 rgba —— 直接拿它算对比度会得到错的数，
 * 而"悬停时文字对比度够不够"是个真实问题（列表行悬停时文字仍要可读）。
 */
export function flatten(foreground: string, background: string): Rgb {
  const alphaMatch = /^rgba?\([^)]*[,\s]+([\d.]+)\s*\)$/.exec(foreground.trim());
  const alpha = alphaMatch ? Number(alphaMatch[1]) : 1;
  if (alpha >= 1) return parseColor(foreground);
  const fg = parseColor(foreground);
  const bg = parseColor(background);
  return {
    r: fg.r * alpha + bg.r * (1 - alpha),
    g: fg.g * alpha + bg.g * (1 - alpha),
    b: fg.b * alpha + bg.b * (1 - alpha),
  };
}

/** WCAG 2.1 相对亮度。 */
export function relativeLuminance({ r, g, b }: Rgb): number {
  const channel = (value: number): number => {
    const c = value / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** 对比度（1–21）。保留两位小数，与 01 §8.2 的记法一致。 */
export function contrastRatio(foreground: string, background: string): number {
  const fg = relativeLuminance(flatten(foreground, background));
  const bg = relativeLuminance(parseColor(background));
  const lighter = Math.max(fg, bg);
  const darker = Math.min(fg, bg);
  return Math.round(((lighter + 0.05) / (darker + 0.05)) * 100) / 100;
}

/**
 * 分档要求（01 §8.1）。
 *
 * `nonText` 那一档写的是 3.0 **且默认主题达不到** —— 这是 §8.3 明确承认的取舍。
 * 断言时对默认主题的边框走 `borderDefaultTheme`（记录现状、防止**变得更差**），
 * 对高对比模式走 3.0。这么分是为了满足 §9 的
 * 「不允许把默认模式的边框断言设成 3.0 然后放宽通过条件」。
 */
export const REQUIREMENT = {
  /** 正文与任何承载信息的文字 */
  text: 4.5,
  /** 大号文字（≥18.66px 且 bold，或 ≥24px） */
  largeText: 3,
  /** 非文本元素（边框、图标、状态点）的**目标** */
  nonText: 3,
} as const;

export interface ContrastCase {
  readonly name: string;
  readonly foreground: string;
  readonly background: string;
  /** 要求的最低比值 */
  readonly min: number;
  /** 01 §8.2 记录的实测值（用于"数值没有悄悄漂"的回归） */
  readonly documented?: number;
}

export interface ContrastResult extends ContrastCase {
  readonly actual: number;
  readonly pass: boolean;
}

export function check(cases: readonly ContrastCase[]): ContrastResult[] {
  return cases.map((item) => {
    const actual = contrastRatio(item.foreground, item.background);
    return { ...item, actual, pass: actual >= item.min };
  });
}

/** 供报告用：把结果排成一张能贴进 PR 的表。 */
export function formatReport(results: readonly ContrastResult[]): string {
  const lines = ['| 组合 | 要求 | 实测 | 判定 |', '|---|---|---|---|'];
  for (const r of results) {
    lines.push(`| ${r.name} | ≥ ${r.min} | ${r.actual} | ${r.pass ? '✅' : '❌'} |`);
  }
  return lines.join('\n');
}
