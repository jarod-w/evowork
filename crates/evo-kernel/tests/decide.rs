use evo_kernel::{AwaitReason, CHECKPOINT_EVERY, Command, RunState, RunStatus, decide};
use evo_protocol::events::model::{PlanIntent, PlanStep, PlannedCall};
use evo_protocol::{ApprovalId, BlobRef, EffectId, RunId, TaintLevel, ToolId};

fn base() -> RunState {
    RunState::new(&RunId::from("r-1"))
}

#[test]
fn a_fresh_run_samples_env_first() {
    assert_eq!(decide(&base()), vec![Command::SampleEnv]);
}

#[test]
fn after_env_comes_context() {
    let mut s = base();
    s.env_sampled_turn = Some(0);
    assert_eq!(
        decide(&s),
        vec![Command::AssembleContext {
            turn: 0,
            profile: "default".into()
        }]
    );
}

#[test]
fn after_context_comes_the_model() {
    let mut s = base();
    s.env_sampled_turn = Some(0);
    s.context_turn = Some(0);
    assert_eq!(decide(&s), vec![Command::CallModel { turn: 0 }]);
}

#[test]
fn a_tool_call_plan_becomes_a_request_effect() {
    let mut s = base();
    s.env_sampled_turn = Some(0);
    s.context_turn = Some(0);
    s.plan_turn = Some(0);
    let call = PlannedCall {
        tool: ToolId::from("fs.write"),
        params_ref: BlobRef {
            content_hash: "sha256:aa".into(),
            size: 2,
            mime: "application/json".into(),
        },
        params_digest: "d1".into(),
    };
    s.last_plan = Some(PlanStep {
        turn: 0,
        intent: PlanIntent::ToolCall,
        rationale_ref: None,
        taint_inherited: TaintLevel::Clean,
        call: Some(call.clone()),
        clarification: None,
    });
    assert_eq!(decide(&s), vec![Command::RequestEffect { call }]);
}

#[test]
fn a_finish_plan_completes_the_run() {
    let mut s = base();
    s.env_sampled_turn = Some(0);
    s.context_turn = Some(0);
    s.plan_turn = Some(0);
    s.last_plan = Some(PlanStep {
        turn: 0,
        intent: PlanIntent::Finish,
        rationale_ref: None,
        taint_inherited: TaintLevel::Clean,
        call: None,
        clarification: None,
    });
    assert_eq!(
        decide(&s),
        vec![Command::Complete {
            status: RunStatus::Completed
        }]
    );
}

#[test]
fn suspension_silences_the_kernel() {
    // 挂起不是特殊状态机，就是 awaiting 有值时 decide 返回空（03 §4）
    let mut s = base();
    s.awaiting = Some(AwaitReason::Approval {
        approval_id: ApprovalId::from("a-1"),
        effect_id: EffectId::from("e-1"),
    });
    assert!(decide(&s).is_empty());
}

#[test]
fn a_completed_run_produces_no_commands() {
    let mut s = base();
    s.status = RunStatus::Completed;
    assert!(decide(&s).is_empty());
}

#[test]
fn a_checkpoint_is_due_every_fifty_events() {
    let mut s = base();
    s.last_seq = CHECKPOINT_EVERY;
    s.last_checkpoint_seq = None;
    let cmds = decide(&s);
    assert!(
        matches!(cmds.first(), Some(Command::Checkpoint { .. })),
        "检查点要排在本轮其余命令之前"
    );
}

#[test]
fn no_second_checkpoint_immediately_after_one() {
    let mut s = base();
    s.last_seq = CHECKPOINT_EVERY;
    s.last_checkpoint_seq = Some(CHECKPOINT_EVERY);
    assert!(!matches!(
        decide(&s).first(),
        Some(Command::Checkpoint { .. })
    ));
}

#[test]
fn a_tool_call_plan_without_call_parameter_fails_the_run() {
    let mut s = base();
    s.env_sampled_turn = Some(0);
    s.context_turn = Some(0);
    s.plan_turn = Some(0);
    s.last_plan = Some(PlanStep {
        turn: 0,
        intent: PlanIntent::ToolCall,
        rationale_ref: None,
        taint_inherited: TaintLevel::Clean,
        call: None,
        clarification: None,
    });
    assert_eq!(
        decide(&s),
        vec![Command::Complete {
            status: RunStatus::Failed
        }]
    );
}
