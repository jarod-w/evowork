use crate::events::accounting::{BudgetAmended, Checkpoint, CostCharged};
use crate::events::approval::{
    ApprovalDenied, ApprovalExpired, ApprovalGranted, ApprovalRequested,
};
use crate::events::artifact::ArtifactEmitted;
use crate::events::clarification::{ClarificationAnswered, ClarificationRequested};
use crate::events::context::{ContextAssembled, ContextCompacted};
use crate::events::determinism::EnvSampled;
use crate::events::effect::{
    EffectDispatched, ImpactEstimated, PolicyEvaluated, ToolRequested, ToolResult,
};
use crate::events::lifecycle::{
    IntentDeclared, RunCompleted, RunCreated, RunFailed, RunResumed, RunSuspended,
};
use crate::events::model::{ModelRequested, ModelResponded, PlanStep};
use crate::ids::RunId;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// 谁产生了这条事件。对应 run_events.actor 列。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
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
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
pub struct Event {
    pub run_id: RunId,
    pub seq: u64,
    /// daemon 写入时刻。内核不可见——reduce 不许读这个字段。
    pub recorded_at: String,
    pub actor: Actor,
    pub schema_ver: u32,
    pub body: EventBody,
}

/// 定义 `EventBody`、它的穷尽方法（`kind` / `schema_ver`），并在测试构建里
/// 同时生成 [`all_event_bodies`] 的穷尽样本表——枚举定义与样本表焊在
/// 同一次宏调用里。
///
/// 焊在一起的理由：`kind()` / `schema_ver()` 各自的穷尽 match 只挡得住
/// 「加了变体、忘了在这两个方法里补 arm」；它们挡不住「加了变体、`kind()`
/// / `schema_ver()` 都老实补了，唯独忘了往 `all_event_bodies()` 那个手工
/// 维护的 `Vec` 里塞一份样本」——那是三处独立维护的穷尽 match，各自穷尽
/// 不等于彼此同步。把三者从同一份变体列表生成，新增变体必须同时给出
/// `sample = ...`，少了它宏展开直接编译不过，不给「记得回来补」的空子。
macro_rules! event_body {
    ($($variant:ident($payload:ty) = $tag:literal, ver = $ver:expr, sample = $sample:expr;)+) => {
        /// 事件体。`kind` 标签内联，因此 payload 列可以整体反序列化回本枚举。
        ///
        /// 红线：本枚举的每个变体、以及它们引用的所有嵌套结构体，一律不得加
        /// `#[serde(deny_unknown_fields)]`。事件 schema 只增不改——新增字段必须是
        /// optional，旧版本解码器必须还能读进带新增字段的 payload；一旦某个事件结构体
        /// 加了 `deny_unknown_fields`，旧解码器遇到新增字段就会直接报错，当场破坏这条
        /// 契约。这条约束由
        /// `tests::all_27_variants_tolerate_unknown_optional_fields` 对全部变体
        /// 做穷尽验证——谁给某个事件结构体加了 `deny_unknown_fields`，这条测试就会红。
        ///
        /// 变体列表、`kind()`、`schema_ver()`、测试样本表由 [`event_body!`] 宏统一
        /// 生成：新增变体必须在宏调用里同时给出 `sample =`，否则编译不过。
        #[derive(Clone, Debug, PartialEq, Serialize, Deserialize, ts_rs::TS)]
        #[serde(tag = "kind")]
        pub enum EventBody {
            $(
                #[serde(rename = $tag)]
                $variant($payload),
            )+
        }

        impl EventBody {
            /// 写进 run_events.kind 列的字符串。必须与 01 §4 的目录逐字一致。
            pub fn kind(&self) -> &'static str {
                match self {
                    $(Self::$variant(_) => $tag,)+
                }
            }

            /// 事件级版本号，不是全局版本号。加 optional 字段不升版；改语义必须升。
            pub fn schema_ver(&self) -> u32 {
                match self {
                    $(Self::$variant(_) => $ver,)+
                }
            }
        }

        /// 每个变体各给一份合法样本，供
        /// `tests::all_27_variants_tolerate_unknown_optional_fields` 做穷尽容忍验证。
        #[cfg(test)]
        fn all_event_bodies() -> Vec<EventBody> {
            vec![$(EventBody::$variant($sample)),+]
        }
    };
}

