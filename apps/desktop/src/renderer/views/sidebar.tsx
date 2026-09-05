/**
 * 任务列表侧边栏（04 §3）。
 *
 * ## 三条来自文档、且做错了很难发现的规则
 *
 * 1. **子任务不出现在顶层列表**（04 §3.2）。`parentThreadId` 非空的 thread 只在父任务的
 *    对话流里以 `SubAgentActivity` 呈现。漏掉这条的表现是"我只建了 3 个任务，列表里 17 条"。
 * 2. **筛选生效时标题变成「任务 (12 / 148) · 重置筛选」**（清单 §4.2）。没有这个入口，
 *    用户会以为任务丢了 —— 这是同类产品最常见的投诉。
 * 3. **删除的二次确认必须说清"不删工作空间文件"**（04 §3.3）。Q1=A 下任务就在真实目录里执行，
 *    用户对"删任务会不会删我的 docx"的默认预期是会 —— 不说清就等于让人不敢用删除。
 *
 * ## 为什么可见页要往外报（`onVisibleChange`）
 *
 * 04 §3.4 的修订说清了：`thread/list` 没有"按 id 过滤"的参数，所以投影表筛出的 id 列表
 * 只能靠逐个 `thread/read` 拉权威字段，而这件事**必须限死在可见页**（不限的话
 * "筛出 800 条"会变成 800 个请求）。"哪些行现在可见"只有这一层知道，所以由它往外报。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';

import { Menu, Popover, type MenuItemSpec } from '../components/menu.js';
import {
  FilterChip,
  IconButton,
  NavItem,
  PillButton,
  QuotaFooter,
  SearchInput,
  SidebarSectionHeader,
  TaskListItem,
} from '../components/primitives.js';
import { STATUS_VIEW, type TaskStatus } from './task-workspace.js';

export interface TaskRow {
  readonly id: string;
  readonly title: string | null;
  readonly status: TaskStatus;
  readonly timeLabel: string;
  /** `threadSection` 的 id。内置 pinned 分区即置顶（总纲 §6.1，不额外做 is_pinned） */
  readonly sectionId: string;
  /** 非空 = 子任务，**不进顶层列表**（04 §3.2） */
  readonly parentThreadId?: string | null | undefined;
  readonly hasArtifacts?: boolean | undefined;
  readonly source?: 'manual' | 'automation' | 'cli' | undefined;
  readonly cwd?: string | undefined;
  readonly modelProvider?: string | undefined;
}

export interface TaskSection {
  readonly id: string;
  readonly name: string;
}

/** 内置分区 id。pinned 是内核内置的，ungrouped 是"没有 section 的那些"的显示归宿。 */
export const PINNED_SECTION = 'pinned';
export const UNGROUPED_SECTION = 'ungrouped';

export type TimeRange = 'all' | 'today' | '7d' | '30d';

/** 04 §3.4 的六组筛选条件。 */
export interface TaskFilter {
  readonly statuses: readonly TaskStatus[];
  readonly range: TimeRange;
  readonly cwd?: string | undefined;
  readonly modelProvider?: string | undefined;
  readonly hasArtifacts?: boolean | undefined;
  readonly source?: TaskRow['source'] | undefined;
}

export const EMPTY_FILTER: TaskFilter = Object.freeze({ statuses: [], range: 'all' });

export function isFilterActive(filter: TaskFilter): boolean {
  return (
    filter.statuses.length > 0 ||
    filter.range !== 'all' ||
    filter.cwd !== undefined ||
    filter.modelProvider !== undefined ||
    filter.hasArtifacts !== undefined ||
    filter.source !== undefined
  );
}

const RANGE_LABEL: Readonly<Record<TimeRange, string>> = {
  all: '不限',
  today: '今天',
  '7d': '7 天',
  '30d': '30 天',
};

const SOURCE_LABEL: Readonly<Record<NonNullable<TaskRow['source']>, string>> = {
  manual: '手动',
  automation: '自动化',
  cli: 'CLI',
};

/** 04 §3.3 的行操作。分享默认关闭（Q10），所以它是**过一次授权流**的入口而不是直接动作。 */
export type RowAction =
  | 'pin'
  | 'unpin'
  | 'rename'
  | 'move'
  | 'reveal'
  | 'new-in-workspace'
  | 'share'
  | 'copy-link'
  | 'fork'
  | 'archive'
  | 'delete';

