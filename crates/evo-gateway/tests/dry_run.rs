//! dry-run 三级降级（02 §3）与审批路径素材的集成测试。
//!
//! `tests/pipeline.rs` 已经覆盖六步管线的接线与 `tighten` 闸门；这个文件
//! 专门测三件事：
//!   1. 三级降级各自的产出（`Exact` / `DeclaredOnly` 两种 precision，第 2、3
//!      级靠 targets 是否非空区分）。
//!   2. 第 2、3 级不阻塞接入——没有 preview、targets 也提取不出来的工具，
//!      仍然拿到完整治理。
//!   3. `Read` 在 dry-run 下照常执行、`External` 在 dry-run 下永不自动放行
//!      这两条回归。

use evo_gateway::{AdmitRequest, Gateway, GatewayAction, ManifestRegistry, PreviewOutcome};
use evo_policy::HardcodedPolicy;
use evo_protocol::budget::{BudgetSpec, BudgetUsage};
use evo_protocol::effect::{CapabilityToken, ResourceOp, ResourceRef};
use evo_protocol::events::effect::{ExecutionMode, ImpactPrecision, ToolResultStatus};
use evo_protocol::events::model::PlannedCall;
use evo_protocol::{BlobRef, EffectId, EventBody, RunId, TaintLevel, ToolId};

/// 每条规则都判 `allow`——这样测试能单独看 dry-run 的降级/抑制行为，
/// 不被"这条 effect 本来就要审批"混进来。
const ALLOW_EVERYTHING: &str = r#"
version = "poc-1"

[[rule]]
id = "read-is-free"
class = "read"
decision = "allow"

[[rule]]
id = "write-is-allowed"
class = "write"
decision = "allow"

[[rule]]
id = "external-is-allowed"
class = "external"
decision = "allow"
"#;

const TOOLS: &str = r#"
[[method]]
name = "fs.read"
class = "read"
reversible = true
targets = [{ from_param = "/path", kind = "file", op = "read" }]

[[method]]
name = "fs.write"
class = "write"
reversible = true
targets = [{ from_param = "/path", kind = "file", op = "update" }]

[[method]]
name = "doc.render"
class = "write"
reversible = true
targets = [{ from_param = "/path", kind = "file", op = "create" }]
preview = "doc.render.preview"

[[method]]
name = "shell.exec"
class = "write"
reversible = false

[[method]]
name = "wecom.send"
class = "external"
reversible = false
"#;

fn gateway() -> Gateway {
    Gateway::new(
        Box::new(HardcodedPolicy::from_toml_str(ALLOW_EVERYTHING).unwrap()),
        ManifestRegistry::from_toml_str(TOOLS).unwrap(),
    )
}

fn gateway_with_manifest(tools: &str) -> Gateway {
    Gateway::new(
        Box::new(HardcodedPolicy::from_toml_str(ALLOW_EVERYTHING).unwrap()),
        ManifestRegistry::from_toml_str(tools).unwrap(),
    )
}

fn admit(tool: &str, params: serde_json::Value, mode: ExecutionMode) -> AdmitRequest {
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
        params,
        taint: TaintLevel::Clean,
        cites_referenced: Vec::new(),
        capability: CapabilityToken {
            subject: "u-1".into(),
            scopes: vec!["*".into()],
        },
        mode,
        // 预算闸门（第⑤步）的输入。这些测试关心的是 ①–④ 与 ⑥，
        // 全 `None` = 不设限，闸门永远放行，不干扰它们的判定。
        // 第⑤步自己的测试在 tests/budget_gate.rs。
        budget: BudgetSpec::default(),
        budget_used: BudgetUsage::default(),
    }
}

fn kinds(v: &[EventBody]) -> Vec<&'static str> {
    v.iter().map(|e| e.kind()).collect()
}

fn find_impact(v: &[EventBody]) -> &evo_protocol::events::effect::ImpactEstimated {
    let ie = v
        .iter()
        .find(|e| e.kind() == "impact.estimated")
        .expect("impact.estimated 事件必须存在");
    let EventBody::ImpactEstimated(ie) = ie else {
        unreachable!()
    };
    ie
}

// ── 第 1 级：manifest 声明了 preview ──────────────────────────────────────

#[test]
fn level_1_a_tool_that_declares_preview_yields_need_preview_first() {
    // admit() 做不了 IO：撞见声明了 preview 的工具，先停下来交还上下文，
    // 不能自己悄悄调 preview，也不能假装没这回事直接派发。
    let gw = gateway();
    let verdict = gw.admit(admit(
        "doc.render",
        serde_json::json!({ "path": "q3.docx" }),
        ExecutionMode::Live,
    ));
    // 分岔之前的两个事件已经落好，preview 悬而未决不耽误审计。
    assert_eq!(
        kinds(&verdict.events),
        vec!["tool.requested", "policy.evaluated"]
    );
    let GatewayAction::NeedPreview { pending } = verdict.action else {
        panic!("声明了 preview 的工具必须先产出 NeedPreview")
    };
    assert_eq!(pending.preview_method(), "doc.render.preview");
    assert_eq!(pending.tool().as_str(), "doc.render");
}

