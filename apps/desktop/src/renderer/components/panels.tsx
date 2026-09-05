/**
 * 三栏页面的中栏与主区组件（01 §5.22–§5.29）。
 *
 * 资料库（06）、自动化（07）、设置里的审计页（10 §6）三个页面共用它们 ——
 * 这正是 01 §5 那份清单存在的理由：**第 33 个组件出现前先补进清单**，
 * 而这三页一个新组件都不需要。
 */
import { useMemo, useState, type ReactNode } from 'react';

import { Badge, IconButton, PillButton, type BadgeVariant } from './primitives.js';

/** 01 §5.23 PanelHeader：中栏头，高 52（占标题栏带）。 */
export function PanelHeader({
  title,
  actions,
}: {
  readonly title: string;
  readonly actions?: ReactNode | undefined;
}) {
  return (
    <header className="ew-panel-header">
      <h2 className="ew-panel-title">{title}</h2>
      {actions ? <span className="ew-panel-actions">{actions}</span> : null}
    </header>
  );
}

/** 01 §5.24 PanelNavItem：中栏导航项，节奏 32。 */
export function PanelNavItem({
  label,
  icon,
  selected,
  badge,
  onClick,
}: {
  readonly label: string;
  readonly icon?: ReactNode | undefined;
  readonly selected?: boolean | undefined;
  /** 右侧圆点（「最近」有未读时用） */
  readonly badge?: boolean | undefined;
  readonly onClick?: (() => void) | undefined;
}) {
  return (
    <button
      type="button"
      className="ew-panel-nav-item"
      data-selected={selected ? 'true' : undefined}
      aria-current={selected ? 'page' : undefined}
      onClick={onClick}
    >
      {icon ? (
        <span className="ew-panel-nav-icon" aria-hidden="true">
          {icon}
        </span>
      ) : null}
      <span>{label}</span>
      {badge ? <span className="ew-panel-nav-dot" aria-label="有更新" /> : null}
    </button>
  );
}

/** 01 §5.25 TreeSectionHeader：「我的资料 ＋」这类。 */
export function TreeSectionHeader({
  label,
  collapsed,
  onToggle,
  onAdd,
  addLabel,
}: {
  readonly label: string;
  readonly collapsed?: boolean | undefined;
  readonly onToggle?: (() => void) | undefined;
  readonly onAdd?: (() => void) | undefined;
  readonly addLabel?: string | undefined;
}) {
  return (
    <div className="ew-tree-section-header">
      <button
        type="button"
        className="ew-tree-section-toggle"
        aria-expanded={!collapsed}
        onClick={onToggle}
      >
        <span>{label}</span>
        <span aria-hidden="true">{collapsed ? '▸' : '▾'}</span>
      </button>
      {onAdd ? <IconButton label={addLabel ?? `新建${label}`} icon="＋" onClick={onAdd} /> : null}
    </div>
  );
}

/** 01 §5.26 TreeItem：缩进 = 12 + 层级×16。 */
export function TreeItem({
  label,
  icon,
  depth = 0,
  selected,
  onClick,
  onMore,
}: {
  readonly label: string;
  readonly icon?: ReactNode | undefined;
  readonly depth?: number | undefined;
  readonly selected?: boolean | undefined;
  readonly onClick?: (() => void) | undefined;
  readonly onMore?: (() => void) | undefined;
}) {
  return (
    <div
      className="ew-tree-item"
      data-selected={selected ? 'true' : undefined}
      // 缩进用 CSS 变量而不是内联 px：token-only 规则同样管这里（01 §9）
      style={{ ['--ew-tree-depth' as string]: String(depth) }}
    >
      <button type="button" className="ew-tree-item-main" onClick={onClick}>
        {icon ? (
          <span className="ew-tree-item-icon" aria-hidden="true">
            {icon}
          </span>
        ) : null}
        <span className="ew-tree-item-label">{label}</span>
      </button>
      {onMore ? <IconButton label={`${label} 的更多操作`} icon="⋯" onClick={onMore} /> : null}
    </div>
  );
}

