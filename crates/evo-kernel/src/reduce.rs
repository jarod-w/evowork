use crate::rng::DeterministicRng;
use crate::state::{ContextRecord, EffectState, RunState, RunStatus};
use evo_protocol::events::effect::ToolResultStatus;
use evo_protocol::ids::RunId;
use evo_protocol::{Event, EventBody};

/// 纯函数。入参只有 &RunState 与 &Event，两者都是纯数据。
///
/// 注意：**不许读 `event.recorded_at`**。那是 daemon 的写入时刻，
/// 内核对时间的唯一来源是 env.sampled（01 §5）。
pub fn reduce(state: &RunState, event: &Event) -> RunState {
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
        EventBody::RunCompleted(_) => {
            s.status = RunStatus::Completed;
        }
    }
    s
}

/// 从空状态起把一串事件叠起来。回放就是它。
pub fn fold(run_id: &RunId, events: &[Event]) -> RunState {
    events
        .iter()
        .fold(RunState::new(run_id), |s, e| reduce(&s, e))
}
