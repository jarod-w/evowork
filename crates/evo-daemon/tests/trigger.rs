use evo_daemon::{AppState, DaemonConfig, FrozenClock, Runtime};
use evo_exec_local::{LocalExecutor, WorkspaceOnlySandbox};
use evo_model::FixtureAdapter;
use evo_protocol::EventBody;
use evo_protocol::events::lifecycle::TriggerKind;
use evo_protocol::rpc::{RpcRequest, RpcResponse, RunEventsResult, TriggerView};
use std::sync::Arc;
use tokio::net::TcpListener;

const FINISH_FIXTURES: &str = r#"{
  "provider": "fixture",
  "model": "fixture-v1",
  "responses": [
    {
      "text": "{\"intent\":\"finish\"}",
      "usage": { "input": 8, "output": 4, "cache_read": 0, "cache_write": 0 },
      "stop_reason": "stop",
      "latency_ms": 1
    }
  ]
}"#;

const TOKEN: &str = "test-token";

async fn spawn(clock: Arc<FrozenClock>) -> (String, AppState, tempfile::TempDir) {
    let dir = tempfile::tempdir().unwrap();
    let config = DaemonConfig::for_test(dir.path());
    let runtime = Runtime::new(
        config,
        clock,
        Arc::new(FixtureAdapter::from_json_str(FINISH_FIXTURES).unwrap()),
        Arc::new(LocalExecutor::new(Arc::new(WorkspaceOnlySandbox::new()))),
    )
    .unwrap();
    let state = AppState::new(runtime, TOKEN, "0.1.0-test").unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let serve_state = state.clone();
    tokio::spawn(async move {
        evo_daemon::serve(listener, serve_state).await.unwrap();
    });
    (format!("http://{addr}"), state, dir)
}

async fn rpc(base: &str, method: &str, params: serde_json::Value) -> RpcResponse {
    let res = reqwest::Client::new()
        .post(format!("{base}/v1/rpc"))
        .header("Authorization", format!("Bearer {TOKEN}"))
        .json(&RpcRequest {
            id: 1,
            method: method.to_owned(),
            params,
        })
        .send()
        .await
        .unwrap();
    assert!(res.status().is_success(), "rpc HTTP {}", res.status());
    res.json().await.unwrap()
}

#[tokio::test]
async fn overdue_once_trigger_fires_on_tick_with_kind_schedule() {
    let clock = Arc::new(FrozenClock::new(1_000));
    let (base, state, _dir) = spawn(clock.clone()).await;

    let created = rpc(
        &base,
        "trigger.create",
        serde_json::json!({
            "name": "once",
            "intent": "把账龄表做出来",
            "spec": { "kind": "once", "at_ms": 500 }
        }),
    )
    .await;
    let view: TriggerView = serde_json::from_value(created.result.unwrap()).unwrap();

    let fired = state.fire_due().await.unwrap();
    assert_eq!(fired.len(), 1, "overdue once must start exactly one run");

    let events = rpc(
        &base,
        "run.events",
        serde_json::json!({ "run_id": fired[0].as_str(), "from_seq": 0 }),
    )
    .await;
    let bundle: RunEventsResult = serde_json::from_value(events.result.unwrap()).unwrap();
    let created_ev = bundle
        .events
        .iter()
        .find_map(|e| match &e.body {
            EventBody::RunCreated(c) => Some(c),
            _ => None,
        })
        .unwrap();
    assert_eq!(created_ev.trigger.kind, TriggerKind::Schedule);
    assert_eq!(created_ev.trigger.reference, view.trigger_id.as_str());

    let fired_again = state.fire_due().await.unwrap();
    assert!(
        fired_again.is_empty(),
        "a once trigger must not fire a second time"
    );
}

#[tokio::test]
async fn paused_trigger_does_not_fire_until_resumed() {
    let clock = Arc::new(FrozenClock::new(1_000));
    let (base, state, _dir) = spawn(clock).await;

    let created = rpc(
        &base,
        "trigger.create",
        serde_json::json!({
            "name": "paused",
            "intent": "把账龄表做出来",
            "spec": { "kind": "once", "at_ms": 1 },
            "paused": true
        }),
    )
    .await;
    let view: TriggerView = serde_json::from_value(created.result.unwrap()).unwrap();
    assert!(state.fire_due().await.unwrap().is_empty());

    rpc(
        &base,
        "trigger.create",
        serde_json::json!({
            "trigger_id": view.trigger_id.as_str(),
            "name": "paused",
            "intent": "把账龄表做出来",
            "spec": { "kind": "once", "at_ms": 1 },
            "paused": false
        }),
    )
    .await;
    let fired = state.fire_due().await.unwrap();
    assert_eq!(fired.len(), 1);
}

#[tokio::test]
async fn interval_does_not_fire_on_create_only_after_one_period() {
    let clock = Arc::new(FrozenClock::new(1_000));
    let (base, state, _dir) = spawn(clock.clone()).await;

    rpc(
        &base,
        "trigger.create",
        serde_json::json!({
            "name": "every",
            "intent": "把账龄表做出来",
            "spec": { "kind": "interval", "every_ms": 10_000 }
        }),
    )
    .await;

    assert!(
        state.fire_due().await.unwrap().is_empty(),
        "interval must wait one period after create"
    );
    clock.set(11_000);
    let fired = state.fire_due().await.unwrap();
    assert_eq!(fired.len(), 1);
}

#[tokio::test]
async fn triggers_are_written_next_to_runlog_and_reload() {
    let clock = Arc::new(FrozenClock::new(1_000));
    let (base, _state, dir) = spawn(clock).await;
    rpc(
        &base,
        "trigger.create",
        serde_json::json!({
            "name": "keep",
            "intent": "把账龄表做出来",
            "spec": { "kind": "once", "at_ms": 9_999 }
        }),
    )
    .await;

    let store =
        evo_daemon::trigger::TriggerStore::open(&dir.path().join("triggers.sqlite")).unwrap();
    assert_eq!(store.list().unwrap().len(), 1);
    assert_eq!(store.list().unwrap()[0].name, "keep");
}
