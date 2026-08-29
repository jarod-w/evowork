use evo_protocol::RunId;
use evo_runlog::RunLog;

fn open() -> (tempfile::TempDir, RunLog) {
    let dir = tempfile::tempdir().unwrap();
    let log = RunLog::open(&dir.path().join("runlog.sqlite"), &dir.path().join("blobs")).unwrap();
    (dir, log)
}

#[test]
fn a_snapshot_can_be_read_back_verbatim() {
    let (_d, mut log) = open();
    let r = RunId::from("r-1");
    log.put_snapshot(&r, 50, b"state-bytes", b"hash-bytes")
        .unwrap();
    let s = log.snapshot_at_or_before(&r, 50).unwrap().unwrap();
    assert_eq!(s.seq, 50);
    assert_eq!(s.state_blob, b"state-bytes");
    assert_eq!(s.state_hash, b"hash-bytes");
}

#[test]
fn lookup_returns_the_nearest_snapshot_not_a_later_one() {
    let (_d, mut log) = open();
    let r = RunId::from("r-1");
    log.put_snapshot(&r, 50, b"a", b"h1").unwrap();
    log.put_snapshot(&r, 100, b"b", b"h2").unwrap();
    assert_eq!(log.snapshot_at_or_before(&r, 99).unwrap().unwrap().seq, 50);
    assert_eq!(
        log.snapshot_at_or_before(&r, 100).unwrap().unwrap().seq,
        100
    );
    assert!(log.snapshot_at_or_before(&r, 49).unwrap().is_none());
}

#[test]
fn snapshots_of_different_runs_do_not_bleed() {
    let (_d, mut log) = open();
    log.put_snapshot(&RunId::from("r-a"), 50, b"a", b"h")
        .unwrap();
    assert!(
        log.snapshot_at_or_before(&RunId::from("r-b"), 50)
            .unwrap()
            .is_none()
    );
}

#[test]
fn clear_snapshots_wipes_them_all() {
    let (_d, mut log) = open();
    log.put_snapshot(&RunId::from("r-a"), 50, b"a", b"h")
        .unwrap();
    log.put_snapshot(&RunId::from("r-b"), 50, b"b", b"h")
        .unwrap();
    assert_eq!(log.snapshot_count().unwrap(), 2);
    assert_eq!(log.clear_snapshots().unwrap(), 2);
    assert_eq!(log.snapshot_count().unwrap(), 0);
}

#[test]
fn writing_the_same_seq_twice_overwrites_rather_than_erroring() {
    let (_d, mut log) = open();
    let r = RunId::from("r-1");
    log.put_snapshot(&r, 50, b"first", b"h1").unwrap();
    log.put_snapshot(&r, 50, b"second", b"h2").unwrap();
    assert_eq!(
        log.snapshot_at_or_before(&r, 50)
            .unwrap()
            .unwrap()
            .state_blob,
        b"second"
    );
}