// 下面这些类型只被 `sample = ...` 用到，只在测试构建里需要——真正的枚举
// payload 类型已经在文件顶部无条件 use 过了。
#[cfg(test)]
use crate::blob::BlobRef;
#[cfg(test)]
use crate::budget::BudgetSpec;
#[cfg(test)]
use crate::effect::{EffectClass, ResourceOp, ResourceRef};
#[cfg(test)]
use crate::events::accounting::{CheckpointReason, CostDimension, CostUnit, Currency};
#[cfg(test)]
use crate::events::approval::{ApprovalVia, RiskLevel};
#[cfg(test)]
use crate::events::clarification::ClarificationOption;
#[cfg(test)]
use crate::events::context::ContextBlock;
#[cfg(test)]
use crate::events::determinism::ModelRoute;
#[cfg(test)]
use crate::events::effect::{
    ExecutionMode, ImpactPrecision, ImpactTarget, PolicyDecisionKind, ToolResultStatus,
};
#[cfg(test)]
use crate::events::lifecycle::{
    CompletionStatus, ErrorDetail, PrincipalRef, SuspendReason, TriggerKind, TriggerRef,
};
#[cfg(test)]
use crate::events::model::{ModelParams, PlanIntent, Usage};
#[cfg(test)]
use crate::ids::{
    ApprovalId, ArtifactId, CheckpointId, CiteId, EffectId, ExecutorId, LeaseId, ToolId,
};
#[cfg(test)]
use crate::taint::{TaintLevel, TrustLevel};
#[cfg(test)]
use std::collections::BTreeMap;

event_body! {
    RunCreated(RunCreated) = "run.created", ver = 1, sample = RunCreated {
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
    };
    IntentDeclared(IntentDeclared) = "intent.declared", ver = 1, sample = IntentDeclared {
        intent_ref: BlobRef {
            content_hash: "sha256:aaa".to_owned(),
            size: 10,
            mime: "text/plain".to_owned(),
        },
        char_len: 10,
        lang: "zh".to_owned(),
        source: "user".to_owned(),
    };
    RunSuspended(RunSuspended) = "run.suspended", ver = 1, sample = RunSuspended {
        reason: SuspendReason::AwaitingApproval,
        detail_ref: None,
    };
    RunResumed(RunResumed) = "run.resumed", ver = 1, sample = RunResumed {
        by: Actor::Human("u-1".to_owned()),
        from_seq: 4,
    };
    RunCompleted(RunCompleted) = "run.completed", ver = 1, sample = RunCompleted {
        status: CompletionStatus::Ok,
        summary_ref: None,
    };
    RunFailed(RunFailed) = "run.failed", ver = 1, sample = RunFailed {
        at_seq: 4,
        error: ErrorDetail {
            code: "tool_error".to_owned(),
            message_ref: None,
            retryable: false,
        },
    };
    EnvSampled(EnvSampled) = "env.sampled", ver = 1, sample = EnvSampled {
        turn: 0,
        wall_clock_ms: 1_756_461_600_000,
        rng_seed: "seed-0".to_owned(),
        env: BTreeMap::new(),
        model_route: ModelRoute {
            provider: "fixture".to_owned(),
            model: "fixture-v1".to_owned(),
            params_digest: "d0".to_owned(),
        },
    };
    ContextAssembled(ContextAssembled) = "context.assembled", ver = 1, sample = ContextAssembled {
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
    };
    ContextCompacted(ContextCompacted) = "context.compacted", ver = 1, sample = ContextCompacted {
        from_seq: 1,
        to_seq: 3,
        summary_ref: BlobRef {
            content_hash: "sha256:ccc0".to_owned(),
            size: 1,
            mime: "text/plain".to_owned(),
        },
        summary_cite_id: CiteId::from("c-summary-1"),
    };
    ModelRequested(ModelRequested) = "model.requested", ver = 1, sample = ModelRequested {
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
    };
    ModelResponded(ModelResponded) = "model.responded", ver = 1, sample = ModelResponded {
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
    };
    PlanStep(PlanStep) = "plan.step", ver = 1, sample = PlanStep {
        turn: 0,
        intent: PlanIntent::Finish,
        rationale_ref: None,
        taint_inherited: TaintLevel::Clean,
        call: None,
        clarification: None,
    };
    ToolRequested(ToolRequested) = "tool.requested", ver = 1, sample = ToolRequested {
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
    };
    PolicyEvaluated(PolicyEvaluated) = "policy.evaluated", ver = 1, sample = PolicyEvaluated {
        effect_id: EffectId::from("e-1"),
        decision: PolicyDecisionKind::Allow,
        rules_hit: vec![],
        policy_ver: "v1".to_owned(),
        reason_code: "ok".to_owned(),
    };
    ImpactEstimated(ImpactEstimated) = "impact.estimated", ver = 1, sample = ImpactEstimated {
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
    };
    ApprovalRequested(ApprovalRequested) = "approval.requested", ver = 1, sample = ApprovalRequested {
        approval_id: ApprovalId::from("ap-1"),
        effect_id: EffectId::from("e-1"),
        risk: RiskLevel::L2,
        impact_ref: None,
        expires_at_ms: 1_756_461_600_000 + 3_600_000,
    };
    ApprovalGranted(ApprovalGranted) = "approval.granted", ver = 1, sample = ApprovalGranted {
        approval_id: ApprovalId::from("ap-1"),
        by: Actor::Human("u-1".to_owned()),
        via: ApprovalVia::Ui,
        note_ref: None,
    };
    ApprovalDenied(ApprovalDenied) = "approval.denied", ver = 1, sample = ApprovalDenied {
        approval_id: ApprovalId::from("ap-1"),
        by: Actor::Human("u-1".to_owned()),
        reason_ref: None,
    };
    ApprovalExpired(ApprovalExpired) = "approval.expired", ver = 1, sample = ApprovalExpired {
        approval_id: ApprovalId::from("ap-1"),
    };
    EffectDispatched(EffectDispatched) = "effect.dispatched", ver = 1, sample = EffectDispatched {
        effect_id: EffectId::from("e-1"),
        executor_id: ExecutorId::from("x-1"),
        lease_id: LeaseId::from("l-1"),
        mode: ExecutionMode::Live,
    };
    ToolResult(ToolResult) = "tool.result", ver = 1, sample = ToolResult {
        effect_id: EffectId::from("e-1"),
        status: ToolResultStatus::Ok,
        output_ref: None,
        bytes: None,
        taint: TaintLevel::Clean,
        cites_produced: vec![],
        actual_targets: vec![],
        actual_egress: vec![],
    };
    CostCharged(CostCharged) = "cost.charged", ver = 1, sample = CostCharged {
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
    };
    BudgetAmended(BudgetAmended) = "budget.amended", ver = 1, sample = BudgetAmended {
        budget: BudgetSpec {
            max_amount_micros: Some(10_000),
            ..BudgetSpec::default()
        },
        by: Actor::Human("u-1".to_owned()),
        reason_ref: None,
    };
    ArtifactEmitted(ArtifactEmitted) = "artifact.emitted", ver = 1, sample = ArtifactEmitted {
        artifact_id: ArtifactId::from("art-1"),
        path: "reports/summary.xlsx".to_owned(),
        blob: BlobRef {
            content_hash: "sha256:hhh".to_owned(),
            size: 1,
            mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                .to_owned(),
        },
        cites: vec![],
        supersedes: None,
    };
    Checkpoint(Checkpoint) = "checkpoint", ver = 1, sample = Checkpoint {
        checkpoint_id: CheckpointId::from("cp-1"),
        state_hash: "sha256:ggg".to_owned(),
        snapshot_ref: None,
        reason: CheckpointReason::Periodic,
    };
    ClarificationRequested(ClarificationRequested) = "clarification.requested", ver = 1, sample = ClarificationRequested {
        question_id: "q-1".to_owned(),
        prompt_ref: BlobRef {
            content_hash: "sha256:iii".to_owned(),
            size: 1,
            mime: "application/json".to_owned(),
        },
        options: vec![ClarificationOption {
            id: "opt-1".to_owned(),
            is_default: true,
        }],
    };
    ClarificationAnswered(ClarificationAnswered) = "clarification.answered", ver = 1, sample = ClarificationAnswered {
        question_id: "q-1".to_owned(),
        by: Actor::Human("u-1".to_owned()),
        option_id: Some("opt-1".to_owned()),
        free_text_ref: None,
    };
}

