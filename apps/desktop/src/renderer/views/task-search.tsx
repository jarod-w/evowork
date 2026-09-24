import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type {
  TaskRowView,
  TaskSearchHitView,
  TaskStatusView,
  WorkspaceView,
} from '../../shared/ipc.js';
import { renderIcon } from '../components/icons.js';

const MAX_CHAT_RESULTS = 9;

export interface TaskSearchFilters {
  readonly status: TaskStatusView | '';
  readonly workspacePath: string;
  readonly updatedWithin: 'day' | 'week' | 'month' | '';
}

const EMPTY_FILTERS: TaskSearchFilters = {
  status: '',
  workspacePath: '',
  updatedWithin: '',
};

const STATUS_OPTIONS: readonly { value: TaskStatusView; label: string }[] = [
  { value: 'running', label: '进行中' },
  { value: 'pending', label: '待你确认' },
  { value: 'planning', label: '规划中' },
  { value: 'completed', label: '已完成' },
  { value: 'failed', label: '失败' },
  { value: 'interrupted', label: '已中断' },
  { value: 'idle', label: '未开始' },
  { value: 'archived', label: '已归档' },
];

const UPDATED_WITHIN_MS = {
  day: 24 * 60 * 60 * 1_000,
  week: 7 * 24 * 60 * 60 * 1_000,
  month: 30 * 24 * 60 * 60 * 1_000,
} as const;

export function filterTaskSearchRows(
  rows: readonly TaskSearchHitView[],
  filters: TaskSearchFilters,
  now = Date.now(),
): readonly TaskSearchHitView[] {
  return rows.filter(({ task }) => {
    if (filters.status && task.status !== filters.status) return false;
    if (filters.workspacePath) {
      const root = filters.workspacePath.replace(/[\\/]+$/, '').replaceAll('\\', '/');
      const cwd = (task.cwd ?? '').replaceAll('\\', '/');
      if (cwd !== root && !cwd.startsWith(`${root}/`)) return false;
    }
    if (filters.updatedWithin && task.updatedAt < now - UPDATED_WITHIN_MS[filters.updatedWithin])
      return false;
    return true;
  });
}

type QuickActionId = 'new-chat' | 'open-folder' | 'search-files';

const QUICK_ACTIONS: readonly {
  readonly id: QuickActionId;
  readonly label: string;
  readonly icon: string;
  readonly key: string;
}[] = [
  { id: 'new-chat', label: '新聊天', icon: 'new-task', key: 'N' },
  { id: 'open-folder', label: '打开文件夹', icon: 'folder', key: 'O' },
  { id: 'search-files', label: '搜索文件', icon: 'search', key: 'P' },
];

function shortcutPrefix(): string {
  return /Mac|iPhone|iPad/.test(window.navigator.platform) ? '⌘' : 'Ctrl+';
}

function workspaceLabel(task: TaskRowView, workspaces: readonly WorkspaceView[]): string {
  const workspace = [...workspaces]
    .filter((candidate) => candidate.path)
    .sort((a, b) => (b.path?.length ?? 0) - (a.path?.length ?? 0))
    .find((candidate) => {
      const root = candidate.path?.replace(/[\\/]+$/, '').replaceAll('\\', '/');
      const cwd = task.cwd?.replaceAll('\\', '/');
      return (
        root !== undefined && cwd !== undefined && (cwd === root || cwd.startsWith(`${root}/`))
      );
    });
  if (workspace) return workspace.name;
  if (!task.cwd) return '本机';
  return task.cwd.split(/[\\/]/).filter(Boolean).at(-1) ?? '本机';
}

/**
 * 全局搜索面板（02 §7）。
 *
 * 它盖在当前界面上，不替换主内容区。空查询时先给最近聊天；输入后再走服务层的
 * 全文搜索。用户点开搜索的第一帧就能继续旧聊天，同时仍保留正文命中能力。
 */
