//! 挂起/恢复/审批/澄清/预算闸门——覆盖 M2 Task 2 的核心行为。
//!
//! 设计前提（03 §4）：挂起不是特殊状态机，就是 `awaiting` 有值时 `decide`
//! 返回空；恢复 = 往 Log 追加一个 `run.resumed` 事件。`awaiting` 的清空
//! 只能由 `run.resumed` 负责——审批/澄清本身都不许直接清它。

use evo_kernel::{AwaitReason, Command, EffectState, RunState, RunStatus, decide, fold, reduce};
use evo_protocol::effect::EffectClass;
use evo_protocol::events::approval::{
    ApprovalDenied, ApprovalGranted, ApprovalRequested, ApprovalVia, RiskLevel,
};
use evo_protocol::events::clarification::{ClarificationAnswered, ClarificationRequested};
use evo_protocol::events::effect::ToolRequested;
use evo_protocol::events::lifecycle::{RunResumed, RunSuspended, SuspendReason};
use evo_protocol::events::model::{PlanIntent, PlanStep};
use evo_protocol::taint::TaintLevel;
use evo_protocol::{Actor, ApprovalId, BlobRef, EffectId, Event, EventBody, RunId, ToolId};

fn ev(seq: u64, body: EventBody) -> Event {
    Event {
        run_id: RunId::from("r-1"),
        seq,
        // 内核不许读这个字段——填一个假值，恰恰是为了证明它不影响任何结果。
        recorded_at: "not-a-real-timestamp".into(),
        actor: Actor::Runtime,
        schema_ver: 1,
        body,
    }
}

fn blob_ref() -> BlobRef {
    BlobRef {
        content_hash: "sha256:aa".into(),
        size: 2,
        mime: "application/json".into(),
    }
}

fn tool_requested(effect_id: &str, turn: u32) -> EventBody {
    EventBody::ToolRequested(ToolRequested {
        effect_id: EffectId::from(effect_id),
        turn,
        tool: ToolId::from("fs.write"),
        params_ref: blob_ref(),
        params_digest: "d1".into(),
        class: EffectClass::Write,
        declared_targets: vec![],
        declared_egress: vec![],
        reversible: true,
        cites_referenced: vec![],
    })
}

fn approval_requested(approval_id: &str, effect_id: &str) -> EventBody {
    EventBody::ApprovalRequested(ApprovalRequested {
        approval_id: ApprovalId::from(approval_id),
        effect_id: EffectId::from(effect_id),
        risk: RiskLevel::L2,
        impact_ref: None,
        expires_at_ms: 1_000_000,
    })
}

fn approval_granted(approval_id: &str) -> EventBody {
    EventBody::ApprovalGranted(ApprovalGranted {
        approval_id: ApprovalId::from(approval_id),
        by: Actor::Human("u-1".into()),
        via: ApprovalVia::Ui,
        note_ref: None,
    })
}

fn approval_denied(approval_id: &str) -> EventBody {
    EventBody::ApprovalDenied(ApprovalDenied {
        approval_id: ApprovalId::from(approval_id),
        by: Actor::Human("u-1".into()),
        reason_ref: None,
    })
}

fn run_suspended(reason: SuspendReason) -> EventBody {
    EventBody::RunSuspended(RunSuspended {
        reason,
        detail_ref: None,
    })
}

fn run_resumed(from_seq: u64) -> EventBody {
    EventBody::RunResumed(RunResumed {
        by: Actor::Human("u-1".into()),
        from_seq,
    })
}

fn clarification_requested(question_id: &str) -> EventBody {
    EventBody::ClarificationRequested(ClarificationRequested {
        question_id: question_id.into(),
        prompt_ref: blob_ref(),
        options: vec![],
    })
}

fn clarification_answered(question_id: &str) -> EventBody {
    EventBody::ClarificationAnswered(ClarificationAnswered {
        question_id: question_id.into(),
        by: Actor::Human("u-1".into()),
        option_id: Some("opt-1".into()),
        free_text_ref: None,
    })
}

// ————————————————————————————————————————————————————————————
// 1. run.suspended 之后 awaiting 有值、decide 返回空
// ————————————————————————————————————————————————————————————

#[test]
fn run_suspended_sets_awaiting_and_silences_decide() {
    let events = vec![ev(0, run_suspended(SuspendReason::BudgetExhausted))];
    let s = fold(&RunId::from("r-1"), &events);

    assert_eq!(s.status, RunStatus::Suspended);
    assert_eq!(s.awaiting, Some(AwaitReason::Budget));
    assert!(decide(&s).is_empty());
}

