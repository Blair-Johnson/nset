use axum::{
    Router,
    body::Body,
    http::{Request, StatusCode},
};
use http_body_util::BodyExt;
use nset::{
    AppState, api,
    auth::Token,
    db::{Database, SCHEMA_VERSION},
};
use serde_json::{Value, json};
use tower::ServiceExt;

fn open(path: &std::path::Path) -> AppState {
    AppState::open(path, Token::new("test-secret").unwrap()).unwrap()
}
async fn raw(
    app: &Router,
    method: &str,
    uri: &str,
    body: Vec<u8>,
    token: bool,
) -> (StatusCode, Value) {
    let mut request = Request::builder()
        .method(method)
        .uri(uri)
        .header("content-type", "application/json");
    if token {
        request = request.header("authorization", "Bearer test-secret");
    }
    let response = app
        .clone()
        .oneshot(request.body(Body::from(body)).unwrap())
        .await
        .unwrap();
    let status = response.status();
    assert_eq!(response.headers()["cache-control"], "private, no-store");
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    if status == StatusCode::NO_CONTENT {
        assert!(bytes.is_empty());
        (status, Value::Null)
    } else {
        (status, serde_json::from_slice(&bytes).unwrap())
    }
}
async fn request(app: &Router, method: &str, uri: &str, body: Value) -> (StatusCode, Value) {
    raw(app, method, uri, serde_json::to_vec(&body).unwrap(), true).await
}
fn workspace() -> Value {
    json!({"version":2,"id":"view:local","name":"Training","experimentId":"rx:synthetic",
    "selectedRunIds":["rx:run-a"],"updatedAt":0,
    "sections":[{"id":"section:stable","title":"Metrics","collapsed":false,"cards":[{
        "id":"chart:stable","title":"Loss","kind":"timeseries",
        "source":{"mode":"selected","keys":["loss"]},"config":{},"outliers":"all","size":"normal"
    }]}]})
}
async fn create(app: &Router) -> Value {
    let (status, result) =
        request(app, "POST", "/api/views", json!({"workspace":workspace()})).await;
    assert_eq!(status, StatusCode::CREATED, "{result}");
    result
}

