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

import { BRAND } from '@evowork/tokens';

import { renderIcon } from '../components/icons.js';
import { Menu, Popover, type MenuItemSpec } from '../components/menu.js';
import {
  FilterChip,
  IconButton,
  NavItem,
  PillButton,
  PromoCard,
  QuotaFooter,
  SearchInput,
  SidebarSectionHeader,
  TaskListItem,
  UserFooter,
} from '../components/primitives.js';
import { STATUS_VIEW, type TaskStatus } from './task-workspace.js';

export interface TaskRow {
  readonly id: string;
  readonly title: string | null;
  readonly status: TaskStatus;
  readonly timeLabel: string;
  /** 最近活动时间（毫秒）；筛选只读这个事实字段，不反向解析 `timeLabel`。 */
  readonly updatedAt: number;
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
  readonly projects?:
    | readonly {
        readonly id: string;
        readonly name: string;
        readonly rootMissing?: boolean | undefined;
      }[]
    | undefined;
  readonly selectedProjectId?: string | undefined;
  readonly onProjectSelect?: ((id: string) => void) | undefined;
  readonly nav?: readonly {
    readonly id: string;
    readonly label: string;
    readonly icon?: string | undefined;
    readonly trailing?: string | undefined;
    readonly count?: number | undefined;
  }[];
  readonly activeNavId?: string | undefined;
  readonly onNavSelect?: ((id: string) => void) | undefined;
  /** 品牌名（K5：换品牌只改 token，布局零改动）。缺省用 BRAND.appName */
  readonly brandName?: string | undefined;
  readonly onToggleCollapse?: (() => void) | undefined;
  readonly searchOpen?: boolean | undefined;
  readonly onSearchOpenChange?: ((open: boolean) => void) | undefined;
  /** 用户区（01 §5.7）。不给就不渲染 —— 未登录时那一块本来就没有内容 */
  readonly user?:
    | { readonly name: string; readonly version: string; readonly unread?: number | undefined }
    | undefined;
  /**
   * 「更多」菜单里被选中的那一项（02 §4.7 的二级入口）。
   *
   * id 用 `settings:<分区>` 的形式，因为设置页是**一页多分区**而不是六个页面 ——
   * 让菜单直接说出要去哪个分区，比让 app 再猜一次少一处映射。
   */
  readonly onMoreSelect?: ((id: string) => void) | undefined;
  readonly onNotifications?: (() => void) | undefined;
  readonly onDevices?: (() => void) | undefined;
  /** Q18 的 `sidebar-promo` 插槽。**默认关闭**，且只渲染静态内容 */
  readonly promo?:
    | { readonly title: string; readonly body: string; readonly actionLabel?: string | undefined }
    | undefined;
}

/**
 * 02 §1 的一级信息架构：**6 个固定入口 + 1 个动态任务区**。
 *
 * 写死在这里而不是由调用方传，是因为它就是固定的 —— 02 §1 的那张表是产品的骨架，
 * 不是配置。传进来只会让"侧边栏有哪几项"变成一个各页面各答一次的问题。
 *
 * 「新建任务」是**导航项而不是按钮**（02 §1 的原话）：它切换的是主内容区的一个视图，
 * 与其余 5 项同级、需要保持选中态。做成按钮就没有选中态，用户永远不知道自己在首页。
 *
 * ## 「助理」为什么不在这里（2026-09-07 下架）
 *
 * 02 §4.2 / 总纲 Q20 的方案是"一个常驻的特殊 Thread"（固定 cwd、默认 Ask、
 * 自动压缩、读用户级记忆）。那条链路**一行都没有**，留着入口只能给一个
 * 「还没做好」的空页 —— 那是在产品骨架上占一格去说一句道歉，而侧边栏的每一项
 * 都在向用户承诺"这里有东西"。设计文档保留方案并标注下架，恢复它 =
 * 把这一项加回来 + 在 `NAV_TO_VIEW` 里给它一个视图。
 */
export const MAIN_NAV: NonNullable<SidebarProps['nav']> = [
  { id: 'new-task', label: '新建任务', icon: 'new-task' },
  { id: 'catalog', label: '插件', icon: 'catalog' },
  { id: 'automations', label: '自动化', icon: 'automation' },
  { id: 'library', label: '资料库', icon: 'library' },
];

