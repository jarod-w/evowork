use evo_daemon::{DaemonConfig, FixedClock, RunOutcome, Runtime};
use evo_exec_local::{LocalExecutor, WorkspaceOnlySandbox};
use evo_kernel::RunStatus;
use evo_model::FixtureAdapter;
use evo_protocol::RunId;
use evo_runlog::RunLog;
use std::sync::Arc;

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

fn setup(dir: &std::path::Path) -> Runtime {
    let config = DaemonConfig::for_test(dir);
    Runtime::new(
        config,
        Arc::new(FixedClock::new(1_756_461_600_000)),
        Arc::new(FixtureAdapter::from_json_str(FIXTURES).unwrap()),
        Arc::new(LocalExecutor::new(Arc::new(WorkspaceOnlySandbox::new()))),
    )
    .unwrap()
}

#[tokio::test]
async fn a_full_turn_writes_the_event_sequence_from_doc_03() {
    let dir = tempfile::tempdir().unwrap();
    let mut rt = setup(dir.path());
    let run_id = RunId::from("r-1");
    let outcome = rt.start(&run_id, "把账龄表做出来").await.unwrap();
    let RunOutcome::Completed(state) = outcome else {
        panic!("expected Completed, got {outcome:?}");
    };
    assert_eq!(state.status, RunStatus::Completed);

    let log = RunLog::open(&dir.path().join("runlog.sqlite"), &dir.path().join("blobs")).unwrap();
    let kinds: Vec<&str> = log
        .events(&run_id, 0, None)
        .unwrap()
        .iter()
        .map(|e| e.body.kind())
        .collect();
    assert_eq!(
        kinds,
        vec![
            "run.created",
            "intent.declared",
            "env.sampled",
            "context.assembled",
            "model.requested",
            "model.responded",
            "cost.charged",
            "cost.charged",
            "plan.step",
            "tool.requested",
            "policy.evaluated",
            "impact.estimated",
            "checkpoint",
            "effect.dispatched",
            "tool.result",
            "artifact.emitted",
            "env.sampled",
            "context.assembled",
            "model.requested",
            "model.responded",
            "cost.charged",
            "cost.charged",
            "plan.step",
            "run.completed",
        ]
    );
    assert_eq!(state.artifacts.len(), 1, "{:?}", state.artifacts);
    assert_eq!(state.artifacts[0].path, "report.txt");
}

#[tokio::test]
async fn the_side_effect_really_happened() {
    let dir = tempfile::tempdir().unwrap();
    let mut rt = setup(dir.path());
    rt.start(&RunId::from("r-1"), "把账龄表做出来")
        .await
        .unwrap();
    let written = dir.path().join("workspaces").join("r-1").join("report.txt");
    assert_eq!(std::fs::read_to_string(written).unwrap(), "账龄表");
}

#[tokio::test]
async fn business_content_never_lands_in_the_event_payload() {
    // 01 §3：payload 里只允许元数据与 content_hash
    let dir = tempfile::tempdir().unwrap();
    let mut rt = setup(dir.path());
    let run_id = RunId::from("r-1");
    rt.start(&run_id, "客户甲欠款 123456 元").await.unwrap();

    let log = RunLog::open(&dir.path().join("runlog.sqlite"), &dir.path().join("blobs")).unwrap();
    for e in log.events(&run_id, 0, None).unwrap() {
        let payload = serde_json::to_string(&e.body).unwrap();
        assert!(
            !payload.contains("123456"),
            "业务数字漏进了 {} 的 payload",
            e.body.kind()
        );
        assert!(
            !payload.contains("客户甲"),
            "客户名漏进了 {} 的 payload",
            e.body.kind()
        );
    }
}

