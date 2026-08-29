use crate::runtime::DaemonError;
use evo_kernel::{RunState, RunStatus, reduce, state_hash_hex};
use evo_protocol::EventBody;
use evo_protocol::ids::RunId;
use evo_runlog::RunLog;
use std::path::Path;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Mismatch {
    pub seq: u64,
    pub expected: String,
    pub actual: String,
}

#[derive(Clone, Debug)]
pub struct VerifyReport {
    pub run_id: RunId,
    pub checkpoints_checked: usize,
    pub mismatches: Vec<Mismatch>,
    pub final_state_hash: String,
}

impl VerifyReport {
    /// 在**已检查的** checkpoint 中没有发现不一致。
    ///
    /// 注意：这不等于「验证通过」。一条没有任何 checkpoint 的 run（阶段 1
    /// 的 checkpoint 是 `pre_write` 语义点，不做写操作的 run 合法地一个都
    /// 没有）或者一个不存在的 `run_id`，同样会得到 `is_ok() == true`——因为
    /// 根本没东西可比对。调用方在展示结果前，必须先查
    /// [`Self::is_vacuous`]，把「什么都没查」和「查了、没问题」区分开。
    pub fn is_ok(&self) -> bool {
        self.mismatches.is_empty()
    }

    /// 这份报告什么都没验证——Log 里一个 checkpoint 都没有。
    ///
    /// **`is_ok()` 为 true 但 `is_vacuous()` 也为 true，意味着「没发现问题」而
    /// 不是「验证通过」。** 调用方（CLI、CI）必须把这两种情况分开呈现，
    /// 否则一个什么都没检查的报告会显示成一行绿色的 OK。
    pub fn is_vacuous(&self) -> bool {
        self.checkpoints_checked == 0
    }
}

/// 回放到某个 seq。**不重新调模型、不重新执行 effect**——
/// 直接重放同一批事件，内核走过完全相同的路径。
///
/// `use_snapshots` 只影响从哪里起步，不影响结果。这一点由
/// 「删光快照结果不变」那条测试保证。
pub fn replay_to(
    log: &RunLog,
    run_id: &RunId,
    to_seq: Option<u64>,
    use_snapshots: bool,
) -> Result<RunState, DaemonError> {
    let target = match to_seq {
        Some(s) => s,
        None => log.last_seq(run_id)?.unwrap_or(0),
    };

    let (mut state, from_seq) = if use_snapshots {
        match log.snapshot_at_or_before(run_id, target)? {
            Some(snap) => {
                let restored: RunState = ciborium::from_reader(snap.state_blob.as_slice())
                    .map_err(|e| DaemonError::SnapshotDecode {
                        seq: snap.seq,
                        detail: e.to_string(),
                    })?;
                // 快照存的是「写检查点之前」的状态，所以要从该 seq 起重放
                (restored, snap.seq)
            }
            None => (RunState::new(run_id), 0),
        }
    } else {
        (RunState::new(run_id), 0)
    };

    for event in log.events(run_id, from_seq, Some(target))? {
        state = reduce(&state, &event);
    }
    Ok(state)
}

