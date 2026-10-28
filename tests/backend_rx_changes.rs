//! External rx invalidations remain coarse; these do not test incremental plots.
use nset::rx::{ChangeWatch, Source};
use rusqlite::Connection;
use std::{
    path::{Path, PathBuf},
    process::Command,
    sync::mpsc::{self, Receiver, RecvTimeoutError, TryRecvError},
    time::{Duration, Instant},
};

const EVENT_TIMEOUT: Duration = Duration::from_secs(8);
const QUIET: Duration = Duration::from_millis(1150);

struct Fixture {
    _dir: tempfile::TempDir,
    path: PathBuf,
    source: Source,
}
impl Fixture {
    fn new(version: i64) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let repo = dir.path().join("repo");
        assert!(
            Command::new("git")
                .args(["init", "-q"])
                .arg(&repo)
                .status()
                .unwrap()
                .success()
        );
        std::fs::create_dir_all(repo.join(".git/rx")).unwrap();
        let path = repo.join(".git/rx/rx.sqlite");
        create_database(&path, version);
        let source = Source::resolve(&repo).unwrap();
        Self {
            _dir: dir,
            path,
            source,
        }
    }
    fn watch(&self) -> (ChangeWatch, Receiver<()>) {
        let (tx, rx) = mpsc::channel();
        let guard = self
            .source
            .watch_changes(move || {
                let _ = tx.send(());
            })
            .unwrap();
        (guard, rx)
    }
}
fn create_database(path: &Path, version: i64) {
    let conn = Connection::open(path).unwrap();
    conn.execute_batch(match version {
        8 => include_str!("fixtures/rx-schema-8.sql"),
        9 => include_str!("fixtures/rx-schema-9.sql"),
        _ => unreachable!(),
    })
    .unwrap();
    conn.execute_batch(
        r#"
        INSERT INTO commands(id,argv) VALUES(1,'[]');
        INSERT INTO runs(id,run_uid,state,command_id,argv,cwd_rel,config,created_at)
        VALUES(1,'run-1','active',1,'[]','.','{}','2026-10-12T00:00:00Z');
        INSERT INTO events(run_id,seq,received_at,data)
        VALUES(1,5,'2026-10-12T00:00:00Z','{"loss":1}');
    "#,
    )
    .unwrap();
}
fn event(rx: &Receiver<()>) {
    rx.recv_timeout(EVENT_TIMEOUT)
        .expect("rx change invalidation");
}
fn quiet(rx: &Receiver<()>) {
    assert_eq!(rx.recv_timeout(QUIET), Err(RecvTimeoutError::Timeout));
}

#[test]
fn wal_commits_and_same_inode_edits_invalidate_but_ticks_and_rollbacks_do_not() {
    for version in [8, 9] {
        let f = Fixture::new(version);
        let writer = Connection::open(&f.path).unwrap();
        writer.busy_timeout(Duration::from_secs(2)).unwrap();
        writer.execute_batch("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; PRAGMA wal_checkpoint(TRUNCATE);").unwrap();
        let main_before = std::fs::read(&f.path).unwrap();
        #[cfg(unix)]
        let inode_before = {
            use std::os::unix::fs::MetadataExt;
            std::fs::metadata(&f.path).unwrap().ino()
        };
        let (_guard, changes) = f.watch();
        quiet(&changes);
        assert_eq!(main_before, std::fs::read(&f.path).unwrap());

        // Keep this transaction open across more than one poll: no commit yet.
        writer.execute_batch("BEGIN; INSERT INTO events(run_id,seq,received_at,data) VALUES(1,6,'now','{\"loss\":0.5}');").unwrap();
        quiet(&changes);
        writer.execute_batch("COMMIT").unwrap();
        event(&changes);
        // Data changed only in WAL, not in the main file's bytes/mtime.
        assert_eq!(main_before, std::fs::read(&f.path).unwrap());
        quiet(&changes);

        // These edits do not increase max seq, row count, or file identity.
        writer.execute_batch("BEGIN; UPDATE events SET data='{\"loss\":0.25}' WHERE seq=5; UPDATE runs SET state='succeeded' WHERE id=1; COMMIT;").unwrap();
        event(&changes);
        quiet(&changes);
        writer.execute_batch("INSERT INTO events(run_id,seq,received_at,data) VALUES(1,-2,'now','{\"loss\":3}');").unwrap();
        event(&changes);
        writer
            .execute_batch("DELETE FROM events WHERE seq=-2;")
            .unwrap();
        event(&changes);
        writer
            .execute_batch("BEGIN; UPDATE runs SET alias='rolled-back'; ROLLBACK;")
            .unwrap();
        quiet(&changes);
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            assert_eq!(inode_before, std::fs::metadata(&f.path).unwrap().ino());
        }
        // A retained read snapshot would obstruct a truncating checkpoint.
        let busy: i64 = writer
            .query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |r| r.get(0))
            .unwrap();
        assert_eq!(busy, 0);
    }
}

