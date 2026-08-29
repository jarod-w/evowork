//! 策略钩子。**trait 是最终接口，实现是 POC 期的**。
//!
//! 换 Cedar / OPA 时只实现一个新的 PolicyHook，Gateway 一行不动。

pub mod hardcoded;

use evo_protocol::effect::{EffectClass, ResourceRef};
use evo_protocol::ids::ToolId;
use evo_protocol::taint::TaintLevel;

pub use hardcoded::HardcodedPolicy;

/// 唯一定义在 `evo_protocol::events::approval::RiskLevel`——`approval.requested`
/// 事件也要用这个类型，而 `evo-policy` 本来就依赖 `evo-protocol`，不需要反向
/// 依赖，因此这里只做重导出，保持 `evo_policy::RiskLevel` 这条路径仍然可用。
/// `Ord`（`L1 < L2 < L3`，Gateway 的 `tighten` 靠它做「只收紧不放宽」）、
/// 序列化形态（`rename_all = "lowercase"`）与新增档位时的注意事项，见那边
/// 的文档注释与 `risk_level_order_is_l1_lt_l2_lt_l3` 测试。
pub use evo_protocol::events::approval::RiskLevel;

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
