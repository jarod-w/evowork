use crate::RunLogError;
use crate::blobstore::BlobStore;
use crate::schema::DDL;
use evo_protocol::{Actor, Event, EventBody, RunId};
use rusqlite::{Connection, params};
use std::path::Path;

/// Run Log 的 SQLite 存储层。
///
/// **单写者假定**：本类型假定同一时刻只有一个写者在追加同一个 run 的事件——
/// 在 evowork 里这个写者永远是 `evo-daemon`。这不是巧合，是架构约束的直接
/// 收益：设计文档明确「只有 evo-daemon 写 Run Log」，多写者一致性问题因此
/// 根本不存在，`RunLog` 也就没有必要为多写者场景做协调（加锁、重试、
/// CAS 循环……）。见 `append` 的文档了解违反这条假定时会发生什么。
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
        Ok(Self {
            conn,
            blobs: BlobStore::open(blob_root)?,
        })
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
    ///
    /// seq 分配方式是「事务外读 [`last_seq`](Self::last_seq)、事务内 INSERT」，
    /// 中间没有锁把这两步粘在一起。这在单写者假定下没有问题——见
    /// [`RunLog`] 的类型级文档。但如果假定被打破，也就是**同一个 run**
    /// 出现了第二个并发写者，两次调用可能算出同一个 seq；此时 `run_events`
    /// 上的 `PRIMARY KEY (run_id, seq)` 约束会在第一条 INSERT 执行时**立即**
    /// 被检查，冲突导致 `tx.execute()` 返回 `SqliteFailure`（SQLite 扩展错误码 1555，
    /// `SQLITE_CONSTRAINT_PRIMARYKEY`），`?` 直接短路返回错误；后续的 `runs`
    /// 表 INSERT 和 `tx.commit()` 都不会被执行到，事务在 Transaction 被 Drop
    /// 时自动回滚——不会出现两条事件共用一个 seq，也不会有事件被静默吞掉。
    ///
    /// **拿到这个 `Err` 时，正确的反应是去找那个第二个写者，而不是重试。**
    /// 单写者是本存储层唯一依赖的并发不变量；这里的 `Err` 就是它被违反的
    /// 信号——说明有代码绕过了「只有 evo-daemon 写 Run Log」的边界。重试
    /// 能让调用方的这一次 `append` 看起来成功，但那只是用循环把一次边界
    /// 违规糊过去：下一次冲突还会发生，而且从此没有任何报错能提醒任何人
    /// 去修那个真正多出来的写者。因此本方法不会加重试循环，也不会加锁——
    /// 加了反而会把「边界被破坏」从一次响亮的 `Err` 变成静默容忍。
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
        let mut stmt = self
            .conn
            .prepare("SELECT run_id FROM runs ORDER BY run_id")?;
        let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
        rows.map(|r| r.map(RunId::from).map_err(RunLogError::from))
            .collect()
    }
}
