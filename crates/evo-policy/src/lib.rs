//! 策略钩子。**trait 是最终接口，实现是 POC 期的**。
//!
//! 换 Cedar / OPA 时只实现一个新的 PolicyHook，Gateway 一行不动。

pub mod hardcoded;

use evo_protocol::effect::{EffectClass, ResourceRef};
use evo_protocol::ids::ToolId;
use evo_protocol::taint::TaintLevel;
use serde::{Deserialize, Serialize};

pub use hardcoded::HardcodedPolicy;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RiskLevel {
    /// 可逆、仅本地、不对外 —— 直接执行，只留审计
    L1,
    /// 不可逆或影响面大，但不对外 —— 进审批队列，可批量放行
    L2,
    /// 对外发送 / 资金 / 生产系统写 —— 强制单条审批，不可批量放行
    L3,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PolicyDecision {
    Allow,
    Deny { reason_code: String },
    RequireApproval { risk: RiskLevel },
}

#[derive(Clone, Debug)]
pub struct PolicyContext {
    pub tool: ToolId,
    pub class: EffectClass,
    pub taint: TaintLevel,
    pub targets: Vec<ResourceRef>,
    pub reversible: bool,
}

pub trait PolicyHook: Send + Sync {
    fn evaluate(&self, ctx: &PolicyContext) -> PolicyDecision;

    /// 判定 + 命中的规则 id，后者进 policy.evaluated.rules_hit。
    ///
    /// **带默认实现**：换 Cedar / OPA 时只需实现 `evaluate`，
    /// 诊断信息拿不到就留空，不给新实现增加必填项。
    fn evaluate_with_trace(&self, ctx: &PolicyContext) -> (PolicyDecision, Vec<String>) {
        (self.evaluate(ctx), Vec::new())
    }

    /// 进 policy.evaluated.policy_ver
    fn version(&self) -> &str;
}

#[derive(Debug, thiserror::Error)]
pub enum PolicyError {
    #[error("toml: {0}")]
    Toml(#[from] toml::de::Error),
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("unknown decision in rule {0}: {1}")]
    UnknownDecision(String, String),
}
