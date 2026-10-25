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
    for path in [
        "/api/rx/fields",
        "/api/rx/plot",
        "/api/rx/records",
        "/api/rx/run-filter",
    ] {
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

#[tokio::test]
async fn field_search_exact_path_survives_hint_and_visit_caps() {
    let f = Fixture::new();
    let mut fields: serde_json::Map<String, Value> = (0..100)
        .map(|i| (format!("aaa_config{i:03}"), json!(i)))
        .collect();
    fields.insert("config".into(), json!({"data":true}));
    fields.insert("config_prefix".into(), json!(true));
    set_search_event(&f, Value::Object(fields));
    let mut q = search_query(&f, "config");
    q["limit"] = json!(2);
    let (_, result) = f.request("POST", "/api/rx/fields", q, true).await;
    assert!(field_paths(&result).contains(&"config"), "{result}");
    assert!(
        field_paths(&result).iter().all(|p| p.starts_with("config")),
        "{result}"
    );
    assert_eq!(result["diagnostics"]["partial"], true);
    let exact = result["fields"]
        .as_array()
        .unwrap()
        .iter()
        .find(|h| h["path"] == "config")
        .unwrap();
    assert_eq!(exact["present"], 1);

    set_search_event(&f, json!({"aaa":vec![0;5000],"config":{"data":true}}));
    let (_, result) = f
        .request("POST", "/api/rx/fields", search_query(&f, "config"), true)
        .await;
    assert!(field_paths(&result).contains(&"config"), "{result}");
    assert_eq!(result["diagnostics"]["partial"], true);
    let (_, result) = f
        .request(
            "POST",
            "/api/rx/fields",
            search_query(&f, "$[\"config\"][\"data\"]"),
            true,
        )
        .await;
    assert!(field_paths(&result).contains(&"config.data"), "{result}");
}

#[tokio::test]
async fn field_search_exact_identity_preserves_case_unicode_and_literal_paths() {
    let f = Fixture::new();
    set_search_event(
        &f,
        json!({
            "Config": 1, "config": {"data": 2}, "config.data": 3,
            "\u{65e5}\u{672c}": 4, "\u{65e5}\u{672c}\u{8a9e}": 5,
            "nested": {"\u{65e5}\u{672c}": 6}
        }),
    );
    for (query, expected) in [
        ("Config", "Config"),
        ("config.data", "config.data"),
        ("$[\"config.data\"]", "$[\"config.data\"]"),
        ("$[\"config\"][\"data\"]", "config.data"),
    ] {
        let mut q = search_query(&f, query);
        q["limit"] = json!(1);
        let (status, result) = f.request("POST", "/api/rx/fields", q, true).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(field_paths(&result), vec![expected]);
    }
    let mut q = search_query(&f, "\u{65e5}\u{672c}");
    q["limit"] = json!(2);
    let (_, result) = f.request("POST", "/api/rx/fields", q, true).await;
    assert_eq!(
        field_paths(&result),
        vec!["$[\"\u{65e5}\u{672c}\"]", "$[\"\u{65e5}\u{672c}\u{8a9e}\"]"]
    );
}

fn run_filter_query(f: &Fixture, conditions: Value) -> Value {
    json!({"source_id":f.source_id,"runs":["u859"],"conditions":conditions})
}

#[tokio::test]
async fn run_filter_matches_independent_events_and_exact_typed_paths_readonly() {
    let f = Fixture::new();
    let db = Connection::open(&f.path).unwrap();
    db.execute(
        "INSERT INTO events VALUES(859,6,'now',?)",
        [json!({
            "config":{"model":"wide","lr":0.01}, "metrics.loss":7,
            "nil":null,"disabled":false,"zero":0,"text":"007","label":"Hello World",
            "large":9007199254740993_u64
        })
        .to_string()],
    )
    .unwrap();
    db.execute(
        "INSERT INTO events VALUES(859,7,'now',?)",
        [json!({"metrics":{"loss":0.2}}).to_string()],
    )
    .unwrap();
    drop(db);
    let before = std::fs::read(&f.path).unwrap();
    let q = run_filter_query(
        &f,
        json!([
            {"path":"config.model","op":"eq","value":"wide"},
            {"path":"metrics.loss","op":"lt","value":0.3},
            {"path":"$[\"metrics.loss\"]","op":"eq","value":7},
            {"path":"metrics.loss","op":"eq","value":7},
            {"path":"nil","op":"exists"},
            {"path":"disabled","op":"exists"},
            {"path":"zero","op":"exists"},
            {"path":"nil","op":"eq","value":null},
            {"path":"text","op":"eq","value":7},
            {"path":"disabled","op":"eq","value":0},
            {"path":"text","op":"eq","value":"007"},
            {"path":"label","op":"contains","value":"World"},
            {"path":"label","op":"contains","value":"world"},
            {"path":"zero","op":"contains","value":"0"},
            {"path":"large","op":"eq","value":9007199254740992_u64},
            {"path":"large","op":"gt","value":9007199254740992_u64}
        ]),
    );
    let (status, result) = f.request("POST", "/api/rx/run-filter", q, true).await;
    assert_eq!(status, StatusCode::OK, "{result}");
    assert_eq!(
        result["runs"],
        json!([{"uid":"u859","conditions":[true,true,true,false,true,true,true,true,false,false,true,true,false,false,false,true]}])
    );
    assert_eq!(result["cursor"], Value::Null);
    assert_eq!(result["diagnostics"]["partial"], false);
    assert_eq!(result["diagnostics"]["scanned"], 3);
    assert_eq!(before, std::fs::read(&f.path).unwrap());
}

#[tokio::test]
async fn run_filter_negative_clauses_require_presence_or_complete_absence() {
    let f = Fixture::new();
    let db = Connection::open(&f.path).unwrap();
    db.execute_batch("INSERT INTO events VALUES(859,6,'now','{\"loss\":0.4,\"nil\":null,\"off\":false,\"zero\":0}'); INSERT INTO runs VALUES(860,'empty','succeeded',NULL,NULL,'now',NULL,NULL,0,'[]');").unwrap();
    let mut q = run_filter_query(
        &f,
        json!([
            {"path":"loss","op":"ne","value":0.5},
            {"path":"absent","op":"ne","value":1},
            {"path":"absent","op":"missing"},
            {"path":"nil","op":"missing"},
            {"path":"off","op":"missing"},
            {"path":"zero","op":"missing"},
            {"path":"loss","op":"gte","value":0.5},
            {"path":"loss","op":"lte","value":0.4},
            {"path":"nil","op":"ne","value":null}
        ]),
    );
    q["runs"] = json!(["u859", "empty"]);
    let (status, result) = f.request("POST", "/api/rx/run-filter", q, true).await;
    assert_eq!(status, StatusCode::OK, "{result}");
    assert_eq!(
        result["runs"][0]["conditions"],
        json!([true, false, true, false, false, false, true, true, false])
    );
    assert_eq!(
        result["runs"][1]["conditions"],
        json!([false, false, true, true, true, true, false, false, false])
    );
}

#[tokio::test]
async fn run_filter_unreadable_events_are_visible_errors_not_completed_unknowns() {
    for data in [
        rusqlite::types::Value::Text("{invalid".into()),
        rusqlite::types::Value::Null,
        rusqlite::types::Value::Blob(b"{\"ok\":true}".to_vec()),
        // Valid JSON beyond serde's nesting bound must also fail explicitly.
        rusqlite::types::Value::Text(format!("{}0{}", "[".repeat(256), "]".repeat(256))),
    ] {
        let f = Fixture::new();
        Connection::open(&f.path)
            .unwrap()
            .execute("INSERT INTO events VALUES(859,6,'now',?)", [data])
            .unwrap();
        let q = run_filter_query(
            &f,
            json!([
                {"path":"loss","op":"exists"},
                {"path":"absent","op":"missing"},
                {"path":"absent","op":"exists"}
            ]),
        );
        let (status, result) = f.request("POST", "/api/rx/run-filter", q, true).await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{result}");
        assert!(result["error"].as_str().unwrap().contains("JSON"));
        assert!(result.get("runs").is_none(), "{result}");
    }
}

#[tokio::test]
async fn run_filter_resource_limit_is_a_visible_error_not_a_skipped_event() {
    let f = Fixture::new();
    let data = json!({"padding":"x".repeat(64 * 1024 * 1024)}).to_string();
    Connection::open(&f.path)
        .unwrap()
        .execute("INSERT INTO events VALUES(859,6,'now',?)", [data])
        .unwrap();
    let q = run_filter_query(&f, json!([{"path":"absent","op":"missing"}]));
    let (status, result) = f.request("POST", "/api/rx/run-filter", q, true).await;
    assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE, "{result}");
    assert!(result["error"].as_str().unwrap().contains("64 MiB"));
    assert!(result.get("runs").is_none(), "{result}");
}

