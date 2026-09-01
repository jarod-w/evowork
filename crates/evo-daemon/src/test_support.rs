//! 供其他 crate 的测试用的最小 Run Log 构造入口（同一条先例见
//! [`crate::casegen`]）。
//!
//! `evo-cli` 需要验证「一条只有 `run.created`、没有任何 checkpoint 的
//! Run Log 会被回放自校验判成 VACUOUS 而不是 OK」——这需要先构造这样一条
//! Log。但 `evo-cli`（连同它的测试）不允许自己持有 `RunLog` 去 `append`：
//! 「只有 evo-daemon 写 Run Log」是字面上的约束，不是「不直接依赖
//! evo-runlog crate」这么浅——不然 evo-daemon 随手把 `RunLog` 类型
//! `pub use` 出去，约束就名存实亡了。所以哪怕只是给测试用的一条最小夹具，
//! 写 Run Log 这件事也只能发生在这里，`evo-cli` 只该拿到「写完了」这个
//! 结果。

use crate::runtime::DaemonError;
use evo_protocol::effect::EffectClass;
use evo_protocol::events::effect::ToolRequested;
use evo_protocol::events::lifecycle::{
    IntentDeclared, PrincipalRef, RunCreated, TriggerKind, TriggerRef,
};
use evo_protocol::{Actor, BlobClass, BudgetSpec, EffectId, EventBody, RunId, ToolId};
use evo_runlog::RunLog;
use std::collections::BTreeMap;
use std::path::Path;

