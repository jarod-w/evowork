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
 * 1. **结果区默认收起**（`⌘I` 切换），由用户点击内容或「打开结果」展开；
 *    普通文件变更不会机械地抢开面板（类 ChatGPT UI 方案 C4）。
 * 2. **自动滚动只在用户已在底部时跟随**；用户上滑后停止跟随并显示「↓ 有新内容」（04 §5.1）。
 * 3. **状态不能只读 `ThreadStatus`**（04 §3.2 / F7）—— 状态由适配层的投影表给出，
 *    这里只渲染。
 * 4. **审批卡内联在时间线上**（不是模态），同时顶部有 `z-400` 吸顶条（04 §5.3 / 10 §3.5）。
 */
import { LAYOUT } from '@evowork/tokens';
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
import { renderIcon } from '../components/icons.js';
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

/**
 * 会被收进「处理过程」组的协议条目。未知类型故意不在这里：上游新增 item
 * 时仍要直接露出「新类型事件」这一行，否则 R2 的防线会被外层折叠悄悄吃掉。
 */
export const PROCESS_ITEM_TYPES = Object.freeze(
  new Set([
    'reasoning',
    'plan',
    'contextCompaction',
    'commandExecution',
    'mcpToolCall',
    'dynamicToolCall',
    'functionCallOutput',
    'webSearch',
    'imageView',
    'sleep',
    'fileChange',
    'enteredReviewMode',
    'exitedReviewMode',
    'subAgentActivity',
    'collabAgentToolCall',
    'hookPrompt',
    'imageGeneration',
  ]),
);

type TimelineEntry =
  | { readonly kind: 'item'; readonly item: RenderItem }
  | {
      readonly kind: 'process';
      readonly key: string;
      readonly items: readonly RenderItem[];
    };

function isProcessItem(item: RenderItem): boolean {
  return PROCESS_ITEM_TYPES.has(item.type);
}

function isTurnBoundary(item: RenderItem): boolean {
  return item.type === 'userMessage' || (!isProcessItem(item) && item.type !== 'agentMessage');
}

/**
 * 同一回合的思考、操作、变更与中间回复收成一个过程组；最终助手回复和用户消息
 * 直接铺开。中间 `agentMessage` 若还跟着过程项，就不是结论，不能切断分组。
 */
export function groupTimelineItems(items: readonly RenderItem[]): readonly TimelineEntry[] {
  const entries: TimelineEntry[] = [];
  let index = 0;
  while (index < items.length) {
    const item = items[index];
    if (!item) break;
    if (isTurnBoundary(item)) {
      entries.push({ kind: 'item', item });
      index += 1;
      continue;
    }

    const run: RenderItem[] = [];
    while (index < items.length) {
      const next = items[index];
      if (!next || isTurnBoundary(next)) break;
      run.push(next);
      index += 1;
    }

    let lastProcess = -1;
    for (let cursor = run.length - 1; cursor >= 0; cursor -= 1) {
      const candidate = run[cursor];
      if (candidate && isProcessItem(candidate)) {
        lastProcess = cursor;
        break;
      }
    }
    if (lastProcess < 0) {
      for (const visible of run) entries.push({ kind: 'item', item: visible });
      continue;
    }

    const folded = run.slice(0, lastProcess + 1);
    const first = folded[0];
    if (first) entries.push({ kind: 'process', key: first.id, items: folded });
    for (const visible of run.slice(lastProcess + 1)) entries.push({ kind: 'item', item: visible });
  }
  return entries;
}

