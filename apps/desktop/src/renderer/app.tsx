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
  AgentsMemoView,
  ApprovalView,
  ApplyModelAccessInput,
  AuditDataView,
  AutomationsDataView,
  DirEntryView,
  LibraryDataView,
  ModelCatalogResult,
  ModelOptionView,
  ModelUnavailableReason,
  OpenTaskResult,
  ProjectDetailView,
  ProjectMutationResult,
  ProjectsDataView,
  RendererEvent,
  RuntimeInstallResultView,
  RuntimeProgressView,
  RuntimeStatusView,
  SendInput,
  SettingsMutationResult,
  SettingsSectionId,
  SettingsView,
  StartupInfo,
  TaskRowView,
  WriteAgentsMemoResult,
} from '../shared/ipc.js';
import type { ApprovalDecision } from './components/approval-card.js';
import { Composer, type ModeId, type SelectOption } from './components/composer.js';
import { Banner, Dialog, EmptyState } from './components/primitives.js';
import { createMermaidRenderer } from './components/mermaid-renderer.js';
import type { RenderItem } from './components/item-renderers.js';
import { resolveModelChoice } from './model-selection.js';
import { AuditPage, type AuditRow } from './views/audit.js';
import type { LibraryRow } from '@evowork/artifacts/library.js';
import { AutomationsPage } from './views/automations.js';
import { Home, type Scenario } from './views/home.js';
import { Library } from './views/library.js';
import {
  Onboarding,
  ONBOARDING_STEPS,
  EMPTY_PROVIDER_KEYS,
  type OnboardingStep,
  type ProviderKeyId,
  type ProviderKeys,
} from './views/onboarding.js';
import { ProjectDetailPage } from './views/project-detail.js';
import { ProjectsPage } from './views/projects.js';
import { Sidebar, type RowAction } from './views/sidebar.js';
import { Settings, SECRET_STORE_UNAVAILABLE } from './views/settings.js';
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
  /** 打开已有任务并拉历史。点侧边栏一行就必须调，否则已完成任务是空对话 */
  openTask(input: { threadId: string }): Promise<OpenTaskResult>;
  /** 首页要渲染的一切，一次给全（场景 · 权限档位 · 案例池 · 已有任务） */
  getStartup(): Promise<StartupInfo>;
  /**
   * 模型下拉的数据（03 §4.5「启动时 + 手动刷新」）。
   *
   * 与 `getStartup` 分开：它是一次网络调用（到网关），失败时界面仍然可用 ——
   * 只是发不出新任务。合并会让网关的一次超时把整个首页拖成白屏。
   */
  listModels(): Promise<ModelCatalogResult>;
  applyModelAccess(input: ApplyModelAccessInput): Promise<ModelCatalogResult>;
  getSettings(): Promise<SettingsView>;
  saveModelKey(input: { slot: string; value: string }): Promise<SettingsMutationResult>;
  clearModelKey(input: { slot: string }): Promise<SettingsMutationResult>;
  addCustomModel(input: {
    id: string;
    displayName?: string;
    upstreamModel: string;
    adapter: string;
    baseUrl: string;
    apiKey?: string;
  }): Promise<SettingsMutationResult>;
  removeCustomModel(input: { id: string }): Promise<SettingsMutationResult>;
  chooseSecretFallback(input: { fallback: 'plaintext' | 'ephemeral' }): Promise<SettingsView>;
  /*
   * 三个目录式页面各自一个动作。**按需拉，不并进 getStartup** ——
   * 它们读的是本机 sqlite，且绝大多数会话里用户根本不会打开资料库。
   */
  getLibrary(): Promise<LibraryDataView>;
  getAutomations(): Promise<AutomationsDataView>;
  getAudit(): Promise<AuditDataView>;
  /*
   * 「项目」页（02 §4.3）。与三个目录式页面同一条理由：**按需拉，不并进 getStartup** ——
   * 它读的是本机 sqlite 与磁盘，而绝大多数会话里用户不会打开这一页。
   */
  listProjects(): Promise<ProjectsDataView>;
  createProject(input: { name: string; path: string }): Promise<ProjectMutationResult>;
  importProject(): Promise<ProjectMutationResult>;
  renameProject(input: { id: string; name: string }): Promise<ProjectMutationResult>;
  removeProject(input: { id: string }): Promise<ProjectMutationResult>;
  openProjectFolder(input: { id: string }): Promise<void>;
  readProjectDetail(input: { id: string }): Promise<ProjectDetailView | null>;
  /** 文件树懒加载：展开哪层读哪层（D-P5） */
  listProjectDir(input: {
    id: string;
    path?: string | undefined;
  }): Promise<readonly DirEntryView[]>;
  readAgentsMemo(input: { id: string }): Promise<AgentsMemoView>;
  writeAgentsMemo(input: { id: string; content: string }): Promise<WriteAgentsMemoResult>;
  /**
   * 打开系统目录选择框（首运行第②步）。**选完会立刻建成一个空间**——只有首运行
   * 该调它，别处（比如「新建空间」对话框）要用下面纯选目录的 `pickProjectDirectory`，
   * 否则选目录 + 按创建会建出两个一模一样的空间（C1）。
   *
   * `{}`（两个字段都没有）= 用户取消，或这个构建没有选择器——**如实无话可说**。
   * `refused` 有值 = 选中的目录被路径闸门拦下了，`path` 不会跟着出现；
   * 这条要害得和取消分得开：都读成"没选成"会把"选了但被拒"悄悄吞掉。
   */
  pickWorkspace(): Promise<{ path?: string; refused?: string }>;
  /**
   * 纯选目录（C1）：只弹选择框、把路径或拒绝理由带回来，**没有任何副作用**——
   * 不建空间、不落库。「新建空间」对话框的「选择目录」按钮走这个，
   * 真正的建空间动作留给用户按下「创建」时的 `createProject`。
   */
  pickProjectDirectory(): Promise<{ path?: string; refused?: string }>;
  completeOnboarding(): Promise<void>;
  /** 办公扩展装了没有（08 §4）。**每次问都真探**，别在渲染层缓存 */
  getRuntimeStatus(): Promise<RuntimeStatusView>;
  /** 装办公扩展。要几分钟，进度走 `onRuntimeProgress` */
  installOfficeRuntime(): Promise<RuntimeInstallResultView>;
  onRuntimeProgress(handler: (progress: RuntimeProgressView) => void): () => void;
}