#[tokio::test]
async fn run_filter_all_witnesses_finish_early_including_missing_presence() {
    let f = Fixture::new();
    Connection::open(&f.path)
        .unwrap()
        .execute_batch(
            "INSERT INTO events VALUES(859,6,'now','{\"later\":true}');
         INSERT INTO events VALUES(859,7,'now','bad json');",
        )
        .unwrap();
    let q = run_filter_query(
        &f,
        json!([
            {"path":"loss","op":"eq","value":0.5},
            {"path":"loss","op":"missing"},
            {"path":"later","op":"exists"}
        ]),
    );
    let (status, result) = f.request("POST", "/api/rx/run-filter", q, true).await;
    assert_eq!(status, StatusCode::OK, "{result}");
    assert_eq!(result["runs"][0]["conditions"], json!([true, false, true]));
    assert!(result["cursor"].is_null());
    assert_eq!(result["diagnostics"]["partial"], false);
    assert_eq!(result["diagnostics"]["scanned"], 2);
}

#[tokio::test]
async fn run_filter_cursor_retains_proofs_pins_high_water_and_rejects_scope_tampering() {
    let f = Fixture::new();
    let db = Connection::open(&f.path).unwrap();
    db.execute_batch("WITH RECURSIVE n(x) AS (VALUES(6) UNION ALL SELECT x+1 FROM n WHERE x<20006) INSERT INTO events SELECT 859,x,'now','{\"kind\":\"config\"}' FROM n; INSERT INTO runs VALUES(860,'later','succeeded',NULL,NULL,'now',NULL,NULL,0,'[]'); INSERT INTO events VALUES(860,1,'now','{\"loss\":0.5}');").unwrap();
    let mut q = run_filter_query(
        &f,
        json!([
            {"path":"loss","op":"eq","value":0.5},
            {"path":"absent","op":"missing"},
            {"path":"absent","op":"exists"},
            {"path":"loss","op":"missing"}
        ]),
    );
    q["runs"] = json!(["u859", "later"]);
    let (status, first) = f
        .request("POST", "/api/rx/run-filter", q.clone(), true)
        .await;
    assert_eq!(status, StatusCode::OK, "{first}");
    assert_eq!(
        first["runs"][0]["conditions"],
        json!([true, null, null, false])
    );
    assert_eq!(
        first["runs"][1]["conditions"],
        json!([null, null, null, null])
    );
    assert!(first["cursor"].is_string(), "{first}");
    assert_eq!(first["diagnostics"]["partial"], true);
    q["cursor"] = first["cursor"].clone();
    let mut changed = q.clone();
    changed["conditions"][0]["value"] = json!(9);
    assert_eq!(
        f.request("POST", "/api/rx/run-filter", changed, true)
            .await
            .0,
        StatusCode::BAD_REQUEST
    );
    let mut changed = q.clone();
    changed["runs"] = json!(["later", "u859"]);
    assert_eq!(
        f.request("POST", "/api/rx/run-filter", changed, true)
            .await
            .0,
        StatusCode::BAD_REQUEST
    );
    let mut changed = q.clone();
    changed["cursor"] = json!(format!("{}x", first["cursor"].as_str().unwrap()));
    assert_eq!(
        f.request("POST", "/api/rx/run-filter", changed, true)
            .await
            .0,
        StatusCode::BAD_REQUEST
    );
    // New events are outside this cursor's fixed high-water scope.
    db.execute_batch("INSERT INTO events VALUES(859,20007,'now','{\"absent\":1}');")
        .unwrap();
    let mut final_page = Value::Null;
    for _ in 0..10 {
        let (status, page) = f
            .request("POST", "/api/rx/run-filter", q.clone(), true)
            .await;
        assert_eq!(status, StatusCode::OK, "{page}");
        assert_eq!(page["runs"][0]["conditions"][0], true);
        if page["cursor"].is_null() {
            final_page = page;
            break;
        }
        q["cursor"] = page["cursor"].clone();
    }
    assert_eq!(
        final_page["runs"][0]["conditions"],
        json!([true, true, false, false])
    );
    assert_eq!(
        final_page["runs"][1]["conditions"],
        json!([true, true, false, false])
    );
    assert_eq!(final_page["diagnostics"]["partial"], false);
    // A truncated high water is stale, even if the source path is unchanged.
    db.execute_batch("DELETE FROM events WHERE run_id=859 AND seq>=6;")
        .unwrap();
    assert_eq!(
        f.request("POST", "/api/rx/run-filter", q, true).await.0,
        StatusCode::BAD_REQUEST
    );
}

