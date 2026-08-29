use crate::state::{AwaitReason, RunState, RunStatus};
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

/// 预算是否超限。**只在对应字段是 `Some` 时才判**——`None` 表示「不设
/// 限」，不是「设成 0」；把 `None` 当 0 比会让所有没配预算的 run 一启动
/// 就撞上限。三个维度独立判断，任一维度超了就算超限（`BudgetSpec` 与
/// `BudgetUsage` 的字段本就是一一对应的三元组，没有理由只查其中一个）。
fn budget_exceeded(state: &RunState) -> bool {
    let spec = &state.budget;
    let used = &state.budget_used;
    spec.max_tokens.is_some_and(|max| used.tokens > max)
        || spec
            .max_amount_micros
            .is_some_and(|max| used.amount_micros > max)
        || spec
            .max_wall_seconds
            .is_some_and(|max_seconds| used.wall_ms > max_seconds.saturating_mul(1000))
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

    // 预算超限：挂起，不是失败、也不是静默继续（功能清单原话「超限自动
    // 挂起而非静默烧钱」）。人提额后可续跑——续跑靠的是随后一条
    // `run.resumed`，与审批链路走的是同一套恢复机制。
    if budget_exceeded(state) {
        cmds.push(Command::Suspend {
            reason: AwaitReason::Budget,
        });
        return cmds;
    }

    // 有 effect 还没跑到终态，等执行面回流，不做新决策。`Denied` 与
    // `Settled` 都算终态（`EffectState::is_resolved`）——否则一个被拒的
    // effect 会让这个 turn 永远卡在这里，即使 run.resumed 已经把 awaiting
    // 清空也没用：decide 走不到下面重新规划的分支。
    if state.pending_effects.values().any(|v| !v.is_resolved()) {
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