#[test]
fn level_1_resuming_with_a_preview_outcome_yields_exact_precision() {
    let gw = gateway();
    let verdict = gw.admit(admit(
        "doc.render",
        serde_json::json!({ "path": "q3.docx" }),
        ExecutionMode::Live,
    ));
    let GatewayAction::NeedPreview { pending } = verdict.action else {
        panic!("应当先要 preview")
    };

    let preview = PreviewOutcome {
        targets: vec![evo_protocol::events::effect::ImpactTarget {
            resource: ResourceRef {
                kind: "voucher".into(),
                id: "V-2026-001".into(),
            },
            op: ResourceOp::Create,
            detail_ref: None,
        }],
        est_cost_micros: Some(1200),
    };
    let resumed = gw.admit_with_preview(pending, Some(preview));

    assert_eq!(kinds(&resumed.events), vec!["impact.estimated"]);
    let ie = find_impact(&resumed.events);
    assert_eq!(
        ie.precision,
        ImpactPrecision::Exact,
        "调过 preview 就是精确降级"
    );
    assert_eq!(ie.targets.len(), 1);
    assert_eq!(ie.targets[0].resource.id, "V-2026-001");
    assert_eq!(ie.est_cost_micros, Some(1200));
    assert!(matches!(resumed.action, GatewayAction::Dispatch(_)));
}

#[test]
fn level_1_resuming_with_no_preview_result_falls_back_to_declared_only() {
    // executor 暂时没接上真正的 preview 调用：`None` 不阻塞接入，只是精度
    // 降一档——判据 1 的延伸。
    let gw = gateway();
    let verdict = gw.admit(admit(
        "doc.render",
        serde_json::json!({ "path": "q3.docx" }),
        ExecutionMode::Live,
    ));
    let GatewayAction::NeedPreview { pending } = verdict.action else {
        panic!("应当先要 preview")
    };
    let resumed = gw.admit_with_preview(pending, None);
    let ie = find_impact(&resumed.events);
    assert_eq!(ie.precision, ImpactPrecision::DeclaredOnly);
    assert_eq!(ie.targets.len(), 1, "退回静态提取，targets 从 /path 拿到");
    assert!(matches!(resumed.action, GatewayAction::Dispatch(_)));
}

// ── 第 2 级：未声明 preview，targets 能从参数静态提取 ─────────────────────

#[test]
fn level_2_targets_statically_extracted_from_params_are_declared_only() {
    let gw = gateway();
    let verdict = gw.admit(admit(
        "fs.write",
        serde_json::json!({ "path": "report.txt" }),
        ExecutionMode::Live,
    ));
    let ie = find_impact(&verdict.events);
    assert_eq!(ie.precision, ImpactPrecision::DeclaredOnly);
    assert_eq!(ie.targets.len(), 1, "「将触碰这些资源」清单来自 /path");
    assert_eq!(ie.targets[0].resource.id, "report.txt");
    assert!(matches!(verdict.action, GatewayAction::Dispatch(_)));
}

// ── 第 3 级：targets 提取不出来（如 shell.exec）────────────────────────────

#[test]
fn level_3_a_tool_with_no_extractable_targets_gets_an_empty_declared_only_estimate() {
    // shell.exec 一类：manifest 没声明 targets（Agent 可以执行任意命令，
    // 静态分析管不住），估不出具体资源，但仍然是 DeclaredOnly，不是拒绝
    // 或报错。
    let gw = gateway();
    let verdict = gw.admit(admit(
        "shell.exec",
        serde_json::json!({ "command": "rm -rf /tmp/scratch" }),
        ExecutionMode::Live,
    ));
    let ie = find_impact(&verdict.events);
    assert_eq!(ie.precision, ImpactPrecision::DeclaredOnly);
    assert!(
        ie.targets.is_empty(),
        "targets 提取不出来时清单应为空，不是伪造一个"
    );
}

#[test]
fn level_2_and_3_tools_are_not_blocked_from_admission_and_get_full_governance() {
    // 判据 1 的延伸：一个既没有 preview、targets 也提取不出来的工具
    // （shell.exec），仍然要拿到完整治理——三个审计事件一个不少，
    // 影响预估照给（只是 precision 是 DeclaredOnly），dry-run 也照样降级，
    // 不需要工具作者写一行治理代码。
    let gw = gateway();

    let live = gw.admit(admit(
        "shell.exec",
        serde_json::json!({ "command": "pip install -r requirements.txt" }),
        ExecutionMode::Live,
    ));
    assert_eq!(
        kinds(&live.events),
        vec!["tool.requested", "policy.evaluated", "impact.estimated"]
    );
    assert!(
        matches!(live.action, GatewayAction::Dispatch(_)),
        "没有 preview、targets 也提取不出来，不代表要被挡在 Gateway 外面"
    );

    let dry = gw.admit(admit(
        "shell.exec",
        serde_json::json!({ "command": "pip install -r requirements.txt" }),
        ExecutionMode::DryRun,
    ));
    assert!(
        matches!(dry.action, GatewayAction::DryRun { .. }),
        "dry-run 三级降级里第 3 级同样要降级为 record-only"
    );
}

