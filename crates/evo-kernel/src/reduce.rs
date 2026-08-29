use crate::rng::DeterministicRng;
use crate::state::{ContextRecord, EffectState, RunState, RunStatus};
use evo_protocol::events::effect::ToolResultStatus;
use evo_protocol::events::lifecycle::CompletionStatus;
use evo_protocol::ids::RunId;
use evo_protocol::{Event, EventBody};

/// 纯函数。入参只有 &RunState 与 &Event，两者都是纯数据。
///
/// 注意：**不许读 `event.recorded_at`**。那是 daemon 的写入时刻，
/// 内核对时间的唯一来源是 env.sampled（01 §5）。
pub fn reduce(state: &RunState, event: &Event) -> RunState {
    debug_assert!(
        event.seq >= state.last_seq,
        "event.seq ({}) < state.last_seq ({}): 事件必须按 seq 非递减顺序喂进来。\
         `events()` 保证按 seq 升序返回；出现倒退说明调用方绕过了这个排序保证 \
         （回放器从快照恢复时会把快照所在 seq 的那条事件重新喂一遍，\
         此时 event.seq == state.last_seq，属于合法情况，故用 >= 而非 >）。",
        event.seq,
        state.last_seq
    );
    let mut s = state.clone();
    s.last_seq = event.seq;

    match &event.body {
        EventBody::RunCreated(e) => {
            s.budget = e.budget;
            s.status = RunStatus::Running;
        }
        EventBody::IntentDeclared(e) => {
            s.intent = Some(e.intent_ref.clone());
        }
        EventBody::EnvSampled(e) => {
            s.turn = e.turn;
            s.clock_ms = e.wall_clock_ms;
            s.rng = DeterministicRng::from_seed(&e.rng_seed);
            s.env = e.env.clone();
            s.env_sampled_turn = Some(e.turn);
        }
        EventBody::ContextAssembled(e) => {
            s.context = Some(ContextRecord {
                turn: e.turn,
                profile: e.profile.clone(),
                block_count: e.blocks.len() as u64,
                taint_level: e.taint_level,
                total_token_estimate: e.total_token_estimate,
            });
            s.taint = s.taint.join(e.taint_level);
            for b in &e.blocks {
                s.cites.insert(b.cite_id.clone());
            }
            s.context_turn = Some(e.turn);
        }
        EventBody::ModelRequested(_) => {}
        EventBody::ModelResponded(e) => {
            s.budget_used.tokens += e.usage.input + e.usage.output;
        }
        EventBody::PlanStep(e) => {
            s.taint = s.taint.join(e.taint_inherited);
            s.last_plan = Some(e.clone());
            s.plan_turn = Some(e.turn);
        }
        EventBody::ToolRequested(e) => {
            s.pending_effects
                .insert(e.effect_id.clone(), EffectState::Requested);
        }
        EventBody::PolicyEvaluated(_) | EventBody::ImpactEstimated(_) => {}
        EventBody::EffectDispatched(e) => {
            s.pending_effects
                .insert(e.effect_id.clone(), EffectState::Dispatched);
        }
        EventBody::ToolResult(e) => {
            s.pending_effects
                .insert(e.effect_id.clone(), EffectState::Settled);
            // 外部返回一律 tainted（02 §2 步骤 ③ 的前提）
            s.taint = s.taint.join(e.taint);
            for c in &e.cites_produced {
                s.cites.insert(c.clone());
            }
            if e.status == ToolResultStatus::Error {
                // 错误不终止 run，交给下一 turn 的模型处理
            }
            // 一个 effect 结算完，本 turn 结束，进入下一 turn
            if s.pending_effects
                .values()
                .all(|v| *v == EffectState::Settled)
            {
                s.turn += 1;
            }
        }
        EventBody::CostCharged(e) => {
            s.budget_used.amount_micros += e.amount_micros;
        }
        EventBody::Checkpoint(_) => {
            s.last_checkpoint_seq = Some(event.seq);
        }
        EventBody::RunCompleted(e) => {
            // Ok/Partial 都记成 Completed——Partial 尚无产生方，先按「完成」
            // 处理；Failed 是唯一改变终态的分支（终审 I1 之前，这里无条件写
            // Completed，把内核 decide 判出来的失败悄悄抹掉）。
            s.status = match e.status {
                CompletionStatus::Failed => RunStatus::Failed,
                CompletionStatus::Ok | CompletionStatus::Partial => RunStatus::Completed,
            };
        }
        // 下面这批变体是本次「事件目录补齐」新增的（M2 治理面 Task 1），
        // 尚无生产方，`reduce` 语义留给消费它们的那个任务去定（例如
        // `RunSuspended`/`RunResumed` 要驱动 `RunStatus::Suspended` 与
        // `AwaitReason`，`ApprovalRequested` 等要维护审批台账）。这里先给
        // 空 match 臂，只为满足穷尽性、让新增变体能编译通过；显式列出
        // 每个变体而不是用 `_` 通配，好让下一个任务给某个变体添加真实
        // 处理时，删掉对应这一行本身就是「待办清单」。
        EventBody::RunSuspended(_)
        | EventBody::RunResumed(_)
        | EventBody::RunFailed(_)
        | EventBody::ContextCompacted(_)
        | EventBody::ApprovalRequested(_)
        | EventBody::ApprovalGranted(_)
        | EventBody::ApprovalDenied(_)
        | EventBody::ApprovalExpired(_)
        | EventBody::ArtifactEmitted(_)
        | EventBody::ClarificationRequested(_)
        | EventBody::ClarificationAnswered(_) => {}
    }
    s
}

/// 从空状态起把一串事件叠起来。回放就是它。
pub fn fold(run_id: &RunId, events: &[Event]) -> RunState {
    events
        .iter()
        .fold(RunState::new(run_id), |s, e| reduce(&s, e))
}