function itemLabel(item: RenderItem): string {
  if (item.type === 'agentMessage') {
    const text = typeof item.text === 'string' ? item.text.trim().split('\n')[0] : '';
    return text || '整理回复';
  }
  if (item.type === 'reasoning') return '分析任务';
  if (item.type === 'plan') {
    const steps = Array.isArray(item.steps)
      ? (item.steps as { step?: string; status?: string }[])
      : [];
    return steps.find((step) => step.status === 'in_progress')?.step ?? '整理计划';
  }
  if (item.type === 'commandExecution') return String(item.command || '运行命令');
  if (item.type === 'webSearch') return `搜索 ${String(item.query || '资料')}`;
  if (item.type === 'mcpToolCall' || item.type === 'dynamicToolCall')
    return String(item.toolName || item.name || '调用工具');
  if (item.type === 'fileChange') return '更新文件';
  if (item.type === 'subAgentActivity' || item.type === 'collabAgentToolCall')
    return String(item.agentRole || item.nickname || '处理子任务');
  if (item.type === 'imageGeneration') return '生成图片';
  return '处理任务';
}

export interface ProcessSummary {
  readonly label: string;
  readonly action: string;
  readonly status: '进行中' | '已完成' | '失败' | '需要你处理';
  readonly detail?: string | undefined;
}

export function summarizeProcess(items: readonly RenderItem[]): ProcessSummary {
  const latest = items.at(-1) as RenderItem;
  const failed = items.some(
    (item) =>
      item.type === 'commandExecution' && typeof item.exitCode === 'number' && item.exitCode !== 0,
  );
  const needsUser = items.some(
    (item) => item.needsUserAction === true || item.status === 'pending',
  );
  const running = items.some((item) => item.completed !== true);
  const durationMs = items.reduce((total, item) => {
    if (typeof item.durationMs === 'number') return total + Math.max(0, item.durationMs);
    if (typeof item.durationSeconds === 'number')
      return total + Math.max(0, item.durationSeconds * 1000);
    return total;
  }, 0);
  const planSteps = items.flatMap((item) =>
    item.type === 'plan' && Array.isArray(item.steps) ? (item.steps as { status?: string }[]) : [],
  );
  const completedSteps = planSteps.filter((step) => step.status === 'completed').length;
  const detail =
    planSteps.length > 0
      ? `${completedSteps}/${planSteps.length} 步`
      : durationMs > 0
        ? `${Math.max(1, Math.round(durationMs / 1000))} 秒`
        : `${items.length} 项`;

  return {
    label: '处理过程',
    action: itemLabel(latest),
    status: needsUser ? '需要你处理' : failed ? '失败' : running ? '进行中' : '已完成',
    detail,
  };
}

/**
 * Cursor 式组级 disclosure：默认只见一行「处理过程」，用户点开后才挂载思考、
 * 命令、中间回复与工具输出。不是用 CSS 遮住——折叠时长输出根本不进 DOM。
 */
