/**
 * 01 §2 的 token —— **数值真源在 01，这里是它的代码形态**。
 *
 * 两者不一致时以 01 为准并回来改这里；`docs/design/ui-spec.html` 是渲染面，同理。
 *
 * ## 为什么这个文件里全是"字面量"却不违反 token-only 规则
 *
 * `@evowork/no-style-literals` 在 eslint 配置里对 `packages/tokens/**` 关闭：
 * 这里是**唯一**允许出现颜色与尺寸字面量的地方（01 §2：token 是唯一的样式来源）。
 * 组件里再出现字面量就会被 lint 拦下。
 */

// ─────────────────────────── 中性色（暖灰基调，01 §2.1）───────────────────────────
//
// 截图的底色不是纯灰，带黄绿暖偏。暗色反相时也要**保留暖偏**（+4° 黄，避免冷蓝）。

export const LIGHT_NEUTRAL = {
  'bg-app': '#F2F1EE',
  'bg-canvas': '#FCFCFA',
  'bg-surface': '#FFFFFF',
  'bg-sunken': '#F7F6F3',
  'bg-hover': 'rgba(29,29,27,.045)',
  'bg-active': 'rgba(29,29,27,.075)',
  'bg-selected': '#E9E8E4',
  'bg-inverse': '#1D1D1B',
  'text-primary': '#1F1F1D',
  'text-secondary': '#6E6D68',
  'text-tertiary': '#9B9A94',
  'text-inverse': '#FFFFFF',
  'border-subtle': '#E7E6E1',
  'border-default': '#DCDBD5',
  'border-strong': '#C9C8C1',
} as const;

export const DARK_NEUTRAL = {
  'bg-app': '#191917',
  'bg-canvas': '#1F1F1D',
  'bg-surface': '#262624',
  'bg-sunken': '#212120',
  'bg-hover': 'rgba(240,239,234,.06)',
  'bg-active': 'rgba(240,239,234,.10)',
  'bg-selected': '#33332F',
  // 反转后选中的分段控件变浅底深字
  'bg-inverse': '#F2F1EE',
  'text-primary': '#F0EFEA',
  'text-secondary': '#A8A7A0',
  'text-tertiary': '#77766F',
  'text-inverse': '#1D1D1B',
  'border-subtle': '#2F2F2C',
  'border-default': '#3A3A36',
  'border-strong': '#4A4A45',
} as const;

// ─────────────────────────── 品牌与语义色（01 §2.2）───────────────────────────
//
// **品牌层只有四项**（K5 的落点）：`accent` 系列 + appName + logo + mascot。
// 换品牌只改这四项，布局零改动。Q25 已定代码与文档统一落 EvoWork。

export const LIGHT_SEMANTIC = {
  accent: '#2FA37A',
  'accent-weak': '#E8F5EE',
  'accent-strong': '#1B6B4F',
  info: '#3B7DD8',
  'info-weak': '#E9F1FC',
  success: '#2FA37A',
  'success-weak': '#E8F5EE',
  warning: '#C98A16',
  'warning-weak': '#FBF2DE',
  danger: '#D24B3E',
  'danger-weak': '#FBECEA',

  /**
   * 语义色的**文字变体**（01 §2.2，必需不可省）。
   *
   * 上面四个基色是**图形色**（圆点、边条、进度填充），对比度只够非文本用途。
   * 任何文字都必须用下面的加深变体 —— `--warning` 在 `--warning-weak` 上只有 2.64:1。
   * 这是 01 里「最容易被忽略、后果最直接」的一条，所以测试对它逐个钉住。
   */
  'info-text': '#225CAC',
  'warning-text': '#895E0F',
  'danger-text': '#A53227',

  /**
   * 聚焦环。**不透明的 accent**，不是 `accent @ 40%`（2026-09-05 修订，已回写 01）。
   *
   * 01 §2.2 把它定义成「`--accent` @ 40%」，而 §8.3 又说它「对 `--bg-surface` 3.16 : 1，达标」——
   * 两句不能同时成立：40% 压在白底上实测只有 **1.54**，3.16 是**不透明** accent 的值。
   *
   * 按 §8.3 第 2 条的意图取不透明：那一条说聚焦态是「键盘用户的主要定位手段」，
   * 一个 1.54 : 1 的环达不到"能定位"这个要求。这是本轮唯一一处**改了 token 数值**的修订，
   * 因此在测试里同时钉住 3.16（现状）与 1.54（说明为什么不能改回 40%）。
   */
  'focus-ring': '#2FA37A',
} as const;

