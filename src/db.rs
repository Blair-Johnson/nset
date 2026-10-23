//! SQLite never runs on an async executor. One writer and two read-only actors,
//! each with a bounded queue, own their connections for their entire lifetime.
use crate::{
    errors::{ApiError, Result},
    models::*,
};
use rusqlite::{Connection, OptionalExtension, params};
use std::{
    io::Write,
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};
use tokio::sync::{mpsc, oneshot};
use uuid::Uuid;

pub const SCHEMA_VERSION: i64 = 1;

type Job = Box<dyn FnOnce(&mut Connection) + Send + 'static>;
#[derive(Clone)]
struct Actor(mpsc::Sender<Job>);
impl Actor {
    fn start(mut connection: Connection, name: &str) -> Result<Self> {
        let (tx, mut rx) = mpsc::channel::<Job>(64);
        std::thread::Builder::new()
            .name(name.to_owned())
            .spawn(move || {
                while let Some(job) = rx.blocking_recv() {
                    job(&mut connection);
                }
            })?;
        Ok(Self(tx))
    }
    async fn call<T: Send + 'static>(
        &self,
        work: impl FnOnce(&mut Connection) -> Result<T> + Send + 'static,
    ) -> Result<T> {
        let (tx, rx) = oneshot::channel();
        // Reject excess work instead of retaining unbounded request bodies in waiters.
        self.0
            .try_send(Box::new(move |conn| {
                let _ = tx.send(work(conn));
            }))
            .map_err(|_| ApiError::busy())?;
        rx.await.map_err(ApiError::internal)?
    }
}
#[derive(Clone)]
pub struct Database {
    writer: Actor,
    readers: Arc<Vec<Actor>>,
    next_reader: Arc<AtomicUsize>,
    images: Arc<PathBuf>,
}
fn setup(connection: &Connection) -> Result<()> {
    connection.busy_timeout(Duration::from_secs(5))?;
    connection.pragma_update(None, "foreign_keys", "ON")?;
    Ok(())
}
fn run_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Run> {
    let parse = |index| -> rusqlite::Result<Object> {
        let raw: String = row.get(index)?;
        serde_json::from_str(&raw).map_err(|e| {
            rusqlite::Error::FromSqlConversionFailure(
                index,
                rusqlite::types::Type::Text,
                Box::new(e),
            )
        })
    };
    Ok(Run {
        id: row.get(0)?,
        experiment_id: row.get(1)?,
        name: row.get(2)?,
        status: row.get(3)?,
        params: parse(4)?,
        tags: parse(5)?,
        created_at: row.get(6)?,
        updated_at: row.get(7)?,
    })
}
const RUN_COLUMNS: &str = "id,experiment_id,name,status,params,tags,created_at,updated_at";
fn get_run(connection: &Connection, id: &str) -> Result<Run> {
    connection
        .query_row(
            &format!("SELECT {RUN_COLUMNS} FROM runs WHERE id=?"),
            [id],
            run_row,
        )
        .optional()?
        .ok_or_else(ApiError::missing)
}
fn require_run(connection: &Connection, id: &str) -> Result<()> {
    if connection
        .query_row("SELECT 1 FROM runs WHERE id=?", [id], |_| Ok(()))
        .optional()?
        .is_none()
    {
        return Err(ApiError::missing());
    }
    Ok(())
}
fn image_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Image> {
    Ok(Image {
        id: row.get(0)?,
        run_id: row.get(1)?,
        key: row.get(2)?,
        step: row.get(3)?,
        timestamp: row.get(4)?,
        content_type: row.get(5)?,
        byte_length: row.get(6)?,
    })
}
const IMAGE_COLUMNS: &str = "id,run_id,key,step,timestamp,content_type,byte_length";
fn schema_version(connection: &Connection) -> Result<i64> {
    let version =
        connection.pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))?;
    if !(0..=SCHEMA_VERSION).contains(&version) {
        return Err(ApiError::internal(format!(
            "unsupported database schema version {version}; expected at most {SCHEMA_VERSION}"
        )));
    }
    Ok(version)
}

