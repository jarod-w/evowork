use evo_daemon::{AppState, DaemonConfig, FixedClock, Runtime};
use evo_exec_local::{LocalExecutor, WorkspaceOnlySandbox};
use evo_model::FixtureAdapter;
use evo_protocol::EventBody;
use evo_protocol::budget::BudgetSpec;
use evo_protocol::rpc::{
    BlobGetResult, CaughtUpFrame, ClientStreamFrame, EventFrame, HelloFrame, RpcRequest,
    RpcResponse, RunCreateResult, RunEventsResult, RunGetResult, RunListResult,
};
use futures_util::{SinkExt, StreamExt};
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

async fn spawn_server(fixtures: &str) -> (String, tempfile::TempDir) {
    spawn_server_with(fixtures, |_| {}).await
}

async fn spawn_server_with(
    fixtures: &str,
    tweak: impl FnOnce(&mut DaemonConfig),
) -> (String, tempfile::TempDir) {
    let dir = tempfile::tempdir().unwrap();
    let mut config = DaemonConfig::for_test(dir.path());
    tweak(&mut config);
    let runtime = Runtime::new(
        config,
        Arc::new(FixedClock::new(1_756_461_600_000)),
        Arc::new(FixtureAdapter::from_json_str(fixtures).unwrap()),
        Arc::new(LocalExecutor::new(Arc::new(WorkspaceOnlySandbox::new()))),
    )
    .unwrap();
    let state = AppState::new(runtime, TOKEN, "0.1.0-test");
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        evo_daemon::serve(listener, state).await.unwrap();
    });
    (format!("http://{addr}"), dir)
}

fn client() -> reqwest::Client {
    reqwest::Client::new()
}

