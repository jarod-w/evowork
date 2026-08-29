use evo_exec::{
    CapabilityToken, DispatchedEffect, EffectOutcome, EgressPolicy, Executor, Lease,
    WorkspaceHandle,
};
use evo_exec_local::{LocalExecutor, WorkspaceOnlySandbox, WorkspaceRoot, resolve_in_workspace};
use evo_protocol::effect::{EffectClass, EffectRequest};
use evo_protocol::events::effect::{ExecutionMode, ToolResultStatus};
use evo_protocol::{BlobRef, EffectId, LeaseId, RunId, TaintLevel, ToolId};
use std::sync::Arc;

fn lease(ws: WorkspaceHandle) -> Lease {
    Lease {
        lease_id: LeaseId::from("l-1"),
        run_id: RunId::from("r-1"),
        effect_id: EffectId::from("e-1"),
        expires_at_ms: u64::MAX,
        workspace: ws,
        egress_policy: EgressPolicy::deny_all(),
        capability: CapabilityToken {
            subject: "u-1".into(),
            scopes: vec!["*".into()],
        },
    }
}

fn write_effect(path: &str, content: &str) -> DispatchedEffect {
    DispatchedEffect {
        request: EffectRequest {
            effect_id: EffectId::from("e-1"),
            run_id: RunId::from("r-1"),
            turn: 0,
            tool: ToolId::from("fs.write"),
            params_ref: BlobRef {
                content_hash: "sha256:aa".into(),
                size: 0,
                mime: "application/json".into(),
            },
            params_digest: "d".into(),
            class: EffectClass::Write,
            targets: Vec::new(),
            egress: Vec::new(),
            reversible: true,
            taint: TaintLevel::Clean,
            cites_referenced: Vec::new(),
            capability: CapabilityToken {
                subject: "u-1".into(),
                scopes: vec!["*".into()],
            },
        },
        params: serde_json::json!({ "path": path, "content": content }),
        mode: ExecutionMode::Live,
    }
}

async fn run(path: &str, content: &str) -> (tempfile::TempDir, EffectOutcome, WorkspaceHandle) {
    let dir = tempfile::tempdir().unwrap();
    let root = WorkspaceRoot::new(dir.path().to_path_buf());
    let ws = root.ensure(&RunId::from("r-1")).unwrap();
    let exec = LocalExecutor::new(Arc::new(WorkspaceOnlySandbox::new()));
    let outcome = exec
        .execute(lease(ws.clone()), write_effect(path, content))
        .await;
    (dir, outcome, ws)
}

#[tokio::test]
async fn fs_write_lands_inside_the_workspace() {
    let (_d, outcome, ws) = run("report.txt", "hello").await;
    assert_eq!(outcome.status, ToolResultStatus::Ok);
    assert_eq!(
        std::fs::read_to_string(ws.path().join("report.txt")).unwrap(),
        "hello"
    );
}

#[tokio::test]
async fn actual_targets_are_reported_for_supply_chain_comparison() {
    let (_d, outcome, _ws) = run("report.txt", "hello").await;
    assert_eq!(outcome.actual_targets.len(), 1);
    assert_eq!(outcome.actual_targets[0].kind, "file");
    assert!(outcome.actual_targets[0].id.ends_with("report.txt"));
}

#[tokio::test]
async fn a_path_escaping_the_workspace_is_refused() {
    let (_d, outcome, _ws) = run("../../etc/passwd", "x").await;
    assert_eq!(outcome.status, ToolResultStatus::Error);
    assert!(outcome.error.unwrap().contains("escapes the workspace"));
}

#[tokio::test]
async fn an_absolute_path_is_refused() {
    let (_d, outcome, _ws) = run("/etc/passwd", "x").await;
    assert_eq!(outcome.status, ToolResultStatus::Error);
}

#[test]
fn sensitive_paths_are_blocked_even_when_they_resolve_inside() {
    // 这几个路径不在策略的可及范围内——策略可以放宽目录权限，
    // 但它们是硬拦截（05 §3 最后一行）
    let dir = tempfile::tempdir().unwrap();
    let root = WorkspaceRoot::new(dir.path().to_path_buf());
    let ws = root.ensure(&RunId::from("r-1")).unwrap();
    std::fs::create_dir_all(ws.path().join(".ssh")).unwrap();
    let err = resolve_in_workspace(&ws, ".ssh/id_rsa").unwrap_err();
    assert!(err.to_string().contains("sensitive"));
}

