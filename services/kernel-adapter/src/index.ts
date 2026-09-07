/**
 * @evowork/kernel-adapter —— app-server 协议适配层（M2a）。
 *
 * **K2 边界的唯一实现处。** 前端只调 `createAdapter()` 暴露的语义化 API，
 * 不认识协议方法名，也不认识实验方法是否可用这件事。
 *
 * 文件分工：
 *   · `session.ts`      进程生命周期 · 握手 · 心跳 · 退避重启 · 会话恢复（09 §1 / §5）
 *   · `capabilities.ts` 实验方法可用性与降级表（09 §3.3，含对 F18 的修订）
 *   · `events.ts`       事件流 → 落库 → UI → 副作用，顺序固定（09 §3.4）
 *   · `approvals.ts`    审批路由与两套超时策略（10 §3，F14）
 *   · `scenario.ts`     场景 + 模式 + 覆盖 → turn/start 参数（03 §2.4，F3）
 *   · `title.ts`        任务标题的就地派生（内核不自动命名，见该文件头注释）
 *   · `identity.ts`     产品身份：关掉 openai-docs；底稿正文在 config/prompts/
 */
export {
  createAdapter,
  type Adapter,
  type AdapterOptions,
  type Catalog,
  type TaskListItem,
  type Workspace,
} from './adapter.js';
export {
  createApprovalRouter,
  INTERACTIVE_POLICY,
  UNATTENDED_POLICY,
  type ApprovalDecision,
  type ApprovalKind,
  type ApprovalReply,
  type ApprovalRouter,
  type ApprovalRouterOptions,
  type ApprovalTimeoutPolicy,
  type PendingApproval,
} from './approvals.js';
export {
  assertDegradationCoverage,
  CapabilityRegistry,
  DEGRADATION,
  FIELD_DEGRADATION,
  PROBE_ON_STARTUP,
  type CapabilityReport,
  type CapabilityState,
  type Degradation,
  type Prober,
} from './capabilities.js';
export { createSpawnLauncher, type SpawnLauncherOptions } from './launcher.js';
export {
  createEventRouter,
  type DeltaChannel,
  type EventRouter,
  type EventRouterOptions,
  type SideEffect,
  type UiEvent,
} from './events.js';
export {
  BUILTIN_SCENARIOS,
  composeInstructions,
  expandTurnStart,
  MODES,
  type ComposerOverrides,
  type ExpandContext,
  type ExpandResult,
  type ModeDefinition,
  type ModeId,
  type Scenario,
  type ScenarioChip,
} from './scenario.js';
export { deriveTaskTitle, titleFromText, TITLE_MAX_CHARS } from './title.js';
export { DISABLE_OPENAI_DOCS_CONFIG } from './identity.js';
export {
  KernelSession,
  type KernelLauncher,
  type KernelProcess,
  type KernelSessionOptions,
  type SessionNotice,
  type SessionPhase,
} from './session.js';
