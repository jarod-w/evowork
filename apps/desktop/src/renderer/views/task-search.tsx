import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { TaskRowView, TaskSearchHitView, WorkspaceView } from '../../shared/ipc.js';
import { renderIcon } from '../components/icons.js';

const MAX_CHAT_RESULTS = 9;

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
  const workspace = workspaces.find((candidate) => candidate.path === task.cwd);
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
        .slice(0, MAX_CHAT_RESULTS)
        .map((task) => ({ task, snippet: '' })),
    [props.tasks],
  );
  const chats = query.trim() ? hits : recent;
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
        </label>

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
              {query.trim()
                ? '没有找到匹配的聊天，换一个关键词试试。'
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
