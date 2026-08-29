use crate::blob::BlobRef;
use crate::event::Actor;
use serde::{Deserialize, Serialize};

/// 澄清问题给出的一个选项。
///
/// `label` 是产品自己拼出来的短提示（例如「按上月同期口径」「跳过本步骤」），
/// 不是用户或模型写的自由文本，本身不含客户名、金额这类业务内容——它和
/// `policy.evaluated.reason_code`、`impact.estimated` 里资源 `kind` 这类
/// 「系统生成的短标签」是同一类东西，因此可以直接进 payload，不受红线①
/// 约束。真正可能带业务内容的是问题正文本身
/// （[`ClarificationRequested::question_ref`]）与用户的自由文本作答
/// （[`ClarificationAnswered::free_text_ref`]），这两个都是 `BlobRef`。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ClarificationOption {
    pub id: String,
    pub label: String,
    pub is_default: bool,
}

/// 一次追问。
///
/// `question_id` 是相对 01 §4 原始目录新增的字段——原文只有
/// `question_ref`。加它是因为同一个 run 里可能连续问好几轮，`seq` 距离
/// 猜不出某条 `clarification.answered` 对应的是哪一条请求；有了
/// `question_id`，两条事件靠它精确配对，不依赖顺序假设。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ClarificationRequested {
    pub question_id: String,
    /// 问题正文：可能引用具体单据、客户、金额，一律进 blob，不进
    /// payload（红线①）
    pub question_ref: BlobRef,
    pub options: Vec<ClarificationOption>,
}

/// 对某条 `clarification.requested` 的回答。`option_id` 与 `free_text_ref`
/// 都是 optional 且不互斥：产品形态允许「选一个选项，外加一句补充说明」。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ClarificationAnswered {
    pub question_id: String,
    pub by: Actor,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub option_id: Option<String>,
    /// 自由文本作答：与问题正文同理，可能带业务内容，一律 blob
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub free_text_ref: Option<BlobRef>,
}
