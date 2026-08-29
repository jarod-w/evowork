use crate::events::accounting::{Checkpoint, CostCharged};
use crate::events::context::ContextAssembled;
use crate::events::determinism::EnvSampled;
use crate::events::effect::{
    EffectDispatched, ImpactEstimated, PolicyEvaluated, ToolRequested, ToolResult,
};
use crate::events::lifecycle::{IntentDeclared, RunCompleted, RunCreated};
use crate::events::model::{ModelRequested, ModelResponded, PlanStep};
use crate::ids::RunId;
use serde::{Deserialize, Serialize};

/// 谁产生了这条事件。对应 run_events.actor 列。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Actor {
    Kernel,
    Runtime,
    Gateway,
    Executor,
    Human(String),
    Trigger(String),
}

/// Run Log 里的一条事件。字段与 run_events 表逐列对应。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Event {
    pub run_id: RunId,
    pub seq: u64,
    /// daemon 写入时刻。内核不可见——reduce 不许读这个字段。
    pub recorded_at: String,
    pub actor: Actor,
    pub schema_ver: u32,
    pub body: EventBody,
}

/// 事件体。`kind` 标签内联，因此 payload 列可以整体反序列化回本枚举。
///
/// 红线：本枚举的每个变体、以及它们引用的所有嵌套结构体，一律不得加
/// `#[serde(deny_unknown_fields)]`。事件 schema 只增不改——新增字段必须是
/// optional，旧版本解码器必须还能读进带新增字段的 payload；一旦某个事件结构体
/// 加了 `deny_unknown_fields`，旧解码器遇到新增字段就会直接报错，当场破坏这条
/// 契约。这条约束由
/// `tests::all_15_variants_tolerate_unknown_optional_fields` 对全部 15 个
/// 变体做穷尽验证——谁给某个事件结构体加了 `deny_unknown_fields`，这条测试就会红。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind")]
pub enum EventBody {
    #[serde(rename = "run.created")]
    RunCreated(RunCreated),
    #[serde(rename = "intent.declared")]
    IntentDeclared(IntentDeclared),
    #[serde(rename = "env.sampled")]
    EnvSampled(EnvSampled),
    #[serde(rename = "context.assembled")]
    ContextAssembled(ContextAssembled),
    #[serde(rename = "model.requested")]
    ModelRequested(ModelRequested),
    #[serde(rename = "model.responded")]
    ModelResponded(ModelResponded),
    #[serde(rename = "plan.step")]
    PlanStep(PlanStep),
    #[serde(rename = "tool.requested")]
    ToolRequested(ToolRequested),
    #[serde(rename = "policy.evaluated")]
    PolicyEvaluated(PolicyEvaluated),
    #[serde(rename = "impact.estimated")]
    ImpactEstimated(ImpactEstimated),
    #[serde(rename = "effect.dispatched")]
    EffectDispatched(EffectDispatched),
    #[serde(rename = "tool.result")]
    ToolResult(ToolResult),
    #[serde(rename = "cost.charged")]
    CostCharged(CostCharged),
    #[serde(rename = "checkpoint")]
    Checkpoint(Checkpoint),
    #[serde(rename = "run.completed")]
    RunCompleted(RunCompleted),
}

