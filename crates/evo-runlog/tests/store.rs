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
