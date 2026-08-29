//! 供 `mkcase` 等离线场景使用的组装入口（Task 19）。
//!
//! 本模块存在的唯一理由，就是 [`crate`] 文档顶部那句「唯一的组装点，
//! 唯一写 Run Log 的进程」。`mkcase` 要为 eval 生成合成用例的 Run Log，
//! 这件事本质上就是选 executor、选 sandbox、选 model adapter、组装
//! [`Runtime`]、跑一遍——如果这段逻辑留在 `evo-cli` 里自己
//! `use evo_exec_local::...` / `use evo_model::...` 去 `Runtime::new(...)`，
//! 就会在 daemon 进程之外，在 evo-cli 里再造出一个能写 Run Log 的组装点，
//! 字面违反了那句不变量——不是依赖方向问题，是第二个写 Run Log 的进程。
//!
//! 所以即便调用方（`mkcase`）是离线、单次、跑完就退出的小工具，组装 Runtime
//! 这件事也必须发生在这里，`evo-cli` 只允许拿到组装完的结果。这样「唯一的
//! 组装点」在字面上就只有 evo-daemon 一处，不需要在治理检查（CI-3）里
//! 再给 evo-cli 开一条例外。

use crate::clock::FixedClock;
use crate::config::DaemonConfig;
use crate::runtime::{DaemonError, Runtime};
use evo_exec_local::{LocalExecutor, WorkspaceOnlySandbox};
use evo_kernel::RunState;
use evo_model::FixtureAdapter;
use evo_protocol::RunId;
use std::path::Path;
use std::sync::Arc;

fn field<'a>(yaml: &'a str, key: &str) -> Option<&'a str> {
    yaml.lines()
        .find_map(|l| l.strip_prefix(&format!("{key}:")))
        .map(str::trim)
}

/// 给定一个 case 目录（内含 `case.yaml` 与一份 fixtures 文件），组装一个
/// 离线用的 [`Runtime`]（`FixedClock` + `FixtureAdapter` + `LocalExecutor`
/// over `WorkspaceOnlySandbox`），生成一条 Run Log，返回最终状态供调用方
/// 打印。
///
/// 生成前会清掉目录里旧的 `runlog.sqlite*`、`blobs/`、`workspaces/`，否则
/// 重新生成时 seq 会接在上一次后面。
pub async fn generate_case(case_dir: &Path) -> Result<RunState, DaemonError> {
    let yaml = std::fs::read_to_string(case_dir.join("case.yaml"))?;
    let run_id = RunId::from(
        field(&yaml, "run_id")
            .ok_or_else(|| DaemonError::CaseFormat("case.yaml 缺 run_id".to_owned()))?,
    );
    let intent = field(&yaml, "intent")
        .ok_or_else(|| DaemonError::CaseFormat("case.yaml 缺 intent".to_owned()))?
        .to_owned();
    let clock_start: u64 = field(&yaml, "clock_start_ms")
        .ok_or_else(|| DaemonError::CaseFormat("case.yaml 缺 clock_start_ms".to_owned()))?
        .parse()
        .map_err(|_| DaemonError::CaseFormat("clock_start_ms 不是合法整数".to_owned()))?;
    let fixtures_name = field(&yaml, "fixtures").unwrap_or("fixtures.json");

    // 重新生成前先清干净，否则 seq 会接在上一次后面
    for p in ["runlog.sqlite", "runlog.sqlite-wal", "runlog.sqlite-shm"] {
        let _ = std::fs::remove_file(case_dir.join(p));
    }
    for d in ["blobs", "workspaces"] {
        let _ = std::fs::remove_dir_all(case_dir.join(d));
    }

    let mut config = DaemonConfig::for_test(case_dir);
    config.principal = "u-eval".to_owned();
    let fixtures = std::fs::read_to_string(case_dir.join(fixtures_name))?;

    let mut rt = Runtime::new(
        config,
        Arc::new(FixedClock::new(clock_start)),
        Arc::new(FixtureAdapter::from_json_str(&fixtures)?),
        Arc::new(LocalExecutor::new(Arc::new(WorkspaceOnlySandbox::new()))),
    )?;
    let outcome = rt.start(&run_id, &intent).await?;
    Ok(outcome.into_state())
}
