use crate::blob::BlobRef;
use crate::budget::BudgetSpec;
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
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct RunCompleted {
    pub status: CompletionStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary_ref: Option<BlobRef>,
}
