//! M2 终审 BL-10：预算闸门端到端。
//!
//! 「超限自动挂起而非静默烧钱」这条能力此前一次都不可能触发——三个独立
//! 缺陷叠在一起：`run.created` 永远写 `BudgetSpec::default()`（五个字段全
//! `None`，三个维度全部短路 false）、`budget_used.wall_ms` 在 `reduce` 的
//! 任何 arm 里都没有写入方、Gateway 的六步管线里根本没有第⑤步。
//!
//! 这个文件锁的是那条完整链路，尤其是最后一段：**提额之后 run 真的继续
//! 推进**。`evo-kernel/tests/suspend_resume.rs` 里那条同名的旧测试是直接
//! 改 state 字段来「提额」的，它验证的那个状态在 Log 上根本推不出来——
//! 没有任何事件能改 `RunState::budget`，所以真实世界里 `run.resumed` 之后
//! `budget_exhausted` 仍然为真，`decide` 立刻再产出 `Suspend`，run 永远
//! 推不动。这里的提额走的是一条真的 `budget.amended` 事件。

use evo_daemon::{DaemonConfig, FixedClock, RunOutcome, Runtime};
use evo_exec_local::{LocalExecutor, WorkspaceOnlySandbox};
use evo_kernel::{AwaitReason, RunStatus};
use evo_model::FixtureAdapter;
use evo_protocol::budget::BudgetSpec;
use evo_protocol::{Actor, EventBody, RunId};
use evo_runlog::RunLog;
use std::sync::Arc;

/// 三轮：写 report-0.txt、写 report-1.txt、结束。
///
/// 按 `config/pricing.toml`（fixture-v1：输入 1 micro/token、输出 2
/// micros/token）算，前两轮各计 120×1 + 40×2 = 200 micros，第三轮
/// 10×1 + 5×2 = 20 micros。把额度配成 300 micros，账就会在第二轮
/// 模型调用**之后**、那一轮的 `fs.write` 派发**之前**跨过上限：
/// 用量 400 > 300，`decide` 在下一次求值时产出 `Command::Suspend`。
const THREE_TURN_FIXTURES: &str = r#"{
  "provider": "fixture",
  "model": "fixture-v1",
  "responses": [
    { "text": "{\"intent\":\"tool_call\",\"tool\":\"fs.write\",\"params\":{\"path\":\"report-0.txt\",\"content\":\"第一版\"}}",
      "usage": { "input": 120, "output": 40, "cache_read": 0, "cache_write": 0 },
      "stop_reason": "stop", "latency_ms": 12 },
    { "text": "{\"intent\":\"tool_call\",\"tool\":\"fs.write\",\"params\":{\"path\":\"report-1.txt\",\"content\":\"第二版\"}}",
      "usage": { "input": 120, "output": 40, "cache_read": 0, "cache_write": 0 },
      "stop_reason": "stop", "latency_ms": 12 },
    { "text": "{\"intent\":\"finish\"}",
      "usage": { "input": 10, "output": 5, "cache_read": 0, "cache_write": 0 },
      "stop_reason": "stop", "latency_ms": 9 }
  ]
}"#;