/// 只写一条 `run.created` 事件，不驱动 [`crate::Runtime`]。
///
/// 用来构造「一个 checkpoint 都没有」的最小 Run Log，验证 CLI 侧对
/// VACUOUS 报告的呈现（`evo-cli` 的 `tests/cli.rs`）。阶段 1 的 checkpoint
/// 只在写操作前插入，一条只声明了 run、什么都没做的 run 合法地一个都
/// 没有——这正是这个函数唯一的用途，不打算变成通用的事件构造器。
pub fn write_bare_run_created(
    db_path: &Path,
    blob_root: &Path,
    run_id: &RunId,
    workspace_id: &str,
    recorded_at: &str,
) -> Result<(), DaemonError> {
    let mut log = RunLog::open(db_path, blob_root)?;
    log.append(
        run_id,
        Actor::Runtime,
        recorded_at,
        EventBody::RunCreated(RunCreated {
            run_id: run_id.clone(),
            parent_run_id: None,
            workspace_id: workspace_id.to_owned(),
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
    )?;
    Ok(())
}

/// 写一条「`tool.requested` 已落盘，但下一条事件还没来得及写」的残局
/// Run Log：`run.created` + `tool.requested`，没有 `policy.evaluated` 之后
/// 的任何东西，尤其没有 `approval.requested`。
///
/// 这是唯一一种没法用 [`crate::Runtime`] 的公开接口构造出来的状态——它
/// 只在进程被杀在两条事件中间时出现，而这恰恰是 M2 终审点名的一条路径：
/// 这样一个 effect 谁也没批过、`resume` 也不会补派它（补派判据是正向的
/// `EffectState::Approved`），于是没有任何东西会把它推向终态，`decide`
/// 只会一直等——`drive` 必须把这条推不动的 run 记成 `run.failed`，而不是
/// 报给调用方一个「完成」。
///
/// 与 [`write_bare_run_created`] 同理：写 Run Log 这件事只能发生在
/// evo-daemon 里，测试夹具也不例外。
pub fn write_run_created_then_orphan_tool_requested(
    db_path: &Path,
    blob_root: &Path,
    run_id: &RunId,
    effect_id: &EffectId,
    recorded_at: &str,
) -> Result<(), DaemonError> {
    let mut log = RunLog::open(db_path, blob_root)?;
    log.append(
        run_id,
        Actor::Runtime,
        recorded_at,
        EventBody::RunCreated(RunCreated {
            run_id: run_id.clone(),
            parent_run_id: None,
            workspace_id: run_id.as_str().to_owned(),
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
    )?;
    // 意图也补上：一条真实残局里 `intent.declared` 早在第一个 turn 之前
    // 就写过了，缺了它 `AssembleContext` 会 panic 在一个与本夹具无关的
    // 前置条件上，测试读起来会像是在测别的东西。
    let intent_ref = log.blobs().put(
        BlobClass::Content,
        "text/plain",
        "把账龄表做出来".as_bytes(),
    )?;
    log.append(
        run_id,
        Actor::Runtime,
        recorded_at,
        EventBody::IntentDeclared(IntentDeclared {
            intent_ref,
            char_len: 7,
            lang: "zh".to_owned(),
            source: "cli".to_owned(),
        }),
    )?;
    let params_ref = log
        .blobs()
        .put(BlobClass::Content, "application/json", b"{}")?;
    let params_digest = params_ref.content_hash.clone();
    log.append(
        run_id,
        Actor::Gateway,
        recorded_at,
        EventBody::ToolRequested(ToolRequested {
            effect_id: effect_id.clone(),
            turn: 0,
            tool: ToolId::from("fs.write"),
            params_ref,
            params_digest,
            class: EffectClass::Write,
            declared_targets: Vec::new(),
            declared_egress: Vec::new(),
            reversible: true,
            cites_referenced: Vec::new(),
        }),
    )?;
    Ok(())
}

/// 两条未决审批并列后挂起。Runtime 今天一次只发一个 effect，这个状态
/// 没法从公开接口走出来，但 `resume` / `reduce` 必须在它上面不 panic、
/// 也不因为批了字典序较大的那条就把另一条当没看见。
///
/// `expires_at_ms` 必须相对测试时钟有意义：`FixedClock` 从
/// `1_756_461_600_000` 起跳，小于该值的截止时刻在第一次 `now_ms()` 时
/// 就已经过期（P0-4）。「仍未决」夹具用一个远未来值；过期夹具用过去值。
pub fn write_run_suspended_with_two_pending_approvals(
    db_path: &Path,
    blob_root: &Path,
    run_id: &RunId,
    recorded_at: &str,
    expires_at_ms: u64,
) -> Result<(evo_protocol::ApprovalId, evo_protocol::ApprovalId), DaemonError> {
    use evo_protocol::ApprovalId;
    use evo_protocol::events::approval::{ApprovalRequested, RiskLevel};
    use evo_protocol::events::lifecycle::{RunSuspended, SuspendReason};

    let mut log = RunLog::open(db_path, blob_root)?;
    log.append(
        run_id,
        Actor::Runtime,
        recorded_at,
        EventBody::RunCreated(RunCreated {
            run_id: run_id.clone(),
            parent_run_id: None,
            workspace_id: run_id.as_str().to_owned(),
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
    )?;
    let intent_ref = log.blobs().put(
        BlobClass::Content,
        "text/plain",
        "把账龄表做出来".as_bytes(),
    )?;
    log.append(
        run_id,
        Actor::Runtime,
        recorded_at,
        EventBody::IntentDeclared(IntentDeclared {
            intent_ref,
            char_len: 7,
            lang: "zh".to_owned(),
            source: "cli".to_owned(),
        }),
    )?;

    let params_ref = log
        .blobs()
        .put(BlobClass::Content, "application/json", b"{}")?;
    let params_digest = params_ref.content_hash.clone();

    let first = ApprovalId::from("r-1-a10");
    let last = ApprovalId::from("r-1-a9");
    let e1 = EffectId::from("e-1");
    let e2 = EffectId::from("e-2");

    for (effect_id, approval_id) in [(&e1, &first), (&e2, &last)] {
        log.append(
            run_id,
            Actor::Gateway,
            recorded_at,
            EventBody::ToolRequested(ToolRequested {
                effect_id: effect_id.clone(),
                turn: 0,
                tool: ToolId::from("fs.write"),
                params_ref: params_ref.clone(),
                params_digest: params_digest.clone(),
                class: EffectClass::Write,
                declared_targets: Vec::new(),
                declared_egress: Vec::new(),
                reversible: true,
                cites_referenced: Vec::new(),
            }),
        )?;
        log.append(
            run_id,
            Actor::Gateway,
            recorded_at,
            EventBody::ApprovalRequested(ApprovalRequested {
                approval_id: approval_id.clone(),
                effect_id: effect_id.clone(),
                risk: RiskLevel::L2,
                impact_ref: None,
                expires_at_ms,
            }),
        )?;
    }
    log.append(
        run_id,
        Actor::Runtime,
        recorded_at,
        EventBody::RunSuspended(RunSuspended {
            reason: SuspendReason::AwaitingApproval,
            detail_ref: None,
        }),
    )?;
    Ok((first, last))
}
