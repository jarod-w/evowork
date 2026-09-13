import { useState } from 'react';

import type { DirEntryView } from '../../shared/ipc.js';
import { IconButton } from './primitives.js';
import { TreeItem } from './panels.js';

export interface FileTreeProps {
  readonly entries: readonly DirEntryView[];
  readonly childrenOf?: Readonly<Record<string, readonly DirEntryView[]>> | undefined;
  readonly onExpand?: ((path: string) => void) | undefined;
  readonly onRefresh?: (() => void) | undefined;
  readonly onFileOpen?: ((entry: DirEntryView) => void) | undefined;
  readonly ariaLabel?: string | undefined;
}

/**
 * 项目页与任务结果区共用的文件树。
 *
 * 展开状态属于当前视图，目录内容由宿主持有：这样项目页可以懒加载，结果区也可以只展示
 * 已经拿到的根目录，不会为了复用视觉组件而偷偷增加磁盘扫描。
 */
export function FileTree({
  entries,
  childrenOf = {},
  onExpand,
  onRefresh,
  onFileOpen,
  ariaLabel = '项目文件',
}: FileTreeProps) {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());

  const toggle = (entry: DirEntryView): void => {
    if (!entry.isDirectory) return;
    setExpanded((previous) => {
      const next = new Set(previous);
      if (next.has(entry.path)) {
        next.delete(entry.path);
      } else {
        next.add(entry.path);
        onExpand?.(entry.path);
      }
      return next;
    });
  };

  return (
    <section className="ew-file-tree" aria-label={ariaLabel}>
      {onRefresh ? (
        <div className="ew-file-tree-toolbar">
          <IconButton
            label="刷新文件树"
            icon={<span aria-hidden="true">⟳</span>}
            onClick={onRefresh}
          />
        </div>
      ) : null}
      <div className="ew-file-tree-items">
        {entries.map((entry) => (
          <FileTreeNode
            key={entry.path}
            entry={entry}
            depth={0}
            expanded={expanded}
            childrenOf={childrenOf}
            onToggle={toggle}
            onFileOpen={onFileOpen}
          />
        ))}
      </div>
    </section>
  );
}

function FileTreeNode({
  entry,
  depth,
  expanded,
  childrenOf,
  onToggle,
  onFileOpen,
}: {
  readonly entry: DirEntryView;
  readonly depth: number;
  readonly expanded: ReadonlySet<string>;
  readonly childrenOf: Readonly<Record<string, readonly DirEntryView[]>>;
  readonly onToggle: (entry: DirEntryView) => void;
  readonly onFileOpen?: ((entry: DirEntryView) => void) | undefined;
}) {
  const isOpen = expanded.has(entry.path);
  return (
    <>
      <TreeItem
        label={entry.name}
        depth={depth}
        muted={entry.noisy}
        icon={entry.isDirectory ? (isOpen ? '📂' : '📁') : '📄'}
        onClick={() => (entry.isDirectory ? onToggle(entry) : onFileOpen?.(entry))}
      />
      {isOpen
        ? (childrenOf[entry.path] ?? []).map((child) => (
            <FileTreeNode
              key={child.path}
              entry={child}
              depth={depth + 1}
              expanded={expanded}
              childrenOf={childrenOf}
              onToggle={onToggle}
              onFileOpen={onFileOpen}
            />
          ))
        : null}
    </>
  );
}
