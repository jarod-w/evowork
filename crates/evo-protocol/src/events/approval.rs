use crate::blob::BlobRef;
use crate::event::Actor;
use crate::ids::{ApprovalId, EffectId};
use serde::{Deserialize, Serialize};

/// 风险档位，驱动是否需要人批准以及批准的严格程度（02 §…「结构性闸门」）。
///
/// **刻意与 `evo-policy::RiskLevel` 是两份独立定义，不是同一个类型的重
/// 导出**：`evo-policy` 依赖 `evo-protocol`（它要用 `EffectClass` /
/// `ResourceRef` / `TaintLevel`），反过来让 `evo-protocol` 依赖
/// `evo-policy` 会成环；而本任务的红线之一是不给 `evo-protocol` 加任何
/// 依赖。两份定义的变体名、声明顺序（决定 `Ord`，`L1 < L2 < L3`）与
/// 序列化形态（`rename_all = "lowercase"` → `"l1"`/`"l2"`/`"l3"`）必须
/// 保持一致——daemon 组装 `approval.requested` 时要把 Gateway 判定出的
/// `evo_policy::RiskLevel` 映射到这里；谁在 `evo-policy` 那边新增档位，
/// 必须同步把这份镜像也补上。
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RiskLevel {
    /// 可逆、仅本地、不对外——直接执行，只留审计
    L1,
    /// 不可逆或影响面大，但不对外——进审批队列，可批量放行
    L2,
    /// 对外发送 / 资金 / 生产系统写——强制单条审批，不可批量放行
    L3,
}

/// Gateway 判定某个 effect 需要人批准时发出。这是「挂起而不是 `Err`」这条
/// 控制流反转的起点：daemon 追加这条事件 + 一条 `run.suspended`，然后
/// `reduce` 置 `awaiting`，`decide` 自然返回空，turn 循环干净结束。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ApprovalRequested {
    /// 审批请求的稳定标识，`approval.granted` / `denied` / `expired`
    /// 都靠它关联回这一条请求
    pub approval_id: ApprovalId,
    /// 待批准的哪个 effect；一次 `tool.requested` 最多触发一条审批请求
    pub effect_id: EffectId,
    pub risk: RiskLevel,
    /// 影响预估的引用：可能带具体资源标识甚至金额，一律 blob，不进
    /// payload（红线①）。`Option` 是因为并非所有 effect 都能算出影响
    /// 预估（`ImpactPrecision::DeclaredOnly` 时可能什么都估不出来）
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
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ApprovalVia {
    Ui,
    WecomLink,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ApprovalGranted {
    pub approval_id: ApprovalId,
    pub by: Actor,
    pub via: ApprovalVia,
    /// 审批备注：批准时人可能会写理由，可能夹带客户名或金额，一律 blob，
    /// 不进 payload（红线①）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note_ref: Option<BlobRef>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
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
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ApprovalExpired {
    pub approval_id: ApprovalId,
}
