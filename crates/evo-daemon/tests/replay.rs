use evo_daemon::{DaemonConfig, FixedClock, Runtime, replay_to, verify};
use evo_exec_local::{LocalExecutor, WorkspaceOnlySandbox};
use evo_kernel::state_hash;
use evo_model::FixtureAdapter;
use evo_protocol::RunId;
use evo_runlog::RunLog;
use std::sync::Arc;

const FIXTURES: &str = r#"{
  "provider": "fixture",
  "model": "fixture-v1",
  "responses": [
    { "text": "{\"intent\":\"tool_call\",\"tool\":\"fs.write\",\"params\":{\"path\":\"report.txt\",\"content\":\"账龄表\"}}",
      "usage": { "input": 120, "output": 40, "cache_read": 0, "cache_write": 0 },
      "stop_reason": "stop", "latency_ms": 12 },
    { "text": "{\"intent\":\"finish\"}",
      "usage": { "input": 200, "output": 10, "cache_read": 0, "cache_write": 0 },
      "stop_reason": "stop", "latency_ms": 9 }
  ]
}"#;

async fn produce_a_run(dir: &std::path::Path) -> RunId {
    let mut rt = Runtime::new(
        DaemonConfig::for_test(dir),
        Arc::new(FixedClock::new(1_756_461_600_000)),
        Arc::new(FixtureAdapter::from_json_str(FIXTURES).unwrap()),
        Arc::new(LocalExecutor::new(Arc::new(WorkspaceOnlySandbox::new()))),
    )
    .unwrap();
    let run_id = RunId::from("r-1");
    rt.run_once(&run_id, "把账龄表做出来").await.unwrap();
    run_id
}

fn open(dir: &std::path::Path) -> RunLog {
    RunLog::open(&dir.join("runlog.sqlite"), &dir.join("blobs")).unwrap()
}

#[tokio::test]
async fn every_checkpoint_hash_matches_on_replay() {
    let dir = tempfile::tempdir().unwrap();
    let run_id = produce_a_run(dir.path()).await;
    let report = verify(&open(dir.path()), &run_id).unwrap();
    assert!(report.is_ok(), "不一致的检查点：{:?}", report.mismatches);
    assert!(
        report.checkpoints_checked >= 1,
        "至少要有一个检查点被校验到"
    );
}

#[tokio::test]
async fn deleting_every_snapshot_does_not_change_the_result() {
    // CI 检查 8（Q-06）。没有它，早晚有人往快照里塞一个 Log 里没有的状态。
    let dir = tempfile::tempdir().unwrap();
    let run_id = produce_a_run(dir.path()).await;

    let with_snapshots = replay_to(&open(dir.path()), &run_id, None, true).unwrap();

    let mut log = open(dir.path());
    assert!(log.snapshot_count().unwrap() > 0, "先确认真的有快照可删");
    log.clear_snapshots().unwrap();
    let without = replay_to(&log, &run_id, None, false).unwrap();

    assert_eq!(with_snapshots, without);
    assert_eq!(state_hash(&with_snapshots), state_hash(&without));
}

#[tokio::test]
async fn replay_is_pure_and_repeatable() {
    let dir = tempfile::tempdir().unwrap();
    let run_id = produce_a_run(dir.path()).await;
    let log = open(dir.path());
    let a = replay_to(&log, &run_id, None, false).unwrap();
    let b = replay_to(&log, &run_id, None, false).unwrap();
    assert_eq!(state_hash(&a), state_hash(&b));
}

#[tokio::test]
async fn replay_to_an_earlier_seq_stops_there() {
    let dir = tempfile::tempdir().unwrap();
    let run_id = produce_a_run(dir.path()).await;
    let log = open(dir.path());
    let partial = replay_to(&log, &run_id, Some(2), false).unwrap();
    assert_eq!(partial.last_seq, 2);
    assert_ne!(
        partial.status,
        replay_to(&log, &run_id, None, false).unwrap().status
    );
}

#[tokio::test]
async fn a_tampered_checkpoint_hash_is_caught() {
    // 把某个 checkpoint 的 state_hash 改掉，verify 必须报出来——
    // 否则这道防线是摆设
    let dir = tempfile::tempdir().unwrap();
    let run_id = produce_a_run(dir.path()).await;
    let db = dir.path().join("runlog.sqlite");
    let conn = rusqlite::Connection::open(&db).unwrap();
    conn.execute(
        "UPDATE run_events SET payload = replace(payload, '\"state_hash\":\"', '\"state_hash\":\"ff')
         WHERE kind = 'checkpoint'",
        [],
    )
    .unwrap();
    drop(conn);

    let report = verify(&open(dir.path()), &run_id).unwrap();
    assert!(!report.is_ok());
    assert_eq!(report.mismatches.len(), report.checkpoints_checked);
}

#[tokio::test]
async fn verifying_a_nonexistent_run_is_vacuous_not_passing() {
    // 「空洞」不等于「通过」：一个根本不存在的 run_id 没有任何 checkpoint
    // 可比对，is_ok() 会是 true——但那是因为什么都没查，调用方必须靠
    // is_vacuous() 把这种情况和「真的验证过、没问题」区分开。
    let dir = tempfile::tempdir().unwrap();
    let run_id = RunId::from("r-does-not-exist");
    let report = verify(&open(dir.path()), &run_id).unwrap();
    assert!(report.is_ok(), "空 run 没有不一致，is_ok() 应为 true");
    assert!(
        report.is_vacuous(),
        "没有任何 checkpoint 被检查，is_vacuous() 应为 true"
    );
}

#[tokio::test]
async fn verifying_a_normal_run_is_not_vacuous() {
    let dir = tempfile::tempdir().unwrap();
    let run_id = produce_a_run(dir.path()).await;
    let report = verify(&open(dir.path()), &run_id).unwrap();
    assert!(report.is_ok(), "不一致的检查点：{:?}", report.mismatches);
    assert!(
        !report.is_vacuous(),
        "有 checkpoint 被检查到，is_vacuous() 应为 false"
    );
}
