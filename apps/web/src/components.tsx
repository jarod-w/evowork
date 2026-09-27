/**
 * WEB 的基础件。
 *
 * ## 为什么这里有一份，而不是直接用 `apps/desktop` 的 primitives
 *
 * 那 36 个组件锁在 `apps/desktop/src/renderer/components/` 里，跨 app 不可 import，
 * 而它们的样式散在桌面那份 4215 行的 `app.css` 里（715 条 `.ew-` 规则，大部分是视图级的）。
 * 把它们抽成 `packages/ui` 是对的方向，但那是一次会动到桌面渲染层的重构 ——
 * **先做那个，这一页就得等它**。
 *
 * 所以这里先按 01 §5 的**同一份形态规格**在 WEB 侧落一层薄的：
 * 名字、尺寸、态、禁用要给原因，全部对齐 01 §5，不发明新组件。
 * 抽 `packages/ui` 的时候这一层是被合并掉的那一半，不是要长期并存的第二套。
 *
 * ## 三条纪律
 *
 * 1. **零字面量样式**：颜色与尺寸只走 `app.css` 里的 `var(--token)`，
 *    `@evowork/no-style-literals` 在 `apps/web/src/**` 上是 error。
 * 2. **状态用 `data-*` 表达**，CSS 选择器与测试断言看的是同一件事。
 * 3. **禁用必须给原因**（01 §6.3）。`disabledReason` 不是可选的装饰 ——
 *    没有原因的禁用按钮会让人以为是 bug，然后去别处找入口。
 */
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';

/* ───────────────────────────── 图标 ───────────────────────────── */

/** 线性图标，`currentColor` 描边。没有 emoji（01 §5.19）。 */
export function Icon(props: { readonly name: IconName; readonly size?: 'sm' | 'md' }) {
  const box = props.size === 'sm' ? 'ew-icon-sm' : 'ew-icon-md';
  return (
    <svg
      className={box}
      viewBox="0 0 16 16"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {ICONS[props.name]}
    </svg>
  );
}

export type IconName =
  | 'overview'
  | 'members'
  | 'models'
  | 'usage'
  | 'policy'
  | 'search'
  | 'plus'
  | 'more'
  | 'chevron'
  | 'check'
  | 'cross'
  | 'info'
  | 'warning'
  | 'mail'
  | 'download';

const ICONS: Record<IconName, ReactNode> = {
  overview: (
    <>
      <rect x="2" y="2" width="5" height="5" rx="1" />
      <rect x="9" y="2" width="5" height="5" rx="1" />
      <rect x="2" y="9" width="5" height="5" rx="1" />
      <rect x="9" y="9" width="5" height="5" rx="1" />
    </>
  ),
  members: (
    <>
      <circle cx="6" cy="5.5" r="2.6" />
      <path d="M1.8 13.5c0-2.3 1.9-3.8 4.2-3.8s4.2 1.5 4.2 3.8" />
      <path d="M11 4.2a2.4 2.4 0 0 1 0 4.6M12.2 10.2c1.3.5 2 1.7 2 3.3" />
    </>
  ),
  models: (
    <>
      <rect x="4" y="4" width="8" height="8" rx="1.5" />
      <path d="M6.5 1.8v2.2M9.5 1.8v2.2M6.5 12v2.2M9.5 12v2.2M1.8 6.5h2.2M1.8 9.5h2.2M12 6.5h2.2M12 9.5h2.2" />
    </>
  ),
  usage: <path d="M3 13V8M8 13V3M13 13v-3.5" strokeWidth="1.8" />,
  policy: <path d="M8 1.8 13.2 4v4c0 3-2.2 5.2-5.2 6.2C5 13.2 2.8 11 2.8 8V4z" />,
  search: (
    <>
      <circle cx="7" cy="7" r="4.5" />
      <path d="m10.5 10.5 3 3" />
    </>
  ),
  plus: <path d="M8 3.5v9M3.5 8h9" strokeWidth="1.8" />,
  more: (
    <>
      <circle cx="3.5" cy="8" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="8" cy="8" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="12.5" cy="8" r="1.1" fill="currentColor" stroke="none" />
    </>
  ),
  chevron: <path d="M4.5 6.5 8 10l3.5-3.5" />,
  check: <path d="M3.5 8.5l3 3 6-7" strokeWidth="1.8" />,
  cross: <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" strokeWidth="1.8" />,
  info: (
    <>
      <circle cx="8" cy="8" r="6.5" />
      <path d="M8 7.2v4M8 4.6v.9" />
    </>
  ),
  warning: (
    <>
      <path d="M8 2.5 14.5 13.5h-13z" />
      <path d="M8 6.8v3M8 11.6v.6" />
    </>
  ),
  mail: (
    <>
      <rect x="1.5" y="3.5" width="13" height="9" rx="1.5" />
      <path d="m2 4.5 6 4.5 6-4.5" />
    </>
  ),
  download: <path d="M8 2.5v8M4.5 7.5 8 11l3.5-3.5M2.5 13.5h11" />,
};

