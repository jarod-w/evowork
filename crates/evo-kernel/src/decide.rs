use crate::state::{AwaitReason, EffectState, RunState, RunStatus};
use evo_protocol::events::accounting::CheckpointReason;
use evo_protocol::events::model::{PlanIntent, PlannedCall};

/// 每 50 个事件一个检查点（Q-06），外加 pre_write / pre_approval 两个语义点。
pub const CHECKPOINT_EVERY: u64 = 50;

/// 内核唯一的输出通道。runtime 执行 Command，把结果作为 Event 写回 Log。
///
/// `RequestEffect` 带的是 PlannedCall 而非完整 EffectRequest：
/// class / targets / egress 来自工具 manifest，内核看不到 manifest，由 Gateway 补全。
#[derive(Clone, Debug, PartialEq)]
pub enum Command {
    SampleEnv,
    AssembleContext { turn: u32, profile: String },
    CallModel { turn: u32 },
    RequestEffect { call: PlannedCall },
    AskClarification { question: String },
    Checkpoint { reason: CheckpointReason },
    Suspend { reason: AwaitReason },
    Complete { status: RunStatus },
}

/// 纯函数：给定状态，内核说「接下来该做什么」，但不做。
pub fn decide(state: &RunState) -> Vec<Command> {
    if state.status != RunStatus::Running || state.awaiting.is_some() {
        return Vec::new();
    }

    let mut cmds = Vec::new();
    if state.events_since_checkpoint() >= CHECKPOINT_EVERY {
        cmds.push(Command::Checkpoint {
            reason: CheckpointReason::Periodic,
        });
    }

    // 有 effect 还没结算，等执行面回流，不做新决策
    if state
        .pending_effects
        .values()
        .any(|v| *v != EffectState::Settled)
    {
        return cmds;
    }

    let turn = state.turn;
    if state.env_sampled_turn != Some(turn) {
        cmds.push(Command::SampleEnv);
        return cmds;
    }
    if state.context_turn != Some(turn) {
        cmds.push(Command::AssembleContext {
            turn,
            profile: "default".to_owned(),
        });
        return cmds;
    }
    if state.plan_turn != Some(turn) {
        cmds.push(Command::CallModel { turn });
        return cmds;
    }

    match state.last_plan.as_ref().map(|p| (p.intent, p.call.clone())) {
        Some((PlanIntent::ToolCall, Some(call))) => {
            cmds.push(Command::RequestEffect { call });
        }
        Some((PlanIntent::ToolCall, None)) => {
            // plan.step 说要调工具却没给 call —— runtime 解析出了问题
            cmds.push(Command::Complete {
                status: RunStatus::Failed,
            });
        }
        Some((PlanIntent::Clarify, _)) => {
            cmds.push(Command::AskClarification {
                question: String::new(),
            });
        }
        Some((PlanIntent::Finish, _)) | None => {
            cmds.push(Command::Complete {
                status: RunStatus::Completed,
            });
        }
    }
    cmds
}
