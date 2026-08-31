use evo_kernel::{RunState, RunStatus, fold, reduce};
use evo_protocol::events::artifact::ArtifactEmitted;
use evo_protocol::events::context::{ContextAssembled, ContextBlock};
use evo_protocol::events::determinism::{EnvSampled, ModelRoute};
use evo_protocol::events::effect::{ToolResult, ToolResultStatus};
use evo_protocol::events::lifecycle::{CompletionStatus, RunCompleted};
use evo_protocol::events::model::{PlanIntent, PlanStep};
use evo_protocol::{
    Actor, ArtifactId, BlobRef, CiteId, EffectId, Event, EventBody, RunId, TaintLevel, TrustLevel,
};

fn ev(seq: u64, body: EventBody) -> Event {
    Event {
        run_id: RunId::from("r-1"),
        seq,
        recorded_at: "2026-08-29T10:00:00Z".into(),
        actor: Actor::Runtime,
        schema_ver: 1,
        body,
    }
}

fn env_sampled(turn: u32, clock: u64) -> EventBody {
    EventBody::EnvSampled(EnvSampled {
        turn,
        wall_clock_ms: clock,
        rng_seed: "seed-0".into(),
        env: Default::default(),
        model_route: ModelRoute {
            provider: "fixture".into(),
            model: "fixture-v1".into(),
            params_digest: "d0".into(),
        },
    })
}

#[test]
fn env_sampled_is_the_only_way_the_clock_moves() {
    let s = RunState::new(&RunId::from("r-1"));
    assert_eq!(s.clock_ms, 0);
    let s = reduce(&s, &ev(0, env_sampled(0, 1_756_461_600_000)));
    assert_eq!(s.clock_ms, 1_756_461_600_000);
    assert_eq!(s.env_sampled_turn, Some(0));
}

#[test]
fn reduce_never_mutates_the_input_state() {
    let before = RunState::new(&RunId::from("r-1"));
    let after = reduce(&before, &ev(0, env_sampled(0, 42)));
    assert_eq!(before.clock_ms, 0, "入参必须原样不动");
    assert_eq!(after.clock_ms, 42);
}

#[test]
fn last_seq_follows_the_event() {
    let s = reduce(
        &RunState::new(&RunId::from("r-1")),
        &ev(7, env_sampled(0, 1)),
    );
    assert_eq!(s.last_seq, 7);
}

#[test]
fn context_taint_is_carried_into_state() {
    let s = RunState::new(&RunId::from("r-1"));
    let s = reduce(
        &s,
        &ev(
            0,
            EventBody::ContextAssembled(ContextAssembled {
                turn: 0,
                profile: "default".into(),
                blocks: vec![ContextBlock {
                    cite_id: CiteId::from("c-1"),
                    source: "tool:web.fetch".into(),
                    trust: TrustLevel::Untrusted,
                    scope: "run".into(),
                    content_hash: "sha256:ab".into(),
                    span: None,
                    token_estimate: 10,
                }],
                taint_level: TaintLevel::Tainted,
                total_token_estimate: 10,
            }),
        ),
    );
    assert_eq!(s.taint, TaintLevel::Tainted);
    assert_eq!(s.context_turn, Some(0));
    assert!(s.cites.contains(&CiteId::from("c-1")));
}

/// M2 终审 BL-9：`tool.result` → `RunState.taint` 这一段传播链。
///
/// 闸门（`evo_gateway` 管线第 ③ 步）读的是 `RunState.taint`，而 daemon
/// 每次 `admit` 都把 `state.taint` 原样递进去。所以「执行器标了污点」到
/// 「闸门看得见」中间只隔这一行 `join`——它必须被单独钉住，不能只靠
/// 端到端测试间接覆盖。
#[test]
fn tool_result_taint_is_carried_into_state() {
    let s = RunState::new(&RunId::from("r-1"));
    let s = reduce(
        &s,
        &ev(
            0,
            EventBody::ToolResult(ToolResult {
                effect_id: EffectId::from("e-1"),
                status: ToolResultStatus::Ok,
                output_ref: None,
                bytes: None,
                taint: TaintLevel::Tainted,
                cites_produced: Vec::new(),
                actual_targets: Vec::new(),
                actual_egress: Vec::new(),
            }),
        ),
    );
    assert_eq!(s.taint, TaintLevel::Tainted);
}