#[tokio::test]
async fn run_filter_validates_bounds_and_preserves_large_exact_identities() {
    let f = Fixture::new();
    let db = Connection::open(&f.path).unwrap();
    let uid = "9".repeat(128);
    db.execute(
        "INSERT INTO runs VALUES(9007199254740993,?,'succeeded',NULL,NULL,'now',NULL,NULL,0,'[]')",
        [&uid],
    )
    .unwrap();
    db.execute_batch(
        "INSERT INTO events VALUES(9007199254740993,9007199254740993,'now','{\"ok\":true}');",
    )
    .unwrap();
    let base = run_filter_query(&f, json!([{"path":"ok","op":"exists"}]));
    let mut q = base.clone();
    q["runs"] = json!([uid]);
    let (status, result) = f.request("POST", "/api/rx/run-filter", q, true).await;
    assert_eq!(status, StatusCode::OK, "{result}");
    assert_eq!(result["runs"], json!([{"uid":uid,"conditions":[true]}]));
    for runs in [
        json!([]),
        json!(["u859", "u859"]),
        json!(["x".repeat(129)]),
        json!([859]),
        json!(vec!["u859"; 33]),
        json!(["not-a-run"]),
    ] {
        let mut q = base.clone();
        q["runs"] = runs;
        assert!(
            f.request("POST", "/api/rx/run-filter", q, true)
                .await
                .0
                .is_client_error()
        );
    }
    for condition in [
        json!({"path":"ok","op":"wat"}),
        json!({"path":"ok","op":"contains","value":5}),
        json!({"path":"ok","op":"lt","value":"1"}),
        json!({"path":"ok","op":"eq","value":{}}),
        json!({"path":"ok..bad","op":"exists"}),
    ] {
        let mut q = base.clone();
        q["conditions"] = json!([condition]);
        assert_eq!(
            f.request("POST", "/api/rx/run-filter", q, true).await.0,
            StatusCode::BAD_REQUEST
        );
    }
    let mut q = base.clone();
    q["conditions"] = json!(vec![json!({"path":"ok","op":"exists"}); 17]);
    assert_eq!(
        f.request("POST", "/api/rx/run-filter", q, true).await.0,
        StatusCode::BAD_REQUEST
    );
    let mut q = base.clone();
    q["source_id"] = json!("wrong");
    assert_eq!(
        f.request("POST", "/api/rx/run-filter", q, true).await.0,
        StatusCode::BAD_REQUEST
    );
    let mut q = base.clone();
    q["unexpected"] = json!(true);
    assert!(
        f.request("POST", "/api/rx/run-filter", q, true)
            .await
            .0
            .is_client_error()
    );
    let mut q = base;
    q["conditions"][0]["path"] = json!("x".repeat(40_000));
    assert_eq!(
        f.request("POST", "/api/rx/run-filter", q, true).await.0,
        StatusCode::PAYLOAD_TOO_LARGE
    );
}

