//! 上下文装配。M1 只做最简形态：intent 原文一个 block。
//!
//! 04 的完整装配（口径库、记忆、污点传播、cite 校验）是 M2。
//! 这个 crate 在 M1 就建起来，是为了让 context.assembled 事件的字段
//! 从第一天起就被真的写过一遍——而不是等 M2 才第一次验证。
//!
//! M2 Task 6（A-12 澄清式追问）在此基础上加了一件事：`assemble` 现在
//! 还能接纳「已回答的澄清」，把答案带进重新装配的上下文——否则内核把
//! `context_turn`/`plan_turn` 退回去、模型重新规划时用的还是一份不含
//! 答案的上下文，跟没回答没有区别（交接边界见
//! `evo_kernel::reduce` 对 `ClarificationAnswered` 的处理注释）。
//! 这个 crate 依然只依赖 `evo-protocol`，不读 blob store——答案的纯文本
//! 与它所在的 blob 引用都由调用方（daemon）读出来再传进来。

use evo_protocol::events::context::{ContextAssembled, ContextBlock};
use evo_protocol::{BlobRef, CiteId, TaintLevel, TrustLevel};

/// 一条已回答的澄清，供 [`Assembler::assemble`] 拼成额外的 context block。
///
/// 两个字段都是 daemon 已经从 blob store 读出来的东西：
/// - `answer_ref` 指向一个 blob，内容是这条澄清的摘要（问题正文 + 选中
///   项文案 + 自由文本，具体怎么拼由 daemon 决定）——block 的 `cite_id`
///   与 `content_hash` 都只认这个引用，不认下面的 `answer_text`。
/// - `answer_text` 是同一份内容的纯文本，只用来估算 token 数；换句话说，
///   就算把它整个删掉，装配出来的 block 在"引用了哪个 blob"这件事上不会
///   有任何变化——这正是判据 3（回放重建同一份上下文）要求的：`cite_id`
///   只能由内容（这里体现为 blob 的 `content_hash`）与 turn 决定。
pub struct AnsweredClarification<'a> {
    pub answer_ref: &'a BlobRef,
    pub answer_text: &'a str,
}

pub struct Assembler {
    profile: String,
}

impl Assembler {
    pub fn new(profile: &str) -> Self {
        Self {
            profile: profile.to_owned(),
        }
    }

