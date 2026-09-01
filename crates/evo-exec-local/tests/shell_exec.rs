//! `shell.exec` 是 `Sandbox::spawn` 的第一个真实调用者（M2 Task 5）。
//! 这里不经过 Gateway/policy——和 `tests/executor.rs` 里 `fs.write` 的
//! 既有做法一致：直接手工构造 `DispatchedEffect`，只测 `LocalExecutor`
//! + `WorkspaceOnlySandbox` 这一层真正做了什么。
//!
//! 覆盖的正是任务交代要覆盖的几件事：一条简单命令的 stdout/exit code、
//! 工作区隔离（cwd 钉死在工作区，参数里也没有能改写它的字段）、
//! `env_clear()` 真的清了宿主机环境、proxy 两套大小写 + `NO_PROXY=""`
//! 都注入了、PATH 按白名单生效（含负面测试）、以及 `actual_targets` /
//! `actual_egress` 与 `declared_*` 落在同一命名空间、可以互相比对。

use evo_exec::{
    CapabilityToken, DispatchedEffect, EffectOutcome, EgressPolicy, Executor, Lease,
    WorkspaceHandle,
};
use evo_exec_local::{LocalExecutor, WorkspaceOnlySandbox, WorkspaceRoot};
use evo_protocol::effect::{EffectClass, EffectRequest};
use evo_protocol::events::effect::{ExecutionMode, ToolResultStatus};
use evo_protocol::{BlobRef, EffectId, EgressRef, LeaseId, ResourceRef, RunId, TaintLevel, ToolId};
use std::sync::Arc;

/// `config/tools.toml` 里 `shell.exec` 声明的字面量 target——真实链路里
/// 这一条由 Gateway 从 manifest 解析出来，挂在 `EffectRequest.targets`
/// 上再交给 executor。这里手工搭出同样的值。
fn declared_workspace_target() -> ResourceRef {
    ResourceRef {
        kind: "workspace".to_owned(),
        id: "sandbox:workspace".to_owned(),
    }
}

/// `config/tools.toml` 里 `egress = [{ via = "proxy" }]` 解析出来的值——
/// `EgressRef::host` 上的 `#[serde(alias = "via")]` 让它落在跟真实
/// 主机名一样的字段里，因此这里直接构造 `host: "proxy"`。
fn declared_proxy_egress() -> EgressRef {
    EgressRef {
        host: "proxy".to_owned(),
        port: None,
    }
}

fn lease(ws: WorkspaceHandle, egress_policy: EgressPolicy) -> Lease {
    Lease {
        lease_id: LeaseId::from("l-1"),
        run_id: RunId::from("r-1"),
        effect_id: EffectId::from("e-1"),
        issued_at_ms: 0,
        expires_at_ms: u64::MAX,
        workspace: ws,
        egress_policy,
        capability: CapabilityToken {
            subject: "u-1".into(),
            scopes: vec!["*".into()],
        },
    }
}

/// `params` 允许调用方额外塞字段（比如一次尝试注入 `cwd` 的攻击性
/// 参数）——`run_shell_exec` 只读 `/program` 与 `/args`，多余的字段
/// 直接被忽略,这正是"工作区之外没有可乘之机"的字面含义。
fn shell_effect(program: &str, args: &[&str], extra_params: serde_json::Value) -> DispatchedEffect {
    let mut params = serde_json::json!({
        "program": program,
        "args": args,
    });
    if let serde_json::Value::Object(extra) = extra_params {
        params.as_object_mut().unwrap().extend(extra);
    }
    DispatchedEffect {
        request: EffectRequest {
            effect_id: EffectId::from("e-1"),
            run_id: RunId::from("r-1"),
            turn: 0,
            tool: ToolId::from("shell.exec"),
            params_ref: BlobRef {
                content_hash: "sha256:aa".into(),
                size: 0,
                mime: "application/json".into(),
            },
            params_digest: "d".into(),
            class: EffectClass::Write,
            targets: vec![declared_workspace_target()],
            egress: vec![declared_proxy_egress()],
            reversible: false,
            taint: TaintLevel::Clean,
            cites_referenced: Vec::new(),
            capability: CapabilityToken {
                subject: "u-1".into(),
                scopes: vec!["*".into()],
            },
        },
        params,
        mode: ExecutionMode::Live,
    }
}

async fn run_with_egress(
    program: &str,
    args: &[&str],
    egress_policy: EgressPolicy,
) -> (tempfile::TempDir, EffectOutcome, WorkspaceHandle) {
    let dir = tempfile::tempdir().unwrap();
    let root = WorkspaceRoot::new(dir.path().to_path_buf());
    let ws = root.ensure(&RunId::from("r-1")).unwrap();
    let exec = LocalExecutor::new(Arc::new(WorkspaceOnlySandbox::new()));
    let outcome = exec
        .execute(
            lease(ws.clone(), egress_policy),
            shell_effect(program, args, serde_json::json!({})),
        )
        .await;
    (dir, outcome, ws)
}