impl EventBody {
    /// 写进 run_events.kind 列的字符串。必须与 01 §4 的目录逐字一致。
    pub fn kind(&self) -> &'static str {
        match self {
            Self::RunCreated(_) => "run.created",
            Self::IntentDeclared(_) => "intent.declared",
            Self::EnvSampled(_) => "env.sampled",
            Self::ContextAssembled(_) => "context.assembled",
            Self::ModelRequested(_) => "model.requested",
            Self::ModelResponded(_) => "model.responded",
            Self::PlanStep(_) => "plan.step",
            Self::ToolRequested(_) => "tool.requested",
            Self::PolicyEvaluated(_) => "policy.evaluated",
            Self::ImpactEstimated(_) => "impact.estimated",
            Self::EffectDispatched(_) => "effect.dispatched",
            Self::ToolResult(_) => "tool.result",
            Self::CostCharged(_) => "cost.charged",
            Self::Checkpoint(_) => "checkpoint",
            Self::RunCompleted(_) => "run.completed",
        }
    }

    /// 事件级版本号，不是全局版本号。加 optional 字段不升版；改语义必须升。
    ///
    /// 用穷尽 match 而非一个常量：新增 `EventBody` 变体时，少一个 match arm
    /// 编译器就会拒绝通过，逼着作者当场为新变体显式声明 schema_ver，而不是
    /// 指望"记得回来改"。
    pub fn schema_ver(&self) -> u32 {
        match self {
            Self::RunCreated(_) => 1,
            Self::IntentDeclared(_) => 1,
            Self::EnvSampled(_) => 1,
            Self::ContextAssembled(_) => 1,
            Self::ModelRequested(_) => 1,
            Self::ModelResponded(_) => 1,
            Self::PlanStep(_) => 1,
            Self::ToolRequested(_) => 1,
            Self::PolicyEvaluated(_) => 1,
            Self::ImpactEstimated(_) => 1,
            Self::EffectDispatched(_) => 1,
            Self::ToolResult(_) => 1,
            Self::CostCharged(_) => 1,
            Self::Checkpoint(_) => 1,
            Self::RunCompleted(_) => 1,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::blob::BlobRef;
    use crate::budget::BudgetSpec;
    use crate::effect::{EffectClass, ResourceOp, ResourceRef};
    use crate::events::accounting::{CheckpointReason, CostDimension, CostUnit, Currency};
    use crate::events::context::ContextBlock;
    use crate::events::determinism::{EnvSampled, ModelRoute};
    use crate::events::effect::{
        ExecutionMode, ImpactPrecision, ImpactTarget, PolicyDecisionKind, ToolResultStatus,
    };
    use crate::events::lifecycle::{CompletionStatus, PrincipalRef, TriggerKind, TriggerRef};
    use crate::events::model::{ModelParams, PlanIntent, Usage};
    use crate::ids::{CheckpointId, CiteId, EffectId, ExecutorId, LeaseId, ToolId};
    use crate::taint::{TaintLevel, TrustLevel};
    use std::collections::BTreeMap;

    fn sample_event() -> Event {
        Event {
            run_id: RunId::from("r-001"),
            seq: 3,
            recorded_at: "2026-08-29T10:00:00Z".to_owned(),
            actor: Actor::Runtime,
            schema_ver: 1,
            body: EventBody::EnvSampled(EnvSampled {
                turn: 0,
                wall_clock_ms: 1_756_461_600_000,
                rng_seed: "seed-0".to_owned(),
                env: BTreeMap::new(),
                model_route: ModelRoute {
                    provider: "fixture".to_owned(),
                    model: "fixture-v1".to_owned(),
                    params_digest: "d0".to_owned(),
                },
            }),
        }
    }

    #[test]
    fn kind_string_matches_the_catalog_in_doc_01() {
        assert_eq!(sample_event().body.kind(), "env.sampled");
    }

    #[test]
    fn body_serialises_with_the_kind_tag_inline() {
        let v = serde_json::to_value(&sample_event().body).unwrap();
        assert_eq!(v["kind"], "env.sampled");
        assert_eq!(v["wall_clock_ms"], 1_756_461_600_000u64);
    }

    #[test]
    fn body_roundtrips_through_the_payload_column() {
        let body = sample_event().body;
        let payload = serde_json::to_string(&body).unwrap();
        let back: EventBody = serde_json::from_str(&payload).unwrap();
        assert_eq!(back, body);
    }

    #[test]
    fn unknown_optional_fields_do_not_break_decoding() {
        // 红线 3：新增 optional 字段后，旧解码路径必须还能读新 payload。
        let payload = r#"{"kind":"plan.step","turn":0,"intent":"finish",
                          "taint_inherited":"clean","some_future_field":42}"#;
        let back: EventBody = serde_json::from_str(payload).unwrap();
        assert_eq!(back.kind(), "plan.step");
    }

    /// 15 个事件变体各给一份合法样本。谁给某个事件结构体加了
    /// `deny_unknown_fields`，下面的穷尽容忍测试就会因为这个样本变红。
    fn all_event_bodies() -> Vec<EventBody> {
        vec![
            EventBody::RunCreated(RunCreated {
                run_id: RunId::from("r-001"),
                parent_run_id: None,
                workspace_id: "ws-1".to_owned(),
                principal: PrincipalRef {
                    kind: "user".to_owned(),
                    id: "u-1".to_owned(),
                },
                trigger: TriggerRef {
                    kind: TriggerKind::Manual,
                    reference: "cli".to_owned(),
                },
                budget: BudgetSpec::default(),
                labels: BTreeMap::new(),
            }),
            EventBody::IntentDeclared(IntentDeclared {
                intent_ref: BlobRef {
                    content_hash: "sha256:aaa".to_owned(),
                    size: 10,
                    mime: "text/plain".to_owned(),
                },
                char_len: 10,
                lang: "zh".to_owned(),
                source: "user".to_owned(),
            }),
            EventBody::EnvSampled(EnvSampled {
                turn: 0,
                wall_clock_ms: 1_756_461_600_000,
                rng_seed: "seed-0".to_owned(),
                env: BTreeMap::new(),
                model_route: ModelRoute {
                    provider: "fixture".to_owned(),
                    model: "fixture-v1".to_owned(),
                    params_digest: "d0".to_owned(),
                },
            }),
            EventBody::ContextAssembled(ContextAssembled {
                turn: 0,
                profile: "default".to_owned(),
                blocks: vec![ContextBlock {
                    cite_id: CiteId::from("c-1"),
                    source: "doc".to_owned(),
                    trust: TrustLevel::OrgTrusted,
                    scope: "org".to_owned(),
                    content_hash: "sha256:bbb".to_owned(),
                    span: None,
                    token_estimate: 5,
                }],
                taint_level: TaintLevel::Clean,
                total_token_estimate: 5,
            }),
            EventBody::ModelRequested(ModelRequested {
                turn: 0,
                provider: "anthropic".to_owned(),
                model: "claude".to_owned(),
                params: ModelParams {
                    temperature: 0.0,
                    max_tokens: None,
                },
                request_digest: "d1".to_owned(),
                messages_ref: BlobRef {
                    content_hash: "sha256:ccc".to_owned(),
                    size: 1,
                    mime: "application/json".to_owned(),
                },
            }),
            EventBody::ModelResponded(ModelResponded {
                turn: 0,
                response_ref: BlobRef {
                    content_hash: "sha256:ddd".to_owned(),
                    size: 1,
                    mime: "application/json".to_owned(),
                },
                response_hash: "sha256:eee".to_owned(),
                usage: Usage::default(),
                stop_reason: "end_turn".to_owned(),
                latency_ms: 100,
            }),
            EventBody::PlanStep(PlanStep {
                turn: 0,
                intent: PlanIntent::Finish,
                rationale_ref: None,
                taint_inherited: TaintLevel::Clean,
                call: None,
            }),
            EventBody::ToolRequested(ToolRequested {
                effect_id: EffectId::from("e-1"),
                turn: 0,
                tool: ToolId::from("t-1"),
                params_ref: BlobRef {
                    content_hash: "sha256:fff".to_owned(),
                    size: 1,
                    mime: "application/json".to_owned(),
                },
                params_digest: "d2".to_owned(),
                class: EffectClass::Read,
                declared_targets: vec![],
                declared_egress: vec![],
                reversible: true,
                cites_referenced: vec![],
            }),
            EventBody::PolicyEvaluated(PolicyEvaluated {
                effect_id: EffectId::from("e-1"),
                decision: PolicyDecisionKind::Allow,
                rules_hit: vec![],
                policy_ver: "v1".to_owned(),
                reason_code: "ok".to_owned(),
            }),
            EventBody::ImpactEstimated(ImpactEstimated {
                effect_id: EffectId::from("e-1"),
                targets: vec![ImpactTarget {
                    resource: ResourceRef {
                        kind: "file".to_owned(),
                        id: "f-1".to_owned(),
                    },
                    op: ResourceOp::Read,
                    detail_ref: None,
                }],
                externals: vec![],
                est_cost_micros: None,
                precision: ImpactPrecision::DeclaredOnly,
            }),
            EventBody::EffectDispatched(EffectDispatched {
                effect_id: EffectId::from("e-1"),
                executor_id: ExecutorId::from("x-1"),
                lease_id: LeaseId::from("l-1"),
                mode: ExecutionMode::Live,
            }),
            EventBody::ToolResult(ToolResult {
                effect_id: EffectId::from("e-1"),
                status: ToolResultStatus::Ok,
                output_ref: None,
                bytes: None,
                taint: TaintLevel::Clean,
                cites_produced: vec![],
                actual_targets: vec![],
                actual_egress: vec![],
            }),
            EventBody::CostCharged(CostCharged {
                effect_id: None,
                turn: None,
                unit: CostUnit::Call,
                quantity: 1,
                unit_price_micros: 1,
                amount_micros: 1,
                currency: Currency::CNY,
                price_table_ver: "v1".to_owned(),
                dimension: CostDimension {
                    principal: "u-1".to_owned(),
                    team: None,
                    run_id: RunId::from("r-001"),
                    skill: None,
                    tool: None,
                },
            }),
            EventBody::Checkpoint(Checkpoint {
                checkpoint_id: CheckpointId::from("cp-1"),
                state_hash: "sha256:ggg".to_owned(),
                snapshot_ref: None,
                reason: CheckpointReason::Periodic,
            }),
            EventBody::RunCompleted(RunCompleted {
                status: CompletionStatus::Ok,
                summary_ref: None,
            }),
        ]
    }

    #[test]
    fn all_15_variants_tolerate_unknown_optional_fields() {
        // 红线 3 的穷尽版：unknown_optional_fields_do_not_break_decoding 只锁住了
        // plan.step 一个变体，若有人给其余 14 个事件结构体之一加上
        // `#[serde(deny_unknown_fields)]`，那条测试并不会变红。这里对全部 15 个
        // 变体各自序列化、注入一个未来才会出现的字段、再解码，逐一验证旧解码
        // 路径能读进新 payload。
        let bodies = all_event_bodies();
        assert_eq!(bodies.len(), 15, "事件目录变了就要同步补全这份穷尽样本");

        for body in bodies {
            let mut value = serde_json::to_value(&body).unwrap();
            value
                .as_object_mut()
                .expect("EventBody 序列化后必须是 JSON object")
                .insert("some_future_field".to_owned(), serde_json::json!(42));

            let back: EventBody = serde_json::from_value(value)
                .unwrap_or_else(|e| panic!("variant {} 未能容忍未知字段: {e}", body.kind()));
            assert_eq!(back, body, "variant {} 解码结果与原样本不一致", body.kind());
        }
    }
}
