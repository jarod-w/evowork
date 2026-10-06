/**
 * 任务工作台（04）—— 三栏，M2 的主体，也是产品使用时长最集中的页面。
 *
 * ```
 * ┌──────────┬────────────────────────────────┬──────────────────┐
 * │ 侧边栏    │ 对话区                          │ 结果区（可折叠）  │
 * │ 275      │ flex · 内容列 768 居中           │ 42% · 420–720     │
 * └──────────┴────────────────────────────────┴──────────────────┘
 * ```
 *
 * 四条来自文档的布局与行为约束：
 *
 * 1. **有结果时默认显示**（`⌘I` 切换），用户手动收起后不再被内容变化抢开；
 *    普通文件变更不会机械地抢开面板（类 ChatGPT UI 方案 C4）。
 * 2. **自动滚动只在用户已在底部时跟随**；用户上滑后停止跟随并显示「↓ 有新内容」（04 §5.1）。
 * 3. **状态不能只读 `ThreadStatus`**（04 §3.2 / F7）—— 状态由适配层的投影表给出，
 *    这里只渲染。
 * 4. **审批卡内联在时间线上**（不是模态），同时顶部有 `z-400` 吸顶条（04 §5.3 / 10 §3.5）。
 */
import { LAYOUT } from '@evowork/tokens';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';

import {
  activityIcon,
  activityKinds,
  activityState,
  describeActivity,
} from '../../shared/activity.js';
import type { TurnView } from '../../shared/ipc.js';
import type { TaskGoalView } from '../../shared/ipc.js';
import { webSourcesByItem, type WebSource } from '../../shared/web-sources.js';

import { GOAL_STATUS_LABELS } from '../../shared/goal-command.js';
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
import { Menu, Popover, type MenuItemSpec } from '../components/menu.js';
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
 * 会被收进相邻操作组的协议条目。未知类型故意不在这里：上游新增 item
 * 时仍要直接露出「新类型事件」这一行，否则 R2 的防线会被外层折叠悄悄吃掉。
 */
