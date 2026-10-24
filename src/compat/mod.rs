//! Shared protocol state lives in the native query database, never a third DB.
//! Protocol handlers persist pending payloads before calling `ingest_metrics` and
//! own their per-run ordering. Success here means native projection is visible.
pub mod mlflow;
pub mod wandb;

use crate::{
    db::Database,
    errors::{ApiError, Result},
    ingest::{DurableIngest, IngestReceipt},
    models::{MetricBatch, MetricInput, NewRun, safe},
};
use axum::http::StatusCode;
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex as MapMutex, Weak},
    time::Duration,
};
use tokio::{
    sync::{Mutex, OwnedMutexGuard},
    time::{Instant, sleep, timeout_at},
};

/// Protocol ports provide explicit timestamps; their query-side sequence is ignored.
pub use crate::models::Metric;

const BATCH_SCHEME: &str = "compat-v1";
const CHUNK_SIZE: usize = 10_000;
const INGEST_TIMEOUT: Duration = Duration::from_secs(30);
const POLL_INTERVAL: Duration = Duration::from_millis(50);

type Locks = Arc<MapMutex<HashMap<String, Weak<Mutex<()>>>>>;

#[derive(Clone)]
pub struct Compat {
    pub db: Database,
    pub ingest: DurableIngest,
    locks: Locks,
}

impl Compat {
    pub fn new(db: Database, ingest: DurableIngest) -> Self {
        Self {
            db,
            ingest,
            locks: Arc::new(MapMutex::new(HashMap::new())),
        }
    }

    pub async fn get(&self, namespace: &str, key: &str) -> Result<Option<Value>> {
        self.db.compat_get(namespace.into(), key.into()).await
    }

    pub async fn put(&self, namespace: &str, key: &str, value: Value) -> Result<()> {
        self.put_many(namespace, vec![(key.into(), value)]).await
    }

    pub async fn put_many(&self, namespace: &str, values: Vec<(String, Value)>) -> Result<()> {
        self.db.compat_put_many(namespace.into(), values).await
    }

    pub async fn delete(&self, namespace: &str, key: &str) -> Result<()> {
        self.db.compat_delete(namespace.into(), key.into()).await
    }

    pub async fn items(&self, namespace: &str) -> Result<Vec<(String, Value)>> {
        self.db.compat_items(namespace.into()).await
    }

    pub async fn next_id(&self, namespace: &str, start: i64) -> Result<i64> {
        self.db.compat_next_id(namespace.into(), start).await
    }

    /// Clone-shared, non-reentrant per-key locks. The map guard never crosses await.
    /// Held guards and waiters keep their lock alive; unused entries are pruned.
    pub async fn lock(&self, key: &str) -> OwnedMutexGuard<()> {
        let lock = {
            let mut locks = self.locks.lock().unwrap_or_else(|error| error.into_inner());
            locks.retain(|_, lock| lock.strong_count() != 0);
            if let Some(lock) = locks.get(key).and_then(Weak::upgrade) {
                lock
            } else {
                let lock = Arc::new(Mutex::new(()));
                locks.insert(key.into(), Arc::downgrade(&lock));
                lock
            }
        };
        lock.lock_owned().await
    }

    /// Returns an existing mapping unchanged, otherwise creates both records in
    /// one native transaction and overwrites metadata.native_id with the new ID.
    pub async fn create_run(
        &self,
        namespace: &str,
        key: &str,
        input: NewRun,
        metadata: Value,
    ) -> Result<Value> {
        self.db
            .compat_create_run(namespace.into(), key.into(), input, metadata)
            .await
    }

