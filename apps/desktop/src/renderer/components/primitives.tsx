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
import { useState } from 'react';
import type { CSSProperties, KeyboardEvent, ReactNode } from 'react';

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
  icon,
  trailing,
  onClick,
  disabled,
  disabledReason,
}: {
  readonly children: ReactNode;
  readonly variant?: 'default' | 'accent' | 'ghost' | undefined;
  /** §5.8 的「可选图标 14」 */
  readonly icon?: ReactNode | undefined;
  /** §5.8 的「可选 chevron/箭头 12」 */
  readonly trailing?: ReactNode | undefined;
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
      {icon ? (
        <span className="ew-pill-icon" aria-hidden="true">
          {icon}
        </span>
      ) : null}
      <span className="ew-pill-label">{children}</span>
      {trailing ? (
        <span className="ew-pill-trailing" aria-hidden="true">
          {trailing}
        </span>
      ) : null}
    </button>
  );
}

/**
 * 01 §5.2 AppSwitcherChip（「发现应用」）：高 26，`--r-full`，图标 14 + caption + chevron 12。
 *
 * 它在截图里紧挨着品牌名，是侧边栏顶部那一行的另一半 —— 没有它，品牌行只剩一个名字，
 * 整条左栏的重心就散了。点击展开应用目录抽屉（05 §6，本期未实现时不给 onClick）。
 */
export function AppSwitcherChip({
  label,
  icon,
  onClick,
}: {
  readonly label: string;
  readonly icon?: ReactNode | undefined;
  readonly onClick?: (() => void) | undefined;
}) {
  return (
    <button
      type="button"
      className="ew-app-switcher"
      onClick={onClick}
      disabled={onClick === undefined}
      title={onClick === undefined ? `${label}（本期未开放）` : label}
    >
      {icon ? (
        <span className="ew-app-switcher-icon" aria-hidden="true">
          {icon}
        </span>
      ) : null}
      <span>{label}</span>
      <span className="ew-app-switcher-chevron" aria-hidden="true">
        {chevron()}
      </span>
    </button>
  );
}

/**
 * 01 §5.6 PromoCard（运营位卡）。
 *
 * **Q18：只渲染静态内容，禁任何行为回传。** 所以这里没有 `onImpression`、没有 `onClickTrack`，
 * 连 `href` 都不收 —— 有了回传通道，"默认关闭"就只是个配置项而不是结构性保证。
 * 关闭动作是本机的（调用方持久化），不通知任何人。
 */
export function PromoCard({
  title,
  body,
  actionLabel,
  onClose,
}: {
  readonly title: string;
  readonly body: string;
  readonly actionLabel?: string | undefined;
  readonly onClose?: (() => void) | undefined;
}) {
  return (
    <div className="ew-promo-card" data-slot="sidebar-promo">
      <div className="ew-promo-text">
        <p className="ew-promo-title">{title}</p>
        <p className="ew-promo-body">{body}</p>
      </div>
      {actionLabel ? <span className="ew-promo-action">{actionLabel}</span> : null}
      {onClose ? (
        <button type="button" className="ew-promo-close" aria-label="关闭运营位" onClick={onClose}>
          ✕
        </button>
      ) : null}
    </div>
  );
}

/**
 * 01 §5.7 UserFooter：高 62，头像 28 + 名称/版本两行 + 通知与设备两个 IconButton。
 *
 * 版本号显示在这里是刻意的：这是一个**本机应用**（Q1=A），"我装的是哪一版"
 * 是用户报障时唯一能自己回答的问题。
 */
export function UserFooter({
  name,
  version,
  unreadCount,
  notificationIcon,
  deviceIcon,
  onNotifications,
  onDevices,
}: {
  readonly name: string;
  readonly version: string;
  readonly unreadCount?: number | undefined;
  readonly notificationIcon?: ReactNode | undefined;
  readonly deviceIcon?: ReactNode | undefined;
  readonly onNotifications?: (() => void) | undefined;
  readonly onDevices?: (() => void) | undefined;
}) {
  const unread = unreadCount !== undefined && unreadCount > 0;
  return (
    <div className="ew-user-footer">
      <span className="ew-avatar" aria-hidden="true">
        {name.slice(0, 1)}
      </span>
      <span className="ew-user-text">
        <span className="ew-user-name">{name}</span>
        <span className="ew-user-version">{version}</span>
      </span>
      <span className="ew-user-actions">
        <span className="ew-notify-anchor" data-unread={unread ? 'true' : undefined}>
          <IconButton
            label={unread ? `通知中心（${unreadCount} 条未读）` : '通知中心'}
            icon={notificationIcon ?? '🔔'}
            onClick={onNotifications}
          />
        </span>
        <IconButton label="设备中心" icon={deviceIcon ?? '🖥'} onClick={onDevices} />
      </span>
    </div>
  );
}

