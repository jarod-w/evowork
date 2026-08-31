//! M2 Task 3：挂起是事件，不是 `Err`。
//!
//! 覆盖计划里 Task 3 的八条：拒绝/审批/澄清都要走事件而不是 `Err`，
//! `start`/`resume` 共用一个驱动循环，恢复真的走 Log 而不是内存残留状态，
//! 意图从 blob 取而不是从参数取。

use evo_daemon::{DaemonConfig, FixedClock, RunOutcome, Runtime};
use evo_exec_local::{LocalExecutor, WorkspaceOnlySandbox};
use evo_kernel::{AwaitReason, RunStatus};
use evo_model::FixtureAdapter;
use evo_protocol::{Actor, RunId};
use evo_runlog::RunLog;
use std::sync::Arc;

/// 两轮对话：第一轮调 `fs.write`，第二轮结束。与 `tests/turn_loop.rs`
/// 用的是同一份 fixture——审批/拒绝场景改变的是策略，不是模型。
const FIXTURES: &str = r#"{
  "provider": "fixture",
  "model": "fixture-v1",
  "responses": [
    { "text": "{\"intent\":\"tool_call\",\"tool\":\"fs.write\",\"params\":{\"path\":\"report.txt\",\"content\":\"账龄表\"}}",
      "usage": { "input": 120, "output": 40, "cache_read": 0, "cache_write": 0 },
      "stop_reason": "stop", "latency_ms": 12 },
    { "text": "{\"intent\":\"finish\"}",
      "usage": { "input": 200, "output": 10, "cache_read": 0, "cache_write": 0 },
      "stop_reason": "stop", "latency_ms": 9 }
  ]
}"#;

/// 单轮：直接结束。`FixtureAdapter` 的响应游标是**按实例**计数的——一个
/// 全新的 `Runtime`（因而是全新的 `FixtureAdapter`）第一次调模型时永远
/// 从下标 0 开始，不知道另一个实例已经替它把第 0 轮的响应用掉了。
/// 用在「丢弃 Runtime、换一个全新实例继续跑」的测试里：新实例自己只会
/// 调一次模型（跑的是第二个 turn），这份 fixture 就是给那一次调用用的。
const FINISH_ONLY_FIXTURES: &str = r#"{
  "provider": "fixture",
  "model": "fixture-v1",
  "responses": [
    { "text": "{\"intent\":\"finish\"}",
      "usage": { "input": 200, "output": 10, "cache_read": 0, "cache_write": 0 },
      "stop_reason": "stop", "latency_ms": 9 }
  ]
}"#;

/// 第一轮：模型直接说要澄清，不涉及任何工具/effect。第二轮（内核修复
/// 澄清死循环之后才会真的被消费到——`clarification.answered` 现在会把
/// `context_turn`/`plan_turn` 一并回退，`decide` 因而会重新
/// `AssembleContext` → `CallModel`）：模型说结束，让「回答之后能驱动到
/// 底」的测试有地方落地，而不是撞上 `FixtureExhausted`。
/// 只调一次模型的测试（比如 `bare_resume_recomputes_from_the_log_not_from_memory`
/// 里那两个全新的 `Runtime` 实例）永远只会用到下标 0，不受第二条响应影响。
const CLARIFY_FIXTURES: &str = r#"{
  "provider": "fixture",
  "model": "fixture-v1",
  "responses": [
    { "text": "{\"intent\":\"clarify\",\"question\":\"是否催收？\",\"options\":[{\"id\":\"opt-yes\",\"label\":\"是\",\"is_default\":true},{\"id\":\"opt-no\",\"label\":\"否\",\"is_default\":false}]}",
      "usage": { "input": 10, "output": 5, "cache_read": 0, "cache_write": 0 },
      "stop_reason": "stop", "latency_ms": 1 },
    { "text": "{\"intent\":\"finish\"}",
      "usage": { "input": 15, "output": 5, "cache_read": 0, "cache_write": 0 },
      "stop_reason": "stop", "latency_ms": 1 }
  ]
}"#;

/// 任何 `fs.write` 一律拒绝——用来构造「被 Gateway 拒掉」的场景。
const DENY_WRITE_POLICY: &str = r#"
version = "poc-1"

