use crate::clock::Clock;
use crate::config::DaemonConfig;
use crate::replay::replay_to;
use evo_context::{AnsweredClarification, Assembler, ToolOutput};
use evo_exec::{CapabilityToken, DispatchedEffect, EgressPolicy, Executor, Lease, WorkspaceHandle};
use evo_exec_local::WorkspaceRoot;
use evo_gateway::{AdmitRequest, Gateway, GatewayAction, ManifestRegistry};
use evo_kernel::{
    AwaitReason, Command, EffectState, RunState, RunStatus, decide, reduce, state_hash,
};
use evo_model::{Message, ModelAdapter, ModelRequest, PriceTable, request_digest};
use evo_policy::HardcodedPolicy;
use evo_protocol::events::accounting::{
    BudgetAmended, Checkpoint, CheckpointReason, CostCharged, CostDimension, CostUnit,
};
use evo_protocol::events::approval::{
    ApprovalDenied, ApprovalGranted, ApprovalRequested, ApprovalVia,
};
use evo_protocol::events::artifact::ArtifactEmitted;
use evo_protocol::events::clarification::{
    ClarificationAnswered, ClarificationOption, ClarificationRequested,
};
use evo_protocol::events::determinism::{EnvSampled, ModelRoute};
use evo_protocol::events::effect::{
    EffectDispatched, ExecutionMode, ToolRequested, ToolResult, ToolResultStatus,
};
use evo_protocol::events::lifecycle::{
    CompletionStatus, ErrorDetail, IntentDeclared, PrincipalRef, RunCompleted, RunCreated,
    RunFailed, RunResumed, RunSuspended, SuspendReason, TriggerKind, TriggerRef,
};
use evo_protocol::events::model::{
    ModelParams, ModelRequested, ModelResponded, PlanIntent, PlanStep, PlannedCall,
    PlannedClarification,
};
use evo_protocol::taint::TaintLevel;
use evo_protocol::{
    Actor, ApprovalId, ArtifactId, BlobClass, BlobRef, BudgetSpec, CheckpointId, EffectClass,
    EffectId, EffectRequest, Event, EventBody, LeaseId, RunId, ToolId,
};
use evo_runlog::RunLog;
use std::collections::BTreeMap;
use std::sync::Arc;