/** AppSwitcherChip 的 chevron。单独一个函数，免得图标集与基础件互相 import。 */
function chevron(): ReactNode {
  return (
    <svg
      className="ew-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M6.75 9.75 12 15l5.25-5.25" />
    </svg>
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

/**
 * 01 §5.35 SecretInput：密钥录入（M10a）。
 *
 * ## 为什么不是 `SearchInput` 加一个 `secret` prop
 *
 * `SearchInput` 的值是可读回的（受控 `value`），而密钥的"不可读回"是一条
 * **安全属性**。做成同一个组件的 prop，就存在"某处忘了传那个 prop"这种失败方式，
 * 而它的表现是密钥出现在渲染进程里 —— 等于出现在任何一个 XSS 面上（11 §12 第 2 条）。
 * 两个组件的话，这种失败方式在类型层面就不存在。
 *
 * ## 三种状态是三件不同的事
 *
 *   ① 空       —— 一个 `type=password` 输入框；
 *   ② 刚粘贴   —— 出现「保存」；形状不对时**给提示但不拦保存**（厂商随时会改 key 的
 *                 形状，拦下来的代价是用户拿着一把有效的 key 进不去）；
 *   ③ 已保存   —— 只显示后四位 + 「更换」「清除」。**没有读回路径**。
 *
 * **没有"显示密码"的小眼睛**：它要求组件持有明文并渲染出来。用户想确认自己贴对了，
 * 靠的是后四位与一次连通性检查 —— 旁边可能坐着别人。
 */
export function SecretInput({
  label,
  saved,
  last4,
  hint,
  disabled,
  onSave,
  onClear,
}: {
  readonly label: string;
  readonly saved: boolean;
  readonly last4?: string | undefined;
  /** 形状提示（如"通常以 sk- 开头"）。**只是提示** */
  readonly hint?: string | undefined;
  readonly disabled?: boolean | undefined;
  readonly onSave: (value: string) => void;
  readonly onClear?: (() => void) | undefined;
}) {
  const [draft, setDraft] = useState('');
  const [editing, setEditing] = useState(false);

  // 已保存且没在改 → ③。**不渲染任何输入框**：一个空的输入框旁边写着"已保存"，
  // 读起来像"没保存上"
  if (saved && !editing) {
    return (
      <div className="ew-field ew-secret">
        <span>{label}</span>
        <div className="ew-secret-saved">
          <span className="ew-secret-mask">已保存 · ****{last4 ?? '****'}</span>
          <PillButton onClick={() => setEditing(true)} disabled={disabled}>
            更换
          </PillButton>
          {onClear ? (
            <PillButton onClick={onClear} disabled={disabled}>
              清除
            </PillButton>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <div className="ew-field ew-secret">
      <span>{label}</span>
      <div className="ew-secret-row">
        <input
          type="password"
          autoComplete="off"
          spellCheck={false}
          aria-label={label}
          value={draft}
          disabled={disabled}
          placeholder="粘贴 API 密钥…"
          onChange={(event) => setDraft(event.target.value)}
        />
        <PillButton
          variant="accent"
          disabled={disabled || draft.trim() === ''}
          onClick={() => {
            onSave(draft.trim());
            // 立刻清空本地草稿：**渲染层不留着这个值**
            setDraft('');
            setEditing(false);
          }}
        >
          保存
        </PillButton>
        {saved ? (
          <PillButton
            onClick={() => {
              setDraft('');
              setEditing(false);
            }}
          >
            取消
          </PillButton>
        ) : null}
      </div>
      {hint ? <p className="ew-field-hint">{hint}</p> : null}
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
  /*
   * 这条**不用 5.33 ProgressBar**：它带 >80% 转 warning、>95% 转 danger 的阈值配色，
   * 是"用量"语义而不是"进度"语义。合并会让两种含义共用一套颜色规则 ——
   * 于是一个装到 85% 的进度条会变成黄色，看起来像出了问题。
   */
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

/**
 * 5.33 ProgressBar —— 确定进度条。
 *
 * **只有确定态，没有"不确定态"**（那种永远循环的动画）。不知道进度就把"在等什么"
 * 写在旁边的文字里：一条永远在动的条会让人以为程序还活着，而它可能已经卡死了 ——
 * 办公扩展安装恰恰有过这个失败模式（下载停滞，进度停在 0%），
 * 现在由下载器的停滞看门狗在 60 秒内把它变成一条明确的失败信息。
 *
 * `label` 说的是**在进行什么**（"正在下载运行时"），不是"进度" ——
 * 读屏用户听到"进度 40%"而不知道是什么的进度，等于没听到。
 */
export function ProgressBar({
  percent,
  label,
}: {
  readonly percent: number;
  readonly label: string;
}) {
  // 越界的值不该把填充画到轨道外面去（上游算错时，界面不跟着错）
  const clamped = Math.max(0, Math.min(100, Math.round(percent)));
  return (
    <div
      className="ew-progress-bar"
      role="progressbar"
      aria-valuenow={clamped}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={label}
    >
      <span
        className="ew-progress-fill"
        style={{ ['--ew-progress-percent' as string]: `${clamped}%` } as CSSProperties}
      />
    </div>
  );
}

/**
 * 01 §5.34 Dialog（模态壳）。
 *
 * **新模态一律用它**。仓库里此前有**四处**各自搭的确认框：`views/library.tsx` 与
 * `views/sidebar.tsx`（两处共用 `ew-delete-confirm`）· `components/changes-view.tsx`
 * （`ew-revert-confirm`）· `components/composer.tsx`（`ew-danger-confirm`）。
 * 本任务只并掉 library 那一处，其余三处是记下来的债。
 *
 * **`ew-delete-confirm` 这个类名因此不能从 CSS 里删掉** —— sidebar 还在用它。
 * 而 sidebar 的测试只断言 role 与文案，删了不会有任何一条测试变红，
 * 表现是那个确认框丢掉边框背景阴影、变成浮在页面上的裸文字。
 *
 * 它不管自己什么时候出现 —— 由调用方决定挂不挂载，
 * 这样"打开着的时候按 Esc"与"根本没打开"是两个显然不同的状态，
 * 而不是一个藏在组件里的布尔。
 */
export function Dialog({
  title,
  children,
  confirmLabel,
  cancelLabel = '取消',
  variant = 'default',
  confirmDisabled,
  onConfirm,
  onCancel,
}: {
  readonly title: string;
  readonly children: ReactNode;
  readonly confirmLabel: string;
  readonly cancelLabel?: string | undefined;
  /** danger：破坏性动作。用 `alertdialog` 而不是 `dialog` */
  readonly variant?: 'default' | 'danger' | undefined;
  readonly confirmDisabled?: boolean | undefined;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}) {
  return (
    <div className="ew-dialog-scrim">
      <div
        className="ew-dialog"
        data-variant={variant}
        role={variant === 'danger' ? 'alertdialog' : 'dialog'}
        aria-label={title}
        aria-modal="true"
        tabIndex={-1}
        onKeyDown={(event) => {
          if (event.key === 'Escape') onCancel();
        }}
      >
        <p className="ew-dialog-title">{title}</p>
        <div className="ew-dialog-body">{children}</div>
        <div className="ew-dialog-actions">
          <PillButton onClick={onCancel}>{cancelLabel}</PillButton>
          <PillButton
            variant="accent"
            disabled={confirmDisabled}
            onClick={confirmDisabled ? undefined : onConfirm}
          >
            {confirmLabel}
          </PillButton>
        </div>
      </div>
    </div>
  );
}

/**
 * 01 §5.20 ItemCard。宽 258、高 112；**带角标行时 128**（项目卡变体走的就是这一档）。
 *
 * `tone="warning"` 是项目卡的路径失效态：整卡换边框色，而不是把失效信息
 * 藏进一个只有悬停才看得到的地方 —— 用户需要在列表上一眼看出哪个空间用不了。
 */
export function ItemCard({
  icon,
  name,
  description,
  badges,
  tone = 'default',
  action,
  onClick,
}: {
  readonly icon?: ReactNode | undefined;
  readonly name: string;
  readonly description: string;
  /** 角标行（§5.20：来源 · 风险等级 · 版本；项目卡用的是任务数 · 产物数 · 最近活动） */
  readonly badges?: readonly string[] | undefined;
  readonly tone?: 'default' | 'warning' | undefined;
  /** 右上角。§5.20 是 `+`，项目卡换成 `⋯` 菜单 */
  readonly action?: ReactNode | undefined;
  readonly onClick?: (() => void) | undefined;
}) {
  const hasBadges = badges !== undefined && badges.length > 0;
  return (
    <div
      className="ew-item-card"
      data-tone={tone}
      data-with-badges={hasBadges ? 'true' : undefined}
      {...(onClick ? { role: 'button', tabIndex: 0, onClick } : {})}
      {...(onClick
        ? {
            onKeyDown: (event: KeyboardEvent) => {
              if (event.key === 'Enter' || event.key === ' ') onClick();
            },
          }
        : {})}
    >
      <div className="ew-item-card-head">
        {icon ? (
          <span className="ew-item-card-icon" aria-hidden="true">
            {icon}
          </span>
        ) : null}
        <span className="ew-item-card-name">{name}</span>
        {action ? (
          /*
           * 整张卡都可点（打开详情），而 `action`（项目卡是 ⋯ 菜单）嵌在卡片内部 ——
           * 不拦一下的话，点菜单里任何一项都会向上冒泡触发卡片自己的 `onClick`，
           * 表现是"改名/移除/打开文件夹"顺带把用户跳进了详情页（Task 13 接线时
           * 实测撞到：`onOpenDetail` 一旦真的做事，这条冒泡就藏不住了）。
           */
          <span className="ew-item-card-action" onClick={(event) => event.stopPropagation()}>
            {action}
          </span>
        ) : null}
      </div>
      <p className="ew-item-card-desc">{description}</p>
      {hasBadges ? (
        <p className="ew-item-card-badges">
          {badges.map((badge) => (
            <span key={badge} className="ew-item-card-badge">
              {badge}
            </span>
          ))}
        </p>
      ) : null}
    </div>
  );
}
