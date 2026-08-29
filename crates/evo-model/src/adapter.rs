use async_trait::async_trait;
use evo_protocol::events::model::{ModelParams, Usage};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Message {
    pub role: String,
    pub content: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ModelRequest {
    pub messages: Vec<Message>,
    pub params: ModelParams,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ModelResponse {
    pub text: String,
    pub usage: Usage,
    pub stop_reason: String,
    pub latency_ms: u64,
}

#[derive(Debug, thiserror::Error)]
pub enum ModelError {
    #[error("json: {0}")]
    Json(#[from] serde_json::Error),
    #[error("toml: {0}")]
    Toml(#[from] toml::de::Error),
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("fixture exhausted after {0} responses")]
    FixtureExhausted(usize),
    #[error(
        "cost overflow: quantity={quantity} * unit_price_micros={unit_price_micros} 超出 u64 范围"
    )]
    CostOverflow {
        quantity: u64,
        unit_price_micros: u64,
    },
}

#[async_trait]
pub trait ModelAdapter: Send + Sync {
    fn provider(&self) -> &str;
    fn model(&self) -> &str;
    async fn call(&self, req: &ModelRequest) -> Result<ModelResponse, ModelError>;
}

/// 进 model.requested.request_digest。回放时重建请求并比对——
/// 不一致说明装配器有非确定性，直接报错而不是继续（01 §5）。
pub fn request_digest(req: &ModelRequest) -> String {
    let canonical = serde_json::to_vec(req).expect("ModelRequest 必须可序列化");
    format!("sha256:{}", hex::encode(Sha256::digest(&canonical)))
}
