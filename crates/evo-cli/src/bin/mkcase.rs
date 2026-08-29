//! 从 case.yaml + fixtures.json 生成一条 Run Log，供回放自校验使用。
//!
//! 阶段 1 的合成用例是可重建的，所以 sqlite 不进 git。
//! M2 的真实冻结用例走 blob store（Q-27）。

use evo_daemon::{DaemonConfig, FixedClock, Runtime};
use evo_exec_local::{LocalExecutor, WorkspaceOnlySandbox};
use evo_model::FixtureAdapter;
use evo_protocol::RunId;
use std::path::PathBuf;
use std::sync::Arc;

fn field<'a>(yaml: &'a str, key: &str) -> Option<&'a str> {
    yaml.lines()
        .find_map(|l| l.strip_prefix(&format!("{key}:")))
        .map(str::trim)
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let case_dir = PathBuf::from(std::env::args().nth(1).ok_or("用法: mkcase <case_dir>")?);
    let yaml = std::fs::read_to_string(case_dir.join("case.yaml"))?;
    let run_id = RunId::from(field(&yaml, "run_id").ok_or("case.yaml 缺 run_id")?);
    let intent = field(&yaml, "intent")
        .ok_or("case.yaml 缺 intent")?
        .to_owned();
    let clock_start: u64 = field(&yaml, "clock_start_ms")
        .ok_or("case.yaml 缺 clock_start_ms")?
        .parse()?;
    let fixtures_name = field(&yaml, "fixtures").unwrap_or("fixtures.json");

    // 重新生成前先清干净，否则 seq 会接在上一次后面
    for p in ["runlog.sqlite", "runlog.sqlite-wal", "runlog.sqlite-shm"] {
        let _ = std::fs::remove_file(case_dir.join(p));
    }
    for d in ["blobs", "workspaces"] {
        let _ = std::fs::remove_dir_all(case_dir.join(d));
    }

    let mut config = DaemonConfig::for_test(&case_dir);
    config.principal = "u-eval".to_owned();
    let fixtures = std::fs::read_to_string(case_dir.join(fixtures_name))?;

    let mut rt = Runtime::new(
        config,
        Arc::new(FixedClock::new(clock_start)),
        Arc::new(FixtureAdapter::from_json_str(&fixtures)?),
        Arc::new(LocalExecutor::new(Arc::new(WorkspaceOnlySandbox::new()))),
    )?;
    let state = rt.run_once(&run_id, &intent).await?;
    println!(
        "{}: status={:?} turn={} last_seq={}",
        case_dir.display(),
        state.status,
        state.turn,
        state.last_seq
    );
    Ok(())
}