[[rule]]
id = "deny-all-writes"
class = "write"
decision = "deny"
reason_code = "writes_forbidden_in_this_test"
"#;

/// 任何 `fs.write` 一律需要审批——用来构造「挂起等人批」的场景。
const REQUIRE_APPROVAL_FOR_WRITES_POLICY: &str = r#"
version = "poc-1"

[[rule]]
id = "approve-all-writes"
class = "write"
decision = "require_approval"
risk = "l2"
"#;

fn setup_with_policy(dir: &std::path::Path, policy_toml: &str, fixtures: &str) -> Runtime {
    let mut config = DaemonConfig::for_test(dir);
    config.policy_toml = policy_toml.to_owned();
    Runtime::new(
        config,
        Arc::new(FixedClock::new(1_756_461_600_000)),
        Arc::new(FixtureAdapter::from_json_str(fixtures).unwrap()),
        Arc::new(LocalExecutor::new(Arc::new(WorkspaceOnlySandbox::new()))),
    )
    .unwrap()
}

fn open_log(dir: &std::path::Path) -> RunLog {
    RunLog::open(&dir.join("runlog.sqlite"), &dir.join("blobs")).unwrap()
}

fn event_kinds(log: &RunLog, run_id: &RunId) -> Vec<&'static str> {
    log.events(run_id, 0, None)
        .unwrap()
        .iter()
        .map(|e| e.body.kind())
        .collect()
}

// ————————————————————————————————————————————————————————————
// 1. 被拒的 run 有终结事件：run.failed，不是停在某个中间事件上，
//    而且留了一个 checkpoint，所以 verify 不报 VACUOUS。
// ————————————————————————————————————————————————————————————

#[tokio::test]
async fn a_denied_effect_ends_the_run_with_a_checkpoint_not_a_vacuous_one() {
    let dir = tempfile::tempdir().unwrap();
    let mut rt = setup_with_policy(dir.path(), DENY_WRITE_POLICY, FIXTURES);
    let run_id = RunId::from("r-1");

    let outcome = rt.start(&run_id, "把账龄表做出来").await.unwrap();
    let RunOutcome::Failed { state, error } = outcome else {
        panic!("expected Failed, got {outcome:?}");
    };
    assert_eq!(state.status, RunStatus::Failed);
    assert!(!error.is_empty(), "Failed 变体应该带一句能看懂的错误信息");

    let log = open_log(dir.path());
    let kinds = event_kinds(&log, &run_id);
    assert_eq!(
        kinds.last(),
        Some(&"run.failed"),
        "Log 末尾应该是 run.failed，而不是停在 impact.estimated / policy.evaluated 之类的中间事件上：{kinds:?}"
    );
    assert!(
        kinds.contains(&"checkpoint"),
        "被拒之前必须先有一个 checkpoint，否则 verify 只能报 VACUOUS：{kinds:?}"
    );

    let report = evo_daemon::verify(&log, &run_id).unwrap();
    assert!(
        !report.is_vacuous(),
        "被拒的 run 应该既能关掉也能验，不该是 VACUOUS"
    );
    assert!(report.is_ok(), "不一致的检查点：{:?}", report.mismatches);
}

// ————————————————————————————————————————————————————————————
// 2. 审批挂起是干净的：start 返回 Suspended，Log 里有
//    approval.requested + run.suspended，status 是 Suspended，
//    整条链路没有任何 Err。
// ————————————————————————————————————————————————————————————

#[tokio::test]
async fn awaiting_approval_suspends_cleanly_with_no_err() {
    let dir = tempfile::tempdir().unwrap();
    let mut rt = setup_with_policy(dir.path(), REQUIRE_APPROVAL_FOR_WRITES_POLICY, FIXTURES);
    let run_id = RunId::from("r-1");

    let outcome = rt
        .start(&run_id, "把账龄表做出来")
        .await
        .expect("挂起路径上不该有任何 Err");
    let RunOutcome::Suspended { state, reason } = outcome else {
        panic!("expected Suspended, got {outcome:?}");
    };
    assert_eq!(state.status, RunStatus::Suspended);
    assert!(
        matches!(reason, AwaitReason::Approval { .. }),
        "挂起原因应该是 Approval，实得 {reason:?}"
    );

    let log = open_log(dir.path());
    let kinds = event_kinds(&log, &run_id);
    assert!(kinds.contains(&"approval.requested"));
    assert_eq!(kinds.last(), Some(&"run.suspended"));
}

