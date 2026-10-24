//! Durable scalar intake. Back up this journal and the query database together.
//! A receipt acknowledges the FULL-synchronous journal commit, not query visibility.
use crate::{
    db::Database,
    errors::{ApiError, Result},
    models::{MetricBatch, now, safe},
};
use axum::http::StatusCode;
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    path::Path,
    sync::{Arc, Condvar, Mutex},
    thread::JoinHandle,
    time::Duration,
};
use tokio::{
    runtime::Runtime,
    sync::{mpsc, oneshot},
};

pub const JOURNAL_FILENAME: &str = "ingest.sqlite3";
const JOURNAL_VERSION: i64 = 1;
const PROJECTION_ERROR: &str = "materialization failed; pending data retained; retrying";
const CORRUPT_ERROR: &str = "journal entry invalid; pending data retained; repair required";

#[derive(Clone, Debug)]
pub struct IngestOptions {
    pub queue_capacity: usize,
    pub max_pending_bytes: u64,
    pub max_pending_batches: usize,
    pub poll_interval_ms: u64,
    pub paused: bool,
}
impl Default for IngestOptions {
    fn default() -> Self {
        Self {
            queue_capacity: 64,
            max_pending_bytes: 268_435_456,
            max_pending_batches: 10_000,
            poll_interval_ms: 100,
            paused: false,
        }
    }
}
impl IngestOptions {
    fn validate(&self) -> Result<()> {
        if !(1..=4096).contains(&self.queue_capacity)
            || self.max_pending_bytes == 0
            || self.max_pending_bytes > i64::MAX as u64
            || self.max_pending_batches == 0
            || self.max_pending_batches > i64::MAX as usize
            || !(1..=60_000).contains(&self.poll_interval_ms)
        {
            return Err(ApiError::bad("invalid durable ingest options"));
        }
        Ok(())
    }
}
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub struct IngestReceipt {
    pub batch_id: String,
    pub run_id: String,
    pub state: String,
    pub accepted: usize,
    pub accepted_at: i64,
}
#[derive(Clone, Debug, Serialize)]
pub struct IngestStatus {
    pub pending_batches: usize,
    pub pending_bytes: u64,
    pub last_error: Option<String>,
}

struct Control {
    stop: Mutex<bool>,
    wake: Condvar,
    error: Mutex<Option<&'static str>>,
}
type Job = Box<dyn FnOnce(&mut Connection, &Runtime, &Database) + Send>;
struct Inner {
    sender: Option<mpsc::Sender<Job>>,
    control: Arc<Control>,
    threads: Vec<JoinHandle<()>>,
    limits: (usize, u64),
}
impl Drop for Inner {
    fn drop(&mut self) {
        *self.control.stop.lock().unwrap() = true;
        self.control.wake.notify_all();
        // Drain accepted jobs even if callers cancelled; disconnect ends intake.
        self.sender.take();
        for thread in self.threads.drain(..) {
            let _ = thread.join();
        }
    }
}
#[derive(Clone)]
pub struct DurableIngest(Arc<Inner>);

