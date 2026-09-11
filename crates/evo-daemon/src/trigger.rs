//! 触发器定义的存储与「何时该醒」的纯函数。
//!
//! 这不是 Run Log 的投影：触发器是「什么时候起一条 run」的定义，run
//! 自己的状态仍然只活在 Log 里。红线那句「不要另起一张表记状态或成本」
//! 管的是 run 的状态/成本，不是调度表。
//!
//! 本模块**不**读墙钟。`next_fire_ms` / `due` 都吃一个 `now_ms`，由
//! daemon 的 [`crate::Clock`] 提供。内核仍然碰不到这里。

use evo_protocol::events::lifecycle::TriggerKind;
use evo_protocol::rpc::{TriggerSpec, TriggerView};
use evo_protocol::{RunId, TriggerId};
use rusqlite::{Connection, OptionalExtension, params};
use std::path::{Path, PathBuf};
use thiserror::Error;

const MS_PER_MINUTE: i64 = 60_000;
const MS_PER_HOUR: i64 = 3_600_000;
const MS_PER_DAY: i64 = 86_400_000;

const DDL: &str = r#"
CREATE TABLE IF NOT EXISTS triggers (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  intent TEXT NOT NULL,
  spec_json TEXT NOT NULL,
  paused INTEGER NOT NULL DEFAULT 0,
  hook_secret TEXT,
  next_fire_ms INTEGER,
  last_run_id TEXT,
  last_fired_ms INTEGER,
  created_ms INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_triggers_hook_secret
  ON triggers(hook_secret) WHERE hook_secret IS NOT NULL;
"#;

#[derive(Debug, Error)]
pub enum TriggerStoreError {
    #[error("sqlite: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("trigger spec json: {0}")]
    SpecJson(#[from] serde_json::Error),
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TriggerRecord {
    pub id: TriggerId,
    pub name: String,
    pub intent: String,
    pub spec: TriggerSpec,
    pub paused: bool,
    pub hook_secret: Option<String>,
    pub next_fire_ms: Option<u64>,
    pub last_run_id: Option<RunId>,
    pub last_fired_ms: Option<u64>,
    pub created_ms: u64,
}

impl TriggerRecord {
    pub fn view(&self) -> TriggerView {
        TriggerView {
            trigger_id: self.id.clone(),
            name: self.name.clone(),
            intent: self.intent.clone(),
            kind: self.spec.trigger_kind(),
            spec: self.spec.clone(),
            paused: self.paused,
            next_fire_ms: self.next_fire_ms,
            last_run_id: self.last_run_id.clone(),
            last_fired_ms: self.last_fired_ms,
            hook_path: self
                .hook_secret
                .as_ref()
                .map(|secret| format!("/v1/hooks/{secret}")),
            created_ms: self.created_ms,
        }
    }

    pub fn kind(&self) -> TriggerKind {
        self.spec.trigger_kind()
    }
}

pub fn trigger_db_path(runlog_path: &Path) -> PathBuf {
    match runlog_path.parent() {
        Some(parent) if !parent.as_os_str().is_empty() => parent.join("triggers.sqlite"),
        _ => PathBuf::from("triggers.sqlite"),
    }
}

pub fn validate_spec(spec: &TriggerSpec) -> Result<(), String> {
    match spec {
        TriggerSpec::Once { .. } => Ok(()),
        TriggerSpec::Interval { every_ms } => {
            if *every_ms == 0 {
                Err("interval.every_ms must be > 0".into())
            } else {
                Ok(())
            }
        }
        TriggerSpec::Daily {
            hour,
            minute,
            tz_offset_minutes,
        } => validate_clock(*hour, *minute, *tz_offset_minutes),
        TriggerSpec::Weekly {
            weekday,
            hour,
            minute,
            tz_offset_minutes,
        } => {
            if *weekday > 6 {
                return Err("weekly.weekday must be 0..=6 (0=Monday)".into());
            }
            validate_clock(*hour, *minute, *tz_offset_minutes)
        }
        TriggerSpec::Monthly {
            day,
            hour,
            minute,
            tz_offset_minutes,
        } => {
            if *day == 0 || *day > 31 {
                return Err("monthly.day must be 1..=31".into());
            }
            validate_clock(*hour, *minute, *tz_offset_minutes)
        }
        TriggerSpec::Webhook => Ok(()),
    }
}

fn validate_clock(hour: u8, minute: u8, tz_offset_minutes: i16) -> Result<(), String> {
    if hour > 23 {
        return Err("hour must be 0..=23".into());
    }
    if minute > 59 {
        return Err("minute must be 0..=59".into());
    }
    if !(-14 * 60..=14 * 60).contains(&tz_offset_minutes) {
        return Err("tz_offset_minutes must be within ±14 hours".into());
    }
    Ok(())
}

/// `from_ms` 起（含）的下一次开火时刻。webhook 没有时刻。once 在已经
/// 开过火之后调用方应直接把 `next_fire_ms` 置空，不要再问这里。
pub fn next_fire_ms(spec: &TriggerSpec, from_ms: u64) -> Option<u64> {
    match spec {
        TriggerSpec::Webhook => None,
        TriggerSpec::Once { at_ms } => Some(*at_ms),
        TriggerSpec::Interval { every_ms } => Some(from_ms.saturating_add(*every_ms)),
        TriggerSpec::Daily {
            hour,
            minute,
            tz_offset_minutes,
        } => Some(next_daily(from_ms, *hour, *minute, *tz_offset_minutes)),
        TriggerSpec::Weekly {
            weekday,
            hour,
            minute,
            tz_offset_minutes,
        } => Some(next_weekly(
            from_ms,
            *weekday,
            *hour,
            *minute,
            *tz_offset_minutes,
        )),
        TriggerSpec::Monthly {
            day,
            hour,
            minute,
            tz_offset_minutes,
        } => Some(next_monthly(
            from_ms,
            *day,
            *hour,
            *minute,
            *tz_offset_minutes,
        )),
    }
}

fn local_ms(utc_ms: u64, tz_offset_minutes: i16) -> i64 {
    utc_ms as i64 + i64::from(tz_offset_minutes) * MS_PER_MINUTE
}

fn utc_from_local(local: i64, tz_offset_minutes: i16) -> u64 {
    (local - i64::from(tz_offset_minutes) * MS_PER_MINUTE).max(0) as u64
}

fn next_daily(from_ms: u64, hour: u8, minute: u8, tz_offset_minutes: i16) -> u64 {
    let local = local_ms(from_ms, tz_offset_minutes);
    let tod = local.rem_euclid(MS_PER_DAY);
    let day_start = local - tod;
    let target_tod = i64::from(hour) * MS_PER_HOUR + i64::from(minute) * MS_PER_MINUTE;
    let local_next = if tod <= target_tod {
        day_start + target_tod
    } else {
        day_start + MS_PER_DAY + target_tod
    };
    utc_from_local(local_next, tz_offset_minutes)
}

fn next_weekly(from_ms: u64, weekday: u8, hour: u8, minute: u8, tz_offset_minutes: i16) -> u64 {
    let local = local_ms(from_ms, tz_offset_minutes);
    let tod = local.rem_euclid(MS_PER_DAY);
    let day_start = local - tod;
    let days_since_epoch = day_start.div_euclid(MS_PER_DAY);
    // 1970-01-01 Thursday. 0=Monday → Thursday=3.
    let wd = ((days_since_epoch + 3).rem_euclid(7)) as u8;
    let target_tod = i64::from(hour) * MS_PER_HOUR + i64::from(minute) * MS_PER_MINUTE;
    let mut delta_days = i64::from((weekday + 7 - wd) % 7);
    if delta_days == 0 && tod > target_tod {
        delta_days = 7;
    }
    utc_from_local(
        day_start + delta_days * MS_PER_DAY + target_tod,
        tz_offset_minutes,
    )
}

fn next_monthly(from_ms: u64, day: u8, hour: u8, minute: u8, tz_offset_minutes: i16) -> u64 {
    let local = local_ms(from_ms, tz_offset_minutes);
    let tod = local.rem_euclid(MS_PER_DAY);
    let day_start = local - tod;
    let unix_days = day_start.div_euclid(MS_PER_DAY);
    let (mut year, mut month, _) = civil_from_unix_days(unix_days);
    let target_tod = i64::from(hour) * MS_PER_HOUR + i64::from(minute) * MS_PER_MINUTE;
    for _ in 0..28 {
        if let Some(days_in) = days_in_month(year, month)
            && u32::from(day) <= days_in
        {
            let candidate_days = unix_days_from_civil(year, month, u32::from(day));
            let candidate_local = candidate_days * MS_PER_DAY + target_tod;
            if candidate_local >= local {
                return utc_from_local(candidate_local, tz_offset_minutes);
            }
        }
        month += 1;
        if month == 13 {
            month = 1;
            year += 1;
        }
    }
    // 28 个月还找不到是 validate 漏了。退回 from_ms 会让调度每 tick
    // 重试，至少不会静默丢。
    from_ms
}

fn days_in_month(year: i32, month: u32) -> Option<u32> {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => Some(31),
        4 | 6 | 9 | 11 => Some(30),
        2 => Some(if is_leap(year) { 29 } else { 28 }),
        _ => None,
    }
}

fn is_leap(year: i32) -> bool {
    year % 4 == 0 && (year % 100 != 0 || year % 400 == 0)
}

/// Howard Hinnant's `civil_from_days`, unix day 0 = 1970-01-01.
fn civil_from_unix_days(unix_days: i64) -> (i32, u32, u32) {
    let z = unix_days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u32;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe as i32 + era as i32 * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    (y, m, d)
}

fn unix_days_from_civil(mut y: i32, m: u32, d: u32) -> i64 {
    y -= i32::from(m <= 2);
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = (y - era * 400) as u32;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era as i64 * 146_097 + doe as i64 - 719_468
}

pub struct TriggerStore {
    conn: Connection,
}

impl TriggerStore {
    pub fn open(path: &Path) -> Result<Self, TriggerStoreError> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let conn = Connection::open(path)?;
        conn.execute_batch(DDL)?;
        Ok(Self { conn })
    }

    pub fn insert(&self, rec: &TriggerRecord) -> Result<(), TriggerStoreError> {
        self.conn.execute(
            "INSERT INTO triggers (id, name, intent, spec_json, paused, hook_secret,
                 next_fire_ms, last_run_id, last_fired_ms, created_ms)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![
                rec.id.as_str(),
                rec.name,
                rec.intent,
                serde_json::to_string(&rec.spec)?,
                rec.paused as i64,
                rec.hook_secret,
                rec.next_fire_ms.map(|v| v as i64),
                rec.last_run_id.as_ref().map(|v| v.as_str().to_owned()),
                rec.last_fired_ms.map(|v| v as i64),
                rec.created_ms as i64,
            ],
        )?;
        Ok(())
    }

    pub fn update(&self, rec: &TriggerRecord) -> Result<(), TriggerStoreError> {
        let n = self.conn.execute(
            "UPDATE triggers SET name = ?2, intent = ?3, spec_json = ?4, paused = ?5,
                 hook_secret = ?6, next_fire_ms = ?7, last_run_id = ?8,
                 last_fired_ms = ?9
             WHERE id = ?1",
            params![
                rec.id.as_str(),
                rec.name,
                rec.intent,
                serde_json::to_string(&rec.spec)?,
                rec.paused as i64,
                rec.hook_secret,
                rec.next_fire_ms.map(|v| v as i64),
                rec.last_run_id.as_ref().map(|v| v.as_str().to_owned()),
                rec.last_fired_ms.map(|v| v as i64),
            ],
        )?;
        if n == 0 {
            return Err(TriggerStoreError::Sqlite(
                rusqlite::Error::QueryReturnedNoRows,
            ));
        }
        Ok(())
    }

    pub fn delete(&self, id: &TriggerId) -> Result<bool, TriggerStoreError> {
        let n = self
            .conn
            .execute("DELETE FROM triggers WHERE id = ?1", params![id.as_str()])?;
        Ok(n > 0)
    }

    pub fn get(&self, id: &TriggerId) -> Result<Option<TriggerRecord>, TriggerStoreError> {
        self.query_one("SELECT id, name, intent, spec_json, paused, hook_secret, next_fire_ms, last_run_id, last_fired_ms, created_ms FROM triggers WHERE id = ?1", params![id.as_str()])
    }

    pub fn get_by_secret(&self, secret: &str) -> Result<Option<TriggerRecord>, TriggerStoreError> {
        self.query_one("SELECT id, name, intent, spec_json, paused, hook_secret, next_fire_ms, last_run_id, last_fired_ms, created_ms FROM triggers WHERE hook_secret = ?1", params![secret])
    }

    pub fn list(&self) -> Result<Vec<TriggerRecord>, TriggerStoreError> {
        let mut stmt = self.conn.prepare(
            "SELECT id, name, intent, spec_json, paused, hook_secret, next_fire_ms, last_run_id, last_fired_ms, created_ms
             FROM triggers ORDER BY created_ms DESC, id DESC",
        )?;
        let rows = stmt.query_map([], row_to_record)?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(TriggerStoreError::from)
            .and_then(|rows| {
                rows.into_iter()
                    .map(record_from_mapped)
                    .collect::<Result<Vec<_>, _>>()
            })
    }

    pub fn due(&self, now_ms: u64) -> Result<Vec<TriggerRecord>, TriggerStoreError> {
        let mut stmt = self.conn.prepare(
            "SELECT id, name, intent, spec_json, paused, hook_secret, next_fire_ms, last_run_id, last_fired_ms, created_ms
             FROM triggers
             WHERE paused = 0 AND next_fire_ms IS NOT NULL AND next_fire_ms <= ?1
             ORDER BY next_fire_ms, id",
        )?;
        let rows = stmt.query_map(params![now_ms as i64], row_to_record)?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(TriggerStoreError::from)
            .and_then(|rows| {
                rows.into_iter()
                    .map(record_from_mapped)
                    .collect::<Result<Vec<_>, _>>()
            })
    }

    fn query_one(
        &self,
        sql: &str,
        params: impl rusqlite::Params,
    ) -> Result<Option<TriggerRecord>, TriggerStoreError> {
        let row = self.conn.query_row(sql, params, row_to_record).optional()?;
        match row {
            None => Ok(None),
            Some(mapped) => Ok(Some(record_from_mapped(mapped)?)),
        }
    }
}