/// 走一遍「start -> 挂起在审批」，把 approval_id 交给调用方继续。
async fn start_and_suspend_on_approval(
    dir: &std::path::Path,
) -> (Runtime, RunId, evo_protocol::ApprovalId) {
    let mut rt = setup_with_policy(dir, REQUIRE_APPROVAL_FOR_WRITES_POLICY, FIXTURES);
    let run_id = RunId::from("r-1");
    let outcome = rt.start(&run_id, "把账龄表做出来").await.unwrap();
    let RunOutcome::Suspended { reason, .. } = outcome else {
        panic!("expected Suspended, got {outcome:?}");
    };
    let AwaitReason::Approval { approval_id, .. } = reason else {
        panic!("expected AwaitReason::Approval, got {reason:?}");
    };
    (rt, run_id, approval_id)
}

// ————————————————————————————————————————————————————————————
// 3. 批准后续跑：approval.granted + run.resumed 落地，run 继续跑到
//    run.completed，那个 effect 真的被执行了（不只是状态变了）。
// ————————————————————————————————————————————————————————————

#[tokio::test]
async fn granting_approval_lets_the_run_continue_and_the_effect_really_runs() {
    let dir = tempfile::tempdir().unwrap();
    let (mut rt, run_id, approval_id) = start_and_suspend_on_approval(dir.path()).await;

    let outcome = rt
        .decide_approval(
            &run_id,
            &approval_id,
            true,
            Actor::Human("u-1".into()),
            None,
        )
        .await
        .expect("批准之后驱动到底不该有 Err");
    let RunOutcome::Completed(state) = outcome else {
        panic!("expected Completed, got {outcome:?}");
    };
    assert_eq!(state.status, RunStatus::Completed);

    let written = dir.path().join("workspaces").join("r-1").join("report.txt");
    assert_eq!(
        std::fs::read_to_string(written).unwrap(),
        "账龄表",
        "effect 应该真的执行了，不是只把状态改成 Completed"
    );

    let log = open_log(dir.path());
    let kinds = event_kinds(&log, &run_id);
    assert!(kinds.contains(&"approval.granted"));
    assert!(kinds.contains(&"run.resumed"));
    assert!(kinds.contains(&"effect.dispatched"));
    assert!(kinds.contains(&"tool.result"));
    assert_eq!(kinds.last(), Some(&"run.completed"));
}

// ————————————————————————————————————————————————————————————
// 4. 驳回后不执行：effect 真的没有被执行（工作区里没有那个文件），
//    run 仍然有终结事件，不会永远挂着。
// ————————————————————————————————————————————————————————————

#[tokio::test]
async fn denying_approval_never_executes_the_effect() {
    let dir = tempfile::tempdir().unwrap();
    let (mut rt, run_id, approval_id) = start_and_suspend_on_approval(dir.path()).await;

    let outcome = rt
        .decide_approval(
            &run_id,
            &approval_id,
            false,
            Actor::Human("u-1".into()),
            Some("金额太大，先别写"),
        )
        .await
        .expect("驳回之后驱动到底不该有 Err");

    let written = dir.path().join("workspaces").join("r-1").join("report.txt");
    assert!(!written.exists(), "effect 被拒之后不该真的执行");

    let log = open_log(dir.path());
    let kinds = event_kinds(&log, &run_id);
    assert!(kinds.contains(&"approval.denied"));
    assert!(kinds.contains(&"run.resumed"));
    assert!(
        !kinds.contains(&"effect.dispatched") && !kinds.contains(&"tool.result"),
        "被拒的 effect 不该出现派发/结算事件：{kinds:?}"
    );

    // 被拒也是一种终态（跟 Settled 一样把 turn 往前推，见 evo-kernel），
    // run 应该正常继续跑完，而不是悬在半空。
    let state = outcome.into_state();
    assert_eq!(state.status, RunStatus::Completed);
    assert_eq!(kinds.last(), Some(&"run.completed"));
}

