use crate::blob::BlobRef;
use crate::ids::ToolId;
use crate::taint::TaintLevel;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ModelParams {
    pub temperature: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_tokens: Option<u32>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ModelRequested {
    pub turn: u32,
    pub provider: String,
    pub model: String,
    pub params: ModelParams,
    /// 回放时重建请求并比对；不一致说明装配器有非确定性
    pub request_digest: String,
    /// messages 全文进 blob
    pub messages_ref: BlobRef,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Usage {
    pub input: u64,
    pub output: u64,
    #[serde(default)]
    pub cache_read: u64,
    #[serde(default)]
    pub cache_write: u64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ModelResponded {
    pub turn: u32,
    pub response_ref: BlobRef,
    pub response_hash: String,
    pub usage: Usage,
    pub stop_reason: String,
    pub latency_ms: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PlanIntent {
    ToolCall,
    Clarify,
    Finish,
}

/// runtime 从 model.responded 解析出的结构化决策。内核只吃这个，不碰模型原文。
///
/// `call` 是对 01 §4.3 的新增 optional 字段：内核要发 RequestEffect，
/// 必须从这里拿到工具名与参数引用（class / targets 由 Gateway 从 manifest 补全）。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct PlanStep {
    pub turn: u32,
    pub intent: PlanIntent,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rationale_ref: Option<BlobRef>,
    pub taint_inherited: TaintLevel,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub call: Option<PlannedCall>,
}

/// 内核能看到的「要调哪个工具」。不含 class / targets——那些来自 manifest，内核看不到。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct PlannedCall {
    pub tool: ToolId,
    pub params_ref: BlobRef,
    pub params_digest: String,
}