fn setup(dir: &std::path::Path, budget: BudgetSpec, fixtures: &str) -> Runtime {
    let mut config = DaemonConfig::for_test(dir);
    config.budget = budget;
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

fn workspace_file(dir: &std::path::Path, run_id: &RunId, name: &str) -> std::path::PathBuf {
    dir.join("workspaces").join(run_id.as_str()).join(name)
}

// ————————————————————————————————————————————————————————————
// 1. 配一个小额度 → 跑到超限 → run 真的挂起 → 提额 → resume →
//    run 真的继续推进。整条链路一次跑完。
// ————————————————————————————————————————————————————————————

#[tokio::test]
async fn a_small_budget_suspends_the_run_and_an_amendment_lets_it_finish() {
    let dir = tempfile::tempdir().unwrap();
    let run_id = RunId::from("r-budget");
    let mut rt = setup(
        dir.path(),
        BudgetSpec {
            max_amount_micros: Some(300),
            ..BudgetSpec::default()
        },
        THREE_TURN_FIXTURES,
    );

    // —— ① 跑到超限，挂起 ——
    let outcome = rt.start(&run_id, "把账龄表做出来").await.unwrap();
    let RunOutcome::Suspended { state, reason } = outcome else {
        panic!("超限必须挂起（而不是跑到 MAX_TURNS、完成、或失败），实得 {outcome:?}");
    };
    assert_eq!(reason, AwaitReason::Budget);
    assert_eq!(state.status, RunStatus::Suspended);
    assert!(
        state.budget_used.amount_micros > 300,
        "闸门要在真的花超之后才跳，实得 {} micros",
        state.budget_used.amount_micros
    );
    assert_eq!(
        state.budget.max_amount_micros,
        Some(300),
        "run.created 必须带上 DaemonConfig 里配的真实额度，而不是全 None 的 BudgetSpec::default()"
    );
    // 第一轮的产物落了盘，第二轮的没有——挂起发生在第二轮的 fs.write 之前。
    assert!(workspace_file(dir.path(), &run_id, "report-0.txt").exists());
    assert!(
        !workspace_file(dir.path(), &run_id, "report-1.txt").exists(),
        "挂起之后不许还把这一轮计划里的写操作派发出去"
    );

    let log = open_log(dir.path());
    let kinds = event_kinds(&log, &run_id);
    assert_eq!(
        kinds.last(),
        Some(&"run.suspended"),
        "Log 末尾应该是 run.suspended：{kinds:?}"
    );
    let turn_at_suspend = state.turn;

    // —— ② 不提额直接 resume：必须再次挂起，不许假装能跑 ——
    let outcome = rt.resume(&run_id).await.unwrap();
    let RunOutcome::Suspended { state, reason } = outcome else {
        panic!("额度没变，resume 必须再次挂在预算上，实得 {outcome:?}");
    };
    assert_eq!(reason, AwaitReason::Budget);
    assert_eq!(state.turn, turn_at_suspend, "没提额就不该有任何进展");

    // —— ③ 提额（一条真的事件，不是改 state 字段）→ resume → 继续推进 ——
    let outcome = rt
        .amend_budget(
            &run_id,
            BudgetSpec {
                max_amount_micros: Some(2_000),
                ..BudgetSpec::default()
            },
            Actor::Human("u-1".to_owned()),
            Some("这条 run 值得跑完"),
        )
        .await
        .unwrap();

    let RunOutcome::Completed(state) = outcome else {
        panic!("提额之后 run 必须真的跑完，实得 {outcome:?}");
    };
    assert_eq!(state.status, RunStatus::Completed);
    assert!(
        state.turn > turn_at_suspend,
        "「继续推进」不是「立刻收工」：turn 必须真的往前走（挂起时 {turn_at_suspend}，现在 {}）",
        state.turn
    );
    assert_eq!(
        state.budget.max_amount_micros,
        Some(2_000),
        "提额必须体现在折叠出来的 state 上——这正是 budget.amended 的作用"
    );
    assert!(
        state.budget_used.amount_micros > 300,
        "提额不抹账：已用量不会因为上限抬高而回退"
    );
    // 被挂起挡下的那次写，在续跑之后真的发生了——这是「继续推进」最硬的证据。
    assert!(
        workspace_file(dir.path(), &run_id, "report-1.txt").exists(),
        "续跑之后那次被挡下的 fs.write 必须真的执行了"
    );

    let log = open_log(dir.path());
    let kinds = event_kinds(&log, &run_id);
    assert!(
        kinds.contains(&"budget.amended"),
        "提额必须在 Log 上留下痕迹，否则这条 run 回放不出来：{kinds:?}"
    );
    assert_eq!(kinds.last(), Some(&"run.completed"), "{kinds:?}");
}

// ————————————————————————————————————————————————————————————
// 2. 提额可回放：把 Log 从头折叠一遍，额度必须是提额之后的那个值。
//    这是旧测试（直接改 state 字段）验证不了的那一半——「状态里有 Log
//    里推不出来的东西」。
// ————————————————————————————————————————————————————————————

#[tokio::test]
async fn the_amended_budget_is_reproducible_from_the_log_alone() {
    let dir = tempfile::tempdir().unwrap();
    let run_id = RunId::from("r-budget-replay");
    let mut rt = setup(
        dir.path(),
        BudgetSpec {
            max_amount_micros: Some(300),
            ..BudgetSpec::default()
        },
        THREE_TURN_FIXTURES,
    );
    rt.start(&run_id, "把账龄表做出来").await.unwrap();
    rt.amend_budget(
        &run_id,
        BudgetSpec {
            max_amount_micros: Some(2_000),
            ..BudgetSpec::default()
        },
        Actor::Human("u-1".to_owned()),
        None,
    )
    .await
    .unwrap();

    let log = open_log(dir.path());
    let events = log.events(&run_id, 0, None).unwrap();
    let folded = evo_kernel::fold(&run_id, &events);
    assert_eq!(
        folded.budget.max_amount_micros,
        Some(2_000),
        "只靠 Log 折叠必须得到提额之后的额度"
    );
    assert_eq!(folded.status, RunStatus::Completed);

    // 事件本身带的就是提额之后的完整 BudgetSpec（整体替换语义）。
    let amended: Vec<_> = events
        .iter()
        .filter_map(|e| match &e.body {
            EventBody::BudgetAmended(b) => Some(b.clone()),
            _ => None,
        })
        .collect();
    assert_eq!(amended.len(), 1);
    assert_eq!(amended[0].budget.max_amount_micros, Some(2_000));
}

// ————————————————————————————————————————————————————————————
// 3. wall_ms 有写入方：时长维度不再是死的。
//
//    `FixedClock` 每调一次 `now_ms()` 推进 1000ms，而 `now_ms()` 只在
//    `Command::SampleEnv` 里被调（写进 `env.sampled.wall_clock_ms`）——
//    所以第 N 次采样的 `wall_ms` 正好是 (N-1)×1000。配 1 秒的额度，
//    第二轮开头那次采样就会把它用满。
// ————————————————————————————————————————————————————————————

#[tokio::test]
async fn the_wall_clock_dimension_actually_suspends_a_run() {
    let dir = tempfile::tempdir().unwrap();
    let run_id = RunId::from("r-wall");
    let mut rt = setup(
        dir.path(),
        BudgetSpec {
            max_wall_seconds: Some(1),
            ..BudgetSpec::default()
        },
        THREE_TURN_FIXTURES,
    );

    let outcome = rt.start(&run_id, "把账龄表做出来").await.unwrap();
    let RunOutcome::Suspended { state, reason } = outcome else {
        panic!("时长超限同样要挂起，实得 {outcome:?}");
    };
    assert_eq!(reason, AwaitReason::Budget);
    assert!(
        state.budget_used.wall_ms >= 1_000,
        "wall_ms 必须真的被写入过——这个字段此前在 reduce 的任何 arm 里都没有写入方，\
         恒为 0，时长维度因此永远短路成 false。实得 {}",
        state.budget_used.wall_ms
    );
    assert_eq!(
        state.clock_start_ms,
        Some(1_756_461_600_000),
        "起点取的是本 run 第一条 env.sampled 的 wall_clock_ms"
    );
}

// ————————————————————————————————————————————————————————————
// 4. 不配预算 = 不设限，不是「设成 0」。回归：别让接通闸门顺手把所有
//    没配预算的 run 一启动就撞上限。
// ————————————————————————————————————————————————————————————

#[tokio::test]
async fn a_run_without_a_budget_is_unlimited_not_zero() {
    let dir = tempfile::tempdir().unwrap();
    let run_id = RunId::from("r-unlimited");
    let mut rt = setup(dir.path(), BudgetSpec::default(), THREE_TURN_FIXTURES);

    let outcome = rt.start(&run_id, "把账龄表做出来").await.unwrap();
    let RunOutcome::Completed(state) = outcome else {
        panic!("没配预算的 run 不该被闸门拦住，实得 {outcome:?}");
    };
    assert_eq!(state.status, RunStatus::Completed);
    assert!(state.budget_used.amount_micros > 0, "账还是要照记");
}

// ————————————————————————————————————————————————————————————
// 5. eval 用例的哈希为什么变了：核对用。
//    `RunState` 多了 `clock_start_ms`，`budget_used.wall_ms` 第一次真的
//    被写入——`state_hash` 是整个 RunState 的序列化哈希，这两处一变，
//    哈希必然跟着变。这条测试把「变的到底是什么」钉住。
// ————————————————————————————————————————————————————————————

#[tokio::test]
async fn a_run_with_no_budget_still_meters_wall_time_and_records_the_clock_origin() {
    let dir = tempfile::tempdir().unwrap();
    let run_id = RunId::from("r-meter");
    let mut rt = setup(dir.path(), BudgetSpec::default(), THREE_TURN_FIXTURES);
    let state = rt
        .start(&run_id, "把账龄表做出来")
        .await
        .unwrap()
        .into_state();

    // 没配预算 ≠ 不记账：计量器照跑，只是没有上限拿它去比。这正是 eval
    // 用例（同样没配预算）的最终状态哈希会变的原因——它的事件序列一条
    // 没变，变的是 RunState 的形状与 wall_ms 这个字段的值。
    assert_eq!(state.clock_start_ms, Some(1_756_461_600_000));
    assert!(state.budget_used.wall_ms > 0, "wall_ms 现在真的会被写入");
    assert_eq!(state.budget, BudgetSpec::default(), "额度仍然是不设限");
}
