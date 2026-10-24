use axum::http::StatusCode;
use nset::{
    db::Database,
    ingest::{DurableIngest, IngestOptions, IngestStatus, JOURNAL_FILENAME},
    models::{MetricBatch, MetricInput, MetricQuery, NewRun},
};
use rusqlite::{Connection, params};
use std::{
    future::Future,
    task::{Context, Poll, Waker},
    time::{Duration, Instant},
};

struct Fixture {
    dir: tempfile::TempDir,
    db: Database,
    rt: tokio::runtime::Runtime,
    run: String,
}
impl Fixture {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open(dir.path()).unwrap();
        let rt = tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap();
        let run = rt.block_on(async {
            let (exp, _) = db.create_experiment("experiment".into()).await.unwrap();
            db.create_run(NewRun {
                experiment_id: exp.id,
                name: "run".into(),
                params: Default::default(),
                tags: Default::default(),
            })
            .await
            .unwrap()
            .id
        });
        Self { dir, db, rt, run }
    }
    fn open(&self, paused: bool) -> DurableIngest {
        self.with_options(IngestOptions {
            paused,
            poll_interval_ms: 5,
            ..Default::default()
        })
    }
    fn with_options(&self, options: IngestOptions) -> DurableIngest {
        DurableIngest::open(self.dir.path(), self.db.clone(), options).unwrap()
    }
    fn journal(&self) -> Connection {
        Connection::open(self.dir.path().join(JOURNAL_FILENAME)).unwrap()
    }
    fn query(&self) -> Connection {
        Connection::open(self.dir.path().join("nset.sqlite3")).unwrap()
    }
    fn points(&self) -> Vec<(i64, i64, f64)> {
        self.rt
            .block_on(self.db.metrics(
                self.run.clone(),
                MetricQuery {
                    key: "loss".into(),
                    after: None,
                    snapshot: None,
                    limit: None,
                },
            ))
            .unwrap()
            .points
            .into_iter()
            .map(|p| (p.step, p.timestamp, p.value))
            .collect()
    }
    fn status(&self, ingest: &DurableIngest) -> IngestStatus {
        self.rt.block_on(ingest.status()).unwrap()
    }
    fn until(&self, mut ready: impl FnMut() -> bool) {
        let deadline = Instant::now() + Duration::from_secs(10);
        while !ready() {
            assert!(Instant::now() < deadline, "condition timed out");
            std::thread::sleep(Duration::from_millis(5));
        }
    }
}
fn batch() -> MetricBatch {
    MetricBatch {
        metrics: vec![
            MetricInput {
                key: "loss".into(),
                step: 1,
                value: 2.5,
                timestamp: None,
            },
            MetricInput {
                key: "loss".into(),
                step: 2,
                value: 3.5,
                timestamp: Some(123),
            },
        ],
    }
}

