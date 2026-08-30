//! 六步管线的第⑤步：预算闸门（M2 终审 BL-10）。
//!
//! 这一步此前**根本不在代码里**——`pipeline.rs` 的步骤注释是 ①②③④⑥，
//! 中间没有 ⑤，`admit()` 从不读预算，`ImpactEstimated.est_cost_micros`
//! 算出来之后零消费者。这个文件锁的就是它接上之后的行为。
//!
//! 与 `evo_kernel::decide` 里那道闸门的分工：那道是 **turn 级**的
//! （「这条 run 还能不能开始下一步」），这道是 **effect 级**的
//! （「这一次工具调用按影响预估会不会把额度打穿」）。两道都要有——内核
//! 看不到 manifest 与影响预估，Gateway 不驱动 turn 循环。

use evo_gateway::{AdmitRequest, Gateway, GatewayAction, ManifestRegistry, PreviewOutcome};
use evo_policy::HardcodedPolicy;
use evo_protocol::budget::{BudgetSpec, BudgetUsage};
use evo_protocol::effect::{CapabilityToken, ResourceOp, ResourceRef};
use evo_protocol::events::effect::{ExecutionMode, ImpactEstimated, ImpactPrecision, ImpactTarget};
use evo_protocol::events::model::PlannedCall;
use evo_protocol::{BlobRef, EffectId, EventBody, RunId, TaintLevel, ToolId};

/// `fs.write` 不声明 preview（走第 2 级，`est_cost_micros` 是 `None`）；
/// `fs.costly` 声明了 preview——只有它这条路径拿得到 `est_cost_micros`，
/// 也就是预扣那一半判据唯一的输入来源。
const TOOLS: &str = r#"
[[method]]
name = "fs.write"
class = "write"
reversible = true
targets = [{ from_param = "/path", kind = "file", op = "update" }]

[[method]]
name = "fs.costly"
class = "write"
reversible = true
targets = [{ from_param = "/path", kind = "file", op = "update" }]
preview = "diff"
"#;

/// 一律放行——这样任何一次「没放行」都只可能是第⑤步干的，不会与策略、
/// 污点、manifest 那三道闸门混在一起。
const ALLOW_ALL: &str = r#"
version = "poc-1"
"#;

fn gateway() -> Gateway {
    Gateway::new(
        Box::new(HardcodedPolicy::from_toml_str(ALLOW_ALL).unwrap()),
        ManifestRegistry::from_toml_str(TOOLS).unwrap(),
    )
}

fn admit(tool: &str, budget: BudgetSpec, budget_used: BudgetUsage) -> AdmitRequest {
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
        taint: TaintLevel::Clean,
        cites_referenced: Vec::new(),
        capability: CapabilityToken {
            subject: "u-1".into(),
            scopes: vec!["*".into()],
        },
        mode: ExecutionMode::Live,
        budget,
        budget_used,
    }
}

fn kinds(v: &[EventBody]) -> Vec<&'static str> {
    v.iter().map(|e| e.kind()).collect()
}

fn spent(amount_micros: u64) -> BudgetUsage {
    BudgetUsage {
        amount_micros,
        ..BudgetUsage::default()
    }
}

// ————————————————————————————————————————————————————————————
// 1. 额度已经用尽：不放行，且结局是「挂起」而不是「拒绝」
// ————————————————————————————————————————————————————————————

#[test]
fn an_exhausted_amount_budget_stops_the_effect() {
    let verdict = gateway().admit(admit(
        "fs.write",
        BudgetSpec {
            max_amount_micros: Some(1_000),
            ..BudgetSpec::default()
        },
        spent(1_000), // 不多不少，正好花完
    ));

    let GatewayAction::BudgetExceeded { reason_code, .. } = verdict.action else {
        panic!("额度用尽必须拦下这次调用");
    };
    assert_eq!(reason_code, "budget_amount_exhausted");
}

