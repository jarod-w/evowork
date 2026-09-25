import type { ComputerUseStatusView } from '../shared/ipc.js';
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
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type {
  AgentsMemoView,
  ApprovalView,
  ApplyModelAccessInput,
  AutomationMutationInput,
  AutomationMutationResult,
  CustomModelInput,
  CustomModelTestInput,
  CustomModelUpdateInput,
  AuditDataView,
  AutomationsDataView,
  CatalogDataView,
  CatalogMutationResult,
  ComposerAttachmentView,
  ComposerContextView,
  ComposerReferenceView,
  DirEntryView,
  LibraryDataView,
  FilePreviewView,
  FileAnnotationView,
  ModelAccessMutationResult,
  ModelAccessView,
  ModelCatalogResult,
  ModelProbeResult,
  ModelOptionView,
  ModelUnavailableReason,
  OpenTaskResult,
  PickAttachmentsInput,
  ProjectDetailView,
  ProjectMutationResult,
  PreferencesInput,
  PreferencesView,
  ProjectsDataView,
  QueuedInputView,
  RendererEvent,
  RuntimeInstallResultView,
  RuntimeProgressView,
  RuntimeStatusView,
  SendInput,
  StartupInfo,
  TaskSearchHitView,
  TaskSearchOccurrenceView,
  TaskGoalView,
  TaskRowView,
  TaskResultsView,
  TaskFilePreviewInput,
  WorkspaceView,
  WriteAgentsMemoResult,
} from '../shared/ipc.js';
import type { ApprovalDecision } from './components/approval-card.js';
import {
  Composer,
  composerModeOptions,
  type ModeId,
  type SelectOption,
} from './components/composer.js';
import type {
  Attachment,
  ComposerPlugin,
  MentionCandidate,
  SlashCommand,
} from './components/composer.js';
import { Banner, EmptyState, IconButton } from './components/primitives.js';
import { renderIcon } from './components/icons.js';
import { createMermaidRenderer } from './components/mermaid-renderer.js';
import type { RenderItem } from './components/item-renderers.js';
import { ChangesView, type ChangedFile, type DiffScope } from './components/changes-view.js';
import { FileTree } from './components/file-tree.js';
import { FilePreview } from './components/file-preview.js';
import {
  shouldAutoDismiss,
  ToastStack,
  TOAST_AUTO_DISMISS_MS,
  type ToastSpec,
} from './components/panels.js';
import { resolveModelChoice } from './model-selection.js';
import { AuditPage, type AuditRow } from './views/audit.js';
import {
  CatalogPage,
  SKILL_CREATOR_PROMPT,
  type CatalogPageProps,
  type CatalogTab,
} from './views/catalog.js';
import type { LibraryRow } from '@evowork/artifacts/library.js';
import { AutomationsPage } from './views/automations.js';
import { Home, type Scenario } from './views/home.js';
import { Library, type LibraryNav } from './views/library.js';
import { Onboarding, ONBOARDING_STEPS, type OnboardingStep } from './views/onboarding.js';
import { ProjectDetailPage } from './views/project-detail.js';
import { SettingsPage, type SettingsSection } from './views/settings.js';
import { CreateProjectDialog, ProjectsPage } from './views/projects.js';
import { Sidebar, type RowAction } from './views/sidebar.js';
import { TaskSearchPalette } from './views/task-search.js';
import { TaskWorkspace, type ResultPane } from './views/task-workspace.js';