#[tokio::test]
async fn the_intent_text_is_retrievable_from_the_blob_store() {
    let dir = tempfile::tempdir().unwrap();
    let mut rt = setup(dir.path());
    let run_id = RunId::from("r-1");
    let state = rt
        .start(&run_id, "客户甲欠款 123456 元")
        .await
        .unwrap()
        .into_state();

    let log = RunLog::open(&dir.path().join("runlog.sqlite"), &dir.path().join("blobs")).unwrap();
    let intent = state.intent.expect("intent 应当在 state 里");
    let text = String::from_utf8(log.blobs().get(&intent).unwrap()).unwrap();
    assert_eq!(text, "客户甲欠款 123456 元", "原文进 blob，不是丢掉");
}

#[tokio::test]
async fn cost_is_charged_from_our_own_price_table() {
    let dir = tempfile::tempdir().unwrap();
    let mut rt = setup(dir.path());
    let run_id = RunId::from("r-1");
    let state = rt.start(&run_id, "x").await.unwrap().into_state();
    // (120*1 + 40*2) + (200*1 + 10*2) = 200 + 220
    assert_eq!(state.budget_used.amount_micros, 420);
}

#[tokio::test]
async fn a_priced_tool_effect_is_charged() {
    let dir = tempfile::tempdir().unwrap();
    let mut config = DaemonConfig::for_test(dir.path());
    config.pricing_toml.push_str(
        r#"

[[tool]]
name = "fs.write"
call_micros = 100
"#,
    );
    let mut rt = Runtime::new(
        config,
        Arc::new(FixedClock::new(1_756_461_600_000)),
        Arc::new(FixtureAdapter::from_json_str(FIXTURES).unwrap()),
        Arc::new(LocalExecutor::new(Arc::new(WorkspaceOnlySandbox::new()))),
    )
    .unwrap();
    let run_id = RunId::from("r-1");
    let state = rt.start(&run_id, "x").await.unwrap().into_state();
    // 模型 420 + fs.write 100
    assert_eq!(state.budget_used.amount_micros, 520);

    let log = RunLog::open(&dir.path().join("runlog.sqlite"), &dir.path().join("blobs")).unwrap();
    let tool_charges: Vec<_> = log
        .events(&run_id, 0, None)
        .unwrap()
        .into_iter()
        .filter_map(|e| match e.body {
            evo_protocol::EventBody::CostCharged(c) if c.effect_id.is_some() => Some(c),
            _ => None,
        })
        .collect();
    assert_eq!(tool_charges.len(), 1, "应恰好一笔工具账");
    assert_eq!(tool_charges[0].amount_micros, 100);
    assert_eq!(tool_charges[0].unit, evo_protocol::CostUnit::Call);
    assert_eq!(
        tool_charges[0].dimension.tool.as_ref().map(|t| t.as_str()),
        Some("fs.write")
    );
}

#[tokio::test]
async fn two_runs_share_one_database() {
    let dir = tempfile::tempdir().unwrap();
    let mut rt = setup(dir.path());
    rt.start(&RunId::from("r-1"), "x").await.unwrap();
    let log = RunLog::open(&dir.path().join("runlog.sqlite"), &dir.path().join("blobs")).unwrap();
    assert_eq!(log.run_ids().unwrap().len(), 1);
}

#[test]
fn plan_parsing_lives_in_the_runtime_not_the_kernel() {
    use evo_daemon::parse_plan;
    use evo_protocol::events::model::PlanIntent;
    let p =
        parse_plan(r#"{"intent":"tool_call","tool":"fs.write","params":{"path":"a"}}"#).unwrap();
    assert_eq!(p.intent, PlanIntent::ToolCall);
    assert_eq!(p.tool.as_deref(), Some("fs.write"));
}

#[test]
fn unparseable_model_output_is_an_error_not_a_guess() {
    use evo_daemon::parse_plan;
    assert!(parse_plan("我觉得应该写个文件").is_err());
}

const TOOL_CALL_WITHOUT_A_TOOL_FIXTURES: &str = r#"{
  "provider": "fixture",
  "model": "fixture-v1",
  "responses": [
    { "text": "{\"intent\":\"tool_call\"}",
      "usage": { "input": 10, "output": 5, "cache_read": 0, "cache_write": 0 },
      "stop_reason": "stop", "latency_ms": 1 }
  ]
}"#;