export interface SidebarProps {
  readonly tasks: readonly TaskRow[];
  readonly sections: readonly TaskSection[];
  readonly selectedId?: string | undefined;
  readonly onSelect?: ((id: string) => void) | undefined;
  readonly onRowAction?: ((action: RowAction, id: string) => void) | undefined;
  /** 内容命中（`thread/search` exp）。与标题命中分组显示（04 §3.4） */
  readonly contentMatches?: readonly {
    readonly id: string;
    readonly title: string;
    readonly excerpt: string;
  }[];
  /**
   * 当前可见的任务 id（上界 = 一页）。宿主用它做**有界的**权威字段校正（04 §3.4 第②步）。
   */
  readonly onVisibleChange?: ((ids: readonly string[]) => void) | undefined;
  readonly pageSize?: number | undefined;
  readonly diskUsageLabel?: string | undefined;
  readonly diskUsagePercent?: number | undefined;
  readonly onCleanup?: (() => void) | undefined;
  readonly onNewTask?: (() => void) | undefined;
  readonly nav?: readonly {
    readonly id: string;
    readonly label: string;
    readonly icon?: string | undefined;
    readonly count?: number | undefined;
  }[];
  readonly activeNavId?: string | undefined;
  readonly onNavSelect?: ((id: string) => void) | undefined;
}

const DEFAULT_PAGE_SIZE = 30;