async fn run(program: &str, args: &[&str]) -> (tempfile::TempDir, EffectOutcome, WorkspaceHandle) {
    run_with_egress(program, args, EgressPolicy::deny_all()).await
}

fn payload(outcome: &EffectOutcome) -> serde_json::Value {
    serde_json::from_slice(outcome.output.as_ref().expect("shell.exec 应该有 output")).unwrap()
}

// --- 一条简单命令：stdout 与 exit code ---

#[tokio::test]
async fn runs_a_simple_command_and_reports_stdout_and_exit_code() {
    let (_d, outcome, _ws) = run("echo", &["hello"]).await;
    assert_eq!(outcome.status, ToolResultStatus::Ok);
    let p = payload(&outcome);
    assert_eq!(p["exit_code"], 0);
    assert_eq!(p["stdout"].as_str().unwrap().trim(), "hello");
}

#[tokio::test]
async fn a_nonzero_exit_code_is_still_a_successful_tool_call() {
    // spawn 本身成功了——命令自己的退出码是数据,不是执行器层面的失败。
    // 这与 fs.write 撞见坏路径那种"执行器层面的失败"不是一回事。
    let (_d, outcome, _ws) = run("sh", &["-c", "echo oops >&2; exit 3"]).await;
    assert_eq!(outcome.status, ToolResultStatus::Ok);
    let p = payload(&outcome);
    assert_eq!(p["exit_code"], 3);
    assert_eq!(p["stderr"].as_str().unwrap().trim(), "oops");
}

// --- 工作区隔离：cwd 是工作区；参数里没有能把它改写到别处的字段 ---

#[tokio::test]
async fn cwd_is_pinned_to_the_workspace() {
    let (_d, outcome, ws) = run("pwd", &[]).await;
    assert_eq!(outcome.status, ToolResultStatus::Ok);
    let stdout = payload(&outcome);
    assert_eq!(
        stdout["stdout"].as_str().unwrap().trim(),
        ws.path().to_str().unwrap()
    );
}

#[tokio::test]
async fn a_relative_write_lands_inside_the_workspace() {
    let (_d, outcome, ws) = run("sh", &["-c", "echo hi > created.txt"]).await;
    assert_eq!(outcome.status, ToolResultStatus::Ok);
    assert_eq!(
        std::fs::read_to_string(ws.path().join("created.txt"))
            .unwrap()
            .trim(),
        "hi"
    );
}

#[tokio::test]
async fn an_attempted_cwd_override_in_params_is_ignored() {
    // `run_shell_exec` 只读 `/program` 和 `/args`。就算调用方
    // （模型）在参数里塞一个 `cwd` 字段试图把执行目录指到工作区外，
    // 这个字段根本不会被读取——`Sandbox::spawn` 的签名只接受一个
    // `WorkspaceHandle`，cwd 恒等于它。这是"写到工作区外的尝试被
    // 挡住"在当前架构下唯一可达的攻击面：参数层面根本没有开口。
    //
    // 老实说明一下这条测试**没有**覆盖到的东西：`sh -c` 本身仍然可以
    // 用形如 `../x` 的相对路径或绝对路径去碰工作区外的文件——那需要
    // 内核级隔离（namespace/landlock/seatbelt）才能真正堵死,05/08 号
    // 设计文档把这个留给 macOS 交付形态的 seatbelt 实现,Linux 开发机
    // 上目前没有（Sandbox 文档注释："不做内核级隔离"）。这里验证的是
    // 唯一在这份 PR 范围内能做到、也确实做到的那一半：cwd 无法被参数
    // 篡改。
    let dir = tempfile::tempdir().unwrap();
    let root = WorkspaceRoot::new(dir.path().to_path_buf());
    let ws = root.ensure(&RunId::from("r-1")).unwrap();
    let exec = LocalExecutor::new(Arc::new(WorkspaceOnlySandbox::new()));
    let effect = shell_effect(
        "pwd",
        &[],
        serde_json::json!({ "cwd": "/", "workdir": "../../etc" }),
    );
    let outcome = exec
        .execute(lease(ws.clone(), EgressPolicy::deny_all()), effect)
        .await;

    assert_eq!(outcome.status, ToolResultStatus::Ok);
    let p = payload(&outcome);
    assert_eq!(
        p["stdout"].as_str().unwrap().trim(),
        ws.path().to_str().unwrap()
    );
}

// --- env_clear() 生效：宿主机环境变量不泄漏进子进程 ---

