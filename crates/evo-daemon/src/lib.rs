//! 唯一的组装点，唯一写 Run Log 的进程。
//!
//! 阶段 1 只出 turn 循环驱动；HTTP /v1/rpc 与 WS /v1/events 是阶段 3。

pub mod casegen;
pub mod clock;
pub mod config;
pub mod replay;
pub mod runtime;
pub mod test_support;

pub use casegen::generate_case;
pub use clock::{Clock, FixedClock, RealClock};
pub use config::DaemonConfig;
pub use replay::{
    CliReplayReport, Mismatch, RunOutcome, VerifyReport, cli_replay, replay_to, verify,
};
pub use runtime::{DaemonError, ParsedPlan, Runtime, parse_plan};
pub use test_support::write_bare_run_created;