export function Sidebar(props: SidebarProps) {
  const [search, setSearch] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [filterOpen, setFilterOpen] = useState(false);
  const [filter, setFilter] = useState<TaskFilter>(EMPTY_FILTER);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<TaskRow | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const pageSize = props.pageSize ?? DEFAULT_PAGE_SIZE;

  // 04 §3.2：子任务不进顶层列表
  const topLevel = useMemo(
    () => props.tasks.filter((t) => t.parentThreadId == null),
    [props.tasks],
  );

  const matched = useMemo(() => {
    const q = search.trim().toLowerCase();
    return topLevel.filter((task) => {
      if (q && !(task.title ?? '').toLowerCase().includes(q)) return false;
      if (filter.statuses.length > 0 && !filter.statuses.includes(task.status)) return false;
      if (filter.cwd !== undefined && task.cwd !== filter.cwd) return false;
      if (filter.modelProvider !== undefined && task.modelProvider !== filter.modelProvider)
        return false;
      if (filter.hasArtifacts !== undefined && (task.hasArtifacts ?? false) !== filter.hasArtifacts)
        return false;
      if (filter.source !== undefined && task.source !== filter.source) return false;
      return true;
    });
  }, [topLevel, search, filter]);

  const visible = useMemo(() => matched.slice(0, pageSize), [matched, pageSize]);

  // 只报可见页（04 §3.4）：把这里改成 matched 就会在"筛出 800 条"时打爆内核
  const onVisibleChange = props.onVisibleChange;
  useEffect(() => {
    onVisibleChange?.(visible.map((t) => t.id));
  }, [visible, onVisibleChange]);

  const grouped = useMemo(() => groupBySection(visible, props.sections), [visible, props.sections]);
  const filtering = isFilterActive(filter) || search.trim() !== '';
  const closeMenu = useCallback(() => setMenuFor(null), []);

  return (
    <nav className="ew-sidebar" aria-label="侧边栏">
      <div className="ew-sidebar-top">
        <PillButton variant="accent" onClick={props.onNewTask}>
          新建任务
        </PillButton>
        <IconButton
          // 与下面 SearchInput 的无障碍名区分开：两个都叫「搜索任务」时，
          // 读屏用户听到的是两个同名控件，而测试里也定位不到唯一元素
          label={searchOpen ? '收起搜索框' : '打开搜索框'}
          icon="⌕"
          selected={searchOpen}
          onClick={() => setSearchOpen((v) => !v)}
        />
        <span className="ew-filter-anchor">
          <IconButton
            label="筛选任务"
            icon="⌄"
            selected={filterOpen || isFilterActive(filter)}
            onClick={() => setFilterOpen((v) => !v)}
          />
          <Popover open={filterOpen} onClose={() => setFilterOpen(false)} align="end">
            <FilterPanel
              filter={filter}
              tasks={topLevel}
              onChange={setFilter}
              onReset={() => setFilter(EMPTY_FILTER)}
            />
          </Popover>
        </span>
      </div>

      {searchOpen ? (
        <SearchInput
          ariaLabel="搜索任务"
          placeholder="搜索任务标题"
          value={search}
          onChange={setSearch}
        />
      ) : null}

      {(props.nav ?? []).map((item) => (
        <NavItem
          key={item.id}
          label={item.label}
          icon={item.icon}
          count={item.count}
          selected={item.id === props.activeNavId}
          onClick={() => props.onNavSelect?.(item.id)}
        />
      ))}

      <SidebarSectionHeader
        label="任务"
        count={topLevel.length}
        {...(filtering ? { filteredCount: matched.length } : {})}
        collapsed={collapsed}
        onToggle={() => setCollapsed((v) => !v)}
        {...(filtering
          ? {
              onResetFilter: () => {
                setFilter(EMPTY_FILTER);
                setSearch('');
              },
            }
          : {})}
      />

      {collapsed ? null : (
        <div className="ew-task-groups">
          {grouped.map((group) => (
            <div key={group.id} className="ew-task-group">
              <p className="ew-task-group-name">
                {group.id === PINNED_SECTION ? '📌 置顶' : group.name}
              </p>
              <ul className="ew-task-list">
                {group.tasks.map((task) => (
                  <li key={task.id}>
                    <span className="ew-task-row-anchor">
                      <TaskListItem
                        title={task.title ?? '未命名任务'}
                        time={task.timeLabel}
                        tone={STATUS_VIEW[task.status].tone}
                        breathing={STATUS_VIEW[task.status].breathing}
                        pinned={task.sectionId === PINNED_SECTION}
                        selected={task.id === props.selectedId}
                        onClick={() => props.onSelect?.(task.id)}
                        onMore={() => setMenuFor(task.id === menuFor ? null : task.id)}
                      />
                      <Popover open={menuFor === task.id} onClose={closeMenu} align="end">
                        <Menu
                          ariaLabel={`${task.title ?? '未命名任务'} 的操作`}
                          items={rowMenuItems(task)}
                          onSelect={(action) => {
                            closeMenu();
                            if (action === 'delete') {
                              setConfirmDelete(task);
                              return;
                            }
                            props.onRowAction?.(action as RowAction, task.id);
                          }}
                        />
                      </Popover>
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ))}

          {matched.length === 0 ? (
            <p className="ew-task-list-empty">
              {filtering ? '没有符合条件的任务。改一下筛选条件，或者重置。' : '还没有任务。'}
            </p>
          ) : null}

          {matched.length > visible.length ? (
            <p className="ew-task-list-more">还有 {matched.length - visible.length} 条，滚动加载</p>
          ) : null}
        </div>
      )}

      {props.diskUsageLabel !== undefined ? (
        <QuotaFooter
          usedLabel={props.diskUsageLabel}
          percent={props.diskUsagePercent ?? 0}
          onCleanup={props.onCleanup}
        />
      ) : null}

      {(props.contentMatches ?? []).length > 0 ? (
        <div className="ew-content-matches">
          <p className="ew-content-matches-title">对话内容命中</p>
          <ul>
            {(props.contentMatches ?? []).map((hit) => (
              <li key={hit.id}>
                <button type="button" onClick={() => props.onSelect?.(hit.id)}>
                  <span className="ew-content-match-title">{hit.title}</span>
                  <span className="ew-content-match-excerpt">{hit.excerpt}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {confirmDelete ? (
        <div className="ew-delete-confirm" role="alertdialog" aria-label="删除任务">
          <p className="ew-delete-confirm-title">删除「{confirmDelete.title ?? '未命名任务'}」？</p>
          {/* 04 §3.3 要求说清这一句。答案是"不删" */}
          <p className="ew-delete-confirm-body">
            只删除这个任务的对话记录。<strong>工作空间里的文件不会被删除</strong>
            {confirmDelete.cwd ? `（${confirmDelete.cwd}）` : ''}。
          </p>
          <PillButton onClick={() => setConfirmDelete(null)}>取消</PillButton>
          <PillButton
            variant="accent"
            onClick={() => {
              props.onRowAction?.('delete', confirmDelete.id);
              setConfirmDelete(null);
            }}
          >
            删除任务
          </PillButton>
        </div>
      ) : null}
    </nav>
  );
}

/** 04 §3.3 的行操作菜单。分享标注"需要授权"，与"复制链接"（不上传）区分开。 */
export function rowMenuItems(task: TaskRow): readonly MenuItemSpec[] {
  const pinned = task.sectionId === PINNED_SECTION;
  return [
    { id: pinned ? 'unpin' : 'pin', label: pinned ? '取消置顶' : '置顶', group: 'a' },
    { id: 'rename', label: '重命名', group: 'a' },
    { id: 'move', label: '移动到分组…', group: 'a' },
    { id: 'reveal', label: '打开所在文件夹', group: 'b' },
    { id: 'new-in-workspace', label: '在此空间新建任务', group: 'b' },
    {
      id: 'share',
      label: '分享任务…',
      // Q10：默认关闭 + 逐次授权。菜单里就说清"要先授权"，避免点了才发现有个模态
      description: '需要你先授权上传，链接有有效期',
      group: 'c',
    },
    { id: 'copy-link', label: '复制任务链接', description: '本机链接，不上传', group: 'c' },
    { id: 'fork', label: '从中途分叉', group: 'c' },
    { id: 'archive', label: '归档', group: 'd' },
    { id: 'delete', label: '删除', danger: true, group: 'd' },
  ];
}

function groupBySection(
  tasks: readonly TaskRow[],
  sections: readonly TaskSection[],
): readonly { id: string; name: string; tasks: readonly TaskRow[] }[] {
  const order = [
    { id: PINNED_SECTION, name: '置顶' },
    ...sections.filter((s) => s.id !== PINNED_SECTION),
    { id: UNGROUPED_SECTION, name: '未分组' },
  ];
  const known = new Set(order.map((s) => s.id));
  return order
    .map((section) => ({
      id: section.id,
      name: section.name,
      tasks: tasks.filter((t) =>
        section.id === UNGROUPED_SECTION
          ? !known.has(t.sectionId) || t.sectionId === UNGROUPED_SECTION
          : t.sectionId === section.id,
      ),
    }))
    .filter((group) => group.tasks.length > 0);
}

/** 04 §3.4 的筛选面板：六组条件，状态为多选。 */
function FilterPanel({
  filter,
  tasks,
  onChange,
  onReset,
}: {
  readonly filter: TaskFilter;
  readonly tasks: readonly TaskRow[];
  readonly onChange: (filter: TaskFilter) => void;
  readonly onReset: () => void;
}) {
  const statuses = Object.keys(STATUS_VIEW) as TaskStatus[];
  const cwds = [...new Set(tasks.map((t) => t.cwd).filter((v): v is string => v !== undefined))];
  const providers = [
    ...new Set(tasks.map((t) => t.modelProvider).filter((v): v is string => v !== undefined)),
  ];

  return (
    <div className="ew-filter-panel" aria-label="筛选条件">
      <p className="ew-filter-group-title">状态</p>
      <div className="ew-filter-group">
        {statuses.map((status) => (
          <FilterChip
            key={status}
            label={STATUS_VIEW[status].label}
            selected={filter.statuses.includes(status)}
            onClick={() =>
              onChange({
                ...filter,
                statuses: filter.statuses.includes(status)
                  ? filter.statuses.filter((s) => s !== status)
                  : [...filter.statuses, status],
              })
            }
          />
        ))}
      </div>

      <p className="ew-filter-group-title">时间范围</p>
      <div className="ew-filter-group">
        {(Object.keys(RANGE_LABEL) as TimeRange[]).map((range) => (
          <FilterChip
            key={range}
            label={RANGE_LABEL[range]}
            selected={filter.range === range}
            onClick={() => onChange({ ...filter, range })}
          />
        ))}
      </div>

      {cwds.length > 0 ? (
        <>
          <p className="ew-filter-group-title">工作空间</p>
          <div className="ew-filter-group">
            {cwds.map((cwd) => (
              <FilterChip
                key={cwd}
                label={cwd}
                selected={filter.cwd === cwd}
                onClick={() => onChange({ ...filter, cwd: filter.cwd === cwd ? undefined : cwd })}
              />
            ))}
          </div>
        </>
      ) : null}

      {providers.length > 0 ? (
        <>
          <p className="ew-filter-group-title">模型</p>
          <div className="ew-filter-group">
            {providers.map((provider) => (
              <FilterChip
                key={provider}
                label={provider}
                selected={filter.modelProvider === provider}
                onClick={() =>
                  onChange({
                    ...filter,
                    modelProvider: filter.modelProvider === provider ? undefined : provider,
                  })
                }
              />
            ))}
          </div>
        </>
      ) : null}

      <p className="ew-filter-group-title">产物</p>
      <div className="ew-filter-group">
        <FilterChip
          label="有产物"
          selected={filter.hasArtifacts === true}
          onClick={() =>
            onChange({ ...filter, hasArtifacts: filter.hasArtifacts === true ? undefined : true })
          }
        />
      </div>

      <p className="ew-filter-group-title">来源</p>
      <div className="ew-filter-group">
        {(Object.keys(SOURCE_LABEL) as NonNullable<TaskRow['source']>[]).map((source) => (
          <FilterChip
            key={source}
            label={SOURCE_LABEL[source]}
            selected={filter.source === source}
            onClick={() =>
              onChange({ ...filter, source: filter.source === source ? undefined : source })
            }
          />
        ))}
      </div>

      <PillButton variant="ghost" onClick={onReset}>
        重置全部条件
      </PillButton>
    </div>
  );
}