/**
 * 主内容区显示什么。
 *
 * **不引 router**：只有两种形态——任务（首页 / 工作台，由 `activeTaskId` 区分）
 * 与一个目录式页面。侧边栏的 6 个入口就是全部的导航面（02 §1），
 * 它是产品骨架而不是可扩展的路由表。
 */
type MainView = 'task' | 'library' | 'automations' | 'audit' | 'projects' | 'catalog' | 'settings';

/** 侧边栏 id → 主内容区。**没有页面的入口也必须在这里出现**，见 `UnbuiltPage`。 */
const NAV_TO_VIEW: Readonly<Record<string, MainView>> = {
  'new-task': 'task',
  projects: 'projects',
  catalog: 'catalog',
  automations: 'automations',
  library: 'library',
  more: 'settings',
};

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
  const [models, setModels] = useState<readonly ModelOptionView[]>([]);
  const [modelId, setModelId] = useState<string | undefined>(undefined);
  /** 用户是否**显式**改过模型（03 §2.5 的圆点）。切场景时保留他的选择，不悄悄改回去 */
  const [modelOverridden, setModelOverridden] = useState(false);
  const [modelUnavailable, setModelUnavailable] = useState<string | undefined>(undefined);
  const [modelUnavailableReason, setModelUnavailableReason] = useState<
    ModelUnavailableReason | undefined
  >(undefined);
  const [providerKeys, setProviderKeys] = useState<ProviderKeys>(EMPTY_PROVIDER_KEYS);
  const [modelApplying, setModelApplying] = useState(false);
  /** 选中的工作空间（EvoWork 的「空间」= 内核的 Project + cwd）。主进程负责翻成 cwd */
  const [workspaceId, setWorkspaceId] = useState<string | undefined>(undefined);
  const [view, setView] = useState<MainView>('task');
  const [library, setLibrary] = useState<LibraryDataView | null>(null);
  const [automations, setAutomations] = useState<AutomationsDataView | null>(null);
  const [audit, setAudit] = useState<AuditDataView | null>(null);
  const [onboardingStep, setOnboardingStep] = useState<OnboardingStep>(
    ONBOARDING_STEPS[0] as OnboardingStep,
  );
  /**
   * 引导里已选的工作空间。
   *
   * 单独一份 state 而不是选完重拉 `getStartup`：选完要立刻能点「下一步」，
   * 而为了看到刚选的目录重拉一次整个启动数据，中间那半秒按钮还是灰的 ——
   * 用户会以为没选上，再点一次。
   */
  const [pickedWorkspaces, setPickedWorkspaces] = useState<readonly string[]>([]);
  /**
   * 办公扩展的状态与安装（08 §4）。
   *
   * 三份 state 而不是一份：**"没装"、"正在装"、"装失败了"是三种不同的界面**，
   * 合成一个字段的话，安装失败后进度条会停在最后一个百分比上不动 ——
   * 看起来像还在装，而实际上已经结束了。
   */
  const [runtime, setRuntime] = useState<RuntimeStatusView | null>(null);
  const [runtimeProgress, setRuntimeProgress] = useState<RuntimeProgressView | undefined>(
    undefined,
  );
  const [runtimeError, setRuntimeError] = useState<string | undefined>(undefined);
  /**
   * 正在拉当前任务的历史。点开已完成任务到条目到达之前，不能显示
   * 「这个任务还没有消息」—— 那是刚创建的空态，不是加载中。
   */
  const [historyLoading, setHistoryLoading] = useState(false);

  /*
   * 「项目」有两个视图（列表与详情），但**不引 router**（`MainView` 的注释）：
   * 一个 `activeProjectId` 就够了 —— null = 列表，有值 = 详情。
   */
  const [projects, setProjects] = useState<ProjectsDataView | null>(null);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [projectDetail, setProjectDetail] = useState<ProjectDetailView | null>(null);
  const [projectTree, setProjectTree] = useState<readonly DirEntryView[]>([]);
  const [projectTreeChildren, setProjectTreeChildren] = useState<
    Readonly<Record<string, readonly DirEntryView[]>>
  >({});
  const [projectMemo, setProjectMemo] = useState<AgentsMemoView>({ exists: false, content: '' });
  /** 上一次动作被拒绝的原话。**显示出来**，不吞掉 */
  const [projectRefusal, setProjectRefusal] = useState<string | undefined>(undefined);
  const [settings, setSettings] = useState<SettingsView | null>(null);
  const [settingsSection, setSettingsSection] = useState<SettingsSectionId>('models');
  const [settingsRefusal, setSettingsRefusal] = useState<string | undefined>(undefined);
  const [secretStoreNeedsChoice, setSecretStoreNeedsChoice] = useState(false);

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
        if (event.type === 'projects-changed') {
          /*
           * 内核那一侧变了（另一个客户端建了 project）。**只在这一页时才拉** ——
           * 本机的增删由动作本身返回新列表，不等这个事件。
           */
          if (view === 'projects') {
            void bridge
              .listProjects()
              .then(setProjects)
              .catch(() => undefined);
          }
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
    // `view` 进依赖：`onUiEvent` 的 handler 闭包里读它判断 projects-changed 要不要重拉，
    // 不进依赖的话闭包会永远拿着订阅那一刻的旧 view，切页后事件处理逻辑就是过期的
  }, [bridge, view]);

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

  /**
   * 模型下拉（03 §4.5「启动时 + 手动刷新」）。
   *
   * 拿不到列表**不是异常**：网关没起、令牌不对、一家密钥都没配，都会走到这里，
   * 而它们的共同后果是"现在发不出任务"。所以结果落在 `modelUnavailable` 上，
   * 由 Composer 渲染成 danger 条并禁用发送（03 §8：**在发送之前就说**，
   * 而不是等任务失败）。
   */
  const applyCatalog = useCallback((result: ModelCatalogResult) => {
    setModels(result.models);
    setModelUnavailable(result.unavailable);
    setModelUnavailableReason(result.reason);
    setSecretStoreNeedsChoice(Boolean(result.secretStoreNeedsChoice));
  }, []);

  const loadModels = useCallback(async () => {
    try {
      applyCatalog(await bridge.listModels());
    } catch (err: unknown) {
      // IPC 本身失败（handler 没注册之类）——这是我们自己的 bug，不能装成"网关不通"
      setModels([]);
      setModelUnavailable(`读不到可用模型：${err instanceof Error ? err.message : String(err)}`);
      setModelUnavailableReason(undefined);
    }
  }, [bridge, applyCatalog]);

  const checkModelAccess = useCallback(async () => {
    const input: ApplyModelAccessInput = {
      ...(providerKeys.deepseek.trim() ? { deepseekApiKey: providerKeys.deepseek.trim() } : {}),
      ...(providerKeys.moonshot.trim() ? { moonshotApiKey: providerKeys.moonshot.trim() } : {}),
      ...(providerKeys.zhipu.trim() ? { zhipuApiKey: providerKeys.zhipu.trim() } : {}),
    };
    const hasKeys = Object.keys(input).length > 0;
    setModelApplying(true);
    try {
      if (hasKeys) {
        applyCatalog(await bridge.applyModelAccess(input));
      } else {
        await loadModels();
      }
    } catch (err: unknown) {
      setModels([]);
      setModelUnavailable(`读不到可用模型：${err instanceof Error ? err.message : String(err)}`);
      setModelUnavailableReason(undefined);
    } finally {
      setModelApplying(false);
    }
  }, [bridge, providerKeys, applyCatalog, loadModels]);

  useEffect(() => {
    void loadModels();
  }, [loadModels]);

  /**
   * 办公扩展：进来先探一次，安装进度订阅整个会话都在。
   *
   * 订阅不只在引导页开：安装可能在引导里发起，而用户会一边装一边往下走完引导 ——
   * 只在那一屏订阅的话，走出去再回来进度就断了。
   */
  useEffect(() => {
    void bridge
      .getRuntimeStatus()
      .then(setRuntime)
      .catch(() => setRuntime(null));
    return bridge.onRuntimeProgress(setRuntimeProgress);
  }, [bridge]);

  /**
   * 装办公扩展。
   *
   * 装完**必须重新探一次**而不是直接把 `installed` 置真：安装器说成功了不等于
   * 这台机器上探得到（安全软件、权限、装到别的 HOME）。以探测结果为准，
   * 才不会出现"界面说装好了、生成产物时说没装"。
   */
  const installRuntime = useCallback(async () => {
    setRuntimeError(undefined);
    setRuntimeProgress({ phase: 'download-python', label: '正在准备', percent: 0 });
    try {
      const result = await bridge.installOfficeRuntime();
      if (!result.ok) setRuntimeError(result.message ?? '安装没能完成。');
    } catch (err: unknown) {
      setRuntimeError(`安装没能完成：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      // 成功与否都清掉进度条并重探：失败时留着进度条会像还在装
      setRuntimeProgress(undefined);
      await bridge
        .getRuntimeStatus()
        .then(setRuntime)
        .catch(() => undefined);
    }
  }, [bridge]);

  /**
   * 选中项跟着「列表 + 场景默认值 + 用户已选」三者走。
   *
   * 场景默认的模型不在列表里时会换一个并**说出来** —— 见 `resolveModelChoice`。
   * 那条提示只在换掉的那一次插入，不会每次渲染都堆一条：`notice` 只有在
   * 选中项真的发生变化时才会被消费。
   */
  const scenarioDefaultModel = startup?.scenarios.find((s) => s.id === scenarioId)?.defaults
    .modelId;
  useEffect(() => {
    const choice = resolveModelChoice(
      models,
      modelOverridden ? modelId : undefined,
      scenarioDefaultModel,
    );
    if (choice.modelId === modelId) return;
    setModelId(choice.modelId);
    const notice = choice.notice;
    if (notice) setNotices((prev) => [...prev, { tone: 'warning', text: notice }]);
    // modelId 不进依赖：它是这个 effect 的输出，进去会让"换一个"再触发一次自己
  }, [models, modelOverridden, scenarioDefaultModel]);

  /**
   * 切到某个任务时，下拉跟着**那个任务的**模型走（04 §4 的任务级设置）。
   *
   * 少了这一步，打开一个用 Kimi 跑过的旧任务、直接接着问一句，那一句会被发给
   * 当前下拉里选中的模型 —— 又一次"静默换模型"，而且用户完全看不出来。
   * 视为一次显式选择（打上圆点）：它确实是用户此前对这个任务做过的选择。
   */
  useEffect(() => {
    if (activeTaskId === null) return;
    const taskModel = tasks.find((t) => t.id === activeTaskId)?.modelId;
    if (taskModel === undefined || taskModel === modelId) return;
    setModelId(taskModel);
    setModelOverridden(true);
    // tasks / modelId 不进依赖：这个 effect 只该在**切任务**时跑。
    // 把 tasks 加进去会让每一次流式更新（任务行随时在变）都重置一遍下拉
  }, [activeTaskId]);

  /**
   * 切到某个任务时拉它的历史（04 §9）。
   *
   * 对话条目此前只活在当场的事件流里。重启后再点已完成任务，`itemsByTask`
   * 是空的，对话区就画出「还没有消息」—— 标题和「已完成」来自投影表，两边对不上。
   * 权威列表到达后与已有的流式条目按 id 合并：进行中的任务不会被一页历史盖掉。
   */
  useEffect(() => {
    if (activeTaskId === null) return;
    const threadId = activeTaskId;
    let cancelled = false;
    setHistoryLoading(true);
    void bridge
      .openTask({ threadId })
      .then((result) => {
        if (cancelled) return;
        setItemsByTask((prev) => ({
          ...prev,
          [threadId]: applyHistory(prev[threadId] ?? [], result.items as readonly RenderItem[]),
        }));
        const incomplete = result.incomplete;
        if (incomplete) {
          setNotices((prev) => [...prev, { tone: 'warning', text: incomplete }]);
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setNotices((prev) => [
          ...prev,
          {
            tone: 'warning',
            text: `读不到这个任务的历史：${err instanceof Error ? err.message : String(err)}`,
          },
        ]);
      })
      .finally(() => {
        if (!cancelled) setHistoryLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [activeTaskId, bridge]);

  /**
   * 进到某一页时才去拉它的数据。
   *
   * **每次进都重拉**，不做缓存：这三张表随时在被别的东西写（调度器在跑、
   * watcher 在索引产物、hook 在写审计）。缓存一份的话，用户跑完一个任务
   * 回到资料库看不到新产物 —— 而他没有任何理由知道要刷新。
   */
  useEffect(() => {
    if (view === 'library')
      void bridge
        .getLibrary()
        .then(setLibrary)
        .catch(() => setLibrary(null));
    if (view === 'automations') {
      void bridge
        .getAutomations()
        .then(setAutomations)
        .catch(() => setAutomations(null));
    }
    if (view === 'audit')
      void bridge
        .getAudit()
        .then(setAudit)
        .catch(() => setAudit(null));
    if (view === 'projects' && activeProjectId === null)
      void bridge
        .listProjects()
        .then(setProjects)
        .catch(() => setProjects(null));
    if (view === 'settings')
      void bridge
        .getSettings()
        .then(setSettings)
        .catch(() => setSettings(null));
  }, [view, activeProjectId, bridge]);

  /**
   * 进详情页时拉三份数据：概览、根目录一层、空间记忆。
   *
   * 三次调用而不是一次给全：文件树与记忆都是**读盘**，而概览读的是 sqlite。
   * 合成一个动作的话，一个没权限的目录会把整页拖成空白。
   */
  useEffect(() => {
    if (view !== 'projects' || activeProjectId === null) return;
    const id = activeProjectId;
    void bridge
      .readProjectDetail({ id })
      .then(setProjectDetail)
      .catch(() => setProjectDetail(null));
    void bridge
      .listProjectDir({ id })
      .then(setProjectTree)
      .catch(() => setProjectTree([]));
    void bridge
      .readAgentsMemo({ id })
      .then(setProjectMemo)
      .catch(() => setProjectMemo({ exists: false, content: '' }));
    setProjectTreeChildren({});
  }, [view, activeProjectId, bridge]);

  /*
   * 增删改的落地方式：**用返回的新列表直接 setProjects，不再拉一次**（Task 13 的要点）——
   * 重拉是第二次往返，可能被稍后到达的 `listProjects` 结果反超，画面回退成没改之前的样子。
   * `refused` 永远跟着一起设：成功时 `result.refused` 是 undefined，正好清掉上一次的拒绝提示。
   */
  const applyMutation = useCallback((result: ProjectMutationResult) => {
    setProjects({ projects: result.projects });
    setProjectRefusal(result.refused);
  }, []);

  const createProject = useCallback(
    (input: { name: string; path: string }) => {
      void bridge
        .createProject(input)
        .then(applyMutation)
        .catch(() => undefined);
    },
    [bridge, applyMutation],
  );

  const importProject = useCallback(() => {
    void bridge
      .importProject()
      .then(applyMutation)
      .catch(() => undefined);
  }, [bridge, applyMutation]);

  const renameProject = useCallback(
    (input: { id: string; name: string }) => {
      void bridge
        .renameProject(input)
        .then(applyMutation)
        .catch(() => undefined);
    },
    [bridge, applyMutation],
  );

  const removeProject = useCallback(
    (id: string) => {
      void bridge
        .removeProject({ id })
        .then(applyMutation)
        .catch(() => undefined);
    },
    [bridge, applyMutation],
  );

  const openProjectFolder = useCallback(
    (id: string) => {
      void bridge.openProjectFolder({ id });
    },
    [bridge],
  );

  /*
   * 新建对话框里的「选择目录」调**纯选目录**动作 `pickProjectDirectory`——
   * **不能**复用 `pickWorkspace`（C1）：那个动作选完会立刻建成一个空间
   * （首次引导要的正是这个语义），对话框如果也调它，用户选目录 + 按「创建」
   * 就会建出两个一模一样的空间；选完按取消，还会留下一个用户没确认过的空间。
   *
   * **拒绝在这一步也要显示**——用户手动选中一个受保护目录（如 `~/.ssh`）时，
   * `pickProjectDirectory` 自己就会带回 `refused`，这条路径同样不能被静默吞掉
   * （Task 9 那个"点了没反应"的坑）。
   */
  const pickProjectDirectory = useCallback(async () => {
    const result = await bridge.pickProjectDirectory();
    if (result.refused) {
      setProjectRefusal(result.refused);
      return undefined;
    }
    return result.path;
  }, [bridge]);

  /**
   * 02 §4.3：跳首页并**预选该工作空间**。
   * 首页下拉在 Task 9 之后读的就是 `project_local`，所以这里只是选中一个已有项，
   * 不新增任何机制。
   */
  const newTaskInProject = useCallback((id: string) => {
    setWorkspaceId(id);
    setActiveProjectId(null);
    setActiveTaskId(null);
    setView('task');
  }, []);

  const expandProjectDir = useCallback(
    (path: string) => {
      if (activeProjectId === null) return;
      const id = activeProjectId;
      void bridge
        .listProjectDir({ id, path })
        .then((entries) => setProjectTreeChildren((prev) => ({ ...prev, [path]: entries })))
        .catch(() => undefined);
    },
    [activeProjectId, bridge],
  );

  /** D-P5：不接 `fs/watch`，「刷新」按钮重拉根目录一层并清掉已展开的子层缓存 */
  const refreshProjectTree = useCallback(() => {
    if (activeProjectId === null) return;
    const id = activeProjectId;
    void bridge
      .listProjectDir({ id })
      .then(setProjectTree)
      .catch(() => setProjectTree([]));
    setProjectTreeChildren({});
  }, [activeProjectId, bridge]);

  /*
   * C3：`onSaveMemo` 把 `WriteAgentsMemoResult` 原样交给页面，**不再假设总是成功**。
   * 以前这里只在 `result.ok` 为真时更新 `projectMemo`，`ok` 为假就直接返回——页面那边
   * 又是 `.then(() => setSaved(true))` 不看结果，两边合起来就是"写失败也显示已保存"。
   *
   * `.catch` 是防御性的第二道：`writeAgentsMemo` 内部已经把 `ports.writeTextFile`
   * 包了 try/catch，正常不会走到这里，但这个文件里**别的每一个** bridge 调用
   * 都有自己的 `.catch`（IPC 本身也可能失败），这里不该是唯一的例外。
   */
  const saveProjectMemo = useCallback(
    (content: string): Promise<WriteAgentsMemoResult> => {
      if (activeProjectId === null) return Promise.resolve({ ok: false });
      const id = activeProjectId;
      return bridge
        .writeAgentsMemo({ id, content })
        .then((result) => {
          if (result.ok) setProjectMemo({ exists: true, content });
          return result;
        })
        .catch((): WriteAgentsMemoResult => ({
          ok: false,
          refused: '没能保存空间记忆，稍后再试。',
        }));
    },
    [activeProjectId, bridge],
  );

  const send = useCallback(async () => {
    const text = draft.trim();
    if (!text) return;
    setDraft('');
    try {
      const { threadId } = await bridge.send({
        ...(activeTaskId ? { threadId: activeTaskId } : {}),
        text,
        scenarioId,
        // 手选的模型跟着这一条消息走（03 §2.4：用户显式选择优先级最高）。
        // 主进程同时把它写进任务级设置，否则下一轮又回落到场景默认值
        ...(modelId !== undefined ? { modelId } : {}),
        // 任务在哪个目录里跑。id → path 的翻译在主进程（渲染层不持有绝对路径）
        ...(workspaceId !== undefined ? { workspaceId } : {}),
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
  }, [bridge, draft, activeTaskId, scenarioId, modelId, workspaceId]);

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

  /** 工作空间下拉的选项。空数组时 Composer 渲染一句说明，**不是空白浮层** */
  const workspaces: readonly SelectOption[] = useMemo(
    () =>
      (startup?.workspaces ?? []).map((w) => ({
        id: w.id,
        label: w.name,
        // 路径就是"任务会跑在哪"，是这一项唯一重要的信息；没有 root 的空间如实说明
        description: w.path ?? '这个空间没有目录，任务会落在默认目录',
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
      workspaces,
      workspaceId,
      onWorkspaceChange: setWorkspaceId,
      permissions,
      permissionId,
      onPermissionChange: setPermissionId,
      mode,
      onModeChange: setMode,
      models,
      modelId,
      onModelChange: (id: string) => {
        setModelId(id);
        // 03 §2.5：显式改过的控件带一个圆点，切场景时不再被默认值改回去
        setModelOverridden(true);
      },
      overrides: { model: modelOverridden },
      onResetOverride: (key: 'model' | 'permission' | 'mode') => {
        if (key === 'model') setModelOverridden(false);
      },
      /*
       * 03 §8：模型不可用 → danger 条 + 禁用发送，**不换一个模型继续**。
       * 「检查模型接入」重新拉一次列表 —— 用户通常是去把网关起起来了再回来点它。
       */
      ...(modelUnavailable !== undefined
        ? {
            modelUnavailable: {
              text: modelUnavailable,
              ...(modelUnavailableReason !== undefined ? { reason: modelUnavailableReason } : {}),
              onFix: () => void checkModelAccess(),
            },
            modelAccess: {
              values: providerKeys,
              onChange: (id: ProviderKeyId, value: string) =>
                setProviderKeys((prev) => ({ ...prev, [id]: value })),
              applying: modelApplying,
            },
          }
        : {}),
    }),
    [
      send,
      running,
      activeTaskId,
      bridge,
      workspaces,
      workspaceId,
      permissions,
      permissionId,
      mode,
      models,
      modelId,
      modelOverridden,
      modelUnavailable,
      loadModels,
      checkModelAccess,
      providerKeys,
      modelApplying,
      modelUnavailableReason,
    ],
  );

  /*
   * 首次引导（02 §9）。**盖住整个界面** —— 它要拿到工作空间与权限档位的答案，
   * 而这两件事决定后面每个任务在哪跑、能动什么。走完落 `meta` 表，不再出现。
   *
   * `startup === null` 时不显示：那时我们还不知道走没走过，
   * 闪一下引导再消失比晚半秒更糟。
   */
  if (startup !== null && !startup.onboarded) {
    return (
      <div className="ew-app ew-app-onboarding">
        {/*
         * `Onboarding` 本身不接 `notices`（它是独立视图，本次修复不改它）。
         * 拒绝目录的提示直接摆在它上面——引导屏这时候是整个界面，
         * 用户的视线躲不开这条 Banner，效果和别处塞进 `notices` 一样。
         */}
        {notices.map((notice, index) => (
          <Banner key={`${notice.tone}-${index}`} tone={notice.tone}>
            {notice.text}
          </Banner>
        ))}
        <Onboarding
          step={onboardingStep}
          onStepChange={setOnboardingStep}
          workspaces={[
            ...startup.workspaces.map((w) => w.path ?? w.name),
            ...pickedWorkspaces.filter((p) => !startup.workspaces.some((w) => w.path === p)),
          ]}
          /*
           * **这一步是硬门槛**：`blockingReason` 要求至少一个工作空间，
           * 而干净机器上内核一个 project 都没有。不接这个回调的话，
           * 「下一步」永远是灰的 —— 整个应用打不开（2026-09-06 实测撞到）。
           */
          onPickWorkspace={() => {
            void bridge.pickWorkspace().then((r) => {
              if (r.path) {
                setPickedWorkspaces((prev) => [...new Set([...prev, r.path as string])]);
                return;
              }
              /*
               * 只有"被拒"才提示，取消不提示（`r.refused` 是 undefined 时什么都不做）——
               * 这正是本条修复要的区分：拒绝要如实说，取消不需要多此一举打扰用户。
               */
              if (r.refused)
                setNotices((prev) => [...prev, { tone: 'warning', text: r.refused as string }]);
            });
          }}
          permissionProfiles={(startup.permissions ?? []).map((p) => ({
            id: p.id,
            allowed: p.allowed,
            ...(p.description !== undefined ? { description: p.description } : {}),
          }))}
          permissionId={permissionId}
          onPermissionChange={setPermissionId}
          modelStatus={modelUnavailable ? 'failed' : models.length > 0 ? 'ok' : 'unchecked'}
          {...(modelUnavailable !== undefined ? { modelError: modelUnavailable } : {})}
          onCheckModel={() => void checkModelAccess()}
          providerKeys={providerKeys}
          onProviderKeyChange={(id, value) => setProviderKeys((prev) => ({ ...prev, [id]: value }))}
          /*
           * 办公扩展（08 §4）。2026-09-07 之前这里硬编码 `runtimeInstalled={false}`，
           * 因为下载器没实现 —— 那时"如实说"是唯一诚实的选择。现在它实现了，
           * 这一屏接的是真实探测结果与真实安装动作。
           */
          runtimeInstalled={runtime?.installed ?? false}
          runtimeSupported={runtime?.supported ?? false}
          {...(runtime?.downloadSize !== undefined
            ? { runtimeDownloadSize: runtime.downloadSize }
            : {})}
          {...(runtimeProgress ? { runtimeProgress } : {})}
          {...(runtimeError !== undefined ? { runtimeError } : {})}
          onInstallRuntime={() => void installRuntime()}
          onSkipRuntime={() => setOnboardingStep('done')}
          onFinish={() => {
            void bridge.completeOnboarding().then(() => {
              setStartup((prev) => (prev ? { ...prev, onboarded: true } : prev));
            });
          }}
        />
      </div>
    );
  }

  return (
    <div className="ew-app">
      <Sidebar
        tasks={tasks}
        sections={[]}
        selectedId={view === 'task' ? (activeTaskId ?? undefined) : undefined}
        onSelect={(id) => {
          setActiveTaskId(id);
          setView('task');
        }}
        onNewTask={() => {
          setActiveTaskId(null);
          setView('task');
        }}
        onNavSelect={(id) => setView(NAV_TO_VIEW[id] ?? 'task')}
        onRowAction={(action, id) => void bridge.rowAction({ action, threadId: id })}
        onVisibleChange={(ids) => void bridge.refreshVisible(ids)}
        brandName={startup?.appName}
        {...(startup
          ? { user: { name: startup.userName, version: `v${startup.appVersion}` } }
          : {})}
      />

      {view !== 'task' ? (
        <MainPage
          view={view}
          library={library}
          automations={automations}
          audit={audit}
          projects={projects}
          activeProjectId={activeProjectId}
          projectDetail={projectDetail}
          projectTree={projectTree}
          projectTreeChildren={projectTreeChildren}
          projectMemo={projectMemo}
          projectRefusal={projectRefusal}
          onOpenTask={(id) => {
            setActiveTaskId(id);
            setView('task');
          }}
          onCloseProject={() => setActiveProjectId(null)}
          onOpenProject={(id) => setActiveProjectId(id)}
          onExpandDir={expandProjectDir}
          onRefreshTree={refreshProjectTree}
          onOpenProjectFolder={() => {
            if (activeProjectId !== null) openProjectFolder(activeProjectId);
          }}
          onOpenProjectFolderById={openProjectFolder}
          onNewTaskInProject={() => {
            if (activeProjectId !== null) newTaskInProject(activeProjectId);
          }}
          onNewTaskInProjectById={newTaskInProject}
          onSaveMemo={saveProjectMemo}
          /*
           * 没有可路由到的自动化详情（「不引 router」），所以这里只切到自动化页 ——
           * 该页自己管理选中项（默认第一行），不接受外部指定某一条
           */
          onOpenAutomation={() => setView('automations')}
          onCreateProject={createProject}
          onImportProject={importProject}
          onRenameProject={renameProject}
          onRemoveProject={removeProject}
          onPickDirectory={pickProjectDirectory}
          settings={settings}
          settingsSection={settingsSection}
          settingsRefusal={settingsRefusal}
          onSettingsSection={setSettingsSection}
          onSaveKey={(slot, value) => {
            void bridge.saveModelKey({ slot, value }).then((result) => {
              setSettings(result.settings);
              setSettingsRefusal(result.refused);
              if (result.secretStoreNeedsChoice) setSecretStoreNeedsChoice(true);
            });
          }}
          onClearKey={(slot) => {
            void bridge.clearModelKey({ slot }).then((result) => {
              setSettings(result.settings);
              setSettingsRefusal(result.refused);
            });
          }}
          onAddCustom={(input) => {
            void bridge.addCustomModel(input).then((result) => {
              setSettings(result.settings);
              setSettingsRefusal(result.refused);
            });
          }}
          onRemoveCustom={(id) => {
            void bridge.removeCustomModel({ id }).then((result) => {
              setSettings(result.settings);
              setSettingsRefusal(result.refused);
            });
          }}
          onChooseFallback={(fallback) => {
            void bridge.chooseSecretFallback({ fallback }).then((next) => {
              setSettings(next);
              setSecretStoreNeedsChoice(next.secretStore.needsChoice);
            });
          }}
        />
      ) : activeTaskId === null ? (
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
          historyLoading={historyLoading}
          onNewTask={() => setActiveTaskId(null)}
          composer={<Composer {...composer} value={draft} onChange={setDraft} />}
        />
      )}
      {secretStoreNeedsChoice ? (
        <Dialog
          title="无法加密保存 API 密钥"
          confirmLabel="以明文文件保存"
          cancelLabel="每次启动时填入"
          onConfirm={() => {
            void bridge.chooseSecretFallback({ fallback: 'plaintext' }).then(() => {
              setSecretStoreNeedsChoice(false);
              void checkModelAccess();
            });
          }}
          onCancel={() => {
            void bridge.chooseSecretFallback({ fallback: 'ephemeral' }).then(() => {
              setSecretStoreNeedsChoice(false);
              void checkModelAccess();
            });
          }}
        >
          {SECRET_STORE_UNAVAILABLE}
        </Dialog>
      ) : null}
    </div>
  );
}

/**
 * 目录式页面的分发。
 *
 * ## 为什么没有页面的入口也要在这里出现
 *
 * 02 §1 的 6 个入口是产品骨架，其中一个（专家·技能·连接器）
 * 现在**还没有页面**。在此之前它们的表现是**点了没有任何反应** ——
 * 用户看到的是一个有六个菜单项、其中两个是死的应用，而"点了没反应"
 * 与"坏了"在界面上完全无法区分。
 *
 * 所以这里给它们一个如实说明的空页：**说清是没做，不是坏了**
 * （CLAUDE.md §9.1「降级、跳过、认不出来都要如实说」的同一条）。
 * 页面做好之后把它加进这个 switch，这段自然消失。
 */
function MainPage(props: {
  readonly view: MainView;
  readonly library: LibraryDataView | null;
  readonly automations: AutomationsDataView | null;
  readonly audit: AuditDataView | null;
  readonly projects: ProjectsDataView | null;
  readonly activeProjectId: string | null;
  readonly projectDetail: ProjectDetailView | null;
  readonly projectTree: readonly DirEntryView[];
  readonly projectTreeChildren: Readonly<Record<string, readonly DirEntryView[]>>;
  readonly projectMemo: AgentsMemoView;
  readonly projectRefusal: string | undefined;
  readonly onOpenTask: (threadId: string) => void;
  readonly onCloseProject: () => void;
  readonly onOpenProject: (id: string) => void;
  readonly onExpandDir: (path: string) => void;
  readonly onRefreshTree: () => void;
  readonly onOpenProjectFolder: () => void;
  readonly onOpenProjectFolderById: (id: string) => void;
  readonly onNewTaskInProject: () => void;
  readonly onNewTaskInProjectById: (id: string) => void;
  readonly onSaveMemo: (content: string) => Promise<WriteAgentsMemoResult>;
  readonly onOpenAutomation: (id: string) => void;
  readonly onCreateProject: (input: { name: string; path: string }) => void;
  readonly onImportProject: () => void;
  readonly onRenameProject: (input: { id: string; name: string }) => void;
  readonly onRemoveProject: (id: string) => void;
  readonly onPickDirectory: () => Promise<string | undefined>;
  readonly settings: SettingsView | null;
  readonly settingsSection: SettingsSectionId;
  readonly settingsRefusal: string | undefined;
  readonly onSettingsSection: (id: SettingsSectionId) => void;
  readonly onSaveKey: (slot: string, value: string) => void;
  readonly onClearKey: (slot: string) => void;
  readonly onAddCustom: (input: {
    id: string;
    displayName: string;
    upstreamModel: string;
    adapter: string;
    baseUrl: string;
    apiKey: string;
  }) => void;
  readonly onRemoveCustom: (id: string) => void;
  readonly onChooseFallback: (fallback: 'plaintext' | 'ephemeral') => void;
}) {
  switch (props.view) {
    /*
     * 两处 `as` 是**跨 IPC 的类型收窄**，不是绕过检查。
     *
     * `shared/ipc.ts` 里这些字段是 `string`：那一层是序列化边界，把服务层的字面量
     * 联合重新声明一遍，等于同一组取值在三处各写一份，加一个取值要改三处。
     * 值本身确实来自那些联合（它们从 sqlite 的 TEXT 列原样回来），
     * 而两个页面对**认不出来的取值**都有兜底：资料库的类型筛选不匹配它，
     * 审计页显示原值而不是空白。
     */
    case 'library':
      return (
        <Library
          rows={(props.library?.rows ?? []) as readonly LibraryRow[]}
          {...(props.library?.diskUsage ? { diskUsage: props.library.diskUsage } : {})}
        />
      );

    case 'automations':
      return (
        <AutomationsPage
          rows={props.automations?.automations ?? []}
          runs={props.automations?.runs ?? {}}
          deviceName={props.automations?.deviceName ?? '这台电脑'}
        />
      );

    case 'audit':
      return (
        <AuditPage
          records={(props.audit?.records ?? []) as readonly AuditRow[]}
          retentionDays={props.audit?.retentionDays ?? 90}
          retentionWarningDays={props.audit?.retentionWarningDays ?? 7}
          {...(props.audit?.oldestAt !== undefined ? { oldestAt: props.audit.oldestAt } : {})}
        />
      );

    case 'projects':
      return props.activeProjectId !== null && props.projectDetail !== null ? (
        <ProjectDetailPage
          detail={props.projectDetail}
          rootEntries={props.projectTree}
          childrenOf={props.projectTreeChildren}
          memo={props.projectMemo}
          onBack={props.onCloseProject}
          onExpand={props.onExpandDir}
          onRefreshTree={props.onRefreshTree}
          onOpenTask={props.onOpenTask}
          onOpenFolder={props.onOpenProjectFolder}
          onNewTaskHere={props.onNewTaskInProject}
          onSaveMemo={props.onSaveMemo}
          onOpenAutomation={props.onOpenAutomation}
        />
      ) : (
        <ProjectsPage
          projects={props.projects?.projects ?? []}
          onCreate={props.onCreateProject}
          onImport={props.onImportProject}
          onRename={props.onRenameProject}
          onRemove={props.onRemoveProject}
          onOpenFolder={(id) => props.onOpenProjectFolderById(id)}
          onNewTaskIn={props.onNewTaskInProjectById}
          onOpenDetail={props.onOpenProject}
          onPickDirectory={props.onPickDirectory}
          {...(props.projectRefusal !== undefined ? { refusal: props.projectRefusal } : {})}
        />
      );

    case 'settings':
      return props.settings ? (
        <Settings
          settings={props.settings}
          section={props.settingsSection}
          onSection={props.onSettingsSection}
          onSaveKey={props.onSaveKey}
          onClearKey={props.onClearKey}
          onAddCustom={props.onAddCustom}
          onRemoveCustom={props.onRemoveCustom}
          onChooseFallback={props.onChooseFallback}
          {...(props.settingsRefusal !== undefined ? { refusal: props.settingsRefusal } : {})}
        />
      ) : (
        <div className="ew-page">
          <div className="ew-content-column">
            <EmptyState title="正在读取设置" hint="" />
          </div>
        </div>
      );

    default:
      return <UnbuiltPage view={props.view} />;
  }
}

/** 02 §1 里已有入口、但页面还没做的那几个。**说清是没做**，不留一个空白主区。 */
const UNBUILT_COPY: Readonly<Record<string, { title: string; hint: string }>> = {
  catalog: {
    title: '专家·技能·连接器还没做好',
    hint: '办公技能（文档 / 表格 / 幻灯片 / 图表）已经随产品分发并可用，只是还没有这个管理界面。',
  },
};

function UnbuiltPage({ view }: { readonly view: MainView }) {
  const copy = UNBUILT_COPY[view] ?? { title: '这个页面还没做好', hint: '' };
  return (
    <div className="ew-page">
      <div className="ew-content-column">
        <EmptyState title={copy.title} hint={copy.hint} />
      </div>
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

/**
 * 打开任务时：权威历史是顺序真源，当场的流式条目叠上去。
 *
 * 只替换会丢掉 list 发出之后才到的增量；只追加会让历史永远出不来。
 * 历史里没有、live 里有的（刚发出去的那一句）接到末尾。
 */
export function applyHistory(
  live: readonly RenderItem[],
  history: readonly RenderItem[],
): readonly RenderItem[] {
  const liveById = new Map(live.map((item) => [item.id, item]));
  const historyIds = new Set(history.map((item) => item.id));
  const merged = history.map((item) => {
    const fromLive = liveById.get(item.id);
    return fromLive === undefined ? item : (mergeItem([item], fromLive)[0] ?? fromLive);
  });
  return [...merged, ...live.filter((item) => !historyIds.has(item.id))];
}
