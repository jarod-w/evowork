use crate::blob::BlobRef;
use crate::ids::{CiteId, EffectId, RunId, ToolId};
use crate::taint::TaintLevel;
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EffectClass {
    Read,
    Write,
    External,
    Compute,
}

impl EffectClass {
    /// dry-run 下是否降级为 record-only。Read / Compute 照常执行，否则预估不准。
    pub fn suppressed_in_dry_run(self) -> bool {
        matches!(self, Self::Write | Self::External)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ResourceOp {
    Read,
    Create,
    Update,
    Delete,
}

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub struct ResourceRef {
    pub kind: String,
    pub id: String,
}

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub struct EgressRef {
    pub host: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub port: Option<u16>,
}

/// 能力令牌。POC 期只做 scope 字符串匹配（02 §2 步骤 ②）。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct CapabilityToken {
    pub subject: String,
    pub scopes: Vec<String>,
}

impl CapabilityToken {
    pub fn allows(&self, tool: &ToolId) -> bool {
        self.scopes.iter().any(|s| s == "*" || s == tool.as_str())
    }
}

/// Gateway 读得懂的「声明」，不是待执行的闭包（02 §1）。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct EffectRequest {
    pub effect_id: EffectId,
    pub run_id: RunId,
    pub turn: u32,
    pub tool: ToolId,
    pub params_ref: BlobRef,
    pub params_digest: String,

    // 以下由工具 manifest 静态推导，由 Gateway 在建请求时填入
    pub class: EffectClass,
    pub targets: Vec<ResourceRef>,
    pub egress: Vec<EgressRef>,
    pub reversible: bool,

    // 以下由 runtime 填入
    pub taint: TaintLevel,
    pub cites_referenced: Vec<CiteId>,
    pub capability: CapabilityToken,
}