/** 品牌标记（K5：换品牌只改这一处 + token）。 */
export function BrandMark() {
  return (
    <svg className="ew-logo" viewBox="0 0 32 32" aria-hidden="true">
      <rect x="1" y="1" width="30" height="30" rx="9" fill="var(--accent)" />
      <path
        d="M10 11h12M10 16h8M10 21h12"
        stroke="var(--text-inverse)"
        strokeWidth="2"
        strokeLinecap="round"
        fill="none"
      />
    </svg>
  );
}

/* ───────────────────────────── 按钮 ───────────────────────────── */

export type ButtonVariant = 'primary' | 'ghost' | 'danger' | 'danger-ghost' | 'quiet';

export interface ButtonProps {
  readonly children: ReactNode;
  readonly variant?: ButtonVariant | undefined;
  readonly size?: 'sm' | 'md' | 'lg' | undefined;
  readonly type?: 'button' | 'submit' | undefined;
  readonly block?: boolean | undefined;
  readonly icon?: IconName | undefined;
  /** 提交期间禁用并换文案。**不给这个，用户会连点三次**，而签发策略包是不可重复的动作。 */
  readonly busy?: boolean | undefined;
  readonly busyLabel?: string | undefined;
  readonly disabled?: boolean | undefined;
  /** 01 §6.3：禁用必须给原因。 */
  readonly disabledReason?: string | undefined;
  readonly onClick?: (() => void) | undefined;
}

export function Button(props: ButtonProps) {
  const disabled = props.disabled === true || props.busy === true;
  return (
    <button
      className="ew-btn"
      type={props.type ?? 'button'}
      data-variant={props.variant ?? 'ghost'}
      data-size={props.size ?? 'md'}
      data-block={props.block === true ? 'true' : undefined}
      disabled={disabled}
      title={props.disabled === true ? props.disabledReason : undefined}
      onClick={props.onClick}
    >
      {props.icon ? <Icon name={props.icon} size="sm" /> : null}
      {props.busy === true ? (props.busyLabel ?? '处理中…') : props.children}
    </button>
  );
}

export function IconButton(props: {
  readonly label: string;
  readonly name: IconName;
  readonly expanded?: boolean | undefined;
  readonly onClick?: (() => void) | undefined;
}) {
  return (
    <button
      className="ew-icon-btn"
      type="button"
      aria-label={props.label}
      aria-expanded={props.expanded}
      onClick={props.onClick}
    >
      <Icon name={props.name} />
    </button>
  );
}

/* ───────────────────────────── 表单 ───────────────────────────── */