#[test]
fn the_gate_trips_at_the_limit_not_one_action_past_it() {
    // `>=` 而不是 `>`：正好花到上限时余额是 0。差一微元则照常放行——
    // 闸门不许提前一步收网。与 `evo_kernel::decide` 里那道判据一致。
    let spec = BudgetSpec {
        max_amount_micros: Some(1_000),
        ..BudgetSpec::default()
    };
    assert!(matches!(
        gateway().admit(admit("fs.write", spec, spent(999))).action,
        GatewayAction::Dispatch(_)
    ));
    assert!(matches!(
        gateway()
            .admit(admit("fs.write", spec, spent(1_000)))
            .action,
        GatewayAction::BudgetExceeded { .. }
    ));
}

#[test]
fn the_token_and_wall_dimensions_are_gated_too() {
    // 三个维度各判各的——不是只查金额那一个。
    let by_tokens = gateway().admit(admit(
        "fs.write",
        BudgetSpec {
            max_tokens: Some(100),
            ..BudgetSpec::default()
        },
        BudgetUsage {
            tokens: 100,
            ..BudgetUsage::default()
        },
    ));
    let GatewayAction::BudgetExceeded { reason_code, .. } = by_tokens.action else {
        panic!("token 维度也要拦");
    };
    assert_eq!(reason_code, "budget_tokens_exhausted");

    let by_wall = gateway().admit(admit(
        "fs.write",
        BudgetSpec {
            max_wall_seconds: Some(2),
            ..BudgetSpec::default()
        },
        BudgetUsage {
            wall_ms: 2_000,
            ..BudgetUsage::default()
        },
    ));
    let GatewayAction::BudgetExceeded { reason_code, .. } = by_wall.action else {
        panic!("时长维度也要拦");
    };
    assert_eq!(reason_code, "budget_wall_exhausted");
}

// ————————————————————————————————————————————————————————————
// 2. est_cost_micros 真的有消费者：预扣
//
//    这是 `ImpactEstimated.est_cost_micros` 在全仓唯一的读取方。此前它被
//    算出来、写进事件，然后没有任何人读它。
// ————————————————————————————————————————————————————————————

/// 走一遍两段式准入：`admit()` 撞见声明了 preview 的工具会停在
/// `NeedPreview`，调用方问完 executor 再调 `admit_with_preview` 续跑。
/// 这里把 preview 的答复直接造出来——`est_cost_micros` 就是从这里进来的。
fn admit_with_preview_cost(
    budget: BudgetSpec,
    used: BudgetUsage,
    est_cost_micros: Option<u64>,
) -> GatewayAction {
    let gw = gateway();
    let verdict = gw.admit(admit("fs.costly", budget, used));
    let GatewayAction::NeedPreview { pending } = verdict.action else {
        panic!("声明了 preview 的工具应该先停在 NeedPreview");
    };
    gw.admit_with_preview(
        pending,
        Some(PreviewOutcome {
            targets: vec![ImpactTarget {
                resource: ResourceRef {
                    kind: "file".into(),
                    id: "report.txt".into(),
                },
                op: ResourceOp::Update,
                detail_ref: None,
            }],
            est_cost_micros,
        }),
    )
    .action
}

#[test]
fn an_estimate_that_would_blow_the_budget_is_charged_before_the_effect_runs() {
    // 余额 400（上限 1000、已花 600），这次预估要花 500——账面上还没超，
    // 但这一次动作跑完必然超。预扣就是在动作**之前**看这件事。
    let action = admit_with_preview_cost(
        BudgetSpec {
            max_amount_micros: Some(1_000),
            ..BudgetSpec::default()
        },
        spent(600),
        Some(500),
    );
    let GatewayAction::BudgetExceeded { reason_code, .. } = action else {
        panic!("预估会打穿额度就必须在动作发生之前拦下来");
    };
    assert_eq!(reason_code, "budget_amount_would_exceed");
}

#[test]
fn an_estimate_that_fits_is_dispatched() {
    // 同样的余额，预估只花 400：正好用满，不超——放行。证明上一条不是
    // 「只要有 est_cost 就拦」。
    assert!(matches!(
        admit_with_preview_cost(
            BudgetSpec {
                max_amount_micros: Some(1_000),
                ..BudgetSpec::default()
            },
            spent(600),
            Some(400),
        ),
        GatewayAction::Dispatch(_)
    ));
}

