use evo_gateway::{AdmitRequest, Gateway, GatewayAction, ManifestRegistry};
use evo_policy::{HardcodedPolicy, RiskLevel};
use evo_protocol::effect::CapabilityToken;
use evo_protocol::events::effect::{ExecutionMode, PolicyDecisionKind, ToolResultStatus};
use evo_protocol::events::model::PlannedCall;
use evo_protocol::{BlobRef, EffectClass, EffectId, EventBody, RunId, TaintLevel, ToolId};

const TOOLS: &str = r#"
[[method]]
name = "fs.write"
class = "write"
reversible = true
targets = [{ from_param = "/path", kind = "file", op = "update" }]

[[method]]
name = "fs.read"
class = "read"
reversible = true
targets = [{ from_param = "/path", kind = "file", op = "read" }]
"#;

const POLICY: &str = r#"
version = "poc-1"

[[rule]]
id = "read-is-free"
class = "read"
decision = "allow"

[[rule]]
id = "external-needs-approval"
class = "external"
decision = "require_approval"
risk = "l3"
"#;

fn gateway() -> Gateway {
    Gateway::new(
        Box::new(HardcodedPolicy::from_toml_str(POLICY).unwrap()),
        ManifestRegistry::from_toml_str(TOOLS).unwrap(),
    )
}

fn admit(tool: &str, taint: TaintLevel, mode: ExecutionMode) -> AdmitRequest {
    AdmitRequest {
        effect_id: EffectId::from("e-1"),
        run_id: RunId::from("r-1"),
        turn: 0,
        call: PlannedCall {
            tool: ToolId::from(tool),
            params_ref: BlobRef {
                content_hash: "sha256:aa".into(),
                size: 2,
                mime: "application/json".into(),
            },
            params_digest: "d1".into(),
        },
        params: serde_json::json!({ "path": "report.txt", "content": "x" }),
        taint,
        cites_referenced: Vec::new(),
        capability: CapabilityToken {
            subject: "u-1".into(),
            scopes: vec!["*".into()],
        },
        mode,
    }
}

fn kinds(v: &[EventBody]) -> Vec<&'static str> {
    v.iter().map(|e| e.kind()).collect()
}

#[test]
fn every_step_writes_an_event_so_the_gateway_itself_is_replayable() {
    let verdict = gateway().admit(admit("fs.write", TaintLevel::Clean, ExecutionMode::Live));
    assert_eq!(
        kinds(&verdict.events),
        vec!["tool.requested", "policy.evaluated", "impact.estimated"]
    );
}

#[test]
fn manifest_fields_are_filled_by_the_gateway_not_the_tool() {
    let verdict = gateway().admit(admit("fs.write", TaintLevel::Clean, ExecutionMode::Live));
    let GatewayAction::Dispatch(req) = verdict.action else {
        panic!("应当派发")
    };
    assert_eq!(req.class, EffectClass::Write);
    assert!(req.reversible);
    assert_eq!(req.targets.len(), 1, "targets 从 /path 静态提取");
    assert_eq!(req.targets[0].id, "report.txt");
}

#[test]
fn the_rule_that_decided_is_named_in_the_event() {
    let verdict = gateway().admit(admit("fs.read", TaintLevel::Clean, ExecutionMode::Live));
    let pe = verdict
        .events
        .iter()
        .find(|e| e.kind() == "policy.evaluated")
        .unwrap();
    let EventBody::PolicyEvaluated(pe) = pe else {
        unreachable!()
    };
    assert_eq!(
        pe.rules_hit,
        vec!["read-is-free".to_owned()],
        "审计要能回答「凭哪条规则放的行」"
    );
    assert_eq!(pe.policy_ver, "poc-1");
}

#[test]
fn impact_is_estimated_unconditionally_not_only_in_dry_run() {
    // 02 §2 细节 2：影响预估是审计与审批材料的一部分，正常模式下也要有
    let verdict = gateway().admit(admit("fs.write", TaintLevel::Clean, ExecutionMode::Live));
    assert!(
        verdict
            .events
            .iter()
            .any(|e| e.kind() == "impact.estimated")
    );
}

#[test]
fn a_tool_with_no_manifest_gets_the_strictest_treatment() {
    // 忘记写 manifest 的后果是「多问一次人」，不是「静默漏掉治理」（02 §4）
    let verdict = gateway().admit(admit(
        "mcp:unknown/do_thing",
        TaintLevel::Clean,
        ExecutionMode::Live,
    ));
    let GatewayAction::AwaitApproval { risk, request } = verdict.action else {
        panic!("无 manifest 必须要求审批")
    };
    assert_eq!(risk, RiskLevel::L3);
    assert_eq!(request.class, EffectClass::External);
    assert!(!request.reversible);
}

