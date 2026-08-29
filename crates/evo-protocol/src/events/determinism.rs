use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ModelRoute {
    pub provider: String,
    pub model: String,
    pub params_digest: String,
}

/// 内核唯一的时间与随机数来源。每 turn 一次（Q-04）。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct EnvSampled {
    pub turn: u32,
    pub wall_clock_ms: u64,
    pub rng_seed: String,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    pub model_route: ModelRoute,
}
