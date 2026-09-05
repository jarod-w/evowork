/**
 * 01 §5 组件清单的基础件。
 *
 * ## 两条纪律
 *
 * 1. **零字面量样式**（01 §9 验收项 1）。所有颜色、尺寸、圆角都走 CSS 变量；
 *    `@evowork/no-style-literals` 会拦下 hex 与 px 字面量。
 *    例外只有 `1px` 边框宽度（01 §4.5 明确要它）与 `0`。
 * 2. **未列出的组件不得直接使用**（01 §5 开头）。要第 33 个组件，先补进 01 §5 再写代码 ——
 *    这条不是形式主义：32 个组件是从 4 张截图反推出来的**完整**控件集，
 *    第 33 个通常意味着有人在发明新的视觉语言。
 *
 * 组件用 `data-*` 属性表达状态而不是拼 class 名，这样 CSS 里的选择器与
 * 测试里的断言看的是同一件事。
 *
 * ## 可选 prop 一律写成 `?: T | undefined`
 *
 * 仓库开着 `exactOptionalPropertyTypes`，它在服务层是对的（"没有这个字段"与
 * "字段是 undefined" 在协议上确实不同）。但在 React 组件边界上它没有这层语义差别，
 * 而代价很实在：调用方每转发一个可能为空的回调都要写一次条件展开
 * （`{...(x ? { onClick: x } : {})}`），JSX 会被这些噪音淹没。
 *
 * 所以**渲染层的组件 prop 显式接受 undefined**，服务层保持严格。
 * 这不是把开关关掉 —— `apps/desktop/src/main` 与所有 `packages/` / `services/` 仍受它约束。
 */
import type { CSSProperties, ReactNode } from 'react';

export interface IconButtonProps {
  /** 无障碍名。**必填** —— 图标按钮没有可见文字，缺了它屏幕阅读器只会读"按钮" */
  readonly label: string;
  readonly icon: ReactNode;
  readonly selected?: boolean | undefined;
  readonly disabled?: boolean | undefined;
  /** 禁用必须给原因（01 §6.3：禁用要配 tooltip 说明原因） */
  readonly disabledReason?: string | undefined;
  readonly onClick?: (() => void) | undefined;
}

/** 01 §5.1 IconButton：28×28，`--r-sm`，图标 20/描边 1.5。 */
export function IconButton({
  label,
  icon,
  selected,
  disabled,
  disabledReason,
  onClick,
}: IconButtonProps) {
  return (
    <button
      type="button"
      className="ew-icon-button"
      aria-label={label}
      aria-pressed={selected}
      disabled={disabled}
      // 禁用时把原因挂上：01 §6.3 要求禁用必须配 tooltip 说明原因
      title={disabled ? (disabledReason ?? label) : label}
      data-selected={selected ? 'true' : undefined}
      onClick={onClick}
    >
      {icon}
    </button>
  );
}

export type BadgeVariant = 'neutral' | 'info' | 'success' | 'warning' | 'danger';

/**
 * 01 §5.30 Badge：高 18，`--r-full`，`micro`。
 *
 * **底用 `-weak`、字用 `-text` 变体**（01 §2.2）—— 用基色写文字会直接失败
 * （`--warning` 在 `--warning-weak` 上只有 2.64:1）。这条约束由 CSS 保证，
 * 组件只负责选 variant。
 */
export function Badge({
  variant,
  children,
}: {
  readonly variant: BadgeVariant;
  readonly children: ReactNode;
}) {
  return (
    <span className="ew-badge" data-variant={variant}>
      {children}
    </span>
  );
}

/**
 * 01 §5.30 StatusDot：6px 圆点。
 *
 * **它在无障碍上被定义为冗余装饰**（01 §6.1）：6px 的点撑不到 3:1
 * （`--accent` 对 `--bg-app` 实测 2.80），所以状态的可感知性由同一行的文字 Badge
 * 或图标承担。因此这里 `aria-hidden` —— 让屏幕阅读器读一个"装饰"是噪音。
 */