#[cfg(unix)]
#[test]
fn atomic_replacement_reopens_even_when_connection_local_versions_match() {
    let f = Fixture::new(9);
    let (_guard, changes) = f.watch();
    quiet(&changes);
    let replacement = f.path.with_file_name("replacement.sqlite");
    create_database(&replacement, 8);
    let replacement_bytes = std::fs::read(&replacement).unwrap();
    std::fs::rename(&replacement, &f.path).unwrap();
    event(&changes);
    quiet(&changes);
    assert_eq!(replacement_bytes, std::fs::read(&f.path).unwrap());
    // Verify the persistent connection moved to the replacement inode.
    Connection::open(&f.path)
        .unwrap()
        .execute_batch("UPDATE runs SET alias='new-inode'")
        .unwrap();
    event(&changes);
}

#[test]
fn missing_source_is_not_recreated_and_unavailable_recovered_emit_once() {
    let f = Fixture::new(9);
    let (guard, changes) = f.watch();
    let parked = f.path.with_file_name("parked.sqlite");
    std::fs::rename(&f.path, &parked).unwrap();
    event(&changes);
    quiet(&changes);
    assert!(
        !f.path.exists(),
        "read-only watcher must not create a source database"
    );
    std::fs::rename(&parked, &f.path).unwrap();
    event(&changes);
    quiet(&changes);
    drop(guard);
    assert_eq!(changes.try_recv(), Err(TryRecvError::Disconnected));
}

#[test]
fn initial_unavailability_recovers_and_guard_drop_interrupts_backoff() {
    let f = Fixture::new(8);
    let parked = f.path.with_file_name("parked.sqlite");
    std::fs::rename(&f.path, &parked).unwrap();
    let (guard, changes) = f.watch();
    event(&changes);
    // Past the first failed retry; worker is now in a backed-off wait.
    quiet(&changes);
    assert!(!f.path.exists());
    let start = Instant::now();
    drop(guard);
    assert!(
        start.elapsed() < Duration::from_millis(750),
        "guard waited for polling backoff"
    );
    assert_eq!(changes.try_recv(), Err(TryRecvError::Disconnected));
    // Dropping also releases single-monitor ownership, including across clones.
    let clone = f.source.clone();
    std::fs::rename(&parked, &f.path).unwrap();
    let guard = clone.watch_changes(|| {}).unwrap();
    assert!(f.source.watch_changes(|| {}).is_err());
    drop(guard);
    let (guard, changes) = f.watch();
    Connection::open(&f.path)
        .unwrap()
        .execute_batch("UPDATE runs SET alias='restarted'")
        .unwrap();
    event(&changes);
    drop(guard);
    assert_eq!(changes.try_recv(), Err(TryRecvError::Disconnected));
}

#[test]
fn schema_changes_are_unavailable_until_valid_again_without_source_mutation() {
    let f = Fixture::new(9);
    let writer = Connection::open(&f.path).unwrap();
    writer.busy_timeout(Duration::from_secs(2)).unwrap();
    let (_guard, changes) = f.watch();
    writer.execute_batch("PRAGMA user_version=42").unwrap();
    let invalid_bytes = std::fs::read(&f.path).unwrap();
    event(&changes);
    quiet(&changes);
    assert_eq!(invalid_bytes, std::fs::read(&f.path).unwrap());
    writer.execute_batch("PRAGMA user_version=9").unwrap();
    event(&changes);
    quiet(&changes);
    // A supported version is not sufficient: preserve full reader validation.
    writer
        .execute_batch("ALTER TABLE events RENAME COLUMN data TO payload")
        .unwrap();
    event(&changes);
    quiet(&changes);
    writer
        .execute_batch("ALTER TABLE events RENAME COLUMN payload TO data")
        .unwrap();
    event(&changes);
}

#[test]
fn initially_unavailable_watcher_reports_recovery_without_restart() {
    let f = Fixture::new(9);
    let parked = f.path.with_file_name("parked.sqlite");
    std::fs::rename(&f.path, &parked).unwrap();
    let (_guard, changes) = f.watch();
    event(&changes);
    quiet(&changes);
    std::fs::rename(&parked, &f.path).unwrap();
    event(&changes);
    quiet(&changes);
}
