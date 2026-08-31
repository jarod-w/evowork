use crate::blob::BlobRef;
use crate::ids::{ArtifactId, CiteId};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// 产物区事件：一个工具/流程向产物区写入了一份可交付文件。
///
/// 今天的产生方是 daemon：成功的 `fs.write`（`ToolResultStatus::Ok`）之后
/// 写一条。`reduce` 把它折进 `RunState::artifacts`。字段从第一天就定死
/// （红线③：事件目录一次定完）。
///
/// `blob` 复用 [`BlobRef`] 而不是各开 `mime` / `size` / `content_hash`
/// 三个字段：产物文件内容进 blob store（`BlobClass::Artifact`），
/// `BlobRef` 本就是「指向 blob 的引用」，没有理由在这里重新发明一遍同样
/// 的三元组。`path` 是给人看的展示/下载路径，与 blob store 内部按
/// content hash 分桶的物理路径是两回事，不能互相推导，所以分开存。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct ArtifactEmitted {
    pub artifact_id: ArtifactId,
    pub path: String,
    pub blob: BlobRef,
    /// 该产物里出现的数字/结论的溯源锚点（A-13「溯源引用」的数据基础），
    /// 供审计追溯「这个数从哪个 cite 来」
    #[serde(default)]
    pub cites: Vec<CiteId>,
    /// 若本产物是对之前某个产物的更新替代，指向被替代者。产物一旦发出
    /// 不可变、不删除——替代关系靠这个字段显式表达，不是原地覆盖旧产物
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub supersedes: Option<ArtifactId>,
}
