use crate::blob::BlobRef;
use crate::event::Actor;
use crate::ids::{ApprovalId, EffectId};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// 风险档位，驱动是否需要人批准以及批准的严格程度（02 §…「结构性闸门」）。
///
/// **唯一定义在这里**：`evo-policy` 本来就依赖 `evo-protocol`（要用
/// `EffectClass` / `ResourceRef` / `TaintLevel`），所以不需要反向依赖，
/// `evo_policy::RiskLevel` 是对本类型的 `pub use` 重导出，不是另一份定义。
///
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
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
pub enum RiskLevel {
    /// 可逆、仅本地、不对外——直接执行，只留审计
    L1,
    /// 不可逆或影响面大，但不对外——进审批队列，可批量放行
    L2,
    /// 对外发送 / 资金 / 生产系统写——强制单条审批，不可批量放行
    L3,
}

#[cfg(test)]
mod risk_level_tests {
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

/// Gateway 判定某个 effect 需要人批准时发出。这是「挂起而不是 `Err`」这条
/// 控制流反转的起点：daemon 追加这条事件 + 一条 `run.suspended`，然后
/// `reduce` 置 `awaiting`，`decide` 自然返回空，turn 循环干净结束。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct ApprovalRequested {
    /// 审批请求的稳定标识，`approval.granted` / `denied` / `expired`
    /// 都靠它关联回这一条请求
    pub approval_id: ApprovalId,
    /// 待批准的哪个 effect；一次 `tool.requested` 最多触发一条审批请求
    pub effect_id: EffectId,
    pub risk: RiskLevel,
    /// 影响预估的引用：可能带具体资源标识甚至金额，一律 blob，不进
    /// payload（红线①）。`Option` 是因为并非所有 effect 都能算出影响
    /// 预估（`ImpactPrecision::Unknown` 时估不出任何资源；空清单不是「没有」）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub impact_ref: Option<BlobRef>,
    /// 审批过期的时刻（wall clock 毫秒）。**来源是本 run 最近一次
    /// `env.sampled.wall_clock_ms` 加上审批有效期，不是组装者调用
    /// `SystemTime::now()`**——内核与执行面都不许自己读时钟（05 节），
    /// 这里是最容易被顺手写错的一处：审批走 daemon 侧的异步等待，
    /// `expires_at_ms` 看着像「daemon 自己算的截止时间」，但只要它的
    /// 起点不是 Log 里已经落盘的 `wall_clock_ms`，同一条 Log 在两次
    /// 回放里算出的过期判定就可能不一致，判据 3（回放结果与原始执行
    /// 一致）当场破功。
    pub expires_at_ms: u64,
}

/// 审批的送达渠道。POC 期两条：站内 UI、企业微信免登录链接。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum ApprovalVia {
    Ui,
    WecomLink,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct ApprovalGranted {
    pub approval_id: ApprovalId,
    pub by: Actor,
    pub via: ApprovalVia,
    /// 审批备注：批准时人可能会写理由，可能夹带客户名或金额，一律 blob，
    /// 不进 payload（红线①）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note_ref: Option<BlobRef>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct ApprovalDenied {
    pub approval_id: ApprovalId,
    pub by: Actor,
    /// 驳回理由：与审批备注同理，可能带业务内容，一律 blob
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason_ref: Option<BlobRef>,
}

/// `expires_at_ms` 到了却没人处理时，daemon（不是人）发出这条事件；没有
/// 额外字段——过期本身就是全部信息，谁想知道超时时长可以从
/// `approval.requested.expires_at_ms` 与本事件的 `recorded_at` 反推。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct ApprovalExpired {
    pub approval_id: ApprovalId,
}