#[tokio::test]
async fn run_filter_byte_pages_scan_large_events_and_reject_replaced_source() {
    let f = Fixture::new();
    let mut db = Connection::open(&f.path).unwrap();
    let tx = db.transaction().unwrap();
    let data = json!({"padding":"x".repeat(300_000)}).to_string();
    for seq in 7..60 {
        tx.execute(
            "INSERT INTO events VALUES(859,?,'now',?)",
            rusqlite::params![seq, data],
        )
        .unwrap();
    }
    tx.commit().unwrap();
    let mut q = run_filter_query(
        &f,
        json!([
            {"path":"loss","op":"eq","value":0.5},
            {"path":"absent","op":"missing"},
            {"path":"absent","op":"exists"}
        ]),
    );
    let (status, first) = f
        .request("POST", "/api/rx/run-filter", q.clone(), true)
        .await;
    assert_eq!(status, StatusCode::OK, "{first}");
    assert!(first["cursor"].is_string(), "{first}");
    assert!(first["diagnostics"]["bytes"].as_u64().unwrap() <= 8 * 1024 * 1024);
    q["cursor"] = first["cursor"].clone();
    let mut final_page = Value::Null;
    for _ in 0..10 {
        let (status, page) = f
            .request("POST", "/api/rx/run-filter", q.clone(), true)
            .await;
        assert_eq!(status, StatusCode::OK, "{page}");
        if page["cursor"].is_null() {
            final_page = page;
            break;
        }
        q["cursor"] = page["cursor"].clone();
    }
    assert_eq!(
        final_page["runs"][0]["conditions"],
        json!([true, true, false])
    );
    assert_eq!(final_page["diagnostics"]["partial"], false);
    assert_eq!(final_page["diagnostics"]["oversized"], 0);
    drop(db);
    // Identical content at a different file identity must not reuse proofs.
    let replacement = f.path.with_extension("replacement");
    std::fs::copy(&f.path, &replacement).unwrap();
    std::fs::rename(replacement, &f.path).unwrap();
    assert_eq!(
        f.request("POST", "/api/rx/run-filter", q, true).await.0,
        StatusCode::BAD_REQUEST
    );
}

#[tokio::test]
async fn run_filter_batches_are_not_a_permanent_catalog_cap() {
    let f = Fixture::new();
    let mut db = Connection::open(&f.path).unwrap();
    let tx = db.transaction().unwrap();
    for id in 1..=40 {
        tx.execute(
            "INSERT INTO runs VALUES(?,?,'succeeded',NULL,NULL,'now',NULL,NULL,0,'[]')",
            rusqlite::params![id, format!("candidate-{id}")],
        )
        .unwrap();
        tx.execute("INSERT INTO events VALUES(?,1,'now','{\"ok\":true}')", [id])
            .unwrap();
    }
    tx.commit().unwrap();
    for (start, end) in [(1, 32), (33, 40)] {
        let mut q = run_filter_query(&f, json!([{"path":"ok","op":"exists"}]));
        let uids: Vec<_> = (start..=end).map(|id| format!("candidate-{id}")).collect();
        q["runs"] = json!(uids);
        let (status, result) = f.request("POST", "/api/rx/run-filter", q, true).await;
        assert_eq!(status, StatusCode::OK, "{result}");
        assert_eq!(result["runs"].as_array().unwrap().len(), uids.len());
        for (run, uid) in result["runs"].as_array().unwrap().iter().zip(&uids) {
            assert_eq!(run["uid"], *uid);
            assert_eq!(run["conditions"], json!([true]));
        }
    }
}