fn storage_error(_: impl std::fmt::Display) -> ApiError {
    // Do not expose SQL, paths, payloads, or trigger text, even in logs.
    ApiError(
        StatusCode::SERVICE_UNAVAILABLE,
        "durable journal unavailable; retry with the same batch id",
    )
}
fn invalid_entry() -> ApiError {
    ApiError(StatusCode::SERVICE_UNAVAILABLE, CORRUPT_ERROR)
}
fn runtime() -> Result<Runtime> {
    tokio::runtime::Builder::new_current_thread()
        .build()
        .map_err(storage_error)
}
fn validate_id(id: &str) -> Result<()> {
    if id.is_empty()
        || id.len() > 128
        || !id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
    {
        return Err(ApiError::bad(
            "batch id must be 1..128 ASCII letters, digits, dot, underscore or hyphen",
        ));
    }
    Ok(())
}
pub(crate) fn validate_batch(batch: &MetricBatch) -> Result<()> {
    if batch.metrics.is_empty() || batch.metrics.len() > 10_000 {
        return Err(ApiError::bad("durable batches require 1..10000 metrics"));
    }
    for metric in &batch.metrics {
        metric.validate()?;
    }
    Ok(())
}
// serde_json without its optional float_roundtrip feature may round finite
// values on decode. Retain their exact IEEE-754 bits independently, so replay
// is lossless without changing the application's dependency features. The
// canonical comparison below also checks the JSON values against these bits.
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct CanonicalBatch {
    batch: MetricBatch,
    value_bits: Vec<u64>,
}
impl CanonicalBatch {
    fn new(batch: MetricBatch) -> Self {
        let value_bits = batch.metrics.iter().map(|m| m.value.to_bits()).collect();
        Self { batch, value_bits }
    }
    fn decode(payload: &[u8]) -> Result<MetricBatch> {
        let mut canonical: Self = serde_json::from_slice(payload).map_err(|_| invalid_entry())?;
        if canonical.batch.metrics.len() != canonical.value_bits.len() {
            return Err(invalid_entry());
        }
        for (metric, bits) in canonical
            .batch
            .metrics
            .iter_mut()
            .zip(&canonical.value_bits)
        {
            metric.value = f64::from_bits(*bits);
        }
        validate_batch(&canonical.batch).map_err(|_| invalid_entry())?;
        if serde_json::to_vec(&canonical).map_err(|_| invalid_entry())? != payload {
            return Err(invalid_entry());
        }
        Ok(canonical.batch)
    }
}

fn digest(payload: &[u8]) -> Vec<u8> {
    Sha256::digest(payload).to_vec()
}

fn open_journal(directory: &Path) -> Result<Connection> {
    std::fs::create_dir_all(directory).map_err(storage_error)?;
    let mut conn = Connection::open(directory.join(JOURNAL_FILENAME)).map_err(storage_error)?;
    conn.busy_timeout(Duration::from_secs(5))
        .map_err(storage_error)?;
    let version: i64 = conn
        .pragma_query_value(None, "user_version", |r| r.get(0))
        .map_err(storage_error)?;
    if !(0..=JOURNAL_VERSION).contains(&version) {
        return Err(ApiError(
            StatusCode::SERVICE_UNAVAILABLE,
            "unsupported durable journal schema; upgrade required",
        ));
    }
    let check: String = conn
        .query_row("PRAGMA quick_check", [], |r| r.get(0))
        .map_err(storage_error)?;
    if check != "ok" {
        return Err(invalid_entry());
    }
    if version == 0 {
        let tables: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'",
                [],
                |r| r.get(0),
            )
            .map_err(storage_error)?;
        if tables != 0 {
            return Err(invalid_entry());
        }
    } else {
        // Check compatibility before any persistent PRAGMA or schema changes.
        conn.prepare("SELECT seq,run_id,batch_id,digest,payload,accepted,accepted_at,state,last_error FROM inbox LIMIT 0").map_err(storage_error)?;
    }
    let mode: String = conn
        .pragma_update_and_check(None, "journal_mode", "WAL", |r| r.get(0))
        .map_err(storage_error)?;
    if !mode.eq_ignore_ascii_case("wal") {
        return Err(storage_error("WAL required"));
    }
    conn.pragma_update(None, "synchronous", "FULL")
        .map_err(storage_error)?;
    let tx = conn
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(storage_error)?;
    // Another opener may have initialized the file while we waited.
    let version: i64 = tx
        .pragma_query_value(None, "user_version", |r| r.get(0))
        .map_err(storage_error)?;
    if version == 0 {
        tx.execute_batch("CREATE TABLE inbox(
            seq INTEGER PRIMARY KEY AUTOINCREMENT,
            run_id TEXT NOT NULL, batch_id TEXT NOT NULL,
            digest BLOB NOT NULL CHECK(length(digest)=32), payload BLOB,
            accepted INTEGER NOT NULL CHECK(accepted BETWEEN 1 AND 10000),
            accepted_at INTEGER NOT NULL CHECK(accepted_at BETWEEN 0 AND 9007199254740991),
            state TEXT NOT NULL CHECK(state IN ('pending','applied')), last_error TEXT,
            UNIQUE(run_id,batch_id),
            CHECK((state='pending' AND payload IS NOT NULL) OR (state='applied' AND payload IS NULL)));
            CREATE INDEX inbox_pending ON inbox(state,seq);").map_err(storage_error)?;
        tx.pragma_update(None, "user_version", JOURNAL_VERSION)
            .map_err(storage_error)?;
    } else if version != JOURNAL_VERSION {
        return Err(invalid_entry());
    }
    tx.commit().map_err(storage_error)?;
    #[cfg(unix)]
    std::fs::File::open(directory)
        .and_then(|f| f.sync_all())
        .map_err(storage_error)?;
    Ok(conn)
}

