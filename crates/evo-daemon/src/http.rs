//! HTTP `/v1/rpc` + WS `/v1/events` + `GET /v1/hello`（设计文档 06）。
//!
//! 本模块是 daemon 进程的对外表面。它不自己写 Run Log——所有写入都经
//! [`crate::Runtime`]（唯一写者）。读路径开第二条 SQLite 连接（WAL 允许多
//! 读者），这样一条 run 在 `drive` 里占着 Runtime 的锁时，事件流仍能把已经
//! 落盘的 backlog 推出去。

use crate::replay::replay_to;
use crate::runtime::{DaemonError, RunOutcome, Runtime};
use crate::trigger::{
    TriggerRecord, TriggerStore, next_fire_ms, random_hook_secret, trigger_db_path, validate_spec,
};
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::IntoResponse;
use axum::routing::{get, post};
use axum::{Json, Router};
use evo_gateway::ManifestRegistry;
use evo_kernel::{AwaitReason, RunStatus};
use evo_protocol::events::accounting::CostCharged;
use evo_protocol::events::effect::ExecutionMode;
use evo_protocol::events::lifecycle::{TriggerKind, TriggerRef};
use evo_protocol::rpc::{
    ApprovalDecideParams, BlobGetParams, BlobGetResult, BudgetAmendParams, CaughtUpFrame,
    ClarificationAnswerParams, ClientStreamFrame, CostQueryParams, CostQueryResult, EventFrame,
    HelloFrame, PolicyGetResult, RPC_INTERNAL, RPC_INVALID_PARAMS, RPC_METHOD_NOT_FOUND,
    RPC_METHODS, RPC_NOT_FOUND, RpcRequest, RpcResponse, RunCreateParams, RunCreateResult,
    RunEventsParams, RunEventsResult, RunGetResult, RunIdParams, RunListResult, ToolListItem,
    ToolListResult, ToolManifestParams, ToolManifestResult, TriggerCreateParams,
    TriggerDryrunResult, TriggerIdParams, TriggerListResult, TriggerSpec,
};
use evo_protocol::{Actor, BlobRef, Currency, Event, EventBody, RunId, TriggerId};
use evo_runlog::{RunLog, RunLogError};
use serde::Deserialize;
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;
use tokio::net::TcpListener;
use tokio::sync::{Mutex, broadcast};
use tower_http::cors::CorsLayer;

const EVENT_BUS_CAPACITY: usize = 1024;

#[derive(Clone)]
pub struct AppState {
    runtime: Arc<Mutex<Runtime>>,
    triggers: Arc<std::sync::Mutex<TriggerStore>>,
    event_tx: broadcast::Sender<Event>,
    token: String,
    db_path: PathBuf,
    blob_root: PathBuf,
    tools_toml: String,
    policy_toml: String,
    daemon_ver: String,
    next_run: Arc<AtomicU64>,
    next_trigger: Arc<AtomicU64>,
}

impl AppState {
    pub fn new(
        runtime: Runtime,
        token: impl Into<String>,
        daemon_ver: impl Into<String>,
    ) -> Result<Self, DaemonError> {
        let (event_tx, _) = broadcast::channel(EVENT_BUS_CAPACITY);
        let runtime = runtime.with_event_sink(event_tx.clone());
        let db_path = runtime.config().db_path.clone();
        let blob_root = runtime.config().blob_root.clone();
        let tools_toml = runtime.config().tools_toml.clone();
        let policy_toml = runtime.config().policy_toml.clone();
        let triggers = TriggerStore::open(&trigger_db_path(&db_path))?;
        Ok(Self {
            runtime: Arc::new(Mutex::new(runtime)),
            triggers: Arc::new(std::sync::Mutex::new(triggers)),
            event_tx,
            token: token.into(),
            db_path,
            blob_root,
            tools_toml,
            policy_toml,
            daemon_ver: daemon_ver.into(),
            next_run: Arc::new(AtomicU64::new(1)),
            next_trigger: Arc::new(AtomicU64::new(1)),
        })
    }

    fn open_log(&self) -> Result<RunLog, DaemonError> {
        Ok(RunLog::open(&self.db_path, &self.blob_root)?)
    }

