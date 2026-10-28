//! SQLite never runs on an async executor. One writer and configurable read-only actors,
//! each with a bounded queue, own their connections for their entire lifetime.
use crate::{
    errors::{ApiError, Result},
    live::{Change, Live},
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

pub const SCHEMA_VERSION: i64 = 4;

type Job = Box<dyn FnOnce(&mut Connection) + Send + 'static>;
#[derive(Clone)]
struct Actor(Arc<ActorInner>);
struct ActorInner {
    sender: Option<mpsc::Sender<Job>>,
    thread: Option<std::thread::JoinHandle<()>>,
}
impl Drop for ActorInner {
    fn drop(&mut self) {
        // Closing intake drains already accepted work. Do not release database
        // ownership while a cancelled caller's job still owns a connection.
        self.sender.take();
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}
impl Actor {
    fn start(mut connection: Connection, name: &str, queue_capacity: usize) -> Result<Self> {
        let (tx, mut rx) = mpsc::channel::<Job>(queue_capacity);
        let thread = std::thread::Builder::new()
            .name(name.to_owned())
            .spawn(move || {
                while let Some(job) = rx.blocking_recv() {
                    job(&mut connection);
                }
            })?;
        Ok(Self(Arc::new(ActorInner {
            sender: Some(tx),
            thread: Some(thread),
        })))
    }
    async fn call<T: Send + 'static>(
        &self,
        work: impl FnOnce(&mut Connection) -> Result<T> + Send + 'static,
    ) -> Result<T> {
        let (tx, rx) = oneshot::channel();
        // Reject excess work instead of retaining unbounded request bodies in waiters.
        self.0
            .sender
            .as_ref()
            .expect("actor intake exists until final drop")
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
    live: Live,
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

// Read-only compatibility checks: optional performance indexes and extension
// objects are deliberately ignored. Required writable columns and identity keys
// cannot be inferred from user_version or a successfully prepared SELECT.
pub(crate) fn require_table(
    connection: &Connection,
    table: &str,
    columns: &str,
    primary_key: &[&str],
    integer_rowid: bool,
) -> Result<()> {
    let invalid = || ApiError::internal(format!("incompatible schema for table {table}"));
    let rowid: Option<bool> = connection
        .query_row(
            "SELECT wr=0 FROM pragma_table_list WHERE schema='main' AND name=? AND type='table'",
            [table],
            |row| row.get(0),
        )
        .optional()?;
    if rowid.is_none() || (integer_rowid && rowid != Some(true)) {
        return Err(invalid());
    }
    let info = connection
        .prepare("SELECT name,type,pk,hidden FROM pragma_table_xinfo(?, 'main')")?
        .query_map([table], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, i64>(3)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    if columns.split(',').any(|column| {
        !info
            .iter()
            .any(|(name, _, _, hidden)| name == column && *hidden == 0)
    }) {
        return Err(invalid());
    }
    let mut keys: Vec<_> = info.iter().filter(|(_, _, pk, _)| *pk != 0).collect();
    keys.sort_by_key(|(_, _, pk, _)| *pk);
    if keys
        .iter()
        .map(|(name, _, _, _)| name.as_str())
        .collect::<Vec<_>>()
        != primary_key
    {
        return Err(invalid());
    }
    if integer_rowid {
        // INTEGER PRIMARY KEY DESC has a separate PK index, not a rowid alias.
        let has_pk_index: bool = connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM pragma_index_list(?, 'main') WHERE origin='pk')",
            [table],
            |row| row.get(0),
        )?;
        if keys.len() != 1 || !keys[0].1.eq_ignore_ascii_case("INTEGER") || has_pk_index {
            return Err(invalid());
        }
    }
    Ok(())
}

pub(crate) fn require_unique(connection: &Connection, table: &str, columns: &[&str]) -> Result<()> {
    let indexes = connection
        .prepare("SELECT name FROM pragma_index_list(?, 'main') WHERE \"unique\"=1 AND partial=0")?
        .query_map([table], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    for index in indexes {
        let keys = connection
            .prepare("SELECT name,coll FROM pragma_index_xinfo(?, 'main') WHERE key=1")?
            .query_map([index], |row| {
                Ok((row.get::<_, Option<String>>(0)?, row.get::<_, String>(1)?))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        if keys.len() == columns.len()
            && columns.iter().all(|column| {
                keys.iter().any(|(name, coll)| {
                    name.as_deref() == Some(*column) && coll.eq_ignore_ascii_case("BINARY")
                })
            })
        {
            return Ok(());
        }
    }
    Err(ApiError::internal(format!(
        "missing identity key for table {table}"
    )))
}

fn preflight_schema(connection: &Connection) -> Result<i64> {
    let version = schema_version(connection)?;
    if version > 0 {
        for (table, columns, primary_key, integer_rowid) in [
            ("experiments", "id,name,created_at", "id", false),
            ("runs", RUN_COLUMNS, "id", false),
            (
                "metrics",
                "seq,run_id,key,step,timestamp,value",
                "seq",
                true,
            ),
            (
                "images",
                "id,run_id,key,step,timestamp,content_type,byte_length,filename",
                "id",
                false,
            ),
        ] {
            require_table(connection, table, columns, &[primary_key], integer_rowid)?;
        }
        require_unique(connection, "experiments", &["name"])?;
        require_unique(connection, "images", &["filename"])?;
    }
    if version >= 2 {
        require_table(
            connection,
            "ingest_receipts",
            "run_id,batch_id,digest,accepted,accepted_at",
            &["run_id", "batch_id"],
            false,
        )?;
        require_unique(connection, "ingest_receipts", &["run_id", "batch_id"])?;
    }
    if version >= 3 {
        for (table, columns, keys) in [
            (
                "compat_kv",
                "namespace,key,value",
                &["namespace", "key"][..],
            ),
            ("compat_sequences", "namespace,value", &["namespace"][..]),
            (
                "compat_batches",
                "run_id,batch_id,scheme,digest",
                &["run_id", "batch_id"][..],
            ),
        ] {
            require_table(connection, table, columns, keys, false)?;
            require_unique(connection, table, keys)?;
        }
    }
    if version >= 4 {
        require_table(
            connection,
            "views",
            "id,name,experiment_id,revision,updated_at,workspace",
            &["id"],
            false,
        )?;
        require_unique(connection, "views", &["id"])?;
    } else {
        // CREATE TABLE shares its case-insensitive namespace with tables, views
        // and indexes. Reject migration collisions before persistent PRAGMAs;
        // rolling back the later DDL would not undo a journal-mode change.
        let collision: bool = connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM main.sqlite_schema WHERE name = 'views' COLLATE NOCASE AND type IN ('table','view','index'))",
            [],
            |row| row.get(0),
        )?;
        if collision {
            return Err(ApiError::internal(
                "schema migration destination views already exists",
            ));
        }
    }
    Ok(version)
}

fn initialize_schema(connection: &mut Connection) -> Result<()> {
    let tx = connection.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    // Recheck under the write lock. Version zero also covers the original,
    // unversioned schema: IF NOT EXISTS preserves its tables, indexes and data.
    let version = preflight_schema(&tx)?;
    if version == 0 {
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
    }
    if version < 2 {
        tx.execute_batch(
            "CREATE TABLE ingest_receipts(
            run_id TEXT NOT NULL REFERENCES runs(id), batch_id TEXT NOT NULL,
            digest BLOB NOT NULL, accepted INTEGER NOT NULL, accepted_at INTEGER NOT NULL,
            PRIMARY KEY(run_id,batch_id));",
        )?;
    }
    if version < 3 {
        tx.execute_batch(
            "CREATE TABLE compat_kv(
                namespace TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL,
                PRIMARY KEY(namespace,key));
             CREATE TABLE compat_sequences(
                namespace TEXT NOT NULL PRIMARY KEY,
                value INTEGER NOT NULL CHECK(value >= 0 AND value < 9223372036854775807));
             CREATE TABLE compat_batches(
                run_id TEXT NOT NULL REFERENCES runs(id), batch_id TEXT NOT NULL,
                scheme TEXT NOT NULL, digest BLOB NOT NULL CHECK(length(digest)=32),
                PRIMARY KEY(run_id,batch_id));",
        )?;
    }
    if version < 4 {
        // A view can refer to rx/synthetic sources: deliberately no experiment FK.
        tx.execute_batch(
            "CREATE TABLE views(
                id TEXT NOT NULL PRIMARY KEY,
                name TEXT NOT NULL, experiment_id TEXT NOT NULL,
                revision INTEGER NOT NULL CHECK(revision BETWEEN 1 AND 9007199254740991),
                updated_at INTEGER NOT NULL CHECK(updated_at BETWEEN 0 AND 9007199254740991),
                workspace TEXT NOT NULL);",
        )?;
    }
    if version < SCHEMA_VERSION {
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

// Caller owns the transaction; compatibility mappings commit with this insert.
fn insert_run(connection: &Connection, input: NewRun) -> Result<Run> {
    if connection
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
    connection.execute(
        "INSERT INTO runs(id,experiment_id,name,status,params,tags,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)",
        params![run.id, run.experiment_id, run.name, run.status,
            serde_json::to_string(&run.params).map_err(ApiError::internal)?,
            serde_json::to_string(&run.tags).map_err(ApiError::internal)?,
            run.created_at, run.updated_at],
    )?;
    Ok(run)
}

fn compat_value(
    connection: &Connection,
    namespace: &str,
    key: &str,
) -> Result<Option<serde_json::Value>> {
    let raw: Option<String> = connection
        .query_row(
            "SELECT value FROM compat_kv WHERE namespace=? AND key=?",
            params![namespace, key],
            |row| row.get(0),
        )
        .optional()?;
    raw.map(|raw| serde_json::from_str(&raw).map_err(ApiError::internal))
        .transpose()
}
impl Database {
    pub fn open(directory: &Path) -> Result<Self> {
        let defaults = crate::config::ConcurrencyOptions::default();
        Self::open_with_options(directory, defaults.read_workers, defaults.db_queue_capacity)
    }

    pub fn open_with_options(
        directory: &Path,
        read_workers: usize,
        queue_capacity: usize,
    ) -> Result<Self> {
        crate::config::validate_database_options(read_workers, queue_capacity)?;
        std::fs::create_dir_all(directory)?;
        let path = directory.join("nset.sqlite3");
        let mut connection = Connection::open(&path)?;
        // Reject unsupported versions and incompatible known schemas before
        // any persistent PRAGMA, DDL, or image directory creation.
        preflight_schema(&connection)?;
        setup(&connection)?;
        connection.pragma_update(None, "journal_mode", "WAL")?;
        connection.pragma_update(None, "synchronous", "FULL")?;
        initialize_schema(&mut connection)?;
        let images = directory.join("images");
        std::fs::create_dir_all(&images)?;
        let writer = Actor::start(connection, "nset-sqlite-writer", queue_capacity)?;
        let mut readers = Vec::new();
        for i in 0..read_workers {
            let connection =
                Connection::open_with_flags(&path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)?;
            setup(&connection)?;
            readers.push(Actor::start(
                connection,
                &format!("nset-sqlite-reader-{i}"),
                queue_capacity,
            )?);
        }
        Ok(Self {
            writer,
            readers: Arc::new(readers),
            next_reader: Arc::new(AtomicUsize::new(0)),
            images: Arc::new(images),
            live: Live::new(),
        })
    }
    /// Configured queue capacities: the single writer, then each read-only actor.
    /// Counts exclude executing jobs and do not change as queues fill or drain.
    pub fn queue_capacities(&self) -> (usize, Vec<usize>) {
        (
            self.writer.0.sender.as_ref().unwrap().max_capacity(),
            self.readers
                .iter()
                .map(|reader| reader.0.sender.as_ref().unwrap().max_capacity())
                .collect(),
        )
    }

    /// Shared process-local feed, also available to external-source invalidators.
    pub fn live(&self) -> Live {
        self.live.clone()
    }

    fn reader(&self) -> &Actor {
        &self.readers[self.next_reader.fetch_add(1, Ordering::Relaxed) % self.readers.len()]
    }
    pub(crate) async fn create_view(
        &self,
        mut workspace: serde_json::Value,
    ) -> Result<serde_json::Value> {
        crate::views::validate_workspace(&workspace)?;
        self.writer.call(move |conn| {
            let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
            let id = format!("server:{}", Uuid::new_v4());
            let time = now();
            workspace["id"] = serde_json::json!(id);
            workspace["updatedAt"] = serde_json::json!(time);
            // Validate server-assigned metadata with the same workspace contract.
            crate::views::validate_workspace(&workspace)?;
            let raw = serde_json::to_string(&workspace).map_err(ApiError::internal)?;
            tx.execute("INSERT INTO views(id,name,experiment_id,revision,updated_at,workspace) VALUES(?,?,?,1,?,?)",
                params![id, workspace["name"].as_str().unwrap(), workspace["experimentId"].as_str().unwrap(), time, raw])?;
            tx.commit()?;
            Ok(serde_json::json!({"id": id, "revision": 1, "workspace": workspace}))
        }).await
    }

    pub(crate) async fn views(&self) -> Result<Vec<serde_json::Value>> {
        self.reader().call(|conn| {
            // Return the entire saved-view collection; never silently hide rows with LIMIT.
            Ok(conn.prepare("SELECT id,name,experiment_id,revision,updated_at FROM views ORDER BY updated_at DESC,id")?
                .query_map([], |row| Ok(serde_json::json!({
                    "id": row.get::<_, String>(0)?, "name": row.get::<_, String>(1)?,
                    "experimentId": row.get::<_, String>(2)?, "revision": row.get::<_, i64>(3)?,
                    "updatedAt": row.get::<_, i64>(4)?
                })))?.collect::<rusqlite::Result<Vec<_>>>()?)
        }).await
    }

    pub(crate) async fn view(
        &self,
        id: String,
        revision: Option<i64>,
    ) -> Result<Option<serde_json::Value>> {
        self.reader().call(move |conn| {
            // One SQLite snapshot, without fetching/deserializing the blob for unchanged polls.
            let row: Option<(i64, Option<String>)> = conn.query_row(
                "SELECT revision,CASE WHEN revision=? THEN NULL ELSE workspace END FROM views WHERE id=?",
                params![revision, id], |row| Ok((row.get(0)?, row.get(1)?))).optional()?;
            let (revision, raw) = row.ok_or_else(ApiError::missing)?;
            raw.map(|raw| {
                let workspace: serde_json::Value = serde_json::from_str(&raw).map_err(ApiError::internal)?;
                Ok(serde_json::json!({"id": id, "revision": revision, "workspace": workspace}))
            }).transpose()
        }).await
    }

    pub(crate) async fn update_view(
        &self,
        id: String,
        revision: i64,
        mut workspace: serde_json::Value,
    ) -> Result<serde_json::Value> {
        crate::views::validate_workspace(&workspace)?;
        if workspace["id"].as_str() != Some(id.as_str()) {
            return Err(ApiError::bad("workspace id must match view id"));
        }
        self.writer.call(move |conn| {
            let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
            let current: i64 = tx.query_row("SELECT revision FROM views WHERE id=?", [&id], |row| row.get(0)).optional()?.ok_or_else(ApiError::missing)?;
            if current != revision || current >= MAX_SAFE {
                return Err(ApiError(axum::http::StatusCode::CONFLICT, "view revision conflict"));
            }
            let time = now();
            workspace["updatedAt"] = serde_json::json!(time);
            crate::views::validate_workspace(&workspace)?;
            let raw = serde_json::to_string(&workspace).map_err(ApiError::internal)?;
            let next = current + 1;
            let changed = tx.execute("UPDATE views SET name=?,experiment_id=?,revision=?,updated_at=?,workspace=? WHERE id=? AND revision=?",
                params![workspace["name"].as_str().unwrap(), workspace["experimentId"].as_str().unwrap(), next, time, raw, id, revision])?;
            if changed != 1 {
                return Err(ApiError(axum::http::StatusCode::CONFLICT, "view revision conflict"));
            }
            tx.commit()?;
            Ok(serde_json::json!({"id": id, "revision": next, "workspace": workspace}))
        }).await
    }
    // Typed compatibility operations retain actor queue bounds and FULL/WAL durability.
    pub(crate) async fn compat_get(
        &self,
        namespace: String,
        key: String,
    ) -> Result<Option<serde_json::Value>> {
        self.reader()
            .call(move |conn| compat_value(conn, &namespace, &key))
            .await
    }

    pub(crate) async fn compat_put_many(
        &self,
        namespace: String,
        values: Vec<(String, serde_json::Value)>,
    ) -> Result<()> {
        // Serialize everything before any writes; a failure cannot leave a partial mapping.
        let values = values
            .into_iter()
            .map(|(key, value)| {
                serde_json::to_string(&value)
                    .map(|value| (key, value))
                    .map_err(ApiError::internal)
            })
            .collect::<Result<Vec<_>>>()?;
        if values.is_empty() {
            return Ok(());
        }
        self.writer.call(move |conn| {
            let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
            {
                let mut statement = tx.prepare("INSERT INTO compat_kv(namespace,key,value) VALUES(?,?,?) ON CONFLICT(namespace,key) DO UPDATE SET value=excluded.value")?;
                for (key, value) in values {
                    statement.execute(params![namespace, key, value])?;
                }
            }
            tx.commit()?;
            Ok(())
        }).await
    }

    pub(crate) async fn compat_delete(&self, namespace: String, key: String) -> Result<()> {
        self.writer
            .call(move |conn| {
                conn.execute(
                    "DELETE FROM compat_kv WHERE namespace=? AND key=?",
                    params![namespace, key],
                )?;
                Ok(())
            })
            .await
    }

    pub(crate) async fn compat_items(
        &self,
        namespace: String,
    ) -> Result<Vec<(String, serde_json::Value)>> {
        self.reader()
            .call(move |conn| {
                let mut statement =
                    conn.prepare("SELECT key,value FROM compat_kv WHERE namespace=? ORDER BY key")?;
                let rows = statement.query_map([namespace], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })?;
                rows.map(|row| {
                    let (key, raw) = row?;
                    Ok((key, serde_json::from_str(&raw).map_err(ApiError::internal)?))
                })
                .collect()
            })
            .await
    }

    pub(crate) async fn compat_next_id(&self, namespace: String, start: i64) -> Result<i64> {
        if !(0..i64::MAX).contains(&start) {
            return Err(ApiError::bad(
                "sequence start must be a nonnegative signed 64-bit integer below its maximum",
            ));
        }
        self.writer.call(move |conn| {
            let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
            let prior: Option<i64> = tx.query_row("SELECT value FROM compat_sequences WHERE namespace=?", [&namespace], |row| row.get(0)).optional()?;
            let value = match prior {
                Some(prior) => prior.checked_add(1).filter(|value| *value < i64::MAX)
                    .ok_or_else(|| ApiError::bad("sequence exhausted"))?.max(start),
                None => start,
            };
            tx.execute("INSERT INTO compat_sequences(namespace,value) VALUES(?,?) ON CONFLICT(namespace) DO UPDATE SET value=excluded.value", params![namespace, value])?;
            tx.commit()?;
            Ok(value)
        }).await
    }

    /// Bind the entire request before the first journal chunk. Never overwrite a binding.
    pub(crate) async fn compat_bind_batch(
        &self,
        run_id: String,
        batch_id: String,
        scheme: String,
        digest: Vec<u8>,
    ) -> Result<()> {
        if digest.len() != 32 {
            return Err(ApiError::bad("invalid compatibility digest"));
        }
        self.writer
            .call(move |conn| {
                let tx =
                    conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
                let prior: Option<(String, Vec<u8>)> = tx
                    .query_row(
                        "SELECT scheme,digest FROM compat_batches WHERE run_id=? AND batch_id=?",
                        params![run_id, batch_id],
                        |row| Ok((row.get(0)?, row.get(1)?)),
                    )
                    .optional()?;
                if let Some(prior) = prior {
                    if prior != (scheme, digest) {
                        return Err(ApiError(
                            axum::http::StatusCode::CONFLICT,
                            "batch id already binds different metrics or identity scheme",
                        ));
                    }
                    return Ok(());
                }
                require_run(&tx, &run_id)?;
                tx.execute(
                    "INSERT INTO compat_batches(run_id,batch_id,scheme,digest) VALUES(?,?,?,?)",
                    params![run_id, batch_id, scheme, digest],
                )?;
                tx.commit()?;
                Ok(())
            })
            .await
    }

    /// Idempotent native creation and protocol mapping are one SQLite transaction.
    pub(crate) async fn compat_create_run(
        &self,
        namespace: String,
        key: String,
        input: NewRun,
        mut metadata: serde_json::Value,
    ) -> Result<serde_json::Value> {
        let live = self.live();
        self.writer
            .call(move |conn| {
                let tx =
                    conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
                if let Some(prior) = compat_value(&tx, &namespace, &key)? {
                    return Ok(prior);
                }
                name_check(&input.name)?;
                object_keys(&input.params)?;
                object_keys(&input.tags)?;
                let object = metadata
                    .as_object_mut()
                    .ok_or_else(|| ApiError::bad("run metadata must be a JSON object"))?;
                let run = insert_run(&tx, input)?;
                object.insert("native_id".into(), serde_json::Value::String(run.id));
                let raw = serde_json::to_string(&metadata).map_err(ApiError::internal)?;
                tx.execute(
                    "INSERT INTO compat_kv(namespace,key,value) VALUES(?,?,?)",
                    params![namespace, key, raw],
                )?;
                tx.commit()?;
                live.publish(Change::Catalog);
                Ok(metadata)
            })
            .await
    }
    pub async fn catalog(&self) -> Result<Catalog> {
        self.reader()
            .call(|conn| {
                // One read-only actor and one snapshot for discovery across all experiments.
                let tx = conn.transaction()?;
                let experiments = tx
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
                    .collect::<rusqlite::Result<_>>()?;
                let runs = tx
                    .prepare(&format!(
                        "SELECT {RUN_COLUMNS} FROM runs ORDER BY created_at DESC,id DESC"
                    ))?
                    .query_map([], run_row)?
                    .collect::<rusqlite::Result<_>>()?;
                // Group using the existing stream indexes, then fetch only the last row
                // per series by primary key. No per-series SQL or full histories in memory.
                // Images have UUID ids, so their implicit rowid (not step/time/id) records
                // insertion order in the existing append-only table. Indexes include rowid.
                let series = tx
                    .prepare(
                        "WITH metric_summary AS (
                            SELECT run_id,key,COUNT(*) AS count,MAX(seq) AS last_id
                            FROM metrics GROUP BY run_id,key
                        ), image_summary AS (
                            SELECT run_id,key,COUNT(*) AS count,MAX(rowid) AS last_id
                            FROM images GROUP BY run_id,key
                        )
                        SELECT s.run_id,s.key,0 AS kind,s.count,m.step,m.timestamp,m.value
                        FROM metric_summary s JOIN metrics m ON m.seq=s.last_id
                        UNION ALL
                        SELECT s.run_id,s.key,1 AS kind,s.count,i.step,i.timestamp,NULL
                        FROM image_summary s JOIN images i ON i.rowid=s.last_id
                        ORDER BY 1,2,3",
                    )?
                    .query_map([], |row| {
                        Ok(CatalogSeries {
                            run_id: row.get(0)?,
                            key: row.get(1)?,
                            kind: if row.get::<_, i64>(2)? == 0 {
                                SeriesKind::Metric
                            } else {
                                SeriesKind::Image
                            },
                            count: row.get(3)?,
                            last_step: row.get(4)?,
                            last_timestamp: row.get(5)?,
                            last_value: row.get(6)?,
                        })
                    })?
                    .collect::<rusqlite::Result<_>>()?;
                let metric_seq =
                    tx.query_row("SELECT COALESCE(MAX(seq),0) FROM metrics", [], |row| {
                        row.get(0)
                    })?;
                tx.commit()?;
                Ok(Catalog {
                    metric_seq,
                    experiments,
                    runs,
                    series,
                })
            })
            .await
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
        let live = self.live();
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
                live.publish(Change::Catalog);
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
        let live = self.live();
        self.writer
            .call(move |conn| {
                let tx = conn.transaction()?;
                let run = insert_run(&tx, input)?;
                tx.commit()?;
                live.publish(Change::Catalog);
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
        let live = self.live();
        self.writer
            .call(move |conn| {
                let tx = conn.transaction()?;
                let mut run = get_run(&tx, &id)?;
                let prior = (run.status.clone(), run.params.clone(), run.tags.clone());
                if let Some(status) = patch.status {
                    run.status = status;
                }
                if let Some(params) = patch.params {
                    run.params.extend(params);
                }
                if let Some(tags) = patch.tags {
                    // Tags merge; a null value removes that tag.
                    for (key, value) in tags {
                        if value.is_null() {
                            run.tags.remove(&key);
                        } else {
                            run.tags.insert(key, value);
                        }
                    }
                }
                if prior == (run.status.clone(), run.params.clone(), run.tags.clone()) {
                    return Ok(run);
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
                live.publish(Change::Catalog);
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
        let live = self.live();
        self.writer
            .call(move |conn| {
                let tx = conn.transaction()?;
                require_run(&tx, &id)?;
                let count = batch.metrics.len();
                let time = now();
                let mut changes = std::collections::BTreeMap::new();
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
                        record_metric(&mut changes, tx.last_insert_rowid(), metric, time);
                    }
                }
                if count > 0 {
                    tx.execute("UPDATE runs SET updated_at=? WHERE id=?", params![time, id])?;
                }
                tx.commit()?;
                live.publish_batch(metric_changes(id, changes));
                Ok(count)
            })
            .await
    }
    /// The replay receipt and all observations commit together. Replaying a query
    /// commit whose journal completion was interrupted is therefore a no-op.
    pub(crate) async fn apply_ingest(
        &self,
        id: String,
        batch_id: String,
        digest: Vec<u8>,
        accepted_at: i64,
        batch: MetricBatch,
    ) -> Result<()> {
        fn storage_error(_: rusqlite::Error) -> ApiError {
            ApiError(
                axum::http::StatusCode::SERVICE_UNAVAILABLE,
                "materialization failed; pending data retained; retrying",
            )
        }
        crate::ingest::validate_batch(&batch)?;
        safe(accepted_at)?;
        let live = self.live();
        self.writer.call(move |conn| {
            let tx = conn.transaction().map_err(storage_error)?;
            let receipt: Option<(Vec<u8>, i64, i64)> = tx.query_row(
                "SELECT digest,accepted,accepted_at FROM ingest_receipts WHERE run_id=? AND batch_id=?",
                params![id, batch_id], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?)),
            ).optional().map_err(storage_error)?;
            if let Some((prior, count, time)) = receipt {
                if prior != digest || count != batch.metrics.len() as i64 || time != accepted_at {
                    return Err(ApiError(axum::http::StatusCode::CONFLICT, "ingest receipt conflict"));
                }
                return Ok(());
            }
            if tx.query_row("SELECT 1 FROM runs WHERE id=?", [&id], |_| Ok(())).optional().map_err(storage_error)?.is_none() {
                return Err(ApiError::missing());
            }
            tx.execute("INSERT INTO ingest_receipts(run_id,batch_id,digest,accepted,accepted_at) VALUES(?,?,?,?,?)",
                params![id,batch_id,digest,batch.metrics.len() as i64,accepted_at]).map_err(storage_error)?;
            let mut changes = std::collections::BTreeMap::new();
            {
                let mut insert = tx.prepare_cached(
                    "INSERT INTO metrics(run_id,key,step,timestamp,value) VALUES(?,?,?,?,?)").map_err(storage_error)?;
                for metric in batch.metrics {
                    insert.execute(params![id,metric.key,metric.step,metric.timestamp.unwrap_or(accepted_at),metric.value]).map_err(storage_error)?;
                    record_metric(&mut changes, tx.last_insert_rowid(), metric, accepted_at);
                }
            }
            tx.execute("UPDATE runs SET updated_at=MAX(updated_at,?) WHERE id=?", params![accepted_at,id]).map_err(storage_error)?;
            tx.commit().map_err(storage_error)?;
            live.publish_batch(metric_changes(id, changes));
            Ok(())
        }).await
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
    pub async fn metrics_tail(&self, query: MetricTailQuery) -> Result<MetricTailResponse> {
        if query.series.len() > 64 {
            return Err(ApiError::bad("at most 64 streams per request"));
        }
        let limit = query.limit.unwrap_or(1000);
        if !(1..=1000).contains(&limit) {
            return Err(ApiError::bad("limit must be 1..1000"));
        }
        let mut unique = std::collections::BTreeSet::new();
        for stream in &query.series {
            name_check(&stream.run_id)?;
            name_check(&stream.key)?;
            safe(stream.after)?;
            if let Some(snapshot) = stream.snapshot {
                safe(snapshot)?;
                if stream.after > snapshot {
                    return Err(ApiError::bad("after exceeds snapshot"));
                }
            }
            if !unique.insert((&stream.run_id, &stream.key)) {
                return Err(ApiError::bad("duplicate stream"));
            }
        }
        drop(unique);
        self.reader().call(move |conn| {
            let tx = conn.transaction()?;
            let mut series = Vec::with_capacity(query.series.len());
            for stream in query.series {
                require_run(&tx, &stream.run_id)?;
                let high: i64 = tx.query_row(
                    "SELECT COALESCE(MAX(seq),0) FROM metrics WHERE run_id=? AND key=?",
                    params![stream.run_id, stream.key], |row| row.get(0))?;
                let snapshot = stream.snapshot.unwrap_or(high);
                if snapshot > high { return Err(ApiError::bad("snapshot exceeds stream high-water mark")); }
                if stream.after > snapshot { return Err(ApiError::bad("after exceeds snapshot")); }
                let mut points: Vec<Metric> = tx.prepare_cached(
                    "SELECT seq,key,step,timestamp,value FROM metrics WHERE run_id=? AND key=? AND seq>? AND seq<=? ORDER BY seq LIMIT ?"
                )?.query_map(params![stream.run_id, stream.key, stream.after, snapshot, (limit + 1) as i64], |row| {
                    Ok(Metric { seq: row.get(0)?, key: row.get(1)?, step: row.get(2)?, timestamp: row.get(3)?, value: row.get(4)? })
                })?.collect::<rusqlite::Result<_>>()?;
                let more = points.len() > limit;
                if more { points.pop(); }
                let next_after = if more { points.last().map(|point| point.seq) } else { None };
                series.push(MetricTailPage { run_id: stream.run_id, key: stream.key, points, snapshot, next_after });
            }
            tx.commit()?;
            Ok(MetricTailResponse { series })
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
        let live = self.live();
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
                live.publish(Change::Image {
                    run_id: image.run_id.clone(),
                    key: image.key.clone(),
                });
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

    fn new_run(experiment_id: &str) -> NewRun {
        NewRun {
            experiment_id: experiment_id.into(),
            name: "compat run".into(),
            params: Object::new(),
            tags: Object::new(),
        }
    }

    #[tokio::test]
    async fn cancelled_accepted_metric_writer_still_publishes_after_commit() {
        use std::{
            future::Future,
            task::{Context, Poll, Waker},
        };
        let directory = tempfile::tempdir().unwrap();
        let db = Database::open(directory.path()).unwrap();
        let (experiment, _) = db.create_experiment("cancel-live".into()).await.unwrap();
        let run = db.create_run(new_run(&experiment.id)).await.unwrap();
        let live = db.live();
        let cursor = live.cursor();
        let (entered_tx, entered_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let actor = db.writer.clone();
        let blocker = tokio::spawn(async move {
            actor
                .call(move |_| {
                    let _ = entered_tx.send(());
                    release_rx.recv().unwrap();
                    Ok(())
                })
                .await
                .unwrap();
        });
        entered_rx.await.unwrap();
        let batch = MetricBatch {
            metrics: vec![MetricInput {
                key: "x".into(),
                step: 0,
                timestamp: Some(0),
                value: 1.0,
            }],
        };
        let mut write = Box::pin(db.insert_metrics(run.id, batch));
        assert!(matches!(
            write.as_mut().poll(&mut Context::from_waker(Waker::noop())),
            Poll::Pending
        ));
        drop(write);
        assert_eq!(live.cursor(), cursor);
        release_tx.send(()).unwrap();
        blocker.await.unwrap();
        let response = tokio::time::timeout(Duration::from_secs(3), live.poll(cursor))
            .await
            .unwrap()
            .unwrap();
        assert!(matches!(
            response.changes[0],
            Change::Metric {
                count: 1,
                high: 1,
                ..
            }
        ));
        assert_eq!(db.catalog().await.unwrap().metric_seq, 1);
    }

    #[tokio::test]
    async fn replayed_projection_and_compat_creation_publish_only_once() {
        let directory = tempfile::tempdir().unwrap();
        let db = Database::open(directory.path()).unwrap();
        let (experiment, _) = db.create_experiment("live-replay".into()).await.unwrap();
        let live = db.live();
        let before = live.cursor();
        let metadata = db
            .compat_create_run(
                "test".into(),
                "one".into(),
                new_run(&experiment.id),
                serde_json::json!({}),
            )
            .await
            .unwrap();
        let first = live.poll(before).await.unwrap();
        assert_eq!(first.changes.len(), 1);
        assert!(matches!(first.changes[0], Change::Catalog));
        let cursor = live.cursor();
        db.compat_create_run(
            "test".into(),
            "one".into(),
            new_run(&experiment.id),
            serde_json::json!({}),
        )
        .await
        .unwrap();
        assert_eq!(cursor, live.cursor());
        let run = metadata["native_id"].as_str().unwrap().to_string();
        let batch = MetricBatch {
            metrics: vec![MetricInput {
                key: "x".into(),
                step: 0,
                timestamp: Some(1),
                value: 1.0,
            }],
        };
        db.apply_ingest(run.clone(), "batch".into(), vec![1], 2, batch.clone())
            .await
            .unwrap();
        let first = live.poll(cursor).await.unwrap();
        assert_eq!(first.changes.len(), 1);
        assert!(matches!(
            first.changes[0],
            Change::Metric {
                count: 1,
                high: 1,
                ..
            }
        ));
        let cursor = live.cursor();
        db.apply_ingest(run.clone(), "batch".into(), vec![1], 2, batch.clone())
            .await
            .unwrap();
        assert_eq!(cursor, live.cursor());
        assert!(
            db.apply_ingest(run, "batch".into(), vec![2], 2, batch)
                .await
                .is_err()
        );
        assert_eq!(cursor, live.cursor());
    }

    #[tokio::test]
    async fn compatibility_metadata_preserves_finite_float_bits() {
        let directory = tempfile::tempdir().unwrap();
        let db = Database::open(directory.path()).unwrap();
        let mut values = vec![
            -0.0,
            0.0,
            f64::MAX,
            f64::MIN,
            f64::MIN_POSITIVE,
            f64::from_bits(1),
        ];
        let mut bits = 1_u64;
        for _ in 0..1024 {
            bits = bits.wrapping_mul(6364136223846793005).wrapping_add(1);
            let value = f64::from_bits(bits);
            if value.is_finite() {
                values.push(value);
            }
        }
        // Pending protocol payloads are persisted before ingest. Decoding them
        // after a restart must not silently change the bound native f64 identity.
        db.compat_put_many(
            "pending".into(),
            vec![("floats".into(), serde_json::json!(values))],
        )
        .await
        .unwrap();
        let decoded = db
            .compat_get("pending".into(), "floats".into())
            .await
            .unwrap()
            .unwrap();
        let decoded: Vec<_> = decoded
            .as_array()
            .unwrap()
            .iter()
            .map(|value| value.as_f64().unwrap().to_bits())
            .collect();
        assert_eq!(
            decoded,
            values.into_iter().map(f64::to_bits).collect::<Vec<_>>()
        );
    }

    #[tokio::test]
    async fn compatibility_metadata_upserts_are_atomic() {
        let directory = tempfile::tempdir().unwrap();
        let db = Database::open(directory.path()).unwrap();
        db.compat_put_many("test".into(), vec![("first".into(), serde_json::json!(1))])
            .await
            .unwrap();
        db.writer.call(|conn| {
            conn.execute_batch("CREATE TRIGGER reject_compat BEFORE INSERT ON compat_kv WHEN NEW.key='reject' BEGIN SELECT RAISE(ABORT,'test rejection'); END;")?;
            Ok(())
        }).await.unwrap();
        assert!(
            db.compat_put_many(
                "test".into(),
                vec![
                    ("first".into(), serde_json::json!(2)),
                    ("reject".into(), serde_json::json!(3)),
                ]
            )
            .await
            .is_err()
        );
        assert_eq!(
            db.compat_items("test".into()).await.unwrap(),
            vec![("first".into(), serde_json::json!(1))]
        );
        db.compat_delete("test".into(), "first".into())
            .await
            .unwrap();
        assert_eq!(
            db.compat_get("test".into(), "first".into()).await.unwrap(),
            None
        );
    }

    #[tokio::test]
    async fn compatibility_run_mapping_is_atomic_and_idempotent() {
        let directory = tempfile::tempdir().unwrap();
        let db = Database::open(directory.path()).unwrap();
        let (experiment, _) = db.create_experiment("compat".into()).await.unwrap();
        db.writer.call(|conn| {
            conn.execute_batch("CREATE TRIGGER reject_mapping BEFORE INSERT ON compat_kv WHEN NEW.key='reject' BEGIN SELECT RAISE(ABORT,'test rejection'); END;")?;
            Ok(())
        }).await.unwrap();
        assert!(
            db.compat_create_run(
                "runs".into(),
                "reject".into(),
                new_run(&experiment.id),
                serde_json::json!({})
            )
            .await
            .is_err()
        );
        assert!(db.runs(None).await.unwrap().is_empty());
        assert_eq!(
            db.compat_get("runs".into(), "reject".into()).await.unwrap(),
            None
        );
        let metadata = db
            .compat_create_run(
                "runs".into(),
                "run".into(),
                new_run(&experiment.id),
                serde_json::json!({"native_id":"untrusted","name":"original"}),
            )
            .await
            .unwrap();
        let native_id = metadata["native_id"].as_str().unwrap();
        assert_ne!(native_id, "untrusted");
        assert_eq!(db.run(native_id.into()).await.unwrap().name, "compat run");
        // Existing mappings are returned unchanged even when new inputs are invalid.
        let retry = db
            .compat_create_run(
                "runs".into(),
                "run".into(),
                new_run("missing"),
                serde_json::Value::Null,
            )
            .await
            .unwrap();
        assert_eq!(retry, metadata);
        assert_eq!(db.runs(None).await.unwrap().len(), 1);
        drop(db);
        let reopened = Database::open(directory.path()).unwrap();
        assert_eq!(
            reopened
                .compat_get("runs".into(), "run".into())
                .await
                .unwrap(),
            Some(metadata)
        );
    }

    #[tokio::test]
    async fn compatibility_sequences_are_monotonic_and_bounded() {
        let directory = tempfile::tempdir().unwrap();
        let db = Database::open(directory.path()).unwrap();
        assert_eq!(db.compat_next_id("ids".into(), 5).await.unwrap(), 5);
        assert_eq!(db.compat_next_id("ids".into(), 1).await.unwrap(), 6);
        assert_eq!(db.compat_next_id("ids".into(), 10).await.unwrap(), 10);
        let mut tasks = Vec::new();
        for _ in 0..16 {
            let db = db.clone();
            tasks.push(tokio::spawn(async move {
                db.compat_next_id("ids".into(), 0).await.unwrap()
            }));
        }
        let mut ids = Vec::new();
        for task in tasks {
            ids.push(task.await.unwrap());
        }
        ids.sort_unstable();
        assert_eq!(ids, (11..27).collect::<Vec<_>>());
        assert!(db.compat_next_id("negative".into(), -1).await.is_err());
        assert!(db.compat_next_id("max".into(), i64::MAX).await.is_err());
        assert_eq!(
            db.compat_next_id("last".into(), i64::MAX - 1)
                .await
                .unwrap(),
            i64::MAX - 1
        );
        assert!(db.compat_next_id("last".into(), 0).await.is_err());
    }

    #[tokio::test]
    async fn compatibility_batch_identity_survives_reopen_and_rejects_rebinding() {
        let directory = tempfile::tempdir().unwrap();
        let db = Database::open(directory.path()).unwrap();
        let (experiment, _) = db.create_experiment("compat".into()).await.unwrap();
        let run = db.create_run(new_run(&experiment.id)).await.unwrap();
        db.compat_bind_batch(run.id.clone(), "batch".into(), "v1".into(), vec![1; 32])
            .await
            .unwrap();
        drop(db);
        let db = Database::open(directory.path()).unwrap();
        db.compat_bind_batch(run.id.clone(), "batch".into(), "v1".into(), vec![1; 32])
            .await
            .unwrap();
        let error = db
            .compat_bind_batch(run.id.clone(), "batch".into(), "v1".into(), vec![2; 32])
            .await
            .unwrap_err();
        assert_eq!(error.0, axum::http::StatusCode::CONFLICT);
        let error = db
            .compat_bind_batch(run.id, "batch".into(), "v2".into(), vec![1; 32])
            .await
            .unwrap_err();
        assert_eq!(error.0, axum::http::StatusCode::CONFLICT);
    }
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
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn final_actor_drop_drains_cancelled_jobs_before_releasing_ownership() {
        use fs2::FileExt;
        let directory = tempfile::tempdir().unwrap();
        let lock_path = directory.path().join("nset.lock");
        let owner = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(&lock_path)
            .unwrap();
        owner.try_lock_exclusive().unwrap();
        let contender = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(&lock_path)
            .unwrap();
        let actor = Actor::start(Connection::open_in_memory().unwrap(), "drain-test", 2).unwrap();
        let (entered_tx, entered_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let caller_actor = actor.clone();
        let caller = tokio::spawn(async move {
            caller_actor
                .call(move |_| {
                    let _ = entered_tx.send(());
                    release_rx.recv().unwrap();
                    Ok(())
                })
                .await
        });
        entered_rx.await.unwrap();
        caller.abort();
        let _ = caller.await;
        let (finished_tx, finished_rx) = std::sync::mpsc::channel();
        let dropping = std::thread::spawn(move || {
            drop(actor);
            drop(owner);
            finished_tx.send(()).unwrap();
        });
        assert!(finished_rx.recv_timeout(Duration::from_millis(30)).is_err());
        assert!(contender.try_lock_exclusive().is_err());
        release_tx.send(()).unwrap();
        finished_rx.recv_timeout(Duration::from_secs(2)).unwrap();
        dropping.join().unwrap();
        contender.try_lock_exclusive().unwrap();
    }
}

// Collect only one last observation and count per affected key within this transaction.
fn record_metric(
    changes: &mut std::collections::BTreeMap<String, (usize, Metric)>,
    seq: i64,
    input: MetricInput,
    time: i64,
) {
    let point = Metric {
        seq,
        key: input.key.clone(),
        step: input.step,
        timestamp: input.timestamp.unwrap_or(time),
        value: if input.value == 0.0 { 0.0 } else { input.value },
    };
    let entry = changes
        .entry(input.key)
        .or_insert_with(|| (0, point.clone()));
    entry.0 += 1;
    entry.1 = point;
}
fn metric_changes(
    run_id: String,
    changes: std::collections::BTreeMap<String, (usize, Metric)>,
) -> Vec<Change> {
    changes
        .into_iter()
        .map(|(key, (count, last))| Change::Metric {
            run_id: run_id.clone(),
            key,
            high: last.seq,
            count,
            last,
        })
        .collect()
}