#[cfg(test)]
mod tests {
    use super::*;

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

    #[test]
    fn all_27_variants_tolerate_unknown_optional_fields() {
        // 红线 3 的穷尽版：unknown_optional_fields_do_not_break_decoding 只锁住了
        // plan.step 一个变体，若有人给其余事件结构体之一加上
        // `#[serde(deny_unknown_fields)]`，那条测试并不会变红。这里对全部 26 个
        // 变体各自序列化、注入一个未来才会出现的字段、再解码，逐一验证旧解码
        // 路径能读进新 payload。
        let bodies = all_event_bodies();
        assert_eq!(bodies.len(), 27, "事件目录变了就要同步补全这份穷尽样本");

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

    #[test]
    fn the_event_catalog_covers_every_kind_the_contract_lists() {
        // 契约文档 01 §4 的事件目录。新增事件必须同步这份清单——
        // 它是「实现有没有偏离契约」的唯一可执行对照物。`run.spawned` /
        // `run.joined` 标 [P2]（子 Agent，属后续 Phase），本次不加。
        //
        // `budget.amended` 是 M2 接通预算闸门时补入的：文档原目录里没有它，
        // 因为原设计以为「人提额续跑」不需要自己的事件。实际上不行——
        // `RunState::budget` 除了 `run.created` 没有任何写入方，提额只能靠
        // 绕过 Log 直接改内存状态，那样的状态在 Log 上不可复现。补入的同时
        // 01 §4.5 也已同步。
        let expected = [
            "run.created",
            "intent.declared",
            "run.suspended",
            "run.resumed",
            "run.completed",
            "run.failed",
            "env.sampled",
            "context.assembled",
            "context.compacted",
            "model.requested",
            "model.responded",
            "plan.step",
            "tool.requested",
            "policy.evaluated",
            "impact.estimated",
            "approval.requested",
            "approval.granted",
            "approval.denied",
            "approval.expired",
            "effect.dispatched",
            "tool.result",
            "cost.charged",
            "budget.amended",
            "artifact.emitted",
            "checkpoint",
            "clarification.requested",
            "clarification.answered",
        ];
        let actual: std::collections::BTreeSet<&str> =
            all_event_bodies().iter().map(|b| b.kind()).collect();
        let expected_set: std::collections::BTreeSet<&str> = expected.into_iter().collect();
        assert_eq!(actual, expected_set, "事件目录与契约文档 01 §4 不一致");
    }
}