// ————————————————————————————————————————————————————————————
// 5+6. resume 从 Log 恢复：丢弃 start() 用过的 Runtime、用一个全新的
//      实例把 run 继续跑完；恢复之后新开的那个 turn 里
//      context.assembled 用的意图，与原始 intent_text 一致——证明意图
//      是从 state.intent 指向的 blob 取的，不是靠内存里的参数残留。
// ————————————————————————————————————————————————————————————

#[tokio::test]
async fn a_brand_new_runtime_resumes_a_suspended_run_purely_from_the_log() {
    let dir = tempfile::tempdir().unwrap();
    let run_id = RunId::from("r-1");
    let intent_text = "把账龄表做出来";

    let approval_id = {
        let mut rt1 = setup_with_policy(dir.path(), REQUIRE_APPROVAL_FOR_WRITES_POLICY, FIXTURES);
        let outcome = rt1.start(&run_id, intent_text).await.unwrap();
        let RunOutcome::Suspended { reason, .. } = outcome else {
            panic!("expected Suspended, got {outcome:?}");
        };
        let AwaitReason::Approval { approval_id, .. } = reason else {
            panic!("expected AwaitReason::Approval, got {reason:?}");
        };
        approval_id
        // rt1 在这里被丢弃——它的所有内存状态都不再存在。
    };

    // 全新的 Runtime：同一份 Log/blob 路径，但内存里对 rt1 一无所知。
    // 它自己只会调一次模型（跑第二个 turn），所以给它一份只有「结束」
    // 这一条的 fixture——见 FINISH_ONLY_FIXTURES 上的注释。
    let mut rt2 = setup_with_policy(
        dir.path(),
        REQUIRE_APPROVAL_FOR_WRITES_POLICY,
        FINISH_ONLY_FIXTURES,
    );
    let outcome = rt2
        .decide_approval(
            &run_id,
            &approval_id,
            true,
            Actor::Human("u-1".into()),
            None,
        )
        .await
        .expect("在一个从没见过这条 run 的 Runtime 上恢复，不该有 Err");
    let RunOutcome::Completed(state) = outcome else {
        panic!("expected Completed, got {outcome:?}");
    };
    assert_eq!(state.status, RunStatus::Completed);

    let written = dir.path().join("workspaces").join("r-1").join("report.txt");
    assert_eq!(
        std::fs::read_to_string(written).unwrap(),
        "账龄表",
        "effect 应该真的被全新的 Runtime 派发执行了"
    );

    // 意图从 blob 取，不从参数取：state.intent 指向的 blob 内容必须与
    // start() 时给的原文一致——rt2 从未被传过 intent_text。
    let log = open_log(dir.path());
    let intent_ref = state.intent.clone().expect("state.intent 应该有值");
    let text = String::from_utf8(log.blobs().get(&intent_ref).unwrap()).unwrap();
    assert_eq!(text, intent_text);

    // 恢复之后应该真的推进了一个新 turn：第二个 context.assembled。
    let kinds = event_kinds(&log, &run_id);
    assert_eq!(
        kinds.iter().filter(|k| **k == "context.assembled").count(),
        2,
        "恢复之后应该有第二个 turn 的 context.assembled：{kinds:?}"
    );
}