#[test]
fn each_run_gets_its_own_workspace() {
    let dir = tempfile::tempdir().unwrap();
    let root = WorkspaceRoot::new(dir.path().to_path_buf());
    let a = root.ensure(&RunId::from("r-a")).unwrap();
    let b = root.ensure(&RunId::from("r-b")).unwrap();
    assert_ne!(a.path(), b.path());
    assert!(a.path().is_dir() && b.path().is_dir());
}

// --- 符号链接逃逸：词法校验看不见符号链接，工作区里预先放一个指向
// 工作区外的软链，就能骗过 `..`/前缀比对，真实文件落到工作区之外。

#[test]
fn a_symlink_to_outside_the_workspace_is_refused() {
    let dir = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    let root = WorkspaceRoot::new(dir.path().to_path_buf());
    let ws = root.ensure(&RunId::from("r-1")).unwrap();
    std::os::unix::fs::symlink(outside.path(), ws.path().join("escape")).unwrap();

    let err = resolve_in_workspace(&ws, "escape/x.txt").unwrap_err();
    assert!(err.to_string().contains("escapes the workspace"));
}

#[test]
fn a_symlink_in_a_middle_path_segment_is_refused() {
    // a 是软链指向工作区外的目录，b 在那个外部目录里真实存在——
    // 证明拦的不只是候选路径的最后一段，中间层同样会被抓到。
    let dir = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(outside.path().join("b")).unwrap();
    let root = WorkspaceRoot::new(dir.path().to_path_buf());
    let ws = root.ensure(&RunId::from("r-1")).unwrap();
    std::os::unix::fs::symlink(outside.path(), ws.path().join("a")).unwrap();

    let err = resolve_in_workspace(&ws, "a/b/x.txt").unwrap_err();
    assert!(err.to_string().contains("escapes the workspace"));
}

#[tokio::test]
async fn symlink_escape_via_fs_write_does_not_create_the_file_outside_the_workspace() {
    let dir = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    let root = WorkspaceRoot::new(dir.path().to_path_buf());
    let ws = root.ensure(&RunId::from("r-1")).unwrap();
    std::os::unix::fs::symlink(outside.path(), ws.path().join("escape")).unwrap();

    let exec = LocalExecutor::new(Arc::new(WorkspaceOnlySandbox::new()));
    let outcome = exec
        .execute(lease(ws.clone()), write_effect("escape/pwned.txt", "pwned"))
        .await;

    assert_eq!(outcome.status, ToolResultStatus::Error);
    // 最要紧的断言：文件真的没有写到工作区外面去，不只是返回了个错误。
    assert!(!outside.path().join("pwned.txt").exists());
}

#[tokio::test]
async fn a_symlink_inside_the_workspace_still_works() {
    let dir = tempfile::tempdir().unwrap();
    let root = WorkspaceRoot::new(dir.path().to_path_buf());
    let ws = root.ensure(&RunId::from("r-1")).unwrap();
    std::fs::create_dir_all(ws.path().join("real")).unwrap();
    std::os::unix::fs::symlink(ws.path().join("real"), ws.path().join("link")).unwrap();

    let exec = LocalExecutor::new(Arc::new(WorkspaceOnlySandbox::new()));
    let outcome = exec
        .execute(lease(ws.clone()), write_effect("link/inside.txt", "ok"))
        .await;

    assert_eq!(outcome.status, ToolResultStatus::Ok);
    assert_eq!(
        std::fs::read_to_string(ws.path().join("real/inside.txt")).unwrap(),
        "ok"
    );
}

#[tokio::test]
async fn a_new_file_in_new_nested_directories_still_works() {
    let (_d, outcome, ws) = run("nested/dirs/report.txt", "hello").await;
    assert_eq!(outcome.status, ToolResultStatus::Ok);
    assert_eq!(
        std::fs::read_to_string(ws.path().join("nested/dirs/report.txt")).unwrap(),
        "hello"
    );
}