struct MappedRow {
    id: String,
    name: String,
    intent: String,
    spec_json: String,
    paused: i64,
    hook_secret: Option<String>,
    next_fire_ms: Option<i64>,
    last_run_id: Option<String>,
    last_fired_ms: Option<i64>,
    created_ms: i64,
}

fn row_to_record(row: &rusqlite::Row<'_>) -> rusqlite::Result<MappedRow> {
    Ok(MappedRow {
        id: row.get(0)?,
        name: row.get(1)?,
        intent: row.get(2)?,
        spec_json: row.get(3)?,
        paused: row.get(4)?,
        hook_secret: row.get(5)?,
        next_fire_ms: row.get(6)?,
        last_run_id: row.get(7)?,
        last_fired_ms: row.get(8)?,
        created_ms: row.get(9)?,
    })
}

fn record_from_mapped(row: MappedRow) -> Result<TriggerRecord, TriggerStoreError> {
    Ok(TriggerRecord {
        id: TriggerId::from(row.id),
        name: row.name,
        intent: row.intent,
        spec: serde_json::from_str(&row.spec_json)?,
        paused: row.paused != 0,
        hook_secret: row.hook_secret,
        next_fire_ms: row.next_fire_ms.map(|v| v as u64),
        last_run_id: row.last_run_id.map(RunId::from),
        last_fired_ms: row.last_fired_ms.map(|v| v as u64),
        created_ms: row.created_ms as u64,
    })
}

