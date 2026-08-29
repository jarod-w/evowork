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
    Approval { approval_id: ApprovalId, effect_id: EffectId },
    Clarification { question_id: String },
    /// [P2] 人机混合队列
    Human { step: String },
    Budget,
    /// [P2] 条件触发
    ExternalEvent { kind: String },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EffectState {
    Requested,
    Dispatched,
    Settled,
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
            Some(at) => self.last_seq.saturating_sub(at),
        }
    }
}
