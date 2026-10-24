use nset::db::{Database, SCHEMA_VERSION};
use rusqlite::Connection;

fn version(connection: &Connection) -> i64 {
    connection
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .unwrap()
}

fn schema(connection: &Connection) -> Vec<(String, Option<String>)> {
    connection
        .prepare("SELECT name, sql FROM sqlite_schema ORDER BY name")
        .unwrap()
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap()
}

#[test]
fn fresh_database_is_version_three() {
    let directory = tempfile::tempdir().unwrap();
    let _db = Database::open(directory.path()).unwrap();
    let connection = Connection::open(directory.path().join("nset.sqlite3")).unwrap();
    assert_eq!(SCHEMA_VERSION, 3);
    assert_eq!(version(&connection), SCHEMA_VERSION);
    for table in [
        "experiments",
        "runs",
        "metrics",
        "images",
        "ingest_receipts",
        "compat_kv",
        "compat_sequences",
        "compat_batches",
    ] {
        assert!(schema(&connection).iter().any(|(name, _)| name == table));
    }
}

#[test]
fn future_schema_is_rejected_without_mutating_database_or_directory() {
    for future in [SCHEMA_VERSION + 1, i32::MAX as i64] {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("nset.sqlite3");
        let connection = Connection::open(&path).unwrap();
        connection
            .execute_batch(
                "CREATE TABLE future_data(value TEXT); INSERT INTO future_data VALUES('keep me');",
            )
            .unwrap();
        connection
            .pragma_update(None, "user_version", future)
            .unwrap();
        let original_schema = schema(&connection);
        connection.close().unwrap();
        let original_bytes = std::fs::read(&path).unwrap();

        assert!(Database::open(directory.path()).is_err());
        assert_eq!(std::fs::read(&path).unwrap(), original_bytes);
        // No images directory, WAL, SHM or journal may be created on rejection.
        let entries: Vec<_> = std::fs::read_dir(directory.path())
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect();
        assert_eq!(entries, [std::ffi::OsString::from("nset.sqlite3")]);
        let connection = Connection::open(&path).unwrap();
        assert_eq!(version(&connection), future);
        assert_eq!(schema(&connection), original_schema);
        assert_eq!(
            connection
                .query_row("SELECT value FROM future_data", [], |row| row
                    .get::<_, String>(0))
                .unwrap(),
            "keep me"
        );
        assert_eq!(
            connection
                .pragma_query_value(None, "journal_mode", |row| row.get::<_, String>(0))
                .unwrap(),
            "delete"
        );
    }
}

#[tokio::test]
async fn original_unversioned_schema_is_adopted_without_losing_data() {
    let directory = tempfile::tempdir().unwrap();
    let db = Database::open(directory.path()).unwrap();
    let (experiment, _) = db
        .create_experiment("legacy experiment".to_owned())
        .await
        .unwrap();
    let connection = Connection::open(directory.path().join("nset.sqlite3")).unwrap();
    connection
        .execute_batch("DROP TABLE ingest_receipts; DROP TABLE compat_kv; DROP TABLE compat_sequences; DROP TABLE compat_batches;")
        .unwrap();
    connection.pragma_update(None, "user_version", 0).unwrap();
    let original_schema = schema(&connection);

    let reopened = Database::open(directory.path()).unwrap();
    assert_eq!(version(&connection), SCHEMA_VERSION);
    let adopted = schema(&connection);
    assert!(original_schema.iter().all(|item| adopted.contains(item)));
    assert!(adopted.iter().any(|(name, _)| name == "ingest_receipts"));
    let experiments = reopened.experiments().await.unwrap();
    assert_eq!(experiments.len(), 1);
    assert_eq!(experiments[0].id, experiment.id);
    assert_eq!(experiments[0].name, "legacy experiment");
}

#[tokio::test]
async fn current_version_preserves_schema_and_data_without_rerunning_ddl() {
    let directory = tempfile::tempdir().unwrap();
    let db = Database::open(directory.path()).unwrap();
    let (experiment, _) = db
        .create_experiment("existing experiment".to_owned())
        .await
        .unwrap();
    let connection = Connection::open(directory.path().join("nset.sqlite3")).unwrap();
    // This optional index's absence proves startup does not rerun CREATE INDEX.
    connection.execute_batch("DROP INDEX metrics_stream; CREATE TABLE extension_data(value TEXT); INSERT INTO extension_data VALUES('preserved');").unwrap();
    let original_schema = schema(&connection);

    let reopened = Database::open(directory.path()).unwrap();
    assert_eq!(version(&connection), SCHEMA_VERSION);
    assert_eq!(schema(&connection), original_schema);
    assert_eq!(reopened.experiments().await.unwrap()[0].id, experiment.id);
    assert_eq!(
        connection
            .query_row("SELECT value FROM extension_data", [], |row| row
                .get::<_, String>(0))
            .unwrap(),
        "preserved"
    );
}

