use crate::state::{AwaitReason, RunState, RunStatus};
use evo_protocol::events::accounting::CheckpointReason;
use evo_protocol::events::model::{PlanIntent, PlannedCall, PlannedClarification};

/// 每 50 个事件一个检查点（Q-06），外加 pre_write / pre_approval 两个语义点。
pub const CHECKPOINT_EVERY: u64 = 50;

/// 内核唯一的输出通道。runtime 执行 Command，把结果作为 Event 写回 Log。
///
/// `RequestEffect` 带的是 PlannedCall 而非完整 EffectRequest：
/// class / targets / egress 来自工具 manifest，内核看不到 manifest，由 Gateway 补全。
/// `AskClarification` 同理：题面与选项来自 `PlanStep.clarification`，内核
/// 原样转交，不另造一份空字符串占位。
#[derive(Clone, Debug, PartialEq)]
pub enum Command {
    SampleEnv,
    AssembleContext { turn: u32, profile: String },
    CallModel { turn: u32 },
    RequestEffect { call: PlannedCall },
    AskClarification { clarification: PlannedClarification },
    Checkpoint { reason: CheckpointReason },
    Suspend { reason: AwaitReason },
    Complete { status: RunStatus },
}

/// 预算是否已经用尽。**只在对应字段是 `Some` 时才判**——`None` 表示「不设
/// 限」，不是「设成 0」；把 `None` 当 0 会让所有没配预算的 run 一启动
/// 就撞上限。三个维度独立判断，任一维度用尽就算用尽（`BudgetSpec` 与
/// `BudgetUsage` 的字段本就是一一对应的三元组，没有理由只查其中一个）。
///
/// 三个维度现在都真的通电了，各自的写入方：
/// - `tokens` ← `model.responded`（`reduce` 累加 usage）
/// - `amount_micros` ← `cost.charged`
/// - `wall_ms` ← `env.sampled`（`clock_ms - clock_start_ms`，见
///   `RunState::clock_start_ms`）
///
/// 这段注释此前写着「三个维度独立判断」，而 `wall_ms` 在 `reduce` 的任何
/// arm 里都没有写入方，恒为 0——声明强于代码，实际只有两个维度活着
/// （M2 终审 BL-10）。补上写入方之后这句话才成立，别再让它跑到代码前面去。
///
/// 判据是 `>=` 而不是 `>`：**正好花到上限时余额是 0**，再放行一次动作
/// 必然超支。`>` 的语义是「花超了才算超」，它把上限读成了「可以花到、
/// 并且可以再多花一次」。
///
/// 这条判定是**后验**的：它拦的是「已经没钱了，别再开始下一步」，不是
/// 「这一步会花多少、够不够」。所以超支的上界是最后那一次动作的成本，
/// 不是零——预扣（在动作之前按预估成本扣减）需要一套预留/结算事件，
/// 见 `decide` 里预算分支上那段【记账项】说明。effect 那一侧的预扣已经由
/// Gateway 的第⑤步做了（`evo_gateway::pipeline::budget_gate`），模型调用
/// 这一侧还没有。
fn budget_exhausted(state: &RunState) -> bool {
    let spec = &state.budget;
    let used = &state.budget_used;
    spec.max_tokens.is_some_and(|max| used.tokens >= max)
        || spec
            .max_amount_micros
            .is_some_and(|max| used.amount_micros >= max)
        || spec
            .max_wall_seconds
            .is_some_and(|max_seconds| used.wall_ms >= max_seconds.saturating_mul(1000))
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

    // 预算用尽：挂起，不是失败、也不是静默继续（功能清单原话「超限自动
    // 挂起而非静默烧钱」）。
    //
    // 人提额后可续跑，需要**两条**事件：先一条 `budget.amended` 抬高
    // `RunState::budget`（否则下面这个判定仍然为真，`decide` 立刻再产出
    // 一次 `Suspend`，run 永远推不动），再一条 `run.resumed` 清空
    // `awaiting`。后半段与审批链路走的是同一套恢复机制。
    //
    // 这道闸门是 turn 级的：它拦的是「这条 run 还能不能开始下一步」。
    // effect 级的那道在 Gateway 第⑤步（`evo_gateway` 的 `budget_gate`），
    // 拦的是「这一次工具调用按影响预估会不会把额度打穿」。两道都要有，
    // 谁也替代不了谁——内核看不到 manifest 与影响预估，Gateway 不驱动
    // turn 循环。
    //
    // 【记账项，本轮未做】模型调用这一侧没有预扣：`CallModel` 之前无从
    // 知道这次会花多少（token 数要等响应回来才知道），计费发生在调用
    // **之后**（`cost.charged`）。所以即便闸门活着，最坏情况也会超支
    // 整整一次模型调用的成本。真正的预扣要求一套「预留 → 结算/释放」
    // 事件（下单前按 max_tokens 预估扣住，响应回来后按实际用量结算，
    // 失败要释放），涉及新事件、失败路径上的对账、以及回放语义，
    // 比这一轮的接线大得多，留给下一轮。`>=` 让超支的上界收敛到「一次
    // 调用」而不是「一次调用 + 上限本身」。
    if budget_exhausted(state) {
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

    match state.last_plan.as_ref() {
        Some(plan) => match plan.intent {
            PlanIntent::ToolCall => match plan.call.clone() {
                Some(call) => cmds.push(Command::RequestEffect { call }),
                None => {
                    // plan.step 说要调工具却没给 call —— runtime 解析出了问题
                    cmds.push(Command::Complete {
                        status: RunStatus::Failed,
                    });
                }
            },
            PlanIntent::Clarify => match plan.clarification.clone() {
                Some(clarification) => cmds.push(Command::AskClarification { clarification }),
                None => {
                    // 与 ToolCall 却没给 call 对称：Clarify 却没给要问的问题
                    cmds.push(Command::Complete {
                        status: RunStatus::Failed,
                    });
                }
            },
            PlanIntent::Finish => cmds.push(Command::Complete {
                status: RunStatus::Completed,
            }),
        },
        None => cmds.push(Command::Complete {
            status: RunStatus::Completed,
        }),
    }
    cmds
}
