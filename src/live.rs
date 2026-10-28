//! Process-local, bounded postcommit hints for the single native writer.
//! SQLite is authoritative: restart, overflow and foreign cursors require resync.
//! External SQLite writers are not observed by this feed. Never await publication.
use crate::{
    errors::{ApiError, Result},
    models::Metric,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::VecDeque,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::sync::{Semaphore, watch};
use uuid::Uuid;

const MAX_ENTRIES: usize = 4096;
const MAX_BYTES: usize = 2 * 1024 * 1024;
const MAX_POLLS: usize = 256;
const WAIT: Duration = Duration::from_secs(20);
const COALESCE: Duration = Duration::from_millis(75);

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Change {
    Metric {
        #[serde(rename = "runId")]
        run_id: String,
        key: String,
        high: i64,
        /// Observations added to this key by ONE committed batch (not a total).
        count: usize,
        last: Metric,
    },
    Catalog,
    Rx,
    Image {
        #[serde(rename = "runId")]
        run_id: String,
        key: String,
    },
}

#[derive(Debug, Serialize, Deserialize)]
pub struct PollResponse {
    pub cursor: String,
    pub reset: bool,
    pub changes: Vec<Change>,
}

struct Batch {
    revision: u64,
    bytes: usize,
    changes: Vec<Change>,
}
struct Ring {
    epoch: String,
    revision: u64,
    /// Cursors strictly below this revision have lost at least one batch.
    floor: u64,
    entries: usize,
    bytes: usize,
    batches: VecDeque<Batch>,
}
impl Ring {
    fn cursor(&self) -> String {
        format!("{}:{}", self.epoch, self.revision)
    }
    fn response(&self, cursor: &str) -> PollResponse {
        let revision = cursor.split_once(':').and_then(|(epoch, value)| {
            if epoch != self.epoch || value.is_empty() || !value.bytes().all(|b| b.is_ascii_digit())
            {
                return None;
            }
            value.parse::<u64>().ok()
        });
        let valid = revision.filter(|r| *r >= self.floor && *r <= self.revision);
        PollResponse {
            cursor: self.cursor(),
            reset: valid.is_none(),
            changes: valid
                .map(|r| {
                    self.batches
                        .iter()
                        .filter(|b| b.revision > r)
                        .flat_map(|b| b.changes.iter().cloned())
                        .collect()
                })
                .unwrap_or_default(),
        }
    }
}
struct Inner {
    ring: Mutex<Ring>,
    wake: watch::Sender<()>,
    polls: Semaphore,
    max_entries: usize,
    max_bytes: usize,
}
#[derive(Clone)]
pub struct Live(Arc<Inner>);
impl Default for Live {
    fn default() -> Self {
        Self::new()
    }
}
impl Live {
    pub fn new() -> Self {
        Self::bounded(MAX_ENTRIES, MAX_BYTES)
    }
    fn bounded(max_entries: usize, max_bytes: usize) -> Self {
        let (wake, _) = watch::channel(());
        Self(Arc::new(Inner {
            ring: Mutex::new(Ring {
                epoch: Uuid::new_v4().to_string(),
                revision: 0,
                floor: 0,
                entries: 0,
                bytes: 0,
                batches: VecDeque::new(),
            }),
            wake,
            polls: Semaphore::new(MAX_POLLS),
            max_entries,
            max_bytes,
        }))
    }
    pub fn cursor(&self) -> String {
        self.0
            .ring
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .cursor()
    }
    pub fn publish(&self, change: Change) {
        self.publish_batch(vec![change]);
    }
    /// Preserve transaction boundaries. In particular never add metric counts
    /// across batches: a catalog watermark may fall between those commits.
    pub fn publish_batch(&self, changes: Vec<Change>) {
        if changes.is_empty() {
            return;
        }
        // Include allocation overhead as well as wire bytes in the retention bound.
        // Serialization is outside the short ring lock and cannot fail publication.
        let bytes = serde_json::to_vec(&changes)
            .map(|v| v.len().saturating_add(changes.len().saturating_mul(128)))
            .unwrap_or(usize::MAX);
        {
            let mut ring = self.0.ring.lock().unwrap_or_else(|e| e.into_inner());
            if ring.revision == u64::MAX {
                ring.epoch = Uuid::new_v4().to_string();
                ring.revision = 0;
                ring.floor = 0;
                ring.entries = 0;
                ring.bytes = 0;
                ring.batches.clear();
            }
            ring.revision += 1;
            let revision = ring.revision;
            // A batch that cannot fit is an explicit reset barrier, never truncated.
            if changes.len() > self.0.max_entries || bytes > self.0.max_bytes {
                ring.batches.clear();
                ring.entries = 0;
                ring.bytes = 0;
                ring.floor = revision;
            } else {
                while ring.entries + changes.len() > self.0.max_entries
                    || ring.bytes + bytes > self.0.max_bytes
                {
                    if let Some(old) = ring.batches.pop_front() {
                        ring.entries -= old.changes.len();
                        ring.bytes -= old.bytes;
                        ring.floor = old.revision;
                    } else {
                        break;
                    }
                }
                ring.entries += changes.len();
                ring.bytes += bytes;
                ring.batches.push_back(Batch {
                    revision,
                    bytes,
                    changes,
                });
            }
        }
        self.0.wake.send_replace(());
    }
    fn response(&self, cursor: &str) -> PollResponse {
        self.0
            .ring
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .response(cursor)
    }
    pub async fn poll(&self, cursor: impl AsRef<str>) -> Result<PollResponse> {
        self.poll_for(cursor.as_ref(), WAIT, COALESCE).await
    }
    async fn poll_for(
        &self,
        cursor: &str,
        wait: Duration,
        coalesce: Duration,
    ) -> Result<PollResponse> {
        let _permit = self.0.polls.try_acquire().map_err(|_| ApiError::busy())?;
        // Subscribe BEFORE reading the ring; no commit can disappear in the gap.
        let mut wake = self.0.wake.subscribe();
        let deadline = tokio::time::Instant::now() + wait;
        loop {
            let response = self.response(cursor);
            if response.reset {
                return Ok(response);
            }
            if !response.changes.is_empty() {
                tokio::time::sleep(coalesce).await;
                return Ok(self.response(cursor));
            }
            if tokio::time::timeout_at(deadline, wake.changed())
                .await
                .is_err()
            {
                return Ok(self.response(cursor));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn replay_timeout_and_abort_are_lossless() {
        let live = Live::new();
        let before = live.cursor();
        let empty = live
            .poll_for(&before, Duration::from_millis(2), Duration::ZERO)
            .await
            .unwrap();
        assert!(!empty.reset);
        assert!(empty.changes.is_empty());
        assert_eq!(empty.cursor, before);
        let pending = {
            let live = live.clone();
            let cursor = before.clone();
            tokio::spawn(async move { live.poll(cursor).await })
        };
        tokio::task::yield_now().await;
        pending.abort();
        let _ = pending.await;
        assert_eq!(live.0.polls.available_permits(), MAX_POLLS);
        live.publish(Change::Catalog);
        for _ in 0..2 {
            let response = live
                .poll_for(&before, Duration::ZERO, Duration::ZERO)
                .await
                .unwrap();
            assert!(!response.reset);
            assert_eq!(response.changes.len(), 1);
        }
    }
    #[tokio::test]
    async fn wakes_and_keeps_batches_separate() {
        let live = Live::new();
        let before = live.cursor();
        let pending = {
            let live = live.clone();
            tokio::spawn(async move {
                live.poll_for(&before, Duration::from_secs(1), Duration::from_millis(5))
                    .await
                    .unwrap()
            })
        };
        tokio::task::yield_now().await;
        live.publish(Change::Catalog);
        live.publish(Change::Catalog);
        assert_eq!(pending.await.unwrap().changes.len(), 2);
    }
    #[test]
    fn ring_bounds_epochs_future_and_oversized_batches() {
        let live = Live::bounded(2, 1024);
        let before = live.cursor();
        live.publish(Change::Catalog);
        let first = live.cursor();
        live.publish_batch(vec![Change::Catalog, Change::Catalog]);
        assert!(live.response(&before).reset);
        assert_eq!(live.response(&first).changes.len(), 2);
        assert!(live.response("foreign:0").reset);
        assert!(live.response("bad").reset);
        let epoch = live.cursor().split(':').next().unwrap().to_string();
        assert!(live.response(&format!("{epoch}:999")).reset);
        let before = live.cursor();
        live.publish(Change::Image {
            run_id: "r".into(),
            key: "x".repeat(2000),
        });
        assert!(live.response(&before).reset);
        assert!(!live.response(&live.cursor()).reset);
        live.publish(Change::Catalog);
        let ring = live.0.ring.lock().unwrap();
        assert!(ring.entries <= 2 && ring.bytes <= 1024);
    }
    #[test]
    fn byte_budget_evicts_independently_of_entry_budget() {
        let live = Live::bounded(100, 250);
        let before = live.cursor();
        live.publish(Change::Catalog);
        let first = live.cursor();
        live.publish(Change::Catalog);
        assert!(live.response(&before).reset);
        assert_eq!(live.response(&first).changes.len(), 1);
    }
}