#[tokio::test]
async fn version_one_migrates_receipts_without_recreating_legacy_objects() {
    let directory = tempfile::tempdir().unwrap();
    let db = Database::open(directory.path()).unwrap();
    let (experiment, _) = db.create_experiment("v1 experiment".into()).await.unwrap();
    let run = db
        .create_run(nset::models::NewRun {
            experiment_id: experiment.id.clone(),
            name: "legacy run".into(),
            params: Default::default(),
            tags: Default::default(),
        })
        .await
        .unwrap();
    db.insert_metrics(
        run.id.clone(),
        nset::models::MetricBatch {
            metrics: vec![nset::models::MetricInput {
                key: "loss".into(),
                step: 7,
                timestamp: Some(1234),
                value: 0.25,
            }],
        },
    )
    .await
    .unwrap();
    let conn = Connection::open(directory.path().join("nset.sqlite3")).unwrap();
    conn.execute_batch(
        "DROP TABLE ingest_receipts; DROP TABLE compat_kv; DROP TABLE compat_sequences; DROP TABLE compat_batches; DROP INDEX metrics_stream; PRAGMA user_version=1;",
    )
    .unwrap();
    let original = schema(&conn);
    let reopened = Database::open(directory.path()).unwrap();
    assert_eq!(version(&conn), SCHEMA_VERSION);
    let upgraded = schema(&conn);
    assert!(original.iter().all(|item| upgraded.contains(item)));
    assert!(!upgraded.iter().any(|(name, _)| name == "metrics_stream"));
    assert!(upgraded.iter().any(|(name, _)| name == "ingest_receipts"));
    assert_eq!(reopened.experiments().await.unwrap()[0].id, experiment.id);
    let page = reopened
        .metrics(
            run.id,
            nset::models::MetricQuery {
                key: "loss".into(),
                after: None,
                snapshot: None,
                limit: None,
            },
        )
        .await
        .unwrap();
    assert_eq!(page.points.len(), 1);
    assert_eq!(page.points[0].seq, 1);
    assert_eq!(
        (
            page.points[0].step,
            page.points[0].timestamp,
            page.points[0].value
        ),
        (7, 1234, 0.25)
    );
}

#[test]
fn incompatible_known_schemas_are_rejected_before_persistent_changes() {
    let source = tempfile::tempdir().unwrap();
    let _db = Database::open(source.path()).unwrap();
    let original = Connection::open(source.path().join("nset.sqlite3")).unwrap();
    original
        .execute_batch(
            "INSERT INTO experiments VALUES('exp','existing',1);
        INSERT INTO runs VALUES('run','exp','existing','running','{}','{}',1,1);",
        )
        .unwrap();
    for (claimed_version, damage) in [
        (2, "DROP TABLE ingest_receipts;"),
        (1, "DROP TABLE ingest_receipts; DROP TABLE metrics;"),
        (
            2,
            "DROP TABLE metrics; CREATE VIEW metrics AS SELECT 1 AS seq,'run' AS run_id,'loss' AS key,1 AS step,1 AS timestamp,1.0 AS value;",
        ),
        (2, "ALTER TABLE runs DROP COLUMN tags;"),
        (
            2,
            "DROP TABLE ingest_receipts; CREATE TABLE ingest_receipts(run_id TEXT,batch_id TEXT,digest BLOB,accepted INTEGER,accepted_at INTEGER,PRIMARY KEY(batch_id));",
        ),
        (
            2,
            "DROP TABLE ingest_receipts; CREATE TABLE ingest_receipts(run_id TEXT,batch_id TEXT,digest BLOB,accepted INTEGER,accepted_at INTEGER,UNIQUE(run_id,batch_id));",
        ),
        (
            2,
            "DROP TABLE metrics; CREATE TABLE metrics(seq INTEGER NOT NULL DEFAULT 1,run_id TEXT,key TEXT,step INTEGER,timestamp INTEGER,value REAL);",
        ),
    ] {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("nset.sqlite3");
        // A standalone copy of a real query DB, with an existing run and no
        // actor connections or WAL sidecars in the rejection fixture.
        original
            .execute("VACUUM INTO ?", [path.to_str().unwrap()])
            .unwrap();
        let conn = Connection::open(&path).unwrap();
        conn.pragma_update(None, "journal_mode", "DELETE").unwrap();
        conn.execute_batch(damage).unwrap();
        conn.pragma_update(None, "user_version", claimed_version)
            .unwrap();
        let before_schema = schema(&conn);
        conn.close().unwrap();
        let before_bytes = std::fs::read(&path).unwrap();
        assert!(
            Database::open(directory.path()).is_err(),
            "accepted v{claimed_version}: {damage}"
        );
        assert_eq!(std::fs::read(&path).unwrap(), before_bytes);
        assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 1);
        let conn = Connection::open(&path).unwrap();
        assert_eq!(version(&conn), claimed_version);
        assert_eq!(schema(&conn), before_schema);
        assert_eq!(
            conn.pragma_query_value(None, "journal_mode", |row| row.get::<_, String>(0))
                .unwrap(),
            "delete"
        );
        assert_eq!(
            conn.query_row("SELECT name FROM runs WHERE id='run'", [], |row| row
                .get::<_, String>(0))
                .unwrap(),
            "existing"
        );
    }
}
#[test]
fn failed_version_one_upgrade_preserves_schema_and_version() {
    let directory = tempfile::tempdir().unwrap();
    let db = Database::open(directory.path()).unwrap();
    let conn = Connection::open(directory.path().join("nset.sqlite3")).unwrap();
    // An unexpected conflicting table must not silently be accepted as v2.
    conn.execute_batch("PRAGMA user_version=1;").unwrap();
    let original = schema(&conn);
    assert!(Database::open(directory.path()).is_err());
    assert_eq!(version(&conn), 1);
    assert_eq!(schema(&conn), original);
    drop(db);
}

