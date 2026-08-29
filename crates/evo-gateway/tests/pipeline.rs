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
fn the_taint_gate_only_tightens_allow_it_never_loosens_a_deny() {
    // 污点闸门以前的写法是无条件覆盖 policy_decision，如果策略本来判定 Deny，
    // taint_gate 命中会把它覆盖成 RequireApproval——等于把一次拒绝"放宽"成了
    // 可审批通过。这里用一条明确 deny fs.write 的策略 + tainted 输入复现，
    // 断言结果仍然是 Deny。
    const DENY_FS_WRITE: &str = r#"
version = "poc-1"

[[rule]]
id = "deny-fs-write"
tool = "fs.write"
decision = "deny"
"#;
    let gw = Gateway::new(
        Box::new(HardcodedPolicy::from_toml_str(DENY_FS_WRITE).unwrap()),
        ManifestRegistry::from_toml_str(TOOLS).unwrap(),
    );
    let verdict = gw.admit(admit("fs.write", TaintLevel::Tainted, ExecutionMode::Live));
    let GatewayAction::Deny { reason_code } = verdict.action else {
        panic!("策略 Deny 时，即使这次调用摸到了污点数据，也必须仍然是 Deny")
    };
    assert_eq!(reason_code, "deny-fs-write");
}

#[test]
fn the_taint_gate_never_downgrades_a_policy_risk_that_is_already_higher() {
    // re-review 实测复现的缺陷：策略已经判 RequireApproval { risk: L3 }
    // （比如 class = "external" 命中 external-needs-approval），这次调用
    // 又恰好 tainted，污点闸门以前硬编码 risk: L2，等于把 L3 压低成 L2——
    // 一个本该逐条审批、不可批量放行的高危操作，被闸门"放宽"成了可以批量
    // 放行的档位。闸门只应该保底抬升，绝不能压低策略已经给出的档位。
    const EXTERNAL_TOOL: &str = r#"
[[method]]
name = "net.send"
class = "external"
reversible = false
targets = []
"#;
    let gw = Gateway::new(
        Box::new(HardcodedPolicy::from_toml_str(POLICY).unwrap()),
        ManifestRegistry::from_toml_str(EXTERNAL_TOOL).unwrap(),
    );
    let verdict = gw.admit(admit("net.send", TaintLevel::Tainted, ExecutionMode::Live));
    let GatewayAction::AwaitApproval { risk, .. } = verdict.action else {
        panic!("污点 + external 都要求审批")
    };
    assert_eq!(risk, RiskLevel::L3, "策略原判的 L3 不能被污点闸门降级成 L2");
    let pe = verdict
        .events
        .iter()
        .find(|e| e.kind() == "policy.evaluated")
        .unwrap();
    let EventBody::PolicyEvaluated(pe) = pe else {
        unreachable!()
    };
    assert_eq!(pe.reason_code, "taint_gate");
}

#[test]
fn the_taint_gate_still_floors_an_allow_at_l2() {
    // 回归：策略判 Allow（本例：fs.write 没有命中任何规则，HardcodedPolicy
    // 兜底为 Allow）+ 污点闸门命中 —— 结果仍然是 RequireApproval { risk: L2 }，
    // 确认「至少 L2」的保底没有被这轮修复带走。
    let verdict = gateway().admit(admit("fs.write", TaintLevel::Tainted, ExecutionMode::Live));
    let GatewayAction::AwaitApproval { risk, .. } = verdict.action else {
        panic!("污点闸门必须要求审批")
    };
    assert_eq!(risk, RiskLevel::L2);
}