/**
 * 02 §4.7 的三组二级入口。**没做的项留在菜单里但禁用**，并说清为什么。
 *
 * 「退出登录」不在这里：账号随 M10b（Q30=A 下未登录是常态，摆一个登出项
 * 等于承诺一个不存在的登录态）。
 */
export const MORE_MENU: readonly MenuItemSpec[] = [
  { id: 'settings:models', label: '设置' },
  { id: 'settings:data', label: '数据管理' },
  { id: 'settings:usage', label: '用量与预算' },
  { id: 'audit', label: '用量与审计' },
  { id: 'settings:about', label: '关于' },
  {
    id: 'inspiration',
    label: '灵感 / 案例库',
    disabled: true,
    disabledReason: '完整案例库还没做好；首页下方已经有官方最佳实践的入口。',
  },
  {
    id: 'guide',
    label: '使用指南',
    disabled: true,
    disabledReason: '还没写。现在能查的是引导里的五步说明。',
  },
  {
    id: 'devices',
    label: '设备与同步',
    disabled: true,
    disabledReason: '跨设备同步本期不做（Q17 / Q19）。自动化的设备归属在自动化页里看。',
  },
  {
    id: 'update',
    label: '检查更新',
    disabled: true,
    disabledReason: '自动更新还没接上，现在需要手动下载新版本。',
  },
];

const DEFAULT_PAGE_SIZE = 30;

