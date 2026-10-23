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
fn fresh_database_is_version_one() {
    let directory = tempfile::tempdir().unwrap();
    let _db = Database::open(directory.path()).unwrap();
    let connection = Connection::open(directory.path().join("nset.sqlite3")).unwrap();
    assert_eq!(SCHEMA_VERSION, 1);
    assert_eq!(version(&connection), SCHEMA_VERSION);
    for table in ["experiments", "runs", "metrics", "images"] {
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
    connection.pragma_update(None, "user_version", 0).unwrap();
    let original_schema = schema(&connection);

    let reopened = Database::open(directory.path()).unwrap();
    assert_eq!(version(&connection), SCHEMA_VERSION);
    assert_eq!(schema(&connection), original_schema);
    let experiments = reopened.experiments().await.unwrap();
    assert_eq!(experiments.len(), 1);
    assert_eq!(experiments[0].id, experiment.id);
    assert_eq!(experiments[0].name, "legacy experiment");
}

#[tokio::test]
async fn version_one_preserves_schema_and_data_without_rerunning_ddl() {
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
                "--listen",
                "127.0.0.1:0",
                "--token",
                "shutdown-test-secret",
                "--data-dir",
            ])
            .arg(directory.path().join("data"))
            .env("RUST_LOG", "nset=info")
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
}