#[derive(Debug, thiserror::Error)]
pub enum DaemonError {
    #[error("runlog: {0}")]
    RunLog(#[from] evo_runlog::RunLogError),
    #[error("model: {0}")]
    Model(#[from] evo_model::ModelError),
    #[error("policy: {0}")]
    Policy(#[from] evo_policy::PolicyError),
    #[error("manifest: {0}")]
    Manifest(#[from] evo_gateway::ManifestError),
    #[error("exec: {0}")]
    Exec(#[from] evo_exec::ExecError),
    #[error("model output is not a plan: {0}")]
    UnparseablePlan(String),
    #[error("turn limit exceeded: {0}")]
    TurnLimit(u32),
    #[error("turn loop made {0} iterations without a turn ever terminating it")]
    LoopIterationLimit(u32),
    /// 只作为 `run.failed` 的正文来源存在：turn 循环停在了 Running 上，
    /// 因为 Log 里留着一批不会有人再去推的 effect（上一次进程被杀的残局）。
    /// 它不会作为 `Err` 冒泡——正是本轮修掉的那种行为。
    #[error(
        "turn loop stopped while the run was still Running:          these effects will never reach a terminal state on their own: {0}"
    )]
    StalledEffects(String),
    #[error("snapshot is undecodable at seq {seq}: {detail}")]
    SnapshotDecode { seq: u64, detail: String },
    #[error("model {provider}/{model} is not in the price table")]
    ModelNotPriced { provider: String, model: String },
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("case.yaml: {0}")]
    CaseFormat(String),
    #[error("approval {0} is not currently pending (already resolved, or never requested)")]
    UnknownApproval(String),
    #[error("question {0} is not currently pending (already answered, or never asked)")]
    UnknownClarification(String),
    #[error("option {option_id} is not one of the options for question {question_id}")]
    UnknownClarificationOption {
        question_id: String,
        option_id: String,
    },
}

/// 一个 `clarify` 计划里的一个选项，解析自模型输出的 JSON——**不是**
/// `evo_protocol::events::clarification::ClarificationOption`：那个类型
/// 特意不带 `label`（见它的文档注释），选项文案只能活在这里，活在
/// runtime 解析出来、随即被塞进 blob 的这一步，绝不允许流进任何事件
/// payload。
#[derive(Clone, Debug, PartialEq)]
pub struct ParsedClarifyOption {
    pub id: String,
    pub label: String,
    pub is_default: bool,
}

/// runtime 从模型输出里解析出的结构化决策。
///
/// **解析在这里，不在内核（Q-12）**：它是最容易引入非确定性
/// （正则、时间、随机重试）的地方，关在内核外面，内核的确定性好守得多。
///
/// `question`/`options` 只在 `intent == Clarify` 时有意义。`parse_plan`
/// 只在 `call_model` 里被调用这一次：解析结果里的 `question`/`options`
/// 随即被落进一个 blob，随 `PlanStep.clarification`（对称于 `call`）一并
/// 写进 Log；`decide` 把那份 `PlannedClarification` 原样放进
/// `Command::AskClarification`，runtime 执行时读 Command 载荷，不再从
/// `last_plan` 另读一遍、也不对模型原文重新解析。
#[derive(Clone, Debug, PartialEq)]
pub struct ParsedPlan {
    pub intent: PlanIntent,
    pub tool: Option<String>,
    pub params: serde_json::Value,
    pub question: Option<String>,
    pub options: Vec<ParsedClarifyOption>,
}

pub fn parse_plan(text: &str) -> Result<ParsedPlan, DaemonError> {
    let v: serde_json::Value = serde_json::from_str(text)
        .map_err(|_| DaemonError::UnparseablePlan(text.chars().take(60).collect()))?;
    let intent = match v.get("intent").and_then(|i| i.as_str()) {
        Some("tool_call") => PlanIntent::ToolCall,
        Some("clarify") => PlanIntent::Clarify,
        Some("finish") => PlanIntent::Finish,
        _ => {
            return Err(DaemonError::UnparseablePlan(
                text.chars().take(60).collect(),
            ));
        }
    };
    let question = v
        .get("question")
        .and_then(|q| q.as_str())
        .map(str::to_owned);
    let options = v
        .get("options")
        .and_then(|o| o.as_array())
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    let id = item.get("id")?.as_str()?.to_owned();
                    let label = item.get("label")?.as_str()?.to_owned();
                    let is_default = item
                        .get("is_default")
                        .and_then(|d| d.as_bool())
                        .unwrap_or(false);
                    Some(ParsedClarifyOption {
                        id,
                        label,
                        is_default,
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    Ok(ParsedPlan {
        intent,
        tool: v.get("tool").and_then(|t| t.as_str()).map(str::to_owned),
        params: v.get("params").cloned().unwrap_or(serde_json::json!({})),
        question,
        options,
    })
}

/// 单 run 最多跑多少 turn。防的是 fixture 或模型让循环停不下来。
const MAX_TURNS: u32 = 64;

/// 循环体最多转多少圈，与 `state.turn` 是否推进无关。
///
/// `MAX_TURNS` 这道保险挂在 `state.turn` 上：今天 `decide` 要么推进 turn
/// 要么终止 run，两者必居其一，所以够用。但挂起/恢复、dry-run 早返回这类
/// 「返回命令但不推进 turn」的序列会让只看 `state.turn` 的保险形同虚设：
/// turn 不动，`state.turn > MAX_TURNS` 永远不成立。这里独立计一次「循环体
/// 转了几圈」，与 turn 绑不绑得上无关，兜住这类序列。
const MAX_LOOP_ITERATIONS: u32 = 10_000;

/// 审批有效期。**起点是 `state.clock_ms`（来自本 run 最近一次
/// `env.sampled.wall_clock_ms`），不是 daemon 自己读的挂钟时间**——
/// 内核与执行面都不许自己读时钟（05 节），`ApprovalRequested.expires_at_ms`
/// 的文档注释把这条红线写得很清楚：起点必须是 Log 里已经落盘的值，否则
/// 同一条 Log 在两次回放里算出的过期判定可能不一致。
const APPROVAL_TTL_MS: u64 = 24 * 60 * 60 * 1000;

/// [`Runtime::start`] / [`Runtime::resume`] / [`Runtime::decide_approval`] /
/// [`Runtime::answer_clarification`] 的统一产出。
///
/// 挂起（`Suspended`）与失败（`Failed`）都是**正常返回值，不是 `Err`**——
/// 这是本任务（M2 Task 3）的核心反转。`Err` 只留给真正的故障：IO 失败、
/// 模型输出解析不出来、定价表查不到……「人还没批」不是故障。
#[derive(Clone, Debug)]
pub enum RunOutcome {
    Completed(RunState),
    Suspended {
        state: RunState,
        reason: AwaitReason,
    },
    Failed {
        state: RunState,
        error: String,
    },
}

impl RunOutcome {
    /// 不管落在哪个变体，都要看最终状态时用——`RunState` 三个变体里都带着。
    pub fn into_state(self) -> RunState {
        match self {
            RunOutcome::Completed(state) => state,
            RunOutcome::Suspended { state, .. } => state,
            RunOutcome::Failed { state, .. } => state,
        }
    }
}

pub struct Runtime {
    config: DaemonConfig,
    clock: Arc<dyn Clock>,
    model: Arc<dyn ModelAdapter>,
    executor: Arc<dyn Executor>,
    log: RunLog,
    gateway: Gateway,
    assembler: Assembler,
    pricing: PriceTable,
    workspaces: WorkspaceRoot,
    /// HTTP/WS 层订阅的事件广播。没有订阅者时 `send` 只是 no-op（bounded
    /// broadcast 在零接收者时返回 Err，这里故意忽略）。
    event_tx: Option<tokio::sync::broadcast::Sender<Event>>,
}

impl Runtime {
    pub fn new(
        config: DaemonConfig,
        clock: Arc<dyn Clock>,
        model: Arc<dyn ModelAdapter>,
        executor: Arc<dyn Executor>,
    ) -> Result<Self, DaemonError> {
        let log = RunLog::open(&config.db_path, &config.blob_root)?;
        let gateway = Gateway::new(
            Box::new(HardcodedPolicy::from_toml_str(&config.policy_toml)?),
            ManifestRegistry::from_toml_str(&config.tools_toml)?,
        );
        let pricing = PriceTable::from_toml_str(&config.pricing_toml)?;
        let assembler = Assembler::new(&config.context_profile);
        let workspaces = WorkspaceRoot::new(config.workspace_root.clone());
        Ok(Self {
            config,
            clock,
            model,
            executor,
            log,
            gateway,
            assembler,
            pricing,
            workspaces,
            event_tx: None,
        })
    }

    /// 接上 HTTP/WS 层的事件广播。必须在任何 `start` / `resume` 之前调用。
    pub fn with_event_sink(mut self, tx: tokio::sync::broadcast::Sender<Event>) -> Self {
        self.event_tx = Some(tx);
        self
    }

    pub fn config(&self) -> &DaemonConfig {
        &self.config
    }

    pub fn events(
        &self,
        run_id: &RunId,
        from_seq: u64,
        to_seq: Option<u64>,
    ) -> Result<Vec<Event>, DaemonError> {
        Ok(self.log.events(run_id, from_seq, to_seq)?)
    }

    pub fn run_ids(&self) -> Result<Vec<RunId>, DaemonError> {
        Ok(self.log.run_ids()?)
    }

    pub fn last_seq(&self, run_id: &RunId) -> Result<Option<u64>, DaemonError> {
        Ok(self.log.last_seq(run_id)?)
    }

    /// 唯一写 Run Log 的地方。写完立刻 reduce——state 永远是 Log 的折叠结果。
    fn emit(
        &mut self,
        state: &RunState,
        actor: Actor,
        body: EventBody,
    ) -> Result<RunState, DaemonError> {
        let recorded_at = self.clock.now_rfc3339();
        let event = self.log.append(&state.run_id, actor, &recorded_at, body)?;
        if let Some(tx) = &self.event_tx {
            let _ = tx.send(event.clone());
        }
        Ok(reduce(state, &event))
    }

    /// 起一条新 run：建 state、发 `run.created` + `intent.declared`，然后驱动到停。
    ///
    /// `source` 同时写入 `run.created.trigger.reference` 与 `intent.declared.source`。
    /// CLI 与 HTTP 入口走同一个函数，只是 source 不同——不要为此再开一条写 Log 的路径。
    pub async fn start(
        &mut self,
        run_id: &RunId,
        intent_text: &str,
    ) -> Result<RunOutcome, DaemonError> {
        self.start_from(run_id, intent_text, "cli").await
    }

    pub async fn start_from(
        &mut self,
        run_id: &RunId,
        intent_text: &str,
        source: &str,
    ) -> Result<RunOutcome, DaemonError> {
        let state = RunState::new(run_id);

        let state = self.emit(
            &state,
            Actor::Runtime,
            EventBody::RunCreated(RunCreated {
                run_id: run_id.clone(),
                parent_run_id: None,
                workspace_id: run_id.as_str().to_owned(),
                principal: PrincipalRef {
                    kind: "user".into(),
                    id: self.config.principal.clone(),
                },
                trigger: TriggerRef {
                    kind: TriggerKind::Manual,
                    reference: source.into(),
                },
                budget: self.config.budget,
                labels: Default::default(),
            }),
        )?;

        // 意图原文进 blob，事件里只留引用与长度（01 §3）
        let intent_ref =
            self.log
                .blobs()
                .put(BlobClass::Content, "text/plain", intent_text.as_bytes())?;
        let state = self.emit(
            &state,
            Actor::Runtime,
            EventBody::IntentDeclared(IntentDeclared {
                intent_ref: intent_ref.clone(),
                char_len: intent_text.chars().count() as u64,
                lang: "zh".to_owned(),
                source: source.to_owned(),
            }),
        )?;

        self.drive(state).await
    }

    /// 从 Log 恢复一条已存在的 run，继续驱动到停。
    ///
    /// 意图从 `state.intent` 指向的 blob 取，不从参数取——这个方法的签名
    /// 里根本没有 `intent_text`，恢复本来就不该需要它。
    ///
    /// 恢复之后先补一件事：**已经批准、但还没真正派发的 effect**。
    /// `decide()` 在 effect 停留在 `Requested` 时只会等待，不会重新规划
    /// （见 evo-kernel 的 `approval_granted_then_resumed_lets_the_run_continue`
    /// 测试），真正把它派发出去是 daemon 的责任，而且这份责任必须落在
    /// `resume` 这个唯一的恢复入口上，不能只塞进 `decide_approval` 里——
    /// 否则「谁触发的派发」会分叉成两条路径，而 `decide_approval` 之外
    /// 也可能有人直接调 `resume`（比如这条测试）。
    ///
    /// 先发 `run.resumed` 再补派发，不是反过来：`run.resumed` 标志着这条
    /// run 重新变回 `Running`，之后发生的 checkpoint/派发/结算都应该发生
    /// 在「正在跑」的状态下，而不是让它们记录在状态字段仍是 `Suspended`
    /// 的那一小段窗口里——两种顺序在 `reduce()` 折叠出的最终状态上等价，
    /// 但前者读起来更像一个正常的因果链条。
    pub async fn resume(&mut self, run_id: &RunId) -> Result<RunOutcome, DaemonError> {
        let state = replay_to(&self.log, run_id, None, true)?;

        // 拦住一种推不动任何事情的恢复：这条 run 挂在「等审批」上，而那条
        // 审批**仍然未决**（没人批、也没人驳）。此前这里照样先落一条
        // `run.resumed`，run 变回 Running、awaiting 被清空，然后 `decide`
        // 因为那个 effect 还停在非终态返回空命令，循环立刻 break，落到
        // `drive` 的 `RunStatus::Running` 分支——调用方（UI/CLI）被告知
        // 「完成」，而 Log 最后一条是 `run.resumed`（M2 终审 BL-7）。
        //
        // 正确的答案是「什么都没发生」：恢复的前提是那个挡路的东西被解决
        // 了，没解决就不该往 Log 里写一条骗人的 `run.resumed`。审批一旦被
        // 批准或驳回，`reduce` 就把它从 `pending_approvals` 里销掉，这个
        // 条件自然不再成立，`decide_approval` 转发过来的 resume 照常往下走。
        //
        // 只拦审批这一种：澄清的裸 resume 有既有的、被测试固定的行为
        // （重新问一次，随即再次挂起——那条路径自己会落 run.suspended，
        // 不会撞上 Running 分支），不在本次修复范围内。
        //
        // 未决台账是真源，不是 `awaiting` 里那一个代表 id。多条审批并列时
        // `awaiting` 只指向其中一条；只拦那一条会让「批了代表、另一条还
        // 没人看」也写出一条骗人的 `run.resumed`。
        if !state.pending_approvals.is_empty() {
            let reason = state.awaiting.clone().unwrap_or_else(|| {
                let (approval_id, effect_id) = state
                    .pending_approvals
                    .iter()
                    .next()
                    .map(|(a, e)| (a.clone(), e.clone()))
                    .expect("刚判断过 pending_approvals 非空");
                AwaitReason::Approval {
                    approval_id,
                    effect_id,
                }
            });
            return Ok(RunOutcome::Suspended { state, reason });
        }

        let from_seq = state.last_seq + 1;
        let mut state = self.emit(
            &state,
            Actor::Runtime,
            EventBody::RunResumed(RunResumed {
                by: Actor::Runtime,
                from_seq,
            }),
        )?;

        // 「已批准但还没派发」= pending_effects 里是 `EffectState::Approved`。
        // 这是一条**正向**判定：只有真的落过一条 `approval.granted`
        // （`reduce` 据此把 effect 从 `Requested` 改写成 `Approved`）的
        // effect 才会被补派。
        //
        // 此前这里判的是反向条件「还是 Requested，且不在 pending_approvals
        // 里」，那是 BL-1 的根：任何让 effect 停在 `Requested` 的路径都会被
        // 误当成已批准——被 Gateway 直接拒掉的 effect（那条路径现在会写
        // `tool.result{Denied}`，但即使不写，正向判定也不会派发它），以及
        // `tool.requested` 落盘后、`approval.requested` 落盘前进程被杀留下的
        // 孤儿 effect（谁也没批过，反向判定却照样派发）。
        let approved_but_undispatched: Vec<EffectId> = state
            .pending_effects
            .iter()
            .filter(|(_, st)| **st == EffectState::Approved)
            .map(|(id, _)| id.clone())
            .collect();
        for effect_id in approved_but_undispatched {
            let tool_requested = self.find_tool_requested(run_id, &effect_id)?.expect(
                "pending_effects 里的每个 effect_id 必有一条对应的 tool.requested——\
                 Gateway 的 admit() 管线在判定动作之前一定先写这条事件",
            );
            let request = self.rebuild_effect_request(&state, tool_requested);
            state = self.dispatch_effect(state, effect_id, request).await?;
        }

        self.drive(state).await
    }

    /// 人做出审批决定：往 Log 追加 `approval.granted` / `approval.denied`，然后 resume。
    ///
    /// 真正把批准之后的 effect 派发出去的逻辑不在这里——见 [`Runtime::resume`]
    /// 顶部的说明。这里只管把人的决定记进 Log。
    pub async fn decide_approval(
        &mut self,
        run_id: &RunId,
        approval_id: &ApprovalId,
        granted: bool,
        by: Actor,
        note: Option<&str>,
    ) -> Result<RunOutcome, DaemonError> {
        let state = replay_to(&self.log, run_id, None, true)?;
        if !state.pending_approvals.contains_key(approval_id) {
            return Err(DaemonError::UnknownApproval(
                approval_id.as_str().to_owned(),
            ));
        }
        let note_ref = note
            .map(|n| {
                self.log
                    .blobs()
                    .put(BlobClass::Content, "text/plain", n.as_bytes())
            })
            .transpose()?;

        if granted {
            self.emit(
                &state,
                by.clone(),
                EventBody::ApprovalGranted(ApprovalGranted {
                    approval_id: approval_id.clone(),
                    by,
                    via: ApprovalVia::Ui,
                    note_ref,
                }),
            )?;
        } else {
            self.emit(
                &state,
                by.clone(),
                EventBody::ApprovalDenied(ApprovalDenied {
                    approval_id: approval_id.clone(),
                    by,
                    reason_ref: note_ref,
                }),
            )?;
        }

        self.resume(run_id).await
    }

    /// 人回答澄清：追加 `clarification.answered`，然后 resume。
    pub async fn answer_clarification(
        &mut self,
        run_id: &RunId,
        question_id: &str,
        option_id: Option<&str>,
        free_text: Option<&str>,
        by: Actor,
    ) -> Result<RunOutcome, DaemonError> {
        let state = replay_to(&self.log, run_id, None, true)?;
        if state.pending_question.as_deref() != Some(question_id) {
            return Err(DaemonError::UnknownClarification(question_id.to_owned()));
        }
        if let Some(option_id) = option_id {
            let requested = self
                .find_clarification_requested(run_id, question_id)?
                .ok_or_else(|| DaemonError::UnknownClarification(question_id.to_owned()))?;
            if !requested.options.iter().any(|o| o.id == option_id) {
                return Err(DaemonError::UnknownClarificationOption {
                    question_id: question_id.to_owned(),
                    option_id: option_id.to_owned(),
                });
            }
        }
        let free_text_ref = free_text
            .map(|t| {
                self.log
                    .blobs()
                    .put(BlobClass::Content, "text/plain", t.as_bytes())
            })
            .transpose()?;

        self.emit(
            &state,
            by.clone(),
            EventBody::ClarificationAnswered(ClarificationAnswered {
                question_id: question_id.to_owned(),
                by,
                option_id: option_id.map(str::to_owned),
                free_text_ref,
            }),
        )?;

        self.resume(run_id).await
    }

    /// 人改一条**已经在跑**（或已经挂起）的 run 的额度：往 Log 追加一条
    /// `budget.amended`，如果这条 run 正挂在预算上就顺手把它续起来。
    ///
    /// **这是「人提额后续跑」唯一的落点。** 在这个方法存在之前，
    /// `RunState::budget` 除了 `run.created` 没有任何写入方——提额只能靠
    /// 调用方绕过 Log 直接改内存里的状态字段，而那样的状态**在 Log 上
    /// 推不出来**：回放同一条 Log 得到的额度还是原来那个，
    /// `budget_exhausted` 仍然为真，`decide` 立刻再产出一次 `Suspend`。
    /// 「状态里有 Log 里推不出来的东西」正是判据 3 要挡的那类问题
    /// （`evo-kernel/tests/suspend_resume.rs` 里那条测试就曾经这么写，
    /// 于是它「证明」了一件在真实链路上根本不成立的事）。
    ///
    /// 与 [`Runtime::decide_approval`] 同构：先把人的决定记进 Log，再
    /// `resume`。差别在于**只有真的挂在预算上的 run 才续跑**——一条挂在
    /// 等审批上的 run，提额并不解除它的挂起理由，这时候写一条
    /// `run.resumed` 就是在骗人（与 `resume` 顶部拦住「审批仍未决却恢复」
    /// 是同一条道理，M2 终审 BL-7）。额度照记，恢复留给那个原因自己。
    pub async fn amend_budget(
        &mut self,
        run_id: &RunId,
        budget: BudgetSpec,
        by: Actor,
        reason: Option<&str>,
    ) -> Result<RunOutcome, DaemonError> {
        let state = replay_to(&self.log, run_id, None, true)?;
        // 提额理由是人写的自由文本，进 blob，不进 payload（红线①）。
        let reason_ref = reason
            .map(|r| {
                self.log
                    .blobs()
                    .put(BlobClass::Content, "text/plain", r.as_bytes())
            })
            .transpose()?;
        let state = self.emit(
            &state,
            by.clone(),
            EventBody::BudgetAmended(BudgetAmended {
                budget,
                by,
                reason_ref,
            }),
        )?;

        if state.awaiting == Some(AwaitReason::Budget) {
            return self.resume(run_id).await;
        }
        Ok(match (state.status, state.awaiting.clone()) {
            (RunStatus::Suspended, Some(reason)) => RunOutcome::Suspended { state, reason },
            (RunStatus::Completed, _) => RunOutcome::Completed(state),
            (RunStatus::Failed, _) => {
                let error = self.failure_message(&state)?;
                RunOutcome::Failed { state, error }
            }
            // 还在跑（或者 Suspended 却没有 awaiting——`reduce` 的不变量说
            // 这不可能，真出现了也该由 drive 的收尾逻辑如实报出来，而不是
            // 在这里猜一个结局）：不写 `run.resumed`，它从来没挂起过，
            // 直接接着驱动。
            _ => return self.drive(state).await,
        })
    }

    /// 唯一的驱动循环。[`Runtime::start`] 与 [`Runtime::resume`]
    /// （连同经它转发的 [`Runtime::decide_approval`] /
    /// [`Runtime::answer_clarification`]）都收敛到这一个函数——它们的差别
    /// 只在「循环之前怎么拿到 state」，循环本身只有这一份实现。
    ///
    /// 挂起路径上不许有 `Err`：Gateway/内核判定的每一种「先别继续」都被
    /// 翻译成一条 Log 事件（`run.suspended`/`run.failed` 及其配套事件），
    /// `reduce` 据此改变 `state.status`，下一轮 `decide()` 自然返回空，
    /// 循环干净结束——不需要提前 `return`，也不需要抛错误短路。
    async fn drive(&mut self, mut state: RunState) -> Result<RunOutcome, DaemonError> {
        let mut iterations: u32 = 0;
        loop {
            iterations += 1;
            // 两道保险撞上了同样是故障，同样要落成 run.failed：一条撞了
            // 上限就被 `Err` 掀翻的 run，在 Log 里看不出任何结局。
            if iterations > MAX_LOOP_ITERATIONS {
                let state = self.fail_run(
                    state,
                    "loop_iteration_limit",
                    &DaemonError::LoopIterationLimit(MAX_LOOP_ITERATIONS),
                )?;
                let error = self.failure_message(&state)?;
                return Ok(RunOutcome::Failed { state, error });
            }
            if state.turn > MAX_TURNS {
                let state =
                    self.fail_run(state, "turn_limit", &DaemonError::TurnLimit(MAX_TURNS))?;
                let error = self.failure_message(&state)?;
                return Ok(RunOutcome::Failed { state, error });
            }
            let commands = decide(&state);
            if commands.is_empty() {
                break;
            }
            for cmd in commands {
                state = self.execute_command(state, cmd).await?;
            }
        }

        Ok(match state.status {
            RunStatus::Suspended => {
                // 畸形 Log（`run.suspended{AwaitingApproval}` 却没有任何
                // `approval.requested`）时 `reduce` 不再 panic，`awaiting`
                // 可能是 None。decide 看到 Suspended 本来就会返回空，这里
                // 也不该为了凑一个审批 id 再 panic 一次。
                let reason = state
                    .awaiting
                    .clone()
                    .unwrap_or(AwaitReason::ExternalEvent {
                        kind: "suspended_without_await_reason".to_owned(),
                    });
                RunOutcome::Suspended { state, reason }
            }
            RunStatus::Failed => {
                let error = self.failure_message(&state)?;
                RunOutcome::Failed { state, error }
            }
            RunStatus::Completed => RunOutcome::Completed(state),
            RunStatus::Running => {
                // decide() 只有在「还有 effect 没跑到终态」时才会在 status 仍是
                // Running 的情况下返回空命令。单次 drive() 内部撞不上这种中间
                // 态——每个 effect 的生命周期都在 dispatch_effect 里同步跑完
                // （checkpoint → lease → execute → tool.result 一次写完）——
                // 但**跨进程**撞得上：Log 里可能留着上一次进程被杀时的残局，
                // 一个停在 Requested（`tool.requested` 落盘后就被杀，没人批过
                // 它、`resume` 也不会补派）或停在 Dispatched（执行中途被杀）
                // 的 effect，谁也不会再把它推向终态。
                //
                // 此前这里是 `debug_assert!(false)` + 按「完成」兜底：debug 构建
                // panic，release 构建把一条没有任何终结事件的 run 报成 Completed
                // （M2 终审 BL-7）。现在落一条 `run.failed`——这既是唯一诚实的
                // 结局（这条 run 真的推不动了），也是唯一可用的终结事件：
                // `run.suspended` 需要一个 `SuspendReason`，而没有任何一个能
                // 如实描述「卡在一个没人会去推的 effect 上」——`AwaitingApproval`
                // 会让 UI 以为在等一条并不存在的审批，`Paused` 则会被读成
                // 「有人手动暂停了」。
                let stalled: Vec<String> = state
                    .pending_effects
                    .iter()
                    .filter(|(_, st)| !st.is_resolved())
                    .map(|(id, _)| id.as_str().to_owned())
                    .collect();
                let state = self.fail_run(
                    state,
                    "stalled_unresolved_effects",
                    &DaemonError::StalledEffects(format!("{stalled:?}")),
                )?;
                let error = self.failure_message(&state)?;
                RunOutcome::Failed { state, error }
            }
        })
    }

    /// 把一个**真正的故障**落成一条 `run.failed`，而不是让 `Err` 冒泡。
    ///
    /// `evo_protocol` 里 `RunFailed` 的文档写的就是这件事：「真正的故障
    /// （IO 失败、模型解析不出来、预算表查不到……）落到这里成为一条 Log
    /// 事件，而不是掀翻调用栈、把 run 晾在没有终结事件的状态里」。此前
    /// 全仓唯一写 `RunFailed` 的地方是 Gateway 的 Deny 分支，别的故障路径
    /// 一律 `Err` 冒泡：Log 最后一条停在 `cost.charged`，status 折叠出来
    /// 还是 Running，这条 run 的结局只存在于调用方的错误字符串里，不在
    /// 唯一权威事实里（M2 终审 BL-8）。
    ///
    /// `code` 是稳定的错误分类，进 payload；错误正文进 blob（红线 4），
    /// 事件里只留 `message_ref`。正文一律取对应 [`DaemonError`] 的
    /// `Display`，好让「这条 run 为什么失败」在 Log 里和在错误类型里是
    /// 同一句话。
    ///
    /// 落完这条事件，`reduce` 把 status 置为 `Failed`，下一轮 `decide`
    /// 自然返回空命令，`drive` 的循环干净结束——与挂起路径同一套机制。
    fn fail_run(
        &mut self,
        state: RunState,
        code: &str,
        detail: &DaemonError,
    ) -> Result<RunState, DaemonError> {
        let message_ref = self.log.blobs().put(
            BlobClass::Content,
            "text/plain",
            detail.to_string().as_bytes(),
        )?;
        self.emit(
            &state,
            Actor::Runtime,
            EventBody::RunFailed(RunFailed {
                at_seq: state.last_seq,
                error: ErrorDetail {
                    code: code.to_owned(),
                    message_ref: Some(message_ref),
                    retryable: false,
                },
            }),
        )
    }

    /// `state.status` 变成 `Failed` 的那条终结事件里带的错误信息。
    ///
    /// `Failed` 有两个独立的落点：`run.failed`（本任务新增，Gateway 拒绝、
    /// 真正的故障）与 `run.completed{status: failed}`（既有行为，模型说
    /// 要调工具却没给出合法 call）。两者都要能讲出「为什么」。
    fn failure_message(&self, state: &RunState) -> Result<String, DaemonError> {
        let last = self
            .log
            .events(&state.run_id, state.last_seq, Some(state.last_seq))?
            .into_iter()
            .next();
        Ok(match last.map(|e| e.body) {
            Some(EventBody::RunFailed(rf)) => rf.error.code,
            Some(EventBody::RunCompleted(rc)) if rc.status == CompletionStatus::Failed => {
                "plan called for a tool but runtime could not parse a valid call".to_owned()
            }
            other => format!(
                "run status is Failed but its terminal event doesn't explain why: {other:?}"
            ),
        })
    }

    /// 在 Log 里找到某个 effect 的 `tool.requested`——重建 `EffectRequest`
    /// 唯一的信息来源（`resume` 补派已批准的 effect时用得上）。
    fn find_tool_requested(
        &self,
        run_id: &RunId,
        effect_id: &EffectId,
    ) -> Result<Option<ToolRequested>, DaemonError> {
        for event in self.log.events(run_id, 0, None)? {
            if let EventBody::ToolRequested(tr) = event.body
                && &tr.effect_id == effect_id
            {
                return Ok(Some(tr));
            }
        }
        Ok(None)
    }

    fn find_clarification_requested(
        &self,
        run_id: &RunId,
        question_id: &str,
    ) -> Result<Option<ClarificationRequested>, DaemonError> {
        for event in self.log.events(run_id, 0, None)? {
            if let EventBody::ClarificationRequested(c) = event.body
                && c.question_id == question_id
            {
                return Ok(Some(c));
            }
        }
        Ok(None)
    }

    /// 模型请求的 messages：与装配器同一批来源、同一顺序。
    ///
    /// 1. intent 原文
    /// 2. 已回答澄清的摘要（`answer_blobs_for`）
    /// 3. 有内容回流的工具返回，标上工具名
    ///
    /// 不另造 system prompt。来源都空时才退回一条空的 user 消息——适配器
    /// 至少要有一条，但生产路径上 `intent.declared` 已经写过。
    fn model_messages(&self, state: &RunState) -> Result<Vec<Message>, DaemonError> {
        let mut messages = Vec::new();
        if let Some(intent_ref) = &state.intent {
            let text = String::from_utf8(self.log.blobs().get(intent_ref)?)
                .expect("intent blob 是 runtime 自己用 UTF-8 写入的原文，不应解码失败");
            messages.push(Message {
                role: "user".into(),
                content: text,
            });
        }
        for (_, summary) in self.answer_blobs_for(&state.run_id)? {
            messages.push(Message {
                role: "user".into(),
                content: summary,
            });
        }
        for (tool, _, text) in self.tool_output_blobs_for(&state.run_id)? {
            messages.push(Message {
                role: "user".into(),
                content: format!("[{tool}]\n{text}"),
            });
        }
        if messages.is_empty() {
            messages.push(Message {
                role: "user".into(),
                content: String::new(),
            });
        }
        Ok(messages)
    }

    /// 把这条 run 里迄今**已回答**的每一条澄清，拼成一个 (答案 blob 引用,
    /// 答案纯文本) 的列表，供 `AssembleContext` 传给 `Assembler`。
    ///
    /// 每一项都是"daemon 读 blob、拼文本、再写一个新 blob"：
    /// 1. 从 `clarification.requested` 的 `prompt_ref` 里取回问题正文与
    ///    全部选项文案（`ClarificationRequested::prompt_ref` 建议的
    ///    `{"question":..,"options":{id:label}}` 形状）；
    /// 2. 用 `clarification.answered` 的 `option_id` 查出被选中那项的
    ///    文案，`free_text_ref`（如果有）另外取一遍原文；
    /// 3. 把这些拼成一段人类可读的文本，写成一个新 blob——这个新 blob
    ///    才是 `AnsweredClarification::answer_ref` 真正引用的对象。
    ///
    /// 新开一个 blob 而不是直接复用 `prompt_ref`/`free_text_ref` 之一，
    /// 是因为"选中了哪一项"这件事本身不活在任何一个既有 blob 里
    /// （`prompt_ref` 里所有选项的文案都在，唯独不知道选的是哪个）——
    /// 拼出的这段文本才是这条已回答澄清的完整、可独立引用的内容。这个
    /// blob store 是内容寻址的（`BlobStore::put`），同一次回答在多个 turn
    /// 里被反复装配进上下文，只会落一份文件，不是每次都新增。
    fn answer_blobs_for(&self, run_id: &RunId) -> Result<Vec<(BlobRef, String)>, DaemonError> {
        let mut requested: BTreeMap<String, ClarificationRequested> = BTreeMap::new();
        let mut resolved: Vec<(ClarificationRequested, ClarificationAnswered)> = Vec::new();
        for event in self.log.events(run_id, 0, None)? {
            match event.body {
                EventBody::ClarificationRequested(e) => {
                    requested.insert(e.question_id.clone(), e);
                }
                EventBody::ClarificationAnswered(a) => {
                    if let Some(req) = requested.get(&a.question_id) {
                        resolved.push((req.clone(), a));
                    }
                }
                _ => {}
            }
        }

        let mut out = Vec::with_capacity(resolved.len());
        for (req, ans) in resolved {
            let prompt: serde_json::Value =
                serde_json::from_slice(&self.log.blobs().get(&req.prompt_ref)?)
                    .unwrap_or(serde_json::json!({}));
            let question = prompt
                .get("question")
                .and_then(|q| q.as_str())
                .unwrap_or_default();
            let chosen_label = ans.option_id.as_ref().and_then(|id| {
                prompt
                    .get("options")
                    .and_then(|opts| opts.get(id))
                    .and_then(|label| label.as_str())
            });
            let free_text = match &ans.free_text_ref {
                Some(r) => Some(
                    String::from_utf8(self.log.blobs().get(r)?)
                        .expect("free_text blob 是 runtime 自己用 UTF-8 写入的原文，不应解码失败"),
                ),
                None => None,
            };

            let mut summary = format!("澄清问题：{question}");
            if let Some(label) = chosen_label {
                summary.push_str(&format!("\n选择：{label}"));
            }
            if let Some(free) = &free_text {
                summary.push_str(&format!("\n补充说明：{free}"));
            }

            let answer_ref =
                self.log
                    .blobs()
                    .put(BlobClass::Content, "text/plain", summary.as_bytes())?;
            out.push((answer_ref, summary));
        }
        Ok(out)
    }

    /// 把这条 run 里迄今每一份**有内容回传**的工具返回，拼成一个
    /// (工具名, 输出 blob 引用, 文本形态) 的列表，供 `AssembleContext`
    /// 传给 `Assembler`。
    ///
    /// 这是污点闸门在上下文这一侧的电源（M2 终审 BL-9）。在它存在之前，
    /// `assemble` 只见得到 intent 与澄清答案两种来源，两者都是用户当面
    /// 输入，于是 `context.assembled.taint_level` 恒为 `Clean`——04 §2
    /// 第 1 条「块的污点进 run」在代码里是一条恒等式。
    ///
    /// 三个判断：
    ///
    /// 1. **只收 `output_ref` 有值的**。一个 block 的身份就是它的
    ///    `content_hash`（04 §1），没有 blob 就没有内容可引用。`fs.write`
    ///    成功（不回传任何东西）、被 Gateway 拒掉的 `Denied`、dry-run 的
    ///    `DryRun`、执行出错的 `Error`，都落在这一类里。
    /// 2. **工具名从 `tool.requested` 取**。`tool.result` 的 payload 里
    ///    没有工具名，只有 `effect_id`——两条事件按 `effect_id` 对起来。
    ///    取不到就跳过：一条没有对应 `tool.requested` 的 `tool.result`
    ///    是 Log 损坏，不该在这里静默编一个工具名出来。
    /// 3. **文本按有损方式转**。`fs.read` 读二进制文件完全合法，而
    ///    `output_text` 只用来估 token 数——block 引用的是 blob 的
    ///    `content_hash`，有损转换不会改变它（见 `ToolOutput` 的文档），
    ///    判据 3 因而不受影响。
    fn tool_output_blobs_for(
        &self,
        run_id: &RunId,
    ) -> Result<Vec<(String, BlobRef, String)>, DaemonError> {
        let mut tool_of: BTreeMap<EffectId, String> = BTreeMap::new();
        let mut out = Vec::new();
        for event in self.log.events(run_id, 0, None)? {
            match event.body {
                EventBody::ToolRequested(tr) => {
                    tool_of.insert(tr.effect_id, tr.tool.as_str().to_owned());
                }
                EventBody::ToolResult(res) => {
                    let Some(output_ref) = res.output_ref else {
                        continue;
                    };
                    let Some(tool) = tool_of.get(&res.effect_id) else {
                        continue;
                    };
                    let bytes = self.log.blobs().get(&output_ref)?;
                    let text = String::from_utf8_lossy(&bytes).into_owned();
                    out.push((tool.clone(), output_ref, text));
                }
                _ => {}
            }
        }
        Ok(out)
    }

    /// 从 `tool.requested`（Gateway 判定阶段就写好的字段）+ 当前 state
    /// （taint）+ 配置（capability）拼回一份 `EffectRequest`。
    ///
    /// 这是 `resume` 补派已批准 effect 时唯一可行的路径：Gateway 当初返回
    /// 的那份 `EffectRequest`只活在内存里，`Runtime` 实例一旦被丢弃就没了；
    /// 但它的每个字段要么来自 manifest（已经写进 `tool.requested`），要么
    /// 来自当前 state（taint），要么是可以按同样规则重新推导的（capability）。
    fn rebuild_effect_request(&self, state: &RunState, tr: ToolRequested) -> EffectRequest {
        EffectRequest {
            effect_id: tr.effect_id,
            run_id: state.run_id.clone(),
            turn: tr.turn,
            tool: tr.tool,
            params_ref: tr.params_ref,
            params_digest: tr.params_digest,
            class: tr.class,
            targets: tr.declared_targets,
            egress: tr.declared_egress,
            reversible: tr.reversible,
            taint: state.taint,
            cites_referenced: tr.cites_referenced,
            capability: CapabilityToken {
                subject: self.config.principal.clone(),
                scopes: vec!["*".to_owned()],
            },
        }
    }

    async fn execute_command(
        &mut self,
        state: RunState,
        cmd: Command,
    ) -> Result<RunState, DaemonError> {
        match cmd {
            Command::SampleEnv => {
                let body = EventBody::EnvSampled(EnvSampled {
                    turn: state.turn,
                    wall_clock_ms: self.clock.now_ms(),
                    rng_seed: self.clock.seed(),
                    env: Default::default(),
                    model_route: ModelRoute {
                        provider: self.model.provider().to_owned(),
                        model: self.model.model().to_owned(),
                        params_digest: "default".to_owned(),
                    },
                });
                self.emit(&state, Actor::Runtime, body)
            }

            Command::AssembleContext { turn, .. } => {
                // 意图从 state.intent 指向的 blob 取，不是函数参数——
                // resume 之后没有 intent_text 参数可用，这是唯一的信息来源。
                let intent_ref = state.intent.clone().expect(
                    "AssembleContext 只会在 intent.declared 已经写入之后被 decide 产出——\
                     state.intent 此时必为 Some（start/resume 都先保证了这一点）",
                );
                let intent_text = String::from_utf8(self.log.blobs().get(&intent_ref)?)
                    .expect("intent blob 是 runtime 自己用 UTF-8 写入的原文，不应解码失败");

                // 把这条 run 里已经回答过的澄清都带进来——这是 Task 6 的要害:
                // `evo_kernel::reduce` 处理 `ClarificationAnswered` 时把
                // `context_turn`/`plan_turn` 一并回退，就是为了让 decide 重新
                // 产出 AssembleContext；这里如果不把答案真的塞进去，模型拿到
                // 的还是一份不含答案的上下文，跟没回答没有区别（见该 reduce
                // 分支的交接注释）。答案文本从 blob 读出来再传给 Assembler——
                // evo-context 本身不读 blob store。
                let answer_blobs = self.answer_blobs_for(&state.run_id)?;
                let answered: Vec<AnsweredClarification<'_>> = answer_blobs
                    .iter()
                    .map(|(answer_ref, answer_text)| AnsweredClarification {
                        answer_ref,
                        answer_text,
                    })
                    .collect();

                // 工具返回同理：内容早就在 blob 里了，daemon 读出来递进去，
                // `evo-context` 自己不碰 blob store。它们进上下文时带
                // `TrustLevel::Untrusted`（判定在 `evo_context::BlockSource`
                // 那一侧，不在这里），于是这个 turn 的
                // `context.assembled.taint_level` 变成 `Tainted`，`reduce`
                // 把它 join 进 `RunState.taint`，下一步非 Read 的 effect 就
                // 会撞上 Gateway 的第 ③ 步。
                let tool_output_blobs = self.tool_output_blobs_for(&state.run_id)?;
                let tool_outputs: Vec<ToolOutput<'_>> = tool_output_blobs
                    .iter()
                    .map(|(tool, output_ref, output_text)| ToolOutput {
                        tool,
                        output_ref,
                        output_text,
                    })
                    .collect();

                let assembled = self.assembler.assemble(
                    turn,
                    &intent_ref,
                    &intent_text,
                    &answered,
                    &tool_outputs,
                );
                self.emit(
                    &state,
                    Actor::Runtime,
                    EventBody::ContextAssembled(assembled),
                )
            }

            Command::CallModel { turn } => self.call_model(state, turn).await,

            Command::RequestEffect { call } => self.request_effect(state, call).await,

            Command::Checkpoint { reason } => self.checkpoint(state, reason),

            // 内核的判决（RunStatus）原样转成 Log 里的 CompletionStatus——
            // 此前这里无条件写 Ok，把 decide() 判出来的 Failed 悄悄抹掉
            // （唯一产出 Failed 的分支：ToolCall 却没给出合法 call，见
            // evo-kernel/src/decide.rs）。
            Command::Complete { status } => self.emit(
                &state,
                Actor::Kernel,
                EventBody::RunCompleted(RunCompleted {
                    status: match status {
                        RunStatus::Failed => CompletionStatus::Failed,
                        _ => CompletionStatus::Ok,
                    },
                    summary_ref: None,
                }),
            ),

            // 问题正文与选项文案（含 `label`，绝不进 payload）早已在
            // `call_model` 里随 `PlanStep.clarification` 落进一个 blob（见
            // `ClarificationRequested::prompt_ref` 的文档给出的建议形状）
            // ——`decide` 把那份 `PlannedClarification` 放进 Command，这里
            // 读载荷，不从 `last_plan` 另读一遍，也不对模型原文重新解析。
            Command::AskClarification { clarification } => {
                let question_id = format!("{}-q{}", state.run_id, state.last_seq);
                let state = self.emit(
                    &state,
                    Actor::Runtime,
                    EventBody::ClarificationRequested(ClarificationRequested {
                        question_id,
                        prompt_ref: clarification.prompt_ref,
                        options: clarification.options,
                    }),
                )?;
                self.emit(
                    &state,
                    Actor::Runtime,
                    EventBody::RunSuspended(RunSuspended {
                        reason: SuspendReason::AwaitingHuman,
                        detail_ref: None,
                    }),
                )
            }

            // 预算超限，内核发的（decide.rs 里唯一构造 Command::Suspend 的
            // 分支）。挂起，不是 Err：追加 run.suspended，让 reduce 置
            // awaiting，循环自然结束。
            Command::Suspend { reason } => {
                let suspend_reason = match reason {
                    AwaitReason::Budget => SuspendReason::BudgetExhausted,
                    other => unreachable!(
                        "evo-kernel::decide 目前只在预算超限时产出 Command::Suspend\
                         （唯一构造点是 decide.rs 的 budget_exceeded 分支）；出现 \
                         {other:?} 说明这条假设被打破，daemon 需要新增对应的挂起处理分支"
                    ),
                };
                self.emit(
                    &state,
                    Actor::Kernel,
                    EventBody::RunSuspended(RunSuspended {
                        reason: suspend_reason,
                        detail_ref: None,
                    }),
                )
            }
        }
    }

    async fn call_model(&mut self, state: RunState, turn: u32) -> Result<RunState, DaemonError> {
        let mut state = state;
        let request = ModelRequest {
            messages: self.model_messages(&state)?,
            params: ModelParams {
                temperature: 0.0,
                max_tokens: None,
            },
        };
        // messages 全文进 blob
        let messages_ref = self.log.blobs().put(
            BlobClass::Content,
            "application/json",
            &serde_json::to_vec(&request.messages).expect("messages 可序列化"),
        )?;
        state = self.emit(
            &state,
            Actor::Runtime,
            EventBody::ModelRequested(ModelRequested {
                turn,
                provider: self.model.provider().to_owned(),
                model: self.model.model().to_owned(),
                params: request.params.clone(),
                request_digest: request_digest(&request),
                messages_ref,
            }),
        )?;

        let response = self.model.call(&request).await?;
        let response_ref =
            self.log
                .blobs()
                .put(BlobClass::Content, "text/plain", response.text.as_bytes())?;
        let response_hash = response_ref.content_hash.clone();
        state = self.emit(
            &state,
            Actor::Runtime,
            EventBody::ModelResponded(ModelResponded {
                turn,
                response_ref,
                response_hash,
                usage: response.usage,
                stop_reason: response.stop_reason.clone(),
                latency_ms: response.latency_ms,
            }),
        )?;

        let dimension = CostDimension {
            principal: self.config.principal.clone(),
            team: None,
            run_id: state.run_id.clone(),
            skill: None,
            tool: None,
        };
        // 定价表里没有这个模型时 charges() 返回空列表——那和「这次真的没费用」
        // 是两回事，必须能分辨，否则「未定价」会被静默当成「免费」。
        if !self
            .pricing
            .covers(self.model.provider(), self.model.model())
        {
            let detail = DaemonError::ModelNotPriced {
                provider: self.model.provider().to_owned(),
                model: self.model.model().to_owned(),
            };
            return self.fail_run(state, "model_not_priced", &detail);
        }
        for charge in self.pricing.charges(
            self.model.provider(),
            self.model.model(),
            &response.usage,
            &dimension,
            Some(turn),
        )? {
            state = self.emit(&state, Actor::Runtime, EventBody::CostCharged(charge))?;
        }

        // 模型返回散文而不是计划：这是最常见的一种真实故障，落成事件，
        // 不冒泡。错误正文（含模型原文的前 60 个字符）进 blob。
        let parsed = match parse_plan(&response.text) {
            Ok(p) => p,
            Err(e) => return self.fail_run(state, "unparseable_plan", &e),
        };
        let call = match (&parsed.intent, &parsed.tool) {
            (PlanIntent::ToolCall, Some(tool)) => {
                let params_bytes = serde_json::to_vec(&parsed.params).expect("params 可序列化");
                let params_ref =
                    self.log
                        .blobs()
                        .put(BlobClass::Content, "application/json", &params_bytes)?;
                let params_digest = params_ref.content_hash.clone();
                Some(PlannedCall {
                    tool: evo_protocol::ToolId::from(tool.as_str()),
                    params_ref,
                    params_digest,
                })
            }
            _ => None,
        };
        // 澄清路径与工具调用路径对称：问题正文与选项文案（含 label，
        // 绝不进事件 payload）在这里——`parse_plan` 唯一被调用的地方——
        // 一次性落进一个 blob，随 `PlanStep.clarification` 写进 Log。
        // `decide` 再把它放进 `Command::AskClarification`，执行方读载荷。
        let clarification = match parsed.intent {
            PlanIntent::Clarify => {
                let options_by_id: BTreeMap<String, String> = parsed
                    .options
                    .iter()
                    .map(|o| (o.id.clone(), o.label.clone()))
                    .collect();
                let prompt = serde_json::json!({
                    "question": parsed.question.clone().unwrap_or_default(),
                    "options": options_by_id,
                });
                let prompt_ref = self.log.blobs().put(
                    BlobClass::Content,
                    "application/json",
                    &serde_json::to_vec(&prompt).expect("prompt 可序列化"),
                )?;
                let options: Vec<ClarificationOption> = parsed
                    .options
                    .into_iter()
                    .map(|o| ClarificationOption {
                        id: o.id,
                        is_default: o.is_default,
                    })
                    .collect();
                Some(PlannedClarification {
                    prompt_ref,
                    options,
                })
            }
            _ => None,
        };
        self.emit(
            &state,
            Actor::Runtime,
            EventBody::PlanStep(PlanStep {
                turn,
                intent: parsed.intent,
                rationale_ref: None,
                taint_inherited: state.taint,
                call,
                clarification,
            }),
        )
    }

    async fn request_effect(
        &mut self,
        state: RunState,
        call: PlannedCall,
    ) -> Result<RunState, DaemonError> {
        let mut state = state;
        let effect_id = EffectId::from(format!("{}-e{}", state.run_id, state.last_seq));
        let params: serde_json::Value =
            serde_json::from_slice(&self.log.blobs().get(&call.params_ref)?)
                .unwrap_or(serde_json::json!({}));

        let verdict = self.gateway.admit(AdmitRequest {
            effect_id: effect_id.clone(),
            run_id: state.run_id.clone(),
            turn: state.turn,
            call,
            params: params.clone(),
            taint: state.taint,
            cites_referenced: state.cites.iter().cloned().collect(),
            capability: CapabilityToken {
                subject: self.config.principal.clone(),
                scopes: vec!["*".to_owned()],
            },
            mode: ExecutionMode::Live,
            // 第⑤步（预算闸门）的输入。Gateway 不持有 run 状态，额度与
            // 已用量都由这里从 `RunState` 里取出来当纯数据递进去——
            // `state` 本身是 Log 折叠的结果，所以这两个值同样是可回放的。
            budget: state.budget,
            budget_used: state.budget_used,
        });

        for body in verdict.events {
            state = self.emit(&state, Actor::Gateway, body)?;
        }

        self.handle_gateway_action(state, effect_id, verdict.action)
            .await
    }

    /// [`Gateway::admit`] 的产出可能不止一种结局：正常情况下五种动作里选
    /// 一种；一个声明了 `preview` 的工具还会先给出
    /// `GatewayAction::NeedPreview`，要再问一轮 executor、调用
    /// [`Gateway::admit_with_preview`] 才能拿到真正的结局。用 `loop` 而不是
    /// 递归 `async fn` 调自己，是因为递归 `async fn` 的 future 大小在编译期
    /// 算不出来，需要额外 `Box::pin`；而这里的"递归"深度天然只有一层——
    /// `admit_with_preview` 的产出不会再是 `NeedPreview`——用 `loop` 更直接。
    ///
    /// **`NeedPreview` 现在的处理**：M2 这一轮还没有任何工具在
    /// `config/tools.toml` 里声明 `preview`，`Executor` 也还没有真正调用它
    /// 的能力（那是后续任务接上某个回写演示场景时才要做的事）。真正接上
    /// 之前，这里显式传 `None`——不做任何 IO，退回第 2 级（`DeclaredOnly`）
    /// 或第 3 级（`Unknown`）。这不阻塞接入，是判据 1 延伸的直接体现。
    async fn handle_gateway_action(
        &mut self,
        mut state: RunState,
        effect_id: EffectId,
        mut action: GatewayAction,
    ) -> Result<RunState, DaemonError> {
        loop {
            match action {
                GatewayAction::Dispatch(request) => {
                    return self.dispatch_effect(state, effect_id, request).await;
                }

                // Gateway 已经把 tool.result{dry_run} 塞进了本轮的
                // verdict.events（调用方已经写过了）——这里只是继续循环，
                // 不是终止。
                GatewayAction::DryRun { .. } => return Ok(state),

                GatewayAction::Deny { reason_code } => {
                    // 先下一个检查点，再追加 run.failed：否则这条 run 没有
                    // 任何可校验的锚点，`verify` 会报 VACUOUS——一条被拒的
                    // run 应当既能关掉也能验。
                    let state = self.checkpoint(state, CheckpointReason::PreApproval)?;
                    // 把 effect 推到终态。`tool.requested` 已经让 reduce 把它
                    // 记成 `EffectState::Requested`；不写这条结算，它就永远停
                    // 在那儿，而「停在 Requested」是 `resume` 补派的判据之一
                    // ——一条被明确拒绝的写操作会在下一次恢复时被真的执行
                    // （M2 终审 BL-1）。`ToolResultStatus::Denied` 这个此前
                    // 零生产者的状态就是为这一刻留的：effect 从未执行，所以
                    // 没有输出、没有实际目标、taint 保持 Clean。
                    let state = self.emit(
                        &state,
                        Actor::Gateway,
                        EventBody::ToolResult(ToolResult {
                            effect_id,
                            status: ToolResultStatus::Denied,
                            output_ref: None,
                            bytes: None,
                            taint: TaintLevel::Clean,
                            cites_produced: Vec::new(),
                            actual_targets: Vec::new(),
                            actual_egress: Vec::new(),
                        }),
                    )?;
                    let message_ref = self.log.blobs().put(
                        BlobClass::Content,
                        "text/plain",
                        reason_code.as_bytes(),
                    )?;
                    return self.emit(
                        &state,
                        Actor::Gateway,
                        EventBody::RunFailed(RunFailed {
                            at_seq: state.last_seq,
                            error: ErrorDetail {
                                code: reason_code,
                                message_ref: Some(message_ref),
                                retryable: false,
                            },
                        }),
                    );
                }

                GatewayAction::AwaitApproval { risk, impact, .. } => {
                    let approval_id =
                        ApprovalId::from(format!("{}-a{}", state.run_id, state.last_seq));
                    let expires_at_ms = state.clock_ms + APPROVAL_TTL_MS;
                    // 影响预估可能带具体资源标识甚至金额，一律 blob，
                    // 不进 `approval.requested` 的 payload（红线①）。
                    let impact_bytes =
                        serde_json::to_vec(&impact).expect("ImpactEstimated 可序列化");
                    let impact_ref = self.log.blobs().put(
                        BlobClass::Content,
                        "application/json",
                        &impact_bytes,
                    )?;
                    state = self.emit(
                        &state,
                        Actor::Gateway,
                        EventBody::ApprovalRequested(ApprovalRequested {
                            approval_id,
                            effect_id: effect_id.clone(),
                            risk,
                            impact_ref: Some(impact_ref),
                            expires_at_ms,
                        }),
                    )?;
                    return self.emit(
                        &state,
                        Actor::Gateway,
                        EventBody::RunSuspended(RunSuspended {
                            reason: SuspendReason::AwaitingApproval,
                            detail_ref: None,
                        }),
                    );
                }

                // 第⑤步拦下了这次调用。与 `Deny` 分支同构的收尾，只有结局
                // 不同：被拒是 `run.failed`（这个动作本身不许做），超预算是
                // `run.suspended{BudgetExhausted}`（动作合法，只是现在没钱）
                // ——「超限自动挂起而非静默烧钱」。
                GatewayAction::BudgetExceeded { reason_code, .. } => {
                    // 与 Deny 分支同样的理由：先下检查点，否则这条 run 没有
                    // 任何可校验的锚点，`verify` 会报 VACUOUS。
                    let state = self.checkpoint(state, CheckpointReason::PreApproval)?;
                    // 把 effect 推到终态。不写这条结算，它会永远停在
                    // `Requested`：`decide` 的「还有 effect 没跑到终态」检查
                    // 会一直挡在前面，人提额、`run.resumed` 清空 awaiting
                    // 之后 run 照样推不动——turn 循环走不到重新规划那一步，
                    // 最后落进 `drive` 的 stalled 分支报 run.failed。
                    // 这条 effect 从未执行，所以没有输出、没有实际目标、
                    // taint 保持 Clean，与 Gateway 直接拒掉的那条路径一致。
                    let state = self.emit(
                        &state,
                        Actor::Gateway,
                        EventBody::ToolResult(ToolResult {
                            effect_id,
                            status: ToolResultStatus::Denied,
                            output_ref: None,
                            bytes: None,
                            taint: TaintLevel::Clean,
                            cites_produced: Vec::new(),
                            actual_targets: Vec::new(),
                            actual_egress: Vec::new(),
                        }),
                    )?;
                    // 哪个维度、为什么拦，进 blob——`RunSuspended` 的 payload
                    // 里只有粗粒度的 `SuspendReason`，具体分类码走 detail_ref
                    // （红线①：正文不进 payload）。这是 UI 要告诉人「加多少
                    // 才跑得动」时唯一的线索来源。
                    let detail_ref = self.log.blobs().put(
                        BlobClass::Content,
                        "text/plain",
                        reason_code.as_bytes(),
                    )?;
                    return self.emit(
                        &state,
                        Actor::Gateway,
                        EventBody::RunSuspended(RunSuspended {
                            reason: SuspendReason::BudgetExhausted,
                            detail_ref: Some(detail_ref),
                        }),
                    );
                }

                GatewayAction::NeedPreview { pending } => {
                    let verdict = self.gateway.admit_with_preview(pending, None);
                    for body in verdict.events {
                        state = self.emit(&state, Actor::Gateway, body)?;
                    }
                    action = verdict.action;
                }
            }
        }
    }

    /// 派发一个已经放行的 effect：pre_write 检查点、租约、真正执行、结算。
    ///
    /// 两个调用点收在这一个方法里：`request_effect` 的 `Dispatch` 分支
    /// （一次性放行），以及 `resume` 对「已批准但还没派发」的 effect 的
    /// 补派——此前这两条路径各写一份几乎相同的代码，容易漏改其中一处。
    async fn dispatch_effect(
        &mut self,
        state: RunState,
        effect_id: EffectId,
        request: EffectRequest,
    ) -> Result<RunState, DaemonError> {
        let mut state = state;
        let tool = request.tool.clone();
        let turn = request.turn;
        let params: serde_json::Value =
            serde_json::from_slice(&self.log.blobs().get(&request.params_ref)?)
                .unwrap_or(serde_json::json!({}));
        let params_for_artifact = params.clone();

        // pre_write 语义检查点（03 §5）：不可逆动作之前留一个可回滚的锚点
        if request.class == EffectClass::Write || request.class == EffectClass::External {
            state = self.checkpoint(state, CheckpointReason::PreWrite)?;
        }

        let workspace: WorkspaceHandle = self.workspaces.ensure(&state.run_id)?;
        let lease = Lease {
            lease_id: LeaseId::from(format!("{effect_id}-l")),
            run_id: state.run_id.clone(),
            effect_id: effect_id.clone(),
            // 两个时刻都来自 env.sampled 的 clock_ms，不是执行器自己读时钟。
            // spawn 超时 = expires_at_ms - issued_at_ms，封顶 60s。
            issued_at_ms: state.clock_ms,
            expires_at_ms: state.clock_ms + 60_000,
            workspace,
            egress_policy: EgressPolicy {
                allow: self.config.egress_allow.clone(),
                proxy_addr: self.config.proxy_addr.clone(),
            },
            capability: request.capability.clone(),
        };

        state = self.emit(
            &state,
            Actor::Gateway,
            EventBody::EffectDispatched(EffectDispatched {
                effect_id: effect_id.clone(),
                executor_id: self.executor.id(),
                lease_id: lease.lease_id.clone(),
                mode: ExecutionMode::Live,
            }),
        )?;

        let outcome = self
            .executor
            .execute(
                lease,
                DispatchedEffect {
                    request,
                    params,
                    mode: ExecutionMode::Live,
                },
            )
            .await;

        let (output_ref, bytes) = match &outcome.output {
            Some(b) => (
                Some(
                    self.log
                        .blobs()
                        .put(BlobClass::Content, &outcome.output_mime, b)?,
                ),
                Some(b.len() as u64),
            ),
            None => (None, None),
        };

        let executed = matches!(
            outcome.status,
            ToolResultStatus::Ok | ToolResultStatus::Error
        );
        let write_ok = outcome.status == ToolResultStatus::Ok && tool.as_str() == "fs.write";
        let reported_cost = outcome.cost_micros;

        let mut state = self.emit(
            &state,
            Actor::Executor,
            EventBody::ToolResult(ToolResult {
                effect_id: effect_id.clone(),
                status: outcome.status,
                output_ref,
                bytes,
                taint: outcome.taint,
                cites_produced: Vec::new(),
                actual_targets: outcome.actual_targets,
                actual_egress: outcome.actual_egress,
            }),
        )?;

        if write_ok {
            state = self.emit_artifact_for_write(&state, &params_for_artifact)?;
        }

        if executed {
            state = self.charge_effect(state, &effect_id, &tool, turn, reported_cost)?;
        }

        Ok(state)
    }

    /// 成功的 `fs.write` 才进产物区。错误 / 拒绝 / dry-run、以及 `fs.read` /
    /// `shell.exec` 都不发。`cites` 恒空——`cites_produced` 今天没有写入方，
    /// 不在这里编一份。同一 path 再次写出时 `supersedes` 指向状态里已有的
    /// 那条；两条都留在 `RunState::artifacts` 里（不可变，替代关系靠字段）。
    fn emit_artifact_for_write(
        &mut self,
        state: &RunState,
        params: &serde_json::Value,
    ) -> Result<RunState, DaemonError> {
        let Some(path) = params.get("path").and_then(|v| v.as_str()) else {
            return Ok(state.clone());
        };
        let Some(content) = params.get("content").and_then(|v| v.as_str()) else {
            return Ok(state.clone());
        };
        let blob = self
            .log
            .blobs()
            .put(BlobClass::Artifact, "text/plain", content.as_bytes())?;
        let supersedes = state
            .artifacts
            .iter()
            .rev()
            .find(|a| a.path == path)
            .map(|a| a.artifact_id.clone());
        let artifact_id = ArtifactId::from(format!("{}-art{}", state.run_id, state.last_seq));
        self.emit(
            state,
            Actor::Executor,
            EventBody::ArtifactEmitted(ArtifactEmitted {
                artifact_id,
                path: path.to_owned(),
                blob,
                cites: Vec::new(),
                supersedes,
            }),
        )
    }

    /// 已执行的工具（Ok / Error，不是 Denied / DryRun）才出账。
    ///
    /// 优先用执行器回报的 `cost_micros`：`Some(n>0)` 按次计；`Some(0)` 表示
    /// 这次明确免费，不再查定价表。`None` 才查表。表里没有、或 `call_micros`
    /// 为 0，就跳过——未定价的本地工具不让 run 失败（与模型未定价不同）。
    fn charge_effect(
        &mut self,
        mut state: RunState,
        effect_id: &EffectId,
        tool: &ToolId,
        turn: u32,
        reported_cost: Option<u64>,
    ) -> Result<RunState, DaemonError> {
        let dimension = CostDimension {
            principal: self.config.principal.clone(),
            team: None,
            run_id: state.run_id.clone(),
            skill: None,
            tool: Some(tool.clone()),
        };
        let charges = match reported_cost {
            Some(0) => Vec::new(),
            Some(micros) => vec![CostCharged {
                effect_id: Some(effect_id.clone()),
                turn: Some(turn),
                unit: CostUnit::Call,
                quantity: 1,
                unit_price_micros: micros,
                amount_micros: micros,
                currency: self.pricing.currency(),
                price_table_ver: self.pricing.version().to_owned(),
                dimension,
            }],
            None => self
                .pricing
                .tool_charges(tool.as_str(), effect_id, Some(turn), &dimension)?,
        };
        for charge in charges {
            state = self.emit(&state, Actor::Runtime, EventBody::CostCharged(charge))?;
        }
        Ok(state)
    }

    /// 写一个检查点：先算当前 state 的 hash 进事件，再存快照。
    ///
    /// 顺序不能反——事件里的 state_hash 是**写检查点之前**的状态，
    /// 回放到该 seq 时重算的也是同一个状态。
    fn checkpoint(
        &mut self,
        state: RunState,
        reason: CheckpointReason,
    ) -> Result<RunState, DaemonError> {
        let hash = state_hash(&state);
        let body = EventBody::Checkpoint(Checkpoint {
            checkpoint_id: CheckpointId::from(format!("{}-cp{}", state.run_id, state.last_seq)),
            state_hash: hex::encode(hash),
            snapshot_ref: None,
            reason,
        });
        let new_state = self.emit(&state, Actor::Kernel, body)?;

        let mut blob = Vec::new();
        ciborium::into_writer(&state, &mut blob).expect("RunState 可序列化");
        self.log
            .put_snapshot(&new_state.run_id, new_state.last_seq, &blob, &hash)?;
        Ok(new_state)
    }
}