// ————————————————————————————————————————————————————————————
// 2. run.resumed 之后 awaiting 清空、decide 重新有输出
// ————————————————————————————————————————————————————————————

#[test]
fn run_resumed_clears_awaiting_and_wakes_decide_back_up() {
    let events = vec![
        ev(0, run_suspended(SuspendReason::BudgetExhausted)),
        ev(1, run_resumed(2)),
    ];
    let s = fold(&RunId::from("r-1"), &events);

    assert_eq!(s.status, RunStatus::Running);
    assert_eq!(s.awaiting, None);
    // 一个全新的 state（没采过 env）：decide 重新给出输出，第一件事永远是
    // SampleEnv。
    assert_eq!(decide(&s), vec![Command::SampleEnv]);
}

#[test]
fn approval_granted_alone_does_not_clear_awaiting() {
    // 红线①：awaiting 的清空只由 run.resumed 负责。approval.granted 只
    // 是记账——如果它直接清了 awaiting，这条测试会失败。
    let events = vec![
        ev(0, tool_requested("e-1", 0)),
        ev(1, approval_requested("a-1", "e-1")),
        ev(2, run_suspended(SuspendReason::AwaitingApproval)),
        ev(3, approval_granted("a-1")),
    ];
    let s = fold(&RunId::from("r-1"), &events);

    assert_eq!(
        s.status,
        RunStatus::Suspended,
        "approval.granted 不许把 run 直接改回 Running"
    );
    assert!(
        s.awaiting.is_some(),
        "approval.granted 不许清空 awaiting——只有 run.resumed 可以"
    );
    assert!(decide(&s).is_empty());
}

// ————————————————————————————————————————————————————————————
// 3. approval.requested -> approval.granted -> run.resumed：
//    pending_approvals 清空，run 可继续
// ————————————————————————————————————————————————————————————

#[test]
fn approval_granted_then_resumed_lets_the_run_continue() {
    let events = vec![
        ev(0, tool_requested("e-1", 0)),
        ev(1, approval_requested("a-1", "e-1")),
        ev(2, run_suspended(SuspendReason::AwaitingApproval)),
        ev(3, approval_granted("a-1")),
        ev(4, run_resumed(5)),
    ];
    let s = fold(&RunId::from("r-1"), &events);

    assert!(
        s.pending_approvals.is_empty(),
        "批准之后台账要清干净：{:?}",
        s.pending_approvals
    );
    assert_eq!(s.status, RunStatus::Running);
    assert_eq!(s.awaiting, None);
    // effect 还停在 Requested（还没被真正派发/结算），所以 decide 现在
    // 应该在等执行面回流，而不是空手——它不再是「挂起」，只是「等」。
    assert_eq!(
        s.pending_effects.get(&EffectId::from("e-1")),
        Some(&EffectState::Requested)
    );
    assert!(
        decide(&s).is_empty() || matches!(decide(&s).first(), Some(Command::Checkpoint { .. })),
        "run 已经不再 awaiting，只是仍在等这个 effect 结算，不应该重新规划新动作"
    );
}

// ————————————————————————————————————————————————————————————
// 4. approval.denied 之后 run 不能继续跑那个 effect
// ————————————————————————————————————————————————————————————

#[test]
fn approval_denied_marks_the_effect_as_a_terminal_denial() {
    let events = vec![
        ev(0, tool_requested("e-1", 0)),
        ev(1, approval_requested("a-1", "e-1")),
        ev(2, run_suspended(SuspendReason::AwaitingApproval)),
        ev(3, approval_denied("a-1")),
    ];
    let s = fold(&RunId::from("r-1"), &events);

    // 台账销掉了这条审批……
    assert!(s.pending_approvals.is_empty());
    // ……effect 落在一个跟 Settled 并列、但可区分的终态上——不是被悄悄
    // 删掉，也不是回到 Requested 留着看起来还能重跑。
    assert_eq!(
        s.pending_effects.get(&EffectId::from("e-1")),
        Some(&EffectState::Denied)
    );
    assert_ne!(
        s.pending_effects.get(&EffectId::from("e-1")),
        Some(&EffectState::Settled)
    );
}