#[tokio::test]
async fn create_read_list_save_cas_and_revision_polling() {
    let dir = tempfile::tempdir().unwrap();
    let app = api::router(open(dir.path()));
    assert_eq!(
        request(&app, "GET", "/api/views", Value::Null).await,
        (StatusCode::OK, json!({"views":[]}))
    );
    let first = create(&app).await;
    let id = first["id"].as_str().unwrap();
    assert!(id.starts_with("server:"));
    uuid::Uuid::parse_str(id.strip_prefix("server:").unwrap()).unwrap();
    assert_eq!(first["revision"], 1);
    assert_eq!(first["workspace"]["id"], id);
    assert!(first["workspace"]["updatedAt"].as_i64().unwrap() > 0);
    let url = format!("/api/views/{id}");
    assert_eq!(
        request(&app, "GET", &url, Value::Null).await,
        (StatusCode::OK, first.clone())
    );
    assert_eq!(
        request(&app, "GET", &format!("{url}?revision=1"), Value::Null).await,
        (StatusCode::NO_CONTENT, Value::Null)
    );
    assert_eq!(
        request(&app, "GET", &format!("{url}?revision=2"), Value::Null).await,
        (StatusCode::OK, first.clone())
    );
    let (_, listing) = request(&app, "GET", "/api/views", Value::Null).await;
    assert_eq!(
        listing["views"],
        json!([{"id":id,"name":"Training","experimentId":"rx:synthetic","revision":1,"updatedAt":first["workspace"]["updatedAt"]}])
    );

    let mut edited = first["workspace"].clone();
    edited["name"] = json!("Edited locally");
    edited["updatedAt"] = json!(1);
    // Local changes have no server effect until an explicit PUT.
    assert_eq!(request(&app, "GET", &url, Value::Null).await.1, first);
    let (status, saved) =
        request(&app, "PUT", &url, json!({"revision":1,"workspace":edited})).await;
    assert_eq!(status, StatusCode::OK, "{saved}");
    assert_eq!(saved["revision"], 2);
    assert_eq!(saved["workspace"]["name"], "Edited locally");
    assert!(saved["workspace"]["updatedAt"].as_i64().unwrap() > 1);
    assert_eq!(
        saved["workspace"]["sections"],
        first["workspace"]["sections"]
    );
    assert_eq!(
        request(
            &app,
            "PUT",
            &url,
            json!({"revision":1,"workspace":first["workspace"]})
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    assert_eq!(
        request(&app, "GET", &format!("{url}?revision=1"), Value::Null).await,
        (StatusCode::OK, saved.clone())
    );
    assert_eq!(
        request(&app, "GET", &format!("{url}?revision=2"), Value::Null)
            .await
            .0,
        StatusCode::NO_CONTENT
    );
    assert_eq!(request(&app, "GET", &url, Value::Null).await.1, saved);
    for query in ["0", "-1", "1.5", "9007199254740992", "not-a-number", ""] {
        assert_eq!(
            request(&app, "GET", &format!("{url}?revision={query}"), Value::Null)
                .await
                .0,
            StatusCode::BAD_REQUEST
        );
    }
    assert_eq!(
        request(
            &app,
            "GET",
            "/api/views/server:missing?revision=1",
            Value::Null
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    let mut missing = workspace();
    missing["id"] = json!("server:missing");
    assert_eq!(
        request(
            &app,
            "PUT",
            "/api/views/server:missing",
            json!({"revision":1,"workspace":missing})
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        request(
            &app,
            "PUT",
            &url,
            json!({"revision":2,"workspace":workspace()})
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
}

#[tokio::test]
async fn authentication_write_admission_and_body_limits() {
    let dir = tempfile::tempdir().unwrap();
    let state = open(dir.path());
    let app = api::router(state.clone());
    let _held = state
        .write_slots
        .try_acquire_many(state.write_slots.available_permits() as u32)
        .unwrap();
    for (method, url) in [
        ("GET", "/api/views"),
        ("POST", "/api/views"),
        ("GET", "/api/views/server:x"),
        ("PUT", "/api/views/server:x"),
    ] {
        assert_eq!(
            raw(&app, method, url, vec![], false).await.0,
            StatusCode::UNAUTHORIZED
        );
    }
    for (method, url) in [("POST", "/api/views"), ("PUT", "/api/views/server:x")] {
        assert_eq!(
            request(&app, method, url, json!({})).await.0,
            StatusCode::SERVICE_UNAVAILABLE
        );
    }
    assert_eq!(
        request(&app, "GET", "/api/views", Value::Null).await.0,
        StatusCode::OK
    );
    drop(_held);
    for method in ["POST", "PUT"] {
        let url = if method == "POST" {
            "/api/views"
        } else {
            "/api/views/server:x"
        };
        let (status, error) = raw(&app, method, url, vec![b' '; 2 * 1024 * 1024 + 1], true).await;
        assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE);
        assert!(error["error"].as_str().unwrap().contains("2 MiB"));
    }
}

#[tokio::test]
async fn invalid_envelopes_workspaces_and_nested_configs_are_not_saved() {
    let dir = tempfile::tempdir().unwrap();
    let app = api::router(open(dir.path()));
    for body in [
        json!({}),
        json!({"workspace":workspace(),"extra":1}),
        json!({"workspace":null}),
        json!({"workspace":workspace(),"revision":1}),
    ] {
        assert!(
            request(&app, "POST", "/api/views", body)
                .await
                .0
                .is_client_error()
        );
    }
    let cases = vec![
        ("/version", json!(1)),
        ("/name", json!("\u{feff}")),
        ("/name", json!("😀".repeat(129))),
        ("/id", json!("constructor")),
        ("/experimentId", json!(false)),
        ("/updatedAt", json!(-1)),
        ("/updatedAt", json!(1.5)),
        ("/updatedAt", json!(9007199254740992_u64)),
        ("/selectedRunIds", json!(["a", "a"])),
        ("/selectedRunIds", json!([null])),
        ("/sections/0/collapsed", json!(0)),
        ("/sections/0/title", json!("")),
        ("/sections/0/cards/0/kind", json!("scatter")),
        ("/sections/0/cards/0/outliers", json!("bad")),
        (
            "/sections/0/cards/0/source",
            json!({"mode":"selected","keys":["x","x"]}),
        ),
        (
            "/sections/0/cards/0/source",
            json!({"mode":"selected","keys":[],"extra":1}),
        ),
        (
            "/sections/0/cards/0/source",
            json!({"mode":"explicit","series":[{"runId":"r","key":"k","kind":"image"}]}),
        ),
        (
            "/sections/0/cards/0/source",
            json!({"mode":"explicit","series":[{"runId":"r","key":"k","kind":"metric"},{"runId":"r","key":"k","kind":"metric"}]}),
        ),
        ("/sections/0/cards/0/config", json!({"height":239})),
        ("/sections/0/cards/0/config", json!({"version":2})),
        ("/sections/0/cards/0/config", json!({"alpha":0})),
        (
            "/sections/0/cards/0/config",
            json!({"style":{"color":"url(evil)"}}),
        ),
        ("/sections/0/cards/0/config", json!({"style":{"width":21}})),
        (
            "/sections/0/cards/0/config",
            json!({"advanced":{"hooks":{}}}),
        ),
        ("/sections/0/cards/0/config", json!({"xMin":4,"xMax":2})),
        (
            "/sections/0/cards/0/config",
            json!({"yScale":"log","yMin":0}),
        ),
        (
            "/sections/0/cards/0/config",
            json!({"yScale":"log","runs":{"a":{"fillTo":0}}}),
        ),
        (
            "/sections/0/cards/0/config",
            json!({"advanced":{"scales":{"x":{"auto":false}}}}),
        ),
        (
            "/sections/0/cards/0/config",
            json!({"advanced":{"axes":[{"values":["a"]}]}}),
        ),
        (
            "/sections/0/cards/0/config",
            json!({"advanced":{"axes":[{}, {"rotate":10}]}}),
        ),
        ("/sections/0/cards/0/config", json!({"constructor":{}})),
    ];
    for (pointer, value) in cases {
        let mut w = workspace();
        *w.pointer_mut(pointer).unwrap() = value;
        let (status, error) = request(&app, "POST", "/api/views", json!({"workspace":w})).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{pointer}: {error}");
    }
    for kind in ["sections", "cards"] {
        let mut w = workspace();
        if kind == "sections" {
            let section = w["sections"][0].clone();
            w["sections"].as_array_mut().unwrap().push(section);
        } else {
            let card = w["sections"][0]["cards"][0].clone();
            w["sections"][0]["cards"].as_array_mut().unwrap().push(card);
        }
        assert_eq!(
            request(&app, "POST", "/api/views", json!({"workspace":w}))
                .await
                .0,
            StatusCode::BAD_REQUEST
        );
    }
    let mut unknown = workspace();
    unknown["extra"] = json!(true);
    assert_eq!(
        request(&app, "POST", "/api/views", json!({"workspace":unknown}))
            .await
            .0,
        StatusCode::BAD_REQUEST
    );
    let mut large = workspace();
    large["selectedRunIds"] = json!(
        (0..40)
            .map(|i| format!("{i}{}", "a".repeat(8000)))
            .collect::<Vec<_>>()
    );
    assert_eq!(
        request(&app, "POST", "/api/views", json!({"workspace":large}))
            .await
            .0,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        request(&app, "GET", "/api/views", Value::Null).await.1,
        json!({"views":[]})
    );
    let valid = create(&app).await;
    let url = format!("/api/views/{}", valid["id"].as_str().unwrap());
    for revision in [
        json!(0),
        json!(-1),
        json!(1.1),
        json!(9007199254740992_u64),
        json!("1"),
        Value::Null,
    ] {
        assert_eq!(
            request(
                &app,
                "PUT",
                &url,
                json!({"revision":revision,"workspace":valid["workspace"]})
            )
            .await
            .0,
            StatusCode::BAD_REQUEST
        );
    }
    assert!(
        request(
            &app,
            "PUT",
            &url,
            json!({"revision":1,"workspace":valid["workspace"],"extra":1})
        )
        .await
        .0
        .is_client_error()
    );
    assert_eq!(request(&app, "GET", &url, Value::Null).await.1, valid);
}

#[tokio::test]
async fn records_xy_images_and_advanced_options_round_trip() {
    let dir = tempfile::tempdir().unwrap();
    let app = api::router(open(dir.path()));
    let binding = json!({"sourceId":"rx:external","runUids":["uid"],"x":"epoch","ys":["$[\"metrics.loss\"]"],"group":"tag", "filters":{"any":false,"conditions":[{"path":"stage","op":"eq","value":"train"}]}});
    let mut w = workspace();
    w["sections"][0]["cards"][0]["records"] = binding.clone();
    w["sections"][0]["cards"][0]["config"] = json!({"style":{"color":"oklch(60% .2 30 / 50%)","markers":{"show":"auto","dash":[2,3]}},"advanced":{"axes":[{"stroke":"#abb3bc","grid":{"stroke":"#363b40"},"ticks":{"stroke":"#737b84"}}],"scales":{"x":{"range":[0,10],"auto":false}}}});
    let (status, saved) = request(&app, "POST", "/api/views", json!({"workspace":w})).await;
    assert_eq!(status, StatusCode::CREATED, "{saved}");
    assert_eq!(saved["workspace"]["sections"], w["sections"]);
    for (key, value) in [
        ("x", json!("$")),
        ("ys", json!([])),
        ("runUids", json!(["u", "u"])),
        ("sourceId", json!("native:x")),
        ("group", json!(false)),
        (
            "filters",
            json!({"any":false,"conditions":[{"path":"a","op":"eq","value":9007199254740992_u64}]}),
        ),
    ] {
        let mut invalid = w.clone();
        invalid["sections"][0]["cards"][0]["records"][key] = value;
        assert_eq!(
            request(&app, "POST", "/api/views", json!({"workspace":invalid}))
                .await
                .0,
            StatusCode::BAD_REQUEST
        );
    }
    w["sections"][0]["cards"][0]["x"] = json!({"mode":"key","key":"epoch"});
    assert_eq!(
        request(&app, "POST", "/api/views", json!({"workspace":w}))
            .await
            .0,
        StatusCode::BAD_REQUEST
    );
    w["sections"][0]["cards"][0]
        .as_object_mut()
        .unwrap()
        .remove("records");
    w["sections"][0]["cards"][0]["layout"] = json!({"width":400,"height":300});
    assert_eq!(
        request(&app, "POST", "/api/views", json!({"workspace":w}))
            .await
            .0,
        StatusCode::CREATED
    );
    w["sections"][0]["cards"][0]["kind"] = json!("image");
    assert_eq!(
        request(&app, "POST", "/api/views", json!({"workspace":w}))
            .await
            .0,
        StatusCode::BAD_REQUEST
    );
    w["sections"][0]["cards"][0]
        .as_object_mut()
        .unwrap()
        .remove("x");
    assert_eq!(
        request(&app, "POST", "/api/views", json!({"workspace":w}))
            .await
            .0,
        StatusCode::CREATED
    );
}

#[tokio::test]
async fn simultaneous_saves_have_one_winner_and_quota_never_hides_views() {
    let dir = tempfile::tempdir().unwrap();
    let app = api::router(open(dir.path()));
    let first = create(&app).await;
    let url = format!("/api/views/{}", first["id"].as_str().unwrap());
    let mut a = first["workspace"].clone();
    a["name"] = json!("A");
    let mut b = first["workspace"].clone();
    b["name"] = json!("B");
    let (a, b) = tokio::join!(
        request(&app, "PUT", &url, json!({"revision":1,"workspace":a})),
        request(&app, "PUT", &url, json!({"revision":1,"workspace":b}))
    );
    assert!(
        (a.0 == StatusCode::OK && b.0 == StatusCode::CONFLICT)
            || (b.0 == StatusCode::OK && a.0 == StatusCode::CONFLICT)
    );
    assert_eq!(
        request(&app, "GET", &url, Value::Null).await.1["revision"],
        2
    );
    for _ in 1..128 {
        create(&app).await;
    }
    assert_eq!(
        request(&app, "POST", "/api/views", json!({"workspace":workspace()}))
            .await
            .0,
        StatusCode::CONFLICT
    );
    let (_, listed) = request(&app, "GET", "/api/views", Value::Null).await;
    assert_eq!(listed["views"].as_array().unwrap().len(), 128);
    // Updates continue to work at capacity.
    assert_eq!(
        request(
            &app,
            "PUT",
            &url,
            json!({"revision":2,"workspace":first["workspace"]})
        )
        .await
        .0,
        StatusCode::OK
    );
}

#[tokio::test]
async fn version_three_migration_and_restart_preserve_saved_workspaces() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::open(dir.path()).unwrap();
    let (experiment, _) = db
        .create_experiment("existing experiment".into())
        .await
        .unwrap();
    drop(db);
    let conn = rusqlite::Connection::open(dir.path().join("nset.sqlite3")).unwrap();
    conn.execute_batch("DROP TABLE views; PRAGMA user_version=3; CREATE TABLE extension(value TEXT); INSERT INTO extension VALUES('preserved');").unwrap();
    drop(conn);
    let app = api::router(open(dir.path()));
    let saved = create(&app).await;
    let url = format!("/api/views/{}", saved["id"].as_str().unwrap());
    drop(app);
    let app = api::router(open(dir.path()));
    assert_eq!(
        request(&app, "GET", &url, Value::Null).await,
        (StatusCode::OK, saved)
    );
    assert_eq!(
        request(&app, "GET", "/api/experiments", Value::Null)
            .await
            .1["experiments"][0]["id"],
        experiment.id
    );
    let conn = rusqlite::Connection::open(dir.path().join("nset.sqlite3")).unwrap();
    assert_eq!(
        conn.pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0))
            .unwrap(),
        SCHEMA_VERSION
    );
    assert_eq!(
        conn.query_row("SELECT value FROM extension", [], |r| r.get::<_, String>(0))
            .unwrap(),
        "preserved"
    );
}

#[test]
fn migration_name_collisions_leave_older_databases_unchanged() {
    for version in 0..4 {
        for collision in [
            "CREATE TABLE views(unrelated TEXT); INSERT INTO views VALUES('untouched');",
            "CREATE VIEW ViEwS AS SELECT value FROM extension;",
            "CREATE INDEX VIEWS ON extension(value);",
        ] {
            let dir = tempfile::tempdir().unwrap();
            drop(Database::open(dir.path()).unwrap());
            let path = dir.path().join("nset.sqlite3");
            let conn = rusqlite::Connection::open(&path).unwrap();
            conn.execute_batch("PRAGMA journal_mode=DELETE; DROP TABLE views; CREATE TABLE extension(value TEXT); INSERT INTO extension VALUES('preserved');").unwrap();
            if version < 3 {
                conn.execute_batch(
                    "DROP TABLE compat_batches; DROP TABLE compat_sequences; DROP TABLE compat_kv;",
                )
                .unwrap();
            }
            if version < 2 {
                conn.execute_batch("DROP TABLE ingest_receipts;").unwrap();
            }
            conn.pragma_update(None, "user_version", version).unwrap();
            conn.execute_batch(collision).unwrap();
            drop(conn);
            std::fs::remove_dir(dir.path().join("images")).unwrap();
            let before = std::fs::read(&path).unwrap();

            assert!(
                Database::open(dir.path()).is_err(),
                "v{version}: {collision}"
            );
            assert_eq!(
                std::fs::read(&path).unwrap(),
                before,
                "failed open changed v{version}: {collision}"
            );
            assert!(!dir.path().join("images").exists());
            assert!(!dir.path().join("nset.sqlite3-wal").exists());
            let conn = rusqlite::Connection::open(&path).unwrap();
            assert_eq!(
                conn.pragma_query_value(None, "journal_mode", |r| r.get::<_, String>(0))
                    .unwrap(),
                "delete"
            );
            assert_eq!(
                conn.pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0))
                    .unwrap(),
                version
            );
            assert_eq!(
                conn.query_row("SELECT value FROM extension", [], |r| r.get::<_, String>(0))
                    .unwrap(),
                "preserved"
            );
        }
    }
}

#[tokio::test]
async fn javascript_numeric_expansion_cannot_bypass_workspace_byte_limit() {
    let dir = tempfile::tempdir().unwrap();
    let app = api::router(open(dir.path()));
    let mut w = workspace();
    let template = w["sections"][0]["cards"][0].clone();
    w["sections"][0]["cards"] = json!(
        (0..3)
            .map(|i| {
                let mut card = template.clone();
                card["id"] = json!(format!("chart:{i}"));
                card["config"] = json!({"advanced":{"cursor":{"hover":{"skip":vec![1e20; 4096]}}}});
                card
            })
            .collect::<Vec<_>>()
    );
    assert!(serde_json::to_vec(&w).unwrap().len() < 262_144);
    assert_eq!(
        request(&app, "POST", "/api/views", json!({"workspace":w}))
            .await
            .0,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        request(&app, "GET", "/api/views", Value::Null).await.1,
        json!({"views":[]})
    );
    let mut small = workspace();
    small["sections"][0]["cards"][0]["config"] =
        json!({"advanced":{"cursor":{"hover":{"skip":[1e20, -1e20, 1e-6, 5e-324]}}}});
    let (status, saved) = request(&app, "POST", "/api/views", json!({"workspace":small})).await;
    assert_eq!(status, StatusCode::CREATED, "{saved}");
    assert_eq!(saved["workspace"]["sections"], small["sections"]);
}
