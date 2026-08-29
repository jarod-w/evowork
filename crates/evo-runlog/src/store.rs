use crate::blobstore::BlobStore;
use crate::schema::DDL;
use crate::RunLogError;
use evo_protocol::{Actor, Event, EventBody, RunId};
use rusqlite::{params, Connection};
use std::path::Path;

pub struct RunLog {
    conn: Connection,
    blobs: BlobStore,
}

impl RunLog {
    pub fn open(db_path: &Path, blob_root: &Path) -> Result<Self, RunLogError> {
        if let Some(parent) = db_path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let conn = Connection::open(db_path)?;
        conn.execute_batch(DDL)?;
        Ok(Self { conn, blobs: BlobStore::open(blob_root)? })
    }

    pub fn blobs(&self) -> &BlobStore {
        &self.blobs
    }

    pub fn last_seq(&self, run_id: &RunId) -> Result<Option<u64>, RunLogError> {
        let v: Option<i64> = self.conn.query_row(
            "SELECT MAX(seq) FROM run_events WHERE run_id = ?1",
            params![run_id.as_str()],
            |row| row.get(0),
        )?;
        Ok(v.map(|s| s as u64))
    }

    /// 追加一条事件。seq 由本函数分配，调用方不许自己算。
    pub fn append(
        &mut self,
        run_id: &RunId,
        actor: Actor,
        recorded_at: &str,
        body: EventBody,
    ) -> Result<Event, RunLogError> {
        let seq = self.last_seq(run_id)?.map_or(0, |s| s + 1);
        let event = Event {
            run_id: run_id.clone(),
            seq,
            recorded_at: recorded_at.to_owned(),
            actor,
            schema_ver: body.schema_ver(),
            body,
        };
        let payload = serde_json::to_string(&event.body)?;
        let actor_str = serde_json::to_string(&event.actor)?;
        let tx = self.conn.transaction()?;
        tx.execute(
            "INSERT INTO run_events (run_id, seq, kind, schema_ver, recorded_at, actor, payload)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                event.run_id.as_str(),
                event.seq as i64,
                event.body.kind(),
                event.schema_ver as i64,
                event.recorded_at,
                actor_str,
                payload
            ],
        )?;
        // runs 是投影表：只从事件推导，不接受任何 Log 里没有的字段。
        //
        // 阶段 1 只维护 run_id / 时间戳 / last_seq —— 这是 run_ids() 唯一用到的部分。
        // workspace_id / principal / status / cost_micros 要从 run.created、run.completed、
        // cost.charged 折叠出来，那是阶段 3 接 `run.list` / `cost.query` 时的事；
        // **在此之前不许有任何读取方依赖这几列**，否则它们会被当成真值。
        tx.execute(
            "INSERT INTO runs (run_id, parent_run_id, workspace_id, principal, status,
                               created_at, updated_at, last_seq, title, cost_micros)
             VALUES (?1, NULL, '', '', 'running', ?2, ?2, ?3, NULL, 0)
             ON CONFLICT(run_id) DO UPDATE SET updated_at = ?2, last_seq = ?3",
            params![event.run_id.as_str(), event.recorded_at, event.seq as i64],
        )?;
        tx.commit()?;
        Ok(event)
    }

    /// 读 [from_seq, to_seq] 闭区间；to_seq 为 None 时读到末尾。
    pub fn events(
        &self,
        run_id: &RunId,
        from_seq: u64,
        to_seq: Option<u64>,
    ) -> Result<Vec<Event>, RunLogError> {
        let upper = to_seq.map_or(i64::MAX, |s| s as i64);
        let mut stmt = self.conn.prepare(
            "SELECT seq, schema_ver, recorded_at, actor, payload FROM run_events
             WHERE run_id = ?1 AND seq >= ?2 AND seq <= ?3 ORDER BY seq",
        )?;
        let rows = stmt.query_map(params![run_id.as_str(), from_seq as i64, upper], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
            ))
        })?;
        let mut out = Vec::new();
        for row in rows {
            let (seq, schema_ver, recorded_at, actor, payload) = row?;
            out.push(Event {
                run_id: run_id.clone(),
                seq: seq as u64,
                recorded_at,
                actor: serde_json::from_str(&actor)?,
                schema_ver: schema_ver as u32,
                body: serde_json::from_str(&payload)?,
            });
        }
        Ok(out)
    }

    pub fn run_ids(&self) -> Result<Vec<RunId>, RunLogError> {
        let mut stmt = self.conn.prepare("SELECT run_id FROM runs ORDER BY run_id")?;
        let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
        rows.map(|r| r.map(RunId::from).map_err(RunLogError::from)).collect()
    }
}
