use evo_protocol::events::lifecycle::{PrincipalRef, RunCreated, TriggerKind, TriggerRef};
use evo_protocol::{Actor, BudgetSpec, EventBody, RunId};
use evo_runlog::RunLog;
use std::collections::BTreeMap;
use std::process::Command;

fn bin() -> Command {
    Command::new(env!("CARGO_BIN_EXE_evo-cli"))
}

#[test]
fn replay_verify_on_a_missing_file_fails_loudly() {
    let out = bin()
        .args(["replay", "--verify", "/nonexistent/runlog.sqlite"])
        .output()
        .unwrap();
    assert!(!out.status.success());
    assert!(String::from_utf8_lossy(&out.stderr).contains("/nonexistent/runlog.sqlite"));
}

#[test]
fn a_log_without_checkpoints_is_reported_as_vacuous_not_ok() {
    // 判据 3 的检测器如果对「没检查到任何东西」也报通过，
    // CI 上那行绿字就是假的。这条测试守住 CLI 侧的呈现。
    //
    // 构造：不跑完整的 Runtime（那需要 evo-daemon/evo-model/evo-exec-local
    // 一整套），直接建一条只有 `run.created` 事件的最小 Log——阶段 1 的
    // checkpoint 只在写操作前插入，一条只声明了 run、什么都没做的 run
    // 合法地一个 checkpoint 都没有。
    let dir = tempfile::tempdir().unwrap();
    let db_path = dir.path().join("runlog.sqlite");
    let blob_root = dir.path().join("blobs");

    let mut log = RunLog::open(&db_path, &blob_root).unwrap();
    let run_id = RunId::from("r-vacuous");
    log.append(
        &run_id,
        Actor::Runtime,
        "2026-08-29T00:00:00Z",
        EventBody::RunCreated(RunCreated {
            run_id: run_id.clone(),
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
    )
    .unwrap();
    drop(log);

    let out = bin()
        .args(["replay", "--verify", db_path.to_str().unwrap()])
        .output()
        .unwrap();
    assert!(!out.status.success());
    assert!(String::from_utf8_lossy(&out.stderr).contains("VACUOUS"));
}

#[test]
fn replay_verify_needs_at_least_one_path() {
    let out = bin().args(["replay", "--verify"]).output().unwrap();
    assert!(!out.status.success());
}