fn initialize_schema(connection: &mut Connection) -> Result<()> {
    let tx = connection.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    // Recheck under the write lock. Version zero also covers the original,
    // unversioned schema: IF NOT EXISTS preserves its tables, indexes and data.
    if schema_version(&tx)? == 0 {
        tx.execute_batch("
            CREATE TABLE IF NOT EXISTS experiments(id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY, experiment_id TEXT NOT NULL REFERENCES experiments(id), name TEXT NOT NULL,
                status TEXT NOT NULL CHECK(status IN ('running','finished','failed')), params TEXT NOT NULL, tags TEXT NOT NULL,
                created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
            CREATE INDEX IF NOT EXISTS runs_experiment ON runs(experiment_id,created_at);
            CREATE TABLE IF NOT EXISTS metrics(seq INTEGER PRIMARY KEY AUTOINCREMENT CHECK(seq<=9007199254740991), run_id TEXT NOT NULL REFERENCES runs(id),
                key TEXT NOT NULL, step INTEGER NOT NULL CHECK(step BETWEEN 0 AND 9007199254740991),
                timestamp INTEGER NOT NULL CHECK(timestamp BETWEEN 0 AND 9007199254740991), value REAL NOT NULL);
            CREATE INDEX IF NOT EXISTS metrics_stream ON metrics(run_id,key,seq);
            CREATE TABLE IF NOT EXISTS images(id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), key TEXT NOT NULL,
                step INTEGER NOT NULL, timestamp INTEGER NOT NULL, content_type TEXT NOT NULL, byte_length INTEGER NOT NULL,
                filename TEXT NOT NULL UNIQUE);
            CREATE INDEX IF NOT EXISTS images_stream ON images(run_id,key,step,timestamp,id);")?;
        tx.pragma_update(None, "user_version", SCHEMA_VERSION)?;
    }
    tx.commit()?;
    Ok(())
}

fn sync_image_directory(directory: &Path) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        // Persist the renamed directory entry before committing its SQLite index.
        std::fs::File::open(directory)?.sync_all()
    }
    #[cfg(not(unix))]
    {
        // std cannot portably open/sync directories on non-Unix platforms.
        // File contents are synced, but rename durability across power loss is
        // best-effort there; a committed index may outlive its directory entry.
        let _ = directory;
        Ok(())
    }
}

