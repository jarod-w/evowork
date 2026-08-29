use crate::clock::Clock;
use crate::config::DaemonConfig;
use evo_context::Assembler;
use evo_exec::{CapabilityToken, DispatchedEffect, EgressPolicy, Executor, Lease, WorkspaceHandle};
use evo_exec_local::WorkspaceRoot;
use evo_gateway::{AdmitRequest, Gateway, GatewayAction, ManifestRegistry};
use evo_kernel::{Command, RunState, decide, reduce, state_hash};
use evo_model::{Message, ModelAdapter, ModelRequest, PriceTable, request_digest};
use evo_policy::HardcodedPolicy;
use evo_protocol::events::accounting::{Checkpoint, CheckpointReason, CostDimension};
use evo_protocol::events::determinism::{EnvSampled, ModelRoute};
use evo_protocol::events::effect::{EffectDispatched, ExecutionMode, ToolResult};
use evo_protocol::events::lifecycle::{
    CompletionStatus, IntentDeclared, PrincipalRef, RunCompleted, RunCreated, TriggerKind,
    TriggerRef,
};
use evo_protocol::events::model::{
    ModelParams, ModelRequested, ModelResponded, PlanIntent, PlanStep, PlannedCall,
};
use evo_protocol::{
    Actor, BlobClass, BlobRef, BudgetSpec, CheckpointId, EffectClass, EffectId, EventBody, LeaseId,
    RunId,
};
use evo_runlog::RunLog;
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
    #[error("effect was denied: {0}")]
    Denied(String),
    #[error("turn limit exceeded: {0}")]
    TurnLimit(u32),
    #[error("snapshot is undecodable at seq {seq}: {detail}")]
    SnapshotDecode { seq: u64, detail: String },
    #[error("not implemented in phase 1: {0}")]
    NotImplemented(&'static str),
    #[error("model {provider}/{model} is not in the price table")]
    ModelNotPriced { provider: String, model: String },
}

/// runtime 从模型输出里解析出的结构化决策。
///
/// **解析在这里，不在内核（Q-12）**：它是最容易引入非确定性
/// （正则、时间、随机重试）的地方，关在内核外面，内核的确定性好守得多。
#[derive(Clone, Debug, PartialEq)]
pub struct ParsedPlan {
    pub intent: PlanIntent,
    pub tool: Option<String>,
    pub params: serde_json::Value,
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
    Ok(ParsedPlan {
        intent,
        tool: v.get("tool").and_then(|t| t.as_str()).map(str::to_owned),
        params: v.get("params").cloned().unwrap_or(serde_json::json!({})),
    })
}

/// 单 run 最多跑多少 turn。防的是 fixture 或模型让循环停不下来。
const MAX_TURNS: u32 = 64;

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
        })
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
        Ok(reduce(state, &event))
    }

    pub async fn run_once(
        &mut self,
        run_id: &RunId,
        intent_text: &str,
    ) -> Result<RunState, DaemonError> {
        let mut state = RunState::new(run_id);

        state = self.emit(
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
                    reference: "cli".into(),
                },
                budget: BudgetSpec::default(),
                labels: Default::default(),
            }),
        )?;

        // 意图原文进 blob，事件里只留引用与长度（01 §3）
        let intent_ref =
            self.log
                .blobs()
                .put(BlobClass::Content, "text/plain", intent_text.as_bytes())?;
        state = self.emit(
            &state,
            Actor::Runtime,
            EventBody::IntentDeclared(IntentDeclared {
                intent_ref: intent_ref.clone(),
                char_len: intent_text.chars().count() as u64,
                lang: "zh".to_owned(),
                source: "cli".to_owned(),
            }),
        )?;

        loop {
            if state.turn > MAX_TURNS {
                return Err(DaemonError::TurnLimit(MAX_TURNS));
            }
            let commands = decide(&state);
            if commands.is_empty() {
                break;
            }
            for cmd in commands {
                state = self
                    .execute_command(state, cmd, &intent_ref, intent_text)
                    .await?;
            }
        }
        Ok(state)
    }

    async fn execute_command(
        &mut self,
        state: RunState,
        cmd: Command,
        intent_ref: &BlobRef,
        intent_text: &str,
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
                let assembled = self.assembler.assemble(turn, intent_ref, intent_text);
                self.emit(
                    &state,
                    Actor::Runtime,
                    EventBody::ContextAssembled(assembled),
                )
            }

            Command::CallModel { turn } => self.call_model(state, turn).await,

            Command::RequestEffect { call } => self.request_effect(state, call).await,

            Command::Checkpoint { reason } => self.checkpoint(state, reason),

            Command::Complete { .. } => self.emit(
                &state,
                Actor::Kernel,
                EventBody::RunCompleted(RunCompleted {
                    status: CompletionStatus::Ok,
                    summary_ref: None,
                }),
            ),

            Command::AskClarification { .. } => Err(DaemonError::NotImplemented(
                "clarification.requested 属阶段 2",
            )),
            Command::Suspend { .. } => Err(DaemonError::NotImplemented("run.suspended 属阶段 2")),
        }
    }

    async fn call_model(&mut self, state: RunState, turn: u32) -> Result<RunState, DaemonError> {
        let mut state = state;
        let request = ModelRequest {
            messages: vec![Message {
                role: "user".into(),
                content: String::new(),
            }],
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
            return Err(DaemonError::ModelNotPriced {
                provider: self.model.provider().to_owned(),
                model: self.model.model().to_owned(),
            });
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

        let parsed = parse_plan(&response.text)?;
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
        self.emit(
            &state,
            Actor::Runtime,
            EventBody::PlanStep(PlanStep {
                turn,
                intent: parsed.intent,
                rationale_ref: None,
                taint_inherited: state.taint,
                call,
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
        });

        for body in verdict.events {
            state = self.emit(&state, Actor::Gateway, body)?;
        }

        let request = match verdict.action {
            GatewayAction::Dispatch(req) => req,
            GatewayAction::DryRun { .. } => return Ok(state),
            GatewayAction::Deny { reason_code } => return Err(DaemonError::Denied(reason_code)),
            GatewayAction::AwaitApproval { .. } => {
                // 阶段 2：写 approval.requested 并挂起。阶段 1 的工具都不触发它。
                return Err(DaemonError::Denied("approval_required".to_owned()));
            }
        };

        // pre_write 语义检查点（03 §5）：不可逆动作之前留一个可回滚的锚点
        if request.class == EffectClass::Write || request.class == EffectClass::External {
            state = self.checkpoint(state, CheckpointReason::PreWrite)?;
        }

        let workspace: WorkspaceHandle = self.workspaces.ensure(&state.run_id)?;
        let lease = Lease {
            lease_id: LeaseId::from(format!("{effect_id}-l")),
            run_id: state.run_id.clone(),
            effect_id: effect_id.clone(),
            // 来自 env.sampled 的 clock_ms，不是执行器自己读时钟
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

        self.emit(
            &state,
            Actor::Executor,
            EventBody::ToolResult(ToolResult {
                effect_id,
                status: outcome.status,
                output_ref,
                bytes,
                taint: outcome.taint,
                cites_produced: Vec::new(),
                actual_targets: outcome.actual_targets,
                actual_egress: outcome.actual_egress,
            }),
        )
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
