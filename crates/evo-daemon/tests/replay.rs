use evo_daemon::{DaemonConfig, FixedClock, Runtime, replay_to, replay_to_checked, verify};
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
    rt.start(&run_id, "把账龄表做出来").await.unwrap();
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

/// M2 终审 BL-2：快照被无条件信任。
///
/// `snapshots` 表里存着 `state_hash` 列，`Snapshot` 结构体也把它读了出来，
/// 但全仓没有一处比对过——`replay_to(use_snapshots=true)` 直接
/// `ciborium::from_reader` 拿它当起点。于是改一改快照 blob 里的
/// `budget_used`/`taint`（**不动任何事件、不动哈希列**），带快照回放出来的
/// state 就与诚实全量 fold 的结果不一致，而 `verify()` 仍然报 is_ok——它比
/// 的是 checkpoint 事件里的哈希，不是快照。
///
/// 这条路径不是理论风险：`Runtime::resume` 走的正是
/// `replay_to(use_snapshots=true)`，被污染的快照会直接驱动真实执行。
///
/// 「快照可丢弃」这条性质让兜底零代价：对不上就扔掉快照退回全量 fold，
/// 结果必然与诚实回放相同。
#[tokio::test]
async fn a_tampered_snapshot_is_discarded_not_trusted() {
    use evo_kernel::RunState;
    use evo_protocol::taint::TaintLevel;

    let dir = tempfile::tempdir().unwrap();
    let run_id = produce_a_run(dir.path()).await;
    let honest = replay_to(&open(dir.path()), &run_id, None, false).unwrap();
    // 先确认没被篡改的快照不会被误伤——否则「对不上就丢弃」会退化成
    // 「永远丢弃」，测试照样绿，加速器却白扔了。
    let (before, rejected) = replay_to_checked(&open(dir.path()), &run_id, None, true).unwrap();
    assert_eq!(before, honest);
    assert_eq!(rejected, None, "诚实的快照不该被丢弃");

    // 篡改每一个快照的 blob：预算用量与 taint 各改一处，事件与
    // state_hash 列都原样不动。
    let db = dir.path().join("runlog.sqlite");
    let conn = rusqlite::Connection::open(&db).unwrap();
    let rows: Vec<(i64, Vec<u8>)> = conn
        .prepare("SELECT seq, state_blob FROM snapshots")
        .unwrap()
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
        .unwrap()
        .map(|r| r.unwrap())
        .collect();
    assert!(!rows.is_empty(), "先确认真的有快照可篡改");
    for (seq, blob) in rows {
        let mut state: RunState = ciborium::from_reader(blob.as_slice()).unwrap();
        state.budget_used.tokens += 1_000_000;
        state.taint = TaintLevel::Tainted;
        let mut tampered = Vec::new();
        ciborium::into_writer(&state, &mut tampered).unwrap();
        conn.execute(
            "UPDATE snapshots SET state_blob = ?1 WHERE seq = ?2",
            rusqlite::params![tampered, seq],
        )
        .unwrap();
    }
    drop(conn);

    let (from_snapshot, rejected) =
        replay_to_checked(&open(dir.path()), &run_id, None, true).unwrap();
    assert_eq!(
        from_snapshot, honest,
        "带快照回放必须与诚实全量 fold 结果相同：快照是加速器，不是第二份权威事实"
    );
    assert_eq!(state_hash(&from_snapshot), state_hash(&honest));
    // 降级是静默的（不报错），但不是无声的：调用方拿得到「哪个快照被
    // 丢了、声称的哈希与重算的哈希各是什么」。
    let rejected = rejected.expect("被污染的快照必须留下一个可观测的信号");
    assert_ne!(rejected.expected, rejected.actual);
}