/// 更直接地证明 `resume()` 本身（不经过 `decide_approval`）是从 Log
/// 折叠出 state，不是从内存：起一条会挂在「等澄清」上的 run，丢弃
/// Runtime，用一个全新的实例只调 `resume(run_id)`。
///
/// 这里没有人调用过 `answer_clarification`——只是丢弃 Runtime、换一个
/// 全新实例裸调 `resume()`。`evo_kernel::reduce` 里 `clarification.
/// answered` 的死循环修复（把 `context_turn`/`plan_turn` 一并回退）只
/// 挂在那条事件上；这里从未发生过 `clarification.answered`，`plan_turn`
/// 仍然停在原地、`last_plan`（intent 仍是 Clarify）也还是那份没被回答过
/// 的规划，所以裸调 `resume()`（`Runtime::resume` 无条件先落一条
/// `run.resumed`）之后，`decide()` 在同一个 turn 里会立刻对着同一份
/// `last_plan` 再问一次——这条行为在澄清死循环修复前后都成立，不是那个
/// bug 的一部分：这里验证的是「全新的 Runtime 确实从 Log 重新算出了
/// 第二次追问」，而不是从内存里保留着什么残留状态。
#[tokio::test]
async fn bare_resume_recomputes_from_the_log_not_from_memory() {
    let dir = tempfile::tempdir().unwrap();
    let run_id = RunId::from("r-1");

    {
        let mut rt1 = setup_with_policy(dir.path(), DENY_WRITE_POLICY, CLARIFY_FIXTURES);
        let outcome = rt1.start(&run_id, "这个客户还要不要催收？").await.unwrap();
        assert!(matches!(outcome, RunOutcome::Suspended { .. }));
        // rt1 在这里被丢弃。
    }

    let mut rt2 = setup_with_policy(dir.path(), DENY_WRITE_POLICY, CLARIFY_FIXTURES);
    let outcome = rt2.resume(&run_id).await.expect("裸调 resume() 不该有 Err");
    let RunOutcome::Suspended { state, reason } = outcome else {
        panic!("expected Suspended, got {outcome:?}");
    };
    assert_eq!(state.status, RunStatus::Suspended);
    assert!(
        matches!(reason, AwaitReason::Clarification { .. }),
        "挂起原因应该仍是 Clarification，实得 {reason:?}"
    );

    let log = open_log(dir.path());
    let kinds = event_kinds(&log, &run_id);
    assert_eq!(
        kinds
            .iter()
            .filter(|k| **k == "clarification.requested")
            .count(),
        2,
        "全新的 Runtime 应该真的重新算出了第二次追问：{kinds:?}"
    );
    assert!(kinds.contains(&"run.resumed"));
}

// ————————————————————————————————————————————————————————————
// 7. 澄清挂起与回答：同构的一条链——干净挂起、回答干净落盘，
//    全程没有任何 Err。
// ————————————————————————————————————————————————————————————

#[tokio::test]
async fn clarification_suspends_cleanly_and_answering_it_produces_no_err() {
    let dir = tempfile::tempdir().unwrap();
    let mut rt = setup_with_policy(dir.path(), DENY_WRITE_POLICY, CLARIFY_FIXTURES);
    let run_id = RunId::from("r-1");

    let outcome = rt
        .start(&run_id, "这笔逾期要不要发起催收？")
        .await
        .expect("挂起路径上不该有任何 Err");
    let RunOutcome::Suspended { state, reason } = outcome else {
        panic!("expected Suspended, got {outcome:?}");
    };
    assert_eq!(state.status, RunStatus::Suspended);
    let AwaitReason::Clarification { question_id } = reason else {
        panic!("expected AwaitReason::Clarification, got {reason:?}");
    };

    let log = open_log(dir.path());
    let kinds = event_kinds(&log, &run_id);
    assert!(kinds.contains(&"clarification.requested"));
    assert_eq!(kinds.last(), Some(&"run.suspended"));

    let outcome = rt
        .answer_clarification(
            &run_id,
            &question_id,
            Some("opt-yes"),
            None,
            Actor::Human("u-1".into()),
        )
        .await
        .expect("回答澄清、驱动到底，全程不该有 Err");

    // 内核那边的死循环已经修了（`clarification.answered` 现在会把
    // `context_turn`/`plan_turn` 一并回退），所以回答之后 `decide` 不会
    // 再对着同一份 `last_plan` 重发一次 `AskClarification`，而是重新
    // `AssembleContext` → `CallModel`——第二轮 fixture 响应说 finish，
    // run 应该干净地跑完，而不是又挂在一条新的追问上。
    let RunOutcome::Completed(state) = outcome else {
        panic!("expected Completed, got {outcome:?}");
    };
    assert_eq!(state.status, RunStatus::Completed);

    let log = open_log(dir.path());
    let kinds = event_kinds(&log, &run_id);
    assert!(kinds.contains(&"clarification.answered"));
    assert!(kinds.contains(&"run.resumed"));
    assert_eq!(
        kinds
            .iter()
            .filter(|k| **k == "clarification.requested")
            .count(),
        1,
        "回答一次就该翻篇，不该再收到第二条追问：{kinds:?}"
    );
    assert_eq!(kinds.last(), Some(&"run.completed"));
}

