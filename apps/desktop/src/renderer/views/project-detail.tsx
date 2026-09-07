/**
 * 项目详情页（02 §4.3，三栏）。
 *
 * ## 为什么文件树上有一个刷新按钮
 *
 * D-P5：不接 `fs/watch`。那就必须让"这棵树可能是旧的"这件事**在界面上可见** ——
 * 一个刷新按钮同时是能力与声明。没有它，用户会以为树是实时的，
 * 然后在 agent 刚生成完文件时对着一棵没变的树发愣。
 *
 * ## 空间记忆为什么区分「不存在」与「空」
 *
 * `<root>/AGENTS.md` 不存在 = 这个空间还没有长期指令；内容为空 = 用户自己清空了。
 * 两者在界面上说的话不同，所以 `AgentsMemoView` 带 `exists` 而不是只给一个字符串。
 */
import { useEffect, useState } from 'react';

import type {
  AgentsMemoView,
  DirEntryView,
  ProjectDetailView,
  WriteAgentsMemoResult,
} from '../../shared/ipc.js';
import { DataTable, PanelHeader, TreeItem, TreeSectionHeader } from '../components/panels.js';
import {
  Banner,
  EmptyState,
  IconButton,
  PillButton,
  TaskListItem,
} from '../components/primitives.js';
// 状态 → 圆点色与呼吸。侧边栏用的是同一张表，别在这里再写一份
import { STATUS_VIEW } from './task-workspace.js';

export interface ProjectDetailPageProps {
  readonly detail: ProjectDetailView;
  readonly rootEntries: readonly DirEntryView[];
  /** 已展开目录的子项，按目录绝对路径索引。**由上层持有** —— 页面自己不发 IPC */
  readonly childrenOf: Readonly<Record<string, readonly DirEntryView[]>>;
  readonly memo: AgentsMemoView;
  readonly onBack: () => void;
  readonly onExpand: (path: string) => void;
  readonly onRefreshTree: () => void;
  readonly onOpenTask: (threadId: string) => void;
  readonly onOpenFolder: () => void;
  readonly onNewTaskHere: () => void;
  /** C3：结果必须回读——`ok` 为假时页面不能显示"已保存"，且要把 `refused` 亮出来 */
  readonly onSaveMemo: (content: string) => Promise<WriteAgentsMemoResult>;
  readonly onOpenAutomation: (id: string) => void;
}

const MISSING_REASON = '这个空间的路径已失效，先重新指定再新建任务。';

function TreeNode({
  entry,
  depth,
  expanded,
  childrenOf,
  onToggle,
}: {
  readonly entry: DirEntryView;
  readonly depth: number;
  readonly expanded: ReadonlySet<string>;
  readonly childrenOf: Readonly<Record<string, readonly DirEntryView[]>>;
  readonly onToggle: (entry: DirEntryView) => void;
}) {
  const isOpen = expanded.has(entry.path);
  return (
    <>
      <TreeItem
        label={entry.name}
        depth={depth}
        // 噪声目录弱化但**仍然在列表里**（D-P5）
        muted={entry.noisy}
        icon={entry.isDirectory ? (isOpen ? '📂' : '📁') : '📄'}
        onClick={() => onToggle(entry)}
      />
      {isOpen
        ? (childrenOf[entry.path] ?? []).map((child) => (
            <TreeNode
              key={child.path}
              entry={child}
              depth={depth + 1}
              expanded={expanded}
              childrenOf={childrenOf}
              onToggle={onToggle}
            />
          ))
        : null}
    </>
  );
}

