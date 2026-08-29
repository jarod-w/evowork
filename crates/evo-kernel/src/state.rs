use crate::rng::DeterministicRng;
use evo_protocol::blob::BlobRef;
use evo_protocol::budget::{BudgetSpec, BudgetUsage};
use evo_protocol::events::model::PlanStep;
use evo_protocol::ids::{ApprovalId, ArtifactId, CiteId, EffectId, RunId};
use evo_protocol::taint::TaintLevel;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RunStatus {
    #[default]
    Running,
    Suspended,
    Completed,
    Failed,
}

/// 挂起原因。异步审批就住在这里——恢复 = 往 Log 追加一个事件（03 §4）。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AwaitReason {
    Approval {
        approval_id: ApprovalId,
        effect_id: EffectId,
    },
    Clarification {
        question_id: String,
    },
    /// [P2] 人机混合队列
    Human {
        step: String,
    },
    Budget,
    /// [P2] 条件触发
    ExternalEvent {
        kind: String,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EffectState {
    Requested,
    Dispatched,
    Settled,
    /// 对应这个 effect 的审批被 `approval.denied`（或到期未处理，
    /// `approval.expired`）终结——它不会再变成 `Dispatched`/`Settled`，
    /// 是与二者并列的另一个终态。
    ///
    /// 落在 `pending_effects` 而不是另开一个 `RunState::denied_effects`
    /// 集合，是刻意的：`pending_effects` 已经是「这个 effect 现在什么
    /// 状态」的唯一真源，daemon 决定要不要派发、UI 渲染这一步的状态，
    /// 两边原本就在读这张表；再开一张表要求两处消费方永远同步维护两份
    /// 账本，而这里只需要多认一个变体。代价是 `EffectState::is_resolved`
    /// 之类的调用点要记得把 `Denied` 与 `Settled` 一起当「已解决」处理
    /// （见 `reduce`/`decide` 里对它的使用）。
    Denied,
}

impl EffectState {
    /// 这个 effect 是否已经跑到终态——不会再产生后续事件。`decide` 用它
    /// 判断「还要不要等执行面回流」，`reduce` 用它判断「这个 turn 是否
    /// 可以往前走」。`Denied` 与 `Settled` 都是终态，区别只在于终态的
    /// 种类，不在于是否还需要等待。
    pub fn is_resolved(&self) -> bool {
        matches!(self, EffectState::Settled | EffectState::Denied)
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ArtifactRecord {
    pub artifact_id: ArtifactId,
    pub path: String,
    pub content_hash: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ContextRecord {
    pub turn: u32,
    pub profile: String,
    pub block_count: u64,
    pub taint_level: TaintLevel,
    pub total_token_estimate: u64,
}

/// 内核的全部状态。**全部有序容器**——HashMap 的迭代顺序会让 state_hash 不稳定。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct RunState {
    pub run_id: RunId,
    pub status: RunStatus,
    pub turn: u32,

    /// 只由 env.sampled 写入。内核想读时钟，只有这一个地方可读。
    pub clock_ms: u64,
    /// 同上，只由 env.sampled 写入
    pub rng: DeterministicRng,
    pub env: BTreeMap<String, String>,

    pub intent: Option<BlobRef>,
    pub context: Option<ContextRecord>,
    pub taint: TaintLevel,

    pub last_plan: Option<PlanStep>,
    pub pending_effects: BTreeMap<EffectId, EffectState>,
    pub awaiting: Option<AwaitReason>,

    /// 审批台账：`approval.requested` 插入，`approval.granted` /
    /// `approval.denied` / `approval.expired` 移除。`run.suspended`
    /// 判定 `SuspendReason::AwaitingApproval` 时，从这张表里取出当前
    /// 唯一一条未决审批，拼出 `AwaitReason::Approval`。
    pub pending_approvals: BTreeMap<ApprovalId, EffectId>,
    /// 当前未回答的追问 id。`clarification.requested` 写入，
    /// `clarification.answered` 清空。`run.suspended` 判定
    /// `SuspendReason::AwaitingHuman`（澄清式追问，02 §…doc）时，从这里
    /// 取出 question_id 拼出 `AwaitReason::Clarification`。
    pub pending_question: Option<String>,

    pub budget: BudgetSpec,
    pub budget_used: BudgetUsage,
    pub artifacts: Vec<ArtifactRecord>,
    pub cites: BTreeSet<CiteId>,

    // —— turn 循环的进度标记：decide 靠它们判断这一 turn 走到哪了 ——
    pub env_sampled_turn: Option<u32>,
    pub context_turn: Option<u32>,
    pub plan_turn: Option<u32>,

    pub last_seq: u64,
    pub last_checkpoint_seq: Option<u64>,

    /// [P2] Fleet
    pub children: Vec<RunId>,
}

impl RunState {
    pub fn new(run_id: &RunId) -> Self {
        Self {
            run_id: run_id.clone(),
            status: RunStatus::Running,
            turn: 0,
            clock_ms: 0,
            rng: DeterministicRng::from_seed(""),
            env: BTreeMap::new(),
            intent: None,
            context: None,
            taint: TaintLevel::Clean,
            last_plan: None,
            pending_effects: BTreeMap::new(),
            awaiting: None,
            pending_approvals: BTreeMap::new(),
            pending_question: None,
            budget: BudgetSpec::default(),
            budget_used: BudgetUsage::default(),
            artifacts: Vec::new(),
            cites: BTreeSet::new(),
            env_sampled_turn: None,
            context_turn: None,
            plan_turn: None,
            last_seq: 0,
            last_checkpoint_seq: None,
            children: Vec::new(),
        }
    }

    /// 距上一个检查点过了多少事件。decide 用它决定要不要 Checkpoint。
    pub fn events_since_checkpoint(&self) -> u64 {
        match self.last_checkpoint_seq {
            None => self.last_seq + 1,
            Some(at) => {
                debug_assert!(
                    at <= self.last_seq,
                    "last_checkpoint_seq ({at}) > last_seq ({}): 检查点比最新事件还新，\
                     这是不可能出现的状态。写检查点时 reduce 会把 last_checkpoint_seq \
                     与 last_seq 同时设成同一个 event.seq，之后 last_seq 只增不减，\
                     所以 last_checkpoint_seq <= last_seq 恒成立；出现违反说明状态 \
                     被别的路径污染了。若这里用 saturating_sub 掩盖，会静默返回 0，\
                     表现为『刚打完检查点』，导致该打检查点时不打。",
                    self.last_seq
                );
                self.last_seq.saturating_sub(at)
            }
        }
    }
}