export function Field(props: {
  readonly label: string;
  readonly name: string;
  readonly type?: string | undefined;
  readonly autoComplete?: string | undefined;
  readonly required?: boolean | undefined;
  readonly defaultValue?: string | undefined;
  readonly placeholder?: string | undefined;
  readonly mono?: boolean | undefined;
  readonly hint?: ReactNode | undefined;
  readonly aside?: ReactNode | undefined;
  readonly value?: string | undefined;
  readonly onChange?: ((value: string) => void) | undefined;
}) {
  const id = useId();
  return (
    <div className="ew-field">
      {props.aside ? (
        <span className="ew-label-row">
          <label className="ew-label" htmlFor={id}>
            {props.label}
          </label>
          {props.aside}
        </span>
      ) : (
        <label className="ew-label" htmlFor={id}>
          {props.label}
        </label>
      )}
      <input
        id={id}
        className="ew-input"
        name={props.name}
        type={props.type ?? 'text'}
        autoComplete={props.autoComplete}
        required={props.required === true}
        placeholder={props.placeholder}
        data-mono={props.mono === true ? 'true' : undefined}
        {...(props.value !== undefined
          ? { value: props.value, onChange: (e) => props.onChange?.(e.target.value) }
          : { defaultValue: props.defaultValue })}
      />
      {props.hint ? <span className="ew-muted">{props.hint}</span> : null}
    </div>
  );
}

/** 密码强度条。注册 / 重置 / 改密三处共用，规则在 `api.ts` 的 `passwordStrength`。 */
export function StrengthMeter(props: { readonly score: number; readonly hint: string }) {
  return (
    <>
      <span className="ew-strength" aria-hidden="true">
        {[0, 1, 2, 3].map((i) => (
          <span key={i} data-on={i < props.score ? 'true' : 'false'} />
        ))}
      </span>
      <span className="ew-muted">强度：{props.hint}</span>
    </>
  );
}