export const DARK_SEMANTIC = {
  accent: '#41B891',
  'accent-weak': '#18302A',
  'accent-strong': '#41B891',
  info: '#6FA5EA',
  'info-weak': '#16233A',
  success: '#41B891',
  'success-weak': '#18302A',
  warning: '#E0A93C',
  'warning-weak': '#33270F',
  danger: '#E4695C',
  'danger-weak': '#3A1E1B',
  // 暗色下 -text 变体改用**提亮**版（01 §4.5）
  'info-text': '#9BC2F2',
  'warning-text': '#EBC474',
  'danger-text': '#F0958B',
  // 暗色下用提亮的 accent（与 --accent 同值），理由同浅色：环必须能被看见
  'focus-ring': '#41B891',
} as const;

/**
 * 高对比模式（01 §8.3）。
 *
 * **只覆盖三个边框 token**，不改布局、圆角、字号 —— 它是同一套 token 的一组覆盖值，
 * 不是第二套设计。在 `prefers-contrast: more` 与设置项「高对比度」下都生效。
 */
export const LIGHT_HIGH_CONTRAST_BORDERS = {
  'border-subtle': '#A3A29B',
  'border-default': '#8A8981',
  'border-strong': '#6E6D68',
} as const;

export const DARK_HIGH_CONTRAST_BORDERS = {
  'border-subtle': '#5A5A54',
  'border-default': '#6A6961',
  'border-strong': '#A8A7A0',
} as const;

// ─────────────────────────── 尺度（01 §2.3–2.8）───────────────────────────

/** 圆角（01 §2.3） */
export const RADIUS = {
  xs: 6,
  sm: 8,
  md: 10,
  lg: 12,
  xl: 16,
  '2xl': 20,
  full: 999,
} as const;

/** 阴影（01 §2.4）。静态卡片用 xs，悬停才升到 md —— 不要一上来就打重阴影。 */
export const SHADOW = {
  xs: '0 1px 2px rgba(24,24,20,.05)',
  sm: '0 1px 3px rgba(24,24,20,.06), 0 1px 2px rgba(24,24,20,.04)',
  md: '0 4px 12px rgba(24,24,20,.08), 0 1px 3px rgba(24,24,20,.05)',
  lg: '0 12px 32px rgba(24,24,20,.12), 0 2px 8px rgba(24,24,20,.06)',
} as const;

/** 间距刻度（01 §2.5）。**不允许 10 / 14 / 18 / 22 这类中间值。** */
export const SPACE = [2, 4, 6, 8, 12, 16, 20, 24, 32, 40, 48, 64] as const;

/** 排版（01 §2.6）。中文行高不低于字号 ×1.5。 */
export const TYPE = {
  display: { size: 36, line: 44, weight: 700, tracking: '-.02em' },
  'title-1': { size: 20, line: 28, weight: 700 },
  'title-2': { size: 17, line: 24, weight: 600 },
  'body-lg': { size: 15, line: 24, weight: 400 },
  label: { size: 13, line: 20, weight: 500 },
  body: { size: 13, line: 20, weight: 400 },
  caption: { size: 12, line: 16, weight: 400 },
  micro: { size: 11, line: 14, weight: 500 },
} as const;

