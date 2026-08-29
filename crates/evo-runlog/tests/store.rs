use evo_protocol::events::lifecycle::{
    CompletionStatus, PrincipalRef, RunCompleted, RunCreated, TriggerKind, TriggerRef,
};
use evo_protocol::{Actor, BudgetSpec, EventBody, RunId};
use evo_runlog::RunLog;

fn open() -> (tempfile::TempDir, RunLog) {
    let dir = tempfile::tempdir().unwrap();
    let log = RunLog::open(&dir.path().join("runlog.sqlite"), &dir.path().join("blobs")).unwrap();
    (dir, log)
}

fn run_created(run_id: &RunId) -> EventBody {
    EventBody::RunCreated(RunCreated {
        run_id: run_id.clone(),
        parent_run_id: None,
        workspace_id: "ws-1".into(),
        principal: PrincipalRef { kind: "user".into(), id: "u-1".into() },
        trigger: TriggerRef { kind: TriggerKind::Manual, reference: "cli".into() },
        budget: BudgetSpec::default(),
        labels: Default::default(),
    })
}

#[test]
fn seq_starts_at_zero_and_increases_by_one() {
    let (_d, mut log) = open();
    let r = RunId::from("r-1");
    let e0 = log.append(&r, Actor::Runtime, "2026-08-29T10:00:00Z", run_created(&r)).unwrap();
    let e1 = log
        .append(&r, Actor::Kernel, "2026-08-29T10:00:01Z",
                EventBody::RunCompleted(RunCompleted { status: CompletionStatus::Ok, summary_ref: None }))
        .unwrap();
    assert_eq!(e0.seq, 0);
    assert_eq!(e1.seq, 1);
}

#[test]
fn two_runs_share_one_database_with_independent_seq() {
    let (_d, mut log) = open();
    let a = RunId::from("r-a");
    let b = RunId::from("r-b");
    log.append(&a, Actor::Runtime, "t", run_created(&a)).unwrap();
    let first_of_b = log.append(&b, Actor::Runtime, "t", run_created(&b)).unwrap();
    assert_eq!(first_of_b.seq, 0, "单库多 run，seq 是 run 内单调（Q-06）");
}

#[test]
fn events_roundtrip_through_kind_and_payload_columns() {
    let (_d, mut log) = open();
    let r = RunId::from("r-1");
    let written = log.append(&r, Actor::Runtime, "2026-08-29T10:00:00Z", run_created(&r)).unwrap();
    let read = log.events(&r, 0, None).unwrap();
    assert_eq!(read.len(), 1);
    assert_eq!(read[0], written);
}

#[test]
fn events_can_be_read_as_a_half_open_range() {
    let (_d, mut log) = open();
    let r = RunId::from("r-1");
    for _ in 0..5 {
        log.append(&r, Actor::Runtime, "t", run_created(&r)).unwrap();
    }
    assert_eq!(log.events(&r, 1, Some(3)).unwrap().len(), 3, "[1, 3] 闭区间共 3 条");
    assert_eq!(log.last_seq(&r).unwrap(), Some(4));
}

#[test]
fn runs_projection_tracks_last_seq() {
    let (_d, mut log) = open();
    let r = RunId::from("r-1");
    log.append(&r, Actor::Runtime, "2026-08-29T10:00:00Z", run_created(&r)).unwrap();
    assert_eq!(log.run_ids().unwrap(), vec![r]);
}