// ————————————————————————————————————————————————————————————
// 8. start 与 resume 共用一个驱动循环——见 crates/evo-daemon/src/runtime.rs
//    里的私有方法 `Runtime::drive`：`start`/`resume`（以及经它转发的
//    `decide_approval`/`answer_clarification`）都以它收尾，仓库里只有
//    这一份 turn 循环的实现。这条不易在测试里直接断言，改在报告里说明。
// ————————————————————————————————————————————————————————————

// ————————————————————————————————————————————————————————————
// 9. 被 Gateway 拒掉的 effect，之后任何一次 resume 都不许把它派发出去
//    （M2 终审 BL-1，红线 1「未经放行的 effect 不会发生」的破口）。
//
//    Deny 分支此前只写 checkpoint + run.failed，从不把 effect 推到终态，
//    于是它一直停在 `tool.requested` 记下的 `EffectState::Requested`；
//    `resume()` 的反向推断「Requested 且不在 pending_approvals 里 ⇒
//    已批准待派发」对它成立，一次 resume 就把一个被明确拒绝的写操作
//    真的执行了。
// ————————————————————————————————————————————————————————————

#[tokio::test]
async fn a_gateway_denied_effect_is_never_dispatched_by_a_later_resume() {
    let dir = tempfile::tempdir().unwrap();
    let mut rt = setup_with_policy(dir.path(), DENY_WRITE_POLICY, FIXTURES);
    let run_id = RunId::from("r-1");

    let outcome = rt.start(&run_id, "把账龄表做出来").await.unwrap();
    assert!(
        matches!(outcome, RunOutcome::Failed { .. }),
        "被拒的 run 应该以 Failed 收场，实得 {outcome:?}"
    );
    let written = dir.path().join("workspaces").join("r-1").join("report.txt");
    assert!(!written.exists(), "被拒的 effect 在 start 阶段就不该执行");

    // 有人（UI、CLI、崩溃重启后的恢复流程）再调一次 resume。
    rt.resume(&run_id).await.expect("resume 不该有 Err");

    assert!(
        !written.exists(),
        "被 Gateway 拒绝的 effect 被一次 resume 真的执行了——红线 1 被击穿"
    );
    let log = open_log(dir.path());
    let kinds = event_kinds(&log, &run_id);
    assert!(
        !kinds.contains(&"effect.dispatched"),
        "被拒的 effect 不该有任何派发事件：{kinds:?}"
    );
}

// ————————————————————————————————————————————————————————————
// 10. 对一条「挂起等审批、人还没批」的 run 调 resume()，调用方不能被
//     告知「完成」（M2 终审 BL-7）。
//
//     此前：resume() 无条件先落 run.resumed（awaiting 被清空、status 变回
//     Running），decide() 因为那个 effect 还停在非终态返回空命令，循环随即
//     break，落到 drive() 的 RunStatus::Running 分支——debug 构建在那儿
//     panic，release 构建返回 RunOutcome::Completed，而 Log 最后一条是
//     run.resumed：一条没有任何终结事件的 run 被报成了完成。
// ————————————————————————————————————————————————————————————

#[tokio::test]
async fn resuming_a_run_whose_approval_is_still_pending_stays_suspended() {
    let dir = tempfile::tempdir().unwrap();
    let (mut rt, run_id, _approval_id) = start_and_suspend_on_approval(dir.path()).await;

    // 没有人批过——直接 resume。
    let outcome = rt.resume(&run_id).await.expect("resume 不该有 Err");
    let RunOutcome::Suspended { state, reason } = outcome else {
        panic!("审批未决时 resume 必须仍然是 Suspended，实得 {outcome:?}");
    };
    assert_eq!(state.status, RunStatus::Suspended);
    assert!(
        matches!(reason, AwaitReason::Approval { .. }),
        "挂起原因应该仍是 Approval，实得 {reason:?}"
    );

    let log = open_log(dir.path());
    let kinds = event_kinds(&log, &run_id);
    assert!(
        !kinds.contains(&"run.completed"),
        "没批过的 run 不该出现任何完成事件：{kinds:?}"
    );
    assert_eq!(
        kinds.last(),
        Some(&"run.suspended"),
        "Log 最后一条应该仍是那条 run.suspended——一次推不动任何事情的恢复\
         不该在 Log 里留下一条悬空的 run.resumed：{kinds:?}"
    );
}