    pub async fn ingest_metrics(
        &self,
        run_id: &str,
        batch_id: &str,
        metrics: Vec<Metric>,
    ) -> Result<()> {
        if run_id.is_empty() || metrics.is_empty() {
            return Err(ApiError::bad("run id and nonempty metrics are required"));
        }
        if batch_id.is_empty()
            || batch_id.len() > 128
            || !batch_id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(&byte))
        {
            return Err(ApiError::bad(
                "batch id must be 1..128 ASCII letters, digits, dot, underscore or hyphen",
            ));
        }
        // Protocol metadata carries Metric records; native ingestion assigns seq.
        let metrics: Vec<MetricInput> = metrics
            .into_iter()
            .map(|metric| MetricInput {
                key: metric.key,
                step: metric.step,
                timestamp: Some(metric.timestamp),
                value: metric.value,
            })
            .collect();
        // Validate all chunks before committing an identity or submitting anything.
        for metric in &metrics {
            metric.validate()?;
        }
        let digest = fingerprint(&metrics)?;
        self.db
            .compat_bind_batch(run_id.into(), batch_id.into(), BATCH_SCHEME.into(), digest)
            .await?;

        // The immutable binding is now durable. Cancellation at any later point is
        // safe: retries submit the same identities, including after partial chunks.
        let deadline = Instant::now() + INGEST_TIMEOUT;
        for (index, chunk) in metrics.chunks(CHUNK_SIZE).enumerate() {
            let source = serde_json::to_vec(&(BATCH_SCHEME, run_id, batch_id, index))
                .map_err(ApiError::internal)?;
            let chunk_id = format!("cs1-{:x}", Sha256::digest(source));
            let mut receipt = timeout_at(
                deadline,
                self.ingest.submit(
                    run_id.into(),
                    chunk_id.clone(),
                    MetricBatch {
                        metrics: chunk.to_vec(),
                    },
                ),
            )
            .await
            .map_err(|_| pending())??;
            loop {
                check_receipt(&receipt, run_id, &chunk_id, chunk.len())?;
                if receipt.state == "applied" {
                    break;
                }
                timeout_at(deadline, sleep(POLL_INTERVAL))
                    .await
                    .map_err(|_| pending())?;
                receipt = timeout_at(
                    deadline,
                    self.ingest.receipt(run_id.into(), chunk_id.clone()),
                )
                .await
                .map_err(|_| pending())??;
            }
        }
        Ok(())
    }
}

fn pending() -> ApiError {
    ApiError(
        StatusCode::SERVICE_UNAVAILABLE,
        "native ingest remains pending; retry with the same batch id",
    )
}

fn check_receipt(receipt: &IngestReceipt, run: &str, batch: &str, count: usize) -> Result<()> {
    if receipt.run_id != run
        || receipt.batch_id != batch
        || receipt.accepted != count
        || !matches!(receipt.state.as_str(), "pending" | "applied")
        || safe(receipt.accepted_at).is_err()
    {
        return Err(ApiError(
            StatusCode::SERVICE_UNAVAILABLE,
            "invalid native ingest receipt; retry with the same batch id",
        ));
    }
    Ok(())
}

