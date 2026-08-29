#![forbid(unsafe_code)]
//! 纯函数状态机。无 IO、无时钟、无随机数。
//!
//! 内核要知道时间，只能读 `RunState::clock_ms`，而它只由 `env.sampled` 事件写入。
//! **想读时钟都没有地方读**——这比在规范上禁止可靠。

pub mod hash;
pub mod rng;
pub mod state;

pub use hash::{state_hash, state_hash_hex};
pub use rng::DeterministicRng;
pub use state::{ArtifactRecord, AwaitReason, ContextRecord, EffectState, RunState, RunStatus};
