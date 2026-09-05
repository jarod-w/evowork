/**
 * EvoWork 用到的 app-server 方法清单 —— **同时是依赖面的声明**。
 *
 * 内核共有 158 个客户端请求方法、82 个服务端通知、9 个服务端请求（2026-09-05 @ `89a4eec6da` 实测）。
 * 这里只列我们真正调用的那些。这么做的收益是 R2 的影响面可见：上游改了不在这张表里的东西，
 * 与我们无关；改了表里的，`scripts/kernel-drift.mjs` 与类型检查会指出来。
 *
 * `EXPERIMENTAL` 标记来自内核源码里的 `#[experimental("…")]` 属性。它决定两件事：
 *   ① `initialize` 必须声明 `capabilities.experimentalApi = true`（K2），否则调用直接被拒；
 *   ② 这些方法要经 09 §3.3 的降级表兜底 —— 上游随时可能改名或移除。
 */

/** 稳定方法：上游承诺兼容性的那部分。 */
export const METHOD = {
  // 握手
  initialize: 'initialize',
  /** 客户端通知。**注意方法名是 `initialized`，不是 `notifications/initialized`** —— 见 F17 */
  initialized: 'initialized',

  // 线程生命周期
  threadStart: 'thread/start',
  threadResume: 'thread/resume',
  threadFork: 'thread/fork',
  threadRead: 'thread/read',
  threadList: 'thread/list',
  threadArchive: 'thread/archive',
  threadUnarchive: 'thread/unarchive',
  threadDelete: 'thread/delete',
  threadSetName: 'thread/name/set',
  threadSectionMove: 'thread/section/move',
  threadMetadataUpdate: 'thread/metadata/update',
  threadCompactStart: 'thread/compact/start',
  threadRollback: 'thread/rollback',
  threadRevert: 'thread/revert',

  // 条目与回合
  threadItemsList: 'thread/items/list',
  threadTurnsList: 'thread/turns/list',
  turnStart: 'turn/start',
  turnSteer: 'turn/steer',
  turnInterrupt: 'turn/interrupt',

  // 目标与预算（Q11：不自建，用内核的 ThreadGoal.budget）
  threadGoalSet: 'thread/goal/set',
  threadGoalGet: 'thread/goal/get',
  threadGoalClear: 'thread/goal/clear',

  // 分组
  threadSectionList: 'threadSection/list',
  threadSectionCreate: 'threadSection/create',
  threadSectionUpdate: 'threadSection/update',
  threadSectionDelete: 'threadSection/delete',

  // 目录与能力
  modelList: 'model/list',
  modelProviderCapabilitiesRead: 'modelProvider/capabilities/read',
  permissionProfileList: 'permissionProfile/list',
  experimentalFeatureList: 'experimentalFeature/list',
  skillsList: 'skills/list',
  pluginInstalled: 'plugin/installed',
  mcpServerStatusList: 'mcpServerStatus/list',

  // 文件系统（工作空间文件视图，04 §6.2）
  fsReadDirectory: 'fs/readDirectory',
  fsReadFile: 'fs/readFile',
  fsWatch: 'fs/watch',
  fsUnwatch: 'fs/unwatch',

  // 记忆（09 §2：只走协议，不读文件）
  memoriesRead: 'memories/read',
  memoriesWrite: 'memories/write',

  // 审批与守护
  threadApproveGuardianDeniedAction: 'thread/approveGuardianDeniedAction',
} as const;

/**
 * 实验方法。每一项都必须在 09 §3.3 的降级表里有对应的兜底路径。
 *
 * 这张表与 `DEGRADATION` 是配对的：新增一个实验方法就必须给它一条降级路径，
 * 否则「实验方法不可用时白屏」会以最平常的方式发生。
 */
export const EXPERIMENTAL_METHOD = {
  projectList: 'project/list',
  projectRead: 'project/read',
  projectCreate: 'project/create',
  projectDelete: 'project/delete',

  threadQueueAdd: 'thread/queue/add',
  threadQueueList: 'thread/queue/list',
  threadQueueUpdate: 'thread/queue/update',
  threadQueueDelete: 'thread/queue/delete',
  threadQueueReorder: 'thread/queue/reorder',
  threadQueueStart: 'thread/queue/start',

  threadSearch: 'thread/search',
  threadSearchOccurrences: 'thread/searchOccurrences',
  threadTimelineList: 'thread/timeline/list',

  threadMemoryModeSet: 'thread/memoryMode/set',
  memoryReset: 'memory/reset',

  threadRealtimeStart: 'thread/realtime/start',
  threadRealtimeAppendAudio: 'thread/realtime/appendAudio',
  threadRealtimeStop: 'thread/realtime/stop',

  /** F3：只返回硬编码的 plan + default，对 UI 无用 —— 列在这里是为了说明「我们不调它」 */
  collaborationModeList: 'collaborationMode/list',
} as const;