/// 污点只升不降：脏了之后，一次 `Clean` 的工具返回（比如 `fs.write`
/// 成功，它不回传任何内容）不能把 run 洗回干净。这条要是红了，
/// 「先读一个外部文件、再写一个文件、然后就自由了」就成立了。
#[test]
fn a_clean_tool_result_cannot_wash_the_taint_off() {
    let s = RunState::new(&RunId::from("r-1"));
    let dirty = reduce(
        &s,
        &ev(
            0,
            EventBody::ToolResult(ToolResult {
                effect_id: EffectId::from("e-1"),
                status: ToolResultStatus::Ok,
                output_ref: None,
                bytes: None,
                taint: TaintLevel::Tainted,
                cites_produced: Vec::new(),
                actual_targets: Vec::new(),
                actual_egress: Vec::new(),
            }),
        ),
    );
    let after = reduce(
        &dirty,
        &ev(
            1,
            EventBody::ToolResult(ToolResult {
                effect_id: EffectId::from("e-2"),
                status: ToolResultStatus::Ok,
                output_ref: None,
                bytes: None,
                taint: TaintLevel::Clean,
                cites_produced: Vec::new(),
                actual_targets: Vec::new(),
                actual_egress: Vec::new(),
            }),
        ),
    );
    assert_eq!(after.taint, TaintLevel::Tainted);
}

#[test]
fn plan_step_records_the_turn_it_belongs_to() {
    let s = RunState::new(&RunId::from("r-1"));
    let s = reduce(
        &s,
        &ev(
            0,
            EventBody::PlanStep(PlanStep {
                turn: 0,
                intent: PlanIntent::Finish,
                rationale_ref: None,
                taint_inherited: TaintLevel::Clean,
                call: None,
                clarification: None,
            }),
        ),
    );
    assert_eq!(s.plan_turn, Some(0));
}

#[test]
fn run_completed_stops_the_machine() {
    let s = RunState::new(&RunId::from("r-1"));
    let s = reduce(
        &s,
        &ev(
            0,
            EventBody::RunCompleted(RunCompleted {
                status: CompletionStatus::Ok,
                summary_ref: None,
            }),
        ),
    );
    assert_eq!(s.status, RunStatus::Completed);
}

#[test]
fn fold_is_reduce_applied_in_order() {
    let events = vec![ev(0, env_sampled(0, 10)), ev(1, env_sampled(1, 20))];
    let s = fold(&RunId::from("r-1"), &events);
    assert_eq!(s.clock_ms, 20);
    assert_eq!(s.turn, 1, "env.sampled 的 turn 推进 state.turn");
}

#[test]
fn folding_the_same_events_twice_gives_the_same_state() {
    let events = vec![ev(0, env_sampled(0, 10)), ev(1, env_sampled(1, 20))];
    assert_eq!(
        fold(&RunId::from("r-1"), &events),
        fold(&RunId::from("r-1"), &events)
    );
}

#[test]
fn artifact_emitted_is_folded_into_run_state() {
    let blob = BlobRef {
        content_hash: "sha256:art".into(),
        size: 4,
        mime: "text/plain".into(),
    };
    let s = reduce(
        &RunState::new(&RunId::from("r-1")),
        &ev(
            0,
            EventBody::ArtifactEmitted(ArtifactEmitted {
                artifact_id: ArtifactId::from("r-1-art0"),
                path: "report.txt".into(),
                blob,
                cites: vec![],
                supersedes: None,
            }),
        ),
    );
    assert_eq!(s.artifacts.len(), 1);
    assert_eq!(s.artifacts[0].path, "report.txt");
    assert_eq!(s.artifacts[0].content_hash, "sha256:art");
}
