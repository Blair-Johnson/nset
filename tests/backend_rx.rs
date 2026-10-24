use axum::{
    Router,
    body::Body,
    http::{Request, StatusCode},
};
use http_body_util::BodyExt;
use nset::{AppState, api, auth::Token, rx::Source};
use rusqlite::Connection;
use serde_json::{Value, json};
use std::{
    io::{BufRead, BufReader, Write},
    path::PathBuf,
    process::{Command, Stdio},
};
use tower::ServiceExt;

struct Fixture {
    _dir: tempfile::TempDir,
    repo: PathBuf,
    path: PathBuf,
    app: Router,
    source_id: String,
}
impl Fixture {
    fn new() -> Self {
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
        let db = Connection::open(&path).unwrap();
        db.execute_batch("PRAGMA user_version=8; CREATE TABLE runs(id INTEGER PRIMARY KEY,run_uid TEXT UNIQUE,state TEXT,alias TEXT,config TEXT,created_at TEXT,started_at TEXT,finished_at TEXT,exit_code INTEGER,argv TEXT); CREATE TABLE events(run_id INTEGER,seq INTEGER,received_at TEXT,data TEXT,UNIQUE(run_id,seq)); INSERT INTO runs VALUES(859,'u859','succeeded',NULL,'summary','2026-10-12T00:00:00Z',NULL,NULL,0,'[]'); INSERT INTO events VALUES(859,5,'2026-10-12T00:00:00Z','{\"kind\":\"epoch\",\"epoch\":1,\"loss\":0.5}');").unwrap();
        drop(db);
        let source = Source::resolve(&repo).unwrap();
        let source_id = source.id.clone();
        let mut state = AppState::open(
            &dir.path().join("native"),
            Token::new("test-secret").unwrap(),
        )
        .unwrap();
        state.rx = Some(source);
        Self {
            _dir: dir,
            repo,
            path,
            app: api::router(state),
            source_id,
        }
    }
    async fn request(
        &self,
        method: &str,
        path: &str,
        body: Value,
        auth: bool,
    ) -> (StatusCode, Value) {
        let mut request = Request::builder()
            .method(method)
            .uri(path)
            .header("content-type", "application/json");
        if auth {
            request = request.header("authorization", "Bearer test-secret");
        }
        let response = self
            .app
            .clone()
            .oneshot(request.body(Body::from(body.to_string())).unwrap())
            .await
            .unwrap();
        let status = response.status();
        let value =
            serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes())
                .unwrap();
        (status, value)
    }
    fn query(&self) -> Value {
        json!({"source_id":self.source_id,"runs":["u859"],"x":"epoch","ys":["loss"],"filters":{"conditions":[{"path":"kind","op":"eq","value":"epoch"}]}})
    }
}
#[tokio::test]
async fn rx_routes_require_auth_validate_bounds_and_leave_native_catalog_available() {
    let f = Fixture::new();
    for path in ["/api/rx/fields", "/api/rx/plot", "/api/rx/records"] {
        assert_eq!(
            f.request("POST", path, f.query(), false).await.0,
            StatusCode::UNAUTHORIZED
        );
    }
    assert_eq!(
        f.request("GET", "/api/rx/catalog", Value::Null, false)
            .await
            .0,
        StatusCode::UNAUTHORIZED
    );
    let before = std::fs::read(&f.path).unwrap();
    let (status, result) = f.request("POST", "/api/rx/plot", f.query(), true).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(result["traces"][0]["points"], json!([[1.0, 0.5, 5]]));
    let mut query = f.query();
    query["path"] = json!("/etc/passwd");
    assert!(
        f.request("POST", "/api/rx/plot", query, true)
            .await
            .0
            .is_client_error()
    );
    let mut query = f.query();
    query["runs"] = json!(vec!["u859"; 33]);
    assert_eq!(
        f.request("POST", "/api/rx/records", query, true).await.0,
        StatusCode::BAD_REQUEST
    );
    let mut query = f.query();
    query["prefix"] = json!("x".repeat(40_000));
    assert_eq!(
        f.request("POST", "/api/rx/fields", query, true).await.0,
        StatusCode::PAYLOAD_TOO_LARGE
    );
    assert_eq!(before, std::fs::read(&f.path).unwrap());
    let (status, catalog) = f.request("GET", "/api/catalog", Value::Null, true).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(catalog["rx_enabled"], true);
    assert_eq!(catalog["runs"], json!([]));
    Connection::open(&f.path)
        .unwrap()
        .pragma_update(None, "user_version", 7)
        .unwrap();
    let (_, rx) = f.request("GET", "/api/rx/catalog", Value::Null, true).await;
    assert!(rx["error"].as_str().unwrap().contains("does not migrate"));
    assert_eq!(
        f.request("GET", "/api/catalog", Value::Null, true).await.0,
        StatusCode::OK
    );
}
#[tokio::test]
async fn git_common_directory_keeps_source_identity_across_worktrees() {
    let f = Fixture::new();
    assert!(
        Command::new("git")
            .arg("-C")
            .arg(&f.repo)
            .args([
                "-c",
                "user.name=test",
                "-c",
                "user.email=test@example.invalid",
                "commit",
                "--allow-empty",
                "-qm",
                "fixture"
            ])
            .status()
            .unwrap()
            .success()
    );
    let worktree = f._dir.path().join("linked");
    assert!(
        Command::new("git")
            .arg("-C")
            .arg(&f.repo)
            .args(["worktree", "add", "--detach", "-q"])
            .arg(&worktree)
            .status()
            .unwrap()
            .success()
    );
    assert_eq!(Source::resolve(&worktree).unwrap().id, f.source_id);
}