#[tokio::test]
async fn run_filter_cursorless_batches_identify_source_replacement_not_appends() {
    let f = Fixture::new();
    let q = run_filter_query(&f, json!([{"path":"new_metric","op":"missing"}]));
    let (status, first) = f
        .request("POST", "/api/rx/run-filter", q.clone(), true)
        .await;
    assert_eq!(status, StatusCode::OK, "{first}");
    assert!(first["cursor"].is_null());
    assert_eq!(first["runs"][0]["conditions"], json!([true]));
    assert!(!first["source_generation"].as_str().unwrap().is_empty());
    let db = Connection::open(&f.path).unwrap();
    db.execute_batch("INSERT INTO events VALUES(859,6,'now','{\"new_metric\":1}');")
        .unwrap();
    drop(db);
    let (_, appended) = f
        .request("POST", "/api/rx/run-filter", q.clone(), true)
        .await;
    assert_eq!(first["source_generation"], appended["source_generation"]);
    assert_eq!(appended["runs"][0]["conditions"], json!([false]));
    let replacement = f.path.with_extension("replacement");
    std::fs::copy(&f.path, &replacement).unwrap();
    std::fs::rename(replacement, &f.path).unwrap();
    let (status, replaced) = f.request("POST", "/api/rx/run-filter", q, true).await;
    assert_eq!(status, StatusCode::OK, "{replaced}");
    assert!(replaced["cursor"].is_null());
    assert_ne!(first["source_generation"], replaced["source_generation"]);
    assert_eq!(appended["runs"], replaced["runs"]); // Same UIDs/content, new generation.
}

#[tokio::test]
async fn run_filter_compares_live_high_water_exactly_above_js_integer_range() {
    let f = Fixture::new();
    let db = Connection::open(&f.path).unwrap();
    let high = 9007199254760993_i64;
    db.execute_batch("WITH RECURSIVE n(x) AS (VALUES(9007199254740993) UNION ALL SELECT x+1 FROM n WHERE x<9007199254760993) INSERT INTO events SELECT 859,x,'now','{}' FROM n;").unwrap();
    let base = run_filter_query(&f, json!([{"path":"appended","op":"missing"}]));
    let (status, first) = f
        .request("POST", "/api/rx/run-filter", base.clone(), true)
        .await;
    assert_eq!(status, StatusCode::OK, "{first}");
    assert!(first["cursor"].is_string());
    let mut q = base.clone();
    q["cursor"] = first["cursor"].clone();
    db.execute(
        "INSERT INTO events VALUES(859,?,'now','{\"appended\":true}')",
        [high + 1],
    )
    .unwrap();
    let mut final_page = Value::Null;
    for _ in 0..10 {
        let (status, page) = f
            .request("POST", "/api/rx/run-filter", q.clone(), true)
            .await;
        assert_eq!(status, StatusCode::OK, "{page}");
        if page["cursor"].is_null() {
            final_page = page;
            break;
        }
        q["cursor"] = page["cursor"].clone();
    }
    assert_eq!(final_page["runs"][0]["conditions"], json!([true]));
    // Refresh includes the append, while a captured scan excludes it.
    let mut fresh = base;
    let mut refreshed = Value::Null;
    for _ in 0..10 {
        let (status, page) = f
            .request("POST", "/api/rx/run-filter", fresh.clone(), true)
            .await;
        assert_eq!(status, StatusCode::OK, "{page}");
        if page["cursor"].is_null() {
            refreshed = page;
            break;
        }
        fresh["cursor"] = page["cursor"].clone();
    }
    assert_eq!(refreshed["source_generation"], first["source_generation"]);
    assert_eq!(refreshed["runs"][0]["conditions"], json!([false]));
    // One integer below the captured high water, not merely below the last scanned seq.
    db.execute("DELETE FROM events WHERE run_id=859 AND seq>=?", [high])
        .unwrap();
    assert_eq!(
        f.request("POST", "/api/rx/run-filter", q, true).await.0,
        StatusCode::BAD_REQUEST
    );
}