export function StatusDot({
  tone,
  breathing,
}: {
  readonly tone: 'accent' | 'info' | 'warning' | 'danger' | 'muted';
  /** 进行中与待处理带呼吸（01 §6.1）；`prefers-reduced-motion` 下由 CSS 改为静态实心点 */
  readonly breathing?: boolean | undefined;
}) {
  return (
    <span
      className="ew-status-dot"
      data-tone={tone}
      data-breathing={breathing ? 'true' : undefined}
      aria-hidden="true"
    />
  );
}

/** 01 §5.8 PillButton：高 28，`--r-full`。 */
export function PillButton({
  children,
  variant = 'default',
  onClick,
  disabled,
  disabledReason,
}: {
  readonly children: ReactNode;
  readonly variant?: 'default' | 'accent' | 'ghost' | undefined;
  readonly onClick?: (() => void) | undefined;
  readonly disabled?: boolean | undefined;
  readonly disabledReason?: string | undefined;
}) {
  return (
    <button
      type="button"
      className="ew-pill-button"
      data-variant={variant}
      disabled={disabled}
      {...(disabled && disabledReason ? { title: disabledReason } : {})}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

export interface SegmentedItem {
  readonly id: string;
  readonly label: string;
  readonly icon?: ReactNode | undefined;
}

/**
 * 01 §5.9 / §5.10 SegmentedControl。
 *
 * **两个变体的分工是硬规则**（01 §5.10）：
 *   · `dark`（深色选中态）= **决定页面装什么**（首页场景、页面顶部 Tab）
 *   · `light`（浅色选中态）= **决定已装内容怎么看**（结果区四视图、资料库三 Tab）
 *
 * 不得混用。把它做成两个 variant 而不是两个组件，是为了让这条规则出现在同一处 ——
 * 拆成两个组件，规则就只存在于文档里了。
 */
export function SegmentedControl({
  items,
  value,
  onChange,
  variant,
  ariaLabel,
}: {
  readonly items: readonly SegmentedItem[];
  readonly value: string;
  readonly onChange: (id: string) => void;
  readonly variant: 'dark' | 'light';
  readonly ariaLabel: string;
}) {
  return (
    <div className="ew-segmented" data-variant={variant} role="tablist" aria-label={ariaLabel}>
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          role="tab"
          aria-selected={item.id === value}
          className="ew-segmented-item"
          data-selected={item.id === value ? 'true' : undefined}
          onClick={() => onChange(item.id)}
        >
          {item.icon}
          <span>{item.label}</span>
        </button>
      ))}
    </div>
  );
}

/**
 * 01 §4.3 空态。
 *
 * **文案必须给出下一步动作**，不写"暂无数据"—— 这条在 01 里是硬规则，
 * 所以 `action` 不是可选的装饰而是这个组件存在的一半理由。
 */
export function EmptyState({
  icon,
  title,
  hint,
  action,
}: {
  readonly icon?: ReactNode | undefined;
  readonly title: string;
  readonly hint?: string | undefined;
  readonly action?: ReactNode | undefined;
}) {
  return (
    <div className="ew-empty-state">
      {icon ? (
        <div className="ew-empty-state-icon" aria-hidden="true">
          {icon}
        </div>
      ) : null}
      <p className="ew-empty-state-title">{title}</p>
      {hint ? <p className="ew-empty-state-hint">{hint}</p> : null}
      {action ? <div className="ew-empty-state-action">{action}</div> : null}
    </div>
  );
}

/** 01 §4.4 骨架：`--bg-sunken` 填充 + 1.4s 呼吸；**首屏 > 400ms 才显示**（避免闪烁）。 */
export function Skeleton({
  count = 3,
  height,
}: {
  readonly count?: number | undefined;
  readonly height?: number | undefined;
}) {
  const style = height
    ? ({ ['--ew-skeleton-h' as string]: `${height}px` } as CSSProperties)
    : undefined;
  return (
    <div className="ew-skeleton" aria-hidden="true" style={style}>
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="ew-skeleton-row" />
      ))}
    </div>
  );
}