#[tokio::test]
async fn separate_process_wal_writer_and_readonly_sidecars() {
    let f = Fixture::new();
    // Only this synthetic temp database is writable. The source reader runs in a
    // separate process from the writer, so it cannot reuse writable shm mappings.
    let script = r#"import sqlite3,sys
c=sqlite3.connect(sys.argv[1]); c.execute('PRAGMA journal_mode=WAL'); c.execute('PRAGMA wal_autocheckpoint=0')
c.execute('INSERT INTO events VALUES(859,6,?,?)',('now','{"kind":"epoch","epoch":2,"loss":0.4}')); c.commit()
print('ready',flush=True)
for line in sys.stdin:
 if line.strip()=='write':
  c.execute('INSERT INTO events VALUES(859,7,?,?)',('now','{"kind":"epoch","epoch":3,"loss":0.3}')); c.commit(); print('committed',flush=True)
 else: break
c.close()
"#;
    let child = Command::new("python3")
        .arg("-c")
        .arg(script)
        .arg(&f.path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    struct Child(std::process::Child);
    impl Drop for Child {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
    let mut child = Child(child);
    let mut stdout = BufReader::new(child.0.stdout.take().unwrap());
    let mut line = String::new();
    stdout.read_line(&mut line).unwrap();
    assert_eq!(line.trim(), "ready");
    let wal = PathBuf::from(format!("{}-wal", f.path.display()));
    let shm = PathBuf::from(format!("{}-shm", f.path.display()));
    let files = [&f.path, &wal, &shm];
    let before = files.map(|p| std::fs::read(p).unwrap());
    let (status, result) = f.request("POST", "/api/rx/plot", f.query(), true).await;
    assert_eq!(status, StatusCode::OK, "{result}");
    assert_eq!(result["diagnostics"]["matched"], 2);
    assert_eq!(before, files.map(|p| std::fs::read(p).unwrap()));
    writeln!(child.0.stdin.as_mut().unwrap(), "write").unwrap();
    line.clear();
    stdout.read_line(&mut line).unwrap();
    assert_eq!(line.trim(), "committed");
    let (status, result) = f.request("POST", "/api/rx/plot", f.query(), true).await;
    assert_eq!(status, StatusCode::OK, "{result}");
    assert_eq!(result["diagnostics"]["matched"], 3);
    writeln!(child.0.stdin.as_mut().unwrap(), "quit").unwrap();
    child.0.wait().unwrap();
    // A read-only final connection may leave producer-owned sidecars behind.
    // The fixture owner checkpoints and removes its own sidecars, then verifies
    // the source reader refuses to recreate either one.
    let owner = Connection::open(&f.path).unwrap();
    owner
        .execute_batch("PRAGMA wal_checkpoint(TRUNCATE)")
        .unwrap();
    drop(owner);
    for path in [&wal, &shm] {
        if path.exists() {
            std::fs::remove_file(path).unwrap();
        }
    }
    let (status, result) = f.request("POST", "/api/rx/plot", f.query(), true).await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "{result}");
    assert!(!wal.exists());
    assert!(!shm.exists());
}
