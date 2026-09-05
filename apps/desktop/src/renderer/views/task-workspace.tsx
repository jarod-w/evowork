/**
 * 任务工作台（04）—— 三栏，M2 的主体，也是产品使用时长最集中的页面。
 *
 * ```
 * ┌──────────┬────────────────────────────────┬──────────────────┐
 * │ 侧边栏    │ 对话区                          │ 结果区（可折叠）  │
 * │ 260      │ flex · 内容列 800 居中           │ 360–560 可拖拽    │
 * └──────────┴────────────────────────────────┴──────────────────┘
 * ```
 *
 * 四条来自文档的布局与行为约束：
 *
 * 1. **结果区默认收起**（`⌘I` 切换），**首次产生产物或文件变更时自动展开一次**，
 *    之后尊重用户的开合状态（04 §1）。
 * 2. **自动滚动只在用户已在底部时跟随**；用户上滑后停止跟随并显示「↓ 有新内容」（04 §5.1）。
 * 3. **状态不能只读 `ThreadStatus`**（04 §3.2 / F7）—— 状态由适配层的投影表给出，
 *    这里只渲染。
 * 4. **审批卡内联在时间线上**（不是模态），同时顶部有 `z-400` 吸顶条（04 §5.3 / 10 §3.5）。
 */
import { useEffect, useMemo, useRef, useState } from 'react';

import {
  ApprovalCard,
  PendingApprovalBar,
  type ApprovalDecision,
  type ApprovalViewModel,
} from '../components/approval-card.js';
import {
  ItemRenderer,
  type ItemRenderContext,
  type RenderItem,
} from '../components/item-renderers.js';
import {
  Badge,
  Banner,
  EmptyState,
  PillButton,
  SegmentedControl,
  StatusDot,
} from '../components/primitives.js';

/** 与 `@evowork/store` 的 `DerivedStatus` 对应（不 import 是为了让渲染层不依赖服务层类型）。 */
export type TaskStatus =
  'running' | 'pending' | 'planning' | 'completed' | 'failed' | 'interrupted' | 'archived' | 'idle';

/** 01 §6.1 的状态视觉规范。「待你确认」用第二人称，因为它要求用户行动。 */
export const STATUS_VIEW: Readonly<
  Record<
    TaskStatus,
    {
      label: string;
      badge: 'neutral' | 'info' | 'success' | 'warning' | 'danger';
      tone: 'accent' | 'info' | 'warning' | 'danger' | 'muted';
      breathing: boolean;
    }
  >
> = Object.freeze({
  running: { label: '进行中', badge: 'success', tone: 'accent', breathing: true },
  planning: { label: '规划中', badge: 'info', tone: 'info', breathing: false },
  pending: { label: '待你确认', badge: 'warning', tone: 'warning', breathing: true },
  completed: { label: '已完成', badge: 'neutral', tone: 'muted', breathing: false },
  failed: { label: '失败', badge: 'danger', tone: 'danger', breathing: false },
  // 04 §2.2：清单没有这一态但用户会遇到 —— 映射到"已完成"会误导，映射到"失败"会让人以为出错
  interrupted: { label: '已中断，可继续', badge: 'neutral', tone: 'muted', breathing: false },
  archived: { label: '已归档', badge: 'neutral', tone: 'muted', breathing: false },
  idle: { label: '还没有开始', badge: 'neutral', tone: 'muted', breathing: false },
});

export type ResultPane = 'artifacts' | 'files' | 'changes' | 'browser';

const RESULT_TABS = [
  { id: 'artifacts', label: '产物' },
  { id: 'files', label: '文件' },
  { id: 'changes', label: '变更' },
  { id: 'browser', label: '浏览器' },
] as const;

export interface TaskWorkspaceProps {
  readonly title: string | null;
  readonly status: TaskStatus;
  readonly items: readonly RenderItem[];
  readonly pendingApprovals: readonly ApprovalViewModel[];
  readonly onDecide: (id: string, decision: ApprovalDecision) => void;
  readonly onAnswer?: (
    id: string,
    answer: { optionId?: string; text?: string },
  ) => void | undefined;
  readonly itemContext: ItemRenderContext;
  /** 有产物或文件变更时结果区自动展开一次（04 §1） */
  readonly hasResults?: boolean | undefined;
  /** 顶部提示（04 §8：断连 / 上下文将满 / 预算耗尽 / 路径失效） */
  readonly notices?: readonly {
    readonly tone: 'info' | 'warning' | 'danger';
    readonly text: string;
    readonly actionLabel?: string | undefined;
    readonly onAction?: (() => void) | undefined;
  }[];
  readonly resultPanel?: React.ReactNode | undefined;
  /**
   * 对话区底部的 Composer。
   *
   * 03 §4.6 要的是"输入框留在原地、周围长出了对话" —— 所以任务页与首页用的是
   * **同一个组件**，由外面传进来而不是这里再造一个。这里只负责它的位置：
   * 贴在对话区底部、随内容列 800 居中。
   */
  readonly composer?: React.ReactNode | undefined;
  readonly onNewTask?: (() => void) | undefined;
}

