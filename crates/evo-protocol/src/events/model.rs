use crate::blob::BlobRef;
use crate::events::clarification::ClarificationOption;
use crate::ids::ToolId;
use crate::taint::TaintLevel;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
pub struct ModelParams {
    pub temperature: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_tokens: Option<u32>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
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

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct Usage {
    pub input: u64,
    pub output: u64,
    #[serde(default)]
    pub cache_read: u64,
    #[serde(default)]
    pub cache_write: u64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
pub struct ModelResponded {
    pub turn: u32,
    pub response_ref: BlobRef,
    pub response_hash: String,
    pub usage: Usage,
    pub stop_reason: String,
    pub latency_ms: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
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
///
/// `clarification` 与 `call` 对称：`AskClarification` 分支要问的问题正文
/// 与选项，同样必须从这里拿，不能靠 daemon 拿着 `response_ref` 再对模型
/// 原文 `parse_plan` 一遍——那是两处消费同一份解析结果、只靠人记得保持
/// 同步的脆弱模式。`call_model` 已经 `parse_plan` 过一次，这里把那次解
/// 析的产物直接落盘。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
pub struct PlanStep {
    pub turn: u32,
    pub intent: PlanIntent,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rationale_ref: Option<BlobRef>,
    pub taint_inherited: TaintLevel,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub call: Option<PlannedCall>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub clarification: Option<PlannedClarification>,
}

/// 内核能看到的「要调哪个工具」。不含 class / targets——那些来自 manifest，内核看不到。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
pub struct PlannedCall {
    pub tool: ToolId,
    pub params_ref: BlobRef,
    pub params_digest: String,
}

/// 内核能看到的「要问哪个问题」，与 `PlannedCall` 同构。
///
/// 问题正文与全部选项的展示文案（含 `label`）**不在这里**——那些是自由
/// 文本，一律进 `prompt_ref` 指向的 blob（形状同
/// [`ClarificationRequested::prompt_ref`][crate::events::clarification::ClarificationRequested::prompt_ref]
/// 的建议）。`options` 里的 [`ClarificationOption`] 本身已经不含
/// `label`（见它的文档：那道红线是历史教训），所以可以直接进事件 payload。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
pub struct PlannedClarification {
    pub prompt_ref: BlobRef,
    pub options: Vec<ClarificationOption>,
}