impl Database {
    pub fn open(directory: &Path) -> Result<Self> {
        std::fs::create_dir_all(directory)?;
        let path = directory.join("nset.sqlite3");
        let mut connection = Connection::open(&path)?;
        // Reject unknown versions before any persistent PRAGMA, DDL, or image
        // directory creation. In particular, do not change a newer DB to WAL.
        schema_version(&connection)?;
        setup(&connection)?;
        connection.pragma_update(None, "journal_mode", "WAL")?;
        connection.pragma_update(None, "synchronous", "FULL")?;
        initialize_schema(&mut connection)?;
        let images = directory.join("images");
        std::fs::create_dir_all(&images)?;
        let writer = Actor::start(connection, "nset-sqlite-writer")?;
        let mut readers = Vec::new();
        for i in 0..2 {
            let connection =
                Connection::open_with_flags(&path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)?;
            setup(&connection)?;
            readers.push(Actor::start(
                connection,
                &format!("nset-sqlite-reader-{i}"),
            )?);
        }
        Ok(Self {
            writer,
            readers: Arc::new(readers),
            next_reader: Arc::new(AtomicUsize::new(0)),
            images: Arc::new(images),
        })
    }
    fn reader(&self) -> &Actor {
        &self.readers[self.next_reader.fetch_add(1, Ordering::Relaxed) % self.readers.len()]
    }
    pub async fn experiments(&self) -> Result<Vec<Experiment>> {
        self.reader()
            .call(|conn| {
                Ok(conn
                    .prepare(
                        "SELECT id,name,created_at FROM experiments ORDER BY created_at DESC,id",
                    )?
                    .query_map([], |row| {
                        Ok(Experiment {
                            id: row.get(0)?,
                            name: row.get(1)?,
                            created_at: row.get(2)?,
                        })
                    })?
                    .collect::<rusqlite::Result<_>>()?)
            })
            .await
    }
    pub async fn create_experiment(&self, name: String) -> Result<(Experiment, bool)> {
        name_check(&name)?;
        self.writer
            .call(move |conn| {
                let tx = conn.transaction()?;
                let found = tx
                    .query_row(
                        "SELECT id,name,created_at FROM experiments WHERE name=?",
                        [&name],
                        |row| {
                            Ok(Experiment {
                                id: row.get(0)?,
                                name: row.get(1)?,
                                created_at: row.get(2)?,
                            })
                        },
                    )
                    .optional()?;
                if let Some(experiment) = found {
                    return Ok((experiment, false));
                }
                let experiment = Experiment {
                    id: Uuid::new_v4().to_string(),
                    name,
                    created_at: now(),
                };
                tx.execute(
                    "INSERT INTO experiments(id,name,created_at) VALUES(?,?,?)",
                    params![experiment.id, experiment.name, experiment.created_at],
                )?;
                tx.commit()?;
                Ok((experiment, true))
            })
            .await
    }
    pub async fn runs(&self, experiment: Option<String>) -> Result<Vec<Run>> {
        self.reader().call(move |conn| {
            if let Some(id) = &experiment
                && conn.query_row("SELECT 1 FROM experiments WHERE id=?", [id], |_| Ok(())).optional()?.is_none() {
                return Err(ApiError::missing());
            }
            Ok(conn.prepare(&format!("SELECT {RUN_COLUMNS} FROM runs WHERE (?1 IS NULL OR experiment_id=?1) ORDER BY created_at DESC,id DESC"))?.query_map([experiment], run_row)?.collect::<rusqlite::Result<_>>()?)
        }).await
    }
    pub async fn run(&self, id: String) -> Result<Run> {
        self.reader().call(move |conn| get_run(conn, &id)).await
    }
    pub async fn create_run(&self, input: NewRun) -> Result<Run> {
        name_check(&input.name)?;
        object_keys(&input.params)?;
        object_keys(&input.tags)?;
        self.writer
            .call(move |conn| {
                let tx = conn.transaction()?;
                if tx
                    .query_row(
                        "SELECT 1 FROM experiments WHERE id=?",
                        [&input.experiment_id],
                        |_| Ok(()),
                    )
                    .optional()?
                    .is_none()
                {
                    return Err(ApiError::missing());
                }
                let time = now();
                let run = Run {
                    id: Uuid::new_v4().to_string(),
                    experiment_id: input.experiment_id,
                    name: input.name,
                    status: "running".into(),
                    params: input.params,
                    tags: input.tags,
                    created_at: time,
                    updated_at: time,
                };
                tx.execute(
                    "INSERT INTO runs VALUES(?,?,?,?,?,?,?,?)",
                    params![
                        run.id,
                        run.experiment_id,
                        run.name,
                        run.status,
                        serde_json::to_string(&run.params).map_err(ApiError::internal)?,
                        serde_json::to_string(&run.tags).map_err(ApiError::internal)?,
                        run.created_at,
                        run.updated_at
                    ],
                )?;
                tx.commit()?;
                Ok(run)
            })
            .await
    }
    pub async fn patch_run(&self, id: String, patch: PatchRun) -> Result<Run> {
        if let Some(params) = &patch.params {
            object_keys(params)?;
        }
        if let Some(tags) = &patch.tags {
            object_keys(tags)?;
        }
        if patch
            .status
            .as_ref()
            .is_some_and(|s| !["running", "finished", "failed"].contains(&s.as_str()))
        {
            return Err(ApiError::bad("invalid run status"));
        }
        self.writer
            .call(move |conn| {
                let tx = conn.transaction()?;
                let mut run = get_run(&tx, &id)?;
                if let Some(status) = patch.status {
                    run.status = status;
                }
                if let Some(params) = patch.params {
                    run.params.extend(params);
                }
                if let Some(tags) = patch.tags {
                    run.tags.extend(tags);
                }
                run.updated_at = now();
                tx.execute(
                    "UPDATE runs SET status=?,params=?,tags=?,updated_at=? WHERE id=?",
                    params![
                        run.status,
                        serde_json::to_string(&run.params).map_err(ApiError::internal)?,
                        serde_json::to_string(&run.tags).map_err(ApiError::internal)?,
                        run.updated_at,
                        id
                    ],
                )?;
                tx.commit()?;
                Ok(run)
            })
            .await
    }
    pub async fn insert_metrics(&self, id: String, batch: MetricBatch) -> Result<usize> {
        if batch.metrics.len() > 10000 {
            return Err(ApiError::bad("at most 10000 metrics per request"));
        }
        for metric in &batch.metrics {
            metric.validate()?;
        }
        self.writer
            .call(move |conn| {
                let tx = conn.transaction()?;
                require_run(&tx, &id)?;
                let count = batch.metrics.len();
                let time = now();
                {
                    let mut insert = tx.prepare_cached(
                        "INSERT INTO metrics(run_id,key,step,timestamp,value) VALUES(?,?,?,?,?)",
                    )?;
                    for metric in batch.metrics {
                        insert.execute(params![
                            id,
                            metric.key,
                            metric.step,
                            metric.timestamp.unwrap_or(time),
                            metric.value
                        ])?;
                    }
                }
                if count > 0 {
                    tx.execute("UPDATE runs SET updated_at=? WHERE id=?", params![time, id])?;
                }
                tx.commit()?;
                Ok(count)
            })
            .await
    }
    pub async fn metric_keys(&self, id: String) -> Result<Vec<String>> {
        self.reader()
            .call(move |conn| {
                require_run(conn, &id)?;
                Ok(conn
                    .prepare("SELECT DISTINCT key FROM metrics WHERE run_id=? ORDER BY key")?
                    .query_map([id], |row| row.get(0))?
                    .collect::<rusqlite::Result<_>>()?)
            })
            .await
    }
    pub async fn metrics(&self, id: String, query: MetricQuery) -> Result<MetricPage> {
        name_check(&query.key)?;
        let after = query.after.unwrap_or(0);
        safe(after)?;
        if let Some(snapshot) = query.snapshot {
            safe(snapshot)?;
        }
        let limit = query.limit.unwrap_or(10000);
        if !(1..=50000).contains(&limit) {
            return Err(ApiError::bad("limit must be 1..50000"));
        }
        self.reader().call(move |conn| {
            // All page metadata and points observe the same SQLite read snapshot.
            let tx = conn.transaction()?;
            require_run(&tx,&id)?;
            let high: i64 = tx.query_row("SELECT COALESCE(MAX(seq),0) FROM metrics WHERE run_id=? AND key=?", params![id,query.key], |row| row.get(0))?;
            let snapshot = query.snapshot.unwrap_or(high);
            if snapshot > high { return Err(ApiError::bad("snapshot exceeds stream high-water mark")); }
            let total = tx.query_row("SELECT COUNT(*) FROM metrics WHERE run_id=? AND key=? AND seq<=?", params![id,query.key,snapshot], |row| row.get(0))?;
            let mut points: Vec<Metric> = tx.prepare("SELECT seq,key,step,timestamp,value FROM metrics WHERE run_id=? AND key=? AND seq>? AND seq<=? ORDER BY seq LIMIT ?")?.query_map(params![id,query.key,after,snapshot,(limit+1) as i64], |row| Ok(Metric {seq:row.get(0)?,key:row.get(1)?,step:row.get(2)?,timestamp:row.get(3)?,value:row.get(4)?}))?.collect::<rusqlite::Result<_>>()?;
            let more = points.len() > limit;
            if more { points.pop(); }
            let next_after = if more { points.last().map(|point| point.seq) } else { None };
            tx.commit()?;
            Ok(MetricPage {points,next_after,snapshot,total})
        }).await
    }
    pub async fn insert_image(
        &self,
        run_id: String,
        query: ImageQuery,
        content_type: String,
        bytes: Vec<u8>,
    ) -> Result<Image> {
        name_check(&query.key)?;
        safe(query.step)?;
        safe(query.timestamp)?;
        let directory = self.images.clone();
        self.writer
            .call(move |conn| {
                let tx = conn.transaction()?;
                require_run(&tx, &run_id)?;
                let id = Uuid::new_v4().to_string();
                let filename = format!("{id}.image");
                let path = directory.join(&filename);
                let image = Image {
                    id,
                    run_id,
                    key: query.key,
                    step: query.step,
                    timestamp: query.timestamp,
                    content_type,
                    byte_length: bytes.len() as i64,
                };
                // Same directory guarantees an atomic rename; unique generated names
                // and persist_noclobber prevent replacement of any existing artifact.
                let mut temp = tempfile::NamedTempFile::new_in(directory.as_ref())?;
                temp.write_all(&bytes)?;
                temp.as_file().sync_all()?;
                temp.persist_noclobber(&path).map_err(ApiError::internal)?;
                let indexed = (|| -> Result<()> {
                    sync_image_directory(&directory)?;
                    tx.execute(
                        "INSERT INTO images VALUES(?,?,?,?,?,?,?,?)",
                        params![
                            image.id,
                            image.run_id,
                            image.key,
                            image.step,
                            image.timestamp,
                            image.content_type,
                            image.byte_length,
                            filename
                        ],
                    )?;
                    tx.execute(
                        "UPDATE runs SET updated_at=? WHERE id=?",
                        params![now(), image.run_id],
                    )?;
                    tx.commit()?;
                    Ok(())
                })();
                if let Err(error) = indexed {
                    if let Err(cleanup) = std::fs::remove_file(path) {
                        tracing::error!(%cleanup,"failed to remove unindexed image");
                    }
                    return Err(error);
                }
                Ok(image)
            })
            .await
    }
    pub async fn images(&self, id: String, key: Option<String>) -> Result<Vec<Image>> {
        if let Some(key) = &key {
            name_check(key)?;
        }
        self.reader().call(move |conn| {
            require_run(conn,&id)?;
            Ok(conn.prepare(&format!("SELECT {IMAGE_COLUMNS} FROM images WHERE run_id=?1 AND (?2 IS NULL OR key=?2) ORDER BY step,timestamp,id"))?.query_map(params![id,key],image_row)?.collect::<rusqlite::Result<_>>()?)
        }).await
    }
    pub async fn image_content(&self, id: String) -> Result<(Image, Vec<u8>)> {
        let directory = self.images.clone();
        self.reader()
            .call(move |conn| {
                let image = conn
                    .query_row(
                        &format!("SELECT {IMAGE_COLUMNS} FROM images WHERE id=?"),
                        [&id],
                        image_row,
                    )
                    .optional()?
                    .ok_or_else(ApiError::missing)?;
                // Never trust a database filename as a filesystem path.
                let parsed = Uuid::parse_str(&image.id).map_err(ApiError::internal)?;
                let path = directory.join(format!("{parsed}.image"));
                let file = std::fs::File::open(path).map_err(ApiError::internal)?;
                if file.metadata()?.len() != image.byte_length as u64
                    || image.byte_length > crate::config::MAX_BODY as i64
                {
                    return Err(ApiError::internal("image length mismatch"));
                }
                use std::io::Read;
                let mut bytes = Vec::new();
                file.take(crate::config::MAX_BODY as u64 + 1)
                    .read_to_end(&mut bytes)?;
                if bytes.len() as i64 != image.byte_length {
                    return Err(ApiError::internal("image length changed"));
                }
                Ok((image, bytes))
            })
            .await
    }
}
fn name_check(value: &str) -> Result<()> {
    name(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn writer_uses_full_synchronous_wal() {
        let directory = tempfile::tempdir().unwrap();
        let db = Database::open(directory.path()).unwrap();
        let settings = db
            .writer
            .call(|connection| {
                Ok((
                    connection
                        .pragma_query_value(None, "synchronous", |row| row.get::<_, i64>(0))?,
                    connection
                        .pragma_query_value(None, "journal_mode", |row| row.get::<_, String>(0))?,
                ))
            })
            .await
            .unwrap();
        assert_eq!(settings, (2, "wal".to_owned()));
    }
}