struct Entry {
    seq: i64,
    receipt: IngestReceipt,
    digest: Vec<u8>,
    payload: Option<Vec<u8>>,
}
fn entry(row: &rusqlite::Row<'_>) -> rusqlite::Result<Entry> {
    Ok(Entry {
        seq: row.get(0)?,
        receipt: IngestReceipt {
            run_id: row.get(1)?,
            batch_id: row.get(2)?,
            state: row.get(3)?,
            accepted: usize::try_from(row.get::<_, i64>(4)?).map_err(|e| {
                rusqlite::Error::FromSqlConversionFailure(
                    4,
                    rusqlite::types::Type::Integer,
                    Box::new(e),
                )
            })?,
            accepted_at: row.get(5)?,
        },
        digest: row.get(6)?,
        payload: row.get(7)?,
    })
}
const ENTRY_COLUMNS: &str = "seq,run_id,batch_id,state,accepted,accepted_at,digest,payload";
fn lookup(conn: &Connection, run: &str, batch: &str) -> Result<Option<Entry>> {
    conn.query_row(
        &format!("SELECT {ENTRY_COLUMNS} FROM inbox WHERE run_id=? AND batch_id=?"),
        params![run, batch],
        entry,
    )
    .optional()
    .map_err(storage_error)
}
fn verified(entry: &Entry) -> Result<Option<MetricBatch>> {
    validate_id(&entry.receipt.batch_id).map_err(|_| invalid_entry())?;
    safe(entry.receipt.accepted_at).map_err(|_| invalid_entry())?;
    if entry.digest.len() != 32 || !(1..=10_000).contains(&entry.receipt.accepted) {
        return Err(invalid_entry());
    }
    match (entry.receipt.state.as_str(), &entry.payload) {
        ("applied", None) => Ok(None),
        ("pending", Some(payload)) => {
            if digest(payload) != entry.digest {
                return Err(invalid_entry());
            }
            let batch = CanonicalBatch::decode(payload)?;
            if batch.metrics.len() != entry.receipt.accepted {
                return Err(invalid_entry());
            }
            Ok(Some(batch))
        }
        _ => Err(invalid_entry()),
    }
}