#[test]
fn tainted_context_forces_approval_even_when_policy_would_allow() {
    // 03 在 04 之前：策略不能放行污点检查（02 §2 细节 1）
    let verdict = gateway().admit(admit("fs.write", TaintLevel::Tainted, ExecutionMode::Live));
    assert!(matches!(
        verdict.action,
        GatewayAction::AwaitApproval { .. }
    ));
    let pe = verdict
        .events
        .iter()
        .find(|e| e.kind() == "policy.evaluated")
        .unwrap();
    let EventBody::PolicyEvaluated(pe) = pe else {
        unreachable!()
    };
    assert_eq!(pe.decision, PolicyDecisionKind::RequireApproval);
    assert_eq!(pe.reason_code, "taint_gate");
}

#[test]
fn a_tainted_read_is_still_allowed() {
    // 污点闸门只挡 class != Read 的动作
    let verdict = gateway().admit(admit("fs.read", TaintLevel::Tainted, ExecutionMode::Live));
    assert!(matches!(verdict.action, GatewayAction::Dispatch(_)));
}

#[test]
fn dry_run_suppresses_writes_and_produces_a_tool_result() {
    let verdict = gateway().admit(admit("fs.write", TaintLevel::Clean, ExecutionMode::DryRun));
    assert!(matches!(verdict.action, GatewayAction::DryRun { .. }));
    let tr = verdict
        .events
        .iter()
        .find(|e| e.kind() == "tool.result")
        .unwrap();
    let EventBody::ToolResult(tr) = tr else {
        unreachable!()
    };
    assert_eq!(tr.status, ToolResultStatus::DryRun);
}

#[test]
fn dry_run_still_executes_reads_or_the_estimate_would_be_wrong() {
    let verdict = gateway().admit(admit("fs.read", TaintLevel::Clean, ExecutionMode::DryRun));
    assert!(
        matches!(verdict.action, GatewayAction::Dispatch(_)),
        "Read 在 dry-run 下照常执行（02 §1）"
    );
}

#[test]
fn judgement_one_a_brand_new_tool_gets_governance_for_free() {
    // 02 那条判据：新接入一个工具，不改任何治理代码，它自动获得
    // dry-run、影响预估、审计。这里的 "report.render" 只在 manifest 里
    // 声明了一行，Gateway 不认识它，治理照样生效。
    const WITH_NEW_TOOL: &str = r#"
[[method]]
name = "report.render"
class = "write"
reversible = true
targets = [{ from_param = "/path", kind = "file", op = "create" }]
"#;
    let gw = Gateway::new(
        Box::new(HardcodedPolicy::from_toml_str(POLICY).unwrap()),
        ManifestRegistry::from_toml_str(WITH_NEW_TOOL).unwrap(),
    );

    // 审计：三个事件一个不少
    let live = gw.admit(admit(
        "report.render",
        TaintLevel::Clean,
        ExecutionMode::Live,
    ));
    assert_eq!(
        kinds(&live.events),
        vec!["tool.requested", "policy.evaluated", "impact.estimated"]
    );
    // 影响预估：targets 从参数静态提取，工具作者没写一行治理代码
    let ie = live
        .events
        .iter()
        .find(|e| e.kind() == "impact.estimated")
        .unwrap();
    let EventBody::ImpactEstimated(ie) = ie else {
        unreachable!()
    };
    assert_eq!(ie.targets.len(), 1);

    // dry-run：工具完全不知道自己在 dry-run 下
    let dry = gw.admit(admit(
        "report.render",
        TaintLevel::Clean,
        ExecutionMode::DryRun,
    ));
    assert!(matches!(dry.action, GatewayAction::DryRun { .. }));
}

#[test]
fn a_capability_that_does_not_cover_the_tool_denies_the_effect() {
    let mut req = admit("fs.write", TaintLevel::Clean, ExecutionMode::Live);
    req.capability = CapabilityToken {
        subject: "u-1".into(),
        scopes: vec!["fs.read".into()],
    };
    let verdict = gateway().admit(req);
    let GatewayAction::Deny { reason_code } = verdict.action else {
        panic!("应当拒绝")
    };
    assert_eq!(reason_code, "capability_scope");
    assert!(
        verdict
            .events
            .iter()
            .any(|e| e.kind() == "policy.evaluated"),
        "被拒绝的调用是审计里最有价值的记录，必须写事件（02 §2 细节 3）"
    );
}