    fn alloc_run_id(&self) -> RunId {
        let n = self.next_run.fetch_add(1, Ordering::SeqCst);
        let ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        RunId::from(format!("r-{ms}-{n}"))
    }

    fn alloc_trigger_id(&self) -> TriggerId {
        let n = self.next_trigger.fetch_add(1, Ordering::SeqCst);
        let ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        TriggerId::from(format!("t-{ms}-{n}"))
    }

    fn lock_triggers(&self) -> Result<std::sync::MutexGuard<'_, TriggerStore>, DaemonError> {
        self.triggers
            .lock()
            .map_err(|_| DaemonError::TriggerStorePoisoned)
    }

    /// 本层保证调度循环跑在 daemon 进程里，不在 UI。不保证机器开机，
    /// 也不保证有人用 LaunchDaemon 把本进程拉起来（那是装机前提）。
    pub async fn fire_due(&self) -> Result<Vec<RunId>, DaemonError> {
        let now_ms = self.runtime.lock().await.now_ms();
        let due = {
            let store = self.lock_triggers()?;
            store.due(now_ms)?
        };
        let mut fired = Vec::new();
        for rec in due {
            match self.fire_record(rec.id.clone(), now_ms).await {
                Ok(result) => fired.push(result.run_id),
                Err(DaemonError::TriggerBusy(_) | DaemonError::TriggerPaused(_)) => {}
                Err(DaemonError::UnknownTrigger(_)) => {}
                Err(e) => eprintln!("evo-daemon scheduler: {e}"),
            }
        }
        Ok(fired)
    }

    async fn fire_record(
        &self,
        trigger_id: TriggerId,
        now_ms: u64,
    ) -> Result<RunCreateResult, DaemonError> {
        let run_id = self.alloc_run_id();
        let (intent, kind) = {
            let store = self.lock_triggers()?;
            let mut rec = store
                .get(&trigger_id)?
                .ok_or_else(|| DaemonError::UnknownTrigger(trigger_id.to_string()))?;
            if rec.paused {
                return Err(DaemonError::TriggerPaused(trigger_id.to_string()));
            }
            if let Some(prev) = &rec.last_run_id
                && self.last_run_active(prev)?
            {
                return Err(DaemonError::TriggerBusy(trigger_id.to_string()));
            }
            rec.last_run_id = Some(run_id.clone());
            store.update(&rec)?;
            (rec.intent.clone(), rec.kind())
        };

        let mut rt = self.runtime.lock().await;
        let outcome = rt
            .start_with_trigger(
                &run_id,
                &intent,
                TriggerRef {
                    kind,
                    reference: trigger_id.to_string(),
                },
            )
            .await?;
        drop(rt);

        {
            let store = self.lock_triggers()?;
            if let Some(mut rec) = store.get(&trigger_id)? {
                rec.last_fired_ms = Some(now_ms);
                rec.next_fire_ms = match &rec.spec {
                    TriggerSpec::Once { .. } | TriggerSpec::Webhook => None,
                    TriggerSpec::Interval { .. } => next_fire_ms(&rec.spec, now_ms),
                    _ => next_fire_ms(&rec.spec, now_ms.saturating_add(1)),
                };
                store.update(&rec)?;
            }
        }

        let state = outcome.into_state();
        Ok(RunCreateResult {
            run_id,
            status: status_str(state.status),
            last_seq: state.last_seq,
        })
    }

    fn last_run_active(&self, run_id: &RunId) -> Result<bool, DaemonError> {
        let log = self.open_log()?;
        if log.last_seq(run_id)?.is_none() {
            return Ok(false);
        }
        match replay_to(&log, run_id, None, true) {
            Ok(state) => Ok(matches!(
                state.status,
                RunStatus::Running | RunStatus::Suspended
            )),
            // 解不开就当还在跑：宁可漏一次也不对着同一条定义连发。
            Err(_) => Ok(true),
        }
    }
}

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/v1/hello", get(hello))
        .route("/v1/rpc", post(rpc))
        .route("/v1/events", get(events_ws))
        .route("/v1/hooks/{secret}", post(webhook_fire))
        .layer(CorsLayer::very_permissive())
        .with_state(state)
}