// ————————————————————————————————————————————————————————————
// 11. 同一条红线的另一半（BL-7 的兜底 + BL-1 点名的第二条路径）：
//     `tool.requested` 落盘后、`approval.requested` 落盘前进程被杀，
//     留下一个谁也没批过、谁也不会去推的 effect。
//
//     * 它绝不能在下一次 resume 时被派发（正向判定挡住了它）；
//     * 这条真的推不动的 run 必须以 run.failed 收场，而不是被报成完成。
// ————————————————————————————————————————————————————————————

#[tokio::test]
async fn a_run_stuck_on_an_effect_nobody_will_dispatch_fails_instead_of_completing() {
    let dir = tempfile::tempdir().unwrap();
    let run_id = RunId::from("r-1");
    let effect_id = evo_protocol::EffectId::from("r-1-e1");
    evo_daemon::write_run_created_then_orphan_tool_requested(
        &dir.path().join("runlog.sqlite"),
        &dir.path().join("blobs"),
        &run_id,
        &effect_id,
        "2026-08-30T00:00:00Z",
    )
    .unwrap();

    let mut rt = setup_with_policy(dir.path(), REQUIRE_APPROVAL_FOR_WRITES_POLICY, FIXTURES);
    let outcome = rt.resume(&run_id).await.expect("resume 不该有 Err");

    // 先查最要紧的那条：那个 effect 有没有被真的派发出去。
    let log = open_log(dir.path());
    let kinds = event_kinds(&log, &run_id);
    assert!(
        !kinds.contains(&"effect.dispatched"),
        "谁也没批过的 effect 不该被 resume 派发：{kinds:?}"
    );
    assert_eq!(
        kinds.last(),
        Some(&"run.failed"),
        "Log 必须有终结事件收尾：{kinds:?}"
    );

    let RunOutcome::Failed { state, error } = outcome else {
        panic!("一条推不动的 run 必须报 Failed，实得 {outcome:?}");
    };
    assert_eq!(state.status, RunStatus::Failed);
    assert!(!error.is_empty());
}

#[tokio::test]
async fn granting_the_lexically_last_of_two_pending_approvals_does_not_resume() {
    // 旧代码只拦 `awaiting` 里那一个代表（字典序最大）。批了代表、另一条
    // 还在台账里时，照样写出 `run.resumed`。
    let dir = tempfile::tempdir().unwrap();
    let run_id = RunId::from("r-1");
    let config_probe = DaemonConfig::for_test(dir.path());
    let (_first, last) = evo_daemon::write_run_suspended_with_two_pending_approvals(
        &config_probe.db_path,
        &config_probe.blob_root,
        &run_id,
        "2026-08-31T00:00:00Z",
    )
    .unwrap();

    let mut rt = setup_with_policy(dir.path(), REQUIRE_APPROVAL_FOR_WRITES_POLICY, FIXTURES);
    let outcome = rt
        .decide_approval(&run_id, &last, true, Actor::Human("u-1".into()), None)
        .await
        .expect("批一条未决审批不该有 Err");
    let RunOutcome::Suspended { state, .. } = outcome else {
        panic!("另一条还没批完，应仍是 Suspended，实得 {outcome:?}");
    };
    assert_eq!(state.pending_approvals.len(), 1);
    assert!(
        state
            .pending_approvals
            .contains_key(&evo_protocol::ApprovalId::from("r-1-a10"))
    );

    let log = open_log(dir.path());
    let kinds = event_kinds(&log, &run_id);
    assert!(kinds.contains(&"approval.granted"));
    assert!(
        !kinds.contains(&"run.resumed"),
        "剩下一条未决时不许写 run.resumed：{kinds:?}"
    );
}
