//! 唯一的组装点，唯一写 Run Log 的进程。
//!
//! HTTP `/v1/rpc` 与 WS `/v1/events` 由本 crate 的二进制入口拉起
//! （`cargo run -p evo-daemon`）。

pub mod casegen;
pub mod clock;
pub mod config;
pub mod http;
pub mod replay;
pub mod runtime;
pub mod test_support;

pub use casegen::generate_case;
pub use clock::{Clock, FixedClock, RealClock};
pub use config::DaemonConfig;
pub use http::{AppState, router, serve};
pub use replay::{
    CliReplayReport, Mismatch, ReplayOutcome, SnapshotRejected, VerifyReport, cli_replay,
    replay_to, replay_to_checked, verify,
};
pub use runtime::{DaemonError, ParsedPlan, RunOutcome, Runtime, parse_plan};
pub use test_support::{
    write_bare_run_created, write_run_created_then_orphan_tool_requested,
    write_run_suspended_with_two_pending_approvals,
};
