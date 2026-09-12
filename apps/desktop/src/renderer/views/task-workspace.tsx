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
import { useEffect, useMemo, useState } from 'react';

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
 * 04 §5.2 的五类过程块里，会被收进「思考过程」组的协议条目。
 *
 * 未知类型故意不在这里：上游新增 item 时仍要直接露出「新类型事件」这一行，
 * 否则 R2 的防线会被外层折叠悄悄吃掉。
 */
const PROCESS_ITEM_TYPES = new Set([
  'reasoning',
  'commandExecution',
  'mcpToolCall',
  'dynamicToolCall',
  'functionCallOutput',
  'webSearch',
  'imageView',
  'subAgentActivity',
  'collabAgentToolCall',
  'sleep',
  'hookPrompt',
]);

type TimelineEntry =
  | { readonly kind: 'item'; readonly item: RenderItem }
  | { readonly kind: 'process'; readonly key: string; readonly items: readonly RenderItem[] };

/** 连续的过程项合成一个稳定分组；结论性消息会自然切断前后两个过程。 */
export function groupTimelineItems(items: readonly RenderItem[]): readonly TimelineEntry[] {
  const entries: TimelineEntry[] = [];
  let processItems: RenderItem[] = [];

  const flush = (): void => {
    const first = processItems[0];
    if (!first) return;
    entries.push({ kind: 'process', key: first.id, items: processItems });
    processItems = [];
  };

  for (const item of items) {
    if (PROCESS_ITEM_TYPES.has(item.type)) {
      processItems.push(item);
      continue;
    }
    flush();
    entries.push({ kind: 'item', item });
  }
  flush();
  return entries;
}

function processSummary(items: readonly RenderItem[]): string {
  if (items.some((item) => item.completed !== true)) return '思考中…';

  const seconds = items.reduce(
    (total, item) =>
      item.type === 'reasoning' && typeof item.durationSeconds === 'number'
        ? total + Math.max(0, item.durationSeconds)
        : total,
    0,
  );
  if (seconds > 0) return `已思考 ${seconds} 秒`;
  if (items.some((item) => item.type === 'reasoning')) return '已思考不到 1 秒';
  return '处理过程';
}

/**
 * Codex 式组级 disclosure：默认只见一行状态，用户主动展开后才挂载内部推理、
 * 命令与工具输出。不是用 CSS 遮住——折叠时长输出根本不进 DOM。
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

  return (
    <div className="ew-item ew-process-group" data-expanded={expanded ? 'true' : 'false'}>
      <button
        type="button"
        className="ew-item-summary ew-process-summary"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
      >
        <span className="ew-process-chevron" aria-hidden="true">
          {renderIcon(expanded ? 'chevron-down' : 'chevron-right')}
        </span>
        <span>{processSummary(visibleItems)}</span>
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
  /**
   * 正在拉历史。为 true 时不显示「还没有消息」—— 那是刚创建的空态（04 §8），
   * 已完成任务加载中画那句等于撒谎。
   */
  readonly historyLoading?: boolean | undefined;
}

export function TaskWorkspace(props: TaskWorkspaceProps) {
  const view = STATUS_VIEW[props.status];
  const [localResultOpen, setLocalResultOpen] = useState(false);
  const [localResultTab, setLocalResultTab] = useState<ResultPane>('artifacts');
  const resultOpen = props.resultOpen ?? localResultOpen;
  const resultTab = props.resultTab ?? localResultTab;
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
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [props.hasResults, props.resultPanel, resultOpen]);

  const approvalsById = useMemo(
    () => new Map(props.pendingApprovals.map((a) => [a.id, a])),
    [props.pendingApprovals],
  );
  const timeline = useMemo(() => groupTimelineItems(props.items), [props.items]);

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
          {props.hasResults || props.resultPanel ? (
            <PillButton variant="ghost" onClick={() => setResultOpen(!resultOpen)}>
              {resultOpen ? '关闭结果' : '打开结果'}
            </PillButton>
          ) : null}
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
