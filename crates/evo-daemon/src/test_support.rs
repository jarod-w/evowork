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
use evo_protocol::events::lifecycle::{PrincipalRef, RunCreated, TriggerKind, TriggerRef};
use evo_protocol::{Actor, BudgetSpec, EventBody, RunId};
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
