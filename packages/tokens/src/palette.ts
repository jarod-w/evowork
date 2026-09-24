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

// ─────────────────────────── 中性色（冷灰工作台层，01 §2.1）───────────────────────────
//
// 数值对齐 plugins/skills/ui-design 2026-09-16 基线。暗色值收录在 DARK_*，
// 产品 CSS **不注入**（C7）。

export const LIGHT_NEUTRAL = {
  'bg-app': '#f9f9f9',
  'bg-canvas': '#ffffff',
  'bg-surface': '#ffffff',
  'bg-sunken': '#f3f3f3',
  'bg-hover': '#ededed',
  'bg-active': '#dfdfdf',
  'bg-selected': '#ededed',
  'bg-inverse': '#0d0d0d',
  /** 01 §5.34 Dialog 的遮罩层。 */
  'bg-scrim': 'rgba(13,13,13,.45)',
  'text-primary': '#0d0d0d',
  'text-secondary': '#414141',
  'text-tertiary': '#8f8f8f',
  'text-inverse': '#ffffff',
  'border-subtle': 'rgba(13,13,13,.08)',
  'border-default': 'rgba(13,13,13,.12)',
  'border-strong': 'rgba(13,13,13,.14)',
} as const;

export const DARK_NEUTRAL = {
  'bg-app': '#101010',
  'bg-canvas': '#0d0d0d',
  'bg-surface': '#181818',
  'bg-sunken': '#181818',
  'bg-hover': '#212121',
  'bg-active': '#303030',
  'bg-selected': '#212121',
  'bg-inverse': '#ffffff',
  'bg-scrim': 'rgba(0,0,0,.6)',
  'text-primary': '#ffffff',
  'text-secondary': '#afafaf',
  'text-tertiary': '#8f8f8f',
  'text-inverse': '#0d0d0d',
  'border-subtle': 'rgba(255,255,255,.08)',
  'border-default': 'rgba(255,255,255,.12)',
  'border-strong': 'rgba(255,255,255,.14)',
} as const;

// ─────────────────────────── 品牌与语义色（01 §2.2）───────────────────────────
//
// **品牌层只有四项**（K5 的落点）：`accent` 系列 + appName + logo + mascot。
// 换品牌只改这四项，布局零改动。Q25 已定代码与文档统一落 EvoWork。

export const LIGHT_SEMANTIC = {
  accent: '#2FA37A',
  'accent-weak': '#E8F5EE',
  'accent-strong': '#1B6B4F',
  info: '#0169cc',
  'info-weak': '#E8F1FA',
  success: '#008635',
  'success-weak': '#E6F5EC',
  warning: '#923b0f',
  'warning-weak': '#F8EDE6',
  danger: '#ba2623',
  'danger-weak': '#FBECEA',

  /**
   * 语义色的**文字变体**（01 §2.2，必需不可省）。
   *
   * 基色首先是图形色。文字必须走这些变体 —— 即使 `--info` / `--warning` /
   * `--danger` 在当前浅色板上碰巧 ≥4.5。`--success` 在 `-weak` 上只有 4.18，
   * `--accent` 只有 2.82。
   */
  'info-text': '#014A8F',
  'success-text': '#006B2A',
  'warning-text': '#923b0f',
  'danger-text': '#9A1F1C',

  /**
   * 聚焦环。不透明的技能蓝，不是品牌绿，也不是 `focus @ 40%`。
   * 40% 压在白底上实测 1.85；不透明对 `--bg-surface` 为 5.39。
   */
  'focus-ring': '#0169cc',
} as const;

export const DARK_SEMANTIC = {
  accent: '#41B891',
  'accent-weak': '#18302A',
  'accent-strong': '#41B891',
  info: '#339cff',
  'info-weak': '#16233A',
  success: '#40c977',
  'success-weak': '#18302A',
  warning: '#ff8549',
  'warning-weak': '#33270F',
  danger: '#fa423e',
  'danger-weak': '#3A1E1B',
  'info-text': '#339cff',
  'success-text': '#40c977',
  'warning-text': '#ff8549',
  'danger-text': '#fa423e',
  'focus-ring': '#339cff',
} as const;

