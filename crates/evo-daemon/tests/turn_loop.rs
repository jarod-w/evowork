use evo_daemon::{DaemonConfig, FixedClock, Runtime};
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
    let state = rt.run_once(&run_id, "把账龄表做出来").await.unwrap();
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
}

#[tokio::test]
async fn the_side_effect_really_happened() {
    let dir = tempfile::tempdir().unwrap();
    let mut rt = setup(dir.path());
    rt.run_once(&RunId::from("r-1"), "把账龄表做出来")
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
    rt.run_once(&run_id, "客户甲欠款 123456 元").await.unwrap();

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
    let state = rt.run_once(&run_id, "客户甲欠款 123456 元").await.unwrap();

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
    let state = rt.run_once(&run_id, "x").await.unwrap();
    // (120*1 + 40*2) + (200*1 + 10*2) = 200 + 220
    assert_eq!(state.budget_used.amount_micros, 420);
}

#[tokio::test]
async fn two_runs_share_one_database() {
    let dir = tempfile::tempdir().unwrap();
    let mut rt = setup(dir.path());
    rt.run_once(&RunId::from("r-1"), "x").await.unwrap();
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
    let state = rt.run_once(&run_id, "把账龄表做出来").await.unwrap();
    assert_eq!(state.status, RunStatus::Failed);

    let log = RunLog::open(&dir.path().join("runlog.sqlite"), &dir.path().join("blobs")).unwrap();
    let events = log.events(&run_id, 0, None).unwrap();
    let last = events.last().expect("Log 不应为空");
    assert_eq!(last.body.kind(), "run.completed");
    match &last.body {
        EventBody::RunCompleted(rc) => assert_eq!(rc.status, CompletionStatus::Failed),
        other => panic!("Log 末尾应为 run.completed，实得 {}", other.kind()),
    }
}
