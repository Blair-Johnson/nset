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
    assert_eq!(result["traces"][0]["points"], json!([[1.0, 0.5, "5"]]));
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
async fn separate_process_wal_writer_close_reopen_and_no_reader_written_frames() {
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
    // SHM reader marks/index initialization are allowed; DB/WAL data is not.
    let files = [&f.path, &wal];
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
    // Last writer close may checkpoint/clean up its own sidecars. The reader
    // must work both now and when the producer later reopens and commits.
    let before = std::fs::read(&f.path).unwrap();
    let wal_before = std::fs::read(&wal).unwrap_or_default();
    let (status, result) = f.request("POST", "/api/rx/plot", f.query(), true).await;
    assert_eq!(status, StatusCode::OK, "{result}");
    assert_eq!(result["diagnostics"]["matched"], 3);
    assert_eq!(before, std::fs::read(&f.path).unwrap());
    assert_eq!(wal_before, std::fs::read(&wal).unwrap_or_default());
    let reopened = Command::new("python3").arg("-c").arg(r#"import sqlite3,sys
c=sqlite3.connect(sys.argv[1]); c.execute('INSERT INTO events VALUES(859,8,?,?)',('now','{"kind":"epoch","epoch":4,"loss":0.2}')); c.commit(); c.close()
"#).arg(&f.path).status().unwrap();
    assert!(reopened.success());
    let (status, result) = f.request("POST", "/api/rx/plot", f.query(), true).await;
    assert_eq!(status, StatusCode::OK, "{result}");
    assert_eq!(result["diagnostics"]["matched"], 4);
}

#[tokio::test]
async fn exact_integer_filters_and_decimal_string_catalog_page_boundaries() {
    let f = Fixture::new();
    let base = 9_007_199_254_740_992i64;
    let db = Connection::open(&f.path).unwrap();
    for offset in 0..=200i64 {
        let id = base + offset;
        db.execute(
            "INSERT INTO runs VALUES(?,?,'succeeded',NULL,NULL,'now',NULL,NULL,0,'[]')",
            rusqlite::params![id, format!("u{id}")],
        )
        .unwrap();
    }
    for offset in 0..=1i64 {
        let id = base + offset;
        db.execute(
            "INSERT INTO events VALUES(859,?,'now',?)",
            rusqlite::params![
                id,
                format!("{{\"kind\":\"epoch\",\"epoch\":1,\"loss\":0.5,\"id\":{id}}}")
            ],
        )
        .unwrap();
    }
    drop(db);
    let (status, first) = f
        .request(
            "GET",
            &format!("/api/rx/catalog?after={}", base - 1),
            Value::Null,
            true,
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(first["runs"].as_array().unwrap().len(), 200);
    assert_eq!(first["runs"][0]["id"], base.to_string());
    assert_eq!(first["runs"][1]["id"], (base + 1).to_string());
    assert_eq!(first["next_after"], (base + 199).to_string());
    let (status, next) = f
        .request(
            "GET",
            &format!(
                "/api/rx/catalog?after={}",
                first["next_after"].as_str().unwrap()
            ),
            Value::Null,
            true,
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(next["runs"][0]["id"], (base + 200).to_string());
    assert!(next["next_after"].is_null());
    for (op, count) in [
        ("gt", 1),
        ("gte", 2),
        ("lt", 0),
        ("lte", 1),
        ("eq", 1),
        ("ne", 1),
    ] {
        let mut query = f.query();
        query["filters"] = json!({"conditions":[{"path":"id","op":op,"value":base}]});
        let (status, result) = f.request("POST", "/api/rx/records", query, true).await;
        assert_eq!(status, StatusCode::OK, "{result}");
        // Missing fields do not match numeric comparisons.
        let expected = count;
        assert_eq!(
            result["records"].as_array().unwrap().len(),
            expected,
            "{op}: {result}"
        );
        if op == "gt" {
            assert_eq!(result["records"][0]["seq"], (base + 1).to_string());
            assert!(
                result["records"][0]["raw"]
                    .as_str()
                    .unwrap()
                    .contains("9007199254740993")
            );
        }
    }
    let mut query = f.query();
    query["filters"] = json!({"conditions":[{"path":"id","op":"eq","value":base+1}]});
    let (_, plot) = f.request("POST", "/api/rx/plot", query, true).await;
    assert_eq!(plot["traces"][0]["points"][0][2], (base + 1).to_string());
    let mut query = f.query();
    query["prefix"] = json!("id");
    let (_, fields) = f.request("POST", "/api/rx/fields", query, true).await;
    assert_eq!(fields["fields"][0]["values"], json!([]));
}

fn search_query(f: &Fixture, search: &str) -> Value {
    json!({"source_id":f.source_id,"runs":["u859"],"search":search,"limit":25})
}

fn field_paths(result: &Value) -> Vec<&str> {
    result["fields"]
        .as_array()
        .unwrap()
        .iter()
        .map(|hint| hint["path"].as_str().unwrap())
        .collect()
}

fn set_search_event(f: &Fixture, value: Value) {
    Connection::open(&f.path)
        .unwrap()
        .execute("UPDATE events SET data=?", [value.to_string()])
        .unwrap();
}

#[tokio::test]
async fn field_search_nested_scalars_arrays_literal_paths_and_prefix_compatibility() {
    let f = Fixture::new();
    set_search_event(
        &f,
        json!({
            "metrics":{"loss":0.3,"other":false}, "metrics.loss":7,
            "arr":[{"Loss":0.4},8], "loss_box":{"detail":3},
            "ordinary":"loss", "Loss_text":"x".repeat(257)
        }),
    );
    let before = std::fs::read(&f.path).unwrap();
    let (status, result) = f
        .request("POST", "/api/rx/fields", search_query(&f, "LoSs"), true)
        .await;
    assert_eq!(status, StatusCode::OK, "{result}");
    assert_eq!(
        field_paths(&result),
        vec![
            "$[\"metrics.loss\"]",
            "Loss_text",
            "arr[0].Loss",
            "loss_box",
            "loss_box.detail",
            "metrics.loss"
        ]
    );
    assert_eq!(result["fields"][0]["values"], json!([7]));
    assert_eq!(result["fields"][1]["values"], json!([]));
    assert_eq!(result["fields"][3]["types"], json!(["object"]));
    assert_eq!(result["fields"][3]["values"], json!([]));
    assert_eq!(result["fields"][5]["values"], json!([0.3]));
    assert_eq!(result["records"], json!([]));
    assert_eq!(result["traces"], json!([]));
    let (_, result) = f
        .request(
            "POST",
            "/api/rx/fields",
            search_query(&f, "$[\"metrics.loss\"]"),
            true,
        )
        .await;
    assert_eq!(field_paths(&result), vec!["$[\"metrics.loss\"]"]);
    let (_, result) = f
        .request("POST", "/api/rx/fields", search_query(&f, "ARR"), true)
        .await;
    assert_eq!(
        field_paths(&result),
        vec!["arr", "arr[0]", "arr[0].Loss", "arr[1]"]
    );
    assert_eq!(result["fields"][0]["types"], json!(["array"]));
    assert_eq!(result["fields"][0]["values"], json!([]));
    assert_eq!(result["fields"][3]["values"], json!([8]));

    let mut prefix = search_query(&f, "");
    prefix["prefix"] = json!("metrics.");
    let (_, with_empty_search) = f
        .request("POST", "/api/rx/fields", prefix.clone(), true)
        .await;
    prefix.as_object_mut().unwrap().remove("search");
    let (_, without_search) = f
        .request("POST", "/api/rx/fields", prefix.clone(), true)
        .await;
    assert_eq!(with_empty_search, without_search);
    assert_eq!(
        field_paths(&without_search),
        vec!["metrics.loss", "metrics.other"]
    );
    prefix["prefix"] = json!("metrics.L");
    let (_, result) = f
        .request("POST", "/api/rx/fields", prefix.clone(), true)
        .await;
    assert!(
        field_paths(&result).is_empty(),
        "prefix remains case-sensitive"
    );
    prefix["search"] = json!("LoSs");
    prefix["prefix"] = json!("invalid..prefix.");
    assert_eq!(
        f.request("POST", "/api/rx/fields", prefix, true).await.0,
        StatusCode::OK
    );
    assert_eq!(before, std::fs::read(&f.path).unwrap());

    set_search_event(&f, json!(["needle", {"Needle":true}]));
    let (_, result) = f
        .request("POST", "/api/rx/fields", search_query(&f, "needle"), true)
        .await;
    assert_eq!(field_paths(&result), vec!["$[1].Needle"]);
}

#[tokio::test]
async fn field_search_run_scope_cursor_scope_and_explicit_scan_more() {
    let f = Fixture::new();
    // Width exceeds the shared visit budget without exceeding the record cap.
    set_search_event(&f, json!({"wide":vec![0; 5000]}));
    let db = Connection::open(&f.path).unwrap();
    db.execute_batch("INSERT INTO runs VALUES(241,'u241','succeeded',NULL,NULL,'now',NULL,NULL,0,'[]'); INSERT INTO events VALUES(241,1,'now','{\"other_run_target\":2}'); INSERT INTO events VALUES(859,6,'now','{\"late_target\":1}');").unwrap();
    drop(db);
    let before = std::fs::read(&f.path).unwrap();
    let q = search_query(&f, "target");
    let (status, first) = f.request("POST", "/api/rx/fields", q.clone(), true).await;
    assert_eq!(status, StatusCode::OK, "{first}");
    assert!(field_paths(&first).is_empty());
    assert_eq!(first["diagnostics"]["scanned"], 1);
    assert_eq!(first["diagnostics"]["partial"], true);
    assert!(
        first["diagnostics"]["reasons"]
            .as_array()
            .unwrap()
            .contains(&json!("field visit budget reached"))
    );
    assert!(first["next_cursor"].is_string());
    let mut more = q.clone();
    more["cursor"] = first["next_cursor"].clone();
    let (status, second) = f
        .request("POST", "/api/rx/fields", more.clone(), true)
        .await;
    assert_eq!(status, StatusCode::OK, "{second}");
    assert_eq!(field_paths(&second), vec!["late_target"]);
    assert!(second["next_cursor"].is_null());
    for (key, value) in [
        ("search", json!("other")),
        ("runs", json!(["u241"])),
        ("source_id", json!("rx:other")),
        ("prefix", json!("different")),
        (
            "filters",
            json!({"conditions":[{"path":"x","op":"exists"}]}),
        ),
    ] {
        let mut invalid = more.clone();
        invalid[key] = value;
        assert_eq!(
            f.request("POST", "/api/rx/fields", invalid, true).await.0,
            StatusCode::BAD_REQUEST,
            "{key}"
        );
    }
    assert_eq!(
        f.request("POST", "/api/rx/records", more, true).await.0,
        StatusCode::BAD_REQUEST
    );
    let mut other_run = q;
    other_run["runs"] = json!(["u241"]);
    let (_, result) = f.request("POST", "/api/rx/fields", other_run, true).await;
    assert_eq!(field_paths(&result), vec!["other_run_target"]);
    assert_eq!(before, std::fs::read(&f.path).unwrap());

    // Exactly 4096 visits (the array plus its elements) must not consume
    // the following event before yielding its continuation cursor.
    Connection::open(&f.path)
        .unwrap()
        .execute(
            "UPDATE events SET data=? WHERE run_id=859 AND seq=5",
            [json!({"wide":vec![0; 4095]}).to_string()],
        )
        .unwrap();
    let mut query = search_query(&f, "target");
    let (_, first) = f
        .request("POST", "/api/rx/fields", query.clone(), true)
        .await;
    assert_eq!(first["diagnostics"]["scanned"], 1);
    assert!(first["next_cursor"].is_string());
    query["cursor"] = first["next_cursor"].clone();
    let (_, next) = f.request("POST", "/api/rx/fields", query, true).await;
    assert_eq!(field_paths(&next), vec!["late_target"]);
}

#[tokio::test]
async fn field_search_enforces_depth_path_suggestion_and_value_bounds() {
    let f = Fixture::new();
    let mut deep = json!({"hidden":true});
    for _ in 0..32 {
        deep = json!({"node":deep});
    }
    let mut fields: serde_json::Map<String, Value> = (0..100)
        .map(|i| (format!("target{i:03}"), json!(i)))
        .collect();
    fields.insert("deep".into(), deep);
    fields.insert(format!("target{}", "x".repeat(1024)), json!({"hidden":1}));
    fields.insert("path".into(), json!({"x".repeat(1018): {"target":1}}));
    set_search_event(&f, Value::Object(fields));
    let (status, result) = f
        .request("POST", "/api/rx/fields", search_query(&f, "target"), true)
        .await;
    assert_eq!(status, StatusCode::OK, "{result}");
    assert_eq!(field_paths(&result).len(), 25);
    assert_eq!(result["diagnostics"]["partial"], true);
    for reason in [
        "field depth limit reached",
        "oversized field paths skipped",
        "field suggestion limit reached",
    ] {
        assert!(
            result["diagnostics"]["reasons"]
                .as_array()
                .unwrap()
                .contains(&json!(reason)),
            "{result}"
        );
    }
    let mut query = search_query(&f, "target");
    query["limit"] = json!(100);
    let (_, result) = f.request("POST", "/api/rx/fields", query, true).await;
    assert_eq!(field_paths(&result).len(), 64);
    let (_, result) = f
        .request("POST", "/api/rx/fields", search_query(&f, "hidden"), true)
        .await;
    assert!(field_paths(&result).is_empty());
    let mut query = search_query(&f, "deep");
    query["limit"] = json!(100);
    let (_, result) = f.request("POST", "/api/rx/fields", query, true).await;
    assert_eq!(field_paths(&result).len(), 32);
    assert!(
        field_paths(&result)
            .iter()
            .all(|path| path.len() <= 1024 && path.split('.').count() <= 32)
    );
    assert_eq!(
        f.request(
            "POST",
            "/api/rx/fields",
            search_query(&f, &"x".repeat(1025)),
            true
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        f.request(
            "POST",
            "/api/rx/fields",
            search_query(&f, &"x".repeat(1024)),
            true
        )
        .await
        .0,
        StatusCode::OK
    );

    // Scalar examples keep the existing eight-value cap and precise-number policy.
    let db = Connection::open(&f.path).unwrap();
    db.execute("DELETE FROM events", []).unwrap();
    for seq in 1..=12 {
        db.execute(
            "INSERT INTO events VALUES(859,?,'now',?)",
            rusqlite::params![
                seq,
                json!({"target":seq,"target_big":9007199254740993u64}).to_string()
            ],
        )
        .unwrap();
    }
    drop(db);
    let (_, result) = f
        .request("POST", "/api/rx/fields", search_query(&f, "target"), true)
        .await;
    assert_eq!(result["fields"][0]["present"], 12);
    assert_eq!(result["fields"][0]["values"].as_array().unwrap().len(), 8);
    assert_eq!(result["fields"][1]["values"], json!([]));
}

#[tokio::test]
async fn field_search_reuses_scan_and_oversized_record_caps() {
    let f = Fixture::new();
    let mut db = Connection::open(&f.path).unwrap();
    let transaction = db.transaction().unwrap();
    transaction.execute("DELETE FROM events", []).unwrap();
    transaction
        .execute(
            "INSERT INTO events VALUES(859,1,'now',?)",
            [json!({"target":"x".repeat(256 * 1024)}).to_string()],
        )
        .unwrap();
    for seq in 2..=2001 {
        transaction
            .execute("INSERT INTO events VALUES(859,?,'now','{}')", [seq])
            .unwrap();
    }
    transaction
        .execute(
            "INSERT INTO events VALUES(859,2002,'now','{\"target\":1}')",
            [],
        )
        .unwrap();
    transaction.commit().unwrap();
    drop(db);
    let before = std::fs::read(&f.path).unwrap();
    let mut query = search_query(&f, "target");
    let (status, first) = f
        .request("POST", "/api/rx/fields", query.clone(), true)
        .await;
    assert_eq!(status, StatusCode::OK, "{first}");
    assert!(first["diagnostics"]["scanned"].as_u64().unwrap() <= 2000);
    assert_eq!(first["diagnostics"]["oversized"], 1);
    assert_eq!(first["diagnostics"]["partial"], true);
    assert!(field_paths(&first).is_empty());
    assert!(first["next_cursor"].is_string());
    query["cursor"] = first["next_cursor"].clone();
    let mut found = false;
    for _ in 0..10 {
        let (status, page) = f
            .request("POST", "/api/rx/fields", query.clone(), true)
            .await;
        assert_eq!(status, StatusCode::OK, "{page}");
        if field_paths(&page) == vec!["target"] {
            found = true;
            break;
        }
        assert!(page["next_cursor"].is_string(), "{page}");
        query["cursor"] = page["next_cursor"].clone();
    }
    assert!(
        found,
        "explicit scan-more must reach the later matching event"
    );
    assert_eq!(before, std::fs::read(&f.path).unwrap());
}
