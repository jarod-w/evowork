import { useEffect, useState } from 'react';

import type { TaskSearchHitView } from '../../shared/ipc.js';
import { EmptyState, SearchInput } from '../components/primitives.js';

export function TaskSearchPage(props: {
  readonly onSearch: (query: string) => Promise<readonly TaskSearchHitView[]>;
  readonly onOpenTask: (id: string) => void;
}) {
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<readonly TaskSearchHitView[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const term = query.trim();
    if (!term) {
      setHits([]);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      setLoading(true);
      void props
        .onSearch(term)
        .then((result) => {
          if (!cancelled) setHits(result);
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

  return (
    <main className="ew-page ew-task-search-page">
      <div className="ew-content-column">
        <h1>搜索任务</h1>
        <SearchInput
          ariaLabel="搜索任务"
          placeholder="搜索标题与对话内容"
          value={query}
          onChange={setQuery}
          autoFocus
        />
        {loading ? <p role="status">正在搜索…</p> : null}
        {!loading && query.trim() && hits.length === 0 ? (
          <EmptyState title="没有找到" hint="换一个标题或正文关键词试试。" />
        ) : null}
        <ul className="ew-task-search-results">
          {hits.map((hit) => (
            <li key={hit.task.id}>
              <button type="button" onClick={() => props.onOpenTask(hit.task.id)}>
                <strong>{hit.task.title ?? '未命名任务'}</strong>
                <span>{hit.snippet}</span>
                <small>{hit.task.timeLabel}</small>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </main>
  );
}
