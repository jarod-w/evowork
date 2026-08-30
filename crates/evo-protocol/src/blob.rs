use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// 指向 blob store 的引用。事件 payload 里只出现它，不出现内容本身。
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, TS)]
pub struct BlobRef {
    /// "sha256:<hex>"
    pub content_hash: String,
    pub size: u64,
    pub mime: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
pub enum BlobClass {
    /// 元数据，可随事件表一起上云
    Metadata,
    /// 业务内容，永不出本地
    Content,
    /// 产物文件
    Artifact,
}