impl DurableIngest {
    /// Opens without an ambient Tokio runtime. Last-handle drop joins both workers;
    /// outstanding committed entries remain available to the next opener.
    pub fn open(directory: &Path, db: Database, options: IngestOptions) -> Result<Self> {
        options.validate()?;
        let mut intake = open_journal(directory)?;
        let projector = open_journal(directory)?;
        let control = Arc::new(Control {
            stop: Mutex::new(false),
            wake: Condvar::new(),
            error: Mutex::new(None),
        });
        let (sender, mut receiver) = mpsc::channel::<Job>(options.queue_capacity);
        let mut inner = Inner {
            sender: Some(sender),
            control: control.clone(),
            threads: Vec::new(),
            limits: (options.max_pending_batches, options.max_pending_bytes),
        };
        let (ready, started) = std::sync::mpsc::channel();
        let intake_db = db.clone();
        inner.threads.push(
            std::thread::Builder::new()
                .name("nset-ingest-intake".into())
                .spawn(move || {
                    let intake_runtime = match runtime() {
                        Ok(runtime) => {
                            let _ = ready.send(Ok(()));
                            runtime
                        }
                        Err(error) => {
                            let _ = ready.send(Err(error));
                            return;
                        }
                    };
                    while let Some(job) = receiver.blocking_recv() {
                        job(&mut intake, &intake_runtime, &intake_db);
                    }
                })
                .map_err(storage_error)?,
        );
        started.recv().map_err(storage_error)??;
        let (ready, started) = std::sync::mpsc::channel();
        inner.threads.push(
            std::thread::Builder::new()
                .name("nset-ingest-projector".into())
                .spawn(move || {
                    let project_runtime = match runtime() {
                        Ok(runtime) => {
                            let _ = ready.send(Ok(()));
                            runtime
                        }
                        Err(error) => {
                            let _ = ready.send(Err(error));
                            return;
                        }
                    };
                    project_loop(projector, project_runtime, db, control, options);
                })
                .map_err(storage_error)?,
        );
        started.recv().map_err(storage_error)??;
        Ok(Self(Arc::new(inner)))
    }
    async fn call<T: Send + 'static>(
        &self,
        work: impl FnOnce(&mut Connection, &Runtime, &Database) -> Result<T> + Send + 'static,
    ) -> Result<T> {
        let (tx, rx) = oneshot::channel();
        self.0
            .sender
            .as_ref()
            .unwrap()
            .try_send(Box::new(move |conn, runtime, db| {
                let _ = tx.send(work(conn, runtime, db));
            }))
            .map_err(|_| ApiError::busy())?;
        rx.await.map_err(storage_error)?
    }
    pub async fn submit(
        &self,
        run_id: String,
        batch_id: String,
        batch: MetricBatch,
    ) -> Result<IngestReceipt> {
        validate_id(&batch_id)?;
        validate_batch(&batch)?;
        let count = batch.metrics.len();
        let payload = serde_json::to_vec(&CanonicalBatch::new(batch)).map_err(storage_error)?;
        let hash = digest(&payload);
        let limits = self.0.limits;
        let control = self.0.control.clone();
        self.call(move |conn, runtime, db| {
            // All capacity and dedup decisions share the commit's write lock.
            let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate).map_err(storage_error)?;
            if let Some(prior) = lookup(&tx, &run_id, &batch_id)? {
                verified(&prior)?;
                if hash != prior.digest { return Err(ApiError(StatusCode::CONFLICT, "batch id already used with different metrics")); }
                return Ok(prior.receipt);
            }
            runtime.block_on(db.run(run_id.clone()))?;
            let (pending, bytes): (i64, i64) = tx.query_row("SELECT COUNT(*),COALESCE(SUM(length(payload)),0) FROM inbox WHERE state='pending'", [], |r| Ok((r.get(0)?,r.get(1)?))).map_err(storage_error)?;
            if pending as usize >= limits.0 || (bytes as u64).checked_add(payload.len() as u64).is_none_or(|n| n > limits.1) {
                return Err(ApiError(StatusCode::SERVICE_UNAVAILABLE, "durable journal capacity reached; retry later"));
            }
            let accepted_at = now();
            safe(accepted_at)?;
            tx.execute("INSERT INTO inbox(run_id,batch_id,digest,payload,accepted,accepted_at,state) VALUES(?,?,?,?,?,?,'pending')", params![run_id,batch_id,hash,payload,count as i64,accepted_at]).map_err(storage_error)?;
            tx.commit().map_err(storage_error)?;
            control.wake.notify_one();
            Ok(IngestReceipt { run_id, batch_id, state: "pending".into(), accepted: count, accepted_at })
        }).await
    }
    pub async fn receipt(&self, run_id: String, batch_id: String) -> Result<IngestReceipt> {
        validate_id(&batch_id)?;
        self.call(move |conn, _, _| {
            let entry = lookup(conn, &run_id, &batch_id)?.ok_or_else(ApiError::missing)?;
            verified(&entry)?;
            Ok(entry.receipt)
        })
        .await
    }
    pub async fn status(&self) -> Result<IngestStatus> {
        let control = self.0.control.clone();
        self.call(move |conn, _, _| {
            let (pending_batches, pending_bytes): (i64, i64) = conn.query_row("SELECT COUNT(*),COALESCE(SUM(length(payload)),0) FROM inbox WHERE state='pending'", [], |r| Ok((r.get(0)?,r.get(1)?))).map_err(storage_error)?;
            // Never return stored arbitrary error text from a damaged/edited journal.
            let failed: bool = conn.query_row("SELECT EXISTS(SELECT 1 FROM inbox WHERE state='pending' AND last_error IS NOT NULL)", [], |r| r.get(0)).map_err(storage_error)?;
            let last_error = control.error.lock().unwrap().map(str::to_owned).or_else(|| failed.then(|| PROJECTION_ERROR.to_owned()));
            Ok(IngestStatus { pending_batches: pending_batches as usize, pending_bytes: pending_bytes as u64, last_error })
        }).await
    }
}