/** preload 暴露的窄接口。**这就是渲染进程能做的全部事情**。 */
export interface EvoworkBridge {
  getComputerUseStatus?(): Promise<ComputerUseStatusView>;
  setComputerUseEnabled?(input: { enabled: boolean }): Promise<ComputerUseStatusView>;
  stopComputerUse?(): Promise<ComputerUseStatusView>;
  revokeComputerUseAccess?(input: { appId?: string }): Promise<ComputerUseStatusView>;
  openComputerUseSettings?(): Promise<void>;
  onComputerUseStatus?(handler: (status: ComputerUseStatusView) => void): () => void;
  onUiEvent(handler: (event: RendererEvent) => void): () => void;
  onNotice(handler: (notice: { kind: string; text: string }) => void): () => void;
  onPendingApprovals(handler: (approvals: readonly ApprovalView[]) => void): () => void;
  onDegrade(handler: (report: { degradation?: { userVisible: string } }) => void): () => void;
  /** 发送一条需求。没有 threadId 时由主进程新建任务并回 id（03 §1） */
  send(input: SendInput): Promise<{ threadId: string; queued?: boolean }>;
  setTaskMode(input: {
    threadId: string;
    modeId: 'request-approval' | 'approve-for-me' | 'full-access';
  }): Promise<void>;
  interrupt(threadId: string): Promise<void>;
  revertTask?(input: { threadId: string; beforeTurnId: string }): Promise<void>;
  decideApproval(input: {
    id: string;
    decision: ApprovalDecision;
    optionId?: string;
    answer?: string;
  }): Promise<void>;
  rowAction(input: { action: RowAction; threadId: string }): Promise<void>;
  /** 04 §3.4 第②步：对可见页做有界的权威字段校正 */
  refreshVisible(ids: readonly string[]): Promise<void>;
  /** 打开已有任务并拉历史。点侧边栏一行就必须调，否则已完成任务是空对话 */
  openTask(input: { threadId: string }): Promise<OpenTaskResult>;
  listSubtasks?(input: { threadId: string }): Promise<readonly TaskRowView[]>;
  searchTasks?(input: { query: string }): Promise<readonly TaskSearchHitView[]>;
  searchTaskOccurrences?(input: {
    threadId: string;
    query: string;
  }): Promise<readonly TaskSearchOccurrenceView[]>;
  renameTask?(input: { threadId: string; name: string }): Promise<boolean>;
  forkTask?(input: {
    threadId: string;
    lastTurnId?: string;
    ephemeral?: boolean;
  }): Promise<{ threadId: string; task?: TaskRowView }>;
  archiveTask?(input: { threadId: string }): Promise<void>;
  deleteTask?(input: { threadId: string }): Promise<void>;
  listQueuedInputs?(input: { threadId: string }): Promise<readonly QueuedInputView[]>;
  updateQueuedInput?(input: {
    threadId: string;
    id: string;
    text: string;
    references?: readonly ComposerReferenceView[];
  }): Promise<boolean>;
  reorderQueuedInputs?(input: { threadId: string; ids: readonly string[] }): Promise<boolean>;
  removeQueuedInput?(input: { threadId: string; id: string }): Promise<boolean>;
  getTaskGoal?(input: { threadId: string }): Promise<TaskGoalView | undefined>;
  setTaskGoal?(input: {
    threadId: string;
    objective?: string;
    status?: TaskGoalView['status'];
    tokenBudget?: number | null;
  }): Promise<TaskGoalView | undefined>;
  clearTaskGoal?(input: { threadId: string }): Promise<void>;
  getTaskResults(input: { threadId: string }): Promise<TaskResultsView>;
  openResultFile(input: { artifactId: string }): Promise<void>;
  readResultPreview?(input: { artifactId: string }): Promise<FilePreviewView>;
  readTaskFilePreview?(input: TaskFilePreviewInput): Promise<FilePreviewView>;
  readProjectFilePreview?(input: { projectId: string; path: string }): Promise<FilePreviewView>;
  getComposerContext?(input: { workspaceId?: string }): Promise<ComposerContextView>;
  searchComposerMentions?(input: {
    workspaceId?: string;
    query: string;
  }): Promise<ComposerContextView['mentions']>;
  pickAttachments?(input: PickAttachmentsInput): Promise<readonly ComposerAttachmentView[]>;
  ingestAttachments?(input: {
    workspaceId?: string;
    threadId?: string;
    files: readonly { name: string; bytes: Uint8Array }[];
  }): Promise<readonly ComposerAttachmentView[]>;
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
  /*
   * 设置页（11 §4.4，M10a）。
   *
   * **每个动作都返回一份新视图**：少了它，页面要么自己猜新状态（于是"保存了没有"
   * 靠乐观更新，而钥匙串可能拒绝了这次写入），要么再发一次请求。
   * 密钥只朝一个方向走 —— 返回的视图里只有后四位。
   */
  getModelAccess(): Promise<ModelAccessMutationResult>;
  saveProviderKey(input: {
    providerId: string;
    apiKey: string;
  }): Promise<ModelAccessMutationResult>;
  clearProviderKey(input: { providerId: string }): Promise<ModelAccessMutationResult>;
  addCustomModel(input: CustomModelInput): Promise<ModelAccessMutationResult>;
  updateCustomModel(input: CustomModelUpdateInput): Promise<ModelAccessMutationResult>;
  removeCustomModel(input: { id: string }): Promise<ModelAccessMutationResult>;
  /** 保存之前的「测试连接」。不改本机状态，所以**不返回 view** */
  testCustomModel(input: CustomModelTestInput): Promise<ModelProbeResult>;
  openModelsFolder(): Promise<void>;
  openProviderDocs(input: { provider: string }): Promise<{ ok: boolean; refused?: string }>;
  setSecretFallback(input: { accept: boolean }): Promise<ModelAccessMutationResult>;
  probeModel(input: { modelId: string }): Promise<ModelProbeResult>;
  getPreferences(): Promise<PreferencesView>;
  setPreferences(input: PreferencesInput): Promise<PreferencesView>;
  startLogin(): Promise<{ ok: boolean; refused?: string }>;
  logout(): Promise<{ ok: boolean; refused?: string }>;
  listDevices(): Promise<readonly import('../shared/ipc.js').DeviceView[]>;
  revokeDevice(input: { deviceId: string }): Promise<{ ok: boolean; refused?: string }>;
  openAccountWeb(input: { path: string }): Promise<{ ok: boolean; refused?: string }>;
  /*
   * 三个目录式页面各自一个动作。**按需拉，不并进 getStartup** ——
   * 它们读的是本机 sqlite，且绝大多数会话里用户根本不会打开资料库。
   */
  getLibrary(): Promise<LibraryDataView>;
  getAutomations(): Promise<AutomationsDataView>;
  saveAutomation?(input: AutomationMutationInput): Promise<AutomationMutationResult>;
  setAutomationStatus?(input: {
    id: string;
    status: 'ACTIVE' | 'PAUSED';
  }): Promise<AutomationMutationResult>;
  migrateAutomation?(input: { id: string }): Promise<AutomationMutationResult>;
  runAutomation?(input: { id: string; test?: boolean }): Promise<AutomationMutationResult>;
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
  /*
   * 技能 · 连接器（05）。与三个目录式页面同一条理由：**按需拉，不并进 getStartup**。
   */
  getCatalog(): Promise<CatalogDataView>;
  installSkill(input: {
    kind: 'directory' | 'git';
    path?: string | undefined;
    url?: string | undefined;
    acknowledge?: boolean | undefined;
    confirmName?: string | undefined;
  }): Promise<CatalogMutationResult>;
  uninstallSkill(input: { id: string }): Promise<CatalogMutationResult>;
  setSkillEnabled(input: {
    path: string;
    name: string;
    enabled: boolean;
  }): Promise<CatalogMutationResult>;
  installPluginBundle(input: {
    marketplacePath: string;
    pluginName: string;
  }): Promise<CatalogMutationResult>;
  uninstallPluginBundle(input: { pluginId: string }): Promise<CatalogMutationResult>;
  addConnector(input: {
    name: string;
    transport: 'stdio' | 'sse' | 'http';
    command?: string | undefined;
    args?: string | undefined;
    url?: string | undefined;
  }): Promise<CatalogMutationResult>;
  trustConnector(input: { id: string }): Promise<CatalogMutationResult>;
  removeConnector(input: { id: string }): Promise<CatalogMutationResult>;
  createExpert(input: {
    name: string;
    description: string;
    category: string;
    sampleTasks: string;
    instructions?: string | undefined;
  }): Promise<CatalogMutationResult>;
  removeExpert(input: { id: string }): Promise<CatalogMutationResult>;
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
type MainView =
  | 'task'
  | 'library'
  | 'automations'
  | 'audit'
  | 'projects'
  | 'catalog'
  /** 设置（11 §4.4）。**一页多分区**，分区由 `settingsSection` 决定 —— 不是六个视图 */
  | 'settings'
  | 'more';

/** 侧边栏 id → 主内容区。**没有页面的入口也必须在这里出现**，见 `UnbuiltPage`。 */
const NAV_TO_VIEW: Readonly<Record<string, MainView>> = {
  'new-task': 'task',
  projects: 'projects',
  catalog: 'catalog',
  automations: 'automations',
  library: 'library',
  more: 'more',
};

/**
 * 主内容区 → 侧边栏选中项（02 §2）。
 *
 * 设置 / 审计从「更多」进入，不点亮任何一级导航；任务工作台点亮列表行而不是入口。
 * 缺这一层的话 Sidebar 会把「没选任务」猜成首页，自动化页看起来就像还停在「新建任务」。
 */
const VIEW_TO_NAV: Readonly<Partial<Record<MainView, string>>> = {
  task: 'new-task',
  projects: 'projects',
  catalog: 'catalog',
  automations: 'automations',
  library: 'library',
  more: 'more',
};

function navIdForView(view: MainView, activeTaskId: string | null): string | undefined {
  if (view === 'task' && activeTaskId !== null) return undefined;
  return VIEW_TO_NAV[view];
}

/** UI 操作（停止、队列、附件、设置）始终归根任务；子代理时间线只负责查看。 */
export function rootTaskFor(
  tasks: readonly TaskRowView[],
  taskId: string | null,
): TaskRowView | undefined {
  let current = tasks.find((task) => task.id === taskId);
  const seen = new Set<string>();
  while (current?.parentThreadId) {
    if (seen.has(current.id)) return undefined;
    seen.add(current.id);
    const parent = tasks.find((task) => task.id === current?.parentThreadId);
    if (!parent) return undefined;
    current = parent;
  }
  return current;
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

/**
 * 首页 Composer 该预选哪个项目（02 §9）。
 *
 * 已选且还在列表里 → 保持。引导刚选的路径 → 用它。只剩一个项目 → 直接用。
 * 多个且用户没选过 → 不擅自挑，下拉保持「选择项目」。
 */
function preferredWorkspaceId(
  workspaces: readonly WorkspaceView[],
  pickedPaths: readonly string[],
  current: string | undefined,
): string | undefined {
  if (current !== undefined && workspaces.some((workspace) => workspace.id === current)) {
    return current;
  }
  for (let index = pickedPaths.length - 1; index >= 0; index -= 1) {
    const path = pickedPaths[index];
    const match = workspaces.find((workspace) => workspace.path === path);
    if (match) return match.id;
  }
  return workspaces.length === 1 ? workspaces[0]?.id : undefined;
}

export function App({ bridge }: { readonly bridge: EvoworkBridge }) {
  const deletedTaskIds = useRef(new Set<string>());
  const [tasks, setTasks] = useState<readonly TaskRowView[]>([]);
  const [itemsByTask, setItemsByTask] = useState<Readonly<Record<string, readonly RenderItem[]>>>(
    {},
  );
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null);
  const [approvals, setApprovals] = useState<readonly ApprovalView[]>([]);
  const [notices, setNotices] = useState<
    readonly {
      tone: 'info' | 'warning' | 'danger';
      text: string;
      /** 只属于当前任务；进入新任务时不应把旧任务的故障继续挂在首页。 */
      scope?: 'task';
    }[]
  >([]);
  const [turnFailures, setTurnFailures] = useState<
    Readonly<Record<string, { readonly summary: string }>>
  >({});
  const [toasts, setToasts] = useState<readonly ToastSpec[]>([]);
  const toastCounter = useRef(0);
  const [startup, setStartup] = useState<StartupInfo | null>(null);
  const [scenarioId, setScenarioId] = useState('office');
  const [permissionId, setPermissionId] = useState<string | undefined>(undefined);
  const [mode, setMode] = useState<ModeId>('request-approval');
  const [draft, setDraft] = useState('');
  const [failure, setFailure] = useState<string | undefined>(undefined);
  const [models, setModels] = useState<readonly ModelOptionView[]>([]);
  const [modelId, setModelId] = useState<string | undefined>(undefined);
  /** 用户是否**显式**改过模型（03 §2.5 的圆点）。切场景时保留他的选择，不悄悄改回去 */
  const [modelOverridden, setModelOverridden] = useState(false);
  const [modelUnavailable, setModelUnavailable] = useState<string | undefined>(undefined);
  const [modelUnavailableReason, setModelUnavailableReason] = useState<
    ModelUnavailableReason | undefined
  >(undefined);
  /** 选中的工作空间（EvoWork 的「空间」= 内核的 Project + cwd）。主进程负责翻成 cwd */
  const [workspaceId, setWorkspaceId] = useState<string | undefined>(undefined);
  const [view, setView] = useState<MainView>('task');
  /** 设置页的当前分区（11 §4.4）。「更多」菜单直接说要去哪个分区 */
  const [settingsSection, setSettingsSection] = useState<SettingsSection>('models');
  const [modelAccess, setModelAccess] = useState<ModelAccessView | null>(null);
  const [computerUse, setComputerUse] = useState<ComputerUseStatusView | null>(null);
  useEffect(() => bridge.onComputerUseStatus?.(setComputerUse), [bridge]);
  const [preferences, setPreferences] = useState<PreferencesView | null>(null);
  /** 上一次设置页动作被拒绝的原话，以及连通性检查的结论。**都要显示出来** */
  const [settingsRefusal, setSettingsRefusal] = useState<string | undefined>(undefined);
  const [probeResult, setProbeResult] = useState<string | undefined>(undefined);
  const [library, setLibrary] = useState<LibraryDataView | null>(null);
  const [automations, setAutomations] = useState<AutomationsDataView | null>(null);
  const [audit, setAudit] = useState<AuditDataView | null>(null);
  const [onboardingStep, setOnboardingStep] = useState<OnboardingStep>(
    ONBOARDING_STEPS[0] as OnboardingStep,
  );
  /**
   * 引导里已选的项目路径。
   *
   * 单独一份 state 而不是选完才等 `getStartup`：选完要立刻能点「下一步」，
   * 而为了看到刚选的目录重拉一次整个启动数据，中间那半秒按钮还是灰的 ——
   * 用户会以为没选上，再点一次。快照仍会在后台校正，供首页下拉使用。
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
  const [catalog, setCatalog] = useState<CatalogDataView | null>(null);
  const [catalogTab, setCatalogTab] = useState<CatalogTab>('skills');
  const [catalogRefusal, setCatalogRefusal] = useState<string | undefined>(undefined);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [libraryInitialNav, setLibraryInitialNav] = useState<LibraryNav>('recent');
  const [projectCreateOpen, setProjectCreateOpen] = useState(false);
  const [taskResults, setTaskResults] = useState<Readonly<Record<string, TaskResultsView>>>({});
  const [taskFiles, setTaskFiles] = useState<Readonly<Record<string, readonly DirEntryView[]>>>({});
  const [resultUi, setResultUi] = useState<
    Readonly<Record<string, { readonly open: boolean; readonly tab: ResultPane }>>
  >({});
  const [diffScope, setDiffScope] = useState<DiffScope>('thread');
  const [latestTurnByTask, setLatestTurnByTask] = useState<Readonly<Record<string, string>>>({});
  const [turnDiffByTask, setTurnDiffByTask] = useState<
    Readonly<Record<string, { readonly turnId: string; readonly diff: string }>>
  >({});
  const [attachments, setAttachments] = useState<readonly ComposerAttachmentView[]>([]);
  const [references, setReferences] = useState<readonly ComposerReferenceView[]>([]);
  const [composerContext, setComposerContext] = useState<ComposerContextView>({
    mentions: [],
    commands: [],
  });
  const [queuedByTask, setQueuedByTask] = useState<
    Readonly<Record<string, readonly QueuedInputView[]>>
  >({});
  const [goalsByTask, setGoalsByTask] = useState<
    Readonly<Record<string, TaskGoalView | undefined>>
  >({});
  const [subtasksByTask, setSubtasksByTask] = useState<
    Readonly<Record<string, readonly TaskRowView[]>>
  >({});
  const [focusItemId, setFocusItemId] = useState<string | undefined>(undefined);
  const [steer, setSteer] = useState(false);
  const [previewByTask, setPreviewByTask] = useState<Readonly<Record<string, FilePreviewView>>>({});
  const [selectedChangeByTask, setSelectedChangeByTask] = useState<
    Readonly<Record<string, string>>
  >({});
  const [resultDismissed, setResultDismissed] = useState<Readonly<Record<string, boolean>>>({});

  const dismissToast = useCallback((id: string) => {
    setToasts((previous) => previous.filter((toast) => toast.id !== id));
  }, []);

  const pushToast = useCallback((toast: Omit<ToastSpec, 'id'>): void => {
    toastCounter.current += 1;
    const withId: ToastSpec = { ...toast, id: `toast-${toastCounter.current}` };
    setToasts((previous) => [withId, ...previous]);
    if (shouldAutoDismiss(withId)) {
      window.setTimeout(() => {
        setToasts((previous) => previous.filter((item) => item.id !== withId.id));
      }, TOAST_AUTO_DISMISS_MS);
    }
  }, []);
  const reportFailure = useCallback(
    (error: unknown, fallback: string): void => {
      pushToast({ tone: 'danger', text: actionErrorText(error, fallback) });
    },
    [pushToast],
  );

  /**
   * 进入真正的「新任务」状态。
   *
   * 旧任务的历史读取错误、发送错误和任务级模型选择都不能泄漏到新任务首页；
   * 全局故障（例如网关降级、启动失败）仍然保留，因为换任务并不能解决它们。
   */
  const beginNewTask = useCallback(() => {
    setActiveTaskId(null);
    setDraft('');
    setReferences([]);
    setAttachments([]);
    setModelOverridden(false);
    setNotices((previous) => previous.filter((notice) => notice.scope !== 'task'));
    setFocusItemId(undefined);
    setSearchOpen(false);
    setView('task');
  }, []);

  useEffect(() => {
    const offs = [
      bridge.onUiEvent((event) => {
        if ('taskId' in event && deletedTaskIds.current.has(event.taskId)) return;
        if (event.type === 'task-goal-changed') {
          if (bridge.getTaskGoal) {
            void bridge
              .getTaskGoal({ threadId: event.taskId })
              .then((goal) =>
                setGoalsByTask((previous) => ({ ...previous, [event.taskId]: goal })),
              );
          }
          return;
        }
        if (event.type === 'task-removed') {
          deletedTaskIds.current.add(event.taskId);
          setTasks((previous) => previous.filter((task) => task.id !== event.taskId));
          setActiveTaskId((previous) => (previous === event.taskId ? null : previous));
          const remove = <T,>(previous: Readonly<Record<string, T>>) => {
            const next = { ...previous };
            delete next[event.taskId];
            return next;
          };
          setItemsByTask(remove);
          setTaskResults(remove);
          setTaskFiles(remove);
          setQueuedByTask(remove);
          setPreviewByTask(remove);
          setResultUi(remove);
          setResultDismissed(remove);
          setTurnFailures(remove);
          setLatestTurnByTask(remove);
          setTurnDiffByTask(remove);
          setApprovals((previous) =>
            previous.filter((approval) => approval.threadId !== event.taskId),
          );
          return;
        }
        if (event.type === 'task-created') {
          if (deletedTaskIds.current.has(event.task.id)) return;
          setTasks((prev) => {
            const existing = prev.find((task) => task.id === event.task.id);
            const task =
              existing?.title && !event.task.title
                ? { ...event.task, title: existing.title }
                : event.task;
            return [task, ...prev.filter((t) => t.id !== task.id)];
          });
          return;
        }
        if (event.type === 'turn-failed') {
          /*
           * 03 §8：模型不可用**不静默降级**。这里把内核给的原因原样显示 ——
           * 不改写、不归类：`connection refused` 与 `401` 对用户是完全不同的两件事，
           * 归成一句"模型调用失败"就等于把唯一的线索删掉了。
           */
          setTurnFailures((previous) => ({
            ...previous,
            [event.taskId]: {
              summary: event.details ? `${event.message}（${event.details}）` : event.message,
            },
          }));
          return;
        }
        if (event.type === 'turn-started' || event.type === 'turn-completed') {
          setLatestTurnByTask((previous) => ({
            ...previous,
            [event.taskId]: event.turnId,
          }));
          return;
        }
        if (event.type === 'turn-diff') {
          setTurnDiffByTask((previous) => ({
            ...previous,
            [event.taskId]: { turnId: event.turnId, diff: event.diff },
          }));
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
          if (event.status) {
            if (bridge.listQueuedInputs) {
              void bridge
                .listQueuedInputs({ threadId: event.taskId })
                .then((queued) =>
                  setQueuedByTask((previous) => ({ ...previous, [event.taskId]: queued })),
                );
            }
            if (event.status === 'running') {
              setTurnFailures((previous) => {
                const next = { ...previous };
                delete next[event.taskId];
                return next;
              });
            }
          }
          return;
        }
        if (event.type === 'task-results-updated') {
          /*
           * 产物 watcher 在回合进行中写表，而旧逻辑只在“切换任务”时读一次。
           * 结果是文件已经在磁盘上，右侧仍显示“还没有产物”，直到用户切走再切回。
           * 这里重读该任务的权威索引；后台任务也可以更新自己的缓存，不会抢当前页。
           */
          void bridge
            .getTaskResults({ threadId: event.taskId })
            .then((result) => {
              if (!deletedTaskIds.current.has(event.taskId))
                setTaskResults((previous) => ({ ...previous, [event.taskId]: result }));
            })
            .catch(() => undefined);
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
        if (event.type === 'skills-changed') {
          if (bridge.getComposerContext) {
            void bridge
              .getComposerContext({ ...(workspaceId ? { workspaceId } : {}) })
              .then((context) => {
                setComposerContext(context);
                const skillErrors = context.skillErrors;
                if (skillErrors?.length) {
                  setNotices((previous) => [
                    ...previous,
                    {
                      tone: 'warning',
                      text: `有 ${skillErrors.length} 个技能无法加载：${skillErrors[0]?.message ?? '格式无效'}`,
                    },
                  ]);
                }
              })
              .catch((error: unknown) => reportFailure(error, '没能刷新技能列表。'));
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
  }, [bridge, reportFailure, view, workspaceId]);

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

  /*
   * 项目列表变了就校正 Composer 的选中项：引导刚建的、侧栏新建的唯一项目，
   * 以及「在此项目新建任务」留下的选择。删掉当前项后若还剩一个，改选剩下那个。
   */
  useEffect(() => {
    const next = preferredWorkspaceId(startup?.workspaces ?? [], pickedWorkspaces, workspaceId);
    if (next !== workspaceId) setWorkspaceId(next);
  }, [startup, pickedWorkspaces, workspaceId]);

  /*
   * 全局快捷键只负责跨页面导航；文本输入自己的 Enter / Esc 仍由 Composer 处理。
   * `event.code === 'Backslash'` 避免不同键盘布局下 `event.key` 变成其他字符。
   */
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (!event.metaKey && !event.ctrlKey) return;
      if (event.shiftKey && event.key.toLowerCase() === 'o') {
        event.preventDefault();
        beginNewTask();
        return;
      }
      if (!event.shiftKey && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setSearchOpen(true);
        return;
      }
      if (!event.shiftKey && event.code === 'Backslash') {
        event.preventDefault();
        setSidebarCollapsed((collapsed) => !collapsed);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [beginNewTask]);

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
    setModelUnavailable(result.models.length > 0 ? undefined : result.unavailable);
    setModelUnavailableReason(result.models.length > 0 ? undefined : result.reason);
  }, []);

  /**
   * 设置页改完密钥 / 自定义模型后，Composer 必须用**同一份**目录。
   * 只写下拉、不把 `unavailable` 清掉，就是截图里那种：下拉里已经有模型，
   * 输入框上头还写着「本机网关没有启动」。
   *
   * 有可用模型时 danger 条必须消失（11 §13.4）：未登录但配了自定义模型 = 完全可用。
   */
  const applyAccessView = useCallback(
    (view: ModelAccessView) => {
      setModelAccess(view);
      applyCatalog({
        models: view.models,
        ...(view.catalogUnavailable !== undefined ? { unavailable: view.catalogUnavailable } : {}),
        ...(view.catalogReason !== undefined ? { reason: view.catalogReason } : {}),
      });
    },
    [applyCatalog],
  );

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
   * 选中项跟着「列表 + 场景偏好 + 用户已选」三者走。
   *
   * 用户自己选过的模型不在列表里时会换一个并**说出来** —— 见 `resolveModelChoice`。
   * 场景包里的型号不在目录里不算配错：第一个可用的模型就是这台机器上的默认。
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
    if (notice) setNotices((prev) => [...prev, { tone: 'warning', text: notice, scope: 'task' }]);
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
    const taskModel = rootTaskFor(tasks, activeTaskId)?.modelId;
    if (taskModel === undefined || taskModel === modelId) return;
    setModelId(taskModel);
    setModelOverridden(true);
    // tasks / modelId 不进依赖：这个 effect 只该在**切任务**时跑。
    // 把 tasks 加进去会让每一次流式更新（任务行随时在变）都重置一遍下拉
  }, [activeTaskId]);

  useEffect(() => {
    if (activeTaskId === null) return;
    const taskMode = rootTaskFor(tasks, activeTaskId)?.modeId;
    if (
      taskMode !== 'request-approval' &&
      taskMode !== 'approve-for-me' &&
      taskMode !== 'full-access'
    ) {
      return;
    }
    if (taskMode === mode) return;
    setMode(taskMode);
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
        if (cancelled || deletedTaskIds.current.has(threadId)) return;
        const latestTurnId =
          result.latestTurnId ??
          [...result.items].reverse().find((item) => typeof item._turnId === 'string')?._turnId;
        if (typeof latestTurnId === 'string') {
          setLatestTurnByTask((previous) => ({ ...previous, [threadId]: latestTurnId }));
        }
        setItemsByTask((prev) => ({
          ...prev,
          [threadId]: applyHistory(prev[threadId] ?? [], result.items as readonly RenderItem[]),
        }));
        setTurnFailures((previous) => {
          const next = { ...previous };
          if (result.turnFailure) {
            next[threadId] = {
              summary: result.turnFailure.details
                ? `${result.turnFailure.message}（${result.turnFailure.details}）`
                : result.turnFailure.message,
            };
          } else delete next[threadId];
          return next;
        });
        const incomplete = result.incomplete;
        if (incomplete) {
          setNotices((prev) => [...prev, { tone: 'warning', text: incomplete, scope: 'task' }]);
        }
      })
      .catch((err: unknown) => {
        if (cancelled || deletedTaskIds.current.has(threadId)) return;
        setNotices((prev) => [
          ...prev,
          {
            tone: 'warning',
            text: `读不到这个任务的历史：${err instanceof Error ? err.message : String(err)}`,
            scope: 'task',
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

  /** 任务切换时同步它所属的项目、补全候选与排队追问。 */
  useEffect(() => {
    const cwd =
      activeTaskId === null ? undefined : tasks.find((task) => task.id === activeTaskId)?.cwd;
    const taskWorkspace = startup?.workspaces.find((workspace) => workspace.path === cwd);
    if (taskWorkspace) setWorkspaceId(taskWorkspace.id);
    const contextWorkspaceId = taskWorkspace?.id ?? workspaceId;
    if (bridge.getComposerContext) {
      void bridge
        .getComposerContext({ ...(contextWorkspaceId ? { workspaceId: contextWorkspaceId } : {}) })
        .then(setComposerContext)
        .catch(() => setComposerContext({ mentions: [], commands: [] }));
    }
    if (activeTaskId !== null && bridge.listQueuedInputs) {
      const threadId = rootTaskFor(tasks, activeTaskId)?.id ?? activeTaskId;
      void bridge
        .listQueuedInputs({ threadId })
        .then((queued) =>
          setQueuedByTask((previous) =>
            deletedTaskIds.current.has(threadId) ? previous : { ...previous, [threadId]: queued },
          ),
        );
    }
    if (activeTaskId !== null && bridge.getTaskGoal) {
      const threadId = activeTaskId;
      void bridge.getTaskGoal({ threadId }).then((goal) => {
        if (!deletedTaskIds.current.has(threadId))
          setGoalsByTask((previous) => ({ ...previous, [threadId]: goal }));
      });
    }
  }, [activeTaskId, bridge, startup, tasks, workspaceId]);

  useEffect(() => {
    if (activeTaskId === null || !bridge.listSubtasks) return;
    const threadId = activeTaskId;
    void bridge
      .listSubtasks({ threadId })
      .then((subtasks) => setSubtasksByTask((previous) => ({ ...previous, [threadId]: subtasks })))
      .catch((error: unknown) => reportFailure(error, '没能读取子任务。'));
  }, [activeTaskId, bridge, reportFailure]);

  /** 结果区数据按任务读取；产物来自索引，文件来自该任务所属项目的根目录。 */
  useEffect(() => {
    if (activeTaskId === null) return;
    const threadId = activeTaskId;
    void bridge
      .getTaskResults({ threadId })
      .then((result) =>
        setTaskResults((prev) =>
          deletedTaskIds.current.has(threadId) ? prev : { ...prev, [threadId]: result },
        ),
      )
      .catch(() =>
        setTaskResults((prev) =>
          deletedTaskIds.current.has(threadId) ? prev : { ...prev, [threadId]: { artifacts: [] } },
        ),
      );

    const cwd = tasks.find((task) => task.id === threadId)?.cwd;
    const project = startup?.workspaces.find((workspace) => workspace.path === cwd);
    if (!project) {
      setTaskFiles((prev) =>
        deletedTaskIds.current.has(threadId) ? prev : { ...prev, [threadId]: [] },
      );
      return;
    }
    void bridge
      .listProjectDir({ id: project.id })
      .then((entries) =>
        setTaskFiles((prev) =>
          deletedTaskIds.current.has(threadId) ? prev : { ...prev, [threadId]: entries },
        ),
      )
      .catch(() =>
        setTaskFiles((prev) =>
          deletedTaskIds.current.has(threadId) ? prev : { ...prev, [threadId]: [] },
        ),
      );
  }, [activeTaskId, bridge, startup, tasks]);

  /** 有产物就展开结果区；用户关过一次就尊重其选择。 */
  useEffect(() => {
    if (activeTaskId === null || resultDismissed[activeTaskId]) return;
    const result = taskResults[activeTaskId];
    if (!result || result.artifacts.length === 0) return;
    const latest = result.artifacts[0];
    if (!latest) return;
    setResultUi((previous) => {
      const current = previous[activeTaskId];
      if (current?.open === true) return previous;
      return {
        ...previous,
        [activeTaskId]: { open: true, tab: current?.tab ?? 'artifacts' },
      };
    });
    if (!shouldAutoOpenResult(itemsByTask[activeTaskId] ?? []) || !bridge.readResultPreview) return;
    void bridge
      .readResultPreview({ artifactId: latest.id })
      .then((preview) => {
        setPreviewByTask((previous) => ({ ...previous, [activeTaskId]: preview }));
        setResultUi((previous) => ({
          ...previous,
          [activeTaskId]: {
            open: true,
            tab: preview.kind === 'html' ? 'browser' : (previous[activeTaskId]?.tab ?? 'artifacts'),
          },
        }));
      })
      .catch(() => undefined);
  }, [activeTaskId, bridge, itemsByTask, resultDismissed, taskResults]);

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
    if (view === 'catalog')
      void bridge
        .getCatalog()
        .then(setCatalog)
        .catch(() => setCatalog(null));
    if (view === 'settings') {
      void bridge
        .getComputerUseStatus?.()
        .then(setComputerUse)
        .catch(() => setComputerUse(null));
      /*
       * 设置页也是每次进都重拉：密钥可能刚在「添加模型」里填过、企业策略包可能刚更新过。
       * `getModelAccess` 顺带读一次网关目录，所以它会花几百毫秒 ——
       * 这就是它不并进 `getStartup` 的理由（同 `listModels`）。
       */
      void bridge
        .getModelAccess()
        .then((result) => {
          applyAccessView(result.view);
          setSettingsRefusal(result.refused);
        })
        .catch(() => setModelAccess(null));
      void bridge
        .getPreferences()
        .then(setPreferences)
        .catch(() => setPreferences(null));
    }
  }, [view, activeProjectId, bridge, applyAccessView]);

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
  const applyMutation = useCallback(
    (result: ProjectMutationResult) => {
      setProjects({ projects: result.projects });
      setProjectRefusal(result.refused);
      if (result.ok) {
        /*
         * 项目页卡片吃 mutation 返回值，侧栏/Composer 则吃 startup.workspaces。
         * 成功后只把后者的工作空间快照校正回来；不重拉 listProjects，避免旧响应
         * 反超刚完成的 mutation，也避免“创建成功但左侧仍没有”的假完成。
         */
        void bridge
          .getStartup()
          .then((info) =>
            setStartup((previous) =>
              previous === null ? info : { ...previous, workspaces: info.workspaces },
            ),
          )
          .catch(() => undefined);
      }
      pushToast(
        result.ok
          ? { tone: 'success', text: '项目已更新。' }
          : { tone: 'danger', text: result.refused ?? '项目操作没有完成。' },
      );
    },
    [bridge, pushToast],
  );

  const createProject = useCallback(
    (input: { name: string; path: string }) => {
      void bridge
        .createProject(input)
        .then(applyMutation)
        .catch((error: unknown) => reportFailure(error, '项目没有创建。'));
    },
    [bridge, applyMutation, reportFailure],
  );

  const importProject = useCallback(() => {
    void bridge
      .importProject()
      .then(applyMutation)
      .catch((error: unknown) => reportFailure(error, '项目没有导入。'));
  }, [bridge, applyMutation, reportFailure]);

  const searchTasks = useCallback(
    (query: string) => bridge.searchTasks?.({ query }) ?? Promise.resolve([]),
    [bridge],
  );

  const renameProject = useCallback(
    (input: { id: string; name: string }) => {
      void bridge
        .renameProject(input)
        .then(applyMutation)
        .catch((error: unknown) => reportFailure(error, '项目没有改名。'));
    },
    [bridge, applyMutation, reportFailure],
  );

  const removeProject = useCallback(
    (id: string) => {
      void bridge
        .removeProject({ id })
        .then(applyMutation)
        .catch((error: unknown) => reportFailure(error, '项目没有移除。'));
    },
    [bridge, applyMutation, reportFailure],
  );

  const openProjectFolder = useCallback(
    (id: string) => {
      void bridge
        .openProjectFolder({ id })
        .catch((error: unknown) => reportFailure(error, '打不开这个文件夹。'));
    },
    [bridge, reportFailure],
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
    try {
      const result = await bridge.pickProjectDirectory();
      if (result.refused) {
        setProjectRefusal(result.refused);
        return undefined;
      }
      return result.path;
    } catch (error: unknown) {
      reportFailure(error, '没能选择目录。');
      return undefined;
    }
  }, [bridge, reportFailure]);

  /** 技能「从目录安装」复用同一个选择框，拒绝理由要落在目录页，不落到项目页。 */
  const pickCatalogDirectory = useCallback(async () => {
    try {
      const result = await bridge.pickProjectDirectory();
      if (result.refused) {
        setCatalogRefusal(result.refused);
        return undefined;
      }
      return result.path;
    } catch (error: unknown) {
      reportFailure(error, '没能选择目录。');
      return undefined;
    }
  }, [bridge, reportFailure]);

  /**
   * 02 §4.3：跳首页并**预选该工作空间**。
   * 首页下拉在 Task 9 之后读的就是 `project_local`，所以这里只是选中一个已有项，
   * 不新增任何机制。
   */
  const newTaskInProject = useCallback(
    (id: string) => {
      setWorkspaceId(id);
      setActiveProjectId(null);
      beginNewTask();
    },
    [beginNewTask],
  );

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
   * 包了 try/catch，正常不会走到这里；但 IPC 本身仍可能失败，不接住就是点了没反应。
   */
  const saveProjectMemo = useCallback(
    (content: string): Promise<WriteAgentsMemoResult> => {
      if (activeProjectId === null) return Promise.resolve({ ok: false });
      const id = activeProjectId;
      return bridge
        .writeAgentsMemo({ id, content })
        .then((result) => {
          if (result.ok) {
            setProjectMemo({ exists: true, content });
            pushToast({ tone: 'success', text: '项目说明已保存。' });
          } else {
            pushToast({ tone: 'danger', text: result.refused ?? '项目说明没有保存。' });
          }
          return result;
        })
        .catch((): WriteAgentsMemoResult => {
          pushToast({ tone: 'danger', text: '没能保存项目说明，稍后再试。' });
          return {
            ok: false,
            refused: '没能保存项目说明，稍后再试。',
          };
        });
    },
    [activeProjectId, bridge, pushToast],
  );

  const active = tasks.find((task) => task.id === activeTaskId);
  const activeRoot = rootTaskFor(tasks, activeTaskId);
  const interactionTaskId = activeRoot?.id ?? activeTaskId;
  const isSubagent = Boolean(active?.parentThreadId);
  // 运行态必须来自当前任务。后台自动化或另一个任务的状态事件不能把当前 Composer
  // 误切成“停止/插话”模式。
  const running = activeRoot?.status === 'running' || activeRoot?.status === 'pending';

  const send = useCallback(async () => {
    const text = draft.trim();
    const attachmentReferences = attachments.flatMap((attachment) => attachment.references);
    const outgoingReferences = [...references, ...attachmentReferences];
    if (!text && outgoingReferences.length === 0) return;
    setDraft('');
    try {
      const { threadId } = await bridge.send({
        ...(activeTaskId ? { threadId: activeTaskId } : {}),
        text,
        scenarioId,
        // 手选的模型跟着这一条消息走（03 §2.4：用户显式选择优先级最高）。
        // 主进程同时把它写进任务级设置，否则下一轮又回落到场景默认值
        ...(modelId !== undefined ? { modelId } : {}),
        ...(mode !== undefined ? { modeId: mode } : {}),
        // 任务在哪个目录里跑。id → path 的翻译在主进程（渲染层不持有绝对路径）
        ...(workspaceId !== undefined ? { workspaceId } : {}),
        ...(outgoingReferences.length > 0 ? { references: outgoingReferences } : {}),
        ...(running ? { steer } : {}),
      });
      setActiveTaskId(threadId);
      setAttachments([]);
      setReferences([]);
      if (bridge.listQueuedInputs) {
        const queue = await bridge.listQueuedInputs({ threadId });
        setQueuedByTask((previous) => ({ ...previous, [threadId]: queue }));
      }
    } catch (err: unknown) {
      // 发送失败要把草稿还回去 —— 清空输入框又什么都没发生，用户会以为消息丢了
      setDraft(text);
      setNotices((prev) => [
        ...prev,
        {
          tone: 'danger',
          text: `没能发出去：${err instanceof Error ? err.message : String(err)}`,
          scope: 'task',
        },
      ]);
    }
  }, [
    bridge,
    draft,
    attachments,
    references,
    activeTaskId,
    scenarioId,
    modelId,
    mode,
    workspaceId,
    running,
    steer,
  ]);

  const changeMode = useCallback(
    (nextMode: ModeId) => {
      const previousMode = mode;
      setMode(nextMode);
      if (interactionTaskId === null) return;
      const threadId = interactionTaskId;
      void bridge.setTaskMode({ threadId, modeId: nextMode }).catch((error: unknown) => {
        // 只回滚这一次失败的选择；若用户已经又切了一档，不覆盖他更新的决定。
        setMode((current) => (current === nextMode ? previousMode : current));
        reportFailure(error, '没能切换审批档。');
      });
    },
    [bridge, interactionTaskId, mode, reportFailure],
  );

  const retryCurrentTurn = useCallback(async () => {
    if (activeTaskId === null) return;
    const request = lastUserMessageRequest(itemsByTask[activeTaskId] ?? []);
    if (!request) {
      pushToast({
        tone: 'warning',
        text: '上一条需求含当前无法安全重放的输入，请在输入框里确认后重新发送。',
      });
      return;
    }
    setTurnFailures((previous) => {
      const next = { ...previous };
      delete next[activeTaskId];
      return next;
    });
    try {
      await bridge.send({
        threadId: activeTaskId,
        text: request.text,
        ...(request.references.length > 0 ? { references: request.references } : {}),
        scenarioId,
        ...(modelId !== undefined ? { modelId } : {}),
        ...(mode !== undefined ? { modeId: mode } : {}),
        ...(workspaceId !== undefined ? { workspaceId } : {}),
      });
    } catch (error: unknown) {
      const summary = error instanceof Error ? error.message : String(error);
      setTurnFailures((previous) => ({ ...previous, [activeTaskId]: { summary } }));
    }
  }, [activeTaskId, bridge, itemsByTask, modelId, mode, pushToast, scenarioId, workspaceId]);

  const prepareTaskWithText = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      beginNewTask();
      setDraft(trimmed);
    },
    [beginNewTask],
  );

  const applyCatalogResult = useCallback(
    (result: CatalogMutationResult): CatalogMutationResult => {
      setCatalog(result.catalog);
      setCatalogRefusal(result.refused);
      pushToast(
        result.ok
          ? { tone: 'success', text: '插件设置已更新。' }
          : { tone: 'danger', text: result.refused ?? '插件操作没有完成。' },
      );
      return result;
    },
    [pushToast],
  );
  const emptyCatalogView = useMemo(
    (): CatalogDataView => ({ skills: [], connectors: [], experts: [], apps: [] }),
    [],
  );
  const runCatalogMutation = useCallback(
    async (run: () => Promise<CatalogMutationResult>): Promise<CatalogMutationResult> => {
      try {
        return applyCatalogResult(await run());
      } catch (error: unknown) {
        return applyCatalogResult({
          ok: false,
          refused: actionErrorText(error, '插件操作没有完成。'),
          catalog: catalog ?? emptyCatalogView,
        });
      }
    },
    [applyCatalogResult, catalog, emptyCatalogView],
  );

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

  const currentItems = activeTaskId === null ? [] : (itemsByTask[activeTaskId] ?? []);
  const currentResults =
    activeTaskId === null ? { artifacts: [] } : (taskResults[activeTaskId] ?? { artifacts: [] });
  const currentFiles = activeTaskId === null ? [] : (taskFiles[activeTaskId] ?? []);
  const currentPreview = activeTaskId === null ? undefined : previewByTask[activeTaskId];
  const activeProject = startup?.workspaces.find((workspace) => workspace.path === active?.cwd);
  const reasoningAvailable =
    models
      .find((model) => model.id === modelId)
      ?.capabilities.find((capability) => capability.id === 'reasoning')?.available ?? true;
  const currentTurnId = activeTaskId === null ? undefined : latestTurnByTask[activeTaskId];
  const currentTurnDiff = activeTaskId === null ? undefined : turnDiffByTask[activeTaskId];
  const changedFiles = useMemo(
    () =>
      changedFilesFromItems(
        currentItems,
        diffScope === 'turn' ? currentTurnId : undefined,
        diffScope === 'turn' && currentTurnDiff?.turnId === currentTurnId
          ? currentTurnDiff?.diff
          : undefined,
      ),
    [currentItems, currentTurnDiff, currentTurnId, diffScope],
  );
  // 项目目录里的既有文件只是「文件」Tab 可浏览的数据，不是当前任务的结果信号。
  // 否则一发送消息、任务进入 processing，目录读取完成就会把结果区提前撑开。
  // 只有任务产物索引或本轮 FileChange 才能证明这次确实产生/修改了文件。
  const hasCurrentResults = currentResults.artifacts.length > 0 || changedFiles.length > 0;
  const activeResultUi =
    activeTaskId === null
      ? { open: false, tab: 'artifacts' as ResultPane }
      : (resultUi[activeTaskId] ?? {
          open: hasCurrentResults,
          tab: 'artifacts' as ResultPane,
        });
  const updateResultUi = useCallback(
    (patch: Partial<{ open: boolean; tab: ResultPane }>) => {
      if (activeTaskId === null) return;
      setResultUi((prev) => ({
        ...prev,
        [activeTaskId]: { ...activeResultUi, ...patch },
      }));
    },
    [activeTaskId, activeResultUi],
  );
  const rollbackCurrentTurn = useCallback(async () => {
    if (activeTaskId === null || currentTurnId === undefined || !bridge.revertTask) return;
    const threadId = activeTaskId;
    const beforeTurnId = currentTurnId;
    const first = currentItems.findIndex((item) => item._turnId === beforeTurnId);
    const retained = first < 0 ? currentItems : currentItems.slice(0, first);
    const previousTurnId = [...retained]
      .reverse()
      .find((item) => typeof item._turnId === 'string')?._turnId;
    try {
      await bridge.revertTask({ threadId, beforeTurnId });
      setItemsByTask((previous) => ({ ...previous, [threadId]: retained }));
      setLatestTurnByTask((previous) => {
        const next = { ...previous };
        if (typeof previousTurnId === 'string') next[threadId] = previousTurnId;
        else delete next[threadId];
        return next;
      });
      setTurnDiffByTask((previous) => {
        const next = { ...previous };
        delete next[threadId];
        return next;
      });
      setTurnFailures((previous) => {
        const next = { ...previous };
        delete next[threadId];
        return next;
      });
      pushToast({ tone: 'success', text: '对话已回滚；磁盘文件没有改动。' });
    } catch (error: unknown) {
      reportFailure(error, '没能回滚这个回合。');
    }
  }, [activeTaskId, bridge, currentItems, currentTurnId, pushToast, reportFailure]);

  const showPreview = useCallback(
    async (load: () => Promise<FilePreviewView>, pane: ResultPane = 'artifacts') => {
      if (activeTaskId === null) return;
      try {
        const preview = await load();
        setPreviewByTask((previous) => ({ ...previous, [activeTaskId]: preview }));
        updateResultUi({ open: true, tab: preview.kind === 'html' ? 'browser' : pane });
      } catch (error: unknown) {
        pushToast({
          tone: 'danger',
          text: `读不到预览：${error instanceof Error ? error.message : String(error)}`,
        });
      }
    },
    [activeTaskId, pushToast, updateResultUi],
  );
  const openArtifact = useCallback(
    (id: string) => {
      if (bridge.readResultPreview)
        void showPreview(() => bridge.readResultPreview!({ artifactId: id }));
      else
        void bridge
          .openResultFile({ artifactId: id })
          .catch((error: unknown) => reportFailure(error, '打不开这个产物。'));
    },
    [bridge, reportFailure, showPreview],
  );
  const openChangedFile = useCallback(
    (path: string, kind: string) => {
      if (activeTaskId === null) return;
      const threadId = activeTaskId;
      if (kind !== 'add' || !bridge.readTaskFilePreview) {
        setSelectedChangeByTask((previous) => ({ ...previous, [threadId]: path }));
        updateResultUi({ open: true, tab: 'changes' });
        return;
      }
      void showPreview(() => bridge.readTaskFilePreview!({ threadId, path }), 'files');
    },
    [activeTaskId, bridge, showPreview, updateResultUi],
  );
  const annotatePreview = useCallback((annotation: FileAnnotationView) => {
    const region = annotation.region
      ? [
          annotation.region.page === undefined ? '' : `第 ${annotation.region.page} 页`,
          `区域 x=${annotation.region.x}%, y=${annotation.region.y}%, 宽=${annotation.region.width}%, 高=${annotation.region.height}%`,
        ]
          .filter(Boolean)
          .join('，')
      : '';
    const block = [
      `针对文件「${annotation.fileName}」的批注：`,
      annotation.quote ? `> ${annotation.quote.replace(/\n/g, '\n> ')}` : '',
      region,
      annotation.comment,
    ]
      .filter(Boolean)
      .join('\n\n');
    setDraft((previous) => (previous.trim() ? `${previous}\n\n${block}` : block));
  }, []);
  const changeDraft = useCallback(
    (next: string) => {
      setDraft(next);
      setReferences((previous) =>
        reconcileComposerReferences(next, previous, composerContext.mentions),
      );
    },
    [composerContext.mentions],
  );
  const composer = useMemo(
    () => ({
      onSend: () => void send(),
      runState: (running ? 'running' : 'idle') as 'running' | 'idle',
      onInterrupt: () => {
        if (!interactionTaskId) return;
        void bridge
          .interrupt(interactionTaskId)
          .catch((error: unknown) => reportFailure(error, '没能停下。'));
      },
      attachments: attachments as readonly Attachment[],
      onAttach: bridge.pickAttachments
        ? () => {
            /*
             * 失败必须说出来。以前 `void` 掉 rejection，未选项目时主进程抛错、
             * 选择器根本打不开，表现就是「点了添加本地文件没反应」。
             */
            void bridge
              .pickAttachments?.({
                ...(workspaceId ? { workspaceId } : {}),
                ...(interactionTaskId ? { threadId: interactionTaskId } : {}),
              })
              .then((picked) => {
                if (picked.length === 0) return;
                setAttachments((previous) => [...previous, ...picked]);
              })
              .catch((error: unknown) => reportFailure(error, '没能添加本地文件。'));
          }
        : undefined,
      onFilesAdded: bridge.ingestAttachments
        ? (files: readonly File[]) => {
            void Promise.all(
              files.map(async (file) => ({
                name: file.name,
                bytes: new Uint8Array(await file.arrayBuffer()),
              })),
            )
              .then((payload) =>
                bridge.ingestAttachments?.({
                  ...(workspaceId ? { workspaceId } : {}),
                  ...(interactionTaskId ? { threadId: interactionTaskId } : {}),
                  files: payload,
                }),
              )
              .then((picked) => {
                if (picked?.length) setAttachments((previous) => [...previous, ...picked]);
              })
              .catch((error: unknown) => reportFailure(error, '没能添加拖入的文件。'));
          }
        : undefined,
      onRemoveAttachment: (id: string) =>
        setAttachments((previous) => previous.filter((attachment) => attachment.id !== id)),
      onReferAsRaw: (id: string) =>
        setAttachments((previous) =>
          previous.map((attachment) =>
            attachment.id === id && attachment.rawReference
              ? { ...attachment, state: 'ready', references: [attachment.rawReference] }
              : attachment,
          ),
        ),
      mentionCandidates: composerContext.mentions as readonly MentionCandidate[],
      onSearchMentions: bridge.searchComposerMentions
        ? (query: string) =>
            bridge.searchComposerMentions!({
              query,
              ...(workspaceId ? { workspaceId } : {}),
            }) as Promise<readonly MentionCandidate[]>
        : undefined,
      slashCommands: composerContext.commands as readonly SlashCommand[],
      onInsertReference: (candidate: MentionCandidate) => {
        if (!candidate.path) return;
        const reference: ComposerReferenceView =
          candidate.insertAs === 'skill'
            ? { type: 'skill', name: candidate.name ?? candidate.label, path: candidate.path }
            : { type: 'mention', name: candidate.label, path: candidate.path };
        setReferences((previous) => [
          ...previous.filter(
            (existing) => !('path' in existing) || existing.path !== candidate.path,
          ),
          reference,
        ]);
      },
      onRunSkillCommand: (id: string) => {
        const candidate = composerContext.mentions.find(
          (mention) => mention.insertAs === 'skill' && mention.id === id,
        );
        if (candidate)
          setReferences((previous) => [
            ...previous,
            { type: 'skill', name: candidate.name ?? candidate.label, path: candidate.path },
          ]);
      },
      onRunLocalCommand: (id: string) => {
        if (id === 'clear') {
          setDraft('');
          setReferences([]);
        }
        if (id === 'new-task') beginNewTask();
      },
      queued: interactionTaskId ? (queuedByTask[interactionTaskId] ?? []) : [],
      onQueueRemove: (id: string) => {
        if (!interactionTaskId || !bridge.removeQueuedInput) return;
        void bridge
          .removeQueuedInput({ threadId: interactionTaskId, id })
          .then((removed) => {
            if (removed)
              setQueuedByTask((previous) => ({
                ...previous,
                [interactionTaskId]: (previous[interactionTaskId] ?? []).filter(
                  (item) => item.id !== id,
                ),
              }));
          })
          .catch((error: unknown) => reportFailure(error, '没能从队列里移除。'));
      },
      onQueueUpdate: bridge.updateQueuedInput
        ? (id: string, text: string) => {
            if (!interactionTaskId) return;
            const threadId = interactionTaskId;
            const queuedReferences = (queuedByTask[threadId] ?? []).find(
              (item) => item.id === id,
            )?.references;
            void bridge
              .updateQueuedInput?.({
                threadId,
                id,
                text,
                ...(queuedReferences ? { references: queuedReferences } : {}),
              })
              .then((updated) => {
                if (updated)
                  setQueuedByTask((previous) => ({
                    ...previous,
                    [threadId]: (previous[threadId] ?? []).map((item) =>
                      item.id === id ? { ...item, text } : item,
                    ),
                  }));
              })
              .catch((error: unknown) => reportFailure(error, '没能更新排队项。'));
          }
        : undefined,
      onQueueMove: bridge.reorderQueuedInputs
        ? (id: string, direction: -1 | 1) => {
            if (!interactionTaskId) return;
            const threadId = interactionTaskId;
            const queue = [...(queuedByTask[threadId] ?? [])];
            const from = queue.findIndex((item) => item.id === id);
            const to = from + direction;
            if (from < 0 || to < 0 || to >= queue.length) return;
            const [moved] = queue.splice(from, 1);
            if (!moved) return;
            queue.splice(to, 0, moved);
            void bridge
              .reorderQueuedInputs?.({ threadId, ids: queue.map((item) => item.id) })
              .then((reordered) => {
                if (reordered) setQueuedByTask((previous) => ({ ...previous, [threadId]: queue }));
              })
              .catch((error: unknown) => reportFailure(error, '没能调整队列顺序。'));
          }
        : undefined,
      steer,
      onSteerChange: setSteer,
      workspaces,
      workspaceId,
      onWorkspaceChange: setWorkspaceId,
      permissions,
      permissionId,
      onPermissionChange: setPermissionId,
      mode,
      onModeChange: changeMode,
      modeOptions: composerModeOptions({
        approvalsReviewerAvailable: startup?.approvalsReviewerAvailable,
        fullAccessAllowed: startup?.fullAccessAllowed,
        fullAccessDisabledReason: startup?.fullAccessDisabledReason,
      }),
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
      onOpenLibrary: () => setView('library'),
      plugins: catalog?.apps,
      onUsePlugin: (plugin: ComposerPlugin, prompt: string) => {
        if (plugin.kind === 'skill') {
          const internalName = plugin.id.replace(/^skill:/, '');
          const candidate = composerContext.mentions.find(
            (mention) => mention.category === 'skill' && mention.name === internalName,
          );
          if (!candidate) {
            pushToast({
              tone: 'danger',
              text: `技能「${plugin.displayName}」尚未被内核加载，请检查技能格式。`,
            });
            return;
          }
          beginNewTask();
          setDraft(`$${candidate.label} ${prompt}`.trim());
          setReferences([
            {
              type: 'skill',
              name: candidate.name ?? internalName,
              path: candidate.path,
            },
          ]);
          return;
        }
        const connectorId = plugin.id.replace(/^connector:/, '');
        beginNewTask();
        setDraft(`@${plugin.displayName} ${prompt}`.trim());
        setReferences([
          { type: 'mention', name: plugin.displayName, path: `mcp://${connectorId}` },
        ]);
      },
      onOpenPlugins: () => {
        void bridge
          .getCatalog()
          .then(setCatalog)
          .catch(() => setCatalog((current) => current ?? emptyCatalogView));
      },
      onManagePlugins: () => {
        setCatalogTab('skills');
        setView('catalog');
      },
      ...(modelAccess?.policyPack?.status === 'expired' && modelAccess.policyPack.message
        ? { sendLockedReason: modelAccess.policyPack.message }
        : {}),
      /*
       * 03 §8：模型不可用 → danger 条 + 禁用发送，**不换一个模型继续**。
       * 没配模型：下一动作是去设置页添加，再 fetch 一次解决不了。
       * 网关暂时没起来：下一动作是「检查模型接入」重新拉列表。
       */
      ...(modelUnavailable !== undefined
        ? {
            modelUnavailable: {
              text: modelUnavailable,
              ...(modelUnavailableReason !== undefined ? { reason: modelUnavailableReason } : {}),
              ...(modelUnavailableReason === 'no-keys'
                ? {
                    onFix: (): void => {
                      setSettingsSection('models');
                      setView('settings');
                    },
                    fixLabel: '去设置添加模型',
                  }
                : {
                    onFix: (): void => {
                      void loadModels();
                    },
                  }),
            },
          }
        : {}),
    }),
    [
      send,
      running,
      activeTaskId,
      interactionTaskId,
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
      modelUnavailableReason,
      modelAccess,
      attachments,
      composerContext,
      queuedByTask,
      steer,
      workspaceId,
      reportFailure,
      startup,
      changeMode,
      catalog,
      prepareTaskWithText,
      emptyCatalogView,
    ],
  );

  /*
   * 首次引导（02 §9）。**盖住整个界面** —— 它要拿到项目目录的答案，
   * 这件事决定后面每个任务在哪跑。走完落 `meta` 表，不再出现。
   * 权限档位暂时不在这里问：选了也不会进 `turn/start`。
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
           * **这一步是硬门槛**：`blockingReason` 要求至少一个项目，
           * 而干净机器上内核一个 project 都没有。不接这个回调的话，
           * 「下一步」永远是灰的 —— 整个应用打不开（2026-09-06 实测撞到）。
           */
          onPickWorkspace={() => {
            void bridge
              .pickWorkspace()
              .then((r) => {
                if (r.path) {
                  setPickedWorkspaces((prev) => [...new Set([...prev, r.path as string])]);
                  /*
                   * 选完立刻校正侧栏/Composer 用的快照，不等走完引导。
                   * 「下一步」仍由 `pickedWorkspaces` 点亮，不把按钮灰着等到这次往返。
                   */
                  void bridge
                    .getStartup()
                    .then((info) =>
                      setStartup((previous) =>
                        previous === null ? info : { ...previous, workspaces: info.workspaces },
                      ),
                    )
                    .catch(() => undefined);
                  return;
                }
                /*
                 * 只有"被拒"才提示，取消不提示（`r.refused` 是 undefined 时什么都不做）——
                 * 这正是本条修复要的区分：拒绝要如实说，取消不需要多此一举打扰用户。
                 */
                if (r.refused)
                  setNotices((prev) => [...prev, { tone: 'warning', text: r.refused as string }]);
              })
              .catch((error: unknown) => {
                setNotices((prev) => [
                  ...prev,
                  { tone: 'danger', text: actionErrorText(error, '没能选择目录。') },
                ]);
              });
          }}
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
            void bridge
              .completeOnboarding()
              .then(async () => {
                try {
                  const info = await bridge.getStartup();
                  setStartup(info);
                } catch {
                  setStartup((prev) => (prev ? { ...prev, onboarded: true } : prev));
                }
              })
              .catch((error: unknown) => {
                setNotices((prev) => [
                  ...prev,
                  { tone: 'danger', text: actionErrorText(error, '没能完成引导。') },
                ]);
              });
          }}
        />
      </div>
    );
  }

  return (
    <div className="ew-app">
      {sidebarCollapsed ? (
        <div className="ew-sidebar-restore">
          <IconButton
            label="展开侧边栏"
            icon={renderIcon('panel-left')}
            onClick={() => setSidebarCollapsed(false)}
          />
        </div>
      ) : (
        <Sidebar
          tasks={tasks}
          sections={[]}
          selectedId={view === 'task' ? (activeTaskId ?? undefined) : undefined}
          activeNavId={navIdForView(view, activeTaskId)}
          onSelect={(id) => {
            setActiveTaskId(id);
            setView('task');
          }}
          onNewTask={beginNewTask}
          projects={(startup?.workspaces ?? []).map((project) => ({
            id: project.id,
            name: project.name,
            path: project.path,
            rootMissing: project.rootMissing,
          }))}
          selectedProjectId={view === 'projects' ? (activeProjectId ?? undefined) : undefined}
          onProjectSelect={(id) => {
            setActiveProjectId(id);
            setView('projects');
          }}
          onProjectCreate={() => setProjectCreateOpen(true)}
          onProjectImport={importProject}
          onNavSelect={(id) => {
            if (id === 'library') setLibraryInitialNav('recent');
            setView(NAV_TO_VIEW[id] ?? 'task');
          }}
          /*
           * 「更多」是一个菜单（02 §4.7），它的项直接落到设置页的某个分区 ——
           * `settings:models` 这种形式让菜单自己说出要去哪儿，少一处 id → 分区的映射。
           */
          onMoreSelect={(id) => {
            if (id === 'audit') {
              setView('audit');
              return;
            }
            const [page, section] = id.split(':');
            if (page === 'settings') {
              setSettingsSection((section ?? 'models') as SettingsSection);
              setView('settings');
            }
          }}
          onRowAction={(action, id) => {
            void bridge
              .rowAction({ action, threadId: id })
              .then(() => {
                setTasks((previous) => previous.filter((task) => task.id !== id));
                if (activeTaskId === id) setActiveTaskId(null);
              })
              .catch((error: unknown) =>
                reportFailure(
                  error,
                  action === 'delete' ? '没能删除这个任务。' : '没能归档这个任务。',
                ),
              );
          }}
          /*
           * 改名先落到本地列表再发请求：内核会回一条 `thread/name/updated`，
           * 但那要一次往返。等它的话用户会看到自己刚改的名字"没反应"。
           * 请求失败时下一次 `thread/list` 校正会把它改回去（04 §3.4 第②步）。
           */
          onRenameTask={(id, name) => {
            setTasks((previous) =>
              previous.map((task) => (task.id === id ? { ...task, title: name } : task)),
            );
            void bridge
              .renameTask?.({ threadId: id, name })
              .catch((error: unknown) => reportFailure(error, '没能改名。'));
          }}
          onVisibleChange={(ids) => void bridge.refreshVisible(ids)}
          onToggleCollapse={() => setSidebarCollapsed(true)}
          searchOpen={false}
          onSearchOpenChange={(open) => {
            if (open) setSearchOpen(true);
          }}
          brandName={startup?.appName}
          {...(startup
            ? { user: { name: startup.userName, version: `v${startup.appVersion}` } }
            : {})}
        />
      )}

      {computerUse?.state === 'active' ? (
        <div className="ew-approval-bar" role="status">
          <span>{computerUse.message}</span>
          <button
            type="button"
            onClick={() => {
              void bridge.stopComputerUse?.().then(setComputerUse);
            }}
          >
            停止控制
          </button>
        </div>
      ) : null}
      {view !== 'task' ? (
        <MainPage
          view={view}
          settingsSection={settingsSection}
          onSettingsSection={setSettingsSection}
          modelAccess={modelAccess}
          computerUse={computerUse}
          onComputerUseEnabled={(enabled) => {
            void bridge
              .setComputerUseEnabled?.({ enabled })
              .then(setComputerUse)
              .catch((error: unknown) => reportFailure(error, '没能更新电脑操控状态。'));
          }}
          onComputerUseStop={() => {
            void bridge
              .stopComputerUse?.()
              .then(setComputerUse)
              .catch((error: unknown) => reportFailure(error, '没能停止电脑操控。'));
          }}
          onComputerUseRevoke={(appId) => {
            void bridge
              .revokeComputerUseAccess?.(appId ? { appId } : {})
              .then(setComputerUse)
              .catch((error: unknown) => reportFailure(error, '没能撤销应用授权。'));
          }}
          onComputerUseSettings={() => {
            void bridge
              .openComputerUseSettings?.()
              .catch((error: unknown) => reportFailure(error, '没能打开系统设置。'));
          }}
          preferences={preferences}
          appName={startup?.appName ?? 'EvoWork'}
          appVersion={startup?.appVersion ?? ''}
          {...(settingsRefusal !== undefined ? { settingsRefusal } : {})}
          {...(probeResult !== undefined ? { probeResult } : {})}
          onModelAccessAction={(run) => {
            void run(bridge)
              .then((result) => {
                applyAccessView(result.view);
                // 拒绝的原话要显示出来；成功时把上一次的拒绝清掉
                setSettingsRefusal(result.refused);
              })
              .catch((error: unknown) => reportFailure(error, '设置没有保存。'));
          }}
          onTestCustomModel={(input) => bridge.testCustomModel(input)}
          onOpenModelsFolder={() =>
            void bridge
              .openModelsFolder()
              .catch((error: unknown) => reportFailure(error, '打不开模型配置目录。'))
          }
          onOpenProviderDocs={(provider) => {
            void bridge
              .openProviderDocs({ provider })
              .then((result) => {
                // 打不开就把原因显示出来，不做成一个点了没反应的链接
                if (!result.ok) setSettingsRefusal(result.refused);
              })
              .catch((error: unknown) => reportFailure(error, '打不开外部文档。'));
          }}
          onProbe={(modelId) => {
            setProbeResult('正在检查…（会向上游发一次极小的请求）');
            void bridge
              .probeModel({ modelId })
              .then((r) => setProbeResult(r.message))
              .catch(() => setProbeResult('检查没跑起来。'));
          }}
          onPreferences={(input) => {
            void bridge
              .setPreferences(input)
              .then(setPreferences)
              .catch((error: unknown) => reportFailure(error, '偏好没有保存。'));
          }}
          onLogin={() => {
            void bridge
              .startLogin()
              .then((result) => {
                if (!result.ok) setSettingsRefusal(result.refused);
                else setSettingsRefusal(undefined);
                void bridge
                  .getModelAccess()
                  .then((r) => {
                    applyAccessView(r.view);
                  })
                  .catch((error: unknown) => reportFailure(error, '没能刷新账号状态。'));
              })
              .catch((error: unknown) => reportFailure(error, '没能开始登录。'));
          }}
          onLogout={() => {
            void bridge
              .logout()
              .then(() =>
                bridge.getModelAccess().then((r) => {
                  applyAccessView(r.view);
                }),
              )
              .catch((error: unknown) => reportFailure(error, '没能退出登录。'));
          }}
          onRevokeDevice={(deviceId) => {
            void bridge
              .revokeDevice({ deviceId })
              .then(() =>
                bridge
                  .listDevices()
                  .then(() => bridge.getModelAccess().then((r) => setModelAccess(r.view))),
              )
              .catch((error: unknown) => reportFailure(error, '没能吊销这台设备。'));
          }}
          onOpenAccountWeb={(path) => {
            void bridge
              .openAccountWeb({ path })
              .then((result) => {
                if (!result.ok)
                  pushToast({
                    tone: 'danger',
                    text: result.refused ?? '打不开账号页。',
                  });
              })
              .catch((error: unknown) => reportFailure(error, '打不开账号页。'));
          }}
          library={library}
          libraryInitialNav={libraryInitialNav}
          automations={automations}
          automationWorkspaces={(startup?.workspaces ?? [])
            .filter((workspace) => Boolean(workspace.path))
            .map((workspace) => ({ id: workspace.path as string, label: workspace.name }))}
          automationModels={models.map((model) => ({ id: model.id, label: model.label }))}
          onSaveAutomation={async (input) => {
            if (!bridge.saveAutomation) return false;
            try {
              const result = await bridge.saveAutomation(input);
              setAutomations(result.data);
              pushToast({
                tone: result.ok ? 'success' : 'danger',
                text: result.ok ? '自动化已保存。' : (result.refused ?? '自动化没有保存。'),
              });
              return result.ok;
            } catch (error: unknown) {
              reportFailure(error, '自动化没有保存。');
              return false;
            }
          }}
          onAutomationStatus={async (id, status) => {
            if (!bridge.setAutomationStatus) return;
            try {
              const result = await bridge.setAutomationStatus({ id, status });
              setAutomations(result.data);
              if (!result.ok)
                pushToast({
                  tone: 'danger',
                  text: result.refused ?? '自动化状态没有更新。',
                });
            } catch (error: unknown) {
              reportFailure(error, '自动化状态没有更新。');
            }
          }}
          onMigrateAutomation={async (id) => {
            if (!bridge.migrateAutomation) return;
            try {
              const result = await bridge.migrateAutomation({ id });
              setAutomations(result.data);
              pushToast({
                tone: result.ok ? 'success' : 'danger',
                text: result.ok ? '已迁移到本机。' : (result.refused ?? '没能迁移。'),
              });
            } catch (error: unknown) {
              reportFailure(error, '没能迁移。');
            }
          }}
          onRunAutomation={async (id, test) => {
            if (!bridge.runAutomation) return;
            try {
              const result = await bridge.runAutomation({ id, test });
              setAutomations(result.data);
              pushToast({
                tone: result.ok ? 'success' : 'danger',
                text: result.ok
                  ? test
                    ? '试跑已开始。'
                    : '已立即运行。'
                  : (result.refused ?? '没能启动。'),
              });
            } catch (error: unknown) {
              reportFailure(error, '没能启动。');
            }
          }}
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
          onOpenLibraryRow={(id) => {
            void bridge.openResultFile({ artifactId: id }).catch((error: unknown) =>
              pushToast({
                tone: 'danger',
                text: `打不开资料：${error instanceof Error ? error.message : String(error)}`,
              }),
            );
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
          onPickDirectory={view === 'catalog' ? pickCatalogDirectory : pickProjectDirectory}
          catalog={catalog}
          catalogTab={catalogTab}
          onCatalogTab={setCatalogTab}
          {...(catalogRefusal !== undefined ? { catalogRefusal } : {})}
          onInstallSkill={async (input) => runCatalogMutation(() => bridge.installSkill(input))}
          onUninstallSkill={async (id) => runCatalogMutation(() => bridge.uninstallSkill({ id }))}
          onSetSkillEnabled={async (input) =>
            runCatalogMutation(() => bridge.setSkillEnabled(input))
          }
          onInstallBundle={async (input) =>
            runCatalogMutation(() => bridge.installPluginBundle(input))
          }
          onUninstallBundle={async (pluginId) =>
            runCatalogMutation(() => bridge.uninstallPluginBundle({ pluginId }))
          }
          onAddConnector={async (input) => runCatalogMutation(() => bridge.addConnector(input))}
          onTrustConnector={async (id) => runCatalogMutation(() => bridge.trustConnector({ id }))}
          onRemoveConnector={async (id) => runCatalogMutation(() => bridge.removeConnector({ id }))}
          onCreateExpert={async (input) => runCatalogMutation(() => bridge.createExpert(input))}
          onRemoveExpert={async (id) => runCatalogMutation(() => bridge.removeExpert({ id }))}
          onUsePrompt={prepareTaskWithText}
          onWriteSkill={() => {
            const creator = composerContext.mentions.find(
              (mention) => mention.category === 'skill' && mention.name === 'skill-creator',
            );
            if (!creator) {
              pushToast({ tone: 'danger', text: '技能创作器尚未被内核加载，请查看技能错误。' });
              return;
            }
            beginNewTask();
            setDraft(`$${creator.label} ${SKILL_CREATOR_PROMPT}`);
            setReferences([{ type: 'skill', name: 'skill-creator', path: creator.path }]);
          }}
        />
      ) : activeTaskId === null ? (
        <Home
          heroLine="有什么可以帮忙的？"
          scenarios={scenarios}
          scenarioId={scenarioId}
          onScenarioChange={setScenarioId}
          cases={startup?.cases}
          notices={notices}
          composer={composer}
          value={draft}
          onChange={changeDraft}
          {...(modelAccess?.policyPack?.disableSlots
            ? {
                slots: {
                  titlebarPromo: false,
                  activityPopover: false,
                  sidebarPromo: false,
                  showcase: false,
                },
              }
            : {})}
          {...(failure !== undefined
            ? { configNotice: `没有连上本机服务：${failure}。重启 EvoWork 再试。` }
            : {})}
        />
      ) : (
        <TaskWorkspace
          taskId={activeTaskId}
          title={active?.title ?? null}
          status={active?.status ?? 'idle'}
          {...(isSubagent && active?.parentThreadId
            ? {
                subagentContext: {
                  parentThreadId: active.parentThreadId,
                  parentTitle:
                    tasks.find((task) => task.id === active.parentThreadId)?.title ?? undefined,
                  rootThreadId: activeRoot?.id,
                  rootTitle: activeRoot?.title ?? undefined,
                  onOpenRoot: activeRoot
                    ? () => {
                        setActiveTaskId(activeRoot.id);
                        setView('task');
                      }
                    : undefined,
                },
              }
            : {})}
          goal={goalsByTask[activeTaskId]}
          focusItemId={focusItemId}
          onGoalSave={
            !isSubagent && bridge.setTaskGoal
              ? (input) => {
                  const threadId = activeTaskId;
                  void bridge
                    .setTaskGoal?.({
                      threadId,
                      ...input,
                      status: input.status ?? goalsByTask[threadId]?.status ?? 'active',
                    })
                    .then((goal) =>
                      setGoalsByTask((previous) => ({ ...previous, [threadId]: goal })),
                    )
                    .catch((error: unknown) => reportFailure(error, '没能保存任务目标。'));
                }
              : undefined
          }
          onGoalStatus={
            !isSubagent && bridge.setTaskGoal
              ? (status) => {
                  const threadId = activeTaskId;
                  void bridge
                    .setTaskGoal?.({ threadId, status })
                    .then((goal) =>
                      setGoalsByTask((previous) => ({ ...previous, [threadId]: goal })),
                    )
                    .catch((error: unknown) => reportFailure(error, '没能更新任务状态。'));
                }
              : undefined
          }
          onGoalClear={
            !isSubagent && bridge.clearTaskGoal
              ? () => {
                  const threadId = activeTaskId;
                  void bridge
                    .clearTaskGoal?.({ threadId })
                    .then(() =>
                      setGoalsByTask((previous) => ({ ...previous, [threadId]: undefined })),
                    )
                    .catch((error: unknown) => reportFailure(error, '没能清除任务目标。'));
                }
              : undefined
          }
          onFork={
            !isSubagent && bridge.forkTask
              ? (ephemeral) => {
                  void bridge
                    .forkTask?.({
                      threadId: activeTaskId,
                      ...(latestTurnByTask[activeTaskId]
                        ? { lastTurnId: latestTurnByTask[activeTaskId] }
                        : {}),
                      ...(ephemeral ? { ephemeral: true } : {}),
                    })
                    .then((result) => {
                      if (!result) return;
                      if (ephemeral) {
                        const transientTask = result.task;
                        if (transientTask) {
                          setTasks((previous) => [
                            transientTask,
                            ...previous.filter((task) => task.id !== result.threadId),
                          ]);
                        }
                        // 分页历史模式下 ephemeral fork 必须 `excludeTurns:true`，响应里不会
                        // 带复制出的 turns。旁聊的可见上下文直接继承当前已加载时间线；内核
                        // 自己仍持有完整上下文，后续实时事件会继续追加到这份副本。
                        setItemsByTask((previous) => ({
                          ...previous,
                          [result.threadId]: currentItems,
                        }));
                      }
                      setActiveTaskId(result.threadId);
                      setView('task');
                    })
                    .catch((error: unknown) => reportFailure(error, '没能分叉这个任务。'));
                }
              : undefined
          }
          subtasks={
            subtasksByTask[activeTaskId] ??
            tasks.filter((task) => task.parentThreadId === activeTaskId)
          }
          onOpenSubtask={(threadId) => {
            const subtask = (subtasksByTask[activeTaskId] ?? []).find(
              (task) => task.id === threadId,
            );
            if (subtask)
              setTasks((previous) => [subtask, ...previous.filter((task) => task.id !== threadId)]);
            setActiveTaskId(threadId);
            setView('task');
          }}
          items={currentItems}
          pendingApprovals={approvals}
          onDecide={(id, decision) =>
            void bridge
              .decideApproval({ id, decision })
              .catch((error: unknown) => reportFailure(error, '没能提交这项审批。'))
          }
          onAnswer={(id, answer) =>
            void bridge
              .decideApproval({
                id,
                decision: 'accept',
                ...(answer.optionId ? { optionId: answer.optionId } : {}),
                ...(answer.text ? { answer: answer.text } : {}),
              })
              .catch((error: unknown) => reportFailure(error, '没能提交这项审批。'))
          }
          itemContext={{
            reasoningAvailable,
            // Visualizer 的真实 mermaid 渲染器。动态 import，第一次真要画图时才加载
            mermaid: MERMAID,
            onOpenResult: (tab) => updateResultUi({ open: true, tab }),
            artifacts: currentResults.artifacts,
            onOpenArtifact: openArtifact,
            onOpenChangedFile: openChangedFile,
            onOpenSubAgent: (threadId) => {
              const subtask = Object.values(subtasksByTask)
                .flat()
                .find((task) => task.id === threadId);
              if (subtask)
                setTasks((previous) => [
                  subtask,
                  ...previous.filter((task) => task.id !== threadId),
                ]);
              setActiveTaskId(threadId);
              setView('task');
            },
          }}
          artifacts={currentResults.artifacts}
          onOpenArtifact={openArtifact}
          hasResults={hasCurrentResults}
          resultOpen={activeResultUi.open}
          resultTab={activeResultUi.tab}
          onResultOpenChange={(open) => {
            setResultDismissed((previous) => ({ ...previous, [activeTaskId]: !open }));
            updateResultUi({ open });
          }}
          onResultTabChange={(tab) => updateResultUi({ tab })}
          resultPanels={{
            artifacts:
              currentResults.artifacts.length > 0 ? (
                <div className="ew-result-preview-stack">
                  <ul className="ew-result-artifacts">
                    {currentResults.artifacts.map((artifact) => (
                      <li key={artifact.id}>
                        <button
                          type="button"
                          className="ew-result-artifact"
                          onClick={() => openArtifact(artifact.id)}
                        >
                          <span>{artifact.name}</span>
                          <span>版本 {artifact.version}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                  {currentPreview && currentPreview.kind !== 'html' ? (
                    <FilePreview preview={currentPreview} onAnnotate={annotatePreview} />
                  ) : null}
                </div>
              ) : (
                <EmptyState title="还没有产物" hint="任务生成的交付文件会出现在这里。" />
              ),
            files:
              currentFiles.length > 0 || (currentPreview && currentPreview.kind !== 'html') ? (
                <div className="ew-result-preview-stack">
                  {currentFiles.length > 0 ? (
                    <FileTree
                      entries={currentFiles}
                      ariaLabel="结果区项目文件"
                      onFileOpen={(entry) => {
                        if (activeProject && bridge.readProjectFilePreview)
                          void showPreview(
                            () =>
                              bridge.readProjectFilePreview!({
                                projectId: activeProject.id,
                                path: entry.path,
                              }),
                            'files',
                          );
                      }}
                    />
                  ) : null}
                  {currentPreview && currentPreview.kind !== 'html' ? (
                    <FilePreview preview={currentPreview} onAnnotate={annotatePreview} />
                  ) : null}
                </div>
              ) : (
                <EmptyState title="没有项目文件" hint="把任务放进项目后可在这里浏览根目录。" />
              ),
            changes: (
              <ChangesView
                files={changedFiles}
                scope={diffScope}
                onScopeChange={setDiffScope}
                selectedPath={selectedChangeByTask[activeTaskId]}
                {...(currentTurnId !== undefined && bridge.revertTask
                  ? { onRollback: () => void rollbackCurrentTurn() }
                  : {})}
              />
            ),
            browser:
              currentPreview?.kind === 'html' ? (
                <FilePreview preview={currentPreview} onAnnotate={annotatePreview} />
              ) : (
                <EmptyState
                  title="没有浏览器预览"
                  hint="任务产生本地网页或 HTML 预览后才会在这里显示。"
                />
              ),
          }}
          notices={notices}
          {...(turnFailures[activeTaskId]
            ? {
                turnFailure: {
                  summary: turnFailures[activeTaskId].summary,
                  onRetry: () => void retryCurrentTurn(),
                  onOpenSettings: () => {
                    setSettingsSection('models');
                    setView('settings');
                  },
                },
              }
            : {})}
          historyLoading={historyLoading}
          onNewTask={beginNewTask}
          composer={<Composer {...composer} value={draft} onChange={changeDraft} />}
        />
      )}
      {searchOpen ? (
        <TaskSearchPalette
          tasks={tasks}
          workspaces={startup?.workspaces ?? []}
          onSearch={searchTasks}
          onClose={() => setSearchOpen(false)}
          onOpenTask={(id, query) => {
            setActiveTaskId(id);
            setView('task');
            setFocusItemId(undefined);
            if (query && bridge.searchTaskOccurrences) {
              void bridge
                .searchTaskOccurrences({ threadId: id, query })
                .then((occurrences) => setFocusItemId(occurrences[0]?.itemId));
            }
          }}
          onNewChat={beginNewTask}
          onOpenFolder={importProject}
          onSearchFiles={() => {
            setLibraryInitialNav('search');
            setView('library');
          }}
        />
      ) : null}
      {projectCreateOpen ? (
        <CreateProjectDialog
          onCreate={createProject}
          onPickDirectory={pickProjectDirectory}
          onCancel={() => setProjectCreateOpen(false)}
        />
      ) : null}
      <p className="ew-window-size-hint" role="status">
        窗口较窄，建议放大窗口获得完整布局
      </p>
      <ToastStack toasts={toasts} onDismiss={dismissToast} />
    </div>
  );
}

/**
 * 目录式页面的分发。
 *
 * 02 §1 的 6 个入口是产品骨架。「更多」现在还没有本体页，给一个如实说明的空页。
 */
function MainPage(props: {
  readonly computerUse?: ComputerUseStatusView | null | undefined;
  readonly onComputerUseEnabled?: ((enabled: boolean) => void) | undefined;
  readonly onComputerUseStop?: (() => void) | undefined;
  readonly onComputerUseRevoke?: ((appId?: string) => void) | undefined;
  readonly onComputerUseSettings?: (() => void) | undefined;

  readonly view: MainView;
  readonly settingsSection: SettingsSection;
  readonly onSettingsSection: (section: SettingsSection) => void;
  readonly modelAccess: ModelAccessView | null;
  readonly preferences: PreferencesView | null;
  readonly appName: string;
  readonly appVersion: string;
  readonly settingsRefusal?: string | undefined;
  readonly probeResult?: string | undefined;
  /**
   * 设置页的所有改动走这**一个**回调，由它统一处理"改完之后怎么更新界面"。
   *
   * 六个动作各自接一条 setState 的话，"改了密钥之后下拉要不要跟着变"这件事
   * 就会在六处各答一次 —— 而它们必须答得一样（设置页与 Composer 用的是同一份目录）。
   */
  readonly onModelAccessAction: (
    run: (bridge: EvoworkBridge) => Promise<ModelAccessMutationResult>,
  ) => void;
  readonly onProbe: (modelId: string) => void;
  /**
   * 「测试连接」走**自己的一条路**而不是 `onModelAccessAction`：它不改本机状态，
   * 结果要回到弹窗里那一行（页顶横幅在模态后面，用户看不见）。
   */
  readonly onTestCustomModel: (input: CustomModelTestInput) => Promise<ModelProbeResult>;
  readonly onOpenModelsFolder: () => void;
  readonly onOpenProviderDocs: (provider: string) => void;
  readonly onPreferences: (input: PreferencesInput) => void;
  readonly onLogin: () => void;
  readonly onLogout: () => void;
  readonly onRevokeDevice: (deviceId: string) => void;
  readonly onOpenAccountWeb: (path: string) => void;
  readonly library: LibraryDataView | null;
  readonly libraryInitialNav: LibraryNav;
  readonly automations: AutomationsDataView | null;
  readonly automationWorkspaces: readonly { readonly id: string; readonly label: string }[];
  readonly automationModels: readonly { readonly id: string; readonly label: string }[];
  readonly onSaveAutomation: (input: AutomationMutationInput) => Promise<boolean>;
  readonly onAutomationStatus: (id: string, status: 'ACTIVE' | 'PAUSED') => Promise<void>;
  readonly onMigrateAutomation: (id: string) => Promise<void>;
  readonly onRunAutomation: (id: string, test: boolean) => Promise<void>;
  readonly audit: AuditDataView | null;
  readonly projects: ProjectsDataView | null;
  readonly activeProjectId: string | null;
  readonly projectDetail: ProjectDetailView | null;
  readonly projectTree: readonly DirEntryView[];
  readonly projectTreeChildren: Readonly<Record<string, readonly DirEntryView[]>>;
  readonly projectMemo: AgentsMemoView;
  readonly projectRefusal: string | undefined;
  readonly onOpenTask: (threadId: string) => void;
  readonly onOpenLibraryRow: (artifactId: string) => void;
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
  readonly catalog: CatalogDataView | null;
  readonly catalogTab: CatalogTab;
  readonly onCatalogTab: (tab: CatalogTab) => void;
  readonly catalogRefusal?: string | undefined;
  readonly onInstallSkill: CatalogPageProps['onInstallSkill'];
  readonly onUninstallSkill: CatalogPageProps['onUninstallSkill'];
  readonly onSetSkillEnabled: CatalogPageProps['onSetSkillEnabled'];
  readonly onInstallBundle: CatalogPageProps['onInstallBundle'];
  readonly onUninstallBundle: CatalogPageProps['onUninstallBundle'];
  readonly onAddConnector: CatalogPageProps['onAddConnector'];
  readonly onTrustConnector: CatalogPageProps['onTrustConnector'];
  readonly onRemoveConnector: CatalogPageProps['onRemoveConnector'];
  readonly onCreateExpert: CatalogPageProps['onCreateExpert'];
  readonly onRemoveExpert: CatalogPageProps['onRemoveExpert'];
  readonly onUsePrompt: (prompt: string) => void;
  readonly onWriteSkill: () => void;
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
          key={props.libraryInitialNav}
          initialNav={props.libraryInitialNav}
          rows={(props.library?.rows ?? []) as readonly LibraryRow[]}
          {...(props.library?.diskUsage ? { diskUsage: props.library.diskUsage } : {})}
          onOpen={(row) => props.onOpenLibraryRow(row.id)}
        />
      );

    case 'automations':
      return (
        <AutomationsPage
          rows={props.automations?.automations ?? []}
          runs={props.automations?.runs ?? {}}
          deviceName={props.automations?.deviceName ?? '这台电脑'}
          workspaceOptions={props.automationWorkspaces}
          modelOptions={props.automationModels}
          onOpenTask={props.onOpenTask}
          onSave={(draft, id) => props.onSaveAutomation({ ...draft, ...(id ? { id } : {}) })}
          onStatus={props.onAutomationStatus}
          onMigrate={props.onMigrateAutomation}
          onRun={props.onRunAutomation}
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

    case 'settings':
      return (
        <SettingsPage
          section={props.settingsSection}
          onSection={props.onSettingsSection}
          access={props.modelAccess}
          computerUse={props.computerUse}
          onComputerUseEnabled={props.onComputerUseEnabled}
          onComputerUseStop={props.onComputerUseStop}
          onComputerUseRevoke={props.onComputerUseRevoke}
          onComputerUseSettings={props.onComputerUseSettings}
          preferences={props.preferences}
          appName={props.appName}
          appVersion={props.appVersion}
          {...(props.settingsRefusal !== undefined ? { refusal: props.settingsRefusal } : {})}
          {...(props.probeResult !== undefined ? { probeResult: props.probeResult } : {})}
          onAddCustomModel={(input) => props.onModelAccessAction((b) => b.addCustomModel(input))}
          onUpdateCustomModel={(input) =>
            props.onModelAccessAction((b) => b.updateCustomModel(input))
          }
          onRemoveCustomModel={(id) =>
            props.onModelAccessAction((b) => b.removeCustomModel({ id }))
          }
          onTestCustomModel={props.onTestCustomModel}
          onOpenModelsFolder={props.onOpenModelsFolder}
          onOpenProviderDocs={props.onOpenProviderDocs}
          onSecretFallback={(accept) =>
            props.onModelAccessAction((b) => b.setSecretFallback({ accept }))
          }
          onProbe={props.onProbe}
          onPreferences={props.onPreferences}
          onLogin={props.onLogin}
          onLogout={props.onLogout}
          onRevokeDevice={props.onRevokeDevice}
          onOpenAccountWeb={props.onOpenAccountWeb}
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

    case 'catalog':
      return (
        <CatalogPage
          data={props.catalog}
          tab={props.catalogTab}
          onTab={props.onCatalogTab}
          {...(props.catalogRefusal !== undefined ? { refusal: props.catalogRefusal } : {})}
          onInstallSkill={props.onInstallSkill}
          onUninstallSkill={props.onUninstallSkill}
          onSetSkillEnabled={props.onSetSkillEnabled}
          onInstallBundle={props.onInstallBundle}
          onUninstallBundle={props.onUninstallBundle}
          onAddConnector={props.onAddConnector}
          onTrustConnector={props.onTrustConnector}
          onRemoveConnector={props.onRemoveConnector}
          onCreateExpert={props.onCreateExpert}
          onRemoveExpert={props.onRemoveExpert}
          onPickDirectory={props.onPickDirectory}
          onUsePrompt={props.onUsePrompt}
          onWriteSkill={props.onWriteSkill}
        />
      );

    default:
      return <UnbuiltPage view={props.view} />;
  }
}

/** 02 §1 里已有入口、但页面还没做的那几个。**说清是没做**，不留一个空白主区。 */
const UNBUILT_COPY: Readonly<Record<string, { title: string; hint: string }>> = {
  more: { title: '这里还没有内容', hint: '设置、通知与灵感会陆续放到这里。' },
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

/**
 * 用户点了之后 IPC 失败时要说出来的那句话。
 * 空 message 或非 Error 时用 fallback，避免 Toast 里出现空白或 `[object Object]`。
 */
export function actionErrorText(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim() !== '' ? error.message : fallback;
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

function basename(path: string): string {
  return path.split(/[/\\]/).filter(Boolean).at(-1) ?? path;
}

/** 重试必须保留原需求的结构化引用；遇到不能无损重建的输入时明确拒绝自动重放。 */
export function lastUserMessageRequest(
  items: readonly RenderItem[],
): { readonly text: string; readonly references: readonly ComposerReferenceView[] } | undefined {
  for (const item of [...items].reverse()) {
    if (item.type !== 'userMessage' || !Array.isArray(item.content)) continue;
    const texts: string[] = [];
    const references: ComposerReferenceView[] = [];
    let unsupported = false;
    for (const raw of item.content as readonly Record<string, unknown>[]) {
      if (raw.type === 'text' && typeof raw.text === 'string') texts.push(raw.text);
      else if (
        raw.type === 'mention' &&
        typeof raw.name === 'string' &&
        typeof raw.path === 'string'
      )
        references.push({ type: 'mention', name: raw.name, path: raw.path });
      else if (raw.type === 'skill' && typeof raw.name === 'string' && typeof raw.path === 'string')
        references.push({ type: 'skill', name: raw.name, path: raw.path });
      else if (raw.type === 'localImage' && typeof raw.path === 'string')
        references.push({ type: 'localImage', name: basename(raw.path), path: raw.path });
      else unsupported = true;
    }
    const text = texts.join('\n').trim();
    if (!unsupported && (text || references.length > 0)) return { text, references };
    if (unsupported) return undefined;
  }
  return undefined;
}

/** 兼容只需要摘要文本的调用点；真正的重试走 `lastUserMessageRequest`。 */
export function lastUserMessageText(items: readonly RenderItem[]): string | undefined {
  return lastUserMessageRequest(items)?.text || undefined;
}

/**
 * 文本里的可见 token 是结构化引用的删除手柄：用户删掉 `@文件` / `$技能` 后，
 * 对应引用也必须消失，不能继续在后台悄悄发送。
 */
export function reconcileComposerReferences(
  value: string,
  references: readonly ComposerReferenceView[],
  candidates: ComposerContextView['mentions'],
): readonly ComposerReferenceView[] {
  return references.filter((reference) => {
    if (reference.type !== 'mention' && reference.type !== 'skill') return true;
    const candidate = candidates.find((item) => item.path === reference.path);
    const labels = new Set([reference.name, candidate?.label].filter(Boolean) as string[]);
    const prefix = reference.type === 'skill' ? '$' : '@';
    return [...labels].some((label) => hasVisibleReferenceToken(value, prefix, label));
  });
}

function hasVisibleReferenceToken(value: string, prefix: '@' | '$', label: string): boolean {
  const token = `${prefix}${label}`;
  let offset = value.indexOf(token);
  while (offset >= 0) {
    const next = value[offset + token.length];
    if (next === undefined || /\s|[.,!?;:，。！？；：、）)\]}]/u.test(next)) return true;
    offset = value.indexOf(token, offset + token.length);
  }
  return false;
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

function changedFilesFromUnifiedDiff(diff: string): readonly ChangedFile[] {
  if (!diff) return [];
  const sections = diff.split(/(?=^diff --git )/m).filter(Boolean);
  return sections.flatMap((section) => {
    const gitHeader = section.match(/^diff --git a\/(.+?) b\/(.+)$/m);
    const plusHeader = section.match(/^\+\+\+ (?:b\/)?(.+)$/m);
    const path = gitHeader?.[2] ?? plusHeader?.[1];
    if (!path || path === '/dev/null') return [];
    let added = 0;
    let removed = 0;
    for (const line of section.split('\n')) {
      if (line.startsWith('+') && !line.startsWith('+++')) added += 1;
      if (line.startsWith('-') && !line.startsWith('---')) removed += 1;
    }
    return [{ path, added, removed, diff: section }];
  });
}

/**
 * 把时间线里的 FileChange 投影成完整变更视图。
 * 指定 turnId 时只看该回合；聚合 diff 用来补足尚未收到 FileChange 完整快照的窗口。
 */
export function changedFilesFromItems(
  items: readonly RenderItem[],
  turnId?: string,
  aggregateDiff?: string,
): readonly ChangedFile[] {
  const files = new Map<string, ChangedFile>();
  for (const item of items) {
    if (item.type !== 'fileChange' || !Array.isArray(item.changes)) continue;
    if (turnId !== undefined && item._turnId !== turnId) continue;
    const itemDiff = typeof item.diff === 'string' ? item.diff : '';
    for (const raw of item.changes as readonly Record<string, unknown>[]) {
      if (typeof raw.path !== 'string' || raw.path === '') continue;
      files.set(raw.path, {
        path: raw.path,
        added: typeof raw.added === 'number' ? raw.added : 0,
        removed: typeof raw.removed === 'number' ? raw.removed : 0,
        diff: typeof raw.diff === 'string' ? raw.diff : itemDiff,
        ...(typeof raw.kind === 'string' ? { kind: raw.kind } : {}),
        ...(raw.outsideWorkspace === true ? { outsideWorkspace: true } : {}),
      });
    }
  }
  for (const file of changedFilesFromUnifiedDiff(aggregateDiff ?? '')) {
    const existing = files.get(file.path);
    files.set(file.path, existing?.diff ? existing : file);
  }
  return [...files.values()];
}

/** 只在助手明确交付/邀请预览时自动打开，普通文件变更不抢焦点。 */
export function shouldAutoOpenResult(items: readonly RenderItem[]): boolean {
  const latest = [...items]
    .reverse()
    .find((item) => item.type === 'agentMessage' && typeof item.text === 'string');
  if (!latest || typeof latest.text !== 'string') return false;
  return /(?:已生成|已完成|交付|打开预览|请查看|预览|generated|ready to review|open (?:the )?preview)/i.test(
    latest.text,
  );
}
