use evo_exec::{
    CapabilityToken, DispatchedEffect, EffectOutcome, EgressPolicy, Executor, Lease,
    WorkspaceHandle,
};
use evo_exec_local::{LocalExecutor, WorkspaceOnlySandbox, WorkspaceRoot, resolve_in_workspace};
use evo_protocol::effect::{EffectClass, EffectRequest};
use evo_protocol::events::effect::{ExecutionMode, ToolResultStatus};
use evo_protocol::{BlobRef, EffectId, LeaseId, ResourceRef, RunId, TaintLevel, ToolId};
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

// --- actual_targets 命名空间修复:declared_targets(TargetSpec::resolve
// 从参数原值取出的工作区相对路径)与 actual_targets 必须落在同一命名空间,
// 否则任何比对都会 100% 不匹配,而这两个字段存在的全部意义就是互相比对。

#[tokio::test]
async fn actual_targets_use_workspace_relative_paths_not_absolute_ones() {
    let (_d, outcome, _ws) = run("report.txt", "hello").await;
    assert_eq!(outcome.actual_targets[0].id, "report.txt");
}

#[tokio::test]
async fn actual_targets_preserve_nested_relative_paths() {
    let (_d, outcome, _ws) = run("sub/dir/report.txt", "hello").await;
    assert_eq!(outcome.actual_targets[0].id, "sub/dir/report.txt");
}

#[tokio::test]
async fn actual_targets_are_comparable_with_declared_targets() {
    // declared_targets 是 Gateway 从参数原值静态提取的(TargetSpec::resolve),
    // 也就是工具调用时传入的原始相对路径。这里直接用同一个原值构造一个
    // ResourceRef,模拟 declared_targets 里会出现的那一条。
    let declared = ResourceRef {
        kind: "file".to_owned(),
        id: "report.txt".to_owned(),
    };
    let (_d, outcome, _ws) = run("report.txt", "hello").await;
    assert_eq!(outcome.actual_targets[0], declared);
}

