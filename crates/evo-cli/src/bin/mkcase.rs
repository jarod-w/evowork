//! 从 case.yaml + fixtures.json 生成一条 Run Log，供回放自校验使用。
//!
//! 阶段 1 的合成用例是可重建的，所以 sqlite 不进 git。
//! M2 的真实冻结用例走 blob store（Q-27）。
//!
//! 组装 Runtime（选 executor / sandbox / model adapter）的逻辑住在
//! `evo_daemon::casegen` 里（Task 19）——那才是唯一的组装点。这里只做一件
//! 事：读命令行参数，调用，打印结果。不直接依赖 evo-exec-local / evo-model。

use std::path::PathBuf;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let case_dir = PathBuf::from(std::env::args().nth(1).ok_or("用法: mkcase <case_dir>")?);
    let state = evo_daemon::generate_case(&case_dir).await?;
    println!(
        "{}: status={:?} turn={} last_seq={}",
        case_dir.display(),
        state.status,
        state.turn,
        state.last_seq
    );
    Ok(())
}