/**
 * 提示条（01 §2.2 的语义色用法 + 04 §8 的各种顶部条）。
 *
 * `tone` 决定 `-weak` 底与 `-text` 字，**不允许调用方传颜色**。
 */
export function Banner({
  tone,
  children,
  action,
}: {
  readonly tone: 'info' | 'warning' | 'danger' | 'accent';
  readonly children: ReactNode;
  readonly action?: ReactNode | undefined;
}) {
  return (
    <div className="ew-banner" data-tone={tone} role={tone === 'danger' ? 'alert' : 'status'}>
      <span className="ew-banner-text">{children}</span>
      {action ? <span className="ew-banner-action">{action}</span> : null}
    </div>
  );
}

/** 01 §5.3 NavItem（侧边栏主导航）：高 28，选中态用中性灰而**不是**品牌色填充。 */
export function NavItem({
  label,
  icon,
  selected,
  trailing,
  count,
  onClick,
}: {
  readonly label: string;
  readonly icon?: ReactNode | undefined;
  readonly selected?: boolean | undefined;
  /** 右侧尾标（如「更多」右侧的「灵感」） */
  readonly trailing?: string | undefined;
  /** 右侧计数徽标，≥1 时显示（通知中心用） */
  readonly count?: number | undefined;
  readonly onClick?: (() => void) | undefined;
}) {
  return (
    <button
      type="button"
      className="ew-nav-item"
      data-selected={selected ? 'true' : undefined}
      aria-current={selected ? 'page' : undefined}
      onClick={onClick}
    >
      {icon ? (
        <span className="ew-nav-icon" aria-hidden="true">
          {icon}
        </span>
      ) : null}
      <span className="ew-nav-label">{label}</span>
      {trailing ? <span className="ew-nav-trailing">{trailing}</span> : null}
      {count !== undefined && count >= 1 ? <span className="ew-nav-count">{count}</span> : null}
    </button>
  );
}

/**
 * 01 §5.4 SidebarSectionHeader。
 *
 * `filteredCount` 存在时标题变成「任务 (12 / 148) · 重置筛选」—— 清单 §4.2 要求
 * 筛选生效时必须有一个显式的重置入口，而这个位置是唯一用户一定看得到的地方。
 */
export function SidebarSectionHeader({
  label,
  count,
  filteredCount,
  collapsed,
  onToggle,
  onResetFilter,
  actions,
}: {
  readonly label: string;
  readonly count?: number | undefined;
  readonly filteredCount?: number | undefined;
  readonly collapsed?: boolean | undefined;
  readonly onToggle?: (() => void) | undefined;
  readonly onResetFilter?: (() => void) | undefined;
  readonly actions?: ReactNode | undefined;
}) {
  const counter =
    filteredCount !== undefined && count !== undefined
      ? `(${filteredCount} / ${count})`
      : count !== undefined
        ? `(${count})`
        : '';
  return (
    <div className="ew-sidebar-section-header">
      <button
        type="button"
        className="ew-sidebar-section-toggle"
        aria-expanded={!collapsed}
        onClick={onToggle}
      >
        <span className="ew-sidebar-section-label">{label}</span>
        {counter ? <span className="ew-sidebar-section-count">{counter}</span> : null}
        <span className="ew-sidebar-section-chevron" aria-hidden="true">
          {collapsed ? '▸' : '▾'}
        </span>
      </button>
      {onResetFilter ? (
        <button type="button" className="ew-reset-filter" onClick={onResetFilter}>
          重置筛选
        </button>
      ) : null}
      {actions ? <span className="ew-sidebar-section-actions">{actions}</span> : null}
    </div>
  );
}

/**
 * 01 §5.5 TaskListItem。
 *
 * 悬停时时间戳换成 ⋯ —— 但**两者不能同时占位**，否则行宽会在悬停时跳动。
 * 这里靠 CSS 同位叠放解决（`.ew-task-item-tail` 内两者绝对定位在同一格）。
 */