/** 01 §5.22 TextTabs：只靠字重与颜色区分，无下划线无底色。 */
export function TextTabs({
  items,
  value,
  onChange,
  ariaLabel,
}: {
  readonly items: readonly { readonly id: string; readonly label: string }[];
  readonly value: string;
  readonly onChange: (id: string) => void;
  readonly ariaLabel: string;
}) {
  return (
    <div className="ew-text-tabs" role="tablist" aria-label={ariaLabel}>
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          role="tab"
          aria-selected={item.id === value}
          className="ew-text-tab"
          data-selected={item.id === value ? 'true' : undefined}
          onClick={() => onChange(item.id)}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}

export interface Column<Row> {
  readonly id: string;
  readonly header: string;
  readonly render: (row: Row) => ReactNode;
  /** 可排序时给取值函数 */
  readonly sortValue?: ((row: Row) => string | number) | undefined;
  readonly align?: 'start' | 'end' | undefined;
}

/**
 * 01 §5.28 DataTable：表头 40、数据行 48。
 *
 * **行操作在悬停时从右端浮出，不占列宽**（§5.28 原话）——
 * 给操作留一列的话，每一行都会为一个大部分时间不用的东西让出空间。
 */
export function DataTable<Row extends { readonly id: string }>({
  columns,
  rows,
  ariaLabel,
  emptyState,
  rowActions,
  onRowClick,
  selectedId,
}: {
  readonly columns: readonly Column<Row>[];
  readonly rows: readonly Row[];
  readonly ariaLabel: string;
  readonly emptyState?: ReactNode | undefined;
  readonly rowActions?: ((row: Row) => ReactNode) | undefined;
  readonly onRowClick?: ((row: Row) => void) | undefined;
  readonly selectedId?: string | undefined;
}) {
  const [sort, setSort] = useState<{ id: string; direction: 'asc' | 'desc' } | undefined>();

  const sorted = useMemo(() => {
    if (!sort) return rows;
    const column = columns.find((c) => c.id === sort.id);
    if (!column?.sortValue) return rows;
    const factor = sort.direction === 'asc' ? 1 : -1;
    return [...rows].sort((a, b) => {
      const left = column.sortValue?.(a) ?? '';
      const right = column.sortValue?.(b) ?? '';
      if (left === right) return a.id.localeCompare(b.id); // 稳定排序：等值时按 id
      return left > right ? factor : -factor;
    });
  }, [rows, sort, columns]);

  if (rows.length === 0 && emptyState) return <>{emptyState}</>;

  return (
    <table className="ew-data-table" aria-label={ariaLabel}>
      <thead>
        <tr>
          {columns.map((column) => (
            <th key={column.id} data-align={column.align}>
              {column.sortValue ? (
                <button
                  type="button"
                  className="ew-data-table-sort"
                  onClick={() =>
                    setSort((current) =>
                      current?.id === column.id
                        ? { id: column.id, direction: current.direction === 'asc' ? 'desc' : 'asc' }
                        : { id: column.id, direction: 'asc' },
                    )
                  }
                  aria-label={`按${column.header}排序`}
                >
                  {column.header}
                  <span aria-hidden="true">
                    {sort?.id === column.id ? (sort.direction === 'asc' ? ' ↑' : ' ↓') : ''}
                  </span>
                </button>
              ) : (
                column.header
              )}
            </th>
          ))}
          {rowActions ? <th className="ew-data-table-actions-head" aria-label="操作" /> : null}
        </tr>
      </thead>
      <tbody>
        {sorted.map((row) => (
          <tr
            key={row.id}
            data-selected={row.id === selectedId ? 'true' : undefined}
            onClick={onRowClick ? () => onRowClick(row) : undefined}
          >
            {columns.map((column) => (
              <td key={column.id} data-align={column.align}>
                {column.render(row)}
              </td>
            ))}
            {rowActions ? <td className="ew-data-table-actions">{rowActions(row)}</td> : null}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** 01 §5.29 TipBanner：2 列子卡 + 「我知道了」，关闭后本机持久化。 */
export function TipBanner({
  title,
  icon,
  cards,
  onDismiss,
}: {
  readonly title: string;
  readonly icon?: ReactNode | undefined;
  readonly cards: readonly { readonly title: string; readonly body: string }[];
  readonly onDismiss?: (() => void) | undefined;
}) {
  return (
    <aside className="ew-tip-banner">
      <div className="ew-tip-banner-head">
        {icon ? <span aria-hidden="true">{icon}</span> : null}
        <span className="ew-tip-banner-title">{title}</span>
        <PillButton variant="ghost" onClick={onDismiss}>
          我知道了
        </PillButton>
      </div>
      <div className="ew-tip-cards">
        {cards.map((card) => (
          <div key={card.title} className="ew-tip-card">
            <p className="ew-tip-card-title">{card.title}</p>
            <p className="ew-tip-card-body">{card.body}</p>
          </div>
        ))}
      </div>
    </aside>
  );
}

/**
 * 01 §5.31 Toast：默认 4s 自动消失；**含动作或 danger 时不自动消失**。
 *
 * 后半句是关键：一个需要用户做点什么的提示自己飘走了，等于没提示。
 */
export interface ToastSpec {
  readonly id: string;
  readonly tone: 'info' | 'success' | 'warning' | 'danger';
  readonly text: string;
  readonly actionLabel?: string | undefined;
  readonly onAction?: (() => void) | undefined;
}

export const TOAST_AUTO_DISMISS_MS = 4000;
/** 同时最多 3 条，超出折叠为「另有 N 条」。 */
export const TOAST_MAX_VISIBLE = 3;

export function shouldAutoDismiss(toast: ToastSpec): boolean {
  return toast.tone !== 'danger' && toast.actionLabel === undefined;
}

export function ToastStack({
  toasts,
  onDismiss,
}: {
  readonly toasts: readonly ToastSpec[];
  readonly onDismiss: (id: string) => void;
}) {
  const visible = toasts.slice(0, TOAST_MAX_VISIBLE);
  const overflow = toasts.length - visible.length;
  const TONE_BADGE: Readonly<Record<ToastSpec['tone'], BadgeVariant>> = {
    info: 'info',
    success: 'success',
    warning: 'warning',
    danger: 'danger',
  };

  if (toasts.length === 0) return null;
  return (
    <div className="ew-toast-stack" role="status" aria-live="polite">
      {visible.map((toast) => (
        <div key={toast.id} className="ew-toast" data-tone={toast.tone}>
          <Badge variant={TONE_BADGE[toast.tone]}>
            {toast.tone === 'danger' ? '错误' : '提示'}
          </Badge>
          <span className="ew-toast-text">{toast.text}</span>
          {toast.actionLabel ? (
            <PillButton variant="ghost" onClick={toast.onAction}>
              {toast.actionLabel}
            </PillButton>
          ) : null}
          <IconButton label="关闭提示" icon="✕" onClick={() => onDismiss(toast.id)} />
        </div>
      ))}
      {overflow > 0 ? <p className="ew-toast-overflow">另有 {overflow} 条</p> : null}
    </div>
  );
}
