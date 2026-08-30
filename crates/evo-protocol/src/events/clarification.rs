use crate::blob::BlobRef;
use crate::event::Actor;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// 澄清问题给出的一个选项。
///
/// 选项文案（`label`）**不在这里**——它和问题正文一起放进
/// [`ClarificationRequested::prompt_ref`] 指向的 blob。payload 里只留机器
/// 逻辑真正需要的两样：`id`（供 [`ClarificationAnswered::option_id`] 精确
/// 指回这一项）与 `is_default`（一键回答需要知道默认选中哪个）。
///
/// 历史教训（别再犯）：这里原先还有一个 `label: String` 字段，理由是「产品
/// 自己拼的短标签，不含业务内容」，类比 `policy.evaluated.reason_code` 那类
/// 系统生成的短字符串。**这个类比不成立**：`reason_code` 是系统内部的枚举
/// 值，`label` 是面向最终用户展示的自然语言——在这个产品的业务场景（审批、
/// 催收）里，选项文案完全可能长这样：「是否对『某某公司』的 12 万逾期发起
/// 催收」。客户名和金额就这么进了 payload，而 schema 层面没有任何东西拦得
/// 住。不要把 `label` 一类的展示文本加回这个结构体。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct ClarificationOption {
    pub id: String,
    pub is_default: bool,
}

/// 一次追问。
///
/// `question_id` 是相对 01 §4 原始目录新增的字段——原文只有
/// `question_ref`。加它是因为同一个 run 里可能连续问好几轮，`seq` 距离
/// 猜不出某条 `clarification.answered` 对应的是哪一条请求；有了
/// `question_id`，两条事件靠它精确配对，不依赖顺序假设。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct ClarificationRequested {
    pub question_id: String,
    /// 问题正文**与全部选项的展示文案**都在这里，不只是问题本身——字段从
    /// `question_ref` 改名为 `prompt_ref`，就是为了不让下一个人看名字以为
    /// 它只装问题正文，从而把选项文案漏掉、原地又长出一个 `label` 字段。
    /// 可能引用具体单据、客户、金额，一律进 blob，不进 payload（红线①）。
    ///
    /// blob 内容的具体结构由产生方（daemon）决定，这里只给建议形状，供
    /// 后续实现者不用重新发明：
    ///
    /// ```json
    /// {
    ///   "question": "是否对某某公司的 12 万逾期发起催收？",
    ///   "options": {
    ///     "opt-1": "是，立即发起",
    ///     "opt-2": "否，再等等"
    ///   }
    /// }
    /// ```
    ///
    /// `options` 的 key 是 [`ClarificationOption::id`]，value 是该选项的
    /// 展示文案——与 payload 里 `options: Vec<ClarificationOption>` 的每一项
    /// 靠 `id` 一一对齐。
    pub prompt_ref: BlobRef,
    pub options: Vec<ClarificationOption>,
}

/// 对某条 `clarification.requested` 的回答。`option_id` 与 `free_text_ref`
/// 都是 optional 且不互斥：产品形态允许「选一个选项，外加一句补充说明」。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct ClarificationAnswered {
    pub question_id: String,
    pub by: Actor,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub option_id: Option<String>,
    /// 自由文本作答：与问题正文同理，可能带业务内容，一律 blob
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub free_text_ref: Option<BlobRef>,
}