pub fn random_hook_secret() -> Result<String, TriggerStoreError> {
    use std::io::Read;
    let mut buf = [0u8; 16];
    std::fs::File::open("/dev/urandom")?.read_exact(&mut buf)?;
    Ok(hex::encode(buf))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unix_day_zero_is_1970_01_01() {
        assert_eq!(civil_from_unix_days(0), (1970, 1, 1));
        assert_eq!(unix_days_from_civil(1970, 1, 1), 0);
        assert_eq!(unix_days_from_civil(1970, 1, 2), 1);
    }

    #[test]
    fn weekday_monday0_epoch_is_thursday() {
        // 1970-01-01 00:00 UTC = Thursday = 3.
        let local = local_ms(0, 0);
        let days = local.div_euclid(MS_PER_DAY);
        let wd = ((days + 3).rem_euclid(7)) as u8;
        assert_eq!(wd, 3);
        // 1970-01-05 is Monday.
        let monday = 4 * MS_PER_DAY as u64;
        let days = local_ms(monday, 0).div_euclid(MS_PER_DAY);
        let wd = ((days + 3).rem_euclid(7)) as u8;
        assert_eq!(wd, 0);
    }

    #[test]
    fn once_in_the_past_stays_due_at_that_instant() {
        let spec = TriggerSpec::Once { at_ms: 100 };
        assert_eq!(next_fire_ms(&spec, 1_000), Some(100));
    }

    #[test]
    fn interval_first_fire_is_one_period_from_now() {
        let spec = TriggerSpec::Interval { every_ms: 10_000 };
        assert_eq!(next_fire_ms(&spec, 5_000), Some(15_000));
    }

    #[test]
    fn webhook_has_no_next_fire() {
        assert_eq!(next_fire_ms(&TriggerSpec::Webhook, 1), None);
    }

    #[test]
    fn weekly_monday_0800_cst_from_the_sunday_before() {
        // 2026-09-14 08:00 CST = 2026-09-14 00:00 UTC = 1789344000000, a Monday.
        let monday_0800_cst = 1_789_344_000_000;
        let spec = TriggerSpec::Weekly {
            weekday: 0,
            hour: 8,
            minute: 0,
            tz_offset_minutes: 480,
        };
        // Sunday 2026-09-13 00:00 UTC, still before that slot.
        let sunday = monday_0800_cst - MS_PER_DAY as u64;
        assert_eq!(next_fire_ms(&spec, sunday), Some(monday_0800_cst));
        // Exactly on the slot: due now.
        assert_eq!(next_fire_ms(&spec, monday_0800_cst), Some(monday_0800_cst));
        // One ms later: next week.
        assert_eq!(
            next_fire_ms(&spec, monday_0800_cst + 1),
            Some(monday_0800_cst + MS_PER_DAY as u64 * 7)
        );
    }

    #[test]
    fn monthly_day_31_skips_february() {
        // 2026-02-01 00:00 UTC. Next 31st at 08:00 UTC is March 31.
        let feb1 = 1_769_904_000_000;
        let mar31_0800_utc = 1_774_944_000_000;
        let spec = TriggerSpec::Monthly {
            day: 31,
            hour: 8,
            minute: 0,
            tz_offset_minutes: 0,
        };
        assert_eq!(next_fire_ms(&spec, feb1), Some(mar31_0800_utc));
    }

    #[test]
    fn validate_rejects_zero_interval_and_bad_weekday() {
        assert!(validate_spec(&TriggerSpec::Interval { every_ms: 0 }).is_err());
        assert!(
            validate_spec(&TriggerSpec::Weekly {
                weekday: 7,
                hour: 8,
                minute: 0,
                tz_offset_minutes: 0,
            })
            .is_err()
        );
        assert!(validate_spec(&TriggerSpec::Once { at_ms: 0 }).is_ok());
    }

    #[test]
    fn store_roundtrips_and_due_skips_paused() {
        let dir = tempfile::tempdir().unwrap();
        let store = TriggerStore::open(&dir.path().join("triggers.sqlite")).unwrap();
        let due = TriggerRecord {
            id: TriggerId::from("t-due"),
            name: "nightly".into(),
            intent: "出表".into(),
            spec: TriggerSpec::Once { at_ms: 50 },
            paused: false,
            hook_secret: None,
            next_fire_ms: Some(50),
            last_run_id: None,
            last_fired_ms: None,
            created_ms: 1,
        };
        let paused = TriggerRecord {
            id: TriggerId::from("t-paused"),
            name: "paused".into(),
            intent: "出表".into(),
            spec: TriggerSpec::Once { at_ms: 10 },
            paused: true,
            hook_secret: None,
            next_fire_ms: Some(10),
            last_run_id: None,
            last_fired_ms: None,
            created_ms: 2,
        };
        store.insert(&due).unwrap();
        store.insert(&paused).unwrap();
        let got: Vec<String> = store
            .due(100)
            .unwrap()
            .into_iter()
            .map(|r| r.id.as_str().to_owned())
            .collect();
        assert_eq!(got, vec!["t-due"]);
        assert!(store.delete(&TriggerId::from("t-due")).unwrap());
        assert!(store.get(&TriggerId::from("t-due")).unwrap().is_none());
    }
}
