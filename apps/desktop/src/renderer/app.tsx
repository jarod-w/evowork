/**
 * 渲染进程的外壳：把首页、任务工作台、侧边栏接到主进程推来的事件上。
 *
 * ## 这一层只认 IPC 频道，不认协议方法名
 *
 * K2 的边界在服务层（`services/kernel-adapter`），但**破它最容易的方式是在前端**：
 * 只要这里出现一个 `thread/start`，边界就没了。所以渲染进程能看到的东西全在
 * `window.evowork` 这个由 preload 暴露的窄接口里，语义化命名，与协议无关。
 * 载荷的形状在 `shared/ipc.ts`，**主进程与这里共用同一份类型** ——
 * 它们此前各写一份，于是各自都能编译、合起来是断的。
 *
 * ## 路由：只有两个页面
 *
 * 首页与任务页。03 §1 说清了首页不创建 Thread —— 发送第一条消息时主进程才建，
 * 建好回一个 id，这里再切过去。所以"当前在哪个页面"就是 `activeTaskId` 是不是 null，
 * 不需要 router。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';

import type {
  ApprovalView,
  RendererEvent,
  SendInput,
  StartupInfo,
  TaskRowView,
} from '../shared/ipc.js';
import type { ApprovalDecision } from './components/approval-card.js';
import { Composer, type ModeId, type SelectOption } from './components/composer.js';
import { createMermaidRenderer } from './components/mermaid-renderer.js';
import type { RenderItem } from './components/item-renderers.js';
import { Home, type Scenario } from './views/home.js';
import { Sidebar, type RowAction } from './views/sidebar.js';
import { TaskWorkspace } from './views/task-workspace.js';

/** preload 暴露的窄接口。**这就是渲染进程能做的全部事情**。 */
export interface EvoworkBridge {
  onUiEvent(handler: (event: RendererEvent) => void): () => void;
  onNotice(handler: (notice: { kind: string; text: string }) => void): () => void;
  onPendingApprovals(handler: (approvals: readonly ApprovalView[]) => void): () => void;
  onDegrade(handler: (report: { degradation?: { userVisible: string } }) => void): () => void;
  /** 发送一条需求。没有 threadId 时由主进程新建任务并回 id（03 §1） */
  send(input: SendInput): Promise<{ threadId: string }>;
  interrupt(threadId: string): Promise<void>;
  decideApproval(input: { id: string; decision: ApprovalDecision }): Promise<void>;
  rowAction(input: { action: RowAction; threadId: string }): Promise<void>;
  /** 04 §3.4 第②步：对可见页做有界的权威字段校正 */
  refreshVisible(ids: readonly string[]): Promise<void>;
  /** 首页要渲染的一切，一次给全（场景 · 权限档位 · 案例池 · 已有任务） */
  getStartup(): Promise<StartupInfo>;
}

declare global {
  interface Window {
    readonly evowork?: EvoworkBridge;
  }
}

/** 模块级单例：mermaid 的初始化只该做一次，而它自己也缓存了动态 import。 */
const MERMAID = createMermaidRenderer();

/** 权限档位的中文名（10 §2）。未登记的 profile **显示 id 本身，不隐藏**。 */
const PERMISSION_LABEL: Readonly<Record<string, string>> = {
  'evowork-workspace': '工作空间内可写',
  ':read-only': '只读',
  ':danger-full-access': '完全访问',
};