export const FONT_STACK = {
  cjk: '"PingFang SC", "HarmonyOS Sans SC", "Microsoft YaHei", "Noto Sans CJK SC", -apple-system, "Segoe UI", Roboto, sans-serif',
  mono: '"SF Mono", "JetBrains Mono", Menlo, Consolas, monospace',
} as const;

/** 动效（01 §2.7）。`prefers-reduced-motion` 下全部归零并保留最终态。 */
export const MOTION = {
  'dur-fast': '120ms',
  'dur-base': '180ms',
  'dur-slow': '280ms',
  'ease-out': 'cubic-bezier(.2,.8,.2,1)',
  'ease-inout': 'cubic-bezier(.4,0,.2,1)',
} as const;

/** 层级（01 §2.8） */
export const Z = {
  content: 1,
  sticky: 10,
  popover: 100,
  drawer: 200,
  modal: 300,
  /** 审批置顶条：必须高于模态之外的一切（10 §3.5） */
  approvalBar: 400,
  toast: 500,
  dragGhost: 600,
} as const;

/** 布局（01 §3.1）。内容列 800 是全局硬约束。 */
export const LAYOUT = {
  sidebarWidth: 260,
  middleWidth: 272,
  middleMin: 240,
  middleMax: 360,
  /** 全局硬约束：截图 1 的 4×191+3×12 与截图 2 的 3×258+2×12 都等于 800 */
  contentColumn: 800,
  titleBarHeight: 52,
  navItemHeight: 28,
  navRhythm: 33,
  panelNavRhythm: 32,
  itemCardWidth: 258,
  itemCardHeight: 112,
  itemCardHeightWithBadge: 128,
  caseCardWidth: 191,
  gridGap: 12,
  dataTableHeaderHeight: 40,
  dataTableRowHeight: 48,
  minWindowWidth: 1024,
  /** < 860 不支持（桌面应用，无移动端形态） */
  unsupportedWidth: 860,

  /*
   * 以下是 01 §5 各组件的固定尺寸。它们进 token 而不是写在 CSS 里，理由与其他 token 一样：
   * 01 §5 是数值真源，写进 CSS 就等于开了第二份。凡是 §5 白纸黑字给了数字的都在这儿。
   */
  /** §5.11 FilterChip */
  chipHeight: 26,
  /** §5.12 ScenarioChip */
  scenarioChipHeight: 30,
  /** §5.19 Menu 项高与最小宽 */
  menuItemHeight: 30,
  menuMinWidth: 180,
  /** §5.14 InlineSelect */
  inlineSelectHeight: 24,
  /** §5.9 SegmentedControl 轨道 */
  segmentedTrackHeight: 36,
  /** §5.13 SendButton（圆形） */
  sendButtonSize: 32,
  /** §5.13 Composer：折叠态 180，自增至 396 后内部滚动 */
  composerCollapsedHeight: 180,
  composerMaxHeight: 396,
  /** 03 §4.4 附件缩略卡 */
  attachmentHeight: 56,
  /** §5.21 CaseCard 封面 16:9（191×107） */
  caseCoverHeight: 107,
  /** §5.27 QuotaFooter */
  quotaFooterHeight: 56,
  /** §5.27 进度条高 4 */
  quotaBarHeight: 4,
  /** §5.6 PromoCard / §5.29 TipBanner 子卡 */
  promoCardHeight: 68,
  /** 04 §7：沙箱 iframe 高度上限，超出内部滚动 */
  visualizerFrameHeight: 600,
  /** §5.31 Toast 宽 320 */
  toastWidth: 320,
} as const;

/** 品牌层（K5：换品牌只改这四项）。 */
export const BRAND = {
  appName: 'EvoWork',
  /** Q25：WorkBuddy 作为候选对外名保留；改名只影响这一组 token 与文案 */
  candidateName: 'WorkBuddy',
  heroLine: 'EvoWork，我帮你',
  logo: 'assets/logo.svg',
  mascot: 'assets/mascot.svg',
} as const;