#[tokio::test]
async fn run_filter_full_budget_event_advances_after_a_small_row() {
    let f = Fixture::new();
    let limit = 8 * 1024 * 1024;
    let overhead = json!({"late":true,"padding":""}).to_string().len();
    let data = json!({"late":true,"padding":"x".repeat(limit - overhead)}).to_string();
    assert_eq!(data.len(), limit);
    Connection::open(&f.path)
        .unwrap()
        .execute("INSERT INTO events VALUES(859,6,'now',?)", [data])
        .unwrap();
    let mut q = run_filter_query(
        &f,
        json!([
            {"path":"loss","op":"exists"},
            {"path":"late","op":"exists"},
            {"path":"absent","op":"missing"}
        ]),
    );
    let before = std::fs::read(&f.path).unwrap();
    let (status, first) = f
        .request("POST", "/api/rx/run-filter", q.clone(), true)
        .await;
    assert_eq!(status, StatusCode::OK, "{first}");
    assert!(first["cursor"].is_string());
    assert_eq!(first["diagnostics"]["scanned"], 1);
    assert_eq!(first["runs"][0]["conditions"], json!([true, null, null]));
    q["cursor"] = first["cursor"].clone();
    let (status, last) = f.request("POST", "/api/rx/run-filter", q, true).await;
    assert_eq!(status, StatusCode::OK, "{last}");
    assert!(last["cursor"].is_null(), "{last}");
    assert_eq!(last["runs"][0]["conditions"], json!([true, true, true]));
    assert_eq!(last["diagnostics"]["scanned"], 1);
    assert_eq!(last["diagnostics"]["bytes"], limit);
    assert_eq!(last["diagnostics"]["oversized"], 0);
    assert_eq!(last["diagnostics"]["partial"], false);
    assert_eq!(before, std::fs::read(&f.path).unwrap());
    // The larger predicate allowance must not raise the record preview limit.
    let (status, records) = f.request("POST", "/api/rx/records", f.query(), true).await;
    assert_eq!(status, StatusCode::OK, "{records}");
    assert_eq!(records["diagnostics"]["oversized"], 1);
}

#[tokio::test]
async fn run_filter_late_match_after_four_continuations_finishes_snapshot_despite_appends() {
    let f = Fixture::new();
    let db = Connection::open(&f.path).unwrap();
    db.execute_batch("WITH RECURSIVE n(x) AS (VALUES(6) UNION ALL SELECT x+1 FROM n WHERE x<100005) INSERT INTO events SELECT 859,x,'now','{}' FROM n; INSERT INTO events VALUES(859,100006,'now','{\"late\":true}');").unwrap();
    let mut q = run_filter_query(
        &f,
        json!([
            {"path":"loss","op":"exists"},
            {"path":"late","op":"exists"},
            {"path":"appended","op":"missing"}
        ]),
    );
    let mut cursors = std::collections::BTreeSet::new();
    let mut generation = Value::Null;
    let mut total_scanned = 0;
    let mut final_page = Value::Null;
    for page_index in 0..30 {
        let (status, page) = f
            .request("POST", "/api/rx/run-filter", q.clone(), true)
            .await;
        assert_eq!(status, StatusCode::OK, "{page}");
        if page_index == 0 {
            generation = page["source_generation"].clone();
        }
        assert_eq!(page["source_generation"], generation);
        let scanned = page["diagnostics"]["scanned"].as_u64().unwrap();
        assert!(scanned > 0, "no progress: {page}");
        total_scanned += scanned;
        assert_eq!(page["runs"][0]["conditions"][0], true);
        if page["cursor"].is_null() {
            final_page = page;
            break;
        }
        assert_eq!(page["runs"][0]["conditions"][2], Value::Null);
        assert!(cursors.insert(page["cursor"].as_str().unwrap().to_owned()));
        q["cursor"] = page["cursor"].clone();
        db.execute(
            "INSERT INTO events VALUES(859,?,'now','{\"appended\":true}')",
            [100007 + page_index],
        )
        .unwrap();
    }
    assert!(cursors.len() > 4, "{cursors:?}");
    assert_eq!(total_scanned, 100002);
    assert_eq!(
        final_page["runs"][0]["conditions"],
        json!([true, true, true])
    );
    assert_eq!(final_page["diagnostics"]["partial"], false);
}

#[tokio::test]
async fn run_filter_unreadable_tail_fails_after_successful_continuations() {
    for (data, expected) in [
        ("bad json".to_owned(), StatusCode::UNPROCESSABLE_ENTITY),
        (
            json!({"padding":"x".repeat(64 * 1024 * 1024)}).to_string(),
            StatusCode::PAYLOAD_TOO_LARGE,
        ),
    ] {
        let f = Fixture::new();
        let db = Connection::open(&f.path).unwrap();
        db.execute_batch("WITH RECURSIVE n(x) AS (VALUES(6) UNION ALL SELECT x+1 FROM n WHERE x<20005) INSERT INTO events SELECT 859,x,'now','{}' FROM n;").unwrap();
        db.execute("INSERT INTO events VALUES(859,20006,'now',?)", [data])
            .unwrap();
        let mut q = run_filter_query(&f, json!([{"path":"absent","op":"missing"}]));
        let mut failed = false;
        for page_index in 0..10 {
            let (status, page) = f
                .request("POST", "/api/rx/run-filter", q.clone(), true)
                .await;
            if status != StatusCode::OK {
                assert!(page_index > 0);
                assert_eq!(status, expected, "{page}");
                assert!(page["error"].as_str().unwrap().contains("cannot complete"));
                assert!(page.get("runs").is_none());
                failed = true;
                break;
            }
            assert!(
                page["cursor"].is_string(),
                "unreadable scan completed: {page}"
            );
            assert!(page["diagnostics"]["scanned"].as_u64().unwrap() > 0);
            assert_ne!(q["cursor"], page["cursor"]);
            q["cursor"] = page["cursor"].clone();
        }
        assert!(failed, "unreadable scan did not reach a visible error");
    }
}

