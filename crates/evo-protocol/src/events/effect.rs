use crate::blob::BlobRef;
use crate::effect::{EffectClass, EgressRef, ResourceOp, ResourceRef};
use crate::ids::{CiteId, EffectId, ExecutorId, LeaseId, ToolId};
use crate::taint::TaintLevel;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
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

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum PolicyDecisionKind {
    Allow,
    Deny,
    RequireApproval,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct PolicyEvaluated {
    pub effect_id: EffectId,
    pub decision: PolicyDecisionKind,
    #[serde(default)]
    pub rules_hit: Vec<String>,
    pub policy_ver: String,
    pub reason_code: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
pub struct ImpactTarget {
    pub resource: ResourceRef,
    pub op: ResourceOp,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail_ref: Option<BlobRef>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum ImpactPrecision {
    Exact,
    DeclaredOnly,
    /// 没有 preview、也解析不出任何 target。空清单在这里的意思是「不知道」，
    /// 不是「没有」。不要把这一档渲染成「无影响」。
    Unknown,
}

#[cfg(test)]
mod impact_precision_tests {
    use super::ImpactPrecision;

    #[test]
    fn old_declared_only_still_decodes() {
        let p: ImpactPrecision = serde_json::from_str("\"declared_only\"").unwrap();
        assert_eq!(p, ImpactPrecision::DeclaredOnly);
    }

    #[test]
    fn unknown_roundtrips() {
        let p = ImpactPrecision::Unknown;
        let encoded = serde_json::to_string(&p).unwrap();
        assert_eq!(encoded, "\"unknown\"");
        assert_eq!(
            serde_json::from_str::<ImpactPrecision>(&encoded).unwrap(),
            p
        );
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
pub struct ImpactEstimated {
    pub effect_id: EffectId,
    pub targets: Vec<ImpactTarget>,
    #[serde(default)]
    pub externals: Vec<EgressRef>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub est_cost_micros: Option<u64>,
    pub precision: ImpactPrecision,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum ExecutionMode {
    Live,
    DryRun,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct EffectDispatched {
    pub effect_id: EffectId,
    pub executor_id: ExecutorId,
    pub lease_id: LeaseId,
    pub mode: ExecutionMode,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum ToolResultStatus {
    Ok,
    Error,
    DryRun,
    Denied,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
pub struct ToolResult {
    pub effect_id: EffectId,
    pub status: ToolResultStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_ref: Option<BlobRef>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bytes: Option<u64>,
    /// 这次返回带回来的污点。
    ///
    /// **由执行面按来源判定**，不是由这条事件的写入者随手填的：有内容
    /// 回流的工具（`fs.read` 的文件内容、`shell.exec` 的 stdout/stderr）
    /// 一律 `Tainted`，因为工作区里的字节是谁写的、执行面看不出来；没有
    /// 任何内容回流的（`fs.write` 成功、Gateway 拒绝时补的 `Denied`、
    /// dry-run 的 `DryRun`）是 `Clean`。判定表见 `evo_exec_local` 的
    /// `outcome_taint`，那里也讲了为什么基线是 `Tainted` 而不是 `Clean`。
    ///
    /// 这一行以前写的是「外部返回一律 tainted」——那时它是一句**假的**
    /// 断言：执行面三个出口全部写死 `Clean`，`TaintLevel::Tainted` 在整个
    /// 生产代码里没有任何构造点，02 §2 步骤 ③ 的闸门因而恒为假。注释断言
    /// 了一个执行面并不满足的前提，比没有注释更糟。
    pub taint: TaintLevel,
    #[serde(default)]
    pub cites_produced: Vec<CiteId>,
    /// 与 declared_targets 比对，供应链行为异常的数据基础。POC 期只记录不拦截。
    #[serde(default)]
    pub actual_targets: Vec<ResourceRef>,
    #[serde(default)]
    pub actual_egress: Vec<EgressRef>,
}