#[test]
fn after_denial_and_resume_decide_never_re_requests_the_denied_effect() {
    let events = vec![
        ev(0, tool_requested("e-1", 0)),
        ev(1, approval_requested("a-1", "e-1")),
        ev(2, run_suspended(SuspendReason::AwaitingApproval)),
        ev(3, approval_denied("a-1")),
        ev(4, run_resumed(5)),
    ];
    let s = fold(&RunId::from("r-1"), &events);

    assert_eq!(s.status, RunStatus::Running);
    assert_eq!(s.awaiting, None);
    // 被拒也是一种终态，跟 Settled 一样会把 turn 往前推——否则 decide 会
    // 卡在「还有 effect 没结算」的阻塞检查上，run.resumed 清了 awaiting
    // 也没用。
    assert_eq!(s.turn, 1, "被拒的 effect 应该像结算完一样让 turn 前进");

    let cmds = decide(&s);
    assert!(
        !cmds
            .iter()
            .any(|c| matches!(c, Command::RequestEffect { .. })),
        "decide 不许再对这个被拒的 effect（或任何 effect）重新发起请求：{cmds:?}"
    );
}

// ————————————————————————————————————————————————————————————
// 5+6. 预算超限：Suspend，不是 Complete，也不是静默继续
// ————————————————————————————————————————————————————————————

#[test]
fn budget_exhaustion_suspends_instead_of_completing_or_failing() {
    let mut s = RunState::new(&RunId::from("r-1"));
    s.env_sampled_turn = Some(0);
    s.budget.max_amount_micros = Some(1_000);
    s.budget_used.amount_micros = 1_001;

    let cmds = decide(&s);
    assert_eq!(
        cmds,
        vec![Command::Suspend {
            reason: AwaitReason::Budget
        }],
        "超限必须产出 Suspend，不能是 Complete{{Failed}}，也不能悄悄放行"
    );
    assert!(!cmds.iter().any(|c| matches!(c, Command::Complete { .. })));
}

#[test]
fn budget_none_means_unlimited_not_zero() {
    // 红线：只在对应字段是 Some 时才判。None 表示不设限，不是设成 0——
    // 这里 amount_micros 已经花了不少，但没有设上限，不该被挂起。
    let mut s = RunState::new(&RunId::from("r-1"));
    s.budget_used.amount_micros = 999_999_999;
    s.budget_used.tokens = 999_999_999;
    s.budget_used.wall_ms = 999_999_999;
    // budget 三个维度全是默认 None

    assert_eq!(decide(&s), vec![Command::SampleEnv]);
}

#[test]
fn raising_the_budget_lets_a_suspended_run_continue() {
    // 「人提额后可续跑」：把超限之后的挂起状态跑一遍，再模拟人提额
    // （直接把 max 调高——本任务的事件目录里还没有专门的「提额」事件，
    // 提额本身不是这个任务的范围），run.resumed 之后应该正常继续决策。
    let mut s = RunState::new(&RunId::from("r-1"));
    s.env_sampled_turn = Some(0);
    s.budget.max_amount_micros = Some(1_000);
    s.budget_used.amount_micros = 1_001;
    assert_eq!(
        decide(&s),
        vec![Command::Suspend {
            reason: AwaitReason::Budget
        }]
    );

    let suspended = reduce(&s, &ev(0, run_suspended(SuspendReason::BudgetExhausted)));
    assert!(decide(&suspended).is_empty());

    let mut resumed = reduce(&suspended, &ev(1, run_resumed(2)));
    resumed.budget.max_amount_micros = Some(10_000); // 人提额
    assert_eq!(
        decide(&resumed),
        vec![Command::AssembleContext {
            turn: 0,
            profile: "default".into()
        }]
    );
}

// ————————————————————————————————————————————————————————————
// 7. clarification.requested -> clarification.answered 的同构链路
// ————————————————————————————————————————————————————————————

#[test]
fn clarification_chain_mirrors_the_approval_chain() {
    let events = vec![
        ev(0, clarification_requested("q-1")),
        ev(1, run_suspended(SuspendReason::AwaitingHuman)),
    ];
    let s = fold(&RunId::from("r-1"), &events);

    assert_eq!(s.pending_question, Some("q-1".to_owned()));
    assert_eq!(
        s.awaiting,
        Some(AwaitReason::Clarification {
            question_id: "q-1".into()
        })
    );
    assert!(decide(&s).is_empty());

    // 回答本身不清 awaiting（跟 approval.granted 同理）。
    let answered = reduce(&s, &ev(2, clarification_answered("q-1")));
    assert_eq!(answered.pending_question, None);
    assert!(
        answered.awaiting.is_some(),
        "clarification.answered 不许直接清空 awaiting——只有 run.resumed 可以"
    );
    assert!(decide(&answered).is_empty());

    // 只有显式的 run.resumed 才真正解除挂起。
    let resumed = reduce(&answered, &ev(3, run_resumed(4)));
    assert_eq!(resumed.awaiting, None);
    assert_eq!(resumed.status, RunStatus::Running);
    assert_eq!(decide(&resumed), vec![Command::SampleEnv]);
}