pub async fn serve(listener: TcpListener, state: AppState) -> std::io::Result<()> {
    axum::serve(listener, router(state)).await
}

/// 每秒扫一次到期的定时触发器。挂在 daemon 进程上，与 UI 是否开着无关。
pub async fn run_scheduler(state: AppState) {
    let mut interval = tokio::time::interval(Duration::from_secs(1));
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        interval.tick().await;
        if let Err(e) = state.fire_due().await {
            eprintln!("evo-daemon scheduler: {e}");
        }
    }
}

fn bearer_token(headers: &HeaderMap) -> Option<&str> {
    let value = headers
        .get(axum::http::header::AUTHORIZATION)?
        .to_str()
        .ok()?;
    value.strip_prefix("Bearer ")
}

fn authorize(headers: &HeaderMap, expected: &str) -> Result<(), StatusCode> {
    match bearer_token(headers) {
        Some(got) if got == expected => Ok(()),
        _ => Err(StatusCode::UNAUTHORIZED),
    }
}

async fn hello(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<HelloFrame>, StatusCode> {
    authorize(&headers, &state.token)?;
    Ok(Json(HelloFrame::new(&state.daemon_ver)))
}

async fn rpc(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<RpcRequest>,
) -> Result<Json<RpcResponse>, StatusCode> {
    authorize(&headers, &state.token)?;
    Ok(Json(dispatch(&state, req).await))
}

#[derive(Debug, Deserialize)]
struct EventsQuery {
    token: String,
}

async fn events_ws(
    ws: WebSocketUpgrade,
    Query(query): Query<EventsQuery>,
    State(state): State<AppState>,
) -> impl IntoResponse {
    if query.token != state.token {
        return Err(StatusCode::UNAUTHORIZED);
    }
    Ok(ws.on_upgrade(move |socket| handle_socket(socket, state)))
}

async fn handle_socket(mut socket: WebSocket, state: AppState) {
    let hello = HelloFrame::new(&state.daemon_ver);
    if send_json(&mut socket, &hello).await.is_err() {
        return;
    }

    let Some(Ok(Message::Text(text))) = socket.recv().await else {
        return;
    };
    let frame: ClientStreamFrame = match serde_json::from_str(&text) {
        Ok(v) => v,
        Err(e) => {
            let _ = socket
                .send(Message::Close(Some(axum::extract::ws::CloseFrame {
                    code: axum::extract::ws::close_code::ERROR,
                    reason: format!("invalid subscribe frame: {e}").into(),
                })))
                .await;
            return;
        }
    };

    // 先订广播再读 backlog，避免 catch-up 与 live 之间的缝把事件漏掉；
    // live 侧再按 seq 去重。
    let mut rx = state.event_tx.subscribe();

    match frame {
        ClientStreamFrame::Subscribe { run_id, from_seq } => {
            let Ok(last_sent) = catch_up_one(&state, &mut socket, &run_id, from_seq).await else {
                return;
            };
            live_loop(&mut socket, &mut rx, Some(run_id), from_seq, last_sent).await;
        }
        ClientStreamFrame::SubscribeAll { from_seq } => {
            let from_seq = from_seq.unwrap_or(0);
            let Ok(last_sent) = catch_up_all(&state, &mut socket, from_seq).await else {
                return;
            };
            live_loop(&mut socket, &mut rx, None, from_seq, last_sent).await;
        }
    }
}

async fn catch_up_one(
    state: &AppState,
    socket: &mut WebSocket,
    run_id: &RunId,
    from_seq: u64,
) -> Result<BTreeMap<RunId, u64>, ()> {
    let log = state.open_log().map_err(|_| ())?;
    let events = log.events(run_id, from_seq, None).map_err(|_| ())?;
    let mut last_sent = BTreeMap::new();
    let mut last = from_seq.saturating_sub(1);
    for event in events {
        last = event.seq;
        last_sent.insert(run_id.clone(), event.seq);
        send_json(socket, &EventFrame::new(event)).await?;
    }
    send_json(socket, &CaughtUpFrame::new(run_id.clone(), last)).await?;
    Ok(last_sent)
}

async fn catch_up_all(
    state: &AppState,
    socket: &mut WebSocket,
    from_seq: u64,
) -> Result<BTreeMap<RunId, u64>, ()> {
    let log = state.open_log().map_err(|_| ())?;
    let run_ids = log.run_ids().map_err(|_| ())?;
    let mut last_sent = BTreeMap::new();
    for run_id in run_ids {
        let events = log.events(&run_id, from_seq, None).map_err(|_| ())?;
        let mut last = from_seq.saturating_sub(1);
        for event in events {
            last = event.seq;
            last_sent.insert(run_id.clone(), event.seq);
            send_json(socket, &EventFrame::new(event)).await?;
        }
        send_json(socket, &CaughtUpFrame::new(run_id, last)).await?;
    }
    Ok(last_sent)
}

async fn live_loop(
    socket: &mut WebSocket,
    rx: &mut broadcast::Receiver<Event>,
    only_run: Option<RunId>,
    from_seq: u64,
    mut last_sent: BTreeMap<RunId, u64>,
) {
    loop {
        tokio::select! {
            incoming = socket.recv() => {
                match incoming {
                    Some(Ok(Message::Close(_))) | None => break,
                    Some(Ok(Message::Ping(p))) => {
                        let _ = socket.send(Message::Pong(p)).await;
                    }
                    Some(Ok(_)) => {}
                    Some(Err(_)) => break,
                }
            }
            event = rx.recv() => {
                match event {
                    Ok(event) => {
                        if event.seq < from_seq {
                            continue;
                        }
                        if let Some(run_id) = &only_run
                            && event.run_id != *run_id
                        {
                            continue;
                        }
                        if last_sent
                            .get(&event.run_id)
                            .is_some_and(|sent| event.seq <= *sent)
                        {
                            continue;
                        }
                        last_sent.insert(event.run_id.clone(), event.seq);
                        if send_json(socket, &EventFrame::new(event)).await.is_err() {
                            break;
                        }
                    }
                    Err(broadcast::error::RecvError::Lagged(_)) => break,
                    Err(broadcast::error::RecvError::Closed) => break,
                }
            }
        }
    }
}

async fn send_json<T: serde::Serialize>(socket: &mut WebSocket, value: &T) -> Result<(), ()> {
    let text = serde_json::to_string(value).map_err(|_| ())?;
    socket
        .send(Message::Text(text.into()))
        .await
        .map_err(|_| ())
}

async fn dispatch(state: &AppState, req: RpcRequest) -> RpcResponse {
    let id = req.id;
    let method = req.method.as_str();
    let params = req.params;
    let result = match method {
        "run.create" => run_create(state, params).await,
        "run.get" => run_get(state, params),
        "run.list" => run_list(state, params),
        "run.events" => run_events(state, params),
        "run.resume" => run_resume(state, params).await,
        "approval.decide" => approval_decide(state, params).await,
        "clarification.answer" => clarification_answer(state, params).await,
        "budget.amend" => budget_amend(state, params).await,
        "cost.query" => cost_query(state, params),
        "blob.get" => blob_get(state, params),
        "tool.list" => tool_list(state, params),
        "tool.manifest" => tool_manifest(state, params),
        "policy.get" => policy_get(state, params),
        "trigger.create" => trigger_create(state, params).await,
        "trigger.list" => trigger_list(state, params),
        "trigger.delete" => trigger_delete(state, params),
        "trigger.dryrun" => trigger_dryrun(state, params).await,
        other if RPC_METHODS.contains(&other) => Err(RpcFail {
            code: RPC_METHOD_NOT_FOUND,
            message: format!("not implemented: {other}"),
        }),
        other => Err(RpcFail {
            code: RPC_METHOD_NOT_FOUND,
            message: format!("unknown method: {other}"),
        }),
    };
    match result {
        Ok(value) => RpcResponse::ok(id, value),
        Err(fail) => RpcResponse::err(id, fail.code, fail.message),
    }
}

struct RpcFail {
    code: i64,
    message: String,
}

impl From<DaemonError> for RpcFail {
    fn from(err: DaemonError) -> Self {
        match &err {
            DaemonError::UnknownApproval(_)
            | DaemonError::UnknownClarification(_)
            | DaemonError::UnknownTrigger(_) => Self {
                code: RPC_NOT_FOUND,
                message: err.to_string(),
            },
            DaemonError::UnknownClarificationOption { .. } => Self {
                code: RPC_INVALID_PARAMS,
                message: err.to_string(),
            },
            _ => Self {
                code: RPC_INTERNAL,
                message: err.to_string(),
            },
        }
    }
}

impl From<crate::trigger::TriggerStoreError> for RpcFail {
    fn from(err: crate::trigger::TriggerStoreError) -> Self {
        DaemonError::from(err).into()
    }
}

fn params<T: serde::de::DeserializeOwned>(value: serde_json::Value) -> Result<T, RpcFail> {
    serde_json::from_value(value).map_err(|e| RpcFail {
        code: RPC_INVALID_PARAMS,
        message: e.to_string(),
    })
}

fn status_str(status: RunStatus) -> String {
    match status {
        RunStatus::Running => "running",
        RunStatus::Suspended => "suspended",
        RunStatus::Completed => "completed",
        RunStatus::Failed => "failed",
    }
    .to_owned()
}

fn awaiting_str(reason: &Option<AwaitReason>) -> Option<String> {
    match reason {
        Some(AwaitReason::Approval { approval_id, .. }) => Some(format!("approval:{approval_id}")),
        Some(AwaitReason::Clarification { question_id }) => {
            Some(format!("clarification:{question_id}"))
        }
        Some(AwaitReason::Budget) => Some("budget".to_owned()),
        Some(AwaitReason::Human { step }) => Some(format!("human:{step}")),
        Some(AwaitReason::ExternalEvent { kind }) => Some(format!("external:{kind}")),
        None => None,
    }
}

fn outcome_result(run_id: RunId, outcome: RunOutcome) -> serde_json::Value {
    let state = outcome.into_state();
    serde_json::to_value(RunCreateResult {
        run_id,
        status: status_str(state.status),
        last_seq: state.last_seq,
    })
    .expect("RunCreateResult 必须可序列化")
}

fn summarize_run(log: &RunLog, run_id: &RunId) -> Result<RunGetResult, RpcFail> {
    if log.last_seq(run_id).map_err(DaemonError::from)?.is_none() {
        return Err(RpcFail {
            code: RPC_NOT_FOUND,
            message: format!("run not found: {run_id}"),
        });
    }
    let state = replay_to(log, run_id, None, true)?;
    Ok(RunGetResult {
        run_id: run_id.clone(),
        status: status_str(state.status),
        turn: state.turn,
        last_seq: state.last_seq,
        awaiting: awaiting_str(&state.awaiting),
    })
}

async fn run_create(
    state: &AppState,
    raw: serde_json::Value,
) -> Result<serde_json::Value, RpcFail> {
    let p: RunCreateParams = params(raw)?;
    if matches!(p.mode, Some(ExecutionMode::DryRun)) {
        return Err(RpcFail {
            code: RPC_METHOD_NOT_FOUND,
            message: "not implemented: run.create mode=dry_run".to_owned(),
        });
    }
    let run_id = state.alloc_run_id();
    let mut rt = state.runtime.lock().await;
    let outcome = rt.start_from(&run_id, &p.intent, "ui").await?;
    Ok(outcome_result(run_id, outcome))
}

fn run_get(state: &AppState, raw: serde_json::Value) -> Result<serde_json::Value, RpcFail> {
    let p: RunIdParams = params(raw)?;
    let log = state.open_log()?;
    let summary = summarize_run(&log, &p.run_id)?;
    Ok(serde_json::to_value(summary).expect("RunGetResult 必须可序列化"))
}

fn run_list(state: &AppState, raw: serde_json::Value) -> Result<serde_json::Value, RpcFail> {
    let _: serde_json::Value = params(raw).unwrap_or(serde_json::json!({}));
    let log = state.open_log()?;
    let mut runs = Vec::new();
    for run_id in log.run_ids().map_err(DaemonError::from)? {
        runs.push(summarize_run(&log, &run_id)?);
    }
    Ok(serde_json::to_value(RunListResult { runs }).expect("RunListResult 必须可序列化"))
}

fn run_events(state: &AppState, raw: serde_json::Value) -> Result<serde_json::Value, RpcFail> {
    let p: RunEventsParams = params(raw)?;
    let log = state.open_log()?;
    if log
        .last_seq(&p.run_id)
        .map_err(DaemonError::from)?
        .is_none()
    {
        return Err(RpcFail {
            code: RPC_NOT_FOUND,
            message: format!("run not found: {}", p.run_id),
        });
    }
    let events = log
        .events(&p.run_id, p.from_seq, p.to_seq)
        .map_err(DaemonError::from)?;
    Ok(serde_json::to_value(RunEventsResult { events }).expect("RunEventsResult 必须可序列化"))
}

async fn run_resume(
    state: &AppState,
    raw: serde_json::Value,
) -> Result<serde_json::Value, RpcFail> {
    let p: RunIdParams = params(raw)?;
    let mut rt = state.runtime.lock().await;
    let outcome = rt.resume(&p.run_id).await?;
    Ok(outcome_result(p.run_id, outcome))
}

async fn approval_decide(
    state: &AppState,
    raw: serde_json::Value,
) -> Result<serde_json::Value, RpcFail> {
    let p: ApprovalDecideParams = params(raw)?;
    let mut rt = state.runtime.lock().await;
    let principal = rt.config().principal.clone();
    let outcome = rt
        .decide_approval(
            &p.run_id,
            &p.approval_id,
            p.granted,
            Actor::Human(principal),
            p.note.as_deref(),
        )
        .await?;
    Ok(outcome_result(p.run_id, outcome))
}

async fn budget_amend(
    state: &AppState,
    raw: serde_json::Value,
) -> Result<serde_json::Value, RpcFail> {
    let p: BudgetAmendParams = params(raw)?;
    let mut rt = state.runtime.lock().await;
    let principal = rt.config().principal.clone();
    let outcome = rt
        .amend_budget(
            &p.run_id,
            p.budget,
            Actor::Human(principal),
            p.reason.as_deref(),
        )
        .await?;
    Ok(outcome_result(p.run_id, outcome))
}

async fn clarification_answer(
    state: &AppState,
    raw: serde_json::Value,
) -> Result<serde_json::Value, RpcFail> {
    let p: ClarificationAnswerParams = params(raw)?;
    let mut rt = state.runtime.lock().await;
    let principal = rt.config().principal.clone();
    let outcome = rt
        .answer_clarification(
            &p.run_id,
            &p.question_id,
            p.option_id.as_deref(),
            p.free_text.as_deref(),
            Actor::Human(principal),
        )
        .await?;
    Ok(outcome_result(p.run_id, outcome))
}

fn blob_get(state: &AppState, raw: serde_json::Value) -> Result<serde_json::Value, RpcFail> {
    let p: BlobGetParams = params(raw)?;
    let log = state.open_log()?;
    // mime/size 在事件里的 BlobRef 上，不在文件系统路径里。这里只按 hash 取回字节。
    let refer = BlobRef {
        content_hash: p.content_hash.clone(),
        size: 0,
        mime: String::new(),
    };
    let bytes = match log.blobs().get(&refer) {
        Ok(bytes) => bytes,
        Err(RunLogError::BlobNotFound(hash)) => {
            return Err(RpcFail {
                code: RPC_NOT_FOUND,
                message: format!("blob not found: {hash}"),
            });
        }
        Err(RunLogError::BadBlobRef(hash)) => {
            return Err(RpcFail {
                code: RPC_INVALID_PARAMS,
                message: format!("malformed blob ref: {hash}"),
            });
        }
        Err(other) => return Err(DaemonError::from(other).into()),
    };
    let text = String::from_utf8(bytes).map_err(|_| RpcFail {
        code: RPC_INTERNAL,
        message: format!("blob {} is not utf-8", p.content_hash),
    })?;
    Ok(serde_json::to_value(BlobGetResult {
        content_hash: p.content_hash,
        size: text.len() as u64,
        text,
    })
    .expect("BlobGetResult 必须可序列化"))
}

fn cost_query(state: &AppState, raw: serde_json::Value) -> Result<serde_json::Value, RpcFail> {
    let p: CostQueryParams = params(raw).unwrap_or(CostQueryParams { run_id: None });
    let log = state.open_log()?;
    let run_ids = match p.run_id {
        Some(id) => vec![id],
        None => log.run_ids().map_err(DaemonError::from)?,
    };
    let mut amount_micros = 0u64;
    let mut entries = 0u64;
    let mut currency = Currency::CNY;
    for run_id in run_ids {
        for event in log.events(&run_id, 0, None).map_err(DaemonError::from)? {
            if let EventBody::CostCharged(CostCharged {
                amount_micros: amt,
                currency: cur,
                ..
            }) = event.body
            {
                amount_micros = amount_micros.saturating_add(amt);
                currency = cur;
                entries += 1;
            }
        }
    }
    Ok(serde_json::to_value(CostQueryResult {
        amount_micros,
        currency,
        entries,
    })
    .expect("CostQueryResult 必须可序列化"))
}

fn tool_list(state: &AppState, _raw: serde_json::Value) -> Result<serde_json::Value, RpcFail> {
    let registry = ManifestRegistry::from_toml_str(&state.tools_toml).map_err(|e| RpcFail {
        code: RPC_INTERNAL,
        message: e.to_string(),
    })?;
    let mut tools: Vec<ToolListItem> = registry
        .iter()
        .map(|m| ToolListItem {
            name: m.name.clone(),
            class: m.class,
            reversible: m.reversible,
        })
        .collect();
    tools.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(serde_json::to_value(ToolListResult { tools }).expect("ToolListResult 必须可序列化"))
}

fn tool_manifest(state: &AppState, raw: serde_json::Value) -> Result<serde_json::Value, RpcFail> {
    let p: ToolManifestParams = params(raw)?;
    let registry = ManifestRegistry::from_toml_str(&state.tools_toml).map_err(|e| RpcFail {
        code: RPC_INTERNAL,
        message: e.to_string(),
    })?;
    let tool = evo_protocol::ToolId::from(p.tool);
    let Some(m) = registry.get(&tool) else {
        return Err(RpcFail {
            code: RPC_NOT_FOUND,
            message: format!("no manifest for {}", tool.as_str()),
        });
    };
    Ok(serde_json::to_value(ToolManifestResult {
        name: m.name.clone(),
        class: m.class,
        reversible: m.reversible,
        preview: m.preview.clone(),
    })
    .expect("ToolManifestResult 必须可序列化"))
}

fn policy_get(state: &AppState, _raw: serde_json::Value) -> Result<serde_json::Value, RpcFail> {
    Ok(serde_json::to_value(PolicyGetResult {
        policy_toml: state.policy_toml.clone(),
    })
    .expect("PolicyGetResult 必须可序列化"))
}

async fn trigger_create(
    state: &AppState,
    raw: serde_json::Value,
) -> Result<serde_json::Value, RpcFail> {
    let p: TriggerCreateParams = params(raw)?;
    if p.name.trim().is_empty() || p.intent.trim().is_empty() {
        return Err(RpcFail {
            code: RPC_INVALID_PARAMS,
            message: "name and intent must be non-empty".into(),
        });
    }
    validate_spec(&p.spec).map_err(|message| RpcFail {
        code: RPC_INVALID_PARAMS,
        message,
    })?;
    let now_ms = state.runtime.lock().await.now_ms();

    let rec = if let Some(id) = p.trigger_id {
        let store = state.lock_triggers()?;
        let mut rec = store
            .get(&id)?
            .ok_or_else(|| DaemonError::UnknownTrigger(id.to_string()))?;
        rec.name = p.name.trim().to_owned();
        rec.intent = p.intent.trim().to_owned();
        let spec_changed = rec.spec != p.spec;
        if spec_changed {
            rec.spec = p.spec;
            rec.next_fire_ms = next_fire_ms(&rec.spec, now_ms);
        }
        if matches!(rec.spec, TriggerSpec::Webhook) {
            if rec.hook_secret.is_none() {
                rec.hook_secret = Some(random_hook_secret()?);
            }
        } else if spec_changed {
            rec.hook_secret = None;
        }
        if let Some(paused) = p.paused {
            rec.paused = paused;
        }
        store.update(&rec)?;
        rec
    } else {
        let hook_secret = match &p.spec {
            TriggerSpec::Webhook => Some(random_hook_secret()?),
            _ => None,
        };
        let rec = TriggerRecord {
            id: state.alloc_trigger_id(),
            name: p.name.trim().to_owned(),
            intent: p.intent.trim().to_owned(),
            spec: p.spec.clone(),
            paused: p.paused.unwrap_or(false),
            hook_secret,
            next_fire_ms: next_fire_ms(&p.spec, now_ms),
            last_run_id: None,
            last_fired_ms: None,
            created_ms: now_ms,
        };
        state.lock_triggers()?.insert(&rec)?;
        rec
    };

    Ok(serde_json::to_value(rec.view()).expect("TriggerView 必须可序列化"))
}

fn trigger_list(state: &AppState, raw: serde_json::Value) -> Result<serde_json::Value, RpcFail> {
    let _: serde_json::Value = params(raw).unwrap_or(serde_json::json!({}));
    let store = state.lock_triggers()?;
    let triggers = store.list()?.into_iter().map(|rec| rec.view()).collect();
    Ok(serde_json::to_value(TriggerListResult { triggers })
        .expect("TriggerListResult 必须可序列化"))
}

fn trigger_delete(state: &AppState, raw: serde_json::Value) -> Result<serde_json::Value, RpcFail> {
    let p: TriggerIdParams = params(raw)?;
    let deleted = state.lock_triggers()?.delete(&p.trigger_id)?;
    if !deleted {
        return Err(DaemonError::UnknownTrigger(p.trigger_id.to_string()).into());
    }
    Ok(serde_json::json!({ "deleted": true }))
}

async fn trigger_dryrun(
    state: &AppState,
    raw: serde_json::Value,
) -> Result<serde_json::Value, RpcFail> {
    let p: TriggerIdParams = params(raw)?;
    let now_ms = state.runtime.lock().await.now_ms();
    let rec = state
        .lock_triggers()?
        .get(&p.trigger_id)?
        .ok_or_else(|| DaemonError::UnknownTrigger(p.trigger_id.to_string()))?;
    let busy = match &rec.last_run_id {
        Some(run_id) => state.last_run_active(run_id)?,
        None => false,
    };
    let due = rec.next_fire_ms.is_some_and(|t| t <= now_ms) || rec.kind() == TriggerKind::Webhook;
    let would_fire_now = !rec.paused && !busy && due;
    Ok(serde_json::to_value(TriggerDryrunResult {
        trigger_id: rec.id,
        would_fire_now,
        next_fire_ms: rec.next_fire_ms,
        intent: rec.intent,
        paused: rec.paused,
    })
    .expect("TriggerDryrunResult 必须可序列化"))
}

async fn webhook_fire(
    State(state): State<AppState>,
    Path(secret): Path<String>,
) -> Result<Json<RunCreateResult>, (StatusCode, Json<serde_json::Value>)> {
    if secret.is_empty() {
        return Err((
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "error": "not found" })),
        ));
    }
    let trigger_id = {
        let store = state.lock_triggers().map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({ "error": e.to_string() })),
            )
        })?;
        match store.get_by_secret(&secret) {
            Ok(Some(rec)) => rec.id,
            Ok(None) => {
                return Err((
                    StatusCode::NOT_FOUND,
                    Json(serde_json::json!({ "error": "not found" })),
                ));
            }
            Err(e) => {
                return Err((
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(serde_json::json!({ "error": e.to_string() })),
                ));
            }
        }
    };
    let now_ms = state.runtime.lock().await.now_ms();
    match state.fire_record(trigger_id, now_ms).await {
        Ok(result) => Ok(Json(result)),
        Err(DaemonError::UnknownTrigger(_)) => Err((
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "error": "not found" })),
        )),
        Err(DaemonError::TriggerPaused(_) | DaemonError::TriggerBusy(_)) => Err((
            StatusCode::CONFLICT,
            Json(serde_json::json!({ "error": "unavailable" })),
        )),
        Err(e) => Err((
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": e.to_string() })),
        )),
    }
}
