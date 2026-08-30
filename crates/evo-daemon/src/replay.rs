use crate::runtime::DaemonError;
use evo_kernel::{RunState, RunStatus, reduce, state_hash, state_hash_hex};
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

/// 一个快照没通过自校验、被丢弃了。
///
/// 这不是错误——快照本就可丢弃，丢掉它退回全量 fold 得到的是同一个结果。
/// 但它是一个**必须能被看见**的信号：正常运行的系统不会写出对不上自己
/// 哈希的快照，出现它意味着 sqlite 文件被改过（或者写快照的那条路径有
/// 缺陷），两种都值得有人来看一眼。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SnapshotRejected {
    pub seq: u64,
    /// 快照自带的 `state_hash` 列（hex）
    pub expected: String,
    /// 对快照 blob 解出来的 state 重算出的哈希（hex）
    pub actual: String,
}

/// 回放到某个 seq。**不重新调模型、不重新执行 effect**——
/// 直接重放同一批事件，内核走过完全相同的路径。
///
/// `use_snapshots` 只影响从哪里起步，不影响结果。这一点由
/// 「删光快照结果不变」那条测试保证，也由 [`replay_to_checked`] 里的
/// 快照自校验兜住：对不上就当没有快照。
pub fn replay_to(
    log: &RunLog,
    run_id: &RunId,
    to_seq: Option<u64>,
    use_snapshots: bool,
) -> Result<RunState, DaemonError> {
    replay_to_checked(log, run_id, to_seq, use_snapshots).map(|(state, _)| state)
}

/// 同 [`replay_to`]，另外交回「有没有快照因为自校验没过而被丢弃」。
///
/// ## 为什么必须校验
///
/// 快照是加速器，Log 是唯一权威事实（03 §5）。此前这里直接
/// `ciborium::from_reader` 把快照 blob 当起点，`snapshots.state_hash`
/// 这一列读进了 `Snapshot` 结构体却**从不比对**——改一改快照里的
/// `budget_used`/`taint`，不动任何事件、不动哈希列，带快照的回放就会
/// 算出一个 Log 里根本不存在的状态，而 `verify()` 照样报 is_ok（它比的
/// 是 checkpoint 事件里的哈希，不是快照）。`Runtime::resume` 走的正是
/// 这条路径，被污染的快照会直接驱动真实执行（M2 终审 BL-2）。
///
/// ## 为什么是降级而不是报错
///
/// 「快照可丢弃」这条性质让兜底零代价：扔掉快照退回全量 fold，结果必然
/// 与诚实回放相同，调用方什么都不会失去（只是慢一点）。反过来，报错终止
/// 会把一次数据损坏升级成「这条 run 再也恢复不了」——把可用性搭进去换
/// 一个本来就不需要的强硬姿态。所以：静默降级，但留下信号（返回值里的
/// [`SnapshotRejected`]，外加一行 stderr 警告，因为不是每个调用方都会看
/// 返回值里的这一项）。
pub fn replay_to_checked(
    log: &RunLog,
    run_id: &RunId,
    to_seq: Option<u64>,
    use_snapshots: bool,
) -> Result<(RunState, Option<SnapshotRejected>), DaemonError> {
    let target = match to_seq {
        Some(s) => s,
        None => log.last_seq(run_id)?.unwrap_or(0),
    };

    let mut rejected = None;
    let (mut state, from_seq) = if use_snapshots {
        match log.snapshot_at_or_before(run_id, target)? {
            Some(snap) => {
                let restored: RunState = ciborium::from_reader(snap.state_blob.as_slice())
                    .map_err(|e| DaemonError::SnapshotDecode {
                        seq: snap.seq,
                        detail: e.to_string(),
                    })?;
                let actual = state_hash(&restored);
                if actual[..] == snap.state_hash[..] {
                    // 快照存的是「写检查点之前」的状态，所以要从该 seq 起重放
                    (restored, snap.seq)
                } else {
                    let r = SnapshotRejected {
                        seq: snap.seq,
                        expected: hex::encode(&snap.state_hash),
                        actual: hex::encode(actual),
                    };
                    eprintln!(
                        "warning: 丢弃 run {run_id} 在 seq {} 的快照（自校验没过：\
                         快照声称 {}，重算得 {}），退回全量 fold",
                        r.seq, r.expected, r.actual
                    );
                    rejected = Some(r);
                    (RunState::new(run_id), 0)
                }
            }
            None => (RunState::new(run_id), 0),
        }
    } else {
        (RunState::new(run_id), 0)
    };

    for event in log.events(run_id, from_seq, Some(target))? {
        state = reduce(&state, &event);
    }
    Ok((state, rejected))
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
///
/// 改名自 `RunOutcome`（M2 Task 3）：`crate::runtime::RunOutcome` 那个更
/// 核心的概念（`start`/`resume`/`decide_approval`/`answer_clarification`
/// 的统一产出——`Completed`/`Suspended`/`Failed`）需要占用 `RunOutcome`
/// 这个名字，两者不能同时在 crate 根部 `pub use` 成同一个标识符，因此把
/// 这个更早、更局限于 CLI 回放展示的类型让出名字。
#[derive(Clone, Debug)]
pub enum ReplayOutcome {
    Verified(VerifyReport),
    Replayed {
        status: RunStatus,
        turn: u32,
        last_seq: u64,
        final_state_hash: String,
    },
}

/// 一个 run_id 连同它的回放结果（或失败原因）。
pub type RunReplayResult = (RunId, Result<ReplayOutcome, DaemonError>);

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
            verify(&log, &run_id).map(ReplayOutcome::Verified)
        } else {
            replay_to(&log, &run_id, None, !drop_snapshots).map(|state| ReplayOutcome::Replayed {
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