fn fingerprint(metrics: &[MetricInput]) -> Result<Vec<u8>> {
    #[derive(Serialize)]
    struct Body<'a> {
        metrics: &'a [MetricInput],
    }
    // Streaming serialization bounds work without allocating another full body.
    struct BoundedHash {
        hash: Sha256,
        bytes: usize,
    }
    impl std::io::Write for BoundedHash {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            if bytes.len() > crate::config::MAX_BODY.saturating_sub(self.bytes) {
                return Err(std::io::Error::other("compatibility body limit exceeded"));
            }
            self.bytes += bytes.len();
            self.hash.update(bytes);
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    let mut writer = BoundedHash {
        hash: Sha256::new(),
        bytes: 0,
    };
    serde_json::to_writer(&mut writer, &Body { metrics }).map_err(|_| {
        ApiError(
            StatusCode::PAYLOAD_TOO_LARGE,
            "metric batch exceeds body limit",
        )
    })?;
    // Match the native journal's finite-f64 identity, including signed zero.
    // JSON alone must not determine equality of floating-point observations.
    for metric in metrics {
        writer.hash.update(metric.value.to_bits().to_be_bytes());
    }
    Ok(writer.hash.finalize().to_vec())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{ingest::IngestOptions, models::Object};
    use rusqlite::Connection;

    fn metric(value: f64) -> Metric {
        Metric {
            seq: 0,
            key: "loss".into(),
            step: 0,
            timestamp: 1,
            value,
        }
    }

    async fn fixture(paused: bool) -> (tempfile::TempDir, Compat, String) {
        let directory = tempfile::tempdir().unwrap();
        let db = Database::open(directory.path()).unwrap();
        let (experiment, _) = db.create_experiment("compat".into()).await.unwrap();
        let run = db
            .create_run(NewRun {
                experiment_id: experiment.id,
                name: "run".into(),
                params: Object::new(),
                tags: Object::new(),
            })
            .await
            .unwrap();
        let ingest = DurableIngest::open(
            directory.path(),
            db.clone(),
            IngestOptions {
                paused,
                poll_interval_ms: 1,
                ..IngestOptions::default()
            },
        )
        .unwrap();
        (directory, Compat::new(db, ingest), run.id)
    }

    #[tokio::test]
    async fn weak_locks_share_keys_without_serializing_other_keys() {
        let (_directory, compat, _) = fixture(false).await;
        let held = compat.lock("run-a").await;
        let clone = compat.clone();
        assert!(
            tokio::time::timeout(Duration::from_millis(20), clone.lock("run-a"))
                .await
                .is_err()
        );
        let other = tokio::time::timeout(Duration::from_secs(1), clone.lock("run-b"))
            .await
            .unwrap();
        drop(other);
        drop(held);
        drop(clone.lock("run-a").await);
        for key in 0..100 {
            drop(compat.lock(&key.to_string()).await);
        }
        assert_eq!(compat.locks.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn chunked_ingest_is_visible_and_retries_do_not_duplicate() {
        let (directory, compat, run) = fixture(false).await;
        let metrics = || (0..CHUNK_SIZE + 1).map(|_| metric(0.5)).collect();
        compat
            .ingest_metrics(&run, "chunked", metrics())
            .await
            .unwrap();
        compat
            .ingest_metrics(&run, "chunked", metrics())
            .await
            .unwrap();
        let query = Connection::open(directory.path().join("nset.sqlite3")).unwrap();
        assert_eq!(
            query
                .query_row("SELECT COUNT(*) FROM metrics", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            (CHUNK_SIZE + 1) as i64
        );
        assert_eq!(
            query
                .query_row("SELECT COUNT(*) FROM ingest_receipts", [], |r| r
                    .get::<_, i64>(0))
                .unwrap(),
            2
        );
        // A changed chunk count must conflict before submitting any new chunks.
        let error = compat
            .ingest_metrics(&run, "chunked", vec![metric(0.5)])
            .await
            .unwrap_err();
        assert_eq!(error.0, StatusCode::CONFLICT);
        let journal =
            Connection::open(directory.path().join(crate::ingest::JOURNAL_FILENAME)).unwrap();
        assert_eq!(
            journal
                .query_row(
                    "SELECT COUNT(*) FROM inbox WHERE state='applied'",
                    [],
                    |r| r.get::<_, i64>(0)
                )
                .unwrap(),
            2
        );
    }

    #[tokio::test]
    async fn finite_bits_bind_identity_and_invalid_tail_never_submits() {
        let (directory, compat, run) = fixture(false).await;
        compat
            .ingest_metrics(&run, "signed-zero", vec![metric(-0.0)])
            .await
            .unwrap();
        let error = compat
            .ingest_metrics(&run, "signed-zero", vec![metric(0.0)])
            .await
            .unwrap_err();
        assert_eq!(error.0, StatusCode::CONFLICT);
        for value in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
            let mut invalid: Vec<_> = (0..CHUNK_SIZE).map(|_| metric(1.0)).collect();
            invalid.push(metric(value));
            assert_eq!(
                compat
                    .ingest_metrics(&run, "invalid", invalid)
                    .await
                    .unwrap_err()
                    .0,
                StatusCode::BAD_REQUEST
            );
        }
        assert!(
            compat
                .ingest_metrics(&run, "empty", Vec::new())
                .await
                .is_err()
        );
        assert!(
            compat
                .ingest_metrics(&run, "not/valid", vec![metric(1.0)])
                .await
                .is_err()
        );
        let query = Connection::open(directory.path().join("nset.sqlite3")).unwrap();
        assert_eq!(
            query
                .query_row("SELECT COUNT(*) FROM compat_batches", [], |r| r
                    .get::<_, i64>(0))
                .unwrap(),
            1
        );
        assert_eq!(
            query
                .query_row("SELECT COUNT(*) FROM metrics", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            1
        );
    }

    #[tokio::test]
    async fn cancelled_pending_ingest_retains_binding_and_has_no_direct_fallback() {
        let (directory, compat, run) = fixture(true).await;
        let task_compat = compat.clone();
        let task_run = run.clone();
        let task = tokio::spawn(async move {
            task_compat
                .ingest_metrics(&task_run, "pending", vec![metric(2.0)])
                .await
        });
        let journal =
            Connection::open(directory.path().join(crate::ingest::JOURNAL_FILENAME)).unwrap();
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let pending: i64 = journal
                    .query_row(
                        "SELECT COUNT(*) FROM inbox WHERE state='pending'",
                        [],
                        |row| row.get(0),
                    )
                    .unwrap();
                if pending == 1 {
                    break;
                }
                sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .unwrap();
        task.abort();
        let _ = task.await;
        let error = compat
            .ingest_metrics(&run, "pending", vec![metric(3.0)])
            .await
            .unwrap_err();
        assert_eq!(error.0, StatusCode::CONFLICT);
        let query = Connection::open(directory.path().join("nset.sqlite3")).unwrap();
        assert_eq!(
            query
                .query_row("SELECT COUNT(*) FROM compat_batches", [], |r| r
                    .get::<_, i64>(0))
                .unwrap(),
            1
        );
        assert_eq!(
            query
                .query_row("SELECT COUNT(*) FROM metrics", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            0
        );
        drop(query);
        drop(journal);
        drop(compat);
        // Resume exactly the same fresh test root: durable replay and retry agree.
        let db = Database::open(directory.path()).unwrap();
        let ingest =
            DurableIngest::open(directory.path(), db.clone(), IngestOptions::default()).unwrap();
        let compat = Compat::new(db, ingest);
        compat
            .ingest_metrics(&run, "pending", vec![metric(2.0)])
            .await
            .unwrap();
        let query = Connection::open(directory.path().join("nset.sqlite3")).unwrap();
        assert_eq!(
            query
                .query_row("SELECT COUNT(*) FROM metrics", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            1
        );
    }

    #[test]
    fn fingerprints_preserve_finite_f64_bits_and_bound_body_size() {
        let input = |value| MetricInput {
            key: "loss".into(),
            step: 0,
            timestamp: Some(1),
            value,
        };
        assert_ne!(
            fingerprint(&[input(-0.0)]).unwrap(),
            fingerprint(&[input(0.0)]).unwrap()
        );
        let value = 0.845_512_408_225_570_1_f64;
        assert_ne!(
            fingerprint(&[input(value)]).unwrap(),
            fingerprint(&[input(f64::from_bits(value.to_bits() + 1))]).unwrap()
        );
        let large = MetricInput {
            key: "k".repeat(512),
            ..input(1.0)
        };
        assert_eq!(
            fingerprint(&vec![large; 65_536]).unwrap_err().0,
            StatusCode::PAYLOAD_TOO_LARGE
        );
    }
}
