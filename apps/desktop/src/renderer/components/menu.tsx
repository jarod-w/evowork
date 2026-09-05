/**
 * 01 §5.19 Menu / Popover，以及建立在它之上的 §5.14 InlineSelect 与 §5.15 ModelSelect。
 *
 * 三个组件放在一个文件里，是因为**它们共享同一套"打开一个浮层并关掉它"的行为**：
 * Esc 关闭、点外部关闭、焦点回到触发器、方向键在项之间移动。这套行为写三遍就会分叉
 * （典型症状是某一个下拉按 Esc 关不掉），而它又没大到值得单独一个包。
 *
 * ## 禁用项必须给出原因
 *
 * 01 §5.19 与 10 §2.3 都要求：禁用的菜单项**渲染出来并显示原因**，不隐藏。
 * 所以 `MenuItemSpec.disabledReason` 在 `disabled` 为真时是必填的 —— 类型上做不到"条件必填"，
 * 但运行时会在开发期报出来（见 `assertDisabledHasReason`）。理由是权限档位这类项，
 * 用户需要知道"存在这一档但我不能选"，隐藏会让人以为产品没这个能力。
 */
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';

export interface MenuItemSpec {
  readonly id: string;
  readonly label: string;
  readonly icon?: ReactNode | undefined;
  /** 右侧的快捷键提示（`caption` / `--text-tertiary`） */
  readonly shortcut?: string | undefined;
  readonly checked?: boolean | undefined;
  readonly danger?: boolean | undefined;
  readonly disabled?: boolean | undefined;
  /** 禁用原因。**禁用时必填**（01 §5.19） */
  readonly disabledReason?: string | undefined;
  /** 分组：相邻同组的项之间无分割线，跨组加 1px 分割 */
  readonly group?: string | undefined;
  /** 次要说明，显示在标签下方一行（权限档位的 description 用它） */
  readonly description?: string | undefined;
}

/** 开发期兜底：禁用项没给原因时直接报出来，而不是等 UI 评审时才发现。 */
function assertDisabledHasReason(items: readonly MenuItemSpec[]): void {
  for (const item of items) {
    if (item.disabled && !item.disabledReason) {
      throw new Error(`菜单项「${item.label}」被禁用但没有给出原因（01 §5.19 / 10 §2.3 要求必填）`);
    }
  }
}

export interface MenuProps {
  readonly items: readonly MenuItemSpec[];
  readonly onSelect: (id: string) => void;
  readonly ariaLabel: string;
  /** 当前高亮项（受控；`@` 补全菜单要用键盘上下移动） */
  readonly activeId?: string | undefined;
}

/**
 * 纯粹的菜单**内容**，不含浮层定位 —— 定位由外面的 `Popover` 或行内容器负责。
 * 拆开是因为 `@` 补全菜单锚在光标上、行操作菜单锚在按钮上，定位方式不同但内容一样。
 */