#[test]
fn without_an_estimate_the_gate_falls_back_to_the_already_spent_check() {
    // 拿不到 `est_cost_micros`（preview 没接上、或工具压根没声明）时，
    // 预扣那一半读不到输入，闸门退回「已经花光了没有」这一半——精度差
    // 一档、闸门跟着松一档，但不阻塞接入，与影响预估的三级降级同构。
    let roomy = BudgetSpec {
        max_amount_micros: Some(1_000),
        ..BudgetSpec::default()
    };
    // 已花 600、没有预估：放行（哪怕这次真花 500 会超）。
    assert!(matches!(
        admit_with_preview_cost(roomy, spent(600), None),
        GatewayAction::Dispatch(_)
    ));
    // 已花 1000、没有预估：照样拦——退化的是预扣，不是整道闸门。
    assert!(matches!(
        admit_with_preview_cost(roomy, spent(1_000), None),
        GatewayAction::BudgetExceeded { .. }
    ));
}

// ————————————————————————————————————————————————————————————
// 3. 闸门不许改变别的步骤的行为
// ————————————————————————————————————————————————————————————

#[test]
fn no_budget_configured_means_unlimited_not_zero() {
    // 全 `None` = 不设限。把 `None` 当 0 会让所有没配预算的 run 一启动
    // 就撞上限——这是 `BudgetSpec` 上一贯的戒律。
    assert!(matches!(
        gateway()
            .admit(admit(
                "fs.write",
                BudgetSpec::default(),
                BudgetUsage {
                    tokens: 999_999_999,
                    amount_micros: 999_999_999,
                    wall_ms: 999_999_999,
                },
            ))
            .action,
        GatewayAction::Dispatch(_)
    ));
}

#[test]
fn a_budget_stopped_effect_still_leaves_a_full_audit_trail() {
    // ⑥ 影响预估**无条件执行**（02 §2 细节 2）——被预算拦下的这一次
    // 同样要留下「它本来会碰什么、大概花多少」的记录，那是审计材料，
    // 也是人决定要不要提额时唯一的依据。把闸门提到 ⑥ 前面就会丢掉它。
    let verdict = gateway().admit(admit(
        "fs.write",
        BudgetSpec {
            max_amount_micros: Some(1_000),
            ..BudgetSpec::default()
        },
        spent(1_000),
    ));
    assert_eq!(
        kinds(&verdict.events),
        vec!["tool.requested", "policy.evaluated", "impact.estimated"],
        "被预算拦下不等于少写事件：前面每一步的判定照样要可举证"
    );

    let impact: Vec<&ImpactEstimated> = verdict
        .events
        .iter()
        .filter_map(|e| match e {
            EventBody::ImpactEstimated(i) => Some(i),
            _ => None,
        })
        .collect();
    assert_eq!(impact.len(), 1);
    assert_eq!(impact[0].precision, ImpactPrecision::DeclaredOnly);
    assert_eq!(impact[0].targets.len(), 1, "目标清单照样算出来了");
}

#[test]
fn the_budget_gate_runs_before_the_approval_branch() {
    // 没钱就是没钱：不该先请人批一个注定跑不动的动作。审批疲劳会让所有
    // 审批一起贬值，这是不能拿来换的东西。
    let gw = Gateway::new(
        Box::new(
            HardcodedPolicy::from_toml_str(
                r#"
version = "poc-1"

[[rule]]
id = "approve-all-writes"
class = "write"
decision = "require_approval"
risk = "l2"
"#,
            )
            .unwrap(),
        ),
        ManifestRegistry::from_toml_str(TOOLS).unwrap(),
    );
    assert!(
        matches!(
            gw.admit(admit(
                "fs.write",
                BudgetSpec {
                    max_amount_micros: Some(1_000),
                    ..BudgetSpec::default()
                },
                spent(1_000),
            ))
            .action,
            GatewayAction::BudgetExceeded { .. }
        ),
        "额度用尽时不该产出 AwaitApproval"
    );
}