#[tokio::test]
async fn actual_targets_are_stable_across_different_workspace_roots() {
    // 同样的相对路径,在两个不同的工作区根下执行,actual_targets 必须相同——
    // 这证明它不再含机器/临时目录路径,Log 才可移植、才有确定性。
    let (_d1, outcome1, _ws1) = run("report.txt", "hello").await;
    let (_d2, outcome2, _ws2) = run("report.txt", "hello").await;
    assert_eq!(outcome1.actual_targets, outcome2.actual_targets);
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

// --- 悬空符号链接绕过：resolve_through_symlinks 用 `Path::exists()` 判断
// 某个分量是否已存在,而 `exists()` 会跟随符号链接——对一个指向尚不存在
// 目标的悬空软链,它返回 `false`。于是循环把“这里真的什么都没有”和
// “这里有个软链节点,只是它指向的东西还不存在”混为一谈,把悬空软链
// 当空气继续向上剥,最终 canonicalize 到工作区根、判定“安全”,而
// `fs::write` 落笔时内核跟随软链,真实文件写到了工作区之外。

#[tokio::test]
async fn a_dangling_symlink_pointing_outside_the_workspace_is_refused() {
    let dir = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    let root = WorkspaceRoot::new(dir.path().to_path_buf());
    let ws = root.ensure(&RunId::from("r-1")).unwrap();
    // x.txt 在工作区里是一个软链,指向工作区外一个真实存在的目录下、
    // 尚不存在的文件——outside 本身存在,但 outside/newfile.txt 还没被创建。
    std::os::unix::fs::symlink(outside.path().join("newfile.txt"), ws.path().join("x.txt"))
        .unwrap();

    let exec = LocalExecutor::new(Arc::new(WorkspaceOnlySandbox::new()));
    let outcome = exec
        .execute(lease(ws.clone()), write_effect("x.txt", "pwned"))
        .await;

    assert_eq!(outcome.status, ToolResultStatus::Error);
    // 最要紧的断言:工作区外那个文件确实没有被创建出来。
    assert!(!outside.path().join("newfile.txt").exists());
}

#[tokio::test]
async fn toctou_replacing_a_written_file_with_a_dangling_external_symlink_is_refused() {
    let dir = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    let root = WorkspaceRoot::new(dir.path().to_path_buf());
    let ws = root.ensure(&RunId::from("r-1")).unwrap();
    let exec = LocalExecutor::new(Arc::new(WorkspaceOnlySandbox::new()));

    let first = exec
        .execute(lease(ws.clone()), write_effect("toctou.txt", "first"))
        .await;
    assert_eq!(first.status, ToolResultStatus::Ok);

    // 把刚写好的普通文件替换成一个指向工作区外、尚不存在目标的软链,
    // 再对同一个相对路径发起第二次写入。
    std::fs::remove_file(ws.path().join("toctou.txt")).unwrap();
    std::os::unix::fs::symlink(
        outside.path().join("newfile.txt"),
        ws.path().join("toctou.txt"),
    )
    .unwrap();

    let second = exec
        .execute(lease(ws.clone()), write_effect("toctou.txt", "pwned"))
        .await;

    assert_eq!(second.status, ToolResultStatus::Error);
    assert!(!outside.path().join("newfile.txt").exists());
}

#[tokio::test]
async fn a_dangling_symlink_pointing_inside_the_workspace_is_refused() {
    // link 是软链,指向工作区内部一个尚不存在的文件(newfile.txt)。
    // canonicalize 对不存在的目标同样会失败,所以这条路径也被拒绝——
    // 这是一次「误伤」:目标其实落在工作区内部,理论上写进去并不逃逸。
    //
    // 判断:接受这次误伤,视为可接受的保守行为。理由:
    //   1) resolve_through_symlinks 唯一的职责是判断「真实落地路径是否
    //      在工作区内」。它没有能力(也不该有)区分「悬空软链最终指向
    //      哪儿」和「这条悬空软链本身是不是恶意构造的」——一旦侦测到
    //      某个分量是符号链接节点,就必须能 canonicalize 成功才放行,
    //      规则简单、没有需要额外判断的例外分支。
    //   2) 调用方如果真的要通过这个软链写工作区内部的新文件,直接用
    //      真实路径("newfile.txt")操作即可;被牺牲掉的只是一种几乎
    //      不会有人依赖的边缘写法(先建软链、再指望它当新文件用)。
    //   3) 反过来放宽——比如只要词法解出的最终目标仍在工作区内就放行
    //      悬空软链——等于重新相信软链自己声明的目标,而不是文件系统
    //      的真实状态,这正是本轮要堵的洞的一个变种,不能开这个口子。
    let dir = tempfile::tempdir().unwrap();
    let root = WorkspaceRoot::new(dir.path().to_path_buf());
    let ws = root.ensure(&RunId::from("r-1")).unwrap();
    std::os::unix::fs::symlink(ws.path().join("newfile.txt"), ws.path().join("link")).unwrap();

    let exec = LocalExecutor::new(Arc::new(WorkspaceOnlySandbox::new()));
    let outcome = exec
        .execute(lease(ws.clone()), write_effect("link", "hello"))
        .await;

    assert_eq!(outcome.status, ToolResultStatus::Error);
    assert!(!ws.path().join("newfile.txt").exists());
}

#[tokio::test]
async fn legitimate_new_files_and_valid_symlinks_still_work_after_the_dangling_symlink_fix() {
    let dir = tempfile::tempdir().unwrap();
    let root = WorkspaceRoot::new(dir.path().to_path_buf());
    let ws = root.ensure(&RunId::from("r-1")).unwrap();
    let exec = LocalExecutor::new(Arc::new(WorkspaceOnlySandbox::new()));

    let brand_new = exec
        .execute(lease(ws.clone()), write_effect("fresh.txt", "hello"))
        .await;
    assert_eq!(brand_new.status, ToolResultStatus::Ok);

    let nested = exec
        .execute(
            lease(ws.clone()),
            write_effect("deep/nested/dirs/fresh.txt", "hello"),
        )
        .await;
    assert_eq!(nested.status, ToolResultStatus::Ok);

    std::fs::create_dir_all(ws.path().join("real")).unwrap();
    std::os::unix::fs::symlink(ws.path().join("real"), ws.path().join("valid_link")).unwrap();
    let via_symlink = exec
        .execute(
            lease(ws.clone()),
            write_effect("valid_link/inside.txt", "ok"),
        )
        .await;
    assert_eq!(via_symlink.status, ToolResultStatus::Ok);
    assert_eq!(
        std::fs::read_to_string(ws.path().join("real/inside.txt")).unwrap(),
        "ok"
    );
}

// --- BL-3 硬链接逃逸：canonicalize 对硬链接无能为力——硬链接不是「指向
// 另一条路径的节点」，它就是同一个 inode 的第二个名字，两个名字之间没有
// 主次之分，也没有任何可供 canonicalize 跟随的指向关系。于是工作区里的
// `innocent.txt` 与工作区外的 `outside-secret.txt` 是同一份数据：真实
// 路径校验全部通过（这个名字确实在工作区里），`fs::write` 落笔改的却是
// 工作区外那份文件的内容，而 `actual_targets` 报出来的是一条干净的
// 工作区相对路径——供应链行为异常检测（executor.rs）拿到的是伪证。

#[tokio::test]
async fn a_hard_link_to_a_file_outside_the_workspace_is_refused() {
    let dir = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    let root = WorkspaceRoot::new(dir.path().to_path_buf());
    let ws = root.ensure(&RunId::from("r-1")).unwrap();

    let secret = outside.path().join("outside-secret.txt");
    std::fs::write(&secret, "ORIGINAL").unwrap();
    std::fs::hard_link(&secret, ws.path().join("innocent.txt")).unwrap();

    let exec = LocalExecutor::new(Arc::new(WorkspaceOnlySandbox::new()));
    let outcome = exec
        .execute(
            lease(ws.clone()),
            write_effect("innocent.txt", "PWNED BY THE AGENT"),
        )
        .await;

    // 最要紧的断言放最前：工作区外那份文件的内容确实没有被改动。
    assert_eq!(
        std::fs::read_to_string(&secret).unwrap(),
        "ORIGINAL",
        "工作区外的文件被改写了；actual_targets={:?} 报的却是一条干净的\
         工作区相对路径",
        outcome.actual_targets
    );
    assert_eq!(outcome.status, ToolResultStatus::Error);
}

#[test]
fn a_hard_link_is_refused_at_resolve_time_too() {
    let dir = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    let root = WorkspaceRoot::new(dir.path().to_path_buf());
    let ws = root.ensure(&RunId::from("r-1")).unwrap();
    std::fs::write(outside.path().join("secret.txt"), "ORIGINAL").unwrap();
    std::fs::hard_link(
        outside.path().join("secret.txt"),
        ws.path().join("innocent.txt"),
    )
    .unwrap();

    let err = resolve_in_workspace(&ws, "innocent.txt").unwrap_err();
    assert!(err.to_string().contains("escapes the workspace"));
}

#[tokio::test]
async fn a_hard_link_whose_other_name_is_also_inside_the_workspace_is_refused_too() {
    // 有意接受的误伤：`nlink > 1` 只能说明「这个 inode 有第二个名字」，
    // 说不出第二个名字在哪儿——要说得出必须扫全盘找同 inode 的目录项。
    // 所以工作区内部两个互为硬链接的文件也会被拒。理由与悬空软链那次
    // 取舍一致：宁可拒一种几乎没人依赖的写法，也不放行一条无法判定
    // 落点的路径。
    let dir = tempfile::tempdir().unwrap();
    let root = WorkspaceRoot::new(dir.path().to_path_buf());
    let ws = root.ensure(&RunId::from("r-1")).unwrap();
    std::fs::write(ws.path().join("a.txt"), "hello").unwrap();
    std::fs::hard_link(ws.path().join("a.txt"), ws.path().join("b.txt")).unwrap();

    let exec = LocalExecutor::new(Arc::new(WorkspaceOnlySandbox::new()));
    let outcome = exec
        .execute(lease(ws.clone()), write_effect("b.txt", "x"))
        .await;
    assert_eq!(outcome.status, ToolResultStatus::Error);
}

#[tokio::test]
async fn ordinary_single_linked_files_still_work_after_the_hard_link_fix() {
    // 反向保险：`nlink == 1` 的普通文件——新建的、覆写已存在的、经由
    // 工作区内软链写的——一条都不该被这次修复挡住。
    let dir = tempfile::tempdir().unwrap();
    let root = WorkspaceRoot::new(dir.path().to_path_buf());
    let ws = root.ensure(&RunId::from("r-1")).unwrap();
    let exec = LocalExecutor::new(Arc::new(WorkspaceOnlySandbox::new()));

    let created = exec
        .execute(lease(ws.clone()), write_effect("report.txt", "hello"))
        .await;
    assert_eq!(created.status, ToolResultStatus::Ok);

    let overwritten = exec
        .execute(lease(ws.clone()), write_effect("report.txt", "hello again"))
        .await;
    assert_eq!(overwritten.status, ToolResultStatus::Ok);
    assert_eq!(
        std::fs::read_to_string(ws.path().join("report.txt")).unwrap(),
        "hello again"
    );

    std::fs::create_dir_all(ws.path().join("real")).unwrap();
    std::os::unix::fs::symlink(ws.path().join("real"), ws.path().join("link")).unwrap();
    let via_symlink = exec
        .execute(lease(ws.clone()), write_effect("link/inside.txt", "ok"))
        .await;
    assert_eq!(via_symlink.status, ToolResultStatus::Ok);
}

// --- BL-4 工作区根本身可被创建到根之外：`ensure` 直接把 run_id 当路径
// 分量 join 上去，没有任何校验。run_id 由调用方（Runtime::start）给，
// `RunId` 自己零校验。一个带 `..` 的 run_id 会让工作区落在 workspaces
// 根之外——而**之后所有的路径校验都会「通过」**，因为工作区就是那个
// 目录，边界跟着一起搬走了。

#[test]
fn a_run_id_with_parent_dir_components_cannot_place_the_workspace_outside_the_root() {
    let dir = tempfile::tempdir().unwrap();
    let base = dir.path().join("workspaces");
    std::fs::create_dir_all(&base).unwrap();
    let root = WorkspaceRoot::new(base.clone());

    let err = root
        .ensure(&RunId::from("../escaped-workspace"))
        .unwrap_err();
    assert!(err.to_string().contains("escapes the workspace"));
    assert!(!dir.path().join("escaped-workspace").exists());
}

#[test]
fn an_absolute_run_id_cannot_place_the_workspace_outside_the_root() {
    // `Path::join` 遇到绝对路径会**整条丢弃**左边的 base——工作区直接
    // 落在调用方给的绝对路径上。
    let dir = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    let base = dir.path().join("workspaces");
    std::fs::create_dir_all(&base).unwrap();
    let root = WorkspaceRoot::new(base);

    let target = outside.path().join("absolute-workspace");
    let err = root
        .ensure(&RunId::from(target.to_str().unwrap()))
        .unwrap_err();
    assert!(err.to_string().contains("escapes the workspace"));
    assert!(!target.exists());
}

#[test]
fn distinct_run_ids_cannot_normalize_onto_the_same_workspace() {
    // run_id -> 目录必须是单射：否则两个不同的 run 会静默共用一个工作区，
    // 互相读写对方的文件，而 Log 里两条 run 各自看起来都正常。
    let dir = tempfile::tempdir().unwrap();
    let root = WorkspaceRoot::new(dir.path().to_path_buf());
    let plain = root.ensure(&RunId::from("r-1")).unwrap();

    for alias in ["./r-1", "r-1/", "r-1/.", "sub/../r-1"] {
        match root.ensure(&RunId::from(alias)) {
            Err(e) => assert!(
                e.to_string().contains("escapes the workspace"),
                "run_id {alias:?} 被拒但错误不对：{e}"
            ),
            Ok(ws) => panic!(
                "run_id {alias:?} 归一化到了 {}，与 r-1 的 {} 撞车",
                ws.path().display(),
                plain.path().display()
            ),
        }
    }
}

#[test]
fn a_pre_existing_symlink_in_the_workspaces_root_cannot_relocate_a_workspace() {
    // 就算 run_id 本身干净，workspaces/<run_id> 这个目录项也可能已经是
    // 一条指向工作区根之外的软链（create_dir_all 对已存在的目标直接
    // 成功）。工作区根必须是 base 下的**直接子目录**，不能只是「能被
    // 创建出来」。
    let dir = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    let base = dir.path().join("workspaces");
    std::fs::create_dir_all(&base).unwrap();
    std::os::unix::fs::symlink(outside.path(), base.join("r-1")).unwrap();
    let root = WorkspaceRoot::new(base);

    let err = root.ensure(&RunId::from("r-1")).unwrap_err();
    assert!(err.to_string().contains("escapes the workspace"));
}

#[test]
fn ordinary_run_ids_still_get_their_workspace_after_the_run_id_fix() {
    let dir = tempfile::tempdir().unwrap();
    let root = WorkspaceRoot::new(dir.path().join("workspaces"));
    for id in ["r-1", "r-synthetic-01", "r-001", "run.2026-08-30_42"] {
        let ws = root.ensure(&RunId::from(id)).unwrap();
        assert!(ws.path().is_dir());
        assert_eq!(ws.path().file_name().unwrap(), id);
        assert_eq!(ws.id(), id);
    }
}

// --- fs.read ---------------------------------------------------------------
//
// `config/tools.toml` 从 M1 起就声明了 `fs.read`，执行面却一直没有实现，
// 于是任何真实调用都会掉进 `UnknownTool`。下面这组把它钉住：读得到内容、
// 路径校验与 `fs.write` 同一套（工作区边界、绝对路径、符号链接逃逸都要
// 挡住）、actual_targets 与 declared_targets 落在同一命名空间。

fn read_effect(path: &str) -> DispatchedEffect {
    DispatchedEffect {
        request: EffectRequest {
            effect_id: EffectId::from("e-1"),
            run_id: RunId::from("r-1"),
            turn: 0,
            tool: ToolId::from("fs.read"),
            params_ref: BlobRef {
                content_hash: "sha256:aa".into(),
                size: 0,
                mime: "application/json".into(),
            },
            params_digest: "d".into(),
            class: EffectClass::Read,
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
        params: serde_json::json!({ "path": path }),
        mode: ExecutionMode::Live,
    }
}

/// 先在工作区里放一个文件（不经 `fs.write`，模拟"这个文件本来就在那儿"
/// ——外部对账单、上一条命令拉下来的东西），再用 `fs.read` 读它。
async fn run_read(
    plant: Option<(&str, &str)>,
    path: &str,
) -> (tempfile::TempDir, EffectOutcome, WorkspaceHandle) {
    let dir = tempfile::tempdir().unwrap();
    let root = WorkspaceRoot::new(dir.path().to_path_buf());
    let ws = root.ensure(&RunId::from("r-1")).unwrap();
    if let Some((name, content)) = plant {
        let p = ws.path().join(name);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, content).unwrap();
    }
    let exec = LocalExecutor::new(Arc::new(WorkspaceOnlySandbox::new()));
    let outcome = exec.execute(lease(ws.clone()), read_effect(path)).await;
    (dir, outcome, ws)
}

#[tokio::test]
async fn fs_read_returns_the_file_content() {
    let (_d, outcome, _ws) = run_read(Some(("inbox.txt", "对账单正文")), "inbox.txt").await;
    assert_eq!(outcome.status, ToolResultStatus::Ok);
    assert_eq!(outcome.output.unwrap(), "对账单正文".as_bytes());
}

#[tokio::test]
async fn fs_read_reports_a_workspace_relative_actual_target() {
    let (_d, outcome, _ws) = run_read(Some(("sub/inbox.txt", "x")), "sub/inbox.txt").await;
    assert_eq!(outcome.actual_targets.len(), 1);
    assert_eq!(
        outcome.actual_targets[0],
        ResourceRef {
            kind: "file".to_owned(),
            id: "sub/inbox.txt".to_owned(),
        }
    );
}

#[tokio::test]
async fn fs_read_refuses_a_path_escaping_the_workspace() {
    // 「只是读」不能走一条更松的路径校验——它恰恰是最该挡住的方向。
    let (_d, outcome, _ws) = run_read(None, "../../etc/passwd").await;
    assert_eq!(outcome.status, ToolResultStatus::Error);
    assert!(outcome.error.unwrap().contains("escapes the workspace"));
}

#[tokio::test]
async fn fs_read_refuses_an_absolute_path() {
    let (_d, outcome, _ws) = run_read(None, "/etc/passwd").await;
    assert_eq!(outcome.status, ToolResultStatus::Error);
}

#[tokio::test]
async fn fs_read_refuses_a_symlink_pointing_outside_the_workspace() {
    let dir = tempfile::tempdir().unwrap();
    let outside = dir.path().join("outside.txt");
    std::fs::write(&outside, "secret").unwrap();
    let root = WorkspaceRoot::new(dir.path().join("ws"));
    std::fs::create_dir_all(dir.path().join("ws")).unwrap();
    let ws = root.ensure(&RunId::from("r-1")).unwrap();
    std::os::unix::fs::symlink(&outside, ws.path().join("link.txt")).unwrap();

    let exec = LocalExecutor::new(Arc::new(WorkspaceOnlySandbox::new()));
    let outcome = exec.execute(lease(ws), read_effect("link.txt")).await;
    assert_eq!(outcome.status, ToolResultStatus::Error);
    assert!(outcome.output.is_none(), "越界的读绝不能回传内容");
}

#[tokio::test]
async fn fs_read_of_a_missing_file_is_an_error_not_an_empty_success() {
    let (_d, outcome, _ws) = run_read(None, "nope.txt").await;
    assert_eq!(outcome.status, ToolResultStatus::Error);
    assert!(outcome.output.is_none());
}