export function Menu({ items, onSelect, ariaLabel, activeId }: MenuProps) {
  assertDisabledHasReason(items);
  let lastGroup: string | undefined;
  return (
    <div className="ew-menu" role="menu" aria-label={ariaLabel}>
      {items.map((item) => {
        const newGroup = lastGroup !== undefined && item.group !== lastGroup;
        lastGroup = item.group;
        return (
          <button
            key={item.id}
            type="button"
            role="menuitem"
            className="ew-menu-item"
            data-group-start={newGroup ? 'true' : undefined}
            data-danger={item.danger ? 'true' : undefined}
            data-active={item.id === activeId ? 'true' : undefined}
            disabled={item.disabled}
            // 禁用原因既进 title（悬停可见）也进正文（读屏与不悬停时可见）
            title={item.disabled ? item.disabledReason : undefined}
            onClick={() => onSelect(item.id)}
          >
            {item.icon ? (
              <span className="ew-menu-icon" aria-hidden="true">
                {item.icon}
              </span>
            ) : null}
            <span className="ew-menu-label">
              {item.label}
              {item.description ? (
                <span className="ew-menu-description">{item.description}</span>
              ) : null}
            </span>
            {item.disabled && item.disabledReason ? (
              <span className="ew-menu-reason">{item.disabledReason}</span>
            ) : null}
            {item.shortcut ? <span className="ew-menu-shortcut">{item.shortcut}</span> : null}
            {item.checked ? (
              <span className="ew-menu-check" aria-hidden="true">
                ✓
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

/**
 * 受控浮层：负责"关掉它"的三条路径（Esc、点外部、选中后）。
 *
 * 不做 portal —— jsdom 与真实 DOM 里都够用，而 portal 会让"点外部关闭"的判定
 * 变成需要额外维护的 ref 链。
 */
export function Popover({
  open,
  onClose,
  children,
  align = 'start',
}: {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly children: ReactNode;
  readonly align?: 'start' | 'end' | undefined;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
      }
    };
    const onPointerDown = (event: MouseEvent): void => {
      if (!ref.current) return;
      const target = event.target as Node | null;
      // 触发器本身在浮层外面，所以这里只判"点在浮层里"——
      // 触发器的 onClick 会自己 toggle，两者不会打架（点触发器时先关后开 = 保持开）
      if (target && !ref.current.contains(target) && !ref.current.parentElement?.contains(target)) {
        onClose();
      }
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onPointerDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onPointerDown);
    };
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="ew-popover" data-align={align} ref={ref}>
      {children}
    </div>
  );
}

export interface InlineSelectOption {
  readonly id: string;
  readonly label: string;
  readonly description?: string | undefined;
  readonly disabled?: boolean | undefined;
  readonly disabledReason?: string | undefined;
  readonly group?: string | undefined;
}

export interface InlineSelectProps {
  readonly ariaLabel: string;
  readonly icon?: ReactNode | undefined;
  /** 未选值时显示占位并用 `--text-tertiary`（01 §5.14） */
  readonly placeholder: string;
  readonly value?: string | undefined;
  readonly options: readonly InlineSelectOption[];
  readonly onChange: (id: string) => void;
  readonly disabled?: boolean | undefined;
  readonly disabledReason?: string | undefined;
  /**
   * 「已被你改过」圆点（03 §2.5）：切换场景时保留用户的显式选择，并在该控件旁标注。
   * 点它回落到场景默认值。
   */
  readonly overridden?: boolean | undefined;
  readonly onResetOverride?: (() => void) | undefined;
  /** 等宽字族显示（ModelSelect 用，01 §5.15） */
  readonly mono?: boolean | undefined;
}

/** 01 §5.14 InlineSelect（Footer 下拉）。ModelSelect 是它 `mono` + 能力徽标的特化。 */
export function InlineSelect(props: InlineSelectProps) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const selected = props.options.find((o) => o.id === props.value);
  const close = useCallback(() => setOpen(false), []);

  return (
    <span className="ew-inline-select" data-open={open ? 'true' : undefined}>
      <button
        type="button"
        className="ew-inline-select-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={props.ariaLabel}
        id={id}
        disabled={props.disabled}
        title={props.disabled ? props.disabledReason : undefined}
        data-placeholder={selected ? undefined : 'true'}
        data-mono={props.mono ? 'true' : undefined}
        onClick={() => setOpen((v) => !v)}
      >
        {props.icon ? (
          <span className="ew-inline-select-icon" aria-hidden="true">
            {props.icon}
          </span>
        ) : null}
        <span className="ew-inline-select-label">{selected?.label ?? props.placeholder}</span>
        <span className="ew-inline-select-chevron" aria-hidden="true">
          ▾
        </span>
      </button>

      {/* 03 §2.5：用户改过的控件带一个 4px 圆点，点它回落场景默认值 */}
      {props.overridden ? (
        <button
          type="button"
          className="ew-override-dot"
          aria-label={`${props.ariaLabel}已被你改过，点击恢复场景默认值`}
          onClick={props.onResetOverride}
        />
      ) : null}

      <Popover open={open} onClose={close}>
        <Menu
          ariaLabel={props.ariaLabel}
          items={props.options.map((o) => ({
            id: o.id,
            label: o.label,
            checked: o.id === props.value,
            description: o.description,
            disabled: o.disabled,
            disabledReason: o.disabledReason,
            group: o.group,
          }))}
          onSelect={(chosen) => {
            close();
            props.onChange(chosen);
          }}
        />
      </Popover>
    </span>
  );
}

export interface ModelCapability {
  readonly id: 'reasoning' | 'image-input' | 'parallel-tools';
  readonly label: string;
  readonly available: boolean;
}

export interface ModelOption {
  readonly id: string;
  /** `provider/model`，等宽显示 */
  readonly label: string;
  readonly provider: string;
  readonly capabilities: readonly ModelCapability[];
}

/** 标签最长 28 字符，超出**中间省略**（01 §5.15）。 */
export function truncateModelLabel(label: string, max = 28): string {
  if (label.length <= max) return label;
  const keep = max - 1;
  const head = Math.ceil(keep / 2);
  return `${label.slice(0, head)}…${label.slice(label.length - (keep - head))}`;
}

/**
 * 01 §5.15 ModelSelect。
 *
 * **缺失能力必须显示为灰色划除而不是隐藏**（总纲 D2「降级必须显式」）——
 * 隐藏会让"这个模型不支持图片"变成用户拖了图片才发现的事。
 */
export function ModelSelect({
  models,
  value,
  onChange,
  overridden,
  onResetOverride,
}: {
  readonly models: readonly ModelOption[];
  readonly value?: string | undefined;
  readonly onChange: (id: string) => void;
  readonly overridden?: boolean | undefined;
  readonly onResetOverride?: (() => void) | undefined;
}) {
  const [open, setOpen] = useState(false);
  const current = models.find((m) => m.id === value);
  return (
    <span className="ew-model-select" data-open={open ? 'true' : undefined}>
      <button
        type="button"
        className="ew-inline-select-trigger"
        data-mono="true"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="选择模型"
        data-placeholder={current ? undefined : 'true'}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="ew-inline-select-label">
          {current ? truncateModelLabel(current.label) : '选择模型'}
        </span>
        <span className="ew-inline-select-chevron" aria-hidden="true">
          ▾
        </span>
      </button>

      {overridden ? (
        <button
          type="button"
          className="ew-override-dot"
          aria-label="模型已被你改过，点击恢复场景默认值"
          onClick={onResetOverride}
        />
      ) : null}

      <Popover open={open} onClose={() => setOpen(false)}>
        {/* 按 provider 分组（01 §5.15） */}
        <div className="ew-menu" role="menu" aria-label="模型列表">
          {[...new Set(models.map((m) => m.provider))].map((provider) => (
            <div key={provider} className="ew-menu-group">
              <p className="ew-menu-group-title">{provider}</p>
              {models
                .filter((m) => m.provider === provider)
                .map((model) => (
                  <button
                    key={model.id}
                    type="button"
                    role="menuitem"
                    className="ew-menu-item"
                    data-active={model.id === value ? 'true' : undefined}
                    onClick={() => {
                      setOpen(false);
                      onChange(model.id);
                    }}
                  >
                    <span className="ew-menu-label ew-mono">{model.label}</span>
                    <span className="ew-model-caps">
                      {model.capabilities.map((cap) => (
                        <span
                          key={cap.id}
                          className="ew-model-cap"
                          data-available={cap.available ? 'true' : 'false'}
                          // 缺失能力：划除 + 灰，且把"不支持"读出来而不是只靠视觉
                          aria-label={cap.available ? cap.label : `不支持${cap.label}`}
                        >
                          {cap.label}
                        </span>
                      ))}
                    </span>
                  </button>
                ))}
            </div>
          ))}
        </div>
      </Popover>
    </span>
  );
}