/**
 * 高对比模式（01 §8.3）。
 *
 * **只覆盖三个边框 token**，不改布局、圆角、字号 —— 它是同一套 token 的一组覆盖值，
 * 不是第二套设计。在 `prefers-contrast: more` 与设置项「高对比度」下都生效。
 */
export const LIGHT_HIGH_CONTRAST_BORDERS = {
  'border-subtle': '#A3A3A3',
  'border-default': '#8A8A8A',
  'border-strong': '#5D5D5D',
} as const;

export const DARK_HIGH_CONTRAST_BORDERS = {
  'border-subtle': '#5A5A5A',
  'border-default': '#8A8A8A',
  'border-strong': '#AFAFAF',
} as const;

// ─────────────────────────── 尺度（01 §2.3–2.8）───────────────────────────

/** 圆角（01 §2.3）。`--r-composer 22` 是单行输入特例，不进入间距刻度。 */
export const RADIUS = {
  xs: 4,
  sm: 6,
  md: 8,
  lg: 12,
  xl: 16,
  '2xl': 24,
  composer: 22,
  full: 999,
} as const;

/** 阴影（01 §2.4）。窗格靠发丝线；弹层、菜单、Composer 才给深度。 */
export const SHADOW = {
  xs: '0 1px 2px -1px rgb(0 0 0 / 8%)',
  sm: '0 1px 2px -1px rgb(0 0 0 / 8%)',
  md: '0 2px 4px -1px rgb(0 0 0 / 8%)',
  lg: '0 3px 8px rgb(0 0 0 / 6%), 0 0 20px rgb(0 0 0 / 5%)',
  composer: '0 0 0 1px rgb(0 0 0 / 4%), 0 2px 8px rgb(0 0 0 / 4%), 0 4px 40px 8px rgb(0 0 0 / 2%)',
} as const;

/** 间距刻度（01 §2.5）。**不允许 10 / 14 / 18 / 22 这类中间值。** */
export const SPACE = [2, 4, 6, 8, 12, 16, 20, 24, 32, 40, 48, 64] as const;

/** 排版（01 §2.6）。正文档 `body` 行高不低于字号 ×1.5。 */
export const TYPE = {
  display: { size: 28, line: 34, weight: 600 },
  hero: { size: 28, line: 34, weight: 600 },
  'title-1': { size: 20, line: 28, weight: 600 },
  'title-2': { size: 18, line: 24, weight: 600 },
  'body-lg': { size: 16, line: 24, weight: 400 },
  label: { size: 13, line: 18, weight: 500 },
  body: { size: 14, line: 21, weight: 400 },
  caption: { size: 12, line: 16, weight: 400 },
  micro: { size: 11, line: 16, weight: 500 },
} as const;

export const FONT_STACK = {
  cjk: '"PingFang SC", "HarmonyOS Sans SC", "Microsoft YaHei", "Noto Sans CJK SC", -apple-system, "Segoe UI", Roboto, sans-serif',
  mono: 'ui-monospace, "SFMono-Regular", "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
} as const;