fn project_loop(
    mut conn: Connection,
    runtime: Runtime,
    db: Database,
    control: Arc<Control>,
    options: IngestOptions,
) {
    loop {
        if *control.stop.lock().unwrap() {
            break;
        }
        if !options.paused {
            match project_one(&mut conn, &runtime, &db) {
                Ok(true) => {
                    *control.error.lock().unwrap() = None;
                    continue;
                }
                Ok(false) => {
                    *control.error.lock().unwrap() = None;
                }
                Err(error) => {
                    *control.error.lock().unwrap() = Some(error.1);
                }
            }
        }
        let stop = control.stop.lock().unwrap();
        if *stop {
            break;
        }
        let _ = control
            .wake
            .wait_timeout(stop, Duration::from_millis(options.poll_interval_ms))
            .unwrap();
    }
}
fn project_one(conn: &mut Connection, runtime: &Runtime, db: &Database) -> Result<bool> {
    let next = conn
        .query_row(
            &format!(
                "SELECT {ENTRY_COLUMNS} FROM inbox WHERE state='pending' ORDER BY seq LIMIT 1"
            ),
            [],
            entry,
        )
        .optional()
        .map_err(storage_error)?;
    let Some(next) = next else {
        return Ok(false);
    };
    let result: Result<bool> = (|| {
        let batch = verified(&next)?.ok_or_else(invalid_entry)?;
        runtime
            .block_on(db.apply_ingest(
                next.receipt.run_id.clone(),
                next.receipt.batch_id.clone(),
                next.digest.clone(),
                next.receipt.accepted_at,
                batch,
            ))
            .map_err(|_| ApiError(StatusCode::SERVICE_UNAVAILABLE, PROJECTION_ERROR))?;
        // This is deliberately AFTER the atomic query receipt+metrics transaction.
        conn.execute(
            "UPDATE inbox SET state='applied',payload=NULL,last_error=NULL WHERE seq=?",
            [next.seq],
        )
        .map_err(storage_error)?;
        Ok(true)
    })();
    if let Err(error) = &result {
        // If journal I/O itself fails, preserve the pending payload and expose the
        // sanitized in-memory error until storage becomes writable again.
        let _ = conn.execute(
            "UPDATE inbox SET last_error=? WHERE seq=?",
            params![error.1, next.seq],
        );
    }
    result
}