#[tokio::test]
async fn env_clear_hides_a_host_environment_variable_from_the_child() {
    const VAR: &str = "EVOWORK_SHELL_EXEC_LEAK_CHECK";
    // SAFETY: 测试进程里没有其它线程会同时读/写这同一个 key；这是
    // Rust 2024 起 `env::set_var`/`remove_var` 的通用调用约束。
    unsafe {
        std::env::set_var(VAR, "should-not-leak");
    }
    let (_d, outcome, _ws) = run("sh", &["-c", &format!("echo \"${{{VAR}:-absent}}\"")]).await;
    unsafe {
        std::env::remove_var(VAR);
    }

    assert_eq!(outcome.status, ToolResultStatus::Ok);
    assert_eq!(
        payload(&outcome)["stdout"].as_str().unwrap().trim(),
        "absent"
    );
}

// --- proxy 注入：大小写两套 + NO_PROXY="" ---

#[tokio::test]
async fn proxy_env_is_injected_both_cases_plus_empty_no_proxy() {
    let egress_policy = EgressPolicy {
        allow: vec!["api.deepseek.com".into()],
        proxy_addr: Some("127.0.0.1:8899".into()),
    };
    let (_d, outcome, _ws) = run_with_egress(
        "sh",
        &[
            "-c",
            "printf '%s|%s|%s|%s|%s' \"$HTTP_PROXY\" \"$HTTPS_PROXY\" \"$http_proxy\" \"$https_proxy\" \"${NO_PROXY-unset}\"",
        ],
        egress_policy,
    )
    .await;

    assert_eq!(outcome.status, ToolResultStatus::Ok);
    let stdout = payload(&outcome)["stdout"].as_str().unwrap().to_owned();
    assert_eq!(
        stdout,
        "127.0.0.1:8899|127.0.0.1:8899|127.0.0.1:8899|127.0.0.1:8899|"
    );
}

#[tokio::test]
async fn no_proxy_env_leaks_when_no_proxy_is_configured() {
    // deny_all() 没有 proxy_addr——这时不应该注入任何 *_PROXY 变量。
    let (_d, outcome, _ws) = run("sh", &["-c", "printf '%s' \"${HTTP_PROXY-unset}\""]).await;
    assert_eq!(outcome.status, ToolResultStatus::Ok);
    assert_eq!(payload(&outcome)["stdout"].as_str().unwrap(), "unset");
}

// --- PATH 按白名单生效：正面 + 负面 ---

#[tokio::test]
async fn a_bare_program_name_resolves_via_the_sandbox_fixed_path() {
    // "echo" 是裸名字，没有斜杠——如果 PATH 没生效，`Command::new` 根本
    // 找不到它，spawn 会直接失败成 ExecError::Io。能拿到 Ok 就说明
    // 沙箱自己注入的固定 PATH（而不是宿主机的 PATH）确实起了作用。
    let (_d, outcome, _ws) = run("echo", &["path-works"]).await;
    assert_eq!(outcome.status, ToolResultStatus::Ok);
    assert_eq!(
        payload(&outcome)["stdout"].as_str().unwrap().trim(),
        "path-works"
    );
}

#[tokio::test]
async fn a_program_outside_the_allowlist_is_refused() {
    // 负面测试：白名单外的程序名——即使宿主机上真的装了 curl，也不该
    // 跑得起来。选它是因为它恰好是"用一个真实存在于大多数系统上、但
    // 明显该被挡的联网工具"这个反例。
    let (_d, outcome, _ws) = run("curl", &["https://example.com"]).await;
    assert_eq!(outcome.status, ToolResultStatus::Error);
    assert!(
        outcome.error.as_ref().unwrap().contains("not allowed"),
        "got: {:?}",
        outcome.error
    );
}

#[tokio::test]
async fn an_absolute_path_to_a_disallowed_program_is_also_refused() {
    // 换个目录不能绕开白名单：即使调用方给的是一条绝对路径，挡的还是
    // "这个程序名是否被允许"，不是"这条路径是不是在标准目录里"。
    let (_d, outcome, _ws) = run("/bin/rm", &["-rf", "whatever"]).await;
    assert_eq!(outcome.status, ToolResultStatus::Error);
}

// --- actual_targets / actual_egress：如实回报，能跟 declared 比对 ---

#[tokio::test]
async fn actual_targets_match_the_declared_literal_workspace_target() {
    // shell.exec 的 targets 静态提取不出来，manifest 里只能声明字面量
    // "整个工作区"。executor 层唯一能如实确认的就是"这条命令确实是在
    // 这个工作区里跑的"，所以直接复用 Gateway 已经解析好、挂在
    // effect.request.targets 上的声明值——这里手工构造的 `declared`
    // 就是 Gateway 在真实链路里会算出的那一条。
    let declared = declared_workspace_target();
    let (_d, outcome, _ws) = run("echo", &["hi"]).await;
    assert_eq!(outcome.actual_targets, vec![declared]);
}