#[tokio::test]
async fn a_tool_call_without_a_tool_field_fails_the_run_not_completes_it() {
    // decide() 的唯一一个产出 RunStatus::Failed 的分支：模型说要调工具
    // （PlanIntent::ToolCall），但 runtime 解析不出合法的 call。此前 daemon
    // 在 Command::Complete 里无条件写 CompletionStatus::Ok，这个失败在 Log
    // 里被悄悄记成了成功（全分支终审 I1）。
    use evo_protocol::EventBody;
    use evo_protocol::events::lifecycle::CompletionStatus;

    let dir = tempfile::tempdir().unwrap();
    let mut rt = Runtime::new(
        DaemonConfig::for_test(dir.path()),
        Arc::new(FixedClock::new(1_756_461_600_000)),
        Arc::new(FixtureAdapter::from_json_str(TOOL_CALL_WITHOUT_A_TOOL_FIXTURES).unwrap()),
        Arc::new(LocalExecutor::new(Arc::new(WorkspaceOnlySandbox::new()))),
    )
    .unwrap();
    let run_id = RunId::from("r-1");
    let outcome = rt.start(&run_id, "把账龄表做出来").await.unwrap();
    let RunOutcome::Failed { state, error } = outcome else {
        panic!("expected Failed, got {outcome:?}");
    };
    assert_eq!(state.status, RunStatus::Failed);
    assert!(!error.is_empty(), "Failed 变体应该带一句人话的错误信息");

    let log = RunLog::open(&dir.path().join("runlog.sqlite"), &dir.path().join("blobs")).unwrap();
    let events = log.events(&run_id, 0, None).unwrap();
    let last = events.last().expect("Log 不应为空");
    assert_eq!(last.body.kind(), "run.completed");
    match &last.body {
        EventBody::RunCompleted(rc) => assert_eq!(rc.status, CompletionStatus::Failed),
        other => panic!("Log 末尾应为 run.completed，实得 {}", other.kind()),
    }
}

// ————————————————————————————————————————————————————————————
// M2 终审 BL-8：非 Gateway-Deny 的故障也必须落成 run.failed。
//
// `evo-protocol` 里 RunFailed 的文档原话：「真正的故障（IO 失败、模型解析
// 不出来、预算表查不到……）落到这里成为一条 Log 事件，而不是掀翻调用栈、
// 把 run 晾在没有终结事件的状态里」。此前全仓唯一写 RunFailed 的地方是
// Gateway 的 Deny 分支，下面这几条路径都是直接 `Err` 冒泡：Log 最后一条
// 是 cost.charged，status 折叠出来还是 Running，这条 run 的结局只存在于
// 调用方的错误字符串里，不在唯一权威事实里。
// ————————————————————————————————————————————————————————————

/// 模型返回散文，不是 JSON 计划——最真实的一种故障。
const PROSE_FIXTURES: &str = r#"{
  "provider": "fixture",
  "model": "fixture-v1",
  "responses": [
    { "text": "我觉得可以先把账龄表拉出来看看，你说呢？",
      "usage": { "input": 120, "output": 40, "cache_read": 0, "cache_write": 0 },
      "stop_reason": "stop", "latency_ms": 12 }
  ]
}"#;

/// 定价表里没有这个 provider/model。
const UNPRICED_FIXTURES: &str = r#"{
  "provider": "no-such-provider",
  "model": "no-such-model",
  "responses": [
    { "text": "{\"intent\":\"finish\"}",
      "usage": { "input": 10, "output": 5, "cache_read": 0, "cache_write": 0 },
      "stop_reason": "stop", "latency_ms": 1 }
  ]
}"#;