function ProcessGroup({
  items,
  context,
}: {
  readonly items: readonly RenderItem[];
  readonly context: ItemRenderContext;
}) {
  const [expanded, setExpanded] = useState(false);
  const visibleItems = items.filter(
    (item) =>
      !(item.type === 'reasoning' && !context.reasoningAvailable) &&
      !(item.type === 'hookPrompt' && context.hidePolicyPrompts),
  );
  if (visibleItems.length === 0) return null;
  const summary = summarizeProcess(visibleItems);

  return (
    <div
      className="ew-item ew-process-group"
      data-expanded={expanded ? 'true' : 'false'}
      role="group"
      aria-label={`${summary.label}：${summary.action}，${summary.status}`}
    >
      <button
        type="button"
        className="ew-item-summary ew-process-summary"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
      >
        <span className="ew-process-chevron" aria-hidden="true">
          {renderIcon(expanded ? 'chevron-down' : 'chevron-right')}
        </span>
        <span className="ew-process-kind">{summary.label}</span>
        <span className="ew-process-action">{summary.action}</span>
        <span className="ew-process-meta">
          {summary.status} · {summary.detail}
        </span>
      </button>
      {expanded ? (
        <div className="ew-item-body ew-process-body">
          {visibleItems.map((item) => (
            <ItemRenderer key={item.id} item={item} context={context} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

export interface TaskWorkspaceProps {
  readonly taskId?: string | undefined;
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
  /** 有可展示结果时才显示「打开结果」入口。 */
  readonly hasResults?: boolean | undefined;
  /** 顶部提示（04 §8：断连 / 上下文将满 / 预算耗尽 / 路径失效） */
  readonly notices?: readonly {
    readonly tone: 'info' | 'warning' | 'danger';
    readonly text: string;
    readonly actionLabel?: string | undefined;
    readonly onAction?: (() => void) | undefined;
  }[];
  readonly resultPanel?: React.ReactNode | undefined;
  readonly resultPanels?: Readonly<Partial<Record<ResultPane, React.ReactNode>>> | undefined;
  readonly resultOpen?: boolean | undefined;
  readonly resultTab?: ResultPane | undefined;
  readonly onResultOpenChange?: ((open: boolean) => void) | undefined;
  readonly onResultTabChange?: ((tab: ResultPane) => void) | undefined;
  /**
   * 对话区底部的 Composer。
   *
   * 03 §4.6 要的是"输入框留在原地、周围长出了对话" —— 所以任务页与首页用的是
   * **同一个组件**，由外面传进来而不是这里再造一个。这里只负责它的位置：
   * 贴在对话区底部、随内容列 800 居中。
   */
  readonly composer?: React.ReactNode | undefined;
  readonly onNewTask?: (() => void) | undefined;
  readonly onRename?: (() => void) | undefined;
  readonly onForkTask?: (() => void) | undefined;
  readonly onArchive?: (() => void) | undefined;
  readonly onDelete?: (() => void) | undefined;
  readonly artifacts?: readonly {
    readonly id: string;
    readonly name: string;
    readonly artifactType: string;
    readonly version: number;
  }[];
  readonly onOpenArtifact?: ((id: string) => void) | undefined;
  /**
   * 正在拉历史。为 true 时不显示「还没有消息」—— 那是刚创建的空态（04 §8），
   * 已完成任务加载中画那句等于撒谎。
   */
  readonly historyLoading?: boolean | undefined;
  /** 回合失败要落在对应时间线位置，而不是只出现在全局提示条。 */
  readonly turnFailure?:
    | {
        readonly summary: string;
        readonly onRetry?: (() => void) | undefined;
        readonly onOpenSettings?: (() => void) | undefined;
      }
    | undefined;
}

const TIMELINE_PAGE_SIZE = 120;
const BOTTOM_THRESHOLD = 64;

export function TaskWorkspace(props: TaskWorkspaceProps) {
  const view = STATUS_VIEW[props.status];
  const [localResultOpen, setLocalResultOpen] = useState(false);
  const [localResultTab, setLocalResultTab] = useState<ResultPane>('artifacts');
  const resultOpen = props.resultOpen ?? localResultOpen;
  const resultTab = props.resultTab ?? localResultTab;
  const [visibleCount, setVisibleCount] = useState(TIMELINE_PAGE_SIZE);
  const [hasNewContent, setHasNewContent] = useState(false);
  const [resultWidth, setResultWidth] = useState<number | undefined>(undefined);
  const conversationRef = useRef<HTMLElement | null>(null);
  const followOutputRef = useRef(true);
  const resultTriggerRef = useRef<HTMLButtonElement | null>(null);
  const setResultOpen = (open: boolean): void => {
    setLocalResultOpen(open);
    props.onResultOpenChange?.(open);
  };
  const setResultTab = (tab: ResultPane): void => {
    setLocalResultTab(tab);
    props.onResultTabChange?.(tab);
  };

  // ⌘I 切换结果区（02 §6）
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'i') {
        event.preventDefault();
        if (!props.hasResults && !props.resultPanel) return;
        setResultOpen(!resultOpen);
      }
      if (event.key === 'Escape' && resultOpen) {
        event.preventDefault();
        setResultOpen(false);
        resultTriggerRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [props.hasResults, props.resultPanel, resultOpen]);

  useEffect(() => {
    setVisibleCount(TIMELINE_PAGE_SIZE);
    followOutputRef.current = true;
    setHasNewContent(false);
  }, [props.taskId]);

  const lastItemId = props.items.at(-1)?.id;
  const failureSummary = props.turnFailure?.summary;
  useEffect(() => {
    const node = conversationRef.current;
    if (!node) return;
    if (followOutputRef.current) {
      node.scrollTop = node.scrollHeight;
      setHasNewContent(false);
    } else {
      setHasNewContent(true);
    }
  }, [props.items.length, lastItemId, props.pendingApprovals.length, failureSummary]);

  const approvalsById = useMemo(
    () => new Map(props.pendingApprovals.map((a) => [a.id, a])),
    [props.pendingApprovals],
  );
  const mountedItems = useMemo(
    () => props.items.slice(Math.max(0, props.items.length - visibleCount)),
    [props.items, visibleCount],
  );
  const hiddenItemCount = props.items.length - mountedItems.length;
  const timeline = useMemo(() => groupTimelineItems(mountedItems), [mountedItems]);

  const resizeResult = (clientX: number): void => {
    const body = conversationRef.current?.parentElement;
    if (!body) return;
    const width = body.getBoundingClientRect().right - clientX;
    setResultWidth(Math.max(LAYOUT.resultPaneMin, Math.min(LAYOUT.resultPaneMax, width)));
  };

  const beginResize = (event: React.PointerEvent<HTMLDivElement>): void => {
    event.preventDefault();
    const move = (next: PointerEvent): void => resizeResult(next.clientX);
    const stop = (): void => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', stop);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', stop);
  };

  return (
    <div className="ew-task-workspace" data-result-open={resultOpen ? 'true' : 'false'}>
      <header className="ew-title-bar">
        <h1 className="ew-task-title">{props.title ?? '未命名任务'}</h1>
        {props.status === 'running' ||
        props.status === 'planning' ||
        props.status === 'pending' ||
        props.status === 'failed' ||
        props.status === 'interrupted' ? (
          <>
            <StatusDot tone={view.tone} breathing={view.breathing} />
            <Badge variant={view.badge}>{view.label}</Badge>
          </>
        ) : null}
        <div className="ew-title-bar-actions">
          {props.onRename ? <PillButton onClick={props.onRename}>重命名</PillButton> : null}
          {props.onForkTask ? <PillButton onClick={props.onForkTask}>分叉</PillButton> : null}
          {props.onArchive ? <PillButton onClick={props.onArchive}>归档</PillButton> : null}
          {props.onDelete ? <PillButton onClick={props.onDelete}>删除</PillButton> : null}
          {props.hasResults || props.resultPanel ? (
            <button
              ref={resultTriggerRef}
              type="button"
              className="ew-pill-button"
              data-variant="ghost"
              onClick={() => setResultOpen(!resultOpen)}
            >
              {resultOpen ? '关闭结果' : '打开结果'}
            </button>
          ) : null}
        </div>
      </header>

      <div className="ew-workspace-body">
        <main
          ref={conversationRef}
          className="ew-conversation"
          aria-label="对话区"
          onScroll={(event) => {
            const node = event.currentTarget;
            followOutputRef.current =
              node.scrollHeight - node.scrollTop - node.clientHeight <= BOTTOM_THRESHOLD;
            if (followOutputRef.current) setHasNewContent(false);
          }}
        >
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
          <div
            className="ew-content-column"
            role="feed"
            aria-live="polite"
            aria-busy={props.status === 'running' || props.status === 'planning'}
          >
            {hiddenItemCount > 0 ? (
              <PillButton onClick={() => setVisibleCount((count) => count + TIMELINE_PAGE_SIZE)}>
                加载更早内容（还有 {hiddenItemCount} 项）
              </PillButton>
            ) : null}
            {props.items.length === 0 &&
            props.pendingApprovals.length === 0 &&
            !props.historyLoading &&
            props.status === 'idle' ? (
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

            {timeline.map((entry) =>
              entry.kind === 'item' ? (
                <ItemRenderer key={entry.item.id} item={entry.item} context={props.itemContext} />
              ) : (
                <ProcessGroup key={entry.key} items={entry.items} context={props.itemContext} />
              ),
            )}

            {props.items.length > 0 && (props.artifacts ?? []).length > 0 ? (
              <section className="ew-timeline-artifacts" aria-label="任务产物">
                {(props.artifacts ?? []).map((artifact) => (
                  <button
                    key={artifact.id}
                    type="button"
                    className="ew-timeline-artifact"
                    onClick={() => props.onOpenArtifact?.(artifact.id)}
                  >
                    <span className="ew-timeline-artifact-kind">{artifact.artifactType}</span>
                    <strong>{artifact.name}</strong>
                    <span>版本 {artifact.version} · 打开预览</span>
                  </button>
                ))}
              </section>
            ) : null}

            {props.status === 'interrupted' ? (
              <div className="ew-item ew-item-divider" role="separator">
                <span>已停止，可在下方继续</span>
              </div>
            ) : null}

            {props.turnFailure ? (
              <section className="ew-turn-failure" role="alert" aria-label="回合失败">
                <strong>这一回合失败了</strong>
                <p>{props.turnFailure.summary}</p>
                <div className="ew-turn-failure-actions">
                  {props.turnFailure.onRetry ? (
                    <PillButton variant="accent" onClick={props.turnFailure.onRetry}>
                      重试
                    </PillButton>
                  ) : null}
                  {props.turnFailure.onOpenSettings ? (
                    <PillButton onClick={props.turnFailure.onOpenSettings}>打开模型设置</PillButton>
                  ) : null}
                </div>
              </section>
            ) : null}

            {/* 审批卡内联在时间线上（04 §5.3），不是模态 */}
            {[...approvalsById.values()].map((approval) => (
              <ApprovalCard
                key={approval.id}
                approval={approval}
                autoFocus={approval.id === props.pendingApprovals[0]?.id}
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

          {hasNewContent ? (
            <button
              type="button"
              className="ew-new-content"
              onClick={() => {
                const node = conversationRef.current;
                if (node) node.scrollTop = node.scrollHeight;
                followOutputRef.current = true;
                setHasNewContent(false);
              }}
            >
              ↓ 有新内容
            </button>
          ) : null}
        </main>

        {resultOpen ? (
          <aside
            className="ew-result-pane"
            aria-label="结果区"
            style={resultWidth === undefined ? undefined : { width: resultWidth }}
          >
            <div
              className="ew-result-resizer"
              role="separator"
              aria-label="调整结果区宽度"
              aria-orientation="vertical"
              aria-valuemin={LAYOUT.resultPaneMin}
              aria-valuemax={LAYOUT.resultPaneMax}
              aria-valuenow={resultWidth ?? LAYOUT.resultPaneDefault}
              tabIndex={0}
              onPointerDown={beginResize}
              onKeyDown={(event) => {
                if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
                event.preventDefault();
                const direction = event.key === 'ArrowLeft' ? 1 : -1;
                const current = resultWidth ?? LAYOUT.resultPaneDefault;
                setResultWidth(
                  Math.max(
                    LAYOUT.resultPaneMin,
                    Math.min(LAYOUT.resultPaneMax, current + direction * LAYOUT.resultPaneStep),
                  ),
                );
              }}
            />
            {/* 浅色分段控件：**决定已装内容怎么看**（01 §5.10 的硬规则） */}
            <SegmentedControl
              variant="light"
              ariaLabel="结果区视图"
              items={RESULT_TABS.map((t) => ({ id: t.id, label: t.label }))}
              value={resultTab}
              onChange={(id) => setResultTab(id as ResultPane)}
            />
            <div className="ew-result-body" data-pane={resultTab}>
              {props.resultPanels?.[resultTab] ?? props.resultPanel ?? (
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
