//! 上下文装配。M1 只做最简形态：intent 原文一个 block。
//!
//! 04 的完整装配（口径库、记忆、污点传播、cite 校验）是 M2。
//! 这个 crate 在 M1 就建起来，是为了让 context.assembled 事件的字段
//! 从第一天起就被真的写过一遍——而不是等 M2 才第一次验证。

use evo_protocol::events::context::{ContextAssembled, ContextBlock};
use evo_protocol::{BlobRef, CiteId, TrustLevel};

pub struct Assembler {
    profile: String,
}

impl Assembler {
    pub fn new(profile: &str) -> Self {
        Self {
            profile: profile.to_owned(),
        }
    }

    /// 装配一个 turn 的上下文。
    ///
    /// `cite_id` 必须只由 turn 与内容决定——含时间或随机数就会让回放重建的
    /// 上下文与原始不一致，判据 3 当场失效。
    pub fn assemble(&self, turn: u32, intent: &BlobRef, intent_text: &str) -> ContextAssembled {
        let hex = intent
            .content_hash
            .strip_prefix("sha256:")
            .unwrap_or(&intent.content_hash);
        let short = &hex[..hex.len().min(8)];
        let block = ContextBlock {
            cite_id: CiteId::from(format!("c-t{turn}-{short}")),
            source: "user_intent".to_owned(),
            trust: TrustLevel::UserDirect,
            scope: "run".to_owned(),
            content_hash: intent.content_hash.clone(),
            span: None,
            token_estimate: estimate_tokens(intent_text),
        };
        let total = block.token_estimate;
        ContextAssembled {
            turn,
            profile: self.profile.clone(),
            taint_level: block.trust.taint(),
            blocks: vec![block],
            total_token_estimate: total,
        }
    }
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

    #[test]
    fn user_intent_becomes_one_clean_block() {
        let a = Assembler::new("default");
        let c = a.assemble(0, &intent_ref(), "把账龄表做出来");
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
        let c = a.assemble(0, &intent_ref(), "把账龄表做出来");
        assert_eq!(c.blocks[0].content_hash, "sha256:ab");
    }

    #[test]
    fn cite_ids_are_stable_for_the_same_turn_and_content() {
        // 回放要重建同一份上下文；cite_id 含随机数或时间就会破坏判据 3
        let a = Assembler::new("default");
        let one = a.assemble(0, &intent_ref(), "x");
        let two = a.assemble(0, &intent_ref(), "x");
        assert_eq!(one.blocks[0].cite_id, two.blocks[0].cite_id);
    }

    #[test]
    fn token_estimate_is_non_zero_for_non_empty_text() {
        assert!(estimate_tokens("把账龄表做出来") > 0);
        assert_eq!(estimate_tokens(""), 0);
    }
}
