/** 项目详情：把任务、文件、项目说明与自动化收敛为四个明确视图。 */
import { useEffect, useLayoutEffect, useState } from 'react';

import type {
  AgentsMemoView,
  DirEntryView,
  ProjectDetailView,
  WriteAgentsMemoResult,
} from '../../shared/ipc.js';
import { FileTree } from '../components/file-tree.js';
import { DataTable, TextTabs } from '../components/panels.js';
import {
  Banner,
  EmptyState,
  IconButton,
  PillButton,
  TaskListItem,
} from '../components/primitives.js';
import { STATUS_VIEW } from './task-workspace.js';

export interface ProjectDetailPageProps {
  readonly detail: ProjectDetailView;
  readonly rootEntries: readonly DirEntryView[];
  readonly childrenOf: Readonly<Record<string, readonly DirEntryView[]>>;
  readonly memo: AgentsMemoView;
  readonly onBack: () => void;
  readonly onExpand: (path: string) => void;
  readonly onRefreshTree: () => void;
  readonly onOpenTask: (threadId: string) => void;
  readonly onOpenFolder: () => void;
  readonly onNewTaskHere: () => void;
  readonly onSaveMemo: (content: string) => Promise<WriteAgentsMemoResult>;
  readonly onOpenAutomation: (id: string) => void;
}

type ProjectTab = 'tasks' | 'files' | 'instructions' | 'automations';

const PROJECT_TABS = [
  { id: 'tasks', label: '任务' },
  { id: 'files', label: '文件' },
  { id: 'instructions', label: '项目说明' },
  { id: 'automations', label: '自动化' },
] as const;

const MISSING_REASON = '这个项目的路径已失效，先重新指定再新建任务。';

export function ProjectDetailPage(props: ProjectDetailPageProps) {
  const [tab, setTab] = useState<ProjectTab>('tasks');
  const [draft, setDraft] = useState(props.memo.content);
  const [saved, setSaved] = useState(false);
  const [memoRefused, setMemoRefused] = useState<string | undefined>(undefined);

  useEffect(() => {
    setDraft(props.memo.content);
    setSaved(false);
    setMemoRefused(undefined);
  }, [props.memo.content, props.detail.id]);

  useLayoutEffect(() => {
    setTab('tasks');
  }, [props.detail.id]);

  return (
    <main className="ew-project-detail">
      <header className="ew-project-head">
        <IconButton
          label="返回项目列表"
          icon={<span aria-hidden="true">←</span>}
          onClick={props.onBack}
        />
        <div className="ew-project-heading">
          <h1 className="ew-project-name">{props.detail.name}</h1>
          <p className="ew-project-root">本地目录：{props.detail.rootDisplay}</p>
        </div>
        <div className="ew-project-actions">
          <PillButton onClick={props.onOpenFolder}>打开文件夹</PillButton>
          <PillButton
            variant="accent"
            disabled={props.detail.rootMissing}
            {...(props.detail.rootMissing ? { disabledReason: MISSING_REASON } : {})}
            onClick={props.onNewTaskHere}
          >
            在项目中新建任务
          </PillButton>
        </div>
      </header>

      {props.detail.rootMissing ? (
        <Banner tone="warning">
          路径已失效：这个项目的本地目录已经不在了。历史任务与产物索引仍会保留，
          但新任务需要先重新指定目录。
        </Banner>
      ) : null}

      <TextTabs
        ariaLabel="项目内容"
        value={tab}
        items={PROJECT_TABS}
        onChange={(id) => setTab(id as ProjectTab)}
      />

      <section className="ew-project-tab-panel" aria-live="polite">
        {tab === 'tasks' ? (
          props.detail.tasks.length === 0 ? (
            <EmptyState title="这个项目还没有任务" hint="在项目中新建任务后，会显示在这里。" />
          ) : (
            <ul className="ew-project-task-list" aria-label="项目任务">
              {props.detail.tasks.map((task) => (
                <li key={task.id}>
                  <TaskListItem
                    title={task.title ?? '未命名任务'}
                    time={task.timeLabel}
                    tone={STATUS_VIEW[task.status].tone}
                    breathing={STATUS_VIEW[task.status].breathing}
                    onClick={() => props.onOpenTask(task.id)}
                  />
                </li>
              ))}
            </ul>
          )
        ) : null}

        {tab === 'files' ? (
          <>
            <FileTree
              entries={props.rootEntries}
              childrenOf={props.childrenOf}
              onExpand={props.onExpand}
              onRefresh={props.onRefreshTree}
            />
            <section className="ew-project-section">
              <h2 className="ew-project-section-title">最近的文件动作</h2>
              {props.detail.fileActions.length === 0 ? (
                <EmptyState
                  title="还没有文件动作"
                  hint="这个项目中的任务生成或修改文件后会出现在这里。"
                />
              ) : (
                <DataTable
                  ariaLabel="最近的文件动作"
                  rows={props.detail.fileActions}
                  columns={[
                    { id: 'name', header: '文件', render: (row) => row.name },
                    { id: 'action', header: '动作', render: (row) => row.action },
                    {
                      id: 'task',
                      header: '来自哪个任务',
                      render: (row) => row.fromTaskTitle ?? '—',
                    },
                    {
                      id: 'at',
                      header: '时间',
                      render: (row) => new Date(row.at).toLocaleString(),
                      sortValue: (row) => row.at,
                    },
                  ]}
                  {...(props.detail.fileActions.some((action) => action.threadId !== undefined)
                    ? {
                        onRowClick: (row: (typeof props.detail.fileActions)[number]) => {
                          if (row.threadId !== undefined) props.onOpenTask(row.threadId);
                        },
                      }
                    : {})}
                />
              )}
            </section>
          </>
        ) : null}

        {tab === 'instructions' ? (
          <section className="ew-project-section ew-project-instructions">
            <h2 className="ew-project-section-title">项目说明</h2>
            {!props.memo.exists ? (
              <p className="ew-project-memo-hint">
                还没有项目说明。这里的内容会作为长期说明，影响这个项目后续新建的任务。
              </p>
            ) : (
              <p className="ew-project-memo-hint">
                修改后会影响这个项目后续新建的任务，不会改写已经完成的对话。
              </p>
            )}
            <textarea
              aria-label="项目说明"
              className="ew-project-memo"
              value={draft}
              onChange={(event) => {
                setDraft(event.target.value);
                setSaved(false);
                setMemoRefused(undefined);
              }}
            />
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
                保存项目说明
              </PillButton>
              {saved ? <span className="ew-project-memo-saved">已保存</span> : null}
            </div>
          </section>
        ) : null}

        {tab === 'automations' ? (
          <section className="ew-project-section">
            {props.detail.automations.length === 0 ? (
              <EmptyState title="没有自动化绑定到这个项目" />
            ) : (
              <DataTable
                ariaLabel="绑定的自动化"
                rows={props.detail.automations}
                onRowClick={(row) => props.onOpenAutomation(row.id)}
                columns={[
                  { id: 'name', header: '名称', render: (row) => row.name },
                  { id: 'schedule', header: '计划', render: (row) => row.schedule },
                  {
                    id: 'next',
                    header: '下次运行',
                    render: (row) =>
                      row.nextFireAt === undefined
                        ? '—'
                        : new Date(row.nextFireAt).toLocaleString(),
                  },
                  { id: 'status', header: '状态', render: (row) => row.status },
                ]}
              />
            )}
          </section>
        ) : null}
      </section>
    </main>
  );
}
