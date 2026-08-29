//! `Gateway::admit` 遇到声明了 `preview` 的工具时会先产出
//! `GatewayAction::NeedPreview`，把已经算好的判定原样封进 `PendingAdmit`
//! 交还调用方；daemon 的 `handle_gateway_action` 要再问一轮 executor、
//! 调 `Gateway::admit_with_preview` 才能拿到真正的结局
//! （见 `evo-gateway/src/pipeline.rs`）。
//!
//! `config/tools.toml` 里现在没有任何工具声明 `preview`——没有一条真实
//! 路径会走到 `handle_gateway_action` 里的 `NeedPreview` 分支，也就没有
//! 任何测试验证过它。这正是这个项目反复吃过亏的那类缺陷：治理路径上的
//! 死代码「写了、看起来对、从没被执行过」。这里补一个 daemon 级测试，用
//! 一份临时叠加了 `preview` 声明的 manifest 把 `request_effect` 真正逼进
//! 这条分支。
//!
//! 现在还没有任何 executor 实现 preview 方法，所以 daemon 目前是用 `None`
//! 恢复（见 `handle_gateway_action` 的文档注释）——本测试锁的正是这个
//! **当前真实生效**的路径：确认 daemon 确实二次调用了
//! `admit_with_preview`、以 `None` 恢复、最终仍然拿到 `DeclaredOnly` 精度
//! 并把整条 run 跑完。选它而不是「注入一个假 preview 结果换 `Exact`」，
//! 是因为后者需要先给 `Executor` trait 加一个目前完全不存在的 preview
//! 调用能力——那是一次会牵动别的 crate 的产品改动，超出「本轮只加测试与
//! 注释」的范围；等真正接上第一个会 preview 的工具时，`Exact` 这一支自然
//! 会有它自己的端到端测试来锁。

use evo_daemon::{DaemonConfig, FixedClock, RunOutcome, Runtime};
use evo_exec_local::{LocalExecutor, WorkspaceOnlySandbox};
use evo_kernel::RunStatus;
use evo_model::FixtureAdapter;
use evo_protocol::events::effect::ImpactPrecision;
use evo_protocol::{EventBody, RunId};
use evo_runlog::RunLog;
use std::sync::Arc;

const FIXTURES: &str = r#"{
  "provider": "fixture",
  "model": "fixture-v1",
  "responses": [
    { "text": "{\"intent\":\"tool_call\",\"tool\":\"fs.write\",\"params\":{\"path\":\"report.txt\",\"content\":\"账龄表\"}}",
      "usage": { "input": 120, "output": 40, "cache_read": 0, "cache_write": 0 },
      "stop_reason": "stop", "latency_ms": 12 },
    { "text": "{\"intent\":\"finish\"}",
      "usage": { "input": 200, "output": 10, "cache_read": 0, "cache_write": 0 },
      "stop_reason": "stop", "latency_ms": 9 }
  ]
}"#;

/// 与 `tests/turn_loop.rs::setup` 唯一的区别：在真实的 `config/tools.toml`
/// 之后追加一条同名的 `fs.write` manifest，声明 `preview`。
/// `ManifestRegistry::from_toml_str` 按工具名收进 `BTreeMap`——后出现的
/// 同名条目会覆盖先出现的那条，所以这里不需要改动仓库里的真实配置文件，
/// 也不用担心影响其它测试或生产配置。
fn setup_with_preview_declared(dir: &std::path::Path) -> Runtime {
    let mut config = DaemonConfig::for_test(dir);
    config.tools_toml.push_str(
        r#"
[[method]]
name = "fs.write"
class = "write"
reversible = true
targets = [{ from_param = "/path", kind = "file", op = "update" }]
preview = "diff"
"#,
    );
    Runtime::new(
        config,
        Arc::new(FixedClock::new(1_756_461_600_000)),
        Arc::new(FixtureAdapter::from_json_str(FIXTURES).unwrap()),
        Arc::new(LocalExecutor::new(Arc::new(WorkspaceOnlySandbox::new()))),
    )
    .unwrap()
}

#[tokio::test]
async fn a_tool_declaring_preview_still_completes_the_run_via_the_none_fallback() {
    let dir = tempfile::tempdir().unwrap();
    let mut rt = setup_with_preview_declared(dir.path());
    let run_id = RunId::from("r-1");

    let outcome = rt.start(&run_id, "把账龄表做出来").await.unwrap();
    let RunOutcome::Completed(state) = outcome else {
        panic!("expected Completed, got {outcome:?}");
    };
    assert_eq!(state.status, RunStatus::Completed);

    let log = RunLog::open(&dir.path().join("runlog.sqlite"), &dir.path().join("blobs")).unwrap();
    let events = log.events(&run_id, 0, None).unwrap();

    // 事件序列跟 `tests/turn_loop.rs` 里那条不需要 preview 的路径完全一致：
    // `NeedPreview` 分支只是在中途多绕了一次 `admit_with_preview`，
    // 不应该在可观测的事件序列上留下任何痕迹（既不多事件，也不少）。
    // 反过来说：`handle_gateway_action` 里 `NeedPreview` 分支要是被改成
    // `unreachable!()`，或者被改成跳过第二次 admit 直接返回，这条断言
    // 都会红——前者是 panic，后者会在这条序列里少掉
    // impact.estimated/checkpoint/effect.dispatched/tool.result 这些
    // 只有走完 `admit_with_preview` 才会产生的事件。
    let kinds: Vec<&str> = events.iter().map(|e| e.body.kind()).collect();
    assert_eq!(
        kinds,
        vec![
            "run.created",
            "intent.declared",
            "env.sampled",
            "context.assembled",
            "model.requested",
            "model.responded",
            "cost.charged",
            "cost.charged",
            "plan.step",
            "tool.requested",
            "policy.evaluated",
            "impact.estimated",
            "checkpoint",
            "effect.dispatched",
            "tool.result",
            "env.sampled",
            "context.assembled",
            "model.requested",
            "model.responded",
            "cost.charged",
            "cost.charged",
            "plan.step",
            "run.completed",
        ]
    );

    // 精度是 `DeclaredOnly`，不是 `Exact`——证明二次 admit 确实是用 `None`
    // 恢复的（`Some` 才会给出 `Exact`，见 `impact::estimate`），而不是
    // 什么其它旁路凑巧产出了同一条事件序列。
    let impact = events
        .iter()
        .find_map(|e| match &e.body {
            EventBody::ImpactEstimated(impact) => Some(impact),
            _ => None,
        })
        .expect("expected an impact.estimated event");
    assert_eq!(impact.precision, ImpactPrecision::DeclaredOnly);

    // 真正写了文件，证明不是卡在 NeedPreview 之后原地返回、假装跑完了。
    let written = dir.path().join("workspaces").join("r-1").join("report.txt");
    assert_eq!(std::fs::read_to_string(written).unwrap(), "账龄表");
}
