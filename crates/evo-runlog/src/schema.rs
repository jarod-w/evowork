/// 01 §2 的表结构，逐字落地。这就是最终结构，不是「先凑合」。
pub const DDL: &str = r#"
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS run_events (
  run_id      TEXT    NOT NULL,
  seq         INTEGER NOT NULL,
  kind        TEXT    NOT NULL,
  schema_ver  INTEGER NOT NULL,
  recorded_at TEXT    NOT NULL,
  actor       TEXT    NOT NULL,
  payload     TEXT    NOT NULL,
  prev_hash   BLOB,
  hash        BLOB,
  PRIMARY KEY (run_id, seq)
) STRICT;

-- 纯投影表，可从 run_events 全量重建
CREATE TABLE IF NOT EXISTS runs (
  run_id TEXT PRIMARY KEY, parent_run_id TEXT, workspace_id TEXT NOT NULL,
  principal TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL, last_seq INTEGER NOT NULL,
  title TEXT, cost_micros INTEGER NOT NULL DEFAULT 0
) STRICT;

-- 只是加速，删掉不影响正确性（CI 检查 8 会验这一点）
CREATE TABLE IF NOT EXISTS snapshots (
  run_id TEXT NOT NULL, seq INTEGER NOT NULL,
  state_blob BLOB NOT NULL, state_hash BLOB NOT NULL,
  PRIMARY KEY (run_id, seq)
) STRICT;

CREATE TABLE IF NOT EXISTS blobs (
  content_hash TEXT PRIMARY KEY,
  size INTEGER NOT NULL, mime TEXT NOT NULL,
  path TEXT NOT NULL,
  class TEXT NOT NULL,
  created_at TEXT NOT NULL, retain_until TEXT
) STRICT;

CREATE INDEX IF NOT EXISTS idx_run_events_kind ON run_events(run_id, kind);
"#;