fn setup_with_fixtures(dir: &std::path::Path, fixtures: &str) -> Runtime {
    Runtime::new(
        DaemonConfig::for_test(dir),
        Arc::new(FixedClock::new(1_756_461_600_000)),
        Arc::new(FixtureAdapter::from_json_str(fixtures).unwrap()),
        Arc::new(LocalExecutor::new(Arc::new(WorkspaceOnlySandbox::new()))),
    )
    .unwrap()
}

fn kinds_of(dir: &std::path::Path, run_id: &RunId) -> Vec<&'static str> {
    let log = RunLog::open(&dir.join("runlog.sqlite"), &dir.join("blobs")).unwrap();
    log.events(run_id, 0, None)
        .unwrap()
        .iter()
        .map(|e| e.body.kind())
        .collect()
}

#[tokio::test]
async fn a_model_answering_in_prose_ends_the_run_in_the_log_not_only_in_an_error_string() {
    let dir = tempfile::tempdir().unwrap();
    let mut rt = setup_with_fixtures(dir.path(), PROSE_FIXTURES);
    let run_id = RunId::from("r-1");

    let outcome = rt
        .start(&run_id, "把账龄表做出来")
        .await
        .expect("真正的故障也要落成一条 Log 事件，不该掀翻调用栈");
    let RunOutcome::Failed { state, error } = outcome else {
        panic!("expected Failed, got {outcome:?}");
    };
    assert_eq!(state.status, RunStatus::Failed);
    assert!(!error.is_empty());

    let kinds = kinds_of(dir.path(), &run_id);
    assert_eq!(
        kinds.last(),
        Some(&"run.failed"),
        "解析不出计划的 run 必须以 run.failed 收尾，而不是停在 cost.charged：{kinds:?}"
    );
}

#[tokio::test]
async fn an_unpriced_model_ends_the_run_in_the_log_not_only_in_an_error_string() {
    let dir = tempfile::tempdir().unwrap();
    let mut rt = setup_with_fixtures(dir.path(), UNPRICED_FIXTURES);
    let run_id = RunId::from("r-1");

    let outcome = rt
        .start(&run_id, "把账龄表做出来")
        .await
        .expect("查不到定价同样是故障，不是 panic 式的短路");
    let RunOutcome::Failed { state, .. } = outcome else {
        panic!("expected Failed, got {outcome:?}");
    };
    assert_eq!(state.status, RunStatus::Failed);

    let kinds = kinds_of(dir.path(), &run_id);
    assert_eq!(
        kinds.last(),
        Some(&"run.failed"),
        "未定价的模型必须让 run 以 run.failed 收尾：{kinds:?}"
    );
}

#[tokio::test]
async fn hitting_the_turn_limit_ends_the_run_in_the_log_not_only_in_an_error_string() {
    // 每一 turn 都调一次 fs.write，永远不 finish——撞上 MAX_TURNS 那道保险。
    let one = r#"{ "text": "{\"intent\":\"tool_call\",\"tool\":\"fs.write\",\"params\":{\"path\":\"report.txt\",\"content\":\"x\"}}",
      "usage": { "input": 1, "output": 1, "cache_read": 0, "cache_write": 0 },
      "stop_reason": "stop", "latency_ms": 1 }"#;
    let fixtures = format!(
        r#"{{ "provider": "fixture", "model": "fixture-v1", "responses": [{}] }}"#,
        vec![one; 70].join(",")
    );

    let dir = tempfile::tempdir().unwrap();
    let mut rt = setup_with_fixtures(dir.path(), &fixtures);
    let run_id = RunId::from("r-1");

    let outcome = rt
        .start(&run_id, "把账龄表做出来")
        .await
        .expect("撞上 turn 上限也要落成一条 Log 事件");
    let RunOutcome::Failed { state, .. } = outcome else {
        panic!("expected Failed, got {outcome:?}");
    };
    assert_eq!(state.status, RunStatus::Failed);

    let kinds = kinds_of(dir.path(), &run_id);
    assert_eq!(
        kinds.last(),
        Some(&"run.failed"),
        "撞上 turn 上限的 run 必须有终结事件：{kinds:?}"
    );
}