export type StableMethod = (typeof METHOD)[keyof typeof METHOD];
export type ExperimentalMethod = (typeof EXPERIMENTAL_METHOD)[keyof typeof EXPERIMENTAL_METHOD];
export type Method = StableMethod | ExperimentalMethod;

/**
 * 服务端**请求**（不是通知）——F14。
 *
 * 内核发出这些请求后会**一直等回复**，这决定了三个 UX 要求（10 §3.1）：必须有超时策略、
 * 必须能在任何页面看到待审批、Cancel 与 Decline 要分清。
 */
export const SERVER_REQUEST = {
  commandExecutionRequestApproval: 'item/commandExecution/requestApproval',
  fileChangeRequestApproval: 'item/fileChange/requestApproval',
  permissionsRequestApproval: 'item/permissions/requestApproval',
  toolRequestUserInput: 'item/tool/requestUserInput',
  /** 扩展贡献的动态工具调用（04 §5.2 #8） */
  dynamicToolCall: 'item/tool/call',
  /** MCP server 的 elicitation（05 §4） */
  mcpServerElicitation: 'mcpServer/elicitation/request',
  currentTimeRead: 'currentTime/read',
} as const;

export type ServerRequestMethod = (typeof SERVER_REQUEST)[keyof typeof SERVER_REQUEST];

/** 我们订阅的服务端通知（09 §3.4 的分发表）。 */
export const NOTIFICATION = {
  error: 'error',
  warning: 'warning',
  threadStarted: 'thread/started',
  threadStatusChanged: 'thread/status/changed',
  threadNameUpdated: 'thread/name/updated',
  threadArchived: 'thread/archived',
  threadUnarchived: 'thread/unarchived',
  threadDeleted: 'thread/deleted',
  threadClosed: 'thread/closed',
  threadReverted: 'thread/reverted',
  threadCompacted: 'thread/compacted',
  threadTokenUsageUpdated: 'thread/tokenUsage/updated',
  threadQueueChanged: 'thread/queue/changed',
  threadGoalUpdated: 'thread/goal/updated',
  turnStarted: 'turn/started',
  turnCompleted: 'turn/completed',
  turnDiffUpdated: 'turn/diff/updated',
  turnPlanUpdated: 'turn/plan/updated',
  itemStarted: 'item/started',
  itemCompleted: 'item/completed',
  itemAgentMessageDelta: 'item/agentMessage/delta',
  itemPlanDelta: 'item/plan/delta',
  itemReasoningTextDelta: 'item/reasoning/textDelta',
  itemReasoningSummaryTextDelta: 'item/reasoning/summaryTextDelta',
  itemCommandExecutionOutputDelta: 'item/commandExecution/outputDelta',
  itemFileChangePatchUpdated: 'item/fileChange/patchUpdated',
  itemMcpToolCallProgress: 'item/mcpToolCall/progress',
  itemAutoApprovalReviewStarted: 'item/autoApprovalReview/started',
  itemAutoApprovalReviewCompleted: 'item/autoApprovalReview/completed',
  autoApprovalReviewStrictReviewRequired: 'autoApprovalReview/strictReviewRequired',
  skillsChanged: 'skills/changed',
  mcpServerStartupStatusUpdated: 'mcpServer/startupStatus/updated',
  projectChanged: 'project/changed',
  accountRateLimitsUpdated: 'account/rateLimits/updated',
  fsChanged: 'fs/changed',
  serverRequestResolved: 'serverRequest/resolved',
} as const;

export type NotificationMethod = (typeof NOTIFICATION)[keyof typeof NOTIFICATION];

const EXPERIMENTAL_SET: ReadonlySet<string> = new Set(Object.values(EXPERIMENTAL_METHOD));

export function isExperimentalMethod(method: string): method is ExperimentalMethod {
  return EXPERIMENTAL_SET.has(method);
}
