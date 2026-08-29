use crate::blob::BlobRef;
use crate::effect::{EffectClass, EgressRef, ResourceOp, ResourceRef};
use crate::ids::{CiteId, EffectId, ExecutorId, LeaseId, ToolId};
use crate::taint::TaintLevel;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ToolRequested {
    pub effect_id: EffectId,
    pub turn: u32,
    pub tool: ToolId,
    pub params_ref: BlobRef,
    pub params_digest: String,
    pub class: EffectClass,
    pub declared_targets: Vec<ResourceRef>,
    pub declared_egress: Vec<EgressRef>,
    pub reversible: bool,
    #[serde(default)]
    pub cites_referenced: Vec<CiteId>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PolicyDecisionKind {
    Allow,
    Deny,
    RequireApproval,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PolicyEvaluated {
    pub effect_id: EffectId,
    pub decision: PolicyDecisionKind,
    #[serde(default)]
    pub rules_hit: Vec<String>,
    pub policy_ver: String,
    pub reason_code: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ImpactTarget {
    pub resource: ResourceRef,
    pub op: ResourceOp,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail_ref: Option<BlobRef>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ImpactPrecision {
    Exact,
    DeclaredOnly,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ImpactEstimated {
    pub effect_id: EffectId,
    pub targets: Vec<ImpactTarget>,
    #[serde(default)]
    pub externals: Vec<EgressRef>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub est_cost_micros: Option<u64>,
    pub precision: ImpactPrecision,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExecutionMode {
    Live,
    DryRun,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct EffectDispatched {
    pub effect_id: EffectId,
    pub executor_id: ExecutorId,
    pub lease_id: LeaseId,
    pub mode: ExecutionMode,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolResultStatus {
    Ok,
    Error,
    DryRun,
    Denied,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ToolResult {
    pub effect_id: EffectId,
    pub status: ToolResultStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_ref: Option<BlobRef>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bytes: Option<u64>,
    /// 外部返回一律 tainted
    pub taint: TaintLevel,
    #[serde(default)]
    pub cites_produced: Vec<CiteId>,
    /// 与 declared_targets 比对，供应链行为异常的数据基础。POC 期只记录不拦截。
    #[serde(default)]
    pub actual_targets: Vec<ResourceRef>,
    #[serde(default)]
    pub actual_egress: Vec<EgressRef>,
}
