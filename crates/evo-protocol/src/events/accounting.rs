use crate::blob::BlobRef;
use crate::budget::BudgetSpec;
use crate::event::Actor;
use crate::ids::{CheckpointId, EffectId, RunId, ToolId};
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CostUnit {
    InputToken,
    OutputToken,
    CacheRead,
    CacheWrite,
    Seconds,
    Call,
}

/// 刻意不加 `rename_all`：`CNY` / `USD` 是 ISO 4217 货币代码，本就该大写，
/// 与本 crate 其他枚举的 snake_case 风格不一致是故意的，契约文档里写的也是
/// 大写代码。不要为了风格统一给它加 `rename_all = "lowercase"`（或任何改变
/// 序列化形态的属性）——那会让已经落盘的历史账目解不开。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum Currency {
    CNY,
    USD,
}

/// 四维归因从第一天就带。POC 只用得上 principal 与 run_id，另两维留空。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct CostDimension {
    pub principal: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub team: Option<String>,
    pub run_id: RunId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub skill: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool: Option<ToolId>,
}

/// micros 整数，不用浮点——财务客户，账要对得上。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct CostCharged {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effect_id: Option<EffectId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn: Option<u32>,
    pub unit: CostUnit,
    pub quantity: u64,
    pub unit_price_micros: u64,
    pub amount_micros: u64,
    pub currency: Currency,
    /// 改价不能改历史账
    pub price_table_ver: String,
    pub dimension: CostDimension,
}

/// 人改了一条**已经在跑**的 run 的额度。
///
/// 这是 `RunState::budget` 在 `run.created` 之外唯一的写入方，也是
/// 「超限自动挂起 → 人提额 → 续跑」这条链路上此前完全缺失的一环
/// （M2 终审 BL-10）。没有它，`run.resumed` 之后 `budget_exhausted` 仍然
/// 为真，`decide` 立刻再产出一次 `Suspend`，run 永远推不动——提额这件事
/// 在 Log 上根本无从表达，只能靠调用方绕过 Log 直接改内存里的状态字段，
/// 而那样的状态**在 Log 上不可复现**，判据 3（回放结果与原始执行一致）
/// 当场不成立。
///
/// **语义是整体替换，不是增量。** payload 里就是这条 run 从此刻起完整的
/// `BudgetSpec`。选替换的两个理由：一、Log 是唯一权威事实，单独读出一条
/// `budget.amended` 就该能回答「现在的额度是多少」，增量写法要求读者先把
/// 之前每一条都折叠一遍；二、「把某个维度从有限改回不设限」（`Some` →
/// `None`）用加法根本表达不出来。
///
/// **它不改已用量。** `BudgetUsage` 记的是真的花掉的 token / 金额 / 时长，
/// 提额不会让已经发生的消耗消失。续跑靠的是上限抬高之后
/// `budget_exhausted` 不再成立，不是把账抹掉——`cost.charged` 是账本，
/// 谁也不许倒着写。
///
/// 提额理由是人写的自由文本，一律进 blob，事件 payload 里只留引用（红线①）。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct BudgetAmended {
    pub budget: BudgetSpec,
    /// 谁改的。额度是钱，改过必须记名。
    pub by: Actor,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason_ref: Option<BlobRef>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CheckpointReason {
    Periodic,
    PreWrite,
    PreApproval,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Checkpoint {
    pub checkpoint_id: CheckpointId,
    /// 回放到此 seq 时重算，不一致即 fail。判据 3 的自动检测器。
    pub state_hash: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub snapshot_ref: Option<String>,
    pub reason: CheckpointReason,
}
