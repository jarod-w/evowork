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
//!
//! M2 终审 BL-9（污点闸门）在此基础上又加了一件事：block 的 `trust` 不再
//! 写死成 `UserDirect`，而是由 [`BlockSource`] 按**来源**判定，工具返回
//! 进上下文时带 `Untrusted`。在此之前每个 block 都是 `UserDirect`，
//! `context.assembled.taint_level` 因而恒为 `Clean`——04 §2 第 1 条
//! （"块的污点进 run"）在代码里是一条恒等式，不是一条规则。

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

/// 一个 context block 的来源。**`trust` 由它决定**，判定规则写在装配器
/// 这一侧，不由调用方自己挑一个 `TrustLevel` 传进来——04 §1 那句
/// 「`trust` 的判定规则在 POC 期是固定的，写在装配器里（不在 prompt 里）」
/// 说的就是这件事：规则一旦散到每个调用点上，就等于没有规则，只剩下
/// "希望每个调用点都记得标对"，而那正是 04 开篇点名的嘱托性防护。
///
/// 04 §1 的那张表：
///
/// | 来源 | trust |
/// |---|---|
/// | 用户当面输入 | `UserDirect` |
/// | 组织受控数据源 | `OrgTrusted` |
/// | 一切外部内容 | `Untrusted` |
///
/// 表里的 `OrgTrusted` 一档**故意没有对应的变体**。它是留给"组织受控
/// 数据源"（ERP 取数、口径库这类由我们自己接、自己写 manifest 的连接器）
/// 的，而执行面目前一个都没有：本地执行器的三个工具（`fs.read`、
/// `fs.write`、`shell.exec`）碰的全是工作区里的字节，谁写进去的这一层
/// 看不出来。凭空加一个"某些工具算受信"的变体，只会给一条现在还没人走的
/// 路先开好口子。接入第一个组织受控数据源时，在这里加变体是那次改动的
/// 一部分——而且是**唯一**一处能让工具返回重新变 `Clean` 的地方。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BlockSource {
    /// 用户当面输入的意图原文。
    UserIntent,
    /// 一条已回答的澄清。不管是选了默认项、选了别的选项、还是补了一句
    /// 自由文本，都是用户当面给出的信息，与 intent 同档。
    ClarificationAnswer,
    /// 一次工具调用回传的内容。
    ///
    /// 一律 `Untrusted`：`fs.read` 读到的文件可能是人丢进工作区的外部
    /// 对账单，`shell.exec` 的 stdout 更是任意命令的产物，谁写的这一层
    /// 看不出来。判定按来源，不按内容长什么样——"看起来像不像指令"
    /// 这种内容级启发式，一段精心构造的内容就能绕开。
    ToolResult,
}

impl BlockSource {
    /// 04 §1 那张表的可执行形态。
    pub fn trust(self) -> TrustLevel {
        match self {
            Self::UserIntent | Self::ClarificationAnswer => TrustLevel::UserDirect,
            Self::ToolResult => TrustLevel::Untrusted,
        }
    }

    /// 进 `ContextBlock::source` 的标签。只是元数据，不参与信任判定——
    /// 判定看的是变体本身，不是这个字符串。
    fn label(self) -> &'static str {
        match self {
            Self::UserIntent => "user_intent",
            Self::ClarificationAnswer => "clarification_answer",
            Self::ToolResult => "tool_result",
        }
    }
}