#[tokio::test]
async fn catalog_snapshot_completes_beyond_five_pages_despite_appends_and_rejects_replacement() {
    let f = Fixture::new();
    let db = Connection::open(&f.path).unwrap();
    db.execute_batch("DELETE FROM events; DELETE FROM runs; BEGIN;")
        .unwrap();
    for id in 1..=1207 {
        db.execute(
            "INSERT INTO runs VALUES(?,?,'succeeded',NULL,NULL,'now',NULL,NULL,0,'[]')",
            rusqlite::params![id, format!("uid-{id}")],
        )
        .unwrap();
    }
    db.execute_batch("COMMIT").unwrap();
    let (status, first) = f.request("GET", "/api/rx/catalog", Value::Null, true).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(first["high_water"], "1207");
    let generation = first["source_generation"].as_str().unwrap();
    let mut seen = first["runs"].as_array().unwrap().clone();
    let mut next = first["next_after"].as_str().map(str::to_owned);
    let mut pages = 1;
    while let Some(after) = next {
        let appended = 1207 + pages;
        db.execute(
            "INSERT INTO runs VALUES(?,?,'queued',NULL,NULL,'now',NULL,NULL,NULL,'[]')",
            rusqlite::params![appended, format!("uid-{appended}")],
        )
        .unwrap();
        let path =
            format!("/api/rx/catalog?after={after}&high_water=1207&source_generation={generation}");
        let (status, page) = f.request("GET", &path, Value::Null, true).await;
        assert_eq!(status, StatusCode::OK, "{page}");
        assert_eq!(page["high_water"], "1207");
        assert_eq!(page["source_generation"], generation);
        assert!(page["runs"].as_array().unwrap().len() <= 200);
        seen.extend(page["runs"].as_array().unwrap().iter().cloned());
        next = page["next_after"].as_str().map(str::to_owned);
        pages += 1;
        assert!(pages < 10);
    }
    assert_eq!(pages, 7);
    assert_eq!(seen.len(), 1207);
    assert_eq!(seen.last().unwrap()["run_uid"], "uid-1207");
    let (_, refreshed) = f.request("GET", "/api/rx/catalog", Value::Null, true).await;
    assert_eq!(refreshed["high_water"], "1213");
    // The same generation pin is used by the Event filter, not only catalog pages.
    let (_, proof) = f.request("POST", "/api/rx/run-filter", json!({"source_id":f.source_id,"runs":["uid-1"],"conditions":[{"path":"absent","op":"missing"}]}), true).await;
    assert_eq!(proof["source_generation"], generation);
    drop(db);
    let replacement = f.path.with_extension("replacement");
    std::fs::copy(&f.path, &replacement).unwrap();
    std::fs::rename(&replacement, &f.path).unwrap();
    let path = format!("/api/rx/catalog?after=200&high_water=1207&source_generation={generation}");
    assert_eq!(
        f.request("GET", &path, Value::Null, true).await.0,
        StatusCode::BAD_REQUEST
    );
}

#[tokio::test]
async fn catalog_snapshot_pins_exact_i64_high_water_and_rejects_shrink() {
    let f = Fixture::new();
    let db = Connection::open(&f.path).unwrap();
    db.execute("INSERT INTO runs VALUES(9007199254740993,'large','succeeded',NULL,NULL,'now',NULL,NULL,0,'[]')", []).unwrap();
    let (_, first) = f.request("GET", "/api/rx/catalog", Value::Null, true).await;
    assert_eq!(first["high_water"], "9007199254740993");
    let generation = first["source_generation"].as_str().unwrap();
    let path = format!(
        "/api/rx/catalog?after=859&high_water=9007199254740993&source_generation={generation}"
    );
    let (status, page) = f.request("GET", &path, Value::Null, true).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(page["runs"][0]["id"], "9007199254740993");
    db.execute("DELETE FROM runs WHERE run_uid='large'", [])
        .unwrap();
    assert_eq!(
        f.request("GET", &path, Value::Null, true).await.0,
        StatusCode::BAD_REQUEST
    );
}

#[tokio::test]
async fn run_filter_real_source_large_event_preserves_late_match_and_absence() {
    let f = Fixture::new();
    let db = Connection::open(&f.path).unwrap();
    // Real rffm events include 13.4 MB and 54.6 MB diagnostic payloads.
    let raw = json!({"stage_summary":"x".repeat(55 * 1024 * 1024)}).to_string();
    db.execute("INSERT INTO events VALUES(859,6,'now',?)", [&raw])
        .unwrap();
    db.execute_batch("INSERT INTO events VALUES(859,7,'now','{\"metrics\":{\"accuracy\":0.9}}')")
        .unwrap();
    drop(db);
    let mut q = run_filter_query(
        &f,
        json!([
            {"path":"metrics.accuracy","op":"exists"},
            {"path":"absent","op":"missing"}
        ]),
    );
    let mut pages = 0;
    loop {
        let (status, result) = f
            .request("POST", "/api/rx/run-filter", q.clone(), true)
            .await;
        assert_eq!(status, StatusCode::OK, "{result}");
        pages += 1;
        assert!(pages < 10, "large row must make progress");
        if result["diagnostics"]["bytes"].as_u64().unwrap() > 8 * 1024 * 1024 {
            assert_eq!(result["diagnostics"]["scanned"], 1);
        }
        if result["cursor"].is_null() {
            assert_eq!(result["runs"][0]["conditions"], json!([true, true]));
            break;
        }
        assert_ne!(q["cursor"], result["cursor"]);
        q["cursor"] = result["cursor"].clone();
    }
    assert!(pages >= 3);
}