    /// 装配一个 turn 的上下文：intent 原文一个 block，外加每条已回答的
    /// 澄清各一个 block（没有就是空切片，行为与加这个参数之前完全一致——
    /// 这也是 eval 里不触发澄清的用例哈希不该变的原因）。
    ///
    /// `cite_id` 必须只由 turn 与内容决定——含时间或随机数就会让回放重建的
    /// 上下文与原始不一致，判据 3 当场失效。
    pub fn assemble(
        &self,
        turn: u32,
        intent: &BlobRef,
        intent_text: &str,
        answered_clarifications: &[AnsweredClarification<'_>],
    ) -> ContextAssembled {
        let mut blocks = vec![intent_block(turn, intent, intent_text)];
        for answer in answered_clarifications {
            blocks.push(clarification_block(turn, answer));
        }
        let taint_level = blocks
            .iter()
            .fold(TaintLevel::Clean, |acc, b| acc.join(b.trust.taint()));
        let total_token_estimate = blocks.iter().map(|b| b.token_estimate).sum();
        ContextAssembled {
            turn,
            profile: self.profile.clone(),
            taint_level,
            blocks,
            total_token_estimate,
        }
    }
}

fn intent_block(turn: u32, intent: &BlobRef, intent_text: &str) -> ContextBlock {
    ContextBlock {
        cite_id: CiteId::from(format!("c-t{turn}-{}", short_hash(&intent.content_hash))),
        source: "user_intent".to_owned(),
        trust: TrustLevel::UserDirect,
        scope: "run".to_owned(),
        content_hash: intent.content_hash.clone(),
        span: None,
        token_estimate: estimate_tokens(intent_text),
    }
}

/// 已回答的澄清也是用户直接给出的信息（不管是选了默认项、选了别的选项、
/// 还是补了一句自由文本），一样不带污点，与 intent block 同 `trust`。
fn clarification_block(turn: u32, answer: &AnsweredClarification<'_>) -> ContextBlock {
    ContextBlock {
        cite_id: CiteId::from(format!(
            "c-t{turn}-clar-{}",
            short_hash(&answer.answer_ref.content_hash)
        )),
        source: "clarification_answer".to_owned(),
        trust: TrustLevel::UserDirect,
        scope: "run".to_owned(),
        content_hash: answer.answer_ref.content_hash.clone(),
        span: None,
        token_estimate: estimate_tokens(answer.answer_text),
    }
}

fn short_hash(content_hash: &str) -> &str {
    let hex = content_hash.strip_prefix("sha256:").unwrap_or(content_hash);
    &hex[..hex.len().min(8)]
}

/// 粗估 token 数。M1 不接 tokenizer——这个数只进 payload 做统计，
/// 不参与计费（计费用模型返回的真实 usage），估偏了不会让账错。
pub fn estimate_tokens(text: &str) -> u64 {
    if text.is_empty() {
        return 0;
    }
    // 中文按字符、英文按 4 字符 1 token 粗算，取两者较大值保守估计
    let chars = text.chars().count() as u64;
    let bytes = text.len() as u64;
    chars.max(bytes / 4).max(1)
}

impl Default for Assembler {
    fn default() -> Self {
        Self::new("default")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use evo_protocol::{BlobRef, TaintLevel, TrustLevel};

    fn intent_ref() -> BlobRef {
        BlobRef {
            content_hash: "sha256:ab".into(),
            size: 6,
            mime: "text/plain".into(),
        }
    }

    fn answer_ref() -> BlobRef {
        BlobRef {
            content_hash: "sha256:cd1234ef".into(),
            size: 12,
            mime: "text/plain".into(),
        }
    }

    #[test]
    fn user_intent_becomes_one_clean_block() {
        let a = Assembler::new("default");
        let c = a.assemble(0, &intent_ref(), "把账龄表做出来", &[]);
        assert_eq!(c.blocks.len(), 1);
        assert_eq!(c.blocks[0].trust, TrustLevel::UserDirect);
        assert_eq!(c.taint_level, TaintLevel::Clean, "用户直接输入不带污点");
        assert_eq!(c.profile, "default");
        assert_eq!(c.turn, 0);
    }

    #[test]
    fn the_block_cites_the_blob_not_the_text() {
        // 01 §3：事件里只留 content_hash，正文进 blob
        let a = Assembler::new("default");
        let c = a.assemble(0, &intent_ref(), "把账龄表做出来", &[]);
        assert_eq!(c.blocks[0].content_hash, "sha256:ab");
    }

    #[test]
    fn cite_ids_are_stable_for_the_same_turn_and_content() {
        // 回放要重建同一份上下文；cite_id 含随机数或时间就会破坏判据 3
        let a = Assembler::new("default");
        let one = a.assemble(0, &intent_ref(), "x", &[]);
        let two = a.assemble(0, &intent_ref(), "x", &[]);
        assert_eq!(one.blocks[0].cite_id, two.blocks[0].cite_id);
    }

    #[test]
    fn token_estimate_is_non_zero_for_non_empty_text() {
        assert!(estimate_tokens("把账龄表做出来") > 0);
        assert_eq!(estimate_tokens(""), 0);
    }

    #[test]
    fn an_answered_clarification_adds_a_second_clean_block() {
        let a = Assembler::new("default");
        let ans_ref = answer_ref();
        let answers = [AnsweredClarification {
            answer_ref: &ans_ref,
            answer_text: "问题：是否继续？\n回答：是",
        }];
        let c = a.assemble(0, &intent_ref(), "把账龄表做出来", &answers);
        assert_eq!(c.blocks.len(), 2, "应该多出一个澄清答案的 block");
        let clar = &c.blocks[1];
        assert_eq!(clar.content_hash, "sha256:cd1234ef");
        assert_eq!(clar.trust, TrustLevel::UserDirect);
        assert_eq!(c.taint_level, TaintLevel::Clean);
        assert!(clar.token_estimate > 0);
    }

    #[test]
    fn clarification_cite_id_is_stable_and_keyed_by_its_own_blob() {
        let a = Assembler::new("default");
        let ans_ref = answer_ref();
        let answers = [AnsweredClarification {
            answer_ref: &ans_ref,
            answer_text: "同一份内容",
        }];
        let one = a.assemble(2, &intent_ref(), "x", &answers);
        let two = a.assemble(2, &intent_ref(), "x", &answers);
        assert_eq!(one.blocks[1].cite_id, two.blocks[1].cite_id);
        assert_ne!(
            one.blocks[0].cite_id, one.blocks[1].cite_id,
            "intent block 与澄清 block 的 cite_id 不能撞在一起"
        );
    }
}
