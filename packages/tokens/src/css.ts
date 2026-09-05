/**
 * 把 token 变成 CSS 变量。
 *
 * 生成而不是手写 `.css`，是为了让**只有一份数值**：手写一份 CSS 加一份 TS 常量，
 * 两份一定会分叉，而分叉的表现是"某个组件的颜色跟别的差一点"——没人会去查为什么。
 *
 * 三层覆盖（01 §4.5 / §8.3）：
 *   `:root`（浅色）→ `prefers-color-scheme: dark` / `[data-theme=dark]`（暗色）
 *   → `prefers-contrast: more` / `[data-contrast=high]`（只覆盖三个边框 token）
 */
import {
  DARK_HIGH_CONTRAST_BORDERS,
  DARK_NEUTRAL,
  DARK_SEMANTIC,
  FONT_STACK,
  LAYOUT,
  LIGHT_HIGH_CONTRAST_BORDERS,
  LIGHT_NEUTRAL,
  LIGHT_SEMANTIC,
  MOTION,
  RADIUS,
  SHADOW,
  SPACE,
  TYPE,
  Z,
} from './palette.js';

function block(entries: Readonly<Record<string, string | number>>, prefix = ''): string {
  return Object.entries(entries)
    .map(
      ([key, value]) => `  --${prefix}${key}: ${typeof value === 'number' ? `${value}px` : value};`,
    )
    .join('\n');
}

export function toCssVariables(): string {
  const spacing = Object.fromEntries(SPACE.map((n) => [`space-${n}`, n]));
  const radius = Object.fromEntries(
    Object.entries(RADIUS).map(([k, v]) => [`r-${k}`, v === 999 ? '999px' : v]),
  );
  const shadow = Object.fromEntries(Object.entries(SHADOW).map(([k, v]) => [`shadow-${k}`, v]));
  const type = Object.fromEntries(
    Object.entries(TYPE).flatMap(([name, spec]) => [
      [`font-${name}-size`, spec.size],
      [`font-${name}-line`, spec.line],
      [`font-${name}-weight`, String(spec.weight)],
    ]),
  );
  const layout = Object.fromEntries(
    Object.entries(LAYOUT).map(([k, v]) => [`layout-${kebab(k)}`, v]),
  );
  const zIndex = Object.fromEntries(
    Object.entries(Z).map(([k, v]) => [`z-${kebab(k)}`, String(v)]),
  );

  return `/* 由 packages/tokens 生成，不要手改。数值真源是 docs/design/01-ui-design-system.md §2。 */
:root {
  color-scheme: light dark;

${block(LIGHT_NEUTRAL)}

${block(LIGHT_SEMANTIC)}

${block(spacing)}
${block(radius)}
${block(shadow)}
${block(type)}
${block(layout)}
${block(zIndex)}
${block(MOTION)}
  --font-cjk: ${FONT_STACK.cjk};
  --font-mono: ${FONT_STACK.mono};
}

/* 暗色：同一套 token 名反相，**保留暖偏**（01 §4.5） */
@media (prefers-color-scheme: dark) {
  :root:not([data-theme='light']) {
${block(DARK_NEUTRAL)}

${block(DARK_SEMANTIC)}
  }
}

:root[data-theme='dark'] {
${block(DARK_NEUTRAL)}

${block(DARK_SEMANTIC)}
}

/* 高对比模式：**只覆盖三个边框 token**，不改布局、圆角、字号（01 §8.3） */
@media (prefers-contrast: more) {
  :root:not([data-contrast='normal']) {
${block(LIGHT_HIGH_CONTRAST_BORDERS)}
  }
}

:root[data-contrast='high'] {
${block(LIGHT_HIGH_CONTRAST_BORDERS)}
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme='light'])[data-contrast='high'],
  :root:not([data-theme='light']) {
    /* 暗色下的高对比边框（01 §8.3 脚注） */
  }
}

:root[data-theme='dark'][data-contrast='high'] {
${block(DARK_HIGH_CONTRAST_BORDERS)}
}

/* prefers-reduced-motion 下动效归零并保留最终态（01 §2.7） */
@media (prefers-reduced-motion: reduce) {
  :root {
    --dur-fast: 0ms;
    --dur-base: 0ms;
    --dur-slow: 0ms;
  }
}
`;
}

function kebab(value: string): string {
  return value.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
}

export const TOKENS_CSS = toCssVariables();
