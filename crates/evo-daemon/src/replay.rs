use crate::runtime::DaemonError;
use evo_kernel::{RunState, reduce, state_hash};
use evo_protocol::EventBody;
use evo_protocol::ids::RunId;
use evo_runlog::RunLog;

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
    pub fn is_ok(&self) -> bool {
        self.mismatches.is_empty()
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
pub fn verify(log: &RunLog, run_id: &RunId) -> Result<VerifyReport, DaemonError> {
    let mut state = RunState::new(run_id);
    let mut checkpoints_checked = 0usize;
    let mut mismatches = Vec::new();

    for event in log.events(run_id, 0, None)? {
        if let EventBody::Checkpoint(cp) = &event.body {
            // 事件里的 hash 是「写这条 checkpoint 之前」的状态
            let actual = hex::encode(state_hash(&state));
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
        final_state_hash: hex::encode(state_hash(&state)),
    })
}