export function Select(props: {
  readonly label: string;
  readonly name: string;
  readonly options: readonly { readonly value: string; readonly label: string }[];
  readonly defaultValue?: string | undefined;
  readonly hint?: ReactNode | undefined;
}) {
  const id = useId();
  return (
    <div className="ew-field">
      <label className="ew-label" htmlFor={id}>
        {props.label}
      </label>
      <select id={id} className="ew-select" name={props.name} defaultValue={props.defaultValue}>
        {props.options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      {props.hint ? <span className="ew-muted">{props.hint}</span> : null}
    </div>
  );
}

export function Checkbox(props: {
  readonly label: ReactNode;
  readonly name?: string | undefined;
  readonly why?: ReactNode | undefined;
  readonly checked?: boolean | undefined;
  readonly defaultChecked?: boolean | undefined;
  readonly onChange?: ((checked: boolean) => void) | undefined;
}) {
  return (
    <label className="ew-check">
      <input
        type="checkbox"
        name={props.name}
        {...(props.checked !== undefined
          ? { checked: props.checked, onChange: (e) => props.onChange?.(e.target.checked) }
          : {
              defaultChecked: props.defaultChecked,
              onChange: (e) => props.onChange?.(e.target.checked),
            })}
      />
      <span>
        {props.label}
        {props.why ? <span className="ew-check-why">{props.why}</span> : null}
      </span>
    </label>
  );
}

export function SearchInput(props: {
  readonly label: string;
  readonly placeholder: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
}) {
  const id = useId();
  return (
    <span className="ew-search">
      <Icon name="search" size="sm" />
      <label className="ew-visually-hidden" htmlFor={id}>
        {props.label}
      </label>
      <input
        id={id}
        type="search"
        placeholder={props.placeholder}
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
      />
    </span>
  );
}

export function FilterChip(props: {
  readonly children: ReactNode;
  readonly selected: boolean;
  readonly onClick: () => void;
}) {
  return (
    <button className="ew-chip" type="button" aria-pressed={props.selected} onClick={props.onClick}>
      {props.children}
    </button>
  );
}

/* ───────────────────────────── 反馈件 ───────────────────────────── */

export type Tone = 'neutral' | 'accent' | 'info' | 'success' | 'warning' | 'danger';

export function Badge(props: {
  readonly children: ReactNode;
  readonly tone?: Tone | undefined;
  /** 能力缺失：划掉而不是隐藏（D2「降级必须显式」）。 */
  readonly missing?: boolean | undefined;
}) {
  return (
    <span
      className="ew-badge"
      data-tone={props.tone ?? 'neutral'}
      data-missing={props.missing === true ? 'true' : undefined}
    >
      {props.children}
    </span>
  );
}

export function StatusDot(props: { readonly tone?: Tone | undefined }) {
  return <span className="ew-dot" data-tone={props.tone ?? 'neutral'} />;
}

const BANNER_ICON: Record<Tone, IconName> = {
  neutral: 'info',
  accent: 'info',
  info: 'info',
  success: 'check',
  warning: 'warning',
  danger: 'warning',
};

export function Banner(props: {
  readonly children: ReactNode;
  readonly tone?: Tone | undefined;
  readonly action?: ReactNode | undefined;
}) {
  const tone = props.tone ?? 'neutral';
  return (
    <div className="ew-banner" data-tone={tone} role={tone === 'danger' ? 'alert' : undefined}>
      <Icon name={BANNER_ICON[tone]} size="sm" />
      <span className="ew-banner-body">
        <span>{props.children}</span>
        {props.action}
      </span>
    </div>
  );
}

export function ProgressBar(props: {
  readonly percent: number;
  readonly tone?: 'accent' | 'warning' | 'danger' | undefined;
  readonly label?: string | undefined;
}) {
  const percent = Math.max(0, Math.min(100, props.percent));
  return (
    <span
      className="ew-bar"
      data-tone={props.tone ?? 'accent'}
      role="progressbar"
      aria-valuenow={percent}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={props.label}
    >
      <span style={{ width: `${percent}%` }} />
    </span>
  );
}

/**
 * 空态。**必须给下一步动作** —— 一张没有出口的空表和加载失败长得一样。
 */
export function EmptyState(props: {
  readonly title: string;
  readonly description: string;
  readonly action?: ReactNode | undefined;
}) {
  return (
    <div className="ew-empty">
      <span className="ew-empty-icon">
        <Icon name="members" />
      </span>
      <span className="ew-cell-stack">
        <span className="ew-strong">{props.title}</span>
        <span className="ew-muted">{props.description}</span>
      </span>
      {props.action}
    </div>
  );
}

/** 骨架占住最终布局，数据到了不会整页跳一下。 */
export function SkeletonRows(props: { readonly rows?: number | undefined }) {
  const rows = props.rows ?? 4;
  return (
    <div className="ew-skeleton-rows" aria-hidden="true">
      {Array.from({ length: rows }, (_, i) => (
        <span className="ew-skeleton-row" key={i}>
          <span className="ew-skeleton" data-shape="circle" />
          <span className="ew-skeleton ew-grow" />
        </span>
      ))}
    </div>
  );
}

/**
 * 「载入中 / 出错 / 空 / 有数据」四态收成一个组件。
 *
 * 散着写的代价见过了：六个 fetch 里有四个失败被静默吞掉，表格就是空的，
 * 而"空"与"没加载出来"在界面上长得一模一样。
 */
export function Async<T>(props: {
  readonly state: AsyncState<T>;
  readonly onRetry?: (() => void) | undefined;
  readonly empty?: ReactNode | undefined;
  readonly isEmpty?: ((data: T) => boolean) | undefined;
  readonly children: (data: T) => ReactNode;
}) {
  if (props.state.status === 'loading') return <SkeletonRows />;
  if (props.state.status === 'error') {
    return (
      <Banner
        tone="danger"
        action={
          props.onRetry ? (
            <Button size="sm" onClick={props.onRetry}>
              重试
            </Button>
          ) : undefined
        }
      >
        {props.state.message}这一段没能加载，<b>下面是空的不是因为没有数据</b>。
      </Banner>
    );
  }
  if (props.isEmpty?.(props.state.data) === true && props.empty) return <>{props.empty}</>;
  return <>{props.children(props.state.data)}</>;
}

export type AsyncState<T> =
  { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; data: T };

/* ───────────────────────────── 浮层 ───────────────────────────── */

export interface MenuItem {
  readonly label: string;
  readonly tone?: 'danger' | undefined;
  readonly disabled?: boolean | undefined;
  /** 禁用要给原因（01 §6.3），它会显示在菜单底部而不是只做 tooltip。 */
  readonly disabledReason?: string | undefined;
  readonly onClick?: (() => void) | undefined;
  readonly separatorBefore?: boolean | undefined;
}

export function RowMenu(props: { readonly label: string; readonly items: readonly MenuItem[] }) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return undefined;
    function onAway(event: MouseEvent) {
      if (!anchor.current?.contains(event.target as Node)) setOpen(false);
    }
    function onEsc(event: KeyboardEvent) {
      if (event.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onAway);
    document.addEventListener('keydown', onEsc);
    return () => {
      document.removeEventListener('mousedown', onAway);
      document.removeEventListener('keydown', onEsc);
    };
  }, [open]);

  const reasons = props.items.filter((item) => item.disabled === true && item.disabledReason);

  return (
    <span className="ew-menu-anchor" ref={anchor}>
      <IconButton
        label={props.label}
        name="more"
        expanded={open}
        onClick={() => setOpen((v) => !v)}
      />
      {open ? (
        <span className="ew-menu" role="menu">
          {props.items.map((item) => (
            <span key={item.label}>
              {item.separatorBefore === true ? <span className="ew-menu-sep" /> : null}
              <button
                className="ew-menu-item"
                type="button"
                role="menuitem"
                data-tone={item.tone}
                disabled={item.disabled === true}
                title={item.disabledReason}
                onClick={() => {
                  setOpen(false);
                  item.onClick?.();
                }}
              >
                {item.label}
              </button>
            </span>
          ))}
          {reasons.map((item) => (
            <p className="ew-menu-why" key={`why-${item.label}`}>
              {item.label}不可用：{item.disabledReason}
            </p>
          ))}
        </span>
      ) : null}
    </span>
  );
}