// ── 回归：Read 在 dry-run 下照常执行 ───────────────────────────────────────

#[test]
fn a_read_still_executes_under_dry_run_because_the_estimate_would_be_wrong_otherwise() {
    let gw = gateway();
    let verdict = gw.admit(admit(
        "fs.read",
        serde_json::json!({ "path": "report.txt" }),
        ExecutionMode::DryRun,
    ));
    assert!(
        matches!(verdict.action, GatewayAction::Dispatch(_)),
        "Read 在 dry-run 下必须照常执行（02 §1 / §3）"
    );
}

// ── 回归：External 在 dry-run 下永不自动放行 ───────────────────────────────

#[test]
fn external_never_auto_dispatches_under_dry_run_even_when_policy_would_allow() {
    // ALLOW_EVERYTHING 里 external 也是 allow——刻意的：这条测试要单独证明
    // "External 在 dry-run 下永不自动放行" 是结构性的（class.suppressed_in_dry_run），
    // 不是靠策略恰好没放行才躲过去的。
    let gw = gateway();
    let verdict = gw.admit(admit(
        "wecom.send",
        serde_json::json!({ "to": "finance-group" }),
        ExecutionMode::DryRun,
    ));
    assert!(
        matches!(verdict.action, GatewayAction::DryRun { .. }),
        "External 在 dry-run 下即使策略判 Allow 也绝不能变成 Dispatch"
    );
    let tr = verdict
        .events
        .iter()
        .find(|e| e.kind() == "tool.result")
        .expect("record-only 也要留一条 tool.result");
    let EventBody::ToolResult(tr) = tr else {
        unreachable!()
    };
    assert_eq!(tr.status, ToolResultStatus::DryRun);
}

// ── 判据 1 回归：Gateway 代码里不存在的新工具，只在 manifest 里声明 ────────

#[test]
fn judgement_one_a_brand_new_tool_with_preview_gets_full_governance_for_free() {
    // "crm.update_deal" 是 Gateway 代码里完全不存在的工具，只在这条测试的
    // manifest 字符串里声明了一行——包括 preview。它应当自动获得：
    // 三个审计事件、影响预估（可升到 Exact）、dry-run 三级降级，
    // 工具作者不写一行治理代码。
    const WITH_NEW_TOOL: &str = r#"
[[method]]
name = "crm.update_deal"
class = "write"
reversible = false
targets = [{ from_param = "/deal_id", kind = "deal", op = "update" }]
preview = "crm.update_deal.preview"
"#;
    let gw = gateway_with_manifest(WITH_NEW_TOOL);

    // 审计：先给 NeedPreview 之前的两个事件
    let verdict = gw.admit(admit(
        "crm.update_deal",
        serde_json::json!({ "deal_id": "D-1" }),
        ExecutionMode::Live,
    ));
    assert_eq!(
        kinds(&verdict.events),
        vec!["tool.requested", "policy.evaluated"]
    );
    let GatewayAction::NeedPreview { pending } = verdict.action else {
        panic!("声明了 preview 的新工具必须走 NeedPreview")
    };

    // 影响预估：调用方问过 executor 之后续跑，精度升到 Exact
    let resumed = gw.admit_with_preview(
        pending,
        Some(PreviewOutcome {
            targets: vec![evo_protocol::events::effect::ImpactTarget {
                resource: ResourceRef {
                    kind: "deal".into(),
                    id: "D-1".into(),
                },
                op: ResourceOp::Update,
                detail_ref: None,
            }],
            est_cost_micros: None,
        }),
    );
    assert_eq!(kinds(&resumed.events), vec!["impact.estimated"]);
    let ie = find_impact(&resumed.events);
    assert_eq!(ie.precision, ImpactPrecision::Exact);
    assert!(matches!(resumed.action, GatewayAction::Dispatch(_)));

    // dry-run：工具完全不知道自己在 dry-run 下，即使声明了 preview 也一样
    // 先经过 NeedPreview，退回 preview=None 时降级为 record-only。
    let dry = gw.admit(admit(
        "crm.update_deal",
        serde_json::json!({ "deal_id": "D-1" }),
        ExecutionMode::DryRun,
    ));
    let GatewayAction::NeedPreview { pending } = dry.action else {
        panic!("dry-run 下同样先要 preview——精度判定与执行模式正交")
    };
    let dry_resumed = gw.admit_with_preview(pending, None);
    assert!(matches!(dry_resumed.action, GatewayAction::DryRun { .. }));
}