/// 全量重放，在每个 checkpoint 处比对 state_hash。
///
/// 不一致就是内核有非确定性，当天暴露（03 §2 防线 4）。
///
/// ## 保证什么
///
/// **内核状态的一致性**：任何会改变 `reduce` 折叠结果的损坏——篡改中间
/// 事件的 payload、删除某条事件——都会在下一个 checkpoint 处被抓到，
/// 报告为 [`Mismatch`]。「篡改 payload」这一种已有测试固定
/// （`tests/replay.rs` 的 `a_tampered_checkpoint_hash_is_caught`）；
/// 「删除事件」同理会改变折叠结果，因而同样会被下一个 checkpoint 抓到，
/// 原理与篡改 payload 一致，此处不再重复建测试。
///
/// ## 不保证什么
///
/// **不保证事件序列的字节级防篡改。** 如果两条相邻事件在 `reduce` 里
/// 写的是互不覆盖的字段（例如 `run.created` 与 `intent.declared`），把它们
/// 的 seq 对调之后最终状态在数学上完全相同——`verify` 察觉不到这种重排。
/// 这不是缺陷，是「基于状态哈希比对」这类方法的固有边界：它比对的是
/// 折叠结果，不是事件本身的顺序或字节。要察觉这类重排，需要给事件链本身
/// 加密封（hash chain），那是后续阶段的事。
///
/// 另外，一份 `checkpoints_checked == 0` 的报告——不存在的 `run_id`，或者
/// 一条合法地没有任何 checkpoint 的 run——`is_ok()` 会是 true，但那是
/// 「没查」不是「查过」。调用方必须用 [`VerifyReport::is_vacuous`] 把这
/// 两种情况分开。
pub fn verify(log: &RunLog, run_id: &RunId) -> Result<VerifyReport, DaemonError> {
    let mut state = RunState::new(run_id);
    let mut checkpoints_checked = 0usize;
    let mut mismatches = Vec::new();

    for event in log.events(run_id, 0, None)? {
        if let EventBody::Checkpoint(cp) = &event.body {
            // 事件里的 hash 是「写这条 checkpoint 之前」的状态
            let actual = state_hash_hex(&state);
            checkpoints_checked += 1;
            if actual != cp.state_hash {
                mismatches.push(Mismatch {
                    seq: event.seq,
                    expected: cp.state_hash.clone(),
                    actual,
                });
            }
        }
        state = reduce(&state, &event);
    }

    Ok(VerifyReport {
        run_id: run_id.clone(),
        checkpoints_checked,
        mismatches,
        final_state_hash: state_hash_hex(&state),
    })
}

/// 一个 run 的回放结果，供 [`cli_replay`] 交回给调用方展示。
#[derive(Clone, Debug)]
pub enum RunOutcome {
    Verified(VerifyReport),
    Replayed {
        status: RunStatus,
        turn: u32,
        last_seq: u64,
        final_state_hash: String,
    },
}

/// 一个 run_id 连同它的回放结果（或失败原因）。
pub type RunReplayResult = (RunId, Result<RunOutcome, DaemonError>);

/// [`cli_replay`] 的结果：删了几个快照，以及每个 run 各自的回放结果。
#[derive(Debug)]
pub struct CliReplayReport {
    pub dropped_snapshots: usize,
    pub runs: Vec<RunReplayResult>,
}

/// `evo-cli replay` 子命令唯一允许触碰 [`RunLog`] 的入口。
///
/// `evo-cli` 自己不持有 `RunLog`——那是「唯一写 Run Log 的进程」独有的类型
/// （见 [`crate::casegen`] 顶部那句话，Task 19 定下的先例：mkcase 要生成
/// Run Log，也没有让 `evo-cli` 自己 `use evo_runlog::RunLog` 去 `append`，
/// 而是把组装逻辑收进 `evo_daemon::casegen::generate_case`，`evo-cli` 只
/// 拿组装完的结果）。`replay` 子命令要做的「开库、可选删快照、逐 run
/// 回放或回放自校验」同样只在这里发生一次，`evo-cli` 只拿到这个结构化的
/// 只读结果。
///
/// `clear_snapshots` 会真的改动 sqlite 文件（删行），这不是「写 Run Log」——
/// Run Log 是 `run_events` 表，快照是加速用的派生数据，删光快照后回放结果
/// 必须不变（CI 检查 8）——但同样的道理：这个操作也只该由这唯一的入口做。
pub fn cli_replay(
    db_path: &Path,
    blob_root: &Path,
    verify_mode: bool,
    drop_snapshots: bool,
) -> Result<CliReplayReport, DaemonError> {
    let mut log = RunLog::open(db_path, blob_root)?;
    let dropped_snapshots = if drop_snapshots {
        log.clear_snapshots()?
    } else {
        0
    };
    let run_ids = log.run_ids()?;

    let mut runs = Vec::with_capacity(run_ids.len());
    for run_id in run_ids {
        let result = if verify_mode {
            verify(&log, &run_id).map(RunOutcome::Verified)
        } else {
            replay_to(&log, &run_id, None, !drop_snapshots).map(|state| RunOutcome::Replayed {
                status: state.status,
                turn: state.turn,
                last_seq: state.last_seq,
                final_state_hash: state_hash_hex(&state),
            })
        };
        runs.push((run_id, result));
    }
    Ok(CliReplayReport {
        dropped_snapshots,
        runs,
    })
}
