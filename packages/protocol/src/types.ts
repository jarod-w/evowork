/**
 * app-server v2 协议形状的 TypeScript 子集。
 *
 * **手写而不是从内核生成**（见本包 README）：内核能用 `ts-rs` 导出全量类型，但那会丢掉
 * 「我们依赖协议的哪一部分」这条信息。手写子集的清单本身就是依赖面。
 *
 * 所有形状于 2026-09-05 在 `89a4eec6da` 上对照 Rust 定义写成；带 F 编号的地方是
 * docs/design/README.md §4 里有实测记录的断言，改动前先看那里。
 *
 * 约定：内核用 serde `rename_all = "camelCase"`，所以线上字段一律 camelCase。
 * 可选字段用 `?`，可为 null 的用 `| null` —— 两者在内核里是不同的东西
 * （`#[ts(optional = nullable)]` 同时是可缺省与可为 null），我们统一写成 `?: T | null`。
 */

// ─────────────────────────────── 握手 ───────────────────────────────

export interface ClientInfo {
  readonly name: string;
  readonly title?: string | null;
  readonly version: string;
}

export interface InitializeCapabilities {
  /** K2：不声明它，所有实验方法都会被拒（错误码 -32600 + "requires experimentalApi capability"） */
  readonly experimentalApi: boolean;
  readonly requestAttestation?: boolean;
}

export interface InitializeParams {
  readonly clientInfo: ClientInfo;
  readonly capabilities?: InitializeCapabilities;
}

/** 只取我们用得到的字段；内核返回的比这多。 */
export interface InitializeResponse {
  readonly userAgent?: string;
  readonly serverInfo?: { readonly name?: string; readonly version?: string };
}

// ─────────────────────────────── 线程与回合 ───────────────────────────────

/** F7：`ThreadStatus` 只有这四种，**已完成 / 失败不在其中**（04 §2.1）。 */
export type ThreadStatus =
  | 'notLoaded'
  | 'idle'
  | 'systemError'
  | { readonly active: { readonly activeFlags: readonly ThreadActiveFlag[] } };

export type ThreadActiveFlag = 'waitingOnApproval' | 'waitingOnUserInput';

/** F12：`TurnStatus` 含 `interrupted` —— 清单里没有这一态但用户会遇到（04 §2.2）。 */
export type TurnStatus = 'completed' | 'interrupted' | 'failed' | 'inProgress';

export interface TurnError {
  readonly message: string;
  readonly codexErrorInfo?: unknown;
  readonly additionalDetails?: string | null;
}

export interface Turn {
  readonly id: string;
  readonly items: readonly ThreadItem[];
  readonly itemsView?: 'notLoaded' | 'summary' | 'full';
  readonly status: TurnStatus;
  readonly error?: TurnError | null;
  readonly startedAt?: number | null;
  readonly completedAt?: number | null;
  readonly durationMs?: number | null;
}

export interface ThreadSection {
  readonly id: string;
  readonly name?: string | null;
  readonly kind?: string;
}

/** F9：`extra` 是空结构体 —— 协议没有客户端元数据槽，派生状态只能落本机投影表。 */
export interface Thread {
  readonly id: string;
  readonly sessionId: string;
  readonly forkedFromId?: string | null;
  readonly parentThreadId?: string | null;
  readonly preview: string;
  readonly ephemeral: boolean;
  readonly section?: ThreadSection | null;
  readonly sectionEnteredAt?: number | null;
  readonly projectId?: string | null;
  readonly modelProvider: string;
  readonly model?: string | null;
  readonly reasoningEffort?: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly recencyAt?: number | null;
  readonly status: ThreadStatus;
  readonly path?: string | null;
  readonly cwd: string;
  readonly cliVersion?: string;
  readonly originator?: string | null;
  readonly source?: string;
  readonly name?: string | null;
  readonly turns: readonly Turn[];
  readonly extra?: Record<string, never> | null;
}

// ─────────────────────────────── 用户输入 ───────────────────────────────

/** F6：**没有文档类型**。PDF/Office 一律先过本机解析管道（08 §3）。 */
export type UserInput =
  | { readonly type: 'text'; readonly text: string; readonly textElements?: readonly unknown[] }
  | { readonly type: 'image'; readonly imageUrl: string; readonly detail?: string }
  | { readonly type: 'localImage'; readonly path: string; readonly detail?: string }
  | { readonly type: 'audio'; readonly audioUrl: string }
  | { readonly type: 'localAudio'; readonly path: string }
  | { readonly type: 'skill'; readonly name: string; readonly path: string }
  | { readonly type: 'mention'; readonly name: string; readonly path: string };

// ─────────────────────────────── 条目（19 类，F13）───────────────────────────────

/**
 * F13：`ThreadItem` 共 19 个变体。对话区不是"消息 + 工具"两类 —— 04 §5.2 逐类给了渲染规范。
 *
 * 这里只对**渲染必需**的字段建模，其余留在 `[key: string]: unknown` 里：
 * 全量建模 19 个变体的每个字段会让每次上游加字段都变成一次类型修订，而我们并不读那些字段。
 * 未知变体不会丢失（`ThreadItemUnknown`），04 §5.2 要求它渲染成一行「新类型事件」而不是静默丢弃。
 */
