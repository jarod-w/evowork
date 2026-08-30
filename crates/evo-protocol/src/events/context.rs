use crate::blob::BlobRef;
use crate::ids::CiteId;
use crate::taint::{TaintLevel, TrustLevel};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
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

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct ContextAssembled {
    pub turn: u32,
    pub profile: String,
    pub blocks: Vec<ContextBlock>,
    /// blocks 中最高污点
    pub taint_level: TaintLevel,
    pub total_token_estimate: u64,
}

/// 上下文压缩事件。**本切片不产生**——压缩机制排在后续切片——但字段现在
/// 就定死：红线③要求事件目录一次定完，不许「等真做压缩那天再补字段」。
///
/// 压缩必须表达成新事件，原始 `context.assembled` 永不删除或改写（01 §一②，
/// 与 codex 的原地 `Compacted` 是有意的对立）：`from_seq`/`to_seq` 标出被
/// 压缩覆盖的原始事件区间，`summary_ref` 是压缩后的摘要正文——摘要本身也
/// 可能夹带业务上下文（例如摘要里复述了客户名），一律进 blob，不进
/// payload（红线①）；`summary_cite_id` 让这段摘要也能被后续引用溯源，
/// 不至于变成一段查不到出处的文本。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct ContextCompacted {
    pub from_seq: u64,
    pub to_seq: u64,
    pub summary_ref: BlobRef,
    pub summary_cite_id: CiteId,
}