/**
 * 模态。危险动作一律经过它 —— 「撤销策略包」点完即生效是这一页以前的样子，
 * 而那个按钮解的是全租户每台设备的锁。
 */
export function Dialog(props: {
  readonly title: string;
  readonly children: ReactNode;
  readonly wide?: boolean | undefined;
  readonly confirmLabel: string;
  readonly confirmVariant?: ButtonVariant | undefined;
  readonly confirmDisabled?: boolean | undefined;
  readonly confirmDisabledReason?: string | undefined;
  readonly busy?: boolean | undefined;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
  readonly cancelLabel?: string | undefined;
}) {
  const titleId = useId();
  useEffect(() => {
    function onEsc(event: KeyboardEvent) {
      if (event.key === 'Escape') props.onCancel();
    }
    document.addEventListener('keydown', onEsc);
    return () => document.removeEventListener('keydown', onEsc);
  }, [props]);

  return (
    <div className="ew-scrim">
      <div
        className="ew-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-wide={props.wide === true ? 'true' : undefined}
      >
        <h2 id={titleId}>{props.title}</h2>
        {props.children}
        <div className="ew-actions" data-align="end">
          <Button onClick={props.onCancel}>{props.cancelLabel ?? '取消'}</Button>
          <Button
            variant={props.confirmVariant ?? 'primary'}
            disabled={props.confirmDisabled}
            disabledReason={props.confirmDisabledReason}
            busy={props.busy}
            onClick={props.onConfirm}
          >
            {props.confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}

/** 成功提示会自己消失，不会和下一条错误并排留在页面顶上。 */
export function Toasts(props: {
  readonly items: readonly { readonly id: number; readonly text: string }[];
}) {
  if (props.items.length === 0) return null;
  return (
    <div className="ew-toast-layer" aria-live="polite">
      {props.items.map((item) => (
        <div className="ew-toast" key={item.id}>
          <Icon name="check" size="sm" />
          <span>{item.text}</span>
        </div>
      ))}
    </div>
  );
}

export function useToasts() {
  const [items, setItems] = useState<readonly { id: number; text: string }[]>([]);
  const seq = useRef(0);
  function push(text: string) {
    const id = (seq.current += 1);
    setItems((list) => [...list, { id, text }]);
    setTimeout(() => setItems((list) => list.filter((item) => item.id !== id)), 4000);
  }
  return { items, push };
}
