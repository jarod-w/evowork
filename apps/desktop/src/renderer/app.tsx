/**
 * 渲染进程的外壳：把首页、任务工作台、侧边栏接到主进程推来的事件上。
 *
 * ## 这一层只认 IPC 频道，不认协议方法名
 *
 * K2 的边界在服务层（`services/kernel-adapter`），但**破它最容易的方式是在前端**：
 * 只要这里出现一个 `thread/start`，边界就没了。所以渲染进程能看到的东西全在
 * `window.evowork` 这个由 preload 暴露的窄接口里，语义化命名，与协议无关。
 *
 * ## 路由：只有两个页面
 *
 * 首页与任务页。03 §1 说清了首页不创建 Thread —— 发送第一条消息时主进程才建，
 * 建好回一个 id，这里再切过去。所以"当前在哪个页面"就是 `activeTaskId` 是不是 null，
 * 不需要 router。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';

import type { ApprovalViewModel, ApprovalDecision } from './components/approval-card.js';
import { Composer } from './components/composer.js';
import { createMermaidRenderer } from './components/mermaid-renderer.js';
import type { RenderItem } from './components/item-renderers.js';
import { Home, type Scenario } from './views/home.js';
import { Sidebar, type RowAction, type TaskRow } from './views/sidebar.js';
import { TaskWorkspace, type TaskStatus } from './views/task-workspace.js';

/** preload 暴露的窄接口。**这就是渲染进程能做的全部事情**。 */
export interface EvoworkBridge {
  onUiEvent(handler: (event: UiEventFromMain) => void): () => void;
  onNotice(handler: (notice: { kind: string; text: string }) => void): () => void;
  onPendingApprovals(handler: (approvals: readonly ApprovalViewModel[]) => void): () => void;
  onDegrade(handler: (report: { degradation?: { userVisible: string } }) => void): () => void;
  /** 发送一条需求。没有 threadId 时由主进程新建任务并回 id（03 §1） */
  send(input: { threadId?: string | undefined; text: string }): Promise<{ threadId: string }>;
  interrupt(threadId: string): Promise<void>;
  decideApproval(id: string, decision: ApprovalDecision): Promise<void>;
  rowAction(action: RowAction, threadId: string): Promise<void>;
  /** 04 §3.4 第②步：对可见页做有界的权威字段校正 */
  refreshVisible(ids: readonly string[]): Promise<void>;
  listScenarios(): Promise<readonly Scenario[]>;
}

export type UiEventFromMain =
  | { type: 'task-created'; task: TaskRow }
  | { type: 'task-updated'; taskId: string; status?: TaskStatus; title?: string | null }
  | { type: 'item'; taskId: string; item: RenderItem };

declare global {
  interface Window {
    readonly evowork?: EvoworkBridge;
  }
}

/** 模块级单例：mermaid 的初始化只该做一次，而它自己也缓存了动态 import。 */
const MERMAID = createMermaidRenderer();

export function App({ bridge }: { readonly bridge: EvoworkBridge }) {
  const [tasks, setTasks] = useState<readonly TaskRow[]>([]);
  const [itemsByTask, setItemsByTask] = useState<Readonly<Record<string, readonly RenderItem[]>>>(
    {},
  );
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null);
  const [approvals, setApprovals] = useState<readonly ApprovalViewModel[]>([]);
  const [notices, setNotices] = useState<
    readonly { tone: 'info' | 'warning' | 'danger'; text: string }[]
  >([]);
  const [scenarios, setScenarios] = useState<readonly Scenario[]>([]);
  const [scenarioId, setScenarioId] = useState('office');
  const [draft, setDraft] = useState('');
  const [running, setRunning] = useState(false);

  useEffect(() => {
    const offs = [
      bridge.onUiEvent((event) => {
        if (event.type === 'task-created') {
          setTasks((prev) => [event.task, ...prev]);
          return;
        }
        if (event.type === 'task-updated') {
          setTasks((prev) =>
            prev.map((t) =>
              t.id === event.taskId
                ? {
                    ...t,
                    ...(event.status ? { status: event.status } : {}),
                    ...(event.title !== undefined ? { title: event.title } : {}),
                  }
                : t,
            ),
          );
          if (event.status) setRunning(event.status === 'running');
          return;
        }
        setItemsByTask((prev) => ({
          ...prev,
          // 流式增量按 id 合并（04 §5.1）：同 id 的后来者覆盖前者
          [event.taskId]: mergeItem(prev[event.taskId] ?? [], event.item),
        }));
      }),
      bridge.onPendingApprovals(setApprovals),
      bridge.onNotice((notice) =>
        setNotices((prev) => [...prev, { tone: 'warning', text: notice.text }]),
      ),
      // 09 §3.3：降级显式告诉用户，不假装正常
      bridge.onDegrade((report) => {
        const text = report.degradation?.userVisible;
        if (text) setNotices((prev) => [...prev, { tone: 'info', text }]);
      }),
    ];
    return () => offs.forEach((off) => off());
  }, [bridge]);

  useEffect(() => {
    void bridge.listScenarios().then(setScenarios);
  }, [bridge]);

  const send = useCallback(async () => {
    const text = draft.trim();
    if (!text) return;
    setDraft('');
    const { threadId } = await bridge.send({
      ...(activeTaskId ? { threadId: activeTaskId } : {}),
      text,
    });
    setActiveTaskId(threadId);
  }, [bridge, draft, activeTaskId]);

  const active = tasks.find((t) => t.id === activeTaskId);
  const composer = useMemo(
    () => ({
      onSend: () => void send(),
      runState: (running ? 'running' : 'idle') as 'running' | 'idle',
      onInterrupt: () => {
        if (activeTaskId) void bridge.interrupt(activeTaskId);
      },
    }),
    [send, running, activeTaskId, bridge],
  );

  return (
    <div className="ew-app">
      <Sidebar
        tasks={tasks}
        sections={[]}
        selectedId={activeTaskId ?? undefined}
        onSelect={setActiveTaskId}
        onNewTask={() => setActiveTaskId(null)}
        onRowAction={(action, id) => void bridge.rowAction(action, id)}
        onVisibleChange={(ids) => void bridge.refreshVisible(ids)}
      />

      {activeTaskId === null ? (
        <Home
          heroLine="EvoWork，我帮你"
          scenarios={scenarios}
          scenarioId={scenarioId}
          onScenarioChange={setScenarioId}
          composer={composer}
          value={draft}
          onChange={setDraft}
        />
      ) : (
        <TaskWorkspace
          title={active?.title ?? null}
          status={active?.status ?? 'idle'}
          items={itemsByTask[activeTaskId] ?? []}
          pendingApprovals={approvals}
          onDecide={(id, decision) => void bridge.decideApproval(id, decision)}
          itemContext={{
            reasoningAvailable: true,
            // Visualizer 的真实 mermaid 渲染器。动态 import，第一次真要画图时才加载
            mermaid: MERMAID,
          }}
          notices={notices}
          onNewTask={() => setActiveTaskId(null)}
          composer={<Composer {...composer} value={draft} onChange={setDraft} />}
        />
      )}
    </div>
  );
}

/** 流式增量按 id 合并（04 §5.1）。导出是为了单独测"同 id 覆盖、新 id 追加"。 */
export function mergeItem(
  items: readonly RenderItem[],
  incoming: RenderItem,
): readonly RenderItem[] {
  const index = items.findIndex((i) => i.id === incoming.id);
  if (index < 0) return [...items, incoming];
  const next = [...items];
  next[index] = incoming;
  return next;
}
