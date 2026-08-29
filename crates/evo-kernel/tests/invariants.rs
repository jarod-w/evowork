//! 两条「不可能发生的输入」不变量断言。
//!
//! 内核对外暴露的是纯函数（`reduce`/`fold`）和纯数据（`RunState`），任何调用方
//! ——回放器、测试、有 bug 的 daemon——都能绕过 `events()` 给出的排序保证，
//! 直接喂出违反内部不变量的输入。这两个测试证明：debug 构建下内核会响亮地
//! panic，而不是悄悄吞下去、让上层带着一个错的 state 继续跑。

use evo_kernel::{RunState, reduce};
use evo_protocol::events::determinism::{EnvSampled, ModelRoute};
use evo_protocol::{Actor, Event, EventBody, RunId};

fn ev(seq: u64, body: EventBody) -> Event {
    Event {
        run_id: RunId::from("r-1"),
        seq,
        recorded_at: "2026-08-29T10:00:00Z".into(),
        actor: Actor::Runtime,
        schema_ver: 1,
        body,
    }
}

fn env_sampled(turn: u32, clock: u64) -> EventBody {
    EventBody::EnvSampled(EnvSampled {
        turn,
        wall_clock_ms: clock,
        rng_seed: "seed-0".into(),
        env: Default::default(),
        model_route: ModelRoute {
            provider: "fixture".into(),
            model: "fixture-v1".into(),
            params_digest: "d0".into(),
        },
    })
}

/// `events()` 按 seq 升序返回，正常路径下 seq 只会前进。但 `reduce` 是公共纯
/// 函数，没有任何东西拦着调用方倒着喂事件。先喂 seq=10，再喂 seq=3：
/// `last_seq` 会从 10 倒退回 3——这个错误一旦发生在生产环境，会让回放/审计
/// 判据（"重放必须与原始执行完全一致"）失去意义，且没有任何提示。
#[test]
#[should_panic(expected = "event.seq (3) < state.last_seq (10)")]
fn reduce_panics_when_seq_goes_backwards() {
    let s = RunState::new(&RunId::from("r-1"));
    let s = reduce(&s, &ev(10, env_sampled(0, 1)));
    assert_eq!(s.last_seq, 10);
    // 违反前提：调用方绕过了 events() 的排序保证，倒着喂了一条更早的事件。
    let _ = reduce(&s, &ev(3, env_sampled(1, 2)));
}

/// `RunState::new()` 的 last_seq 是 0，第一条事件的 seq 也是 0；回放器从快照
/// 恢复时会从快照所在的那个 seq **开始重放**（包含那一条），此时
/// `event.seq == state.last_seq`。这两种情况都必须合法，断言用 `>=` 而非
/// `>`——这个测试就是防止有人把它误改成 `>` 从而在正常回放路径上炸掉。
#[test]
fn reduce_allows_seq_equal_to_last_seq() {
    let s = RunState::new(&RunId::from("r-1"));
    // new() 之后 last_seq == 0，第一条事件 seq == 0，属于合法边界。
    let s = reduce(&s, &ev(0, env_sampled(0, 1)));
    assert_eq!(s.last_seq, 0);
    // 从快照恢复：快照所在 seq 的那条事件被重新喂一遍，event.seq == last_seq。
    let s = reduce(&s, &ev(0, env_sampled(0, 2)));
    assert_eq!(s.last_seq, 0);
}

/// `last_checkpoint_seq <= last_seq` 恒成立：写检查点时 `reduce` 把两者同时
/// 设成同一个 event.seq，之后 last_seq 只增不减。若这个不变量被破坏（检查点
/// 比最新事件还新，一个不该出现的状态），`saturating_sub` 会悄悄返回 0，
/// 表现为「刚打完检查点」，于是该打检查点时不打——静默、没有任何测试能发现。
/// 这里直接构造一个被污染的 RunState（last_checkpoint_seq > last_seq），
/// 证明 debug 构建下会响亮地 panic，而不是吞掉这个错误。
#[test]
#[should_panic(expected = "last_checkpoint_seq (10) > last_seq (5)")]
fn events_since_checkpoint_panics_when_checkpoint_is_newer_than_last_seq() {
    let mut s = RunState::new(&RunId::from("r-1"));
    s.last_seq = 5;
    s.last_checkpoint_seq = Some(10); // 不可能出现的污染状态
    let _ = s.events_since_checkpoint();
}