#[test]
fn failed_initialization_rolls_back_schema_and_version_together() {
    let directory = tempfile::tempdir().unwrap();
    let connection = Connection::open(directory.path().join("nset.sqlite3")).unwrap();
    // The initial runs index cannot be created against this incompatible table.
    connection
        .execute_batch("CREATE TABLE runs(id TEXT PRIMARY KEY);")
        .unwrap();
    let original_schema = schema(&connection);
    assert!(Database::open(directory.path()).is_err());
    assert_eq!(version(&connection), 0);
    assert_eq!(schema(&connection), original_schema);
    assert!(!directory.path().join("images").exists());
}

#[cfg(unix)]
#[test]
fn binary_exits_successfully_on_sigterm() {
    use std::{
        process::{Child, Command, Stdio},
        time::{Duration, Instant},
    };
    struct Server(Child);
    impl Drop for Server {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
    let directory = tempfile::tempdir().unwrap();
    let log_path = directory.path().join("server.log");
    let log = std::fs::File::create(&log_path).unwrap();
    let mut server = Server(
        Command::new(env!("CARGO_BIN_EXE_nset"))
            .args([
                "serve",
                "--host",
                "127.0.0.1",
                "--port",
                "0",
                "--token",
                "shutdown-test-secret",
                "--db-path",
            ])
            .arg(directory.path().join("data"))
            .args(["--log-level", "info"])
            .stdout(Stdio::from(log.try_clone().unwrap()))
            .stderr(Stdio::from(log))
            .spawn()
            .unwrap(),
    );
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        assert!(
            server.0.try_wait().unwrap().is_none(),
            "server exited before readiness"
        );
        if std::fs::read_to_string(&log_path)
            .unwrap()
            .contains("server listening")
        {
            break;
        }
        assert!(Instant::now() < deadline, "server did not become ready");
        std::thread::sleep(Duration::from_millis(10));
    }
    assert!(
        Command::new("kill")
            .args(["-TERM", &server.0.id().to_string()])
            .status()
            .unwrap()
            .success()
    );
    loop {
        if let Some(status) = server.0.try_wait().unwrap() {
            assert!(
                status.success(),
                "SIGTERM did not shut down gracefully: {status}"
            );
            break;
        }
        assert!(Instant::now() < deadline, "server did not shut down");
        std::thread::sleep(Duration::from_millis(10));
    }
    assert!(
        !std::fs::read_to_string(&log_path)
            .unwrap()
            .contains("shutdown-test-secret")
    );
}

#[tokio::test]
async fn version_two_adds_compatibility_without_recreating_native_objects() {
    let directory = tempfile::tempdir().unwrap();
    let db = Database::open(directory.path()).unwrap();
    let (experiment, _) = db.create_experiment("version two".into()).await.unwrap();
    let connection = Connection::open(directory.path().join("nset.sqlite3")).unwrap();
    connection.execute_batch("DROP TABLE compat_kv; DROP TABLE compat_sequences; DROP TABLE compat_batches; DROP INDEX metrics_stream; PRAGMA user_version=2;").unwrap();
    let original = schema(&connection);
    let reopened = Database::open(directory.path()).unwrap();
    assert_eq!(version(&connection), SCHEMA_VERSION);
    let upgraded = schema(&connection);
    assert!(original.iter().all(|item| upgraded.contains(item)));
    assert!(!upgraded.iter().any(|(name, _)| name == "metrics_stream"));
    assert!(upgraded.iter().any(|(name, _)| name == "compat_kv"));
    assert_eq!(reopened.experiments().await.unwrap()[0].id, experiment.id);
}
