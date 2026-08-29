use crate::ids::CiteId;
use crate::taint::{TaintLevel, TrustLevel};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ContextBlock {
    pub cite_id: CiteId,
    pub source: String,
    pub trust: TrustLevel,
    pub scope: String,
    pub content_hash: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub span: Option<String>,
    pub token_estimate: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ContextAssembled {
    pub turn: u32,
    pub profile: String,
    pub blocks: Vec<ContextBlock>,
    /// blocks 中最高污点
    pub taint_level: TaintLevel,
    pub total_token_estimate: u64,
}