// ————————————————————————————————————————————————————————————
// 8. 澄清死循环修复：回答之后 decide 不能再发一次 AskClarification
//    （上面第 7 条测试没抓到这个——它从空状态起步，env_sampled_turn 一直
//    是 None，decide 第一条分支永远先判 SampleEnv，根本走不到
//    plan_turn/last_plan 那条会重发 AskClarification 的分支。这里手工
//    把进度标记推到「这一 turn 已经问完模型、模型说要 Clarify」的状态，
//    才能真正复现并验证死循环已经被打破。）
// ————————————————————————————————————————————————————————————

/// 模拟「这一 turn 已经采样环境、装配上下文、问过模型，模型的答复是
/// Clarify」的状态——`clarification.requested` 正常发生在这之后。
fn state_mid_turn_with_clarify_plan(turn: u32) -> RunState {
    let mut s = RunState::new(&RunId::from("r-1"));
    s.turn = turn;
    s.env_sampled_turn = Some(turn);
    s.context_turn = Some(turn);
    s.plan_turn = Some(turn);
    s.last_plan = Some(PlanStep {
        turn,
        intent: PlanIntent::Clarify,
        rationale_ref: None,
        taint_inherited: TaintLevel::Clean,
        call: None,
        clarification: None,
    });
    s
}

#[test]
fn clarification_answered_and_resumed_does_not_ask_again() {
    let mid_turn = state_mid_turn_with_clarify_plan(3);
    // decide 在问过之前必须先真的问一次——否则下面「不再追问」的断言就是
    // 空话。
    assert_eq!(
        decide(&mid_turn),
        vec![Command::AskClarification {
            question: String::new()
        }]
    );

    let events = vec![
        ev(0, clarification_requested("q-1")),
        ev(1, run_suspended(SuspendReason::AwaitingHuman)),
        ev(2, clarification_answered("q-1")),
        ev(3, run_resumed(4)),
    ];
    let s = events.into_iter().fold(mid_turn, |s, e| reduce(&s, &e));

    assert_eq!(s.status, RunStatus::Running);
    assert_eq!(s.awaiting, None);

    let cmds = decide(&s);
    assert!(
        !cmds
            .iter()
            .any(|c| matches!(c, Command::AskClarification { .. })),
        "回答之后 decide 不许再发一次 AskClarification——这正是那个死循环：{cmds:?}"
    );
    // 进度标记被退回到「需要重新装配上下文」，decide 应该产出
    // AssembleContext（env 那一步已经在这个 turn 采过了，不需要重采）。
    assert_eq!(
        cmds,
        vec![Command::AssembleContext {
            turn: 3,
            profile: "default".into()
        }]
    );
}

#[test]
fn clarification_answered_can_reach_call_model_after_context_reassembled() {
    let mid_turn = state_mid_turn_with_clarify_plan(3);
    let events = vec![
        ev(0, clarification_requested("q-1")),
        ev(1, run_suspended(SuspendReason::AwaitingHuman)),
        ev(2, clarification_answered("q-1")),
        ev(3, run_resumed(4)),
    ];
    let mut s = events.into_iter().fold(mid_turn, |s, e| reduce(&s, &e));

    // 手工推进进度标记，模拟「装配器已经把答案带进新的上下文」——本任务
    // 不管装配器怎么做到这一点,只验证内核这边看到 context_turn 追上
    // 之后会正确地继续往前走到 CallModel，而不是卡在别处或者又绕回
    // Clarify（`last_plan` 此时还是旧的那份，但 decide 判断
    // 「要不要重新规划」只看 plan_turn 是否追上 turn，不看 last_plan 的
    // 陈旧内容——重新规划之后 last_plan 会被新的 plan.step 覆盖）。
    s.context_turn = Some(s.turn);

    assert_eq!(decide(&s), vec![Command::CallModel { turn: 3 }]);
}

#[test]
fn clarification_never_requested_still_asks_it() {
    // 回归：确认修复没有把「该问的时候不问」也顺手改掉了。这一 turn 的
    // last_plan 是 Clarify，且从没有发生过 clarification.requested /
    // answered，decide 必须照样发出 AskClarification。
    let s = state_mid_turn_with_clarify_plan(0);

    assert_eq!(
        decide(&s),
        vec![Command::AskClarification {
            question: String::new()
        }]
    );
}