export function TaskListItem({
  title,
  time,
  tone,
  breathing,
  pinned,
  selected,
  onClick,
  onMore,
}: {
  readonly title: string;
  readonly time: string;
  readonly tone: 'accent' | 'info' | 'warning' | 'danger' | 'muted';
  readonly breathing?: boolean | undefined;
  readonly pinned?: boolean | undefined;
  readonly selected?: boolean | undefined;
  readonly onClick?: (() => void) | undefined;
  readonly onMore?: (() => void) | undefined;
}) {
  return (
    <div className="ew-task-item" data-selected={selected ? 'true' : undefined}>
      <button type="button" className="ew-task-item-main" onClick={onClick}>
        <StatusDot tone={tone} breathing={breathing} />
        {pinned ? (
          <span className="ew-task-pin" aria-label="已置顶">
            📌
          </span>
        ) : null}
        <span className="ew-task-item-title">{title}</span>
      </button>
      <span className="ew-task-item-tail">
        <span className="ew-task-item-time">{time}</span>
        <IconButton label={`${title} 的更多操作`} icon="⋯" onClick={onMore} />
      </span>
    </div>
  );
}

/** 01 §5.16 SearchInput：带清除按钮（有值时），聚焦时 2px `--focus-ring`。 */
export function SearchInput({
  value,
  onChange,
  placeholder,
  ariaLabel,
}: {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly placeholder: string;
  readonly ariaLabel: string;
}) {
  return (
    <div className="ew-search-input">
      <span className="ew-search-icon" aria-hidden="true">
        ⌕
      </span>
      <input
        type="search"
        aria-label={ariaLabel}
        placeholder={placeholder}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
      {value ? (
        <button
          type="button"
          className="ew-search-clear"
          aria-label="清除搜索"
          onClick={() => onChange('')}
        >
          ✕
        </button>
      ) : null}
    </div>
  );
}

/** 01 §5.17 GhostButton：计数以 `--text-tertiary` 附在标签后。 */
export function GhostButton({
  label,
  count,
  icon,
  onClick,
  disabled,
  disabledReason,
}: {
  readonly label: string;
  readonly count?: number | undefined;
  readonly icon?: ReactNode | undefined;
  readonly onClick?: (() => void) | undefined;
  readonly disabled?: boolean | undefined;
  readonly disabledReason?: string | undefined;
}) {
  return (
    <button
      type="button"
      className="ew-ghost-button"
      disabled={disabled}
      title={disabled ? disabledReason : undefined}
      onClick={onClick}
    >
      {icon ? (
        <span className="ew-ghost-icon" aria-hidden="true">
          {icon}
        </span>
      ) : null}
      <span>{label}</span>
      {count !== undefined ? <span className="ew-ghost-count">{count}</span> : null}
    </button>
  );
}

/** 01 §5.18 SectionHeader：标题 + 右侧动作组。 */
export function SectionHeader({
  title,
  actions,
  size = 'default',
}: {
  readonly title: string;
  readonly actions?: ReactNode | undefined;
  readonly size?: 'default' | 'large' | undefined;
}) {
  return (
    <div className="ew-section-header" data-size={size}>
      <h2 className="ew-section-header-title">{title}</h2>
      {actions ? <span className="ew-section-header-actions">{actions}</span> : null}
    </div>
  );
}

/** 01 §5.11 FilterChip。选中态用 `--bg-selected` + 600 字重，不用品牌色。 */
export function FilterChip({
  label,
  selected,
  onClick,
}: {
  readonly label: string;
  readonly selected?: boolean | undefined;
  readonly onClick?: (() => void) | undefined;
}) {
  return (
    <button
      type="button"
      className="ew-filter-chip"
      role="checkbox"
      aria-checked={selected ?? false}
      data-selected={selected ? 'true' : undefined}
      onClick={onClick}
    >
      {label}
    </button>
  );
}