#[tokio::test]
async fn run_filter_real_source_nonfinite_numbers_are_not_null_or_strings() {
    let f = Fixture::new();
    let db = Connection::open(&f.path).unwrap();
    db.execute("INSERT INTO events VALUES(859,6,'now',?)", [r#"{"metrics":{"accuracy":0.9},"nan":NaN,"positive":Infinity,"negative":-Infinity,"nil":null,"text":"NaN Infinity -Infinity","array":[NaN]}"#]).unwrap();
    drop(db);
    let q = run_filter_query(
        &f,
        json!([
            {"path":"metrics.accuracy","op":"exists"},
            {"path":"nan","op":"exists"},
            {"path":"nan","op":"missing"},
            {"path":"nan","op":"eq","value":null},
            {"path":"nan","op":"ne","value":null},
            {"path":"nan","op":"eq","value":"NaN"},
            {"path":"nan","op":"gt","value":0},
            {"path":"positive","op":"gt","value":1e300},
            {"path":"negative","op":"lt","value":-1e300},
            {"path":"nil","op":"eq","value":null},
            {"path":"text","op":"eq","value":"NaN Infinity -Infinity"},
            {"path":"array[0]","op":"exists"},
            {"path":"nan.child","op":"missing"},
            {"path":"absent","op":"missing"}
        ]),
    );
    let (status, result) = f.request("POST", "/api/rx/run-filter", q, true).await;
    assert_eq!(status, StatusCode::OK, "{result}");
    assert!(result["cursor"].is_null());
    assert_eq!(
        result["runs"][0]["conditions"],
        json!([
            true, true, false, false, true, false, false, true, true, true, true, true, true, true
        ])
    );
}

#[tokio::test]
async fn run_filter_nonfinite_extension_keeps_invalid_json_explicit() {
    for raw in [
        r#"{"x":NaNx}"#,
        r#"{"x":+Infinity}"#,
        r#"{"x":-NaN}"#,
        r#"{NaN:1}"#,
        r#"[Infinity,]"#,
        r#"{"x":NaN,"broken":}"#,
        r#"{"x":"unterminated NaN}"#,
    ] {
        let f = Fixture::new();
        let db = Connection::open(&f.path).unwrap();
        db.execute("INSERT INTO events VALUES(859,6,'now',?)", [raw])
            .unwrap();
        drop(db);
        let q = run_filter_query(&f, json!([{"path":"absent","op":"missing"}]));
        let (status, result) = f.request("POST", "/api/rx/run-filter", q, true).await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{raw}: {result}");
        assert!(result.get("runs").is_none());
    }
}

#[tokio::test]
async fn run_filter_nonfinite_duplicate_keys_keep_last_value() {
    let f = Fixture::new();
    let db = Connection::open(&f.path).unwrap();
    db.execute(
        "INSERT INTO events VALUES(859,6,'now',?)",
        [r#"{"x":NaN,"x":1,"y":NaN,"y":Infinity,"sub":{"x":NaN},"sub":{"x":null}}"#],
    )
    .unwrap();
    drop(db);
    let q = run_filter_query(
        &f,
        json!([
            {"path":"x","op":"eq","value":1},
            {"path":"x","op":"eq","value":null},
            {"path":"y","op":"gt","value":1e300},
            {"path":"sub.x","op":"eq","value":null}
        ]),
    );
    let (status, result) = f.request("POST", "/api/rx/run-filter", q, true).await;
    assert_eq!(status, StatusCode::OK, "{result}");
    assert_eq!(
        result["runs"][0]["conditions"],
        json!([true, false, true, true])
    );
}

#[tokio::test]
async fn run_filter_dense_nonfinite_has_explicit_preallocation_resource_bound() {
    let f = Fixture::new();
    let db = Connection::open(&f.path).unwrap();
    let raw = format!("{{\"dense\":[{}NaN]}}", "NaN,".repeat(999_999));
    db.execute("INSERT INTO events VALUES(859,6,'now',?)", [&raw])
        .unwrap();
    drop(db);
    let q = run_filter_query(&f, json!([{"path":"absent","op":"missing"}]));
    let (status, result) = f.request("POST", "/api/rx/run-filter", q, true).await;
    assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE, "{result}");
    assert!(
        result["error"]
            .as_str()
            .unwrap()
            .contains("non-finite-number resource limit")
    );
    assert!(result.get("runs").is_none());
}
