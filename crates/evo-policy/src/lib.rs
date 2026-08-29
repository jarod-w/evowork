//! 策略钩子。**trait 是最终接口，实现是 POC 期的**。
//!
//! 换 Cedar / OPA 时只实现一个新的 PolicyHook，Gateway 一行不动。

pub mod hardcoded;

use evo_protocol::effect::{EffectClass, ResourceRef};
use evo_protocol::ids::ToolId;
use evo_protocol::taint::TaintLevel;
use serde::{Deserialize, Serialize};

pub use hardcoded::HardcodedPolicy;

/// **`Ord`/`PartialOrd` 是派生的，依赖声明顺序**：`L1 < L2 < L3`，与危险程度
/// 递增一致，Gateway 的结构性闸门（`evo-gateway::pipeline::tighten`）靠这个
/// 序做 `max(策略给出的 risk, 闸门下限)`，只收紧不放宽。
///
/// 下面 `risk_level_order_is_l1_lt_l2_lt_l3` 测试拦得住的，只是「重排既有
/// 档位」——例如把 `L3` 挪到 `L1` 前面。它拦不住「插入一个语义上该排在别处
/// 的新档位」：派生 `Ord` 只看被断言的这几个变体之间的相对顺序，在 `L1`/`L2`
/// 之间插入一个新变体，不会动摇 `L1 < L2 < L3` 这条断言，测试依旧全绿，但
/// 新变体在真实危险程度里排在哪一档，测试完全不知道。新增档位时必须人工
/// 确认它在声明顺序里的位置与其危险程度一致，不能只看这条测试是否通过。
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
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

#[cfg(test)]
mod tests {
    use super::RiskLevel;

    #[test]
    fn risk_level_order_is_l1_lt_l2_lt_l3() {
        // 派生的 Ord 依赖声明顺序。evo-gateway 的结构性闸门靠 `risk.max(...)`
        // 做"只收紧不放宽"，这条测试拦的是「重排既有档位」（例如把 L3 挪到
        // L1 前面）——那会让下面的断言当场失败。它拦不住「插入一个语义上该
        // 排在别处的新档位」：在 L1/L2 之间插入新变体不影响这三者的相对
        // 顺序，断言依旧全绿。新增档位时必须人工确认位置，不能只看这条测试。
        assert!(RiskLevel::L1 < RiskLevel::L2);
        assert!(RiskLevel::L2 < RiskLevel::L3);
        assert!(RiskLevel::L1 < RiskLevel::L3);
    }
}