export function App({ bridge }: { readonly bridge: EvoworkBridge }) {
  const [tasks, setTasks] = useState<readonly TaskRowView[]>([]);
  const [itemsByTask, setItemsByTask] = useState<Readonly<Record<string, readonly RenderItem[]>>>(
    {},
  );
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null);
  const [approvals, setApprovals] = useState<readonly ApprovalView[]>([]);
  const [notices, setNotices] = useState<
    readonly { tone: 'info' | 'warning' | 'danger'; text: string }[]
  >([]);
  const [startup, setStartup] = useState<StartupInfo | null>(null);
  const [scenarioId, setScenarioId] = useState('office');
  const [permissionId, setPermissionId] = useState<string | undefined>(undefined);
  const [mode, setMode] = useState<ModeId>('craft');
  const [draft, setDraft] = useState('');
  const [running, setRunning] = useState(false);
  const [failure, setFailure] = useState<string | undefined>(undefined);

  useEffect(() => {
    const offs = [
      bridge.onUiEvent((event) => {
        if (event.type === 'task-created') {
          setTasks((prev) => [event.task, ...prev.filter((t) => t.id !== event.task.id)]);
          return;
        }
        if (event.type === 'turn-failed') {
          /*
           * 03 §8：模型不可用**不静默降级**。这里把内核给的原因原样显示 ——
           * 不改写、不归类：`connection refused` 与 `401` 对用户是完全不同的两件事，
           * 归成一句"模型调用失败"就等于把唯一的线索删掉了。
           */
          setNotices((prev) => [
            ...prev,
            {
              tone: 'danger',
              text: event.details
                ? `这一回合失败了：${event.message}（${event.details}）`
                : `这一回合失败了：${event.message}`,
            },
          ]);
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
          [event.taskId]: mergeItem(prev[event.taskId] ?? [], event.item as RenderItem),
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
    void bridge
      .getStartup()
      .then((info) => {
        setStartup(info);
        setTasks(info.tasks);
        const preferred = info.scenarios.find((s) => s.id === 'office') ?? info.scenarios[0];
        if (preferred) {
          setScenarioId(preferred.id);
          setPermissionId(preferred.defaults.permissionId);
          if (preferred.defaults.mode) setMode(preferred.defaults.mode);
        }
      })
      .catch((err: unknown) => {
        /*
         * 03 §8：起不来就**说出来**，不留一个看起来正常的空界面。
         * 这条正是上一版缺的：`listScenarios` 没有 handler，rejection 被 `void` 吞掉，
         * 于是首页画出一个没有场景、没有 chips 的壳子，看着像"功能还没做"。
         */
        setFailure(err instanceof Error ? err.message : String(err));
      });
  }, [bridge]);

  const send = useCallback(async () => {
    const text = draft.trim();
    if (!text) return;
    setDraft('');
    try {
      const { threadId } = await bridge.send({
        ...(activeTaskId ? { threadId: activeTaskId } : {}),
        text,
        scenarioId,
      });
      setActiveTaskId(threadId);
    } catch (err: unknown) {
      // 发送失败要把草稿还回去 —— 清空输入框又什么都没发生，用户会以为消息丢了
      setDraft(text);
      setNotices((prev) => [
        ...prev,
        { tone: 'danger', text: `没能发出去：${err instanceof Error ? err.message : String(err)}` },
      ]);
    }
  }, [bridge, draft, activeTaskId, scenarioId]);

  const scenarios: readonly Scenario[] = useMemo(
    () =>
      (startup?.scenarios ?? []).map((s) => ({
        id: s.id,
        name: s.name,
        icon: s.icon,
        chips: s.chips,
        defaults: s.defaults,
      })),
    [startup],
  );

  // F4 / 10 §2：`allowed:false` 的档位**保留并给原因**，不隐藏
  const permissions: readonly SelectOption[] = useMemo(
    () =>
      (startup?.permissions ?? []).map((p) => ({
        id: p.id,
        label: PERMISSION_LABEL[p.id] ?? p.id,
        description: p.description,
        allowed: p.allowed,
        disabledReason: p.allowed ? undefined : '已被企业策略锁定',
      })),
    [startup],
  );

  const active = tasks.find((t) => t.id === activeTaskId);
  const composer = useMemo(
    () => ({
      onSend: () => void send(),
      runState: (running ? 'running' : 'idle') as 'running' | 'idle',
      onInterrupt: () => {
        if (activeTaskId) void bridge.interrupt(activeTaskId);
      },
      permissions,
      permissionId,
      onPermissionChange: setPermissionId,
      mode,
      onModeChange: setMode,
    }),
    [send, running, activeTaskId, bridge, permissions, permissionId, mode],
  );

  return (
    <div className="ew-app">
      <Sidebar
        tasks={tasks}
        sections={[]}
        selectedId={activeTaskId ?? undefined}
        onSelect={setActiveTaskId}
        onNewTask={() => setActiveTaskId(null)}
        onRowAction={(action, id) => void bridge.rowAction({ action, threadId: id })}
        onVisibleChange={(ids) => void bridge.refreshVisible(ids)}
        brandName={startup?.appName}
        {...(startup
          ? { user: { name: startup.userName, version: `v${startup.appVersion}` } }
          : {})}
      />

      {activeTaskId === null ? (
        <Home
          heroLine={`${startup?.appName ?? 'EvoWork'}，我帮你`}
          scenarios={scenarios}
          scenarioId={scenarioId}
          onScenarioChange={setScenarioId}
          cases={startup?.cases}
          notices={notices}
          composer={composer}
          value={draft}
          onChange={setDraft}
          {...(failure !== undefined
            ? { configNotice: `没有连上本机服务：${failure}。重启 EvoWork 再试。` }
            : {})}
        />
      ) : (
        <TaskWorkspace
          title={active?.title ?? null}
          status={active?.status ?? 'idle'}
          items={itemsByTask[activeTaskId] ?? []}
          pendingApprovals={approvals}
          onDecide={(id, decision) => void bridge.decideApproval({ id, decision })}
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
