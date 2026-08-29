use crate::RunLogError;
use crate::store::RunLog;
use evo_protocol::ids::RunId;
use rusqlite::{OptionalExtension, params};

/// 快照的内容对 store 是不透明的字节。
///
/// **故意不认 RunState**：快照只是加速，删掉不影响正确性。
/// store 不知道自己存的是什么，也就无从往里塞一个 Log 里没有的状态——
/// 那一刻快照会从加速器变成第二份权威事实（03 §5）。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Snapshot {
    pub seq: u64,
    pub state_blob: Vec<u8>,
    pub state_hash: Vec<u8>,
}

impl RunLog {
    pub fn put_snapshot(
        &mut self,
        run_id: &RunId,
        seq: u64,
        state_blob: &[u8],
        state_hash: &[u8],
    ) -> Result<(), RunLogError> {
        self.conn_mut().execute(
            "INSERT INTO snapshots (run_id, seq, state_blob, state_hash) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(run_id, seq) DO UPDATE SET state_blob = ?3, state_hash = ?4",
            params![run_id.as_str(), seq as i64, state_blob, state_hash],
        )?;
        Ok(())
    }

    pub fn snapshot_at_or_before(
        &self,
        run_id: &RunId,
        seq: u64,
    ) -> Result<Option<Snapshot>, RunLogError> {
        let row = self
            .conn()
            .query_row(
                "SELECT seq, state_blob, state_hash FROM snapshots
                 WHERE run_id = ?1 AND seq <= ?2 ORDER BY seq DESC LIMIT 1",
                params![run_id.as_str(), seq as i64],
                |row| {
                    Ok(Snapshot {
                        seq: row.get::<_, i64>(0)? as u64,
                        state_blob: row.get(1)?,
                        state_hash: row.get(2)?,
                    })
                },
            )
            .optional()?;
        Ok(row)
    }

    pub fn snapshot_count(&self) -> Result<usize, RunLogError> {
        let n: i64 = self
            .conn()
            .query_row("SELECT COUNT(*) FROM snapshots", [], |r| r.get(0))?;
        Ok(n as usize)
    }

    /// CI 检查 8 用：删光快照后回放结果必须不变。
    pub fn clear_snapshots(&mut self) -> Result<usize, RunLogError> {
        Ok(self.conn_mut().execute("DELETE FROM snapshots", [])?)
    }
}
