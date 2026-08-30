use crate::blob::BlobRef;
use crate::budget::BudgetSpec;
use crate::event::Actor;
use crate::ids::RunId;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PrincipalRef {
    pub kind: String,
    pub id: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TriggerKind {
    Manual,
    Schedule,
    Webhook,
    File,
    Condition,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct TriggerRef {
    pub kind: TriggerKind,
    pub reference: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct RunCreated {
    pub run_id: RunId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_run_id: Option<RunId>,
    pub workspace_id: String,
    pub principal: PrincipalRef,
    pub trigger: TriggerRef,
    pub budget: BudgetSpec,
    #[serde(default)]
    pub labels: BTreeMap<String, String>,
}

/// 意图声明。原文进 blob，事件里只留长度、语言与引用。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct IntentDeclared {
    pub intent_ref: BlobRef,
    pub char_len: u64,
    pub lang: String,
    pub source: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CompletionStatus {
    Ok,
    Partial,
    /// 新增变体，additive（事件 schema 只增不改）。内核 `decide` 在
    /// `PlanIntent::ToolCall` 但解析不出合法 `call` 时会产出
    /// `RunStatus::Failed`；daemon 必须把这个状态原样写进 `run.completed`
    /// 事件，而不是像此前那样一律写 `Ok`——否则失败的 run 在 Log 里被
    /// 记成成功，回放也读不出真相。
    Failed,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct RunCompleted {
    pub status: CompletionStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary_ref: Option<BlobRef>,
}

/// 为什么这一批事件存在：M2 的控制流反转——挂起/拒绝不再是 `Err` 掀翻 turn
/// 循环，而是往 Log 追加一个终结/暂停事件，`reduce` 据此置状态，循环干净
/// 结束。`run.suspended` 是这条反转的落点。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SuspendReason {
    /// Gateway 判定某个 effect 需要人批准（对应一条 `approval.requested`）
    AwaitingApproval,
    /// 澄清式追问：需要人回答问题，不一定经过审批队列
    AwaitingHuman,
    /// 内核 `decide` 自行判出预算超限；不经 Gateway
    BudgetExhausted,
    /// 人工暂停，不归入以上任何一类具体原因
    Paused,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct RunSuspended {
    pub reason: SuspendReason,
    /// 挂起细节（例如超的是哪个预算维度、差多少）：可能带业务上下文，
    /// 一律 blob，不进 payload（红线①）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail_ref: Option<BlobRef>,
}

/// 从挂起恢复。`from_seq` 记录本次恢复重新驱动 turn 循环时看到的下一个
/// 待处理 seq——回放时用它核对恢复点，而不是隐式推断「挂起事件之后紧接
/// 着就是恢复点」，因为两者之间允许插入例如 `approval.granted` 这类事件。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RunResumed {
    pub by: Actor,
    pub from_seq: u64,
}

/// 内核/runtime 判定的故障详情。`code` 是稳定的错误分类，供告警与统计按
/// 类型聚合；`message_ref` 是人类可读的原文（可能带栈信息或工具错误回显，
/// 可能夹带业务参数），一律 blob；`retryable` 供恢复逻辑判断要不要自动
/// 重试还是必须人工介入。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ErrorDetail {
    pub code: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message_ref: Option<BlobRef>,
    pub retryable: bool,
}

/// run 在 `at_seq` 处失败终结。是「挂起路径上一个 `Err` 都不许有」这条约束
/// 的终点：真正的故障（IO 失败、模型解析不出来、预算表查不到……）落到这里
/// 成为一条 Log 事件，而不是掀翻调用栈、把 run 晾在没有终结事件的状态里。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct RunFailed {
    pub at_seq: u64,
    pub error: ErrorDetail,
}