export type ThreadItemType =
  | 'userMessage'
  | 'hookPrompt'
  | 'agentMessage'
  | 'functionCallOutput'
  | 'plan'
  | 'reasoning'
  | 'commandExecution'
  | 'fileChange'
  | 'mcpToolCall'
  | 'dynamicToolCall'
  | 'collabAgentToolCall'
  | 'subAgentActivity'
  | 'webSearch'
  | 'imageView'
  | 'sleep'
  | 'imageGeneration'
  | 'enteredReviewMode'
  | 'exitedReviewMode'
  | 'contextCompaction';

/** 19 类的完整清单，用于「上游是不是加了第 20 类」这个断言（scripts/kernel-drift.mjs 的 F13）。 */
export const THREAD_ITEM_TYPES: readonly ThreadItemType[] = [
  'userMessage',
  'hookPrompt',
  'agentMessage',
  'functionCallOutput',
  'plan',
  'reasoning',
  'commandExecution',
  'fileChange',
  'mcpToolCall',
  'dynamicToolCall',
  'collabAgentToolCall',
  'subAgentActivity',
  'webSearch',
  'imageView',
  'sleep',
  'imageGeneration',
  'enteredReviewMode',
  'exitedReviewMode',
  'contextCompaction',
] as const;

export interface ThreadItemBase {
  readonly id: string;
  readonly type: string;
  readonly [key: string]: unknown;
}

export interface UserMessageItem extends ThreadItemBase {
  readonly type: 'userMessage';
  readonly clientId?: string | null;
  readonly content: readonly UserInput[];
}

export interface AgentMessageItem extends ThreadItemBase {
  readonly type: 'agentMessage';
  readonly text?: string;
}

export interface PlanItem extends ThreadItemBase {
  readonly type: 'plan';
  readonly steps?: readonly { readonly step: string; readonly status: string }[];
}

export interface CommandExecutionItem extends ThreadItemBase {
  readonly type: 'commandExecution';
  readonly command?: string;
  readonly cwd?: string;
  readonly exitCode?: number | null;
  readonly status?: string;
}

export interface FileChangeItem extends ThreadItemBase {
  readonly type: 'fileChange';
  readonly changes?: readonly { readonly path: string; readonly kind?: string }[];
}

export type ThreadItem =
  | UserMessageItem
  | AgentMessageItem
  | PlanItem
  | CommandExecutionItem
  | FileChangeItem
  | ThreadItemBase;

// ─────────────────────────────── 请求参数与响应 ───────────────────────────────

export interface ThreadStartParams {
  readonly cwd?: string;
  readonly model?: string;
  readonly modelProvider?: string;
  /** F5：与 `sandbox` 互斥 */
  readonly permissions?: string;
  readonly sandbox?: 'readOnly' | 'workspaceWrite' | 'dangerFullAccess';
  readonly approvalPolicy?: AskForApproval;
  readonly projectId?: string;
}

export interface ThreadStartResponse {
  readonly thread: Thread;
  readonly model: string;
  readonly modelProvider: string;
  readonly cwd: string;
}

export type AskForApproval = 'untrusted' | 'onFailure' | 'onRequest' | 'never' | 'granular';

/** F2：`ModeKind` 只有两个值 —— Craft/Ask 都映射到 `default`，Plan 映射到 `plan`（D8）。 */
export type ModeKind = 'plan' | 'default';

/** F1：`settings.developer_instructions` 优先于 model / effort / developer instructions。 */
export interface CollaborationMode {
  readonly mode?: ModeKind;
  readonly settings?: {
    readonly model?: string;
    readonly reasoningEffort?: string;
    readonly developerInstructions?: string | null;
  };
}

export interface TurnStartParams {
  readonly threadId: string;
  readonly input: readonly UserInput[];
  readonly clientUserMessageId?: string;
  readonly cwd?: string;
  /** F5：不与 `sandboxPolicy` 同传 */
  readonly permissions?: string;
  readonly approvalPolicy?: AskForApproval;
  readonly model?: string;
  readonly effort?: string;
  readonly collaborationMode?: CollaborationMode;
}

export interface TurnStartResponse {
  readonly turn: Turn;
}

export type ThreadSortKey = 'createdAt' | 'updatedAt' | 'recencyAt' | 'sectionPosition';

/**
 * F8：**没有状态过滤，也没有日期区间过滤**。这就是 `thread_projection` 表存在的理由。
 * （2026-09-05 复核时上游又多了 `originators` 参数，但缺的那两个没有自己长出来。）
 */
export interface ThreadListParams {
  readonly cursor?: string;
  readonly limit?: number;
  readonly sortKey?: ThreadSortKey;
  readonly sortDirection?: 'asc' | 'desc';
  readonly archived?: boolean;
  readonly sectionId?: string | null;
  readonly projectId?: string | null;
  readonly cwd?: { readonly paths: readonly string[] } | string;
  readonly searchTerm?: string;
  readonly parentThreadId?: string;
  readonly ancestorThreadId?: string;
  readonly modelProviders?: readonly string[];
  readonly sourceKinds?: readonly string[];
  /** 只读状态库、不扫 rollout —— 对账时用（09 §4.1 的一致性校正） */
  readonly useStateDbOnly?: boolean;
}