export const PROCESS_ITEM_TYPES = Object.freeze(
  new Set([
    'commandExecution',
    'mcpToolCall',
    'dynamicToolCall',
    'functionCallOutput',
    'webSearch',
    'imageView',
    'sleep',
    'subAgentActivity',
    'collabAgentToolCall',
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

/** 只合并同回合内相邻操作，说明与结论都保持到达位置。 */
export function groupTimelineItems(items: readonly RenderItem[]): readonly TimelineEntry[] {
  const entries: TimelineEntry[] = [];
  let group: RenderItem[] | undefined;
  for (const item of items) {
    if (!isProcessItem(item)) {
      entries.push({ kind: 'item', item });
      group = undefined;
    } else if (group && group[0]?._turnId === item._turnId) {
      group.push(item);
    } else {
      group = [item];
      entries.push({ kind: 'process', key: item.id, items: group });
    }
  }
  return entries;
}

export interface ProcessSummary {
  readonly label: string;
  readonly status: '进行中' | '已完成' | '失败' | '已中断' | '需要你处理';
  readonly detail?: string | undefined;
}

export function summarizeProcess(items: readonly RenderItem[]): ProcessSummary {
  const states = items.map(activityState);
  const status = states.includes('pending')
    ? '需要你处理'
    : states.includes('running')
      ? '进行中'
      : states.includes('interrupted')
        ? '已中断'
        : '已完成';
  const failed = states.filter((state) => state === 'failed').length;
  const kinds = [...new Set(items.flatMap(activityKinds))];
  return {
    label: `${status === '进行中' ? '正在' : status === '需要你处理' ? '待确认：' : status === '已中断' ? '已中断：' : '已'}${kinds.join(' · ')}`,
    status,
    ...(failed > 0 ? { detail: `${failed} 项操作失败` } : {}),
  };
}

/** 摘要默认折叠；当前操作仍可见，用户的展开选择不会被完成事件覆盖。 */
function ProcessGroup({
  items,
  context,
  focusItemId,
  sourceContexts,
}: {
  readonly items: readonly RenderItem[];
  readonly context: ItemRenderContext;
  readonly focusItemId?: string | undefined;
  readonly sourceContexts?: ReadonlyMap<string, readonly WebSource[]> | undefined;
}) {
  const [userExpanded, setUserExpanded] = useState(false);
  const [visibleCount, setVisibleCount] = useState(120);
  const expanded = userExpanded || items.some((item) => item.id === focusItemId);
  useEffect(() => {
    const index = items.findIndex((item) => item.id === focusItemId);
    if (index >= 0) setVisibleCount((count) => Math.max(count, items.length - index));
  }, [items, focusItemId]);
  const summary = summarizeProcess(items);
  const current = [...items]
    .reverse()
    .find((item) => activityState(item) === 'running' || activityState(item) === 'pending');
  return (
    <div
      className="ew-item ew-process-group"
      data-expanded={expanded ? 'true' : 'false'}
      role="group"
      aria-label={`操作记录，${summary.status}`}
    >
      <button
        type="button"
        className="ew-item-summary ew-process-summary"
        aria-expanded={expanded}
        aria-label={`操作记录：${summary.label}，${summary.status}${summary.detail ? `，${summary.detail}` : ''}`}
        onClick={() => setUserExpanded((value) => !value)}
      >
        <span className="ew-process-chevron" aria-hidden="true">
          {renderIcon(activityIcon(items[0] ?? { type: 'unknown' }))}
        </span>
        <span className="ew-process-kind">{summary.label}</span>
        {summary.detail ? <span className="ew-process-meta">{summary.detail}</span> : null}
        <span className="ew-process-chevron" aria-hidden="true">
          {renderIcon(expanded ? 'chevron-down' : 'chevron-right')}
        </span>
      </button>
      {!expanded && current ? (
        <div
          className="ew-current-activity"
          aria-label="当前动作"
          title={describeActivity(current)}
        >
          {renderIcon(activityIcon(current))}
          <span>{describeActivity(current)}</span>
        </div>
      ) : null}
      {expanded ? (
        <div className="ew-process-body">
          {items.length > visibleCount ? (
            <PillButton onClick={() => setVisibleCount((count) => count + 120)}>
              加载更早操作（还有 {items.length - visibleCount} 项）
            </PillButton>
          ) : null}
          {items.slice(-visibleCount).map((item) => (
            <div key={item.id} data-task-item-id={item.id}>
              <ItemRenderer
                item={item}
                context={{ ...context, webSources: sourceContexts?.get(item.id) }}
              />
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function formatTurnDuration(durationMs: number): string {
  const seconds = Math.max(0, Math.floor(durationMs / 1000));
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  return hours > 0
    ? `${hours} 小时 ${minutes % 60} 分钟 ${seconds % 60} 秒`
    : minutes > 0
      ? `${minutes} 分钟 ${seconds % 60} 秒`
      : `${seconds} 秒`;
}

/** 计时只订阅当前仍在运行的回合，终态和未知时间不制造计时器。 */
function TurnHeader({ turn }: { readonly turn: TurnView }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (turn.status !== 'inProgress' || turn.startedAtMs === undefined) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [turn.id, turn.status, turn.startedAtMs]);
  const end = turn.status === 'inProgress' ? now : turn.completedAtMs;
  const duration =
    turn.status !== 'inProgress' && turn.durationMs !== undefined
      ? turn.durationMs
      : turn.startedAtMs !== undefined && end !== undefined
        ? Math.max(0, end - turn.startedAtMs)
        : undefined;
  const suffix =
    turn.status === 'failed'
      ? ' · 失败'
      : turn.status === 'interrupted'
        ? ' · 已停止'
        : turn.status === 'disconnected'
          ? ' · 连接中断'
          : '';
  return (
    <div className="ew-turn-header" aria-label="回合处理时间">
      {duration === undefined
        ? turn.status === 'inProgress'
          ? '正在处理'
          : '处理记录'
        : `已处理 ${formatTurnDuration(duration)}`}
      {suffix}
    </div>
  );
}

export interface TaskWorkspaceProps {
  readonly taskId?: string | undefined;
  readonly title: string | null;
  readonly status: TaskStatus;
  /** 子代理 thread 的时间线只读；继续交代会经根代理的 V2 协作通道转发。 */
  readonly subagentContext?:
    | {
        readonly parentThreadId: string;
        readonly parentTitle?: string | undefined;
        readonly rootThreadId?: string | undefined;
        readonly rootTitle?: string | undefined;
        readonly onOpenRoot?: (() => void) | undefined;
      }
    | undefined;
  readonly items: readonly RenderItem[];
  readonly turns?: readonly TurnView[] | undefined;
  readonly pendingApprovals: readonly ApprovalViewModel[];
  readonly onDecide: (id: string, decision: ApprovalDecision) => void;
  readonly onAnswer?: (
    id: string,
    answer: { optionId?: string; text?: string; answers?: Readonly<Record<string, string>> },
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
   * 贴在对话区底部、随内容列 768 居中。
   */
  readonly composer?: React.ReactNode | undefined;
  readonly onNewTask?: (() => void) | undefined;
  readonly goal?: TaskGoalView | undefined;
  readonly goalPanelRequest?: number | undefined;
  readonly onContinue?: (() => void) | undefined;
  readonly continueDisabled?: boolean | undefined;
  readonly onGoalSave?:
    | ((input: {
        objective: string;
        tokenBudget?: number | null;
        status?: TaskGoalView['status'];
      }) => void)
    | undefined;
  readonly onGoalStatus?: ((status: TaskGoalView['status']) => void) | undefined;
  readonly onGoalClear?: (() => void) | undefined;
  readonly onFork?: ((ephemeral: boolean) => void) | undefined;
  readonly subtasks?: readonly {
    readonly id: string;
    readonly title: string | null;
    readonly status: TaskStatus;
    readonly timeLabel: string;
  }[];
  readonly onOpenSubtask?: ((threadId: string) => void) | undefined;
  readonly focusItemId?: string | undefined;
  readonly artifacts?: readonly {
    readonly id: string;
    readonly name: string;
    readonly path?: string | undefined;
    readonly artifactType: string;
    readonly version: number;
  }[];
  readonly onOpenArtifact?: ((id: string) => void) | undefined;
  /**
   * 正在拉历史。为 true 时不显示「还没有消息」—— 那是刚创建的空态（04 §8），
   * 已完成任务加载中画那句等于撒谎。
   */
  readonly historyLoading?: boolean | undefined;
  /**
   * 内核正在为这个回合重试上游请求。**在失败卡之前**显示，两者不会同时出现：
   * 重试成功就被下一条内容顶掉，重试用完才变成失败卡。
   */
  readonly turnRetry?:
    | { readonly attempt?: number | undefined; readonly maxAttempts?: number | undefined }
    | undefined;
  /** 回合失败要落在对应时间线位置，而不是只出现在全局提示条。 */
  readonly turnFailure?:
    | {
        /** 给人看的那一行 */
        readonly text: string;
        /** 内核给的原文。**一个字都不丢**，只是折起来（03 §8 / 2026-09-27） */
        readonly detail?: string | undefined;
        readonly onRetry?: (() => void) | undefined;
        readonly onOpenSettings?: (() => void) | undefined;
      }
    | undefined;
}

const TIMELINE_PAGE_SIZE = 120;
const BOTTOM_THRESHOLD = 64;

export function TaskWorkspace(props: TaskWorkspaceProps) {
  const view = STATUS_VIEW[props.status];
  /** undefined = 尚未表达偏好，跟随“有结果就默认显示”；boolean = 尊重用户选择。 */
  const [localResultOpen, setLocalResultOpen] = useState<boolean | undefined>(undefined);
  const [localResultTab, setLocalResultTab] = useState<ResultPane>('artifacts');
  const resultOpen =
    props.resultOpen ?? localResultOpen ?? Boolean(props.hasResults || props.resultPanel);
  const resultTab = props.resultTab ?? localResultTab;
  const [visibleCount, setVisibleCount] = useState(TIMELINE_PAGE_SIZE);
  const [hasNewContent, setHasNewContent] = useState(false);
  const [resultWidth, setResultWidth] = useState<number | undefined>(undefined);
  const [goalOpen, setGoalOpen] = useState(false);
  useEffect(() => {
    if (props.goalPanelRequest) setGoalOpen(true);
  }, [props.goalPanelRequest]);
  const [taskMenuOpen, setTaskMenuOpen] = useState(false);
  const taskMenuId = useId();
  const taskMenuRef = useRef<HTMLSpanElement | null>(null);
  const taskMenuTriggerRef = useRef<HTMLButtonElement | null>(null);
  const closeTaskMenu = useCallback(() => {
    setTaskMenuOpen(false);
    taskMenuTriggerRef.current?.focus();
  }, []);
  const taskMenuItems: MenuItemSpec[] = [
    ...(props.onGoalSave ? [{ id: 'goal', label: props.goal ? '目标与预算' : '设置目标' }] : []),
    ...(props.onFork
      ? [
          { id: 'fork', label: '分叉' },
          { id: 'side-chat', label: '旁聊' },
        ]
      : []),
  ];
  const [subtasksOpen, setSubtasksOpen] = useState(false);
  const [goalObjective, setGoalObjective] = useState(props.goal?.objective ?? '');
  const [goalBudget, setGoalBudget] = useState(
    props.goal?.tokenBudget == null ? '' : String(props.goal.tokenBudget),
  );
  const parsedGoalBudget = goalBudget === '' ? null : Number(goalBudget);
  const goalCanSave =
    goalObjective.trim() !== '' &&
    (parsedGoalBudget === null || (Number.isSafeInteger(parsedGoalBudget) && parsedGoalBudget > 0));
  const goalProgress =
    props.goal?.tokenBudget == null || props.goal.tokenBudget <= 0
      ? undefined
      : Math.min(100, (props.goal.tokensUsed / props.goal.tokenBudget) * 100);
  const goalExhausted = props.goal?.status === 'budgetLimited';
  const latestPlan = [...props.items]
    .reverse()
    .find((item) => item.type === 'plan' && Array.isArray(item.steps));
  const steps = (latestPlan?.steps ?? []) as readonly { step?: string; status?: string }[];
  const completedSteps = steps.filter((step) => step.status === 'completed').length;
  const currentStep = steps.find(
    (step) => step.status === 'inProgress' || step.status === 'in_progress',
  );
  const conversationRef = useRef<HTMLDivElement | null>(null);
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
    if (taskMenuOpen)
      taskMenuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
  }, [taskMenuOpen]);

  useEffect(() => {
    setVisibleCount(TIMELINE_PAGE_SIZE);
    followOutputRef.current = true;
    setHasNewContent(false);
    setLocalResultOpen(undefined);
    setSubtasksOpen(false);
    setTaskMenuOpen(false);
  }, [props.taskId]);

  useEffect(() => {
    setGoalObjective(props.goal?.objective ?? '');
    setGoalBudget(props.goal?.tokenBudget == null ? '' : String(props.goal.tokenBudget));
  }, [props.goal]);

  useEffect(() => {
    for (const node of document.querySelectorAll<HTMLElement>('[data-search-focus]')) {
      node.removeAttribute('data-search-focus');
    }
    if (!props.focusItemId) return;
    const index = props.items.findIndex((item) => item.id === props.focusItemId);
    if (index >= 0) setVisibleCount(Math.max(TIMELINE_PAGE_SIZE, props.items.length - index));
    window.setTimeout(() => {
      const target = [...document.querySelectorAll<HTMLElement>('[data-task-item-id]')].find(
        (node) => node.dataset.taskItemId === props.focusItemId,
      );
      target?.scrollIntoView({ block: 'center' });
      target?.setAttribute('data-search-focus', 'true');
    }, 0);
  }, [props.focusItemId, props.items]);

  const failureSummary = props.turnFailure?.text;
  useEffect(() => {
    const node = conversationRef.current;
    if (!node) return;
    if (followOutputRef.current) {
      node.scrollTop = node.scrollHeight;
      setHasNewContent(false);
    } else {
      setHasNewContent(true);
    }
  }, [props.items, props.pendingApprovals.length, failureSummary]);

  const approvalsById = useMemo(
    () => new Map(props.pendingApprovals.map((a) => [a.id, a])),
    [props.pendingApprovals],
  );
  const mountedItems = useMemo(() => {
    let start = Math.max(0, props.items.length - visibleCount);
    // 分页不能从相邻操作组中间切开，否则追加新事件会改变组 key、丢失展开选择。
    while (start > 0) {
      const current = props.items[start];
      const previous = props.items[start - 1];
      if (
        !current ||
        !previous ||
        !isProcessItem(current) ||
        !isProcessItem(previous) ||
        current._turnId !== previous._turnId
      )
        break;
      start -= 1;
    }
    return props.items.slice(start);
  }, [props.items, visibleCount]);
  const hiddenItemCount = props.items.length - mountedItems.length;
  const timeline = useMemo(() => {
    const entries = groupTimelineItems(mountedItems);
    const seen = new Set<string>();
    return entries.map((entry) => {
      const first = entry.kind === 'item' ? entry.item : entry.items[0];
      const turnId = typeof first?._turnId === 'string' ? first._turnId : undefined;
      const turn =
        turnId && first?.type !== 'userMessage' && !seen.has(turnId)
          ? props.turns?.find((candidate) => candidate.id === turnId)
          : undefined;
      const afterTurn =
        turnId &&
        first?.type === 'userMessage' &&
        !mountedItems.some((item) => item._turnId === turnId && item.type !== 'userMessage') &&
        mountedItems.findLast((item) => item._turnId === turnId)?.id === first.id
          ? props.turns?.find((candidate) => candidate.id === turnId)
          : undefined;
      if (turn) seen.add(turn.id);
      return { entry, turn, afterTurn };
    });
  }, [mountedItems, props.turns]);
  const sourceContexts = useMemo(() => webSourcesByItem(props.items), [props.items]);

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
          {(props.subtasks ?? []).length > 0 ? (
            <button
              type="button"
              className="ew-pill-button"
              onClick={() => setSubtasksOpen((value) => !value)}
            >
              子任务 {props.subtasks?.length}
            </button>
          ) : null}
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
          {taskMenuItems.length > 0 ? (
            <span
              ref={taskMenuRef}
              className="ew-task-menu-anchor"
              onKeyDown={(event) => {
                if (event.key === 'Escape' && taskMenuOpen) {
                  event.preventDefault();
                  event.stopPropagation();
                  closeTaskMenu();
                  return;
                }
                if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
                event.preventDefault();
                if (!taskMenuOpen) {
                  setTaskMenuOpen(true);
                  return;
                }
                const items = [
                  ...(taskMenuRef.current?.querySelectorAll<HTMLButtonElement>(
                    '[role="menuitem"]',
                  ) ?? []),
                ];
                const current = items.indexOf(document.activeElement as HTMLButtonElement);
                const next =
                  event.key === 'Home'
                    ? 0
                    : event.key === 'End'
                      ? items.length - 1
                      : (current + (event.key === 'ArrowUp' ? -1 : 1) + items.length) %
                        items.length;
                items[next]?.focus();
              }}
            >
              <button
                ref={taskMenuTriggerRef}
                type="button"
                className="ew-icon-button"
                aria-label="任务更多操作"
                title="更多操作"
                aria-haspopup="menu"
                aria-expanded={taskMenuOpen}
                aria-controls={taskMenuOpen ? taskMenuId : undefined}
                data-selected={taskMenuOpen ? 'true' : undefined}
                onClick={() => setTaskMenuOpen((open) => !open)}
              >
                <span aria-hidden="true">⋯</span>
              </button>
              <Popover open={taskMenuOpen} onClose={closeTaskMenu} align="end">
                <Menu
                  id={taskMenuId}
                  ariaLabel="任务操作"
                  items={taskMenuItems}
                  onSelect={(id) => {
                    closeTaskMenu();
                    if (id === 'goal') setGoalOpen((open) => !open);
                    if (id === 'fork') props.onFork?.(false);
                    if (id === 'side-chat') props.onFork?.(true);
                  }}
                />
              </Popover>
            </span>
          ) : null}
        </div>
      </header>

      {props.goal ||
      ((props.status === 'running' || props.status === 'pending') && steps.length > 0) ? (
        <section
          className="ew-goal-progress"
          data-tone={goalProgress !== undefined && goalProgress >= 80 ? 'warning' : 'accent'}
          aria-label={props.goal ? '持续目标' : '任务执行进度'}
        >
          <div className="ew-goal-progress-copy">
            <span>{props.goal?.objective ?? '任务计划'}</span>
            <span>
              {props.goal
                ? props.goal.status === 'active' &&
                  (props.status === 'failed' || props.status === 'interrupted')
                  ? '等待继续'
                  : GOAL_STATUS_LABELS[props.goal.status]
                : view.label}
            </span>
          </div>
          {steps.length > 0 ? (
            <div className="ew-goal-progress-copy" role="status">
              <span>
                已完成 {completedSteps}/{steps.length} 步
                {currentStep?.step ? ` · 当前：${currentStep.step}` : ''}
              </span>
            </div>
          ) : null}
          {props.goal ? (
            <span>
              {props.goal.tokensUsed.toLocaleString()}
              {props.goal.tokenBudget != null
                ? ` / ${props.goal.tokenBudget.toLocaleString()}`
                : ''}
              {' tokens'} · {props.goal.timeUsedSeconds}s
            </span>
          ) : null}
          {goalProgress !== undefined ? (
            <progress max={100} value={goalProgress} aria-label="Token 预算使用比例" />
          ) : null}
          {goalExhausted ? (
            <div className="ew-goal-exhausted" role="alert">
              <span>预算已耗尽，任务已暂停。</span>
              <PillButton
                variant="accent"
                onClick={() => {
                  if (!props.goal?.tokenBudget) return;
                  const increment = Math.max(1_000, Math.ceil(props.goal.tokenBudget * 0.25));
                  props.onGoalSave?.({
                    objective: props.goal.objective,
                    tokenBudget: Math.max(
                      props.goal.tokenBudget + increment,
                      props.goal.tokensUsed + 1_000,
                    ),
                    status: 'active',
                  });
                }}
              >
                追加预算
              </PillButton>
              <PillButton onClick={() => props.onGoalStatus?.('complete')}>结束任务</PillButton>
            </div>
          ) : null}
        </section>
      ) : null}

      {goalOpen ? (
        <section className="ew-task-goal" aria-label="长任务目标">
          <input
            aria-label="任务目标"
            value={goalObjective}
            placeholder="这个长任务最终要完成什么？"
            onChange={(event) => setGoalObjective(event.target.value)}
          />
          <input
            aria-label="Token 预算"
            type="number"
            min={1}
            value={goalBudget}
            placeholder="Token 预算（可选）"
            onChange={(event) => setGoalBudget(event.target.value)}
          />
          <PillButton
            variant="accent"
            disabled={!goalCanSave}
            onClick={() =>
              props.onGoalSave?.({
                objective: goalObjective.trim(),
                tokenBudget: parsedGoalBudget,
              })
            }
          >
            保存
          </PillButton>
          {props.goal ? (
            <>
              <span>
                {props.goal.tokensUsed.toLocaleString()} tokens · {props.goal.timeUsedSeconds}s ·{' '}
                {GOAL_STATUS_LABELS[props.goal.status]}
              </span>
              <PillButton
                disabled={props.goal.status === 'complete' || props.goal.status === 'budgetLimited'}
                onClick={() =>
                  props.onGoalStatus?.(props.goal?.status === 'active' ? 'paused' : 'active')
                }
              >
                {props.goal.status === 'active' ? '暂停' : '继续'}
              </PillButton>
              <PillButton onClick={props.onGoalClear}>清除目标</PillButton>
            </>
          ) : null}
        </section>
      ) : null}

      {subtasksOpen ? (
        <aside className="ew-subtask-drawer" aria-label="子任务详情">
          <header>
            <div>
              <strong>子任务</strong>
              <span>{props.subtasks?.length ?? 0} 个</span>
            </div>
            <button
              type="button"
              className="ew-pill-button"
              aria-label="关闭子任务详情"
              onClick={() => setSubtasksOpen(false)}
            >
              关闭
            </button>
          </header>
          <ul>
            {(props.subtasks ?? []).map((subtask) => {
              const subtaskStatus = STATUS_VIEW[subtask.status];
              return (
                <li key={subtask.id}>
                  <button type="button" onClick={() => props.onOpenSubtask?.(subtask.id)}>
                    <span>
                      <StatusDot tone={subtaskStatus.tone} breathing={subtaskStatus.breathing} />
                      <strong>{subtask.title ?? '未命名子任务'}</strong>
                    </span>
                    <small>
                      {subtaskStatus.label} · {subtask.timeLabel}
                    </small>
                  </button>
                </li>
              );
            })}
          </ul>
        </aside>
      ) : null}

      <div className="ew-workspace-body">
        <main className="ew-conversation" aria-label="对话区">
          <div
            ref={conversationRef}
            className="ew-conversation-scroll"
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

            {props.subagentContext ? (
              <Banner
                tone="info"
                action={
                  props.subagentContext.onOpenRoot ? (
                    <PillButton onClick={props.subagentContext.onOpenRoot}>返回根任务</PillButton>
                  ) : undefined
                }
              >
                这是子代理的只读时间线。下方追加的要求会先发送到
                {props.subagentContext.rootTitle
                  ? `根任务「${props.subagentContext.rootTitle}」`
                  : '根任务'}
                ，再由它通过协作通道转给当前子代理；上下文不会自动持续共享。
              </Banner>
            ) : null}

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

            {/* 内容列 768 居中（01 §3.1） */}
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

              {timeline.map(({ entry, turn, afterTurn }) => (
                <div key={entry.kind === 'item' ? entry.item.id : entry.key}>
                  {turn ? <TurnHeader turn={turn} /> : null}
                  {entry.kind === 'item' ? (
                    <div data-task-item-id={entry.item.id}>
                      <ItemRenderer
                        item={entry.item}
                        context={{
                          ...props.itemContext,
                          webSources: sourceContexts.get(entry.item.id),
                        }}
                      />
                    </div>
                  ) : (
                    <ProcessGroup
                      items={entry.items}
                      context={props.itemContext}
                      sourceContexts={sourceContexts}
                      focusItemId={props.focusItemId}
                    />
                  )}
                  {afterTurn ? <TurnHeader turn={afterTurn} /> : null}
                </div>
              ))}
              {(props.turns ?? [])
                .filter(
                  (turn) =>
                    turn.status === 'inProgress' &&
                    !mountedItems.some((item) => item._turnId === turn.id),
                )
                .map((turn) => (
                  <TurnHeader key={turn.id} turn={turn} />
                ))}

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

              {(props.status === 'interrupted' || props.status === 'failed') && props.onContinue ? (
                <section className="ew-turn-failure" aria-label="任务恢复">
                  <p>已有历史和产物保留在本机。继续时会先检查进度，再完成剩余步骤。</p>
                  <PillButton
                    variant="accent"
                    disabled={props.continueDisabled}
                    onClick={props.onContinue}
                  >
                    继续任务
                  </PillButton>
                </section>
              ) : null}

              {props.turnRetry ? (
                /*
                 * 用和「已停止，可在下方继续」同一种分隔行，而不是新做一个组件：
                 * 它要表达的东西是一样的 —— 一行会被下一个动静顶掉的状态。
                 * `role="status"` 而不是 `alert`：这不是错误，读屏也不该打断当前朗读。
                 */
                <div className="ew-item ew-item-divider" role="status">
                  <span>
                    上游断了，正在尝试重新连接
                    {props.turnRetry.attempt !== undefined &&
                    props.turnRetry.maxAttempts !== undefined
                      ? `（${props.turnRetry.attempt}/${props.turnRetry.maxAttempts}）`
                      : ''}
                  </span>
                </div>
              ) : null}

              {props.turnFailure ? (
                <section className="ew-turn-failure" role="alert" aria-label="回合失败">
                  <strong>这一回合失败了</strong>
                  <p>{props.turnFailure.text}</p>
                  {/*
                   * 原文折在这里。**默认收起**：它是英文技术信息，摊开会把上面那句
                   * 人话和两个动作按钮挤下去 —— 而用户第一眼要的是"我现在能做什么"。
                   */}
                  {props.turnFailure.detail ? (
                    <details className="ew-turn-failure-detail">
                      <summary>详情</summary>
                      <pre>{props.turnFailure.detail}</pre>
                    </details>
                  ) : null}
                  <div className="ew-turn-failure-actions">
                    {props.turnFailure.onRetry ? (
                      <PillButton
                        variant="accent"
                        disabled={props.continueDisabled}
                        onClick={props.turnFailure.onRetry}
                      >
                        重试
                      </PillButton>
                    ) : null}
                    {props.turnFailure.onOpenSettings ? (
                      <PillButton onClick={props.turnFailure.onOpenSettings}>
                        打开模型设置
                      </PillButton>
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
          </div>

          {props.composer ? (
            <div className="ew-conversation-composer">
              <div className="ew-content-column">{props.composer}</div>
            </div>
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
