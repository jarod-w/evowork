use crate::impact::estimate;
use crate::manifest::ManifestRegistry;
use evo_policy::{PolicyContext, PolicyDecision, PolicyHook, RiskLevel};
use evo_protocol::EventBody;
use evo_protocol::effect::{CapabilityToken, EffectClass, EffectRequest};
use evo_protocol::events::effect::{
    ExecutionMode, PolicyDecisionKind, PolicyEvaluated, ToolRequested, ToolResult, ToolResultStatus,
};
use evo_protocol::events::model::PlannedCall;
use evo_protocol::ids::{CiteId, EffectId, RunId};
use evo_protocol::taint::TaintLevel;

pub struct AdmitRequest {
    pub effect_id: EffectId,
    pub run_id: RunId,
    pub turn: u32,
    pub call: PlannedCall,
    /// 参数正文。daemon 从 blob 取出后传进来。
    pub params: serde_json::Value,
    pub taint: TaintLevel,
    pub cites_referenced: Vec<CiteId>,
    pub capability: CapabilityToken,
    pub mode: ExecutionMode,
}

pub enum GatewayAction {
    Dispatch(EffectRequest),
    DryRun {
        request: EffectRequest,
    },
    Deny {
        reason_code: String,
    },
    AwaitApproval {
        risk: RiskLevel,
        request: EffectRequest,
    },
}

/// Gateway 的产出：要追加哪些事件，以及接下来做什么。
///
/// **Gateway 不写 Log**——由 daemon 落盘。这是「只有 evo-daemon 写 Run Log」
/// 在类型上的形态。
pub struct GatewayVerdict {
    pub events: Vec<EventBody>,
    pub action: GatewayAction,
}

pub struct Gateway {
    policy: Box<dyn PolicyHook>,
    manifests: ManifestRegistry,
}

impl Gateway {
    pub fn new(policy: Box<dyn PolicyHook>, manifests: ManifestRegistry) -> Self {
        Self { policy, manifests }
    }

    /// 六步管线。每一步产出一个事件——**「Gateway 做了什么」本身可回放、可举证**，
    /// 而不是一堆日志行。每一步失败也要先写事件再返回。
    pub fn admit(&self, req: AdmitRequest) -> GatewayVerdict {
        let mut events = Vec::new();

        // 无 manifest 即最严
        let manifest = match self.manifests.get(&req.call.tool) {
            Some(m) => m.clone(),
            None => ManifestRegistry::strictest_default(&req.call.tool),
        };

        let targets: Vec<_> = manifest
            .targets
            .iter()
            .filter_map(|t| t.resolve(&req.params))
            .map(|(r, _)| r)
            .collect();

        let request = EffectRequest {
            effect_id: req.effect_id.clone(),
            run_id: req.run_id.clone(),
            turn: req.turn,
            tool: req.call.tool.clone(),
            params_ref: req.call.params_ref.clone(),
            params_digest: req.call.params_digest.clone(),
            class: manifest.class,
            targets: targets.clone(),
            egress: manifest.egress.clone(),
            reversible: manifest.reversible,
            taint: req.taint,
            cites_referenced: req.cites_referenced.clone(),
            capability: req.capability.clone(),
        };

        events.push(EventBody::ToolRequested(ToolRequested {
            effect_id: request.effect_id.clone(),
            turn: request.turn,
            tool: request.tool.clone(),
            params_ref: request.params_ref.clone(),
            params_digest: request.params_digest.clone(),
            class: request.class,
            declared_targets: request.targets.clone(),
            declared_egress: request.egress.clone(),
            reversible: request.reversible,
            cites_referenced: request.cites_referenced.clone(),
        }));

        let push_policy = |events: &mut Vec<EventBody>, decision, rules, reason: &str| {
            events.push(EventBody::PolicyEvaluated(PolicyEvaluated {
                effect_id: req.effect_id.clone(),
                decision,
                rules_hit: rules,
                policy_ver: self.policy.version().to_owned(),
                reason_code: reason.to_owned(),
            }));
        };

        // ① 身份解析 + ② 能力校验：权限只能收窄
        if !req.capability.allows(&request.tool) {
            push_policy(
                &mut events,
                PolicyDecisionKind::Deny,
                Vec::new(),
                "capability_scope",
            );
            return GatewayVerdict {
                events,
                action: GatewayAction::Deny {
                    reason_code: "capability_scope".to_owned(),
                },
            };
        }

        // ③ 污点检查 —— **在 ④ 之前，且不可被策略放行**
        let taint_gate = req.taint == TaintLevel::Tainted && request.class != EffectClass::Read;

        // ④ 策略求值
        let ctx = PolicyContext {
            tool: request.tool.clone(),
            class: request.class,
            taint: req.taint,
            targets,
            reversible: request.reversible,
        };
        let (policy_decision, rules_hit) = self.policy.evaluate_with_trace(&ctx);

        let decision = if taint_gate {
            // 结构性闸门：策略说 Allow 也要审批
            PolicyDecision::RequireApproval {
                risk: RiskLevel::L2,
            }
        } else {
            policy_decision
        };
        let reason = if taint_gate { "taint_gate" } else { "policy" };

        match &decision {
            PolicyDecision::Deny { reason_code } => {
                push_policy(
                    &mut events,
                    PolicyDecisionKind::Deny,
                    rules_hit,
                    reason_code,
                );
                return GatewayVerdict {
                    events,
                    action: GatewayAction::Deny {
                        reason_code: reason_code.clone(),
                    },
                };
            }
            PolicyDecision::RequireApproval { .. } => {
                push_policy(
                    &mut events,
                    PolicyDecisionKind::RequireApproval,
                    rules_hit,
                    reason,
                );
            }
            PolicyDecision::Allow => {
                push_policy(&mut events, PolicyDecisionKind::Allow, rules_hit, reason);
            }
        }

        // ⑥ 影响预估 —— **无条件执行，不只在 dry-run 时执行**
        events.push(EventBody::ImpactEstimated(estimate(
            &req.effect_id,
            &manifest,
            &req.params,
        )));

        if let PolicyDecision::RequireApproval { risk } = decision {
            return GatewayVerdict {
                events,
                action: GatewayAction::AwaitApproval { risk, request },
            };
        }

        // dry-run：Write / External 降级为 record-only，Read / Compute 照常执行
        if req.mode == ExecutionMode::DryRun && request.class.suppressed_in_dry_run() {
            events.push(EventBody::ToolResult(ToolResult {
                effect_id: req.effect_id.clone(),
                status: ToolResultStatus::DryRun,
                output_ref: None,
                bytes: None,
                taint: TaintLevel::Clean,
                cites_produced: Vec::new(),
                actual_targets: Vec::new(),
                actual_egress: Vec::new(),
            }));
            return GatewayVerdict {
                events,
                action: GatewayAction::DryRun { request },
            };
        }

        GatewayVerdict {
            events,
            action: GatewayAction::Dispatch(request),
        }
    }
}
