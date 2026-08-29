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