export function Sidebar(props: SidebarProps) {
  const [search, setSearch] = useState('');
  const [localSearchOpen, setLocalSearchOpen] = useState(false);
  const [filterOpen, setFilterOpen] = useState(false);
  const [filter, setFilter] = useState<TaskFilter>(EMPTY_FILTER);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<TaskRow | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const pageSize = props.pageSize ?? DEFAULT_PAGE_SIZE;
  const [visibleCount, setVisibleCount] = useState(pageSize);
  const searchOpen = props.searchOpen ?? localSearchOpen;
  const setSearchOpen = (open: boolean): void => {
    setLocalSearchOpen(open);
    props.onSearchOpenChange?.(open);
  };

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
      if (filter.range !== 'all') {
        const days = filter.range === 'today' ? 1 : filter.range === '7d' ? 7 : 30;
        if (task.updatedAt < Date.now() - days * 24 * 60 * 60 * 1000) return false;
      }
      if (filter.cwd !== undefined && task.cwd !== filter.cwd) return false;
      if (filter.modelProvider !== undefined && task.modelProvider !== filter.modelProvider)
        return false;
      if (filter.hasArtifacts !== undefined && (task.hasArtifacts ?? false) !== filter.hasArtifacts)
        return false;
      if (filter.source !== undefined && task.source !== filter.source) return false;
      return true;
    });
  }, [topLevel, search, filter]);

  useEffect(() => setVisibleCount(pageSize), [pageSize, search, filter]);
  const visible = useMemo(() => matched.slice(0, visibleCount), [matched, visibleCount]);

  // 只报可见页（04 §3.4）：把这里改成 matched 就会在"筛出 800 条"时打爆内核
  const onVisibleChange = props.onVisibleChange;
  useEffect(() => {
    onVisibleChange?.(visible.map((t) => t.id));
  }, [visible, onVisibleChange]);

  const grouped = useMemo(() => groupBySection(visible, props.sections), [visible, props.sections]);
  const filtering = isFilterActive(filter) || search.trim() !== '';
  const closeMenu = useCallback(() => setMenuFor(null), []);

  const nav = props.nav ?? MAIN_NAV;
  const primaryNav = nav.filter((item) => item.id === 'new-task');
  const utilityNav = nav.filter((item) => item.id !== 'new-task' && item.id !== 'more');
  /*
   * 选中映射由宿主传入（02 §2）：首页 → new-task；目录页 → 对应 id；
   * `/tasks/:id`、设置、审计 → 不传，不点亮任何一级导航。
   *
   * 不要在「没选任务」时擅自点亮「新建任务」：目录页同样没有 selectedId，
   * 猜成首页会让用户看到主区已经是自动化、侧边栏却还停在新建任务。
   */
  const activeNavId = props.activeNavId;

  return (
    <nav className="ew-sidebar" aria-label="侧边栏">
      {/* 类 ChatGPT 顶栏：品牌与高频动作在同一行。 */}
      <div className="ew-sidebar-titlebar">
        <span className="ew-brand-name">{props.brandName ?? BRAND.appName}</span>
        <IconButton
          label="折叠侧边栏"
          icon={renderIcon('panel-left')}
          onClick={props.onToggleCollapse}
        />
        <IconButton
          // 与下面 SearchInput 的无障碍名区分开：两个都叫「搜索任务」时，
          // 读屏用户听到的是两个同名控件，而测试里也定位不到唯一元素
          label={searchOpen ? '收起搜索框' : '打开搜索框'}
          icon={renderIcon('search')}
          selected={searchOpen}
          onClick={() => setSearchOpen(!searchOpen)}
        />
        <span className="ew-filter-anchor">
          <IconButton
            label="筛选任务"
            icon={renderIcon('filter')}
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

      <div className="ew-sidebar-nav ew-sidebar-primary-nav">
        {primaryNav.map((item) => (
          <NavItem
            key={item.id}
            label={item.label}
            icon={renderIcon(item.icon)}
            selected={item.id === activeNavId}
            onClick={() => {
              props.onNewTask?.();
              props.onNavSelect?.(item.id);
            }}
          />
        ))}
      </div>

      <section className="ew-sidebar-projects" aria-label="项目">
        <div className="ew-sidebar-subhead">
          <button type="button" onClick={() => props.onNavSelect?.('projects')}>
            项目
          </button>
          <button type="button" onClick={() => props.onNavSelect?.('projects')}>
            查看全部
          </button>
        </div>
        {(props.projects ?? []).slice(0, 3).map((project) => (
          <NavItem
            key={project.id}
            label={project.rootMissing ? `${project.name}（目录不可用）` : project.name}
            icon={renderIcon('project')}
            selected={project.id === props.selectedProjectId}
            onClick={() => props.onProjectSelect?.(project.id)}
          />
        ))}
      </section>

      <div
        className="ew-sidebar-tasks"
        onScroll={(event) => {
          const node = event.currentTarget;
          if (
            node.scrollHeight - node.scrollTop - node.clientHeight <= 1 &&
            visibleCount < matched.length
          ) {
            setVisibleCount((count) => Math.min(count + pageSize, matched.length));
          }
        }}
      >
        <SidebarSectionHeader
          label="最近任务"
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
              <p className="ew-task-list-more">
                还有 {matched.length - visible.length} 条，向下滚动继续加载
              </p>
            ) : null}
          </div>
        )}

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
      </div>

      <div className="ew-sidebar-nav ew-sidebar-utility-nav">
        {utilityNav.map((item) => (
          <NavItem
            key={item.id}
            label={item.label}
            icon={renderIcon(item.icon)}
            trailing={item.trailing}
            count={item.count}
            selected={item.id === activeNavId}
            onClick={() => props.onNavSelect?.(item.id)}
          />
        ))}
      </div>

      {/* 01 §3.3：任务列表是唯一的滚动区，运营位与用户区吸底 */}
      <div className="ew-sidebar-bottom">
        {props.promo ? (
          <PromoCard
            title={props.promo.title}
            body={props.promo.body}
            actionLabel={props.promo.actionLabel}
          />
        ) : null}

        {props.diskUsageLabel !== undefined ? (
          <QuotaFooter
            usedLabel={props.diskUsageLabel}
            percent={props.diskUsagePercent ?? 0}
            onCleanup={props.onCleanup}
          />
        ) : null}

        {props.user ? (
          <span className="ew-user-menu-anchor">
            <UserFooter
              name={props.user.name}
              version={props.user.version}
              unreadCount={props.user.unread}
              notificationIcon={renderIcon('bell')}
              deviceIcon={renderIcon('devices')}
              onMenu={() => setMoreOpen((value) => !value)}
              onNotifications={props.onNotifications}
              onDevices={props.onDevices}
            />
            <Popover open={moreOpen} onClose={() => setMoreOpen(false)} align="start">
              <Menu
                ariaLabel="用户菜单"
                items={MORE_MENU}
                onSelect={(id) => {
                  setMoreOpen(false);
                  props.onMoreSelect?.(id);
                }}
              />
            </Popover>
          </span>
        ) : null}
      </div>

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
export function rowMenuItems(_task: TaskRow): readonly MenuItemSpec[] {
  return [
    { id: 'archive', label: '归档', group: 'a' },
    { id: 'delete', label: '删除', danger: true, group: 'a' },
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