export function TaskSearchPalette(props: {
  readonly tasks: readonly TaskRowView[];
  readonly workspaces: readonly WorkspaceView[];
  readonly onSearch: (query: string) => Promise<readonly TaskSearchHitView[]>;
  readonly onOpenTask: (id: string, query?: string) => void;
  readonly onNewChat: () => void;
  readonly onOpenFolder: () => void;
  readonly onSearchFiles: () => void;
  readonly onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<readonly TaskSearchHitView[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [filters, setFilters] = useState<TaskSearchFilters>(EMPTY_FILTERS);
  // `autoFocus` 在 effect 前执行；这里必须在 render 阶段记住触发器，否则记下来的会是输入框自己。
  const restoreFocus = useRef<HTMLElement | null>(
    document.activeElement instanceof HTMLElement ? document.activeElement : null,
  );
  const prefix = shortcutPrefix();

  useEffect(() => {
    return () => restoreFocus.current?.focus();
  }, []);

  useEffect(() => {
    const term = query.trim();
    setSelectedIndex(0);
    if (!term) {
      setHits([]);
      setLoading(false);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      setLoading(true);
      void props
        .onSearch(term)
        .then((result) => {
          if (!cancelled) setHits(result.slice(0, MAX_CHAT_RESULTS));
        })
        .catch(() => {
          if (!cancelled) setHits([]);
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }, 150);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [query, props.onSearch]);

  const recent = useMemo(
    () =>
      props.tasks
        .filter((task) => task.parentThreadId == null)
        .map((task) => ({ task, snippet: '' })),
    [props.tasks],
  );
  const chats = useMemo(
    () => filterTaskSearchRows(query.trim() ? hits : recent, filters).slice(0, MAX_CHAT_RESULTS),
    [filters, hits, query, recent],
  );
  const activeFilterCount = [filters.status, filters.workspacePath, filters.updatedWithin].filter(
    Boolean,
  ).length;
  const itemCount = chats.length + QUICK_ACTIONS.length;

  const runQuickAction = useCallback(
    (id: QuickActionId): void => {
      props.onClose();
      if (id === 'new-chat') props.onNewChat();
      else if (id === 'open-folder') props.onOpenFolder();
      else props.onSearchFiles();
    },
    [props],
  );

  const activate = useCallback(
    (index: number): void => {
      const chat = chats[index];
      if (chat) {
        props.onClose();
        props.onOpenTask(chat.task.id, query.trim() || undefined);
        return;
      }
      const action = QUICK_ACTIONS[index - chats.length];
      if (action) runQuickAction(action.id);
    },
    [chats, props, runQuickAction],
  );

  return (
    <div
      className="ew-search-palette-scrim"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) props.onClose();
      }}
    >
      <section
        className="ew-search-palette"
        role="dialog"
        aria-modal="true"
        aria-label="搜索聊天"
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            props.onClose();
            return;
          }
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            const direction = event.key === 'ArrowDown' ? 1 : -1;
            setSelectedIndex((current) => (current + direction + itemCount) % itemCount);
            return;
          }
          if (event.key === 'Enter') {
            event.preventDefault();
            activate(selectedIndex);
            return;
          }
          if (!event.metaKey && !event.ctrlKey) return;
          const key = event.key.toLowerCase();
          const numeric = Number(key);
          if (Number.isInteger(numeric) && numeric >= 1 && numeric <= chats.length) {
            event.preventDefault();
            activate(numeric - 1);
          } else if (key === 'n' || key === 'o' || key === 'p') {
            event.preventDefault();
            runQuickAction(key === 'n' ? 'new-chat' : key === 'o' ? 'open-folder' : 'search-files');
          }
        }}
      >
        <label className="ew-search-palette-input">
          <span aria-hidden="true">{renderIcon('search')}</span>
          <input
            type="search"
            aria-label="搜索聊天"
            placeholder="搜索聊天"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            autoFocus
          />
          <button
            type="button"
            className="ew-pill-button"
            aria-expanded={filtersOpen}
            onClick={() => setFiltersOpen((open) => !open)}
          >
            筛选{activeFilterCount > 0 ? ` ${activeFilterCount}` : ''}
          </button>
        </label>

        {filtersOpen ? (
          <section className="ew-search-filters" aria-label="高级搜索筛选">
            <label>
              <span>状态</span>
              <select
                aria-label="按状态筛选"
                value={filters.status}
                onChange={(event) => {
                  setFilters((current) => ({
                    ...current,
                    status: event.target.value as TaskSearchFilters['status'],
                  }));
                  setSelectedIndex(0);
                }}
              >
                <option value="">全部状态</option>
                {STATUS_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>项目</span>
              <select
                aria-label="按项目筛选"
                value={filters.workspacePath}
                onChange={(event) => {
                  setFilters((current) => ({ ...current, workspacePath: event.target.value }));
                  setSelectedIndex(0);
                }}
              >
                <option value="">全部项目</option>
                {props.workspaces
                  .filter((workspace) => workspace.path)
                  .map((workspace) => (
                    <option key={workspace.id} value={workspace.path}>
                      {workspace.name}
                    </option>
                  ))}
              </select>
            </label>
            <label>
              <span>更新时间</span>
              <select
                aria-label="按更新时间筛选"
                value={filters.updatedWithin}
                onChange={(event) => {
                  setFilters((current) => ({
                    ...current,
                    updatedWithin: event.target.value as TaskSearchFilters['updatedWithin'],
                  }));
                  setSelectedIndex(0);
                }}
              >
                <option value="">不限时间</option>
                <option value="day">最近 24 小时</option>
                <option value="week">最近 7 天</option>
                <option value="month">最近 30 天</option>
              </select>
            </label>
            {activeFilterCount > 0 ? (
              <button
                type="button"
                className="ew-pill-button"
                onClick={() => {
                  setFilters(EMPTY_FILTERS);
                  setSelectedIndex(0);
                }}
              >
                清除筛选
              </button>
            ) : null}
          </section>
        ) : null}

        <div className="ew-search-palette-content">
          <div className="ew-search-palette-section-title">
            <span>聊天</span>
            {loading ? <span role="status">正在搜索…</span> : null}
          </div>
          {chats.length > 0 ? (
            <ul className="ew-search-palette-list" aria-label="聊天">
              {chats.map((hit, index) => (
                <li key={hit.task.id}>
                  <button
                    type="button"
                    className="ew-search-palette-row"
                    data-selected={selectedIndex === index}
                    onMouseEnter={() => setSelectedIndex(index)}
                    onFocus={() => setSelectedIndex(index)}
                    onClick={() => activate(index)}
                  >
                    <span
                      className="ew-search-palette-status"
                      data-status={hit.task.status}
                      aria-hidden="true"
                    />
                    <span className="ew-search-palette-chat-copy">
                      <strong>{hit.task.title ?? '未命名聊天'}</strong>
                      {query.trim() && hit.snippet ? <small>{hit.snippet}</small> : null}
                    </span>
                    <span className="ew-search-palette-project">
                      {workspaceLabel(hit.task, props.workspaces)}
                    </span>
                    <kbd>
                      {prefix}
                      {index + 1}
                    </kbd>
                  </button>
                </li>
              ))}
            </ul>
          ) : !loading ? (
            <p className="ew-search-palette-empty">
              {query.trim() || activeFilterCount > 0
                ? '没有找到匹配的聊天，调整关键词或筛选条件试试。'
                : '还没有聊天，新建一个就能开始。'}
            </p>
          ) : null}

          <div className="ew-search-palette-section-title">快捷操作</div>
          <ul className="ew-search-palette-list" aria-label="快捷操作">
            {QUICK_ACTIONS.map((action, actionIndex) => {
              const index = chats.length + actionIndex;
              return (
                <li key={action.id}>
                  <button
                    type="button"
                    className="ew-search-palette-row ew-search-palette-action"
                    data-selected={selectedIndex === index}
                    onMouseEnter={() => setSelectedIndex(index)}
                    onFocus={() => setSelectedIndex(index)}
                    onClick={() => runQuickAction(action.id)}
                  >
                    <span className="ew-search-palette-action-icon" aria-hidden="true">
                      {renderIcon(action.icon)}
                    </span>
                    <strong>{action.label}</strong>
                    <kbd>
                      {prefix}
                      {action.key}
                    </kbd>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      </section>
    </div>
  );
}