/// 单写者不变量的固化：见 `RunLog::append` 的文档。
///
/// 这里不开线程。开两个 `RunLog` 实例、各自对同一个 run 顺序调用 `append`
/// 并不能重现冲突——单线程里第二次调用的 `last_seq()` 总会看到第一次已经
/// 提交的行，从而自己算出 seq=1，正常成功，不会撞车。真正的冲突只发生在
/// 两个写者的 `last_seq()` 读都发生在对方提交之前那个窗口内，而这个窗口
/// 天然要求真并发（多线程/多进程）。
///
/// 所以这里换一种确定性的构造：先用一个 `RunLog` 正常写下 run 的第一条事件
/// （seq=0）。然后直接对同一个 db 文件开一个原始 `rusqlite::Connection`，
/// 手工执行与 `append` 完全相同的 INSERT 语句、同样把 seq 算成 0——这正是
/// 「第二个写者的 `last_seq()` 读发生在第一个提交之前，因此也算出 seq=0」
/// 这件事在 SQL 层面唯一可观察的后果。断言这条 INSERT 报错（`PRIMARY KEY
/// (run_id, seq)` 挡住，SQLite 扩展错误码 1555），并且 Log 里确实仍然只有
/// 1 条事件——证明失败的那次没有留下半条记录。
#[test]
fn a_second_writer_computing_the_same_seq_gets_an_error_not_a_silent_success() {
    let dir = tempfile::tempdir().unwrap();
    let db_path = dir.path().join("runlog.sqlite");
    let blob_root = dir.path().join("blobs");
    let mut writer_a = RunLog::open(&db_path, &blob_root).unwrap();

    let r = RunId::from("r-contended");
    let first = writer_a.append(&r, Actor::Runtime, "2026-08-29T10:00:00Z", run_created(&r)).unwrap();
    assert_eq!(first.seq, 0);

    // 模拟第二个写者：它在第一个写者提交之前读到 last_seq=None，于是也把
    // 自己的第一条事件算成 seq=0，然后尝试 INSERT——列和值都照抄
    // `RunLog::append` 里的那条语句。
    let second_writer = rusqlite::Connection::open(&db_path).unwrap();
    let second_writer_result = second_writer.execute(
        "INSERT INTO run_events (run_id, seq, kind, schema_ver, recorded_at, actor, payload)
         VALUES (?1, 0, 'run.created', 1, ?2, ?3, ?4)",
        rusqlite::params![
            r.as_str(),
            "2026-08-29T10:00:00Z",
            serde_json::to_string(&Actor::Runtime).unwrap(),
            serde_json::to_string(&run_created(&r)).unwrap(),
        ],
    );

    let err = second_writer_result
        .expect_err("第二个写者算出了和第一个写者相同的 seq，必须被主键约束挡住，而不是静默成功");
    if let rusqlite::Error::SqliteFailure(ffi_err, _) = &err {
        assert_eq!(
            ffi_err.extended_code, 1555,
            "期望的是 SQLITE_CONSTRAINT_PRIMARYKEY（1555），实际拿到 {}",
            ffi_err.extended_code
        );
    } else {
        panic!("期望 rusqlite::Error::SqliteFailure，实际拿到 {err:?}");
    }

    assert_eq!(
        writer_a.events(&r, 0, None).unwrap().len(),
        1,
        "失败的那次 INSERT 不能留下半条记录——Log 里必须仍然只有第一个写者的那 1 条"
    );
}

/// `Actor::Human` 与 `Actor::Trigger` 是仅有的两个带载荷的 `Actor` 变体。
/// 之前的测试只覆盖了 `Actor::Runtime` / `Actor::Kernel` 这两个无载荷变体，
/// 没有验证过带 `String` 载荷的变体经过 `actor` 列的序列化/反序列化往返后
/// 是否还原样。
#[test]
fn actor_variants_with_payload_roundtrip_through_the_actor_column() {
    let (_d, mut log) = open();

    let r_human = RunId::from("r-human");
    let written_human = log
        .append(&r_human, Actor::Human("user@example.com".into()), "t", run_created(&r_human))
        .unwrap();
    let read_human = log.events(&r_human, 0, None).unwrap();
    assert_eq!(read_human.len(), 1);
    assert_eq!(read_human[0], written_human);

    let r_trigger = RunId::from("r-trigger");
    let written_trigger = log
        .append(&r_trigger, Actor::Trigger("cron:nightly".into()), "t", run_created(&r_trigger))
        .unwrap();
    let read_trigger = log.events(&r_trigger, 0, None).unwrap();
    assert_eq!(read_trigger.len(), 1);
    assert_eq!(read_trigger[0], written_trigger);
}