export function TaskWorkspace(props: TaskWorkspaceProps) {
  const view = STATUS_VIEW[props.status];
  const [resultOpen, setResultOpen] = useState(false);
  const [resultTab, setResultTab] = useState<ResultPane>('artifacts');
  const autoOpenedRef = useRef(false);

  // 04 §1：首次产生产物或文件变更时**自动展开一次**，之后尊重用户的开合状态
  useEffect(() => {
    if (props.hasResults && !autoOpenedRef.current) {
      autoOpenedRef.current = true;
      setResultOpen(true);
    }
  }, [props.hasResults]);

  // ⌘I 切换结果区（02 §6）
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'i') {
        event.preventDefault();
        setResultOpen((v) => !v);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const approvalsById = useMemo(
    () => new Map(props.pendingApprovals.map((a) => [a.id, a])),
    [props.pendingApprovals],
  );

  return (
    <div className="ew-task-workspace" data-result-open={resultOpen ? 'true' : 'false'}>
      <header className="ew-title-bar">
        <h1 className="ew-task-title">{props.title ?? '未命名任务'}</h1>
        <StatusDot tone={view.tone} breathing={view.breathing} />
        <Badge variant={view.badge}>{view.label}</Badge>
        <div className="ew-title-bar-actions">
          <PillButton variant="ghost" onClick={() => setResultOpen((v) => !v)}>
            {resultOpen ? '隐藏详情面板' : '显示详情面板'}
          </PillButton>
        </div>
      </header>

      <div className="ew-workspace-body">
        <main className="ew-conversation" aria-label="对话区">
          {/* z-400 吸顶条（10 §3.5）：用户可能在别的页面，回来时要能立刻看到有待确认 */}
          <PendingApprovalBar
            count={props.pendingApprovals.length}
            onJump={() => {
              document.querySelector('.ew-approval-card')?.scrollIntoView({ block: 'center' });
            }}
          />

          {(props.notices ?? []).map((notice, index) => (
            <Banner
              key={index}
              tone={notice.tone}
              action={
                notice.actionLabel ? (
                  <PillButton onClick={notice.onAction}>{notice.actionLabel}</PillButton>
                ) : undefined
              }
            >
              {notice.text}
            </Banner>
          ))}

          {/* 内容列 800 居中（01 §3.1 的全局硬约束） */}
          <div className="ew-content-column" aria-live="polite">
            {props.items.length === 0 && props.pendingApprovals.length === 0 ? (
              <EmptyState
                title="输入你的第一个需求"
                hint="这个任务还没有消息。说清你要什么产物，我直接做出来。"
                action={
                  props.onNewTask ? (
                    <PillButton onClick={props.onNewTask}>新建任务</PillButton>
                  ) : undefined
                }
              />
            ) : null}

            {props.items.map((item) => (
              <ItemRenderer key={item.id} item={item} context={props.itemContext} />
            ))}

            {/* 审批卡内联在时间线上（04 §5.3），不是模态 */}
            {[...approvalsById.values()].map((approval) => (
              <ApprovalCard
                key={approval.id}
                approval={approval}
                onDecide={(decision) => props.onDecide(approval.id, decision)}
                {...(props.onAnswer
                  ? { onAnswer: (answer) => props.onAnswer?.(approval.id, answer) }
                  : {})}
              />
            ))}
          </div>

          {props.composer ? (
            <div className="ew-conversation-composer">
              <div className="ew-content-column">{props.composer}</div>
            </div>
          ) : null}
        </main>

        {resultOpen ? (
          <aside className="ew-result-pane" aria-label="结果区">
            {/* 浅色分段控件：**决定已装内容怎么看**（01 §5.10 的硬规则） */}
            <SegmentedControl
              variant="light"
              ariaLabel="结果区视图"
              items={RESULT_TABS.map((t) => ({ id: t.id, label: t.label }))}
              value={resultTab}
              onChange={(id) => setResultTab(id as ResultPane)}
            />
            <div className="ew-result-body" data-pane={resultTab}>
              {props.resultPanel ?? (
                <EmptyState
                  title="还没有产物"
                  hint="文档、表格、幻灯片等交付物生成后会自动收集到这里。"
                />
              )}
            </div>
          </aside>
        ) : null}
      </div>
    </div>
  );
}
