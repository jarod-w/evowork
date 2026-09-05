/**
 * @evowork/tokens —— 01 §2 的 design token。
 *
 * **01 是数值真源**，这里是它的代码形态，`docs/design/ui-spec.html` 是渲染面。
 * 三者不一致时以 01 为准。
 *
 * 这个包被两处使用（因此它在 `packages/` 而不是前端里）：
 *   · `apps/desktop` 渲染层
 *   · `plugins/skills/charts`（08 §5.2：图表配色来自 01 §2 token）
 */
export {
  check,
  contrastRatio,
  flatten,
  formatReport,
  parseColor,
  relativeLuminance,
  REQUIREMENT,
  type ContrastCase,
  type ContrastResult,
  type Rgb,
} from './contrast.js';
export {
  BRAND,
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
export { toCssVariables, TOKENS_CSS } from './css.js';
