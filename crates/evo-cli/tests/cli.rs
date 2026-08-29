use evo_protocol::RunId;
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
    // 一整套），只写一条 `run.created` 事件——阶段 1 的 checkpoint 只在写
    // 操作前插入，一条只声明了 run、什么都没做的 run 合法地一个检查点都
    // 没有。写 Run Log 这件事本身经由 evo_daemon::write_bare_run_created
    // 完成——evo-cli（连它的测试也算）不允许自己持有 RunLog 去 append。
    let dir = tempfile::tempdir().unwrap();
    let db_path = dir.path().join("runlog.sqlite");
    let blob_root = dir.path().join("blobs");

    let run_id = RunId::from("r-vacuous");
    evo_daemon::write_bare_run_created(
        &db_path,
        &blob_root,
        &run_id,
        "ws-1",
        "2026-08-29T00:00:00Z",
    )
    .unwrap();

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