export interface ThreadListResponse {
  readonly data: readonly Thread[];
  readonly nextCursor?: string | null;
  readonly backwardsCursor?: string | null;
}

export interface ThreadItemsListParams {
  readonly threadId: string;
  readonly cursor?: string;
  readonly limit?: number;
}

export interface ThreadItemsListResponse {
  readonly data: readonly ThreadItem[];
  readonly nextCursor?: string | null;
}

/** F4：`allowed: false` = 「这个档位存在但你不能选」（企业策略置灰，10 §2.1）。 */
export interface PermissionProfileSummary {
  readonly id: string;
  readonly description?: string | null;
  readonly allowed: boolean;
}

export interface PermissionProfileListResponse {
  readonly data: readonly PermissionProfileSummary[];
}

/**
 * F18：`experimentalFeature/list` 返回的是**内核运行时功能开关**（`shell_tool`、`unified_exec`
 * 这类，141 项），**不是**实验协议方法的可用性。降级判定不能靠它 —— 见 09 §3.3 的修订。
 */
export interface ExperimentalFeature {
  readonly name: string;
  readonly stage: 'beta' | 'underDevelopment' | 'stable' | 'deprecated' | 'removed';
  readonly enabled: boolean;
  readonly displayName?: string | null;
  readonly description?: string | null;
}

export interface ExperimentalFeatureListResponse {
  readonly data: readonly ExperimentalFeature[];
  readonly nextCursor?: string | null;
}

export interface TokenUsageBreakdown {
  readonly inputTokens?: number;
  readonly cachedInputTokens?: number;
  readonly outputTokens?: number;
  readonly reasoningOutputTokens?: number;
  readonly totalTokens?: number;
}

export interface ThreadTokenUsage {
  readonly total: TokenUsageBreakdown;
  readonly last: TokenUsageBreakdown;
  readonly modelContextWindow?: number | null;
}

// ─────────────────────────────── 通知负载 ───────────────────────────────

export interface ThreadStartedNotification {
  readonly thread: Thread;
}
export interface ThreadStatusChangedNotification {
  readonly threadId: string;
  readonly status: ThreadStatus;
}
export interface ThreadNameUpdatedNotification {
  readonly threadId: string;
  readonly name?: string | null;
}
export interface TurnStartedNotification {
  readonly threadId: string;
  readonly turn: Turn;
}
export interface TurnCompletedNotification {
  readonly threadId: string;
  readonly turn: Turn;
}
export interface TurnPlanUpdatedNotification {
  readonly threadId: string;
  readonly turnId: string;
  readonly steps?: readonly { readonly step: string; readonly status: string }[];
}
export interface TurnDiffUpdatedNotification {
  readonly threadId: string;
  readonly turnId: string;
  readonly diff?: string;
}
export interface ItemStartedNotification {
  readonly threadId: string;
  readonly turnId: string;
  readonly item: ThreadItem;
  readonly startedAtMs: number;
}
export interface ItemCompletedNotification {
  readonly threadId: string;
  readonly turnId: string;
  readonly item: ThreadItem;
  readonly completedAtMs: number;
}
export interface ThreadTokenUsageUpdatedNotification {
  readonly threadId: string;
  readonly turnId: string;
  readonly tokenUsage: ThreadTokenUsage;
}

// ─────────────────────────────── 服务端请求（F14）───────────────────────────────

/**
 * 命令审批的可选回复（`v2/item.rs`）。
 *
 * `decline` 与 `cancel` 的区别必须在 UI 上说清（10 §3.1）：前者只拒绝这一次、agent 可换路；
 * 后者结束整个动作。
 */
export type CommandApprovalDecision =
  | 'accept'
  | 'acceptForSession'
  | 'decline'
  | 'cancel'
  | { readonly acceptWithExecpolicyAmendment: unknown }
  | { readonly applyNetworkPolicyAmendment: unknown };

export type FileChangeApprovalDecision = 'accept' | 'acceptForSession' | 'decline' | 'cancel';

export interface CommandExecutionRequestApprovalParams {
  readonly threadId: string;
  readonly turnId?: string;
  readonly itemId: string;
  readonly command?: string;
  readonly cwd?: string;
  /** 「为什么需要确认」是审批卡的必填项（10 §3.2）：没有理由的审批等于让用户瞎点 */
  readonly reason?: string;
  readonly [key: string]: unknown;
}

export interface FileChangeRequestApprovalParams {
  readonly threadId: string;
  readonly turnId?: string;
  readonly itemId: string;
  readonly changes?: readonly { readonly path: string; readonly kind?: string }[];
  readonly reason?: string;
  readonly [key: string]: unknown;
}

export interface ToolRequestUserInputParams {
  readonly threadId: string;
  readonly turnId?: string;
  readonly itemId: string;
  readonly question?: string;
  readonly options?: readonly { readonly id: string; readonly label?: string }[];
  readonly [key: string]: unknown;
}