async fn rpc(base: &str, method: &str, params: serde_json::Value) -> RpcResponse {
    let res = client()
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
async fn hello_without_token_is_401() {
    let (base, _dir) = spawn_server(FINISH_FIXTURES).await;
    let res = client()
        .get(format!("{base}/v1/hello"))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), reqwest::StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn hello_with_token_returns_protocol_1_0() {
    let (base, _dir) = spawn_server(FINISH_FIXTURES).await;
    let res = client()
        .get(format!("{base}/v1/hello"))
        .header("Authorization", format!("Bearer {TOKEN}"))
        .send()
        .await
        .unwrap();
    assert!(res.status().is_success());
    let frame: HelloFrame = res.json().await.unwrap();
    assert_eq!(frame.protocol_ver, "1.0");
    assert_eq!(frame.daemon_ver, "0.1.0-test");
    assert_eq!(frame.runlog_schema_ver, 1);
}

#[tokio::test]
async fn run_create_list_get_events_and_cost_query_roundtrip() {
    let (base, _dir) = spawn_server(FINISH_FIXTURES).await;

    let created = rpc(
        &base,
        "run.create",
        serde_json::json!({ "intent": "把账龄表做出来" }),
    )
    .await;
    let result: RunCreateResult = serde_json::from_value(created.result.unwrap()).unwrap();
    assert_eq!(result.status, "completed");
    assert!(result.last_seq > 0);
    let run_id = result.run_id;

    let listed = rpc(&base, "run.list", serde_json::json!({})).await;
    let list: RunListResult = serde_json::from_value(listed.result.unwrap()).unwrap();
    assert_eq!(list.runs.len(), 1);
    assert_eq!(list.runs[0].run_id, run_id);
    assert_eq!(list.runs[0].status, "completed");

    let got = rpc(
        &base,
        "run.get",
        serde_json::json!({ "run_id": run_id.as_str() }),
    )
    .await;
    let summary: RunGetResult = serde_json::from_value(got.result.unwrap()).unwrap();
    assert_eq!(summary.status, "completed");

    let events = rpc(
        &base,
        "run.events",
        serde_json::json!({ "run_id": run_id.as_str(), "from_seq": 0 }),
    )
    .await;
    let bundle: RunEventsResult = serde_json::from_value(events.result.unwrap()).unwrap();
    let kinds: Vec<&str> = bundle.events.iter().map(|e| e.body.kind()).collect();
    assert_eq!(kinds.first().copied(), Some("run.created"));
    assert_eq!(kinds.last().copied(), Some("run.completed"));

    let cost = rpc(
        &base,
        "cost.query",
        serde_json::json!({ "run_id": run_id.as_str() }),
    )
    .await;
    let cost = cost.result.unwrap();
    assert!(cost["entries"].as_u64().unwrap() >= 1);
    assert!(cost["amount_micros"].as_u64().unwrap() > 0);
}

#[tokio::test]
async fn blob_get_returns_the_intent_text_written_at_run_create() {
    let (base, _dir) = spawn_server(FINISH_FIXTURES).await;
    let intent = "把账龄表做出来";
    let created = rpc(&base, "run.create", serde_json::json!({ "intent": intent })).await;
    let result: RunCreateResult = serde_json::from_value(created.result.unwrap()).unwrap();

    let events = rpc(
        &base,
        "run.events",
        serde_json::json!({ "run_id": result.run_id.as_str(), "from_seq": 0 }),
    )
    .await;
    let bundle: RunEventsResult = serde_json::from_value(events.result.unwrap()).unwrap();
    let intent_ref = bundle
        .events
        .iter()
        .find_map(|e| match &e.body {
            EventBody::IntentDeclared(d) => Some(d.intent_ref.clone()),
            _ => None,
        })
        .expect("run.create 必须写出 intent.declared");

    let got = rpc(
        &base,
        "blob.get",
        serde_json::json!({ "content_hash": intent_ref.content_hash }),
    )
    .await;
    let blob: BlobGetResult = serde_json::from_value(got.result.unwrap()).unwrap();
    assert_eq!(blob.text, intent);
    assert_eq!(blob.content_hash, intent_ref.content_hash);
    assert_eq!(blob.size, intent.len() as u64);
}

#[tokio::test]
async fn blob_get_missing_hash_is_not_found_not_internal() {
    let (base, _dir) = spawn_server(FINISH_FIXTURES).await;
    let res = rpc(
        &base,
        "blob.get",
        serde_json::json!({ "content_hash": format!("sha256:{}", "ab".repeat(32)) }),
    )
    .await;
    let err = res.error.unwrap();
    assert_eq!(err.code, -32004);
    assert!(err.message.contains("blob not found"));
}

#[tokio::test]
async fn blob_get_malformed_hash_is_invalid_params() {
    let (base, _dir) = spawn_server(FINISH_FIXTURES).await;
    let res = rpc(
        &base,
        "blob.get",
        serde_json::json!({ "content_hash": "not-a-hash" }),
    )
    .await;
    let err = res.error.unwrap();
    assert_eq!(err.code, -32602);
    assert!(err.message.contains("malformed blob ref"));
}

#[tokio::test]
async fn unimplemented_catalog_method_returns_method_not_found() {
    let (base, _dir) = spawn_server(FINISH_FIXTURES).await;
    let res = rpc(&base, "run.fork", serde_json::json!({})).await;
    let err = res.error.unwrap();
    assert_eq!(err.code, -32601);
    assert!(err.message.contains("not implemented: run.fork"));
}

#[tokio::test]
async fn unknown_method_returns_method_not_found() {
    let (base, _dir) = spawn_server(FINISH_FIXTURES).await;
    let res = rpc(&base, "no.such.method", serde_json::json!({})).await;
    let err = res.error.unwrap();
    assert_eq!(err.code, -32601);
    assert!(err.message.contains("unknown method"));
}

#[tokio::test]
async fn tool_list_and_policy_get_are_readable() {
    let (base, _dir) = spawn_server(FINISH_FIXTURES).await;
    let tools = rpc(&base, "tool.list", serde_json::json!({})).await;
    let tools = tools.result.unwrap();
    assert!(
        tools["tools"]
            .as_array()
            .unwrap()
            .iter()
            .any(|t| t["name"] == "fs.write")
    );

    let policy = rpc(&base, "policy.get", serde_json::json!({})).await;
    let policy_val = policy.result.unwrap();
    let body = policy_val["policy_toml"].as_str().unwrap();
    assert!(!body.is_empty());
}

#[tokio::test]
async fn ws_subscribe_replays_backlog_then_caught_up() {
    let (base, _dir) = spawn_server(FINISH_FIXTURES).await;
    let created = rpc(&base, "run.create", serde_json::json!({ "intent": "x" })).await;
    let result: RunCreateResult = serde_json::from_value(created.result.unwrap()).unwrap();
    let run_id = result.run_id;

    let ws_url = base.replacen("http://", "ws://", 1) + "/v1/events?token=" + TOKEN;
    let (ws, _) = tokio_tungstenite::connect_async(&ws_url).await.unwrap();
    let (mut sink, mut stream) = ws.split();

    let hello: HelloFrame =
        serde_json::from_str(&stream.next().await.unwrap().unwrap().into_text().unwrap()).unwrap();
    assert_eq!(hello.op, evo_protocol::rpc::HelloOp::Hello);

    let sub = ClientStreamFrame::Subscribe {
        run_id: run_id.clone(),
        from_seq: 0,
    };
    sink.send(tokio_tungstenite::tungstenite::Message::Text(
        serde_json::to_string(&sub).unwrap().into(),
    ))
    .await
    .unwrap();

    let mut saw_created = false;
    let mut saw_caught_up = false;
    while let Some(msg) = stream.next().await {
        let txt = msg.unwrap().into_text().unwrap();
        let v: serde_json::Value = serde_json::from_str(&txt).unwrap();
        match v["op"].as_str() {
            Some("event") => {
                let frame: EventFrame = serde_json::from_value(v).unwrap();
                if frame.event.body.kind() == "run.created" {
                    saw_created = true;
                    assert_eq!(frame.event.run_id, run_id);
                }
            }
            Some("caught_up") => {
                let frame: CaughtUpFrame = serde_json::from_value(v).unwrap();
                assert_eq!(frame.run_id, run_id);
                saw_caught_up = true;
                break;
            }
            other => panic!("unexpected op {other:?}"),
        }
    }
    assert!(saw_created, "backlog must include run.created");
    assert!(saw_caught_up, "server must mark catch-up");
}

/// 三轮：写 report-0、写 report-1、结束。额度 300 micros 会在第二轮模型
/// 调用之后挂起（与 `budget_gate.rs` 同一条账）。这条测的是 **RPC**
/// `budget.amend` 真的接到 `Runtime::amend_budget`，不是只在 Runtime
/// 测试里走得通。
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

#[tokio::test]
async fn budget_amend_rpc_raises_the_ceiling_and_the_run_finishes() {
    let (base, _dir) = spawn_server_with(THREE_TURN_FIXTURES, |config| {
        config.budget = BudgetSpec {
            max_amount_micros: Some(300),
            ..BudgetSpec::default()
        };
    })
    .await;

    let created = rpc(
        &base,
        "run.create",
        serde_json::json!({ "intent": "把账龄表做出来" }),
    )
    .await;
    let created: RunCreateResult = serde_json::from_value(created.result.unwrap()).unwrap();
    assert_eq!(
        created.status, "suspended",
        "300 micros 必须在第二轮之前把 run 挂起，实得 {}",
        created.status
    );

    let got = rpc(
        &base,
        "run.get",
        serde_json::json!({ "run_id": created.run_id.as_str() }),
    )
    .await;
    let summary: RunGetResult = serde_json::from_value(got.result.unwrap()).unwrap();
    assert_eq!(summary.awaiting.as_deref(), Some("budget"));

    let amended = rpc(
        &base,
        "budget.amend",
        serde_json::json!({
            "run_id": created.run_id.as_str(),
            "budget": { "max_amount_micros": 2_000 },
            "reason": "这条 run 值得跑完"
        }),
    )
    .await;
    let amended: RunCreateResult = serde_json::from_value(amended.result.unwrap()).unwrap();
    assert_eq!(
        amended.status, "completed",
        "提额之后 run 必须真的跑完，实得 {}",
        amended.status
    );

    let events = rpc(
        &base,
        "run.events",
        serde_json::json!({ "run_id": created.run_id.as_str(), "from_seq": 0 }),
    )
    .await;
    let bundle: RunEventsResult = serde_json::from_value(events.result.unwrap()).unwrap();
    let kinds: Vec<&str> = bundle.events.iter().map(|e| e.body.kind()).collect();
    assert!(
        kinds.contains(&"budget.amended"),
        "RPC 提额必须落 budget.amended：{kinds:?}"
    );
    assert_eq!(kinds.last().copied(), Some("run.completed"));
}

#[tokio::test]
async fn ws_without_token_is_rejected() {
    let (base, _dir) = spawn_server(FINISH_FIXTURES).await;
    let ws_url = base.replacen("http://", "ws://", 1) + "/v1/events?token=wrong";
    let result = tokio_tungstenite::connect_async(&ws_url).await;
    assert!(result.is_err(), "bad token must not upgrade");
}
