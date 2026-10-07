import type { AttachmentTextInput, InstallAttachmentSkillInput } from '../shared/ipc.js';
import { SkillInstallDialog } from './components/skill-install-dialog.js';
import type { LibraryActions, LibraryDocumentInput } from '../shared/ipc.js';
import type {
  ImageSettingsView,
  SaveImageSettingsInput,
  ImageOperationView,
} from '../shared/ipc.js';
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
import { mergeTurnViews } from '../shared/turn-view.js';
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
  HubItemRef,
  ComposerAttachmentView,
  ComposerContextView,
  ComposerReferenceView,
  DirEntryView,
  AccountActionResult,
  DeeplinkDelivery,
  DeeplinkTargetView,
  LibraryDataView,
  ShareCreateInput,
  ShareCreateResult,
  ShareListView,
  SharePlanResult,
  ThreadShareInput,
  FilePreviewView,
  FileAnnotationView,
  ModelAccessMutationResult,
  ModelAccessView,
  ModelCatalogResult,
  ModelProbeResult,
  ModelOptionView,
  ModelUnavailableReason,
  MemoryMutationResult,
  MemorySettingsInput,
  MemorySettingsView,
  OpenTaskResult,
  TurnView,
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
  UpdateQuitImpactView,
  UpdateStatusView,
  SendInput,
  StartupInfo,
  TaskSearchHitView,
  TaskSearchOccurrenceView,
  TaskGoalView,
  TaskRowView,
  TaskResultsView,
  TaskFilePreviewInput,
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
import { Banner, Dialog, EmptyState, IconButton } from './components/primitives.js';
import { GOAL_STATUS_LABELS, parseGoalCommand } from '../shared/goal-command.js';
import { ShareDialog, type SharePhase } from './components/share-dialog.js';
import { transcriptFileName, transcriptToMarkdown } from './views/thread-transcript.js';
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
import { gateAttachmentsForModel, modelImageInput } from './attachment-capability.js';
import { AuditPage, type AuditRow } from './views/audit.js';
import {
  CatalogPage,
  SKILL_CREATOR_PROMPT,
  type CatalogHubActions,
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
export interface EvoworkBridge extends Partial<LibraryActions> {
  getAttachmentText?(
    input: PickAttachmentsInput & { readonly attachmentId: string },
  ): Promise<ComposerAttachmentView>;
  controlAttachmentText?(input: AttachmentTextInput): Promise<ComposerAttachmentView>;
  joinAttachmentLibrary?(
    input: PickAttachmentsInput & { readonly attachmentId: string },
  ): Promise<LibraryDataView>;
  referenceLibraryDocument?(
    input: LibraryDocumentInput & PickAttachmentsInput,
  ): Promise<readonly ComposerAttachmentView[]>;
  verifyImageConnection?(): Promise<string>;
  getImageSettings?(): Promise<ImageSettingsView>;
  saveImageSettings?(input: SaveImageSettingsInput): Promise<ImageSettingsView>;
  getImageOperations?(input: { threadId: string }): Promise<ImageOperationView[]>;
  recoverImageFiles?(): Promise<void>;
  acknowledgeImageOutcome?(input: { threadId: string; operationId: string }): Promise<void>;
  extendImageBudget?(input: { threadId: string }): Promise<void>;
  getComputerUseStatus?(): Promise<ComputerUseStatusView>;
  setComputerUseEnabled?(input: { enabled: boolean }): Promise<ComputerUseStatusView>;
  stopComputerUse?(): Promise<ComputerUseStatusView>;
  revokeComputerUseAccess?(input: { appId?: string }): Promise<ComputerUseStatusView>;
  openComputerUseSettings?(input?: {
    permission: 'accessibility' | 'screenRecording';
  }): Promise<void>;
  onComputerUseStatus?(handler: (status: ComputerUseStatusView) => void): () => void;
  onUiEvent(handler: (event: RendererEvent) => void): () => void;
  onNotice(handler: (notice: { kind: string; text: string }) => void): () => void;
  onPendingApprovals(handler: (approvals: readonly ApprovalView[]) => void): () => void;
  onDegrade(handler: (report: { degradation?: { userVisible: string } }) => void): () => void;
  /** 发送一条需求。没有 threadId 时由主进程新建任务并回 id（03 §1） */
  discardComposerDraft?(input: { draftId: string }): Promise<void>;
  send(input: SendInput): Promise<{ threadId: string; queued?: boolean }>;
  setTaskMode(input: {
    threadId: string;
    modeId: 'request-approval' | 'approve-for-me' | 'full-access';
  }): Promise<void>;
  setTaskMemoryMode?(input: { threadId: string; enabled: boolean }): Promise<{ ok: boolean }>;
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
  openWebSource?(input: { taskId: string; sourceId: string }): Promise<void>;
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
  getComposerContext?(input: {
    workspaceId?: string;
    threadId?: string;
  }): Promise<ComposerContextView>;
  searchComposerMentions?(input: {
    workspaceId?: string;
    query: string;
  }): Promise<ComposerContextView['mentions']>;
  pickAttachments?(input: PickAttachmentsInput): Promise<readonly ComposerAttachmentView[]>;
  ingestAttachments?(input: {
    draftId?: string;
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
  getMemorySettings?(): Promise<MemorySettingsView>;
  setMemorySettings?(input: MemorySettingsInput): Promise<MemoryMutationResult>;
  resetMemories?(): Promise<MemoryMutationResult>;
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
  /*
   * 分享（Q10 / 08 §7）。四条分开而不是一条 —— `prepareShare` **什么都不上传**，
   * 合成一条会让"点开看看"与"已经传上去了"在这一层长得一样。
   */
  prepareShare?(input: { artifactId: string }): Promise<SharePlanResult>;
  createShare?(input: ShareCreateInput): Promise<ShareCreateResult>;
  createThreadShare?(input: ThreadShareInput): Promise<ShareCreateResult>;
  /** 领走冷启动时那条深链（02 §8）。挂载后调一次 */
  takeDeeplink?(): Promise<DeeplinkDelivery | null>;
  revokeShare?(input: { shareId: string }): Promise<AccountActionResult>;
  listShares?(): Promise<ShareListView>;
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
  pickSkillFile?(): Promise<string | undefined>;
  installAttachmentSkill?(input: InstallAttachmentSkillInput): Promise<CatalogMutationResult>;
  installSkill(input: {
    kind: 'file' | 'directory' | 'git';
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
    acknowledge?: boolean | undefined;
    confirmName?: string | undefined;
  }): Promise<CatalogMutationResult>;
  uninstallPluginBundle(input: { pluginId: string }): Promise<CatalogMutationResult>;
  refreshHub?(): Promise<CatalogMutationResult>;
  installHubItem?(input: {
    kind: HubItemRef['kind'];
    id: string;
    acknowledge?: boolean | undefined;
    confirmName?: string | undefined;
  }): Promise<CatalogMutationResult>;
  uninstallHubItem?(input: HubItemRef): Promise<CatalogMutationResult>;
  rollbackHubItem?(input: HubItemRef): Promise<CatalogMutationResult>;
  setHubFetchWhenSignedOut?(input: { enabled: boolean }): Promise<CatalogMutationResult>;
  addConnector(input: {
    name: string;
    transport: 'stdio' | 'sse' | 'http';
    command?: string | undefined;
    args?: string | undefined;
    url?: string | undefined;
  }): Promise<CatalogMutationResult>;
  trustConnector(input: { id: string }): Promise<CatalogMutationResult>;
  authorizeConnector(input: { id: string }): Promise<CatalogMutationResult>;
  setConnectorToolPolicy(input: {
    id: string;
    tool: string;
    policy: 'default' | 'approve' | 'allow';
  }): Promise<CatalogMutationResult>;
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
  /*
   * 在线升级（在线升级提案 §4 B4 · 总纲 Q46）。可选：没接时设置页如实说「还没接上」。
   * 状态由主进程推（`onUpdateStatus`），渲染层不自己推算。
   */
  getUpdateStatus?(): Promise<UpdateStatusView>;
  checkForUpdate?(): Promise<UpdateStatusView>;
  downloadUpdate?(): Promise<UpdateStatusView>;
  cancelUpdateDownload?(): Promise<UpdateStatusView>;
  setUpdateAutoCheck?(input: { enabled: boolean }): Promise<UpdateStatusView>;
  getUpdateQuitImpact?(): Promise<UpdateQuitImpactView>;
  quitAndOpenInstaller?(): Promise<{ ok: boolean; refused?: string | undefined }>;
  onUpdateStatus?(handler: (status: UpdateStatusView) => void): () => void;
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

/**
 * 从「按任务 id 存的表」里去掉一个任务，返回 setState 的 updater。
 *
 * **没这个任务时原样返回上一个对象**：它会被挂在每一条流式增量上，
 * 每次都造一个新对象等于每来一个字就让整棵树重渲染一次。
 */
function dropTask<T>(taskId: string) {
  return (previous: Readonly<Record<string, T>>): Readonly<Record<string, T>> => {
    if (!(taskId in previous)) return previous;
    const next = { ...previous };
    delete next[taskId];
    return next;
  };
}

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

const COMPOSER_DRAFT_KEY = 'evowork.composer.draft';
function savedComposerDraft(): {
  id: string;
  text: string;
  workspaceId?: string;
  attachments: readonly ComposerAttachmentView[];
  references: readonly ComposerReferenceView[];
} {
  try {
    const raw = localStorage.getItem(COMPOSER_DRAFT_KEY);
    if (raw) {
      const value = JSON.parse(raw) as ReturnType<typeof savedComposerDraft>;
      if (
        typeof value.id === 'string' &&
        typeof value.text === 'string' &&
        Array.isArray(value.attachments) &&
        Array.isArray(value.references)
      )
        return value;
    }
  } catch {
    /* 不可用的本地缓存不能阻止新任务。 */
  }
  return { id: crypto.randomUUID(), text: '', attachments: [], references: [] };
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
      kind?: 'kernel-runtime';
    }[]
  >([]);
  const [turnFailures, setTurnFailures] = useState<
    Readonly<Record<string, { readonly text: string; readonly detail?: string }>>
  >({});
  const [kernelUnavailable, setKernelUnavailable] = useState(false);
  const [continuingTaskId, setContinuingTaskId] = useState<string | null>(null);
  const continuingTasks = useRef(new Set<string>());
  const historyEpochByTask = useRef(new Map<string, number>());
  const turnRevisionByTask = useRef(new Map<string, number>());
  /**
   * 正在重试的回合。**不是失败**，所以不能塞进 `turnFailures` ——
   * 它是一行会被下一个动静顶掉的状态：内核重试成功就继续吐字，用完了才变成失败卡。
   */
  const [turnRetries, setTurnRetries] = useState<
    Readonly<Record<string, { readonly attempt?: number; readonly maxAttempts?: number }>>
  >({});
  const [toasts, setToasts] = useState<readonly ToastSpec[]>([]);
  const toastCounter = useRef(0);
  const [startup, setStartup] = useState<StartupInfo | null>(null);
  const [scenarioId, setScenarioId] = useState('office');
  const [permissionId, setPermissionId] = useState<string | undefined>(undefined);
  const [mode, setMode] = useState<ModeId>('request-approval');
  const savedDraft = useRef(savedComposerDraft());
  const [draft, setDraft] = useState(savedDraft.current.text);
  const draftIdentity = useRef(savedDraft.current.id);
  const [environmentBusy, setEnvironmentBusy] = useState(false);

  const pendingEnvironment = useRef(false);
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
  const [workspaceId, setWorkspaceId] = useState<string | undefined>(
    savedDraft.current.workspaceId,
  );
  const [view, setView] = useState<MainView>('task');
  /** 设置页的当前分区（11 §4.4）。「更多」菜单直接说要去哪个分区 */
  const [settingsSection, setSettingsSection] = useState<SettingsSection>('models');
  const [modelAccess, setModelAccess] = useState<ModelAccessView | null>(null);
  const [computerUse, setComputerUse] = useState<ComputerUseStatusView | null>(null);
  useEffect(() => bridge.onComputerUseStatus?.(setComputerUse), [bridge]);
  const [preferences, setPreferences] = useState<PreferencesView | null>(null);
  const [memorySettings, setMemorySettingsView] = useState<MemorySettingsView | null>(null);
  const [taskMemoryModes, setTaskMemoryModes] = useState<Readonly<Record<string, boolean>>>({});
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
  /** 在线升级的状态。主进程推完整视图过来，这里只存 */
  const [update, setUpdate] = useState<UpdateStatusView | null>(null);
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
  const [shares, setShares] = useState<ShareListView>({ rows: [] });
  /**
   * 分享模态的相位。
   *
   * `null` = 没打开。**打开着与没打开是两个显然不同的状态**，不是一个藏在组件里的布尔 ——
   * 与 `Dialog` 自己那条注释同一条理由。
   */
  const [sharePhase, setSharePhase] = useState<SharePhase | null>(null);
  const shareAbort = useRef<AbortController | null>(null);

  /**
   * `evowork://` 进来了（02 §8）。
   *
   * 两条规则落在这里：
   *   · **`prefill` 只写进 Composer，不发送**（规则 2）—— 一条外部链接不该能触发执行
   *   · **找不到时给明确错误**（规则 3）—— 主进程已经判好了，这里只负责说出来，
   *     绝不静默跳到空白页
   */
  function handleDeeplink(event: {
    readonly target?: DeeplinkTargetView | undefined;
    readonly refused?: string | undefined;
  }) {
    if (event.refused !== undefined || !event.target) {
      pushToast({ tone: 'danger', text: event.refused ?? '这条链接打不开。' });
      return;
    }
    const target = event.target;
    switch (target.kind) {
      case 'task':
        setActiveTaskId(target.threadId);
        setView('task');
        return;
      case 'automation':
        setView('automations');
        return;
      case 'library':
        setLibraryInitialNav('artifacts');
        setView('library');
        return;
      case 'share':
        // 本机确实有这份产物才会走到这里（主进程查过了），所以直接打开它
        setLibraryInitialNav('recent');
        setView('library');
        pushToast({ tone: 'success', text: '这份产物在本机，已经打开资料库。' });
        return;
      case 'home':
        // 首页不是独立视图：它是 `task` 视图在没有选中任务时的样子（NAV_TO_VIEW 的 new-task）
        setActiveTaskId(null);
        setView('task');
        if (target.scenario) setScenarioId(target.scenario);
        if (target.prefill) {
          // 只写入，**不发送**（规则 2）
          setDraft(target.prefill);
          pushToast({ tone: 'info', text: '已把内容填进输入框，确认之后再发送。' });
        }
        return;
    }
  }

  /**
   * 分享第 ① 步：叫出授权模态。
   *
   * **这一步不上传任何东西**。用户点「取消」时什么都没发生过 ——
   * 这正是 Q10 规则 1「逐次授权」要的效果：每次都要重新看一遍要传什么。
   */
  async function openShare(artifactId: string) {
    if (!bridge.prepareShare) {
      pushToast({ tone: 'danger', text: '这个构建没有接分享服务。' });
      return;
    }
    const out = await bridge.prepareShare({ artifactId });
    if (!out.ok) {
      // 企业策略停用、文件不在磁盘上 —— 都如实说原因，不弹一个空模态（01 §6.3）
      pushToast({ tone: 'danger', text: out.refused });
      return;
    }
    setSharePhase({ kind: 'authorize', plan: out.plan });
  }

  /**
   * 分享任务（08 §7.2 规则 5）：同一个模态，但多一句警告和一份预览。
   *
   * **预览的字符串与上传的字符串是同一个值** —— 这里生成一次，
   * 既传给模态显示、又传给主进程上传。分两处生成的话，某天一处改了另一处没改，
   * 预览就开始撒谎，而那正是"不许盲传"要防的事。
   */
  function openThreadShare(threadId: string) {
    const task = tasks.find((row) => row.id === threadId);
    const title = task?.title ?? '未命名任务';
    const markdown = transcriptToMarkdown(title, itemsByTask[threadId] ?? []);
    const bytes = new TextEncoder().encode(markdown).byteLength;
    setSharePhase({
      kind: 'authorize-thread',
      markdown,
      plan: {
        artifactId: threadId,
        fileName: transcriptFileName(title),
        sizeBytes: bytes,
        artifactTypeLabel: '任务记录',
        summary: [
          `将要上传：${transcriptFileName(title)}（任务记录，${(bytes / 1024).toFixed(1)} KB）`,
          '文件会上传到 EvoWork 云。**任何拿到链接的人都能访问它。**',
          '链接在 24 小时后失效，之后云端副本会被自动删除。',
        ],
        ttl: '24h',
        ttlOptions: [
          { id: '24h', label: '24 小时' },
          { id: '7d', label: '7 天' },
          { id: '30d', label: '30 天' },
        ],
      },
    });
  }

  async function confirmShare(input: {
    readonly ttl: ShareCreateInput['ttl'];
    readonly accessCode: string | undefined;
    readonly confirmed: boolean;
    readonly previewed: boolean;
  }) {
    const phase = sharePhase;
    if (!phase || phase.kind === 'done') return;
    setSharePhase({ kind: 'uploading', plan: phase.plan });
    shareAbort.current = new AbortController();
    const out =
      phase.kind === 'authorize-thread'
        ? await (bridge.createThreadShare?.({
            threadId: phase.plan.artifactId,
            fileName: phase.plan.fileName,
            // 与模态里显示的是同一个值
            markdown: phase.markdown,
            ttl: input.ttl,
            ...(input.accessCode ? { accessCode: input.accessCode } : {}),
            confirmed: input.confirmed,
            previewed: input.previewed,
          }) ?? { ok: false as const, refused: '这个构建没有接分享服务。' })
        : await (bridge.createShare?.({
            artifactId: phase.plan.artifactId,
            ttl: input.ttl,
            ...(input.accessCode ? { accessCode: input.accessCode } : {}),
            confirmed: input.confirmed,
          }) ?? { ok: false as const, refused: '这个构建没有接分享服务。' });
    shareAbort.current = null;
    if (!out.ok) {
      // 回到授权那一屏并带上原因：重试不必从头填一遍
      setSharePhase({ kind: 'failed', plan: phase.plan, refused: out.refused });
      return;
    }
    setSharePhase({ kind: 'done', url: out.url, expiresAt: out.expiresAt });
    void bridge.listShares?.().then((next) => setShares(next ?? { rows: [] }));
  }

  function closeShare() {
    // 取消要**真的中止请求**，不只是把模态关掉（08 §7.1）
    shareAbort.current?.abort();
    shareAbort.current = null;
    setSharePhase(null);
  }

  async function revokeShare(shareId: string) {
    if (!bridge.revokeShare) return;
    const out = await bridge.revokeShare({ shareId });
    pushToast({
      tone: out.ok ? 'success' : 'danger',
      text: out.ok ? '已撤销，链接立刻失效。' : (out.refused ?? '撤销失败。'),
    });
    void bridge.listShares?.().then((next) => setShares(next ?? { rows: [] }));
  }

  function copyShareLink(url: string) {
    void navigator.clipboard?.writeText(url);
    pushToast({ tone: 'success', text: '链接已复制。' });
  }
  const [projectCreateOpen, setProjectCreateOpen] = useState(false);
  const [taskResults, setTaskResults] = useState<Readonly<Record<string, TaskResultsView>>>({});
  const [taskFiles, setTaskFiles] = useState<Readonly<Record<string, readonly DirEntryView[]>>>({});
  const [resultUi, setResultUi] = useState<
    Readonly<Record<string, { readonly open: boolean; readonly tab: ResultPane }>>
  >({});
  const [diffScope, setDiffScope] = useState<DiffScope>('thread');
  const [turnsByTask, setTurnsByTask] = useState<Readonly<Record<string, readonly TurnView[]>>>({});
  const [latestTurnByTask, setLatestTurnByTask] = useState<Readonly<Record<string, string>>>({});
  const [turnDiffByTask, setTurnDiffByTask] = useState<
    Readonly<Record<string, { readonly turnId: string; readonly diff: string }>>
  >({});
  const [attachments, setAttachments] = useState<readonly ComposerAttachmentView[]>(
    savedDraft.current.attachments,
  );
  const [references, setReferences] = useState<readonly ComposerReferenceView[]>(
    savedDraft.current.references,
  );
  const [composerContext, setComposerContext] = useState<ComposerContextView>({
    mentions: [],
    commands: [],
  });
  const composerContextRequest = useRef(0);
  const [queuedByTask, setQueuedByTask] = useState<
    Readonly<Record<string, readonly QueuedInputView[]>>
  >({});
  const [goalsByTask, setGoalsByTask] = useState<
    Readonly<Record<string, TaskGoalView | undefined>>
  >({});
  const [goalReplacement, setGoalReplacement] = useState<{
    threadId: string;
    draft: string;
    objective: string;
  } | null>(null);
  const [goalPanelRequest, setGoalPanelRequest] = useState({ threadId: '', sequence: 0 });
  const goalRevisions = useRef(new Map<string, number>());
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

  const refreshComposerContext = useCallback(async () => {
    const request = ++composerContextRequest.current;
    if (!bridge.getComposerContext) return;
    try {
      const context = await bridge.getComposerContext(
        activeTaskId !== null ? { threadId: activeTaskId } : workspaceId ? { workspaceId } : {},
      );
      if (request !== composerContextRequest.current) return;
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
    } catch (error) {
      if (request !== composerContextRequest.current) return;
      setComposerContext({ mentions: [], commands: [] });
      reportFailure(error, '没能刷新技能列表。');
    }
  }, [activeTaskId, bridge, reportFailure, workspaceId]);
  const latestComposerRefresh = useRef(refreshComposerContext);
  latestComposerRefresh.current = refreshComposerContext;

  useEffect(() => {
    setComposerContext({ mentions: [], commands: [] });
    void refreshComposerContext();
    return () => {
      composerContextRequest.current += 1;
    };
  }, [refreshComposerContext]);

  /**
   * 进入真正的「新任务」状态。
   *
   * 旧任务的历史读取错误、发送错误和任务级模型选择都不能泄漏到新任务首页；
   * 全局故障（例如网关降级、启动失败）仍然保留，因为换任务并不能解决它们。
   */
  useEffect(() => {
    if (activeTaskId !== null) return;
    try {
      localStorage.setItem(
        COMPOSER_DRAFT_KEY,
        JSON.stringify({
          id: draftIdentity.current,
          text: draft,
          workspaceId,
          attachments,
          references,
        }),
      );
    } catch {
      /* 沙箱禁用持久存储时保留内存草稿。 */
    }
  }, [activeTaskId, draft, workspaceId, attachments, references]);
  const currentDraftTask = useRef(activeTaskId);
  useEffect(() => {
    if (currentDraftTask.current !== activeTaskId) draftIdentity.current = crypto.randomUUID();
    currentDraftTask.current = activeTaskId;
  }, [activeTaskId]);
  const beginNewTask = useCallback(() => {
    if (!pendingEnvironment.current)
      void bridge
        .discardComposerDraft?.({ draftId: draftIdentity.current })
        .catch((error) => reportFailure(error, '没能清理草稿附件。'));
    draftIdentity.current = crypto.randomUUID();
    setWorkspaceId(undefined);
    setActiveTaskId(null);
    setDraft('');
    setReferences([]);
    setAttachments([]);
    setPendingAttachmentSkill(null);
    setModelOverridden(false);
    setNotices((previous) => previous.filter((notice) => notice.scope !== 'task'));
    setFocusItemId(undefined);
    setSearchOpen(false);
    setView('task');
  }, [bridge, reportFailure]);

  /*
   * 冷启动那条深链走**拉**不走推：推的时候 React 还没订阅事件，会丢
   * （02 §8 / `service-host.ts` 的 `pendingDeeplink`）。
   * 主进程那边领一次就清掉，所以这里只跑一次。
   */
  useEffect(() => {
    void bridge.takeDeeplink?.().then((pending) => {
      if (pending) handleDeeplink(pending);
    });
    // 只跑一次：主进程那边领一次就清掉了
  }, []);

  useEffect(() => {
    // 一帧内同 id 的完整快照只更新一次，首条位置仍按到达顺序保留。
    let frame: number | undefined;
    const queuedItems = new Map<string, Map<string, RenderItem>>();
    const flushItems = (): void => {
      if (frame !== undefined) window.cancelAnimationFrame(frame);
      frame = undefined;
      if (queuedItems.size === 0) return;
      const batch = [...queuedItems];
      queuedItems.clear();
      setItemsByTask((previous) => {
        const next = { ...previous };
        for (const [taskId, items] of batch) {
          if (deletedTaskIds.current.has(taskId)) continue;
          let merged = next[taskId] ?? [];
          for (const item of items.values()) merged = mergeItem(merged, item);
          next[taskId] = merged;
        }
        return next;
      });
    };
    const offs = [
      bridge.onUiEvent((event) => {
        if (event.type !== 'item') flushItems();
        if ('taskId' in event && deletedTaskIds.current.has(event.taskId)) return;
        if (event.type === 'task-disconnected' || event.type === 'task-restored')
          historyEpochByTask.current.set(
            event.taskId,
            (historyEpochByTask.current.get(event.taskId) ?? 0) + 1,
          );
        if (event.type === 'task-disconnected') {
          setTurnsByTask((previous) => ({
            ...previous,
            [event.taskId]: (previous[event.taskId] ?? []).map((turn) =>
              turn.status === 'inProgress'
                ? { ...turn, status: 'disconnected', completedAtMs: Date.now() }
                : turn,
            ),
          }));
          setTurnRetries(dropTask(event.taskId));
          setItemsByTask((previous) => ({
            ...previous,
            [event.taskId]: (previous[event.taskId] ?? []).map((item) => ({
              ...item,
              completed: true,
              ...(item.completed !== true
                ? {
                    interrupted: true,
                    ...(item.status === 'inProgress' ? { status: 'interrupted' } : {}),
                  }
                : {}),
            })),
          }));
          return;
        }
        if (event.type === 'task-restored') {
          setTurnsByTask((previous) => ({
            ...previous,
            [event.taskId]: event.history.turns ?? [],
          }));
          setTurnRetries(dropTask(event.taskId));
          setItemsByTask((previous) => ({
            ...previous,
            [event.taskId]: event.history.items as readonly RenderItem[],
          }));
          if (event.history.latestTurnId)
            setLatestTurnByTask((previous) => ({
              ...previous,
              [event.taskId]: event.history.latestTurnId!,
            }));
          setTurnFailures((previous) => {
            const next = { ...previous };
            const failure = event.history.turnFailure;
            if (failure) next[event.taskId] = turnFailureCopy(failure.message, failure.details);
            else delete next[event.taskId];
            return next;
          });
          return;
        }
        if (event.type === 'deeplink') {
          handleDeeplink(event);
          return;
        }
        if (event.type === 'task-goal-changed') {
          goalRevisions.current.set(
            event.taskId,
            (goalRevisions.current.get(event.taskId) ?? 0) + 1,
          );
          setGoalsByTask((previous) => ({ ...previous, [event.taskId]: event.goal }));
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
          setTurnsByTask(remove);
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
           * 03 §8：模型不可用**不静默降级**。原因一个字都不丢 ——
           * `connection refused` 与 `401` 对用户是完全不同的两件事，
           * 归成一句"模型调用失败"就等于把唯一的线索删掉。
           *
           * 2026-09-27 改成两层：原文进「详情」，上面那行换成人话。
           * 起因是用户截图里那句 `stream disconnected before completion:
           * idle timeout waiting for SSE` —— 线索是保住了，可面对中文用户
           * 它等于什么都没说。两层同时满足这两件事。
           */
          setTurnFailures((previous) => ({
            ...previous,
            [event.taskId]: turnFailureCopy(event.message, event.details),
          }));
          return;
        }
        if (event.type === 'turn-retrying') {
          setTurnRetries((previous) => ({
            ...previous,
            [event.taskId]: {
              ...(event.attempt !== undefined ? { attempt: event.attempt } : {}),
              ...(event.maxAttempts !== undefined ? { maxAttempts: event.maxAttempts } : {}),
            },
          }));
          return;
        }
        if (event.type === 'turn-started' || event.type === 'turn-completed') {
          if (event.type === 'turn-completed' && event.taskId === activeTaskId) {
            void refreshComposerContext();
          }
          turnRevisionByTask.current.set(
            event.taskId,
            (turnRevisionByTask.current.get(event.taskId) ?? 0) + 1,
          );
          const taskId = event.taskId;
          const turn: TurnView =
            event.type === 'turn-started'
              ? { id: event.turnId, status: 'inProgress', startedAtMs: event.startedAtMs }
              : {
                  id: event.turnId,
                  status: event.status,
                  startedAtMs: event.startedAtMs,
                  completedAtMs: event.completedAtMs,
                  durationMs: event.durationMs,
                };
          setTurnsByTask((previous) => ({
            ...previous,
            [taskId]: mergeTurnViews([turn], previous[taskId] ?? []),
          }));
          setLatestTurnByTask((previous) => ({
            ...previous,
            [event.taskId]: event.turnId,
          }));
          // 重试成功也好、彻底失败也好，这一行都该消失：它只描述"正在重连"
          setTurnRetries(dropTask(event.taskId));
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
                )
                .catch((error: unknown) => reportFailure(error, '没能刷新排队消息。'));
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
          void refreshComposerContext();
          return;
        }
        if (event.type === 'connectors-changed') {
          if (view === 'catalog') {
            void bridge
              .getCatalog()
              .then(setCatalog)
              .catch(() => undefined);
          }
          return;
        }
        // 又有内容进来了 = 那次重连成功了，提示该撤掉（内核不会专门说"我重连好了"）
        setTurnRetries(dropTask(event.taskId));
        let items = queuedItems.get(event.taskId);
        if (!items) {
          items = new Map();
          queuedItems.set(event.taskId, items);
        }
        items.set(event.item.id, event.item as RenderItem);
        frame ??= window.requestAnimationFrame(flushItems);
      }),
      bridge.onPendingApprovals(setApprovals),
      bridge.onNotice((notice) => {
        if (notice.kind === 'kernel-lost' || notice.kind === 'kernel-failed')
          setKernelUnavailable(true);
        if (notice.kind === 'kernel-restarted') setKernelUnavailable(false);
        const isKernelNotice = ['kernel-lost', 'kernel-failed', 'kernel-restarted'].includes(
          notice.kind,
        );
        setNotices((prev) => [
          ...(isKernelNotice ? prev.filter((entry) => entry.kind !== 'kernel-runtime') : prev),
          {
            tone: 'warning',
            text: notice.text,
            ...(isKernelNotice ? { kind: 'kernel-runtime' as const } : {}),
          },
        ]);
      }),
      // 09 §3.3：降级显式告诉用户，不假装正常
      bridge.onDegrade((report) => {
        const text = report.degradation?.userVisible;
        if (text) setNotices((prev) => [...prev, { tone: 'info', text }]);
      }),
    ];
    return () => {
      flushItems();
      offs.forEach((off) => off());
    };
    // `view` 进依赖：`onUiEvent` 的 handler 闭包里读它判断 projects-changed 要不要重拉，
    // 不进依赖的话闭包会永远拿着订阅那一刻的旧 view，切页后事件处理逻辑就是过期的
  }, [activeTaskId, bridge, refreshComposerContext, reportFailure, view]);

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

  /** 在线升级：进来先取一次，之后跟着主进程推（下载进度、自动检查的结果都走这里） */
  useEffect(() => {
    void bridge
      .getUpdateStatus?.()
      .then(setUpdate)
      .catch(() => setUpdate(null));
    return bridge.onUpdateStatus?.(setUpdate);
  }, [bridge]);

  const runUpdateAction = useCallback(
    (action: (() => Promise<UpdateStatusView>) | undefined) => {
      if (!action) return;
      action()
        .then(setUpdate)
        .catch((error: unknown) =>
          pushToast({ tone: 'danger', text: actionErrorText(error, '这一步没能完成。') }),
        );
    },
    [pushToast],
  );

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
    const epoch = historyEpochByTask.current.get(threadId);
    const turnRevision = turnRevisionByTask.current.get(threadId);
    setHistoryLoading(true);
    void bridge
      .openTask({ threadId })
      .then((result) => {
        if (
          cancelled ||
          deletedTaskIds.current.has(threadId) ||
          historyEpochByTask.current.get(threadId) !== epoch
        )
          return;
        setTurnsByTask((previous) => ({
          ...previous,
          [threadId]: mergeTurnViews(previous[threadId] ?? [], result.turns ?? []),
        }));
        const latestTurnId =
          result.latestTurnId ??
          [...result.items].reverse().find((item) => typeof item._turnId === 'string')?._turnId;
        if (
          typeof latestTurnId === 'string' &&
          turnRevisionByTask.current.get(threadId) === turnRevision
        ) {
          setLatestTurnByTask((previous) => {
            const current = previous[threadId];
            // 历史请求发出后开始的新回合不会出现在这份快照中，不能把当前范围退回旧回合。
            const snapshotIds = new Set([
              ...(result.turns ?? []).map((turn) => turn.id),
              ...result.items.map((item) => item._turnId),
            ]);
            return current && current !== latestTurnId && !snapshotIds.has(current)
              ? previous
              : { ...previous, [threadId]: latestTurnId };
          });
        }
        setItemsByTask((prev) => ({
          ...prev,
          [threadId]: applyHistory(prev[threadId] ?? [], result.items as readonly RenderItem[]),
        }));
        // 读取期间的新回合终态与失败原因优先于旧快照。
        if (turnRevisionByTask.current.get(threadId) === turnRevision) {
          setTurnFailures((previous) => {
            const next = { ...previous };
            if (result.turnFailure) {
              next[threadId] = turnFailureCopy(
                result.turnFailure.message,
                result.turnFailure.details,
              );
            } else delete next[threadId];
            return next;
          });
        }
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

  /** 任务切换时同步它所属的项目与排队追问。 */
  useEffect(() => {
    const cwd =
      activeTaskId === null ? undefined : tasks.find((task) => task.id === activeTaskId)?.cwd;
    const taskWorkspace = startup?.workspaces.find((workspace) => {
      const task = tasks.find((item) => item.id === activeTaskId);
      return task?.projectId !== undefined
        ? task.projectId === workspace.id
        : workspace.path === cwd;
    });
    if (activeTaskId !== null) setWorkspaceId(taskWorkspace?.id);
    if (activeTaskId !== null && bridge.listQueuedInputs) {
      const threadId = rootTaskFor(tasks, activeTaskId)?.id ?? activeTaskId;
      void bridge
        .listQueuedInputs({ threadId })
        .then((queued) =>
          setQueuedByTask((previous) =>
            deletedTaskIds.current.has(threadId) ? previous : { ...previous, [threadId]: queued },
          ),
        )
        .catch((error: unknown) => reportFailure(error, '没能读取排队消息。'));
    }
  }, [activeTaskId, bridge, reportFailure, startup, tasks, workspaceId]);

  // 只在打开任务时补快照；实时通知是权威更新，不能被较早发出的读取覆盖。
  useEffect(() => {
    if (activeTaskId === null || !bridge.getTaskGoal) return;
    const threadId = activeTaskId;
    const revision = goalRevisions.current.get(threadId) ?? 0;
    let cancelled = false;
    void bridge
      .getTaskGoal({ threadId })
      .then((goal) => {
        if (
          !cancelled &&
          !deletedTaskIds.current.has(threadId) &&
          revision === (goalRevisions.current.get(threadId) ?? 0)
        )
          setGoalsByTask((previous) => ({ ...previous, [threadId]: goal }));
      })
      .catch((error: unknown) => {
        if (!cancelled) reportFailure(error, '没能读取任务目标。');
      });
    return () => {
      cancelled = true;
    };
  }, [activeTaskId, bridge, reportFailure]);

  /*
   * 子代理多半是**这一回合里**派出来的，而用户一直停在这个任务上。只在切换任务时读一次的话，
   * 标题栏的「子任务」入口要等用户切走再切回来才出现（`multi-agent.spec.mjs` 抓到的）。
   * 所以时间线里每多一条协作条目、任务状态每变一次都重读：协作条目可能先于子代理的投影行到，
   * 回合收尾那一次兜底。
   */
  const activeCollabItems =
    activeTaskId === null
      ? 0
      : (itemsByTask[activeTaskId] ?? []).filter(
          (item) => item.type === 'subAgentActivity' || item.type === 'collabAgentToolCall',
        ).length;
  const activeTaskStatus = tasks.find((task) => task.id === activeTaskId)?.status;
  useEffect(() => {
    if (activeTaskId === null || !bridge.listSubtasks) return;
    const threadId = activeTaskId;
    void bridge
      .listSubtasks({ threadId })
      .then((subtasks) => setSubtasksByTask((previous) => ({ ...previous, [threadId]: subtasks })))
      .catch((error: unknown) => reportFailure(error, '没能读取子任务。'));
  }, [activeTaskId, bridge, reportFailure, activeCollabItems, activeTaskStatus]);

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
    const project = startup?.workspaces.find((workspace) => {
      const task = tasks.find((item) => item.id === activeTaskId);
      return task?.projectId !== undefined
        ? task.projectId === workspace.id
        : workspace.path === cwd;
    });
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
    if (view === 'library') {
      void bridge
        .getLibrary()
        .then(setLibrary)
        .catch(() => setLibrary(null));
      // 「我分享的」与资料列表同一次进入拉：分开拉会让那个分区在切过去时空一下
      void bridge
        .listShares?.()
        .then((next) => setShares(next ?? { rows: [] }))
        .catch(() => setShares({ rows: [] }));
    }
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
      // 账号一节里的「未登录时也获取 EvoWork 精选内容」开关要看 Hub 状态
      if (catalog === null)
        void bridge
          .getCatalog()
          .then(setCatalog)
          .catch(() => undefined);
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
      void bridge
        .getMemorySettings?.()
        .then(setMemorySettingsView)
        .catch(() => setMemorySettingsView(null));
    }
  }, [view, activeProjectId, bridge, applyAccessView]);

  // Codex 在后台整理记忆；个性化页打开时自动跟进，不要求用户退出再进。
  useEffect(() => {
    if (
      view !== 'settings' ||
      settingsSection !== 'personalization' ||
      !memorySettings?.enabled ||
      !memorySettings.statusSupported ||
      memorySettings.ready ||
      !bridge.getMemorySettings
    ) {
      return;
    }
    const timer = window.setInterval(() => {
      void bridge
        .getMemorySettings?.()
        .then(setMemorySettingsView)
        .catch(() => undefined);
    }, 2_000);
    return () => window.clearInterval(timer);
  }, [
    bridge,
    memorySettings?.enabled,
    memorySettings?.ready,
    memorySettings?.statusSupported,
    settingsSection,
    view,
  ]);

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

  const pickCatalogSkillFile = useCallback(async () => {
    try {
      return await bridge.pickSkillFile?.();
    } catch (error) {
      reportFailure(error, '没能选择技能文件。');
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
      setActiveProjectId(null);
      beginNewTask();
      setWorkspaceId(id);
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
  // 03 §8：当前模型读不了图时，附件区就拒掉图片。显示与发送用同一份结果
  // （`attachment-capability.ts`）；`attachments` 本身不改，换回能读图的模型时图片就回来了。
  const imageInput = modelImageInput(models, modelId);
  const gatedAttachments = useMemo(
    () => gateAttachmentsForModel(attachments, imageInput),
    [attachments, imageInput],
  );

  const send = useCallback(
    async (replaceGoal = false) => {
      const identity = draftIdentity.current;
      const text = draft.trim();
      const command = parseGoalCommand(text);
      if (command) {
        if (pendingEnvironment.current) return;
        pendingEnvironment.current = true;
        try {
          if (isSubagent) throw new Error('子任务不能修改目标，请返回根任务。');
          if (command.action !== 'create') {
            if (!activeTaskId) {
              pushToast({ tone: 'info', text: '还没有目标。输入 /goal 加上目标描述开始。' });
            } else {
              if (!bridge.getTaskGoal) throw new Error('当前版本不支持目标。');
              const revision = goalRevisions.current.get(activeTaskId) ?? 0;
              let goal = await bridge.getTaskGoal({ threadId: activeTaskId });
              if (command.action === 'show') {
                setGoalPanelRequest((previous) => ({
                  threadId: activeTaskId,
                  sequence: previous.sequence + 1,
                }));
                if (!goal) pushToast({ tone: 'info', text: '当前任务还没有目标。' });
              } else if (!goal) {
                throw new Error('当前任务还没有目标。');
              } else if (command.action === 'clear') {
                if (!bridge.clearTaskGoal) throw new Error('当前版本不支持清除目标。');
                await bridge.clearTaskGoal({ threadId: activeTaskId });
                goal = undefined;
              } else {
                if (!bridge.setTaskGoal) throw new Error('当前版本不支持更新目标。');
                goal = await bridge.setTaskGoal({
                  threadId: activeTaskId,
                  status: command.action === 'pause' ? 'paused' : 'active',
                });
              }
              if (revision === (goalRevisions.current.get(activeTaskId) ?? 0))
                setGoalsByTask((previous) => ({ ...previous, [activeTaskId]: goal }));
              if (goal && command.action !== 'show')
                pushToast({ tone: 'info', text: `目标${GOAL_STATUS_LABELS[goal.status]}。` });
            }
            setDraft((previous) => (previous === draft ? '' : previous));
            return;
          }
          if (attachments.length || references.length)
            throw new Error('创建目标前请先单独发送附件和引用。');
          if (!bridge.getTaskGoal || !bridge.setTaskGoal) throw new Error('当前版本不支持目标。');
          if (activeTaskId && !replaceGoal) {
            const goal = await bridge.getTaskGoal({ threadId: activeTaskId });
            if (goal && goal.status !== 'complete') {
              setGoalReplacement({ threadId: activeTaskId, draft, objective: command.objective });
              return;
            }
          }
        } catch (error: unknown) {
          reportFailure(error, '没能执行目标命令。');
          return;
        } finally {
          pendingEnvironment.current = false;
        }
      }
      const attachmentReferences = gatedAttachments.flatMap((attachment) => attachment.references);
      const outgoingReferences = [...references, ...attachmentReferences];
      if (!text && outgoingReferences.length === 0) return;
      if (
        identity !== draftIdentity.current ||
        pendingEnvironment.current ||
        gatedAttachments.some((attachment) => attachment.state !== 'ready')
      )
        return;
      pendingEnvironment.current = true;
      setEnvironmentBusy(true);
      try {
        const { threadId } = await bridge.send({
          ...(replaceGoal ? { replaceGoal: true } : {}),
          draftId: identity,
          ...(activeTaskId ? { threadId: activeTaskId } : {}),
          text,
          scenarioId,
          // 手选的模型跟着这一条消息走（03 §2.4：用户显式选择优先级最高）。
          // 主进程同时把它写进任务级设置，否则下一轮又回落到场景默认值
          ...(modelId !== undefined ? { modelId } : {}),
          ...(mode !== undefined ? { modeId: mode } : {}),
          // 任务在哪个目录里跑。id → path 的翻译在主进程（渲染层不持有绝对路径）
          ...(!activeTaskId && workspaceId !== undefined ? { workspaceId } : {}),
          ...(outgoingReferences.length > 0 ? { references: outgoingReferences } : {}),
          ...(running ? { steer } : {}),
        });
        if (identity !== draftIdentity.current) return;
        setDraft((previous) => (previous === draft ? '' : previous));
        try {
          localStorage.removeItem(COMPOSER_DRAFT_KEY);
        } catch {
          // 浏览器存储不可用不影响已发送的任务。
        }
        void bridge.discardComposerDraft?.({ draftId: identity }).catch(() => undefined);
        setActiveTaskId(threadId);
        setAttachments([]);
        setReferences([]);
        if (bridge.listQueuedInputs) {
          const queue = await bridge.listQueuedInputs({ threadId });
          setQueuedByTask((previous) => ({ ...previous, [threadId]: queue }));
        }
      } catch (err: unknown) {
        // 发送失败要把草稿还回去 —— 清空输入框又什么都没发生，用户会以为消息丢了
        if (identity !== draftIdentity.current) return;
        setNotices((prev) => [
          ...prev,
          {
            tone: 'danger',
            text: `没能发出去：${err instanceof Error ? err.message : String(err)}`,
            scope: 'task',
          },
        ]);
      } finally {
        pendingEnvironment.current = false;
        setEnvironmentBusy(false);
      }
    },
    [
      bridge,
      draft,
      gatedAttachments,
      references,
      activeTaskId,
      scenarioId,
      modelId,
      mode,
      workspaceId,
      running,
      steer,
      isSubagent,
      attachments,
      pushToast,
      reportFailure,
    ],
  );

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

  const changeTaskMemoryMode = useCallback(
    (enabled: boolean) => {
      if (!interactionTaskId || !bridge.setTaskMemoryMode) return;
      const threadId = interactionTaskId;
      const previous = taskMemoryModes[threadId] ?? memorySettings?.generateMemories ?? true;
      setTaskMemoryModes((current) => ({ ...current, [threadId]: enabled }));
      void bridge
        .setTaskMemoryMode({ threadId, enabled })
        .then((result) => {
          if (!result.ok) throw new Error('当前内核不支持任务级记忆控制');
        })
        .catch((error: unknown) => {
          setTaskMemoryModes((current) =>
            current[threadId] === enabled ? { ...current, [threadId]: previous } : current,
          );
          void bridge
            .getMemorySettings?.()
            .then(setMemorySettingsView)
            .catch(() => undefined);
          reportFailure(error, '没能更新当前任务的记忆设置。');
        });
    },
    [bridge, interactionTaskId, memorySettings?.generateMemories, reportFailure, taskMemoryModes],
  );

  const retryCurrentTurn = useCallback(async () => {
    if (activeTaskId === null || kernelUnavailable || continuingTasks.current.has(activeTaskId))
      return;
    const request = lastUserMessageRequest(itemsByTask[activeTaskId] ?? []);
    if (!request) {
      pushToast({
        tone: 'warning',
        text: '上一条需求含当前无法安全重放的输入，请在输入框里确认后重新发送。',
      });
      return;
    }
    continuingTasks.current.add(activeTaskId);
    setContinuingTaskId(activeTaskId);
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
      // 重试本身失败也走同一套两层文案 —— 否则这条路径又会把裸英文摆到卡片上
      const raw = error instanceof Error ? error.message : String(error);
      setTurnFailures((previous) => ({ ...previous, [activeTaskId]: turnFailureCopy(raw) }));
    } finally {
      continuingTasks.current.delete(activeTaskId);
      setContinuingTaskId((current) => (current === activeTaskId ? null : current));
    }
  }, [
    activeTaskId,
    bridge,
    itemsByTask,
    kernelUnavailable,
    modelId,
    mode,
    pushToast,
    scenarioId,
    workspaceId,
  ]);

  const continueCurrentTask = useCallback(async () => {
    if (!activeTaskId || kernelUnavailable || continuingTasks.current.has(activeTaskId)) return;
    const threadId = activeTaskId;
    continuingTasks.current.add(threadId);
    setContinuingTaskId(threadId);
    try {
      await bridge.send({
        threadId,
        text: '继续完成这个任务。先核对已有对话、计划和工作目录中的产物，确认哪些步骤已经完成、哪些操作的结果尚不确定；只执行剩余步骤。不要重复已确认完成的写入、发送、提交等操作。结果不明确或需要再次授权时先向我确认。',
        scenarioId,
        ...(modelId !== undefined ? { modelId } : {}),
        ...(mode !== undefined ? { modeId: mode } : {}),
        ...(workspaceId !== undefined ? { workspaceId } : {}),
      });
    } catch (error: unknown) {
      const raw = error instanceof Error ? error.message : String(error);
      setTurnFailures((previous) => ({ ...previous, [threadId]: turnFailureCopy(raw) }));
    } finally {
      continuingTasks.current.delete(threadId);
      setContinuingTaskId((current) => (current === threadId ? null : current));
    }
  }, [activeTaskId, bridge, kernelUnavailable, modelId, mode, scenarioId, workspaceId]);

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
      if (result.ok) void latestComposerRefresh.current();
      if (!result.needsConfirm)
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

  /** 附件安装是用户级变更；审计确认仍属于发起安装的那份草稿。 */
  const [skillInstalling, setSkillInstalling] = useState(false);
  const skillInstallBusy = useRef(false);
  const [pendingAttachmentSkill, setPendingAttachmentSkill] = useState<{
    input: InstallAttachmentSkillInput;
    audit: NonNullable<CatalogMutationResult['audit']>;
  } | null>(null);
  useEffect(() => setPendingAttachmentSkill(null), [activeTaskId, workspaceId]);
  const installAttachmentSkill = useCallback(
    async (input: InstallAttachmentSkillInput) => {
      if (!bridge.installAttachmentSkill || skillInstallBusy.current) return;
      skillInstallBusy.current = true;
      setSkillInstalling(true);
      setPendingAttachmentSkill(null);
      const identity = draftIdentity.current;
      try {
        const result = await runCatalogMutation(() => bridge.installAttachmentSkill!(input));
        if (identity === draftIdentity.current && result.needsConfirm && result.audit)
          setPendingAttachmentSkill({ input, audit: result.audit });
      } finally {
        skillInstallBusy.current = false;
        setSkillInstalling(false);
      }
    },
    [bridge, runCatalogMutation],
  );

  /** 插件 Hub 的四个动作（13，H1）。宿主没注入时整块缺席，页面上就没有「EvoWork 精选」。 */
  const hubActions = useMemo((): CatalogHubActions | undefined => {
    const { refreshHub, installHubItem, uninstallHubItem, rollbackHubItem } = bridge;
    if (!refreshHub || !installHubItem || !uninstallHubItem || !rollbackHubItem) return undefined;
    return {
      refresh: () => runCatalogMutation(() => refreshHub.call(bridge)),
      install: (input) => runCatalogMutation(() => installHubItem.call(bridge, input)),
      uninstall: (ref) => runCatalogMutation(() => uninstallHubItem.call(bridge, ref)),
      rollback: (ref) => runCatalogMutation(() => rollbackHubItem.call(bridge, ref)),
    };
  }, [bridge, runCatalogMutation]);

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
  const workspaces: readonly SelectOption[] = useMemo(() => {
    const options = (startup?.workspaces ?? []).map((w) => ({
      id: w.id,
      label: w.name,
      description: w.path ?? '这个项目没有可用目录',
      allowed: !!w.path && !w.rootMissing,
      disabledReason: '项目目录已失效，请重新选择。',
    }));
    if (workspaceId && startup && !options.some((option) => option.id === workspaceId))
      options.push({
        id: workspaceId,
        label: '项目已失效',
        description: '请选择其他项目或不使用项目',
        allowed: false,
        disabledReason: '项目已被移除',
      });
    return options;
  }, [startup, workspaceId]);

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
  const addAttachments = useCallback(
    async (action: (id: string) => Promise<readonly ComposerAttachmentView[] | undefined>) => {
      if (pendingEnvironment.current) return;
      const identity = draftIdentity.current;
      const taskId = activeTaskId;
      pendingEnvironment.current = true;
      setEnvironmentBusy(true);
      try {
        const picked = await action(identity);
        if (identity === draftIdentity.current && taskId === activeTaskId && picked?.length)
          setAttachments((previous) => [...previous, ...picked]);
      } catch (error: unknown) {
        reportFailure(error, '没能添加本地文件。');
      } finally {
        pendingEnvironment.current = false;
        setEnvironmentBusy(false);
      }
    },
    [activeTaskId, reportFailure],
  );
  const pickComposerFolder = useCallback(async () => {
    if (pendingEnvironment.current) return;
    const identity = draftIdentity.current;
    pendingEnvironment.current = true;
    setEnvironmentBusy(true);
    try {
      const result = await bridge.importProject();
      if (result.ok) {
        if (result.warning) pushToast({ tone: 'info', text: result.warning });
        const info = await bridge.getStartup();
        setStartup(info);
        if (identity === draftIdentity.current && result.projectId)
          setWorkspaceId(result.projectId);
      } else if (result.refused) pushToast({ tone: 'danger', text: result.refused });
    } catch (error: unknown) {
      reportFailure(error, '没能打开项目文件夹。');
    } finally {
      pendingEnvironment.current = false;
      setEnvironmentBusy(false);
    }
  }, [bridge, reportFailure, pushToast]);
  useEffect(() => {
    if (
      !bridge.getAttachmentText ||
      !attachments.some((a) => a.state === 'parsing' && a.textProcessing)
    )
      return;
    const identity = draftIdentity.current;
    let active = true;
    const timer = setInterval(() => {
      for (const attachment of attachments.filter(
        (a) => a.state === 'parsing' && a.textProcessing,
      )) {
        void bridge.getAttachmentText!({
          attachmentId: attachment.id,
          draftId: identity,
          ...(interactionTaskId ? { threadId: interactionTaskId } : {}),
        })
          .then((next) => {
            if (active && identity === draftIdentity.current)
              setAttachments((old) => old.map((a) => (a.id === next.id ? next : a)));
          })
          .catch((error) => {
            if (active) reportFailure(error, '识别状态读取失败。');
          });
      }
    }, 1000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [attachments, bridge, interactionTaskId, reportFailure]);
  const attachmentTextAction = useCallback(
    async (
      id: string,
      action: 'ocr' | 'continue' | 'stop' | 'partial' | 'join',
      rotation?: 0 | 90 | 180 | 270,
    ) => {
      const identity = draftIdentity.current;
      const input = {
        attachmentId: id,
        draftId: identity,
        ...(interactionTaskId ? { threadId: interactionTaskId } : {}),
      };
      try {
        if (action === 'join') {
          if (bridge.joinAttachmentLibrary) {
            setLibrary(await bridge.joinAttachmentLibrary(input));
            pushToast({ tone: 'success', text: '附件副本已加入本机资料库。' });
          }
        } else if (bridge.controlAttachmentText) {
          const next = await bridge.controlAttachmentText({
            ...input,
            action,
            ...(rotation !== undefined ? { rotation } : {}),
          });
          if (identity === draftIdentity.current)
            setAttachments((old) => old.map((a) => (a.id === id ? next : a)));
        }
      } catch (error) {
        reportFailure(error, '附件处理未完成。');
      }
    },
    [bridge, interactionTaskId, reportFailure, pushToast],
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
      attachments: gatedAttachments as readonly Attachment[],
      skillInstalling,
      onInstallAttachmentSkill: bridge.installAttachmentSkill
        ? (attachmentId: string) =>
            void installAttachmentSkill({
              attachmentId,
              draftId: draftIdentity.current,
              ...(interactionTaskId ? { threadId: interactionTaskId } : {}),
            })
        : undefined,
      onAttach: bridge.pickAttachments
        ? () =>
            void addAttachments((id) =>
              bridge.pickAttachments!({
                draftId: id,
                ...(interactionTaskId ? { threadId: interactionTaskId } : {}),
              }),
            )
        : undefined,
      onAttachImageEdit: bridge.pickAttachments
        ? () =>
            void addAttachments((id) =>
              bridge.pickAttachments!({
                draftId: id,
                ...(interactionTaskId ? { threadId: interactionTaskId } : {}),
                purpose: 'imageEdit',
              }),
            )
        : undefined,
      onFilesAdded: bridge.ingestAttachments
        ? (files: readonly File[]) =>
            void addAttachments(async (id) => {
              const payload = await Promise.all(
                files.map(async (file) => ({
                  name: file.name,
                  bytes: new Uint8Array(await file.arrayBuffer()),
                })),
              );
              return bridge.ingestAttachments!({
                draftId: id,
                ...(interactionTaskId ? { threadId: interactionTaskId } : {}),
                files: payload,
              });
            })
        : undefined,
      onAttachmentTextAction: bridge.controlAttachmentText
        ? (
            id: string,
            action: 'ocr' | 'continue' | 'stop' | 'partial' | 'join',
            rotation?: 0 | 90 | 180 | 270,
          ) => void attachmentTextAction(id, action, rotation)
        : undefined,
      onRemoveAttachment: (id: string) => {
        if (attachments.find((a) => a.id === id)?.textProcessing && bridge.controlAttachmentText)
          void bridge
            .controlAttachmentText({
              attachmentId: id,
              action: 'remove',
              draftId: draftIdentity.current,
              ...(interactionTaskId ? { threadId: interactionTaskId } : {}),
            })
            .catch((error) => reportFailure(error, '未能停止附件识别。'));
        setAttachments((previous) => previous.filter((attachment) => attachment.id !== id));
      },
      onReferAsRaw: (id: string) => {
        // 出路取自显示出来的那一份：被模型能力拦下的图片，它的原始引用只在那里有
        const rawReference = gatedAttachments.find(
          (attachment) => attachment.id === id,
        )?.rawReference;
        if (!rawReference) return;
        setAttachments((previous) =>
          previous.map((attachment) =>
            attachment.id === id
              ? { ...attachment, state: 'ready', references: [rawReference] }
              : attachment,
          ),
        );
      },
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
      onWorkspaceChange: (id: string) => setWorkspaceId(id === 'no-project' ? undefined : id),
      workspaceLocked: activeTaskId !== null,
      workspaceLabel: activeTaskId
        ? (startup?.workspaces.find((w) => w.id === workspaceId)?.name ?? '不使用项目')
        : undefined,
      environmentBusy,
      onPickFolder: () => void pickComposerFolder(),
      onNewTaskInOtherProject: beginNewTask,
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
      ...(interactionTaskId && memorySettings?.enabled && memorySettings.taskModeSupported
        ? {
            memoryEnabled: taskMemoryModes[interactionTaskId] ?? memorySettings.generateMemories,
            onMemoryEnabledChange: changeTaskMemoryMode,
          }
        : {}),
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
      gatedAttachments,
      attachments,
      attachmentTextAction,
      installAttachmentSkill,
      skillInstalling,
      environmentBusy,
      activeTaskId,
      pickComposerFolder,
      addAttachments,
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
      memorySettings,
      taskMemoryModes,
      changeTaskMemoryMode,
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
                  setStartup({ ...info, onboarded: true });
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
        {/*
         * **引导屏也要有 Toast 出口。**
         *
         * 这一支是 `return`，它此前只渲染 `notices` 与 `Onboarding` ——
         * `ToastStack` 在下面那个主分支里，引导期间**永远到不了**。
         * 于是任何在引导期间 `pushToast` 的东西都被无声吞掉。
         *
         * 最要命的那条正是深链：用户收到一条 `evowork://share/…`，点开，
         * 应用第一次启动 → 引导屏 → 主进程把「这份产物不在这台电脑上」推过来 →
         * 变成一个没有宿主的 toast → **什么都没发生**。
         * 那恰好是 02 §8 规则 3（未知 ID 要给明确错误，不是空白页）要防的事，
         * 而它在最可能发生的那个场景里是失效的。2026-09-27 在真 `.app` 上实测到。
         */}
        <ToastStack toasts={toasts} onDismiss={dismissToast} />
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
            draftIdentity.current = crypto.randomUUID();
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
            /*
             * 「分享」**不走 rowAction**：那条路做完会把任务从列表里拿掉
             * （归档 / 删除都是这个形状），而分享什么都不改。
             * 走同一条的话，分享完任务会从侧边栏消失。
             */
            if (action === 'share') {
              openThreadShare(id);
              return;
            }
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
          <span>
            {computerUse.message} · 已尝试 {computerUse.actionCount ?? 0} / 100 次动作
          </span>
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
          onComputerUseRefresh={() => {
            void bridge
              .getComputerUseStatus?.()
              .then(setComputerUse)
              .catch((error: unknown) => reportFailure(error, '没能重新检查电脑操控。'));
          }}
          onComputerUseSettings={(permission) => {
            void bridge
              .openComputerUseSettings?.({ permission: permission ?? 'accessibility' })
              .catch((error: unknown) => reportFailure(error, '没能打开系统设置。'));
          }}
          imagePorts={bridge}
          preferences={preferences}
          memory={memorySettings}
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
          onMemorySettings={(input) => {
            if (!bridge.setMemorySettings) return;
            void bridge
              .setMemorySettings({
                ...input,
                ...(interactionTaskId ? { currentThreadId: interactionTaskId } : {}),
              })
              .then((result) => {
                setMemorySettingsView(result.view);
                setSettingsRefusal(result.refused);
                if (result.ok && interactionTaskId) {
                  setTaskMemoryModes((current) => ({
                    ...current,
                    [interactionTaskId]: result.view.enabled && result.view.generateMemories,
                  }));
                }
              })
              .catch((error: unknown) => reportFailure(error, '记忆设置没有保存。'));
          }}
          onResetMemories={() => {
            if (!bridge.resetMemories) return;
            void bridge
              .resetMemories()
              .then((result) => {
                setMemorySettingsView(result.view);
                pushToast({
                  tone: result.ok ? 'success' : 'danger',
                  text: result.ok ? '本地记忆已清空。' : (result.refused ?? '本地记忆没有清空。'),
                });
              })
              .catch((error: unknown) => reportFailure(error, '本地记忆没有清空。'));
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
          shares={shares}
          onShareArtifact={(id) => void openShare(id)}
          onRevokeShare={(id) => void revokeShare(id)}
          onCopyShareLink={copyShareLink}
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
          libraryActions={bridge.enableLibrarySearch ? (bridge as LibraryActions) : undefined}
          onReferenceLibrary={(input) => {
            if (!bridge.referenceLibraryDocument) return;
            void addAttachments((id) =>
              bridge.referenceLibraryDocument!({
                ...input,
                draftId: id,
                ...(interactionTaskId ? { threadId: interactionTaskId } : {}),
              }),
            ).then(() => setView('task'));
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
          onPickSkillFile={bridge.pickSkillFile ? pickCatalogSkillFile : undefined}
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
          onAuthorizeConnector={async (id) =>
            runCatalogMutation(() => bridge.authorizeConnector({ id }))
          }
          onSetConnectorToolPolicy={async (input) =>
            runCatalogMutation(() => bridge.setConnectorToolPolicy(input))
          }
          onRemoveConnector={async (id) => runCatalogMutation(() => bridge.removeConnector({ id }))}
          onCreateExpert={async (input) => runCatalogMutation(() => bridge.createExpert(input))}
          onRemoveExpert={async (id) => runCatalogMutation(() => bridge.removeExpert({ id }))}
          hubActions={hubActions}
          onHubFetchWhenSignedOut={
            bridge.setHubFetchWhenSignedOut
              ? (enabled) => {
                  void runCatalogMutation(() => bridge.setHubFetchWhenSignedOut!({ enabled }));
                }
              : undefined
          }
          update={update}
          onCheckUpdate={() =>
            runUpdateAction(bridge.checkForUpdate && (() => bridge.checkForUpdate!()))
          }
          onDownloadUpdate={() =>
            runUpdateAction(bridge.downloadUpdate && (() => bridge.downloadUpdate!()))
          }
          onCancelUpdateDownload={() =>
            runUpdateAction(bridge.cancelUpdateDownload && (() => bridge.cancelUpdateDownload!()))
          }
          onUpdateAutoCheck={(enabled) =>
            runUpdateAction(
              bridge.setUpdateAutoCheck && (() => bridge.setUpdateAutoCheck!({ enabled })),
            )
          }
          onGetUpdateQuitImpact={async () =>
            (await bridge.getUpdateQuitImpact?.()) ?? {
              runningTasks: [],
              upcoming: [],
              runtimeInstalling: false,
            }
          }
          onQuitAndInstall={() => {
            void bridge
              .quitAndOpenInstaller?.()
              .then((result) => {
                if (!result.ok)
                  pushToast({ tone: 'danger', text: result.refused ?? '没能打开安装包。' });
              })
              .catch((error: unknown) =>
                pushToast({ tone: 'danger', text: actionErrorText(error, '没能打开安装包。') }),
              );
          }}
          runtime={runtime}
          runtimeProgress={runtimeProgress}
          runtimeError={runtimeError}
          onInstallRuntime={() => void installRuntime()}
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
          turns={turnsByTask[activeTaskId] ?? []}
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
          goalPanelRequest={
            goalPanelRequest.threadId === activeTaskId ? goalPanelRequest.sequence : 0
          }
          onContinue={!isSubagent ? () => void continueCurrentTask() : undefined}
          continueDisabled={
            kernelUnavailable || historyLoading || continuingTaskId === activeTaskId
          }
          focusItemId={focusItemId}
          onGoalSave={
            !isSubagent && bridge.setTaskGoal
              ? (input) => {
                  const threadId = activeTaskId;
                  const revision = goalRevisions.current.get(threadId) ?? 0;
                  void bridge
                    .setTaskGoal?.({
                      threadId,
                      ...input,
                      status: input.status ?? goalsByTask[threadId]?.status ?? 'active',
                    })
                    .then((goal) => {
                      if (revision === (goalRevisions.current.get(threadId) ?? 0))
                        setGoalsByTask((previous) => ({ ...previous, [threadId]: goal }));
                    })
                    .catch((error: unknown) => reportFailure(error, '没能保存任务目标。'));
                }
              : undefined
          }
          onGoalStatus={
            !isSubagent && bridge.setTaskGoal
              ? (status) => {
                  const threadId = activeTaskId;
                  const revision = goalRevisions.current.get(threadId) ?? 0;
                  void bridge
                    .setTaskGoal?.({ threadId, status })
                    .then((goal) => {
                      if (revision === (goalRevisions.current.get(threadId) ?? 0))
                        setGoalsByTask((previous) => ({ ...previous, [threadId]: goal }));
                    })
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
                ...(answer.answers ? { answers: answer.answers } : {}),
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
            imagePorts: bridge,
            imageThreadId: interactionTaskId,
            onEditImage: (imageRef: string) => {
              setDraft('请编辑这张图片（imageRef: ' + imageRef + '）：');
            },
            onOpenWebSource: (sourceId) => {
              if (!bridge.openWebSource) {
                reportFailure(new Error('当前版本不能打开网页来源。'), '无法打开来源。');
                return;
              }
              void bridge
                .openWebSource({ taskId: activeTaskId, sourceId })
                .catch((error: unknown) => reportFailure(error, '无法打开来源。'));
            },
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
          {...(turnRetries[activeTaskId] ? { turnRetry: turnRetries[activeTaskId] } : {})}
          {...(turnFailures[activeTaskId]
            ? {
                turnFailure: {
                  text: turnFailures[activeTaskId].text,
                  ...(turnFailures[activeTaskId].detail
                    ? { detail: turnFailures[activeTaskId].detail }
                    : {}),
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
      {goalReplacement ? (
        <Dialog
          title="替换当前目标？"
          confirmLabel="替换并开始"
          onCancel={() => setGoalReplacement(null)}
          onConfirm={() => {
            const pending = goalReplacement;
            setGoalReplacement(null);
            if (activeTaskId === pending.threadId && draft === pending.draft) void send(true);
            else pushToast({ tone: 'info', text: '任务或输入已改变，请重新发送目标。' });
          }}
        >
          <p>新目标：{goalReplacement.objective}</p>
          <p>替换后重新计量用量，原目标的预算不会沿用。</p>
        </Dialog>
      ) : null}
      <p className="ew-window-size-hint" role="status">
        窗口较窄，建议放大窗口获得完整布局
      </p>
      {pendingAttachmentSkill ? (
        <SkillInstallDialog
          key={pendingAttachmentSkill.input.attachmentId}
          audit={pendingAttachmentSkill.audit}
          onCancel={() => setPendingAttachmentSkill(null)}
          onConfirm={() =>
            void installAttachmentSkill({
              ...pendingAttachmentSkill.input,
              acknowledge: true,
              ...(pendingAttachmentSkill.audit.level === 'p2'
                ? { confirmName: pendingAttachmentSkill.audit.skillId }
                : {}),
            })
          }
        />
      ) : null}
      {/* 分享授权挂在最外层，任务时间线和资料库共用这一个 Q10 入口。 */}
      {sharePhase ? (
        <ShareDialog
          phase={sharePhase}
          onConfirm={(input) => void confirmShare(input)}
          onCancel={closeShare}
          onCopy={copyShareLink}
        />
      ) : null}
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
  readonly imagePorts?: EvoworkBridge | undefined;
  readonly computerUse?: ComputerUseStatusView | null | undefined;
  readonly onComputerUseEnabled?: ((enabled: boolean) => void) | undefined;
  readonly onComputerUseStop?: (() => void) | undefined;
  readonly onComputerUseRevoke?: ((appId?: string) => void) | undefined;
  readonly onComputerUseSettings?:
    ((permission?: 'accessibility' | 'screenRecording') => void) | undefined;
  readonly onComputerUseRefresh?: (() => void) | undefined;

  readonly view: MainView;
  readonly settingsSection: SettingsSection;
  readonly onSettingsSection: (section: SettingsSection) => void;
  readonly modelAccess: ModelAccessView | null;
  readonly preferences: PreferencesView | null;
  readonly memory: MemorySettingsView | null;
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
  readonly onMemorySettings: (input: MemorySettingsInput) => void;
  readonly onResetMemories: () => void;
  readonly onLogin: () => void;
  readonly onLogout: () => void;
  readonly onRevokeDevice: (deviceId: string) => void;
  readonly onOpenAccountWeb: (path: string) => void;
  readonly library: LibraryDataView | null;
  readonly libraryActions?: LibraryActions | undefined;
  readonly onReferenceLibrary: (input: LibraryDocumentInput) => void;
  readonly libraryInitialNav: LibraryNav;
  readonly shares: ShareListView;
  readonly onShareArtifact: (artifactId: string) => void;
  readonly onRevokeShare: (shareId: string) => void;
  readonly onCopyShareLink: (url: string) => void;
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
  readonly onPickSkillFile?: CatalogPageProps['onPickSkillFile'];
  readonly onUninstallSkill: CatalogPageProps['onUninstallSkill'];
  readonly onSetSkillEnabled: CatalogPageProps['onSetSkillEnabled'];
  readonly onInstallBundle: CatalogPageProps['onInstallBundle'];
  readonly onUninstallBundle: CatalogPageProps['onUninstallBundle'];
  readonly onAddConnector: CatalogPageProps['onAddConnector'];
  readonly onTrustConnector: CatalogPageProps['onTrustConnector'];
  readonly onAuthorizeConnector: CatalogPageProps['onAuthorizeConnector'];
  readonly onSetConnectorToolPolicy: CatalogPageProps['onSetConnectorToolPolicy'];
  readonly onRemoveConnector: CatalogPageProps['onRemoveConnector'];
  readonly onCreateExpert: CatalogPageProps['onCreateExpert'];
  readonly onRemoveExpert: CatalogPageProps['onRemoveExpert'];
  readonly hubActions?: CatalogHubActions | undefined;
  readonly onHubFetchWhenSignedOut?: ((enabled: boolean) => void) | undefined;
  /* 在线升级与办公扩展（设置 → 关于与更新） */
  readonly update: UpdateStatusView | null;
  readonly onCheckUpdate: () => void;
  readonly onDownloadUpdate: () => void;
  readonly onCancelUpdateDownload: () => void;
  readonly onUpdateAutoCheck: (enabled: boolean) => void;
  readonly onGetUpdateQuitImpact: () => Promise<UpdateQuitImpactView>;
  readonly onQuitAndInstall: () => void;
  readonly runtime: RuntimeStatusView | null;
  readonly runtimeProgress?: RuntimeProgressView | undefined;
  readonly runtimeError?: string | undefined;
  readonly onInstallRuntime: () => void;
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
          data={props.library ?? undefined}
          actions={props.libraryActions}
          onReference={props.onReferenceLibrary}
          rows={(props.library?.rows ?? []) as readonly LibraryRow[]}
          {...(props.library?.diskUsage ? { diskUsage: props.library.diskUsage } : {})}
          onOpen={(row) => props.onOpenLibraryRow(row.id)}
          shares={props.shares.rows.map((row) => ({
            id: row.id,
            name: row.name,
            url: row.url,
            expiresLabel: expiresLabelOf(row),
            expiringSoon: row.state === 'expiring-soon',
            accessCount: row.visitCount,
            state: row.state,
            hasPassword: row.hasPassword,
          }))}
          onShare={(row) => props.onShareArtifact(row.id)}
          onRevokeShare={props.onRevokeShare}
          onCopyShareLink={props.onCopyShareLink}
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
          onComputerUseRefresh={props.onComputerUseRefresh}
          imagePorts={props.imagePorts}
          preferences={props.preferences}
          memory={props.memory}
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
          onMemorySettings={props.onMemorySettings}
          onResetMemories={props.onResetMemories}
          onLogin={props.onLogin}
          onLogout={props.onLogout}
          onRevokeDevice={props.onRevokeDevice}
          onOpenAccountWeb={props.onOpenAccountWeb}
          hubStatus={props.catalog?.hub?.status}
          onHubFetchWhenSignedOut={props.onHubFetchWhenSignedOut}
          update={props.update}
          onCheckUpdate={props.onCheckUpdate}
          onDownloadUpdate={props.onDownloadUpdate}
          onCancelUpdateDownload={props.onCancelUpdateDownload}
          onUpdateAutoCheck={props.onUpdateAutoCheck}
          onGetUpdateQuitImpact={props.onGetUpdateQuitImpact}
          onQuitAndInstall={props.onQuitAndInstall}
          runtime={props.runtime}
          runtimeProgress={props.runtimeProgress}
          runtimeError={props.runtimeError}
          onInstallRuntime={props.onInstallRuntime}
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
          onPickSkillFile={props.onPickSkillFile}
          onUninstallSkill={props.onUninstallSkill}
          onSetSkillEnabled={props.onSetSkillEnabled}
          onInstallBundle={props.onInstallBundle}
          onUninstallBundle={props.onUninstallBundle}
          onAddConnector={props.onAddConnector}
          onTrustConnector={props.onTrustConnector}
          onAuthorizeConnector={props.onAuthorizeConnector}
          onSetConnectorToolPolicy={props.onSetConnectorToolPolicy}
          onRemoveConnector={props.onRemoveConnector}
          onCreateExpert={props.onCreateExpert}
          onRemoveExpert={props.onRemoveExpert}
          hubActions={props.hubActions}
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
/**
 * 回合失败卡上的两层文案：上面一行人话，原文折进「详情」。
 *
 * 起因是 2026-09-27 用户截图里的
 * `stream disconnected before completion: idle timeout waiting for SSE` ——
 * 03 §8 要求不改写、不归类（`connection refused` 与 `401` 是不同的两件事），
 * 于是内核给的原因被原样显示，而面对中文用户它等于什么都没说。
 *
 * 两层同时满足这两件事：**原文一个字都不丢**，只是不再占着那句要给人看的话。
 *
 * **刻意不做翻译表**：把已知英文原因映射成中文读起来更好，但内核的错误文案随上游
 * 一起漂（R2），而一条**翻错的**中文比英文原文更糟 —— 它看起来可信。
 * 判据因此只有一条：原文里有没有中文。我们自己写给用户的（网关那句
 * 「与模型服务的连接中断，重试多次仍未成功。」）是中文，内核与传输层的不是。
 */
export function turnFailureCopy(
  message: string,
  details?: string,
): { readonly text: string; readonly detail?: string } {
  const raw = details ? `${message}（${details}）` : message;
  if (/[\u4e00-\u9fa5]/.test(message)) return { text: raw };
  return {
    text: '这次失败的原因只有技术信息，已折进下面的「详情」。可以先重试；反复出现就换一个模型。',
    detail: raw,
  };
}

/**
 * 经 IPC 回来的拒绝被 Electron 包成这个样子，**内层还可能再套一层我们自己的错误类**：
 *   `Error invoking remote method 'evowork:interrupt': JsonRpcCallError: turn/interrupt 失败 (code -32600)`
 */
const IPC_WRAPPER = /^Error invoking remote method '[^']*':\s*/;

/** 一眼就知道不是写给用户看的东西。命中任何一条就改用兜底文案。 */
const INTERNAL_MARKERS: readonly RegExp[] = [
  /Error invoking remote method/,
  /\w+Error:/, // JsonRpcCallError / TransportClosedError / TypeError…
  /\bcode -?\d{3,}\b/, // 裸 JSON-RPC 错误码
  /\n\s*at\s/, // 堆栈
];

/**
 * 动作失败时**给用户看的那句话**。
 *
 * `error.message` 不能原样显示。2026-09-27 的用户截图里，点「停止」失败之后弹出来的是
 * `Error invoking remote method 'evowork:interrupt': JsonRpcCallError: turn/interrupt 失败 (code -32600)`
 * —— 它同时泄漏了内部通道名、内部错误类和裸错误码，而对用户没有任何可操作信息。
 * 此前的实现是「有 message 就显示 message」，于是调用方精心写的兜底文案几乎永远轮不到。
 *
 * 规则：先剥掉 Electron 的包装；剩下的部分还带内部痕迹的话，就用**调用方为这个动作写的
 * 兜底文案** —— 那是为这次失败写的人话，比任何通用改写都准。
 *
 * **不碰回合失败卡**：那条路（`turn-failed` 的 summary）是 03 §8 的明确决定 ——
 * 把内核给的原因原样显示，因为 `connection refused` 与 `401` 对用户是不同的两件事。
 * 两者的区别是：那边显示的是**内核写的原因**，这边泄漏的是**传输层的包装**。
 */
export function actionErrorText(error: unknown, fallback: string): string {
  const raw = error instanceof Error ? error.message.trim() : '';
  if (raw === '') return fallback;
  const unwrapped = raw.replace(IPC_WRAPPER, '').trim();
  if (unwrapped === '') return fallback;
  if (INTERNAL_MARKERS.some((re) => re.test(unwrapped))) return fallback;
  return unwrapped;
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

/**
 * 「我分享的」那一列的文案。
 *
 * 已撤销 / 已过期说的是**结果**而不是剩余时间 —— 一条已经失效的链接旁边写着
 * "还有 3 小时"是这一页最容易出的错。
 */
function expiresLabelOf(row: ShareListView['rows'][number]): string {
  if (row.state === 'revoked') return '已撤销';
  if (row.state === 'expired') return '已过期';
  const left = row.expiresAt - Date.now();
  const hours = Math.floor(left / 3_600_000);
  if (hours >= 24) return `还有 ${Math.floor(hours / 24)} 天`;
  if (hours >= 1) return `还有 ${hours} 小时`;
  return `不到 1 小时`;
}
