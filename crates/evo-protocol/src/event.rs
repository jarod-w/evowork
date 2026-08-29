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
    pub fn schema_ver(&self) -> u32 {
        1
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::events::determinism::{EnvSampled, ModelRoute};
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
}