#[test]
fn the_taint_gate_lifts_an_l1_policy_risk_up_to_l2() {
    // 策略给出的是 RequireApproval { risk: L1 }（不是 Allow），污点闸门命中后
    // 应该把它抬到 L2——闸门的保底线是 L2，不是「原样透传」。
    const L1_THEN_TAINT: &str = r#"
version = "poc-1"

[[rule]]
id = "fs-write-is-l1"
tool = "fs.write"
decision = "require_approval"
risk = "l1"
"#;
    let gw = Gateway::new(
        Box::new(HardcodedPolicy::from_toml_str(L1_THEN_TAINT).unwrap()),
        ManifestRegistry::from_toml_str(TOOLS).unwrap(),
    );
    let verdict = gw.admit(admit("fs.write", TaintLevel::Tainted, ExecutionMode::Live));
    let GatewayAction::AwaitApproval { risk, .. } = verdict.action else {
        panic!("污点闸门必须要求审批")
    };
    assert_eq!(risk, RiskLevel::L2, "污点闸门把 L1 抬到保底的 L2");
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
fn a_tool_with_no_manifest_is_forced_to_approval_even_when_no_policy_rule_would_catch_it() {
    // 复现 review 找到的缺口：客户策略文件里如果没配那条 external -> require_approval
    // 规则（这里只有 read -> allow），HardcodedPolicy 的兜底会返回 Allow，
    // strictest_default 标的 External 就被悄悄吃掉。manifest 闸门必须在
    // Gateway 里结构性地兜住这个洞，不依赖策略文件配没配那条规则。
    const POLICY_WITHOUT_EXTERNAL_RULE: &str = r#"
version = "poc-1"

[[rule]]
id = "read-is-free"
class = "read"
decision = "allow"
"#;
    let gw = Gateway::new(
        Box::new(HardcodedPolicy::from_toml_str(POLICY_WITHOUT_EXTERNAL_RULE).unwrap()),
        ManifestRegistry::from_toml_str(TOOLS).unwrap(),
    );
    let verdict = gw.admit(admit(
        "mcp:unknown/do_thing",
        TaintLevel::Clean,
        ExecutionMode::Live,
    ));
    let GatewayAction::AwaitApproval { risk, .. } = verdict.action else {
        panic!("无 manifest 必须要求审批，即使策略文件里没有覆盖它的规则")
    };
    assert_eq!(risk, RiskLevel::L3);
    let pe = verdict
        .events
        .iter()
        .find(|e| e.kind() == "policy.evaluated")
        .unwrap();
    let EventBody::PolicyEvaluated(pe) = pe else {
        unreachable!()
    };
    assert_eq!(pe.reason_code, "no_manifest");
}

#[test]
fn the_manifest_gate_only_tightens_allow_it_never_loosens_a_deny() {
    // 闸门是用来收紧的，不是用来放宽的：策略把一切都 deny 掉时，
    // 无 manifest 的工具仍然应该是 Deny，不能被闸门"升级"成 RequireApproval。
    const DENY_EVERYTHING: &str = r#"
version = "poc-1"

[[rule]]
id = "deny-all"
decision = "deny"
"#;
    let gw = Gateway::new(
        Box::new(HardcodedPolicy::from_toml_str(DENY_EVERYTHING).unwrap()),
        ManifestRegistry::from_toml_str(TOOLS).unwrap(),
    );
    let verdict = gw.admit(admit(
        "mcp:unknown/do_thing",
        TaintLevel::Clean,
        ExecutionMode::Live,
    ));
    let GatewayAction::Deny { reason_code } = verdict.action else {
        panic!("策略 Deny 时，即使 manifest 缺失也必须仍然是 Deny")
    };
    assert_eq!(reason_code, "deny-all");
}

#[test]
fn a_declared_tool_is_not_affected_by_the_manifest_gate() {
    // 回归：已经写了 manifest 的工具不应该被这个闸门误伤——它只应该管
    // manifest 缺失的那条路径。
    let verdict = gateway().admit(admit("fs.write", TaintLevel::Clean, ExecutionMode::Live));
    assert!(matches!(verdict.action, GatewayAction::Dispatch(_)));
    let pe = verdict
        .events
        .iter()
        .find(|e| e.kind() == "policy.evaluated")
        .unwrap();
    let EventBody::PolicyEvaluated(pe) = pe else {
        unreachable!()
    };
    assert_eq!(pe.reason_code, "policy");
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