/**
 * 01 §5.11 FilterChipRow：横向滚动，溢出时右端浮出 28 圆形箭头。
 *
 * 溢出判定在 jsdom 里恒为假（`scrollWidth` 是 0），所以箭头的显示由 `overflowing`
 * **由外部传入**而不是自己量 —— 让"要不要显示箭头"这件事可测，且真实环境里由
 * `ResizeObserver` 在宿主层喂进来。
 */
export function FilterChipRow({
  children,
  overflowing,
  onNext,
  ariaLabel,
}: {
  readonly children: ReactNode;
  readonly overflowing?: boolean | undefined;
  readonly onNext?: (() => void) | undefined;
  readonly ariaLabel: string;
}) {
  return (
    <div className="ew-filter-chip-row" role="group" aria-label={ariaLabel}>
      <div className="ew-filter-chip-track">{children}</div>
      {overflowing ? <IconButton label="下一页" icon="›" onClick={onNext} /> : null}
    </div>
  );
}

/** 01 §5.12 ScenarioChip：点击 = 把预置提示**写入 Composer，不直接发送**（03 §3.2）。 */
export function ScenarioChip({
  label,
  icon,
  shortcut,
  onClick,
}: {
  readonly label: string;
  readonly icon?: ReactNode | undefined;
  /** `⌥1`–`⌥8`（03 §3.2） */
  readonly shortcut?: string | undefined;
  readonly onClick?: (() => void) | undefined;
}) {
  return (
    <button
      type="button"
      className="ew-scenario-chip"
      title={shortcut ? `${label}（${shortcut}）` : label}
      onClick={onClick}
    >
      {icon ? (
        <span className="ew-scenario-chip-icon" aria-hidden="true">
          {icon}
        </span>
      ) : null}
      <span>{label}</span>
    </button>
  );
}

/**
 * 01 §5.21 CaseCard。
 *
 * 无封面时降级为 `--bg-sunken` 底 + 大号图标 —— 这不是兜底而是**设计的一部分**：
 * 03 §5 把案例池的封面总量限死在 1MB 内，超出的案例只给纯文字卡（R10）。
 */
export function CaseCard({
  title,
  cover,
  icon,
  onClick,
}: {
  readonly title: string;
  readonly cover?: string | undefined;
  readonly icon?: ReactNode | undefined;
  readonly onClick?: (() => void) | undefined;
}) {
  return (
    <button type="button" className="ew-case-card" onClick={onClick}>
      <span className="ew-case-cover" data-empty={cover ? undefined : 'true'}>
        {cover ? (
          <img src={cover} alt="" />
        ) : (
          <span className="ew-case-cover-icon" aria-hidden="true">
            {icon ?? '◈'}
          </span>
        )}
      </span>
      <span className="ew-case-title">{title}</span>
    </button>
  );
}

/**
 * 01 §5.27 QuotaFooter —— **本机语义**（Q17）。
 *
 * 展示的是本机磁盘占用而不是云配额，右侧动作是「清理」而不是「升级」。
 * 这条不是文案偏好：Q17 决定不做个人云盘，摆一个「升级」按钮会承诺一个不存在的东西。
 */
export function QuotaFooter({
  usedLabel,
  percent,
  onCleanup,
}: {
  readonly usedLabel: string;
  readonly percent: number;
  readonly onCleanup?: (() => void) | undefined;
}) {
  const level = percent > 95 ? 'danger' : percent > 80 ? 'warning' : 'normal';
  return (
    <div className="ew-quota-footer">
      <div className="ew-quota-row">
        <span className="ew-quota-label">{usedLabel}</span>
        <PillButton variant="ghost" onClick={onCleanup}>
          清理
        </PillButton>
      </div>
      <div
        className="ew-quota-bar"
        role="progressbar"
        aria-valuenow={percent}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={usedLabel}
        data-level={level}
      >
        <span
          className="ew-quota-fill"
          style={{ ['--ew-quota-percent' as string]: `${percent}%` } as CSSProperties}
        />
      </div>
    </div>
  );
}