/// 一次工具调用回传的内容，供 [`Assembler::assemble`] 拼成一个
/// `BlockSource::ToolResult` 的 block。
///
/// 与 [`AnsweredClarification`] 同构，理由也一样：
/// - `output_ref` 指向 daemon 已经落好的那个 blob，block 的 `cite_id` 与
///   `content_hash` 都只认它；
/// - `output_text` 是同一份内容的文本形态，**只**用来估 token 数。工具
///   返回可以是任意字节（`fs.read` 读二进制文件完全合法），调用方按
///   有损方式转文本即可——这不会改变 block 引用了哪个 blob，判据 3
///   （回放重建同一份上下文）因而不受影响。
pub struct ToolOutput<'a> {
    /// 产出这份内容的工具，如 `"fs.read"`。只进 `span`/审计，不参与信任
    /// 判定——判定在 [`BlockSource`] 那一侧，任何工具的返回都是
    /// `Untrusted`。
    pub tool: &'a str,
    pub output_ref: &'a BlobRef,
    pub output_text: &'a str,
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
    /// 澄清各一个 block、每份已回传的工具输出各一个 block（两者没有就是
    /// 空切片，行为与加这两个参数之前完全一致）。
    ///
    /// `taint_level` 是全部 block 里最高的那一档（04 §2 第 1 条）。它现在
    /// 真的会变成 `Tainted`——只要这个 turn 的上下文里有一份工具返回。
    ///
    /// `cite_id` 必须只由 turn 与内容决定——含时间或随机数就会让回放重建的
    /// 上下文与原始不一致，判据 3 当场失效。
    pub fn assemble(
        &self,
        turn: u32,
        intent: &BlobRef,
        intent_text: &str,
        answered_clarifications: &[AnsweredClarification<'_>],
        tool_outputs: &[ToolOutput<'_>],
    ) -> ContextAssembled {
        let mut blocks = vec![intent_block(turn, intent, intent_text)];
        for answer in answered_clarifications {
            blocks.push(clarification_block(turn, answer));
        }
        for output in tool_outputs {
            blocks.push(tool_result_block(turn, output));
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
    let source = BlockSource::UserIntent;
    ContextBlock {
        cite_id: CiteId::from(format!("c-t{turn}-{}", short_hash(&intent.content_hash))),
        source: source.label().to_owned(),
        trust: source.trust(),
        scope: "run".to_owned(),
        content_hash: intent.content_hash.clone(),
        span: None,
        token_estimate: estimate_tokens(intent_text),
    }
}

/// 已回答的澄清也是用户直接给出的信息（不管是选了默认项、选了别的选项、
/// 还是补了一句自由文本），一样不带污点，与 intent block 同 `trust`。
fn clarification_block(turn: u32, answer: &AnsweredClarification<'_>) -> ContextBlock {
    let source = BlockSource::ClarificationAnswer;
    ContextBlock {
        cite_id: CiteId::from(format!(
            "c-t{turn}-clar-{}",
            short_hash(&answer.answer_ref.content_hash)
        )),
        source: source.label().to_owned(),
        trust: source.trust(),
        scope: "run".to_owned(),
        content_hash: answer.answer_ref.content_hash.clone(),
        span: None,
        token_estimate: estimate_tokens(answer.answer_text),
    }
}

/// 工具返回的内容进上下文——**带着污点进**。
///
/// `span` 记下是哪个工具产出的：这是溯源的落点，"这句话是从哪儿来的"
/// 在审批界面上要答得出来。它是元数据，不参与信任判定。
fn tool_result_block(turn: u32, output: &ToolOutput<'_>) -> ContextBlock {
    let source = BlockSource::ToolResult;
    ContextBlock {
        cite_id: CiteId::from(format!(
            "c-t{turn}-tool-{}",
            short_hash(&output.output_ref.content_hash)
        )),
        source: source.label().to_owned(),
        trust: source.trust(),
        scope: "run".to_owned(),
        content_hash: output.output_ref.content_hash.clone(),
        span: Some(output.tool.to_owned()),
        token_estimate: estimate_tokens(output.output_text),
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

    fn tool_output_ref() -> BlobRef {
        BlobRef {
            content_hash: "sha256:deadbeef".into(),
            size: 20,
            mime: "application/octet-stream".into(),
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
        let c = a.assemble(0, &intent_ref(), "把账龄表做出来", &[], &[]);
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
        let c = a.assemble(0, &intent_ref(), "把账龄表做出来", &[], &[]);
        assert_eq!(c.blocks[0].content_hash, "sha256:ab");
    }

    #[test]
    fn cite_ids_are_stable_for_the_same_turn_and_content() {
        // 回放要重建同一份上下文；cite_id 含随机数或时间就会破坏判据 3
        let a = Assembler::new("default");
        let one = a.assemble(0, &intent_ref(), "x", &[], &[]);
        let two = a.assemble(0, &intent_ref(), "x", &[], &[]);
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
        let c = a.assemble(0, &intent_ref(), "把账龄表做出来", &answers, &[]);
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
        let one = a.assemble(2, &intent_ref(), "x", &answers, &[]);
        let two = a.assemble(2, &intent_ref(), "x", &answers, &[]);
        assert_eq!(one.blocks[1].cite_id, two.blocks[1].cite_id);
        assert_ne!(
            one.blocks[0].cite_id, one.blocks[1].cite_id,
            "intent block 与澄清 block 的 cite_id 不能撞在一起"
        );
    }
    // --- M2 终审 BL-9：trust 按来源定，工具返回带污点进上下文 ---

    #[test]
    fn a_tool_output_block_is_untrusted_and_taints_the_whole_context() {
        // 这条是闸门在上下文这一侧的电源。它红了，说明 04 §2 第 1 条
        // 「块的污点进 run」又变回了一条恒等式。
        let a = Assembler::new("default");
        let out_ref = tool_output_ref();
        let outputs = [ToolOutput {
            tool: "fs.read",
            output_ref: &out_ref,
            output_text: "外部丢进来的对账单正文",
        }];
        let c = a.assemble(0, &intent_ref(), "把账龄表做出来", &[], &outputs);

        assert_eq!(c.blocks.len(), 2);
        let tool_block = &c.blocks[1];
        assert_eq!(tool_block.trust, TrustLevel::Untrusted);
        assert_eq!(tool_block.source, "tool_result");
        assert_eq!(tool_block.content_hash, "sha256:deadbeef");
        assert_eq!(tool_block.span.as_deref(), Some("fs.read"));
        assert_eq!(
            c.taint_level,
            TaintLevel::Tainted,
            "一块 tainted，整份上下文就是 tainted"
        );
    }

    #[test]
    fn trust_comes_from_the_source_not_from_the_caller() {
        // 判定规则住在装配器里（04 §1）：调用方递进来的只有"这是什么来源"，
        // 没有任何一个参数能让它自己挑一个 TrustLevel。这条测试钉的是那张表。
        assert_eq!(BlockSource::UserIntent.trust(), TrustLevel::UserDirect);
        assert_eq!(
            BlockSource::ClarificationAnswer.trust(),
            TrustLevel::UserDirect
        );
        assert_eq!(BlockSource::ToolResult.trust(), TrustLevel::Untrusted);
        assert_eq!(BlockSource::ToolResult.trust().taint(), TaintLevel::Tainted);
    }

    #[test]
    fn every_tool_is_untrusted_no_matter_which_one() {
        // 不存在"这个工具比较安全所以它的返回是 Clean"这条捷径。要开这个
        // 口子，只能是 BlockSource 上加一个 OrgTrusted 档的变体（见那里的
        // 文档注释），不能靠调用方按工具名分流。
        let a = Assembler::new("default");
        let out_ref = tool_output_ref();
        for tool in ["fs.read", "shell.exec", "mcp:whatever/list"] {
            let outputs = [ToolOutput {
                tool,
                output_ref: &out_ref,
                output_text: "x",
            }];
            let c = a.assemble(0, &intent_ref(), "x", &[], &outputs);
            assert_eq!(c.blocks[1].trust, TrustLevel::Untrusted, "tool = {tool}");
            assert_eq!(c.taint_level, TaintLevel::Tainted, "tool = {tool}");
        }
    }

    #[test]
    fn a_tool_output_block_cite_id_is_stable_and_distinct() {
        let a = Assembler::new("default");
        let out_ref = tool_output_ref();
        let outputs = [ToolOutput {
            tool: "fs.read",
            output_ref: &out_ref,
            output_text: "同一份内容",
        }];
        let one = a.assemble(3, &intent_ref(), "x", &[], &outputs);
        let two = a.assemble(3, &intent_ref(), "x", &[], &outputs);
        assert_eq!(one.blocks[1].cite_id, two.blocks[1].cite_id);
        assert_ne!(
            one.blocks[0].cite_id, one.blocks[1].cite_id,
            "intent block 与工具返回 block 的 cite_id 不能撞在一起"
        );
    }

    #[test]
    fn no_tool_output_means_the_context_stays_clean() {
        // 反向的钉子：接通污点不等于"从此什么都是脏的"。一条没调过工具的
        // run（eval 里的合成用例、以及任何还没走到第一次工具调用的 turn）
        // 必须仍然是 Clean，否则闸门会从"结构性防护"退化成"每一步都问人"。
        let a = Assembler::new("default");
        let ans_ref = answer_ref();
        let answers = [AnsweredClarification {
            answer_ref: &ans_ref,
            answer_text: "问题：是否继续？\n回答：是",
        }];
        let c = a.assemble(0, &intent_ref(), "把账龄表做出来", &answers, &[]);
        assert_eq!(c.taint_level, TaintLevel::Clean);
    }
}