#[test]
fn paused_restart_preserves_receipts_timestamps_and_scoped_ids() {
    let f = Fixture::new();
    let ingest = f.open(true); // open needs no ambient runtime
    let payload = serde_json::to_vec(&batch()).unwrap();
    assert!(!String::from_utf8(payload.clone()).unwrap().contains("null"));
    let _: MetricBatch = serde_json::from_slice(&payload).unwrap();
    let receipt =
        f.rt.block_on(ingest.submit(f.run.clone(), "same".into(), batch()))
            .unwrap();
    assert_eq!(receipt.state, "pending");
    assert_eq!(receipt.accepted, 2);
    let replay =
        f.rt.block_on(ingest.submit(f.run.clone(), "same".into(), batch()))
            .unwrap();
    assert_eq!(receipt, replay);
    let mut other = batch();
    other.metrics[0].value = 99.0;
    assert_eq!(
        f.rt.block_on(ingest.submit(f.run.clone(), "same".into(), other))
            .unwrap_err()
            .0,
        StatusCode::CONFLICT
    );
    assert!(f.status(&ingest).pending_bytes >= payload.len() as u64);
    assert!(f.points().is_empty());
    let run = f.rt.block_on(async {
        let exp = f.db.experiments().await.unwrap().remove(0);
        f.db.create_run(NewRun {
            experiment_id: exp.id,
            name: "other".into(),
            params: Default::default(),
            tags: Default::default(),
        })
        .await
        .unwrap()
        .id
    });
    f.rt.block_on(ingest.submit(run.clone(), "same".into(), batch()))
        .unwrap();
    drop(ingest);
    let ingest = f.open(false);
    f.until(|| f.status(&ingest).pending_batches == 0);
    assert_eq!(
        f.points(),
        vec![(1, receipt.accepted_at, 2.5), (2, 123, 3.5)]
    );
    let replay =
        f.rt.block_on(ingest.submit(f.run.clone(), "same".into(), batch()))
            .unwrap();
    assert_eq!(replay.accepted_at, receipt.accepted_at);
    assert_eq!(replay.state, "applied");
    let conn = f.journal();
    assert_eq!(
        conn.query_row(
            "SELECT COUNT(*) FROM inbox WHERE payload IS NULL",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        2
    );
    assert_eq!(
        f.query()
            .query_row("SELECT COUNT(*) FROM metrics WHERE run_id=?", [run], |r| {
                r.get::<_, i64>(0)
            })
            .unwrap(),
        2
    );
    // Equal native observations still have append semantics with a new batch id.
    f.rt.block_on(ingest.submit(f.run.clone(), "new".into(), batch()))
        .unwrap();
    f.until(|| f.status(&ingest).pending_batches == 0);
    assert_eq!(f.points().len(), 4);
}

#[test]
fn query_commit_before_journal_completion_replays_without_duplicate_rows() {
    let f = Fixture::new();
    let ingest = f.open(true);
    let receipt =
        f.rt.block_on(ingest.submit(f.run.clone(), "window".into(), batch()))
            .unwrap();
    drop(ingest);
    let conn = f.journal();
    conn.execute_batch("CREATE TRIGGER completion_failure BEFORE UPDATE OF state ON inbox WHEN NEW.state='applied' BEGIN SELECT RAISE(FAIL,'secret payload must not escape'); END;").unwrap();
    let ingest = f.open(false);
    f.until(|| f.points().len() == 2 && f.status(&ingest).last_error.is_some());
    assert_eq!(f.status(&ingest).pending_batches, 1);
    assert!(!f.status(&ingest).last_error.unwrap().contains("secret"));
    drop(ingest);
    assert_eq!(
        f.points(),
        vec![(1, receipt.accepted_at, 2.5), (2, 123, 3.5)]
    );
    conn.execute_batch("DROP TRIGGER completion_failure")
        .unwrap();
    let ingest = f.open(false);
    f.until(|| f.status(&ingest).pending_batches == 0);
    assert_eq!(
        f.points(),
        vec![(1, receipt.accepted_at, 2.5), (2, 123, 3.5)]
    );
    assert!(f.status(&ingest).last_error.is_none());
    assert_eq!(
        f.query()
            .query_row("SELECT COUNT(*) FROM ingest_receipts", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        1
    );
}

#[test]
fn failed_query_transaction_rolls_back_receipt_and_all_metrics_then_recovers() {
    let f = Fixture::new();
    let conn = f.query();
    conn.execute_batch("CREATE TRIGGER reject_second BEFORE INSERT ON metrics WHEN NEW.step=2 BEGIN SELECT RAISE(FAIL,'private observation'); END;").unwrap();
    let ingest = f.open(false);
    f.rt.block_on(ingest.submit(f.run.clone(), "rollback".into(), batch()))
        .unwrap();
    f.until(|| f.status(&ingest).last_error.is_some());
    assert!(f.points().is_empty());
    assert_eq!(
        conn.query_row("SELECT COUNT(*) FROM ingest_receipts", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        0
    );
    assert_eq!(f.status(&ingest).pending_batches, 1);
    drop(ingest);
    let paused = f.open(true);
    assert!(
        f.status(&paused).last_error.is_some(),
        "error is durable across restart"
    );
    drop(paused);
    conn.execute_batch("DROP TRIGGER reject_second").unwrap();
    let ingest = f.open(false);
    f.until(|| f.status(&ingest).pending_batches == 0);
    assert_eq!(
        f.points().iter().map(|p| (p.0, p.2)).collect::<Vec<_>>(),
        vec![(1, 2.5), (2, 3.5)]
    );
}

#[test]
fn capacity_validation_and_duplicate_receipts_never_discard_pending_data() {
    let f = Fixture::new();
    let seed = f.open(true);
    f.rt.block_on(seed.submit(f.run.clone(), "measure".into(), batch()))
        .unwrap();
    let bytes = f.status(&seed).pending_bytes;
    drop(seed);
    f.journal()
        .execute("DELETE FROM inbox WHERE batch_id='measure'", [])
        .unwrap();
    let ingest = f.with_options(IngestOptions {
        paused: true,
        max_pending_batches: 1,
        max_pending_bytes: bytes,
        ..Default::default()
    });
    f.rt.block_on(ingest.submit(f.run.clone(), "one".into(), batch()))
        .unwrap();
    f.rt.block_on(ingest.submit(f.run.clone(), "one".into(), batch()))
        .unwrap();
    assert_eq!(
        f.rt.block_on(ingest.submit(f.run.clone(), "two".into(), batch()))
            .unwrap_err()
            .0,
        StatusCode::SERVICE_UNAVAILABLE
    );
    for id in ["", "bad/id", "space id", "é"] {
        assert_eq!(
            f.rt.block_on(ingest.submit(f.run.clone(), id.into(), batch()))
                .unwrap_err()
                .0,
            StatusCode::BAD_REQUEST
        );
    }
    assert_eq!(
        f.rt.block_on(ingest.submit(
            f.run.clone(),
            "empty".into(),
            MetricBatch { metrics: vec![] }
        ))
        .unwrap_err()
        .0,
        StatusCode::BAD_REQUEST
    );
    let mut invalid = batch();
    invalid.metrics[1].value = f64::INFINITY;
    assert_eq!(
        f.rt.block_on(ingest.submit(f.run.clone(), "invalid".into(), invalid))
            .unwrap_err()
            .0,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        f.rt.block_on(ingest.submit("missing-run".into(), "missing".into(), batch()))
            .unwrap_err()
            .0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(f.status(&ingest).pending_batches, 1);
    drop(ingest);
    let ingest = f.with_options(IngestOptions {
        paused: true,
        max_pending_bytes: bytes - 1,
        ..Default::default()
    });
    f.rt.block_on(ingest.submit(f.run.clone(), "one".into(), batch()))
        .unwrap();
    assert_eq!(
        f.rt.block_on(ingest.submit(f.run.clone(), "bytes".into(), batch()))
            .unwrap_err()
            .0,
        StatusCode::SERVICE_UNAVAILABLE
    );
    assert_eq!(f.status(&ingest).pending_bytes, bytes);
}

#[test]
fn bounded_queue_and_cancelled_acknowledgements_are_restart_safe() {
    let f = Fixture::new();
    let ingest = f.with_options(IngestOptions {
        paused: true,
        queue_capacity: 1,
        ..Default::default()
    });
    let conn = f.journal();
    conn.execute_batch("BEGIN IMMEDIATE").unwrap();
    let mut accepted = Vec::new();
    let mut rejected = 0;
    let mut cx = Context::from_waker(Waker::noop());
    for i in 0..100 {
        let id = format!("cancelled-{i}");
        let mut future = Box::pin(ingest.submit(f.run.clone(), id.clone(), batch()));
        match future.as_mut().poll(&mut cx) {
            Poll::Pending => accepted.push(id),
            Poll::Ready(Err(error)) => {
                assert_eq!(error.0, StatusCode::SERVICE_UNAVAILABLE);
                rejected += 1;
            }
            Poll::Ready(Ok(_)) => panic!("must not acknowledge before the write lock is released"),
        }
        // Drop the response future after enqueue, before the journal commit.
    }
    assert!((1..=2).contains(&accepted.len()));
    assert!(rejected > 0);
    conn.execute_batch("COMMIT").unwrap();
    drop(ingest); // joins intake, draining enqueued work despite cancelled responses
    let ingest = f.open(true);
    assert_eq!(f.status(&ingest).pending_batches, accepted.len());
    for id in accepted {
        f.rt.block_on(ingest.submit(f.run.clone(), id, batch()))
            .unwrap();
    }
}

#[test]
fn concurrent_duplicate_submissions_share_one_receipt() {
    let f = Fixture::new();
    let ingest = f.open(true);
    let receipts = std::thread::scope(|scope| {
        let mut workers = Vec::new();
        for _ in 0..16 {
            let service = &ingest;
            let run = f.run.clone();
            workers.push(scope.spawn(move || {
                tokio::runtime::Builder::new_current_thread()
                    .build()
                    .unwrap()
                    .block_on(service.submit(run, "shared".into(), batch()))
                    .unwrap()
            }));
        }
        workers
            .into_iter()
            .map(|w| w.join().unwrap())
            .collect::<Vec<_>>()
    });
    assert!(receipts.iter().all(|r| r == &receipts[0]));
    assert_eq!(f.status(&ingest).pending_batches, 1);
}

#[test]
fn corrupt_payload_is_retained_and_blocks_later_projection() {
    let f = Fixture::new();
    let ingest = f.open(true);
    f.rt.block_on(ingest.submit(f.run.clone(), "poison".into(), batch()))
        .unwrap();
    f.rt.block_on(ingest.submit(f.run.clone(), "later".into(), batch()))
        .unwrap();
    drop(ingest);
    let conn = f.journal();
    conn.execute(
        "UPDATE inbox SET payload=? WHERE batch_id='poison'",
        params![b"private malformed payload".as_slice()],
    )
    .unwrap();
    let ingest = f.open(false);
    f.until(|| f.status(&ingest).last_error.is_some());
    assert_eq!(f.status(&ingest).pending_batches, 2);
    assert!(f.points().is_empty());
    assert!(!f.status(&ingest).last_error.unwrap().contains("private"));
    assert_eq!(
        f.rt.block_on(ingest.submit(f.run.clone(), "poison".into(), batch()))
            .unwrap_err()
            .0,
        StatusCode::SERVICE_UNAVAILABLE
    );
    assert_eq!(
        conn.query_row(
            "SELECT payload FROM inbox WHERE batch_id='poison'",
            [],
            |r| r.get::<_, Vec<u8>>(0)
        )
        .unwrap(),
        b"private malformed payload"
    );
}

#[test]
fn journal_schema_corruption_and_option_guards_preserve_existing_files() {
    let f = Fixture::new();
    for version in [2, i32::MAX] {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(JOURNAL_FILENAME);
        let conn = Connection::open(&path).unwrap();
        conn.execute_batch(
            "CREATE TABLE future_data(value TEXT); INSERT INTO future_data VALUES('preserve')",
        )
        .unwrap();
        conn.pragma_update(None, "user_version", version).unwrap();
        drop(conn);
        let bytes = std::fs::read(&path).unwrap();
        assert!(DurableIngest::open(dir.path(), f.db.clone(), Default::default()).is_err());
        assert_eq!(std::fs::read(&path).unwrap(), bytes);
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
    }
    for version in [0, 1] {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(JOURNAL_FILENAME);
        let conn = Connection::open(&path).unwrap();
        conn.execute_batch("CREATE TABLE inbox(unexpected TEXT)")
            .unwrap();
        conn.pragma_update(None, "user_version", version).unwrap();
        drop(conn);
        let bytes = std::fs::read(&path).unwrap();
        assert!(DurableIngest::open(dir.path(), f.db.clone(), Default::default()).is_err());
        assert_eq!(std::fs::read(&path).unwrap(), bytes);
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
    }
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join(JOURNAL_FILENAME);
    std::fs::write(&path, b"not a sqlite database").unwrap();
    assert!(DurableIngest::open(dir.path(), f.db.clone(), Default::default()).is_err());
    assert_eq!(std::fs::read(&path).unwrap(), b"not a sqlite database");
    let absent = dir.path().join("absent");
    assert!(
        DurableIngest::open(
            &absent,
            f.db.clone(),
            IngestOptions {
                queue_capacity: 0,
                ..Default::default()
            }
        )
        .is_err()
    );
    assert!(!absent.exists());
}

#[test]
fn failed_journal_commit_is_not_acknowledged_and_can_be_retried() {
    let f = Fixture::new();
    let ingest = f.open(true);
    let conn = f.journal();
    assert_eq!(
        conn.pragma_query_value(None, "journal_mode", |r| r.get::<_, String>(0))
            .unwrap(),
        "wal"
    );
    conn.execute_batch("CREATE TRIGGER reject_admission BEFORE INSERT ON inbox BEGIN SELECT RAISE(FAIL,'secret admission payload'); END;").unwrap();
    let error =
        f.rt.block_on(ingest.submit(f.run.clone(), "retry".into(), batch()))
            .unwrap_err();
    assert_eq!(error.0, StatusCode::SERVICE_UNAVAILABLE);
    assert!(!error.1.contains("secret"));
    assert_eq!(f.status(&ingest).pending_batches, 0);
    assert!(f.points().is_empty());
    conn.execute_batch("DROP TRIGGER reject_admission").unwrap();
    let receipt =
        f.rt.block_on(ingest.submit(f.run.clone(), "retry".into(), batch()))
            .unwrap();
    let mut explicit = batch();
    explicit.metrics[0].timestamp = Some(receipt.accepted_at);
    assert_eq!(
        f.rt.block_on(ingest.submit(f.run.clone(), "retry".into(), explicit))
            .unwrap_err()
            .0,
        StatusCode::CONFLICT
    );
    assert_eq!(f.status(&ingest).pending_batches, 1);
}

#[test]
fn finite_float_payloads_remain_replayable_and_exact() {
    let f = Fixture::new();
    let ingest = f.open(true);
    let mut bits = 123456789_u64;
    let mut metrics = Vec::new();
    for step in 0..1000 {
        bits ^= bits << 13;
        bits ^= bits >> 7;
        bits ^= bits << 17;
        let value = f64::from_bits(bits);
        if value.is_finite() {
            metrics.push(MetricInput {
                key: "loss".into(),
                step,
                timestamp: None,
                value,
            });
        }
    }
    for (offset, value) in [
        f64::MAX,
        f64::MIN,
        f64::MIN_POSITIVE,
        f64::from_bits(1),
        -f64::from_bits(1),
        0.0,
    ]
    .into_iter()
    .enumerate()
    {
        metrics.push(MetricInput {
            key: "loss".into(),
            step: 1000 + offset as i64,
            timestamp: None,
            value,
        });
    }
    let original = MetricBatch { metrics };
    let receipt =
        f.rt.block_on(ingest.submit(f.run.clone(), "floats".into(), original.clone()))
            .unwrap();
    f.rt.block_on(ingest.submit(f.run.clone(), "floats".into(), original.clone()))
        .unwrap();
    drop(ingest);
    let ingest = f.open(false);
    f.until(|| f.status(&ingest).pending_batches == 0);
    let points = f.points();
    assert_eq!(points.len(), original.metrics.len());
    for (point, metric) in points.iter().zip(original.metrics.iter()) {
        assert_eq!(point.0, metric.step);
        assert_eq!(point.1, receipt.accepted_at);
        assert_eq!(point.2.to_bits(), metric.value.to_bits());
    }
}

#[test]
fn opening_and_last_handle_drop_inside_current_thread_runtime_does_not_deadlock() {
    let f = Fixture::new();
    f.rt.block_on(async {
        let service = f.open(false);
        let clone = service.clone();
        drop(service);
        clone
            .submit(f.run.clone(), "async-lifetime".into(), batch())
            .await
            .unwrap();
        drop(clone);
    });
    let service = f.open(false);
    f.until(|| f.status(&service).pending_batches == 0);
    assert_eq!(
        f.points().iter().map(|p| (p.0, p.2)).collect::<Vec<_>>(),
        vec![(1, 2.5), (2, 3.5)]
    );
}