export function ProjectDetailPage(props: ProjectDetailPageProps) {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [draft, setDraft] = useState(props.memo.content);
  const [saved, setSaved] = useState(false);
  /** C3：写失败时的原话——不能只是"没显示已保存"，要说清楚为什么 */
  const [memoRefused, setMemoRefused] = useState<string | undefined>(undefined);

  // 换空间时把编辑中的内容换掉 —— 否则 A 空间的草稿会存进 B 空间的 AGENTS.md
  useEffect(() => {
    setDraft(props.memo.content);
    setSaved(false);
    setMemoRefused(undefined);
  }, [props.memo.content, props.detail.id]);

  const toggle = (entry: DirEntryView) => {
    if (!entry.isDirectory) return;
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(entry.path)) next.delete(entry.path);
      else {
        next.add(entry.path);
        // 展开哪层读哪层，不递归预取
        props.onExpand(entry.path);
      }
      return next;
    });
  };

  return (
    <div className="ew-project-detail">
      <aside className="ew-panel">
        <PanelHeader
          title={props.detail.name}
          actions={
            <IconButton
              label="返回项目列表"
              icon={<span aria-hidden="true">←</span>}
              onClick={props.onBack}
            />
          }
        />

        <TreeSectionHeader label={`任务 (${props.detail.tasks.length})`} />
        {props.detail.tasks.length === 0 ? (
          <p className="ew-panel-empty">这个空间还没有任务。</p>
        ) : (
          props.detail.tasks.map((task) => (
            <TaskListItem
              key={task.id}
              title={task.title ?? '未命名任务'}
              time={task.timeLabel}
              tone={STATUS_VIEW[task.status].tone}
              breathing={STATUS_VIEW[task.status].breathing}
              onClick={() => props.onOpenTask(task.id)}
            />
          ))
        )}

        <TreeSectionHeader
          label="文件"
          action={
            <IconButton
              label="刷新文件树"
              icon={<span aria-hidden="true">⟳</span>}
              onClick={props.onRefreshTree}
            />
          }
        />
        {props.rootEntries.map((entry) => (
          <TreeNode
            key={entry.path}
            entry={entry}
            depth={0}
            expanded={expanded}
            childrenOf={props.childrenOf}
            onToggle={toggle}
          />
        ))}
      </aside>

      <main className="ew-project-main">
        <header className="ew-project-head">
          <h1 className="ew-project-name">{props.detail.name}</h1>
          <p className="ew-project-root">{props.detail.rootDisplay}</p>
          <div className="ew-project-actions">
            <PillButton
              variant="accent"
              disabled={props.detail.rootMissing}
              {...(props.detail.rootMissing ? { disabledReason: MISSING_REASON } : {})}
              onClick={props.onNewTaskHere}
            >
              在此空间新建任务
            </PillButton>
            <PillButton onClick={props.onOpenFolder}>打开所在文件夹</PillButton>
          </div>
        </header>

        {props.detail.rootMissing ? (
          <Banner tone="warning">
            路径已失效：这个空间的目录已经不在了。它的历史任务与产物索引都还在，
            但新任务需要先重新指定目录。
          </Banner>
        ) : null}

        <section className="ew-project-section">
          <h2 className="ew-project-section-title">最近的文件动作</h2>
          {props.detail.fileActions.length === 0 ? (
            <EmptyState
              title="还没有文件动作"
              hint="这个空间里的任务生成或修改文件后会出现在这里。"
            />
          ) : (
            <DataTable
              ariaLabel="最近的文件动作"
              rows={props.detail.fileActions}
              columns={[
                { id: 'name', header: '文件', render: (row) => row.name },
                { id: 'action', header: '动作', render: (row) => row.action },
                { id: 'task', header: '来自哪个任务', render: (row) => row.fromTaskTitle ?? '—' },
                {
                  id: 'at',
                  header: '时间',
                  render: (row) => new Date(row.at).toLocaleString(),
                  sortValue: (row) => row.at,
                },
              ]}
              {...(props.detail.fileActions.some((a) => a.threadId !== undefined)
                ? {
                    onRowClick: (row: (typeof props.detail.fileActions)[number]) => {
                      if (row.threadId !== undefined) props.onOpenTask(row.threadId);
                    },
                  }
                : {})}
            />
          )}
        </section>

        <section className="ew-project-section">
          <h2 className="ew-project-section-title">绑定的自动化</h2>
          {props.detail.automations.length === 0 ? (
            <EmptyState title="没有自动化绑定到这个空间" />
          ) : (
            <DataTable
              ariaLabel="绑定的自动化"
              rows={props.detail.automations}
              onRowClick={(row) => props.onOpenAutomation(row.id)}
              columns={[
                { id: 'name', header: '名称', render: (row) => row.name },
                { id: 'schedule', header: '计划', render: (row) => row.schedule },
                { id: 'status', header: '状态', render: (row) => row.status },
              ]}
            />
          )}
        </section>

        <section className="ew-project-section">
          <h2 className="ew-project-section-title">空间记忆</h2>
          {props.memo.exists ? null : (
            <p className="ew-project-memo-hint">
              还没有空间记忆。写在这里的内容会作为这个空间的长期指令交给 agent （存成目录下的
              AGENTS.md）。
            </p>
          )}
          <textarea
            aria-label="空间记忆"
            className="ew-project-memo"
            value={draft}
            onChange={(event) => {
              setDraft(event.target.value);
              setSaved(false);
              setMemoRefused(undefined);
            }}
          />
          {/*
           * C3：`已保存` 以前是 `onSaveMemo(draft).then(() => setSaved(true))`——
           * 不看 `writeAgentsMemo` 到底成没成功，无条件显示。这里改成读结果的 `ok`，
           * 拒绝时把 `refused` 摆出来，而不是让用户以为写进去了。
           */}
          {memoRefused ? <Banner tone="danger">{memoRefused}</Banner> : null}
          <div className="ew-project-memo-actions">
            <PillButton
              variant="accent"
              onClick={() => {
                void props.onSaveMemo(draft).then((result) => {
                  setSaved(result.ok);
                  setMemoRefused(
                    result.ok ? undefined : (result.refused ?? '没能保存，稍后再试。'),
                  );
                });
              }}
            >
              保存
            </PillButton>
            {saved ? <span className="ew-project-memo-saved">已保存</span> : null}
          </div>
        </section>
      </main>
    </div>
  );
}