#[tokio::test]
async fn actual_egress_matches_declared_egress_when_a_proxy_is_actually_configured() {
    let declared = declared_proxy_egress();
    let egress_policy = EgressPolicy {
        allow: vec![],
        proxy_addr: Some("127.0.0.1:8899".into()),
    };
    let (_d, outcome, _ws) = run_with_egress("echo", &["hi"], egress_policy).await;
    assert_eq!(outcome.actual_egress, vec![declared]);
}

#[tokio::test]
async fn actual_egress_is_empty_when_the_lease_never_actually_wired_up_a_proxy() {
    // manifest 声明 shell.exec 总是 `egress = [{ via = "proxy" }]`，
    // 但如果这次 lease 的 egress_policy 里根本没有 proxy_addr
    // （deny_all() 就是这样），"实际上并没有出口路径"是一条真实、
    // 值得记录的偏离——即使 POC 期只记录不拦截。这正是 declared_egress
    // 与 actual_egress 存在的意义：字段与比对代码要在，即使这里选择
    // 不拦截。
    let (_d, outcome, _ws) = run("echo", &["hi"]).await;
    assert!(outcome.actual_egress.is_empty());
    assert_ne!(outcome.actual_egress, vec![declared_proxy_egress()]);
}

fn lease_expiring_in(ws: WorkspaceHandle, remaining_ms: u64) -> Lease {
    let mut l = lease(ws, EgressPolicy::deny_all());
    l.issued_at_ms = 0;
    l.expires_at_ms = remaining_ms;
    l
}

// --- P0-3：租约超时与 stdout 上限 ---

#[tokio::test]
async fn a_sleep_infinity_is_killed_when_the_lease_expires() {
    let dir = tempfile::tempdir().unwrap();
    let root = WorkspaceRoot::new(dir.path().to_path_buf());
    let ws = root.ensure(&RunId::from("r-1")).unwrap();
    let exec = LocalExecutor::new(Arc::new(WorkspaceOnlySandbox::new()));
    let started = std::time::Instant::now();
    let outcome = exec
        .execute(
            lease_expiring_in(ws, 250),
            shell_effect("sh", &["-c", "sleep 10"], serde_json::json!({})),
        )
        .await;
    let elapsed = started.elapsed();
    assert_eq!(outcome.status, ToolResultStatus::Error);
    assert!(
        outcome
            .error
            .as_ref()
            .unwrap()
            .to_lowercase()
            .contains("lease"),
        "got: {:?}",
        outcome.error
    );
    assert!(
        elapsed < std::time::Duration::from_secs(3),
        "timeout did not fire; hung for {elapsed:?}"
    );
}

#[tokio::test]
async fn an_already_expired_lease_does_not_spawn() {
    let dir = tempfile::tempdir().unwrap();
    let root = WorkspaceRoot::new(dir.path().to_path_buf());
    let ws = root.ensure(&RunId::from("r-1")).unwrap();
    let exec = LocalExecutor::new(Arc::new(WorkspaceOnlySandbox::new()));
    let outcome = exec
        .execute(
            lease_expiring_in(ws, 0),
            shell_effect("echo", &["should-not-run"], serde_json::json!({})),
        )
        .await;
    assert_eq!(outcome.status, ToolResultStatus::Error);
    assert!(
        outcome.error.as_ref().unwrap().contains("lease"),
        "got: {:?}",
        outcome.error
    );
    assert!(outcome.output.is_none());
}

#[tokio::test]
async fn stdout_is_capped_and_the_child_is_killed() {
    let dir = tempfile::tempdir().unwrap();
    let root = WorkspaceRoot::new(dir.path().to_path_buf());
    let ws = root.ensure(&RunId::from("r-1")).unwrap();
    let exec = LocalExecutor::new(Arc::new(WorkspaceOnlySandbox::new()));
    let started = std::time::Instant::now();
    let outcome = exec
        .execute(
            lease(ws, EgressPolicy::deny_all()),
            shell_effect(
                "python3",
                &["-c", "print('x' * (2 * 1024 * 1024))"],
                serde_json::json!({}),
            ),
        )
        .await;
    let elapsed = started.elapsed();
    assert_eq!(outcome.status, ToolResultStatus::Ok);
    let p = payload(&outcome);
    assert_eq!(p["truncated"], true);
    let stdout = p["stdout"].as_str().unwrap();
    assert!(
        stdout.len() <= evo_exec::SANDBOX_MAX_OUTPUT_BYTES,
        "stdout leaked past the cap: {} bytes",
        stdout.len()
    );
    assert!(
        elapsed < std::time::Duration::from_secs(5),
        "uncapped producer was not killed; hung for {elapsed:?}"
    );
}
