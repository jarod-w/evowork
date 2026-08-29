use crate::adapter::{ModelAdapter, ModelError, ModelRequest, ModelResponse};
use async_trait::async_trait;
use serde::Deserialize;
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};

#[derive(Debug, Deserialize)]
struct FixtureFile {
    provider: String,
    model: String,
    responses: Vec<ModelResponse>,
}

/// M1 的模型实现：从文件读固定响应，按调用顺序返回。
///
/// 回放本来就不重新调模型（01 §5），所以判据 3 的验证一点不打折。
/// 真 DeepSeek / GPT adapter 是 M2 的事（09）。
pub struct FixtureAdapter {
    file: FixtureFile,
    cursor: AtomicUsize,
}

impl FixtureAdapter {
    pub fn from_json_str(s: &str) -> Result<Self, ModelError> {
        Ok(Self {
            file: serde_json::from_str(s)?,
            cursor: AtomicUsize::new(0),
        })
    }

    pub fn from_path(p: &Path) -> Result<Self, ModelError> {
        Self::from_json_str(&std::fs::read_to_string(p)?)
    }
}

#[async_trait]
impl ModelAdapter for FixtureAdapter {
    fn provider(&self) -> &str {
        &self.file.provider
    }

    fn model(&self) -> &str {
        &self.file.model
    }

    async fn call(&self, _req: &ModelRequest) -> Result<ModelResponse, ModelError> {
        let i = self.cursor.fetch_add(1, Ordering::SeqCst);
        // 用尽即报错，绝不循环复用：静默重复会让「跑通了」变成假象
        self.file
            .responses
            .get(i)
            .cloned()
            .ok_or(ModelError::FixtureExhausted(self.file.responses.len()))
    }
}