/** 动效（01 §2.7）。`prefers-reduced-motion` 下全部归零并保留最终态。 */
export const MOTION = {
  'dur-fast': '150ms',
  'dur-base': '180ms',
  'dur-slow': '300ms',
  'ease-out': 'cubic-bezier(.19, 1, .22, 1)',
  'ease-inout': 'cubic-bezier(.65, 0, .35, 1)',
  'ease-exit': 'cubic-bezier(.8, 0, .4, 1)',
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

/** 布局（01 §3.1）。对话列 768 是散文上限；宽产物可到 896。 */
export const LAYOUT = {
  sidebarWidth: 275,
  sidebarMin: 240,
  sidebarMax: 520,
  /** 侧栏 clamp 上限：min(520, 100vw - 本值)，避免把工作区挤没。 */
  sidebarViewportGutter: 320,
  middleWidth: 272,
  middleMin: 240,
  middleMax: 360,
  /** 结果工作区：01 §3.1，默认按主窗口 42%，拖动范围 420–720。 */
  resultPaneDefault: 560,
  resultPaneMin: 420,
  resultPaneMax: 720,
  /** 键盘调整宽度时每次移动一个基础间距。 */
  resultPaneStep: 24,
  contentColumn: 768,
  artifactColumn: 896,
  titleBarHeight: 52,
  navItemHeight: 28,
  navRhythm: 32,
  panelNavRhythm: 32,
  itemCardWidth: 258,
  itemCardHeight: 112,
  itemCardHeightWithBadge: 128,
  caseCardWidth: 191,
  gridGap: 12,
  dataTableHeaderHeight: 40,
  dataTableRowHeight: 48,
  minWindowWidth: 480,
  minWindowHeight: 600,
  defaultWindowWidth: 1280,
  defaultWindowHeight: 820,
  /** 低于最小宽度时改用抽屉与单列，不承诺手机端形态。 */
  unsupportedWidth: 480,

  /*
   * 以下是 01 §5 各组件的固定尺寸。它们进 token 而不是写在 CSS 里，理由与其他 token 一样：
   * 01 §5 是数值真源，写进 CSS 就等于开了第二份。凡是 §5 白纸黑字给了数字的都在这儿。
   */
  /** §3.2 macOS 交通灯占位：left 20 起、宽 60 */
  trafficLightWidth: 60,
  /** §3.3 品牌行（logo + 名称 + AppSwitcherChip） */
  brandRowHeight: 36,
  /** §5.2 AppSwitcherChip */
  appSwitcherHeight: 26,
  /** §5.7 UserFooter 与其头像 */
  userFooterHeight: 62,
  avatarSize: 28,
  /** §5.6 PromoCard 宽 = 侧边栏内容宽（275 - 8×2） */
  sidebarContentWidth: 259,
  /** §5.13 Composer 最小外高 */
  composerMinHeight: 44,
  /*
   * 图标尺寸。§5 各处点名给了 20 / 16 / 15 / 14 / 12 五档（§5.1 图标 20、§5.20 图标 28
   * 是卡片专用），进 token 的理由与其他尺寸一样：§5 是数值真源，写死在 SVG 里就是第二份。
   */
  iconSize: 20,
  iconSizeMd: 16,
  iconSizeSm: 15,
  iconSizeXs: 14,
  chevronSize: 12,
  /** §5.11 FilterChip */
  chipHeight: 26,
  /** §5.12 ScenarioChip */
  scenarioChipHeight: 30,
  /** §5.19 Menu 项高与最小宽 */
  menuItemHeight: 30,
  menuMinWidth: 180,
  /**
   * §5.15 ModelSelect 下拉的最小宽与最大高。
   *
   * 它比通用菜单的 180 宽，是因为一行要**并排**装下两样东西：等宽的
   * `provider/model`（§5.15 规定最长 28 字符）与右侧三个能力徽标。
   * 180 之下两者挤在一起，`deepseek/deepseek-v4-flash` 会从中间折成两行，
   * 徽标又贴着折行的文字 —— 2026-09-06 截图里的"模型列表很乱"就是这个。
   *
   * 340 = 28 字等宽（约 190）+ 间距 12 + 三个徽标（约 110）+ 左右内边距 16 + 余量。
   * 高度封顶让下拉在模型变多时**自己滚**，而不是把 Composer 顶出屏幕。
   */
  modelMenuMinWidth: 340,
  modelMenuMaxHeight: 320,
  /**
   * §5.19 空菜单说明行的最大宽。
   *
   * 空菜单必须说清为什么空（见 `MenuProps.emptyHint`），而那句话往往比
   * 菜单最小宽 180 长。不封顶的话，一句两行的说明会把浮层拉成一条横幅。
   */
  menuEmptyMaxWidth: 260,
  /** §5.34 Dialog：常规宽 420，内容多时撑到 520 */
  dialogWidth: 420,
  dialogMaxWidth: 520,
  /** 05 §6 Composer「使用插件」选择器宽。锚在「+」上，不是整屏抽屉。 */
  discoverDrawerWidth: 420,
  /** §5.14 InlineSelect */
  inlineSelectHeight: 24,
  /** §5.9 SegmentedControl 轨道 */
  segmentedTrackHeight: 36,
  /** §5.13 SendButton（圆形） */
  sendButtonSize: 32,
  /** §5.13 Composer：折叠态随内容收紧，自增至 396 后内部滚动 */
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
  /** 空间记忆编辑框的最小高（02 §4.3）：约 8 行 */
  memoMinHeight: 180,
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
