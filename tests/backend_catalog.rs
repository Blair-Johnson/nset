use axum::{
    Router,
    body::Body,
    http::{HeaderMap, Request, StatusCode},
};
use http_body_util::BodyExt;
use nset::{AppState, api, auth::Token};
use rusqlite::Connection;
use serde_json::{Value, json};
use std::io::Cursor;
use tower::ServiceExt;

struct TestApp {
    app: Router,
    directory: tempfile::TempDir,
}
impl TestApp {
    fn new() -> Self {
        let directory = tempfile::tempdir().unwrap();
        let state = AppState::open(directory.path(), Token::new("test-secret").unwrap()).unwrap();
        Self {
            app: api::router(state),
            directory,
        }
    }
    fn connection(&self) -> Connection {
        Connection::open(self.directory.path().join("nset.sqlite3")).unwrap()
    }
    async fn request(&self, request: Request<Body>) -> (StatusCode, HeaderMap, Value) {
        let response = self.app.clone().oneshot(request).await.unwrap();
        let status = response.status();
        let headers = response.headers().clone();
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        assert_eq!(headers["content-type"], "application/json");
        assert_eq!(headers["cache-control"], "private, no-store");
        assert_eq!(headers["x-content-type-options"], "nosniff");
        assert_eq!(headers["x-frame-options"], "DENY");
        assert_eq!(headers["referrer-policy"], "no-referrer");
        assert!(
            headers["content-security-policy"]
                .to_str()
                .unwrap()
                .contains("frame-ancestors 'none'")
        );
        assert!(!headers.contains_key("access-control-allow-origin"));
        (status, headers, serde_json::from_slice(&bytes).unwrap())
    }
    async fn json(&self, method: &str, uri: &str, body: Value) -> Value {
        let (status, _, result) = self
            .request(
                Request::builder()
                    .method(method)
                    .uri(uri)
                    .header("authorization", "Bearer test-secret")
                    .header("content-type", "application/json")
                    .body(Body::from(serde_json::to_vec(&body).unwrap()))
                    .unwrap(),
            )
            .await;
        assert!(status.is_success(), "{method} {uri}: {result}");
        result
    }
    async fn experiment(&self, name: &str) -> Value {
        self.json("POST", "/api/experiments", json!({"name":name}))
            .await
    }
    async fn run(&self, experiment: &Value, name: &str) -> Value {
        self.json(
            "POST",
            "/api/runs",
            json!({
                "experiment_id":experiment["id"], "name":name,
                "params":{"lr":0.001,"nested":{"label":"literal <tag>"}},
                "tags":{"owner":"catalog test"}
            }),
        )
        .await
    }
    async fn image(&self, run: &Value, step: i64, timestamp: i64) -> Value {
        let mut bytes = Cursor::new(Vec::new());
        image::DynamicImage::new_rgb8(1, 1)
            .write_to(&mut bytes, image::ImageFormat::Png)
            .unwrap();
        let (status, _, image) = self
            .request(
                Request::builder()
                    .method("POST")
                    .uri(format!(
                        "/api/runs/{}/images?key=train%2Floss&step={step}&timestamp={timestamp}",
                        run["id"].as_str().unwrap()
                    ))
                    .header("authorization", "Bearer test-secret")
                    .header("content-type", "image/png")
                    .body(Body::from(bytes.into_inner()))
                    .unwrap(),
            )
            .await;
        assert_eq!(status, StatusCode::CREATED);
        image
    }
    async fn catalog(&self) -> Value {
        self.json("GET", "/api/catalog", Value::Null).await
    }
}

#[tokio::test]
async fn catalog_auth_empty_shape_and_security_headers() {
    let app = TestApp::new();
    for token in [
        None,
        Some("Bearer wrong"),
        Some("Bearer test-secret-extra"),
        Some("Basic test-secret"),
    ] {
        let mut request = Request::builder().uri("/api/catalog?token=test-secret");
        if let Some(token) = token {
            request = request.header("authorization", token);
        }
        let (status, headers, body) = app.request(request.body(Body::empty()).unwrap()).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        assert_eq!(headers["www-authenticate"], "Bearer");
        assert_eq!(body, json!({"error":"unauthorized"}));
    }
    let (status, _, _) = app
        .request(
            Request::builder()
                .uri("/api/catalog")
                .header("authorization", "Bearer test-secret")
                .header("authorization", "Bearer test-secret")
                .body(Body::empty())
                .unwrap(),
        )
        .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(
        app.catalog().await,
        json!({"metric_seq":0,"experiments":[],"runs":[],"series":[]})
    );
    let (status, _, error) = app
        .request(
            Request::builder()
                .method("POST")
                .uri("/api/catalog")
                .header("authorization", "Bearer test-secret")
                .body(Body::empty())
                .unwrap(),
        )
        .await;
    assert_eq!(status, StatusCode::METHOD_NOT_ALLOWED);
    assert_eq!(error, json!({"error":"method not allowed"}));
}

// Include schema, all stored values, insertion ids, and sequence state in the comparison.
fn stored_data(conn: &Connection) -> Vec<String> {
    let mut result = Vec::new();
    for table in [
        "sqlite_schema",
        "experiments",
        "runs",
        "metrics",
        "images",
        "sqlite_sequence",
    ] {
        let mut statement = conn
            .prepare(&format!("SELECT rowid,* FROM {table} ORDER BY rowid"))
            .unwrap();
        let columns = statement.column_count();
        let rows = statement
            .query_map([], |row| {
                Ok((0..columns)
                    .map(|column| format!("{:?}", row.get_ref(column).unwrap()))
                    .collect::<Vec<_>>()
                    .join("|"))
            })
            .unwrap();
        result.extend(rows.map(|row| format!("{table}:{}", row.unwrap())));
    }
    result.push(format!(
        "version:{}",
        conn.pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
            .unwrap()
    ));
    result
}

#[tokio::test]
async fn catalog_all_experiments_kinds_duplicates_and_latest_insertions_are_read_only() {
    let app = TestApp::new();
    let first = app.experiment("first").await;
    let second = app.experiment("second").await;
    let empty_experiment = app.experiment("empty experiment").await;
    let train = app.run(&first, "same run name").await;
    let evaluate = app.run(&second, "same run name").await;
    let empty_run = app.run(&first, "empty run").await;
    let image_only = app.run(&second, "image only").await;
    let special_key = "validation/quote' ? & 雪";
    let train_url = format!("/api/runs/{}", train["id"].as_str().unwrap());
    app.json(
        "POST",
        &format!("{train_url}/metrics"),
        json!({"metrics":[
            {"key":"train/loss","step":100,"timestamp":900,"value":1.0},
            {"key":"train/loss","step":100,"timestamp":900,"value":1.0},
            {"key":"train/loss","step":2,"timestamp":20,"value":-3.0},
            {"key":special_key,"step":0,"timestamp":0,"value":0.0},
            {"key":"train/loss","step":2,"timestamp":10,"value":4.0}
        ]}),
    )
    .await;
    app.json(
        "POST",
        &format!("/api/runs/{}/metrics", evaluate["id"].as_str().unwrap()),
        json!({"metrics":[
            {"key":"train/loss","step":99,"timestamp":800,"value":42.0}
        ]}),
    )
    .await;
    let old_image = app.image(&train, 100, 900).await;
    app.image(&train, 100, 900).await;
    let last_image = app.image(&train, 1, 2).await;
    app.image(&image_only, 7, 8).await;
    app.json("PATCH", &train_url, json!({"status":"finished"}))
        .await;

    // Make UUID lexical ordering deliberately disagree with insertion order.
    let conn = app.connection();
    conn.execute(
        "UPDATE images SET id='zz-old' WHERE id=?",
        [old_image["id"].as_str().unwrap()],
    )
    .unwrap();
    conn.execute(
        "UPDATE images SET id='aa-new' WHERE id=?",
        [last_image["id"].as_str().unwrap()],
    )
    .unwrap();
    let original = stored_data(&conn);
    let data_version: i64 = conn
        .pragma_query_value(None, "data_version", |row| row.get(0))
        .unwrap();
    let image_files: Vec<_> = std::fs::read_dir(app.directory.path().join("images"))
        .unwrap()
        .map(|entry| {
            let path = entry.unwrap().path();
            let bytes = std::fs::read(&path).unwrap();
            (path, bytes)
        })
        .collect();
    // Metadata must not depend on opening artifact files, even when one is unavailable.
    let hidden_path = image_files[0].0.with_extension("hidden");
    std::fs::rename(&image_files[0].0, &hidden_path).unwrap();
    let catalog = app.catalog().await;
    assert_eq!(catalog.as_object().unwrap().len(), 4);
    assert_eq!(catalog["metric_seq"], 6);
    assert_eq!(
        catalog["experiments"],
        app.json("GET", "/api/experiments", Value::Null).await["experiments"]
    );
    assert_eq!(
        catalog["runs"],
        app.json("GET", "/api/runs", Value::Null).await["runs"]
    );
    assert_eq!(catalog["experiments"].as_array().unwrap().len(), 3);
    assert!(
        catalog["experiments"]
            .as_array()
            .unwrap()
            .contains(&empty_experiment)
    );
    assert_eq!(catalog["runs"].as_array().unwrap().len(), 4);
    assert!(catalog["runs"].as_array().unwrap().contains(&empty_run));
    let expected = vec![
        json!({"run_id":train["id"],"key":"train/loss","kind":"metric","count":4,"last_step":2,"last_timestamp":10,"last_value":4.0}),
        json!({"run_id":train["id"],"key":special_key,"kind":"metric","count":1,"last_step":0,"last_timestamp":0,"last_value":0.0}),
        json!({"run_id":train["id"],"key":"train/loss","kind":"image","count":3,"last_step":1,"last_timestamp":2,"last_value":null}),
        json!({"run_id":evaluate["id"],"key":"train/loss","kind":"metric","count":1,"last_step":99,"last_timestamp":800,"last_value":42.0}),
        json!({"run_id":image_only["id"],"key":"train/loss","kind":"image","count":1,"last_step":7,"last_timestamp":8,"last_value":null}),
    ];
    let series = catalog["series"].as_array().unwrap();
    assert_eq!(series.len(), expected.len());
    for summary in expected {
        assert!(series.contains(&summary), "missing {summary} in {series:?}");
    }
    // Exact records above also exclude seq/id, histories, filenames, bytes, and content URLs.
    assert_eq!(app.catalog().await, catalog);
    assert_eq!(stored_data(&conn), original);
    assert_eq!(
        conn.pragma_query_value(None, "data_version", |row| row.get::<_, i64>(0))
            .unwrap(),
        data_version
    );
    std::fs::rename(&hidden_path, &image_files[0].0).unwrap();
    for (path, bytes) in image_files {
        assert_eq!(std::fs::read(path).unwrap(), bytes);
    }
    let history = app
        .json(
            "GET",
            &format!("{train_url}/metrics?key=train%2Floss"),
            Value::Null,
        )
        .await;
    assert_eq!(history["total"], 4);
    assert_eq!(history["points"].as_array().unwrap().len(), 4);
    assert_eq!(history["points"][0]["step"], 100);
    assert_eq!(history["points"][3]["value"], 4.0);
    let reopened = api::router(
        AppState::open(app.directory.path(), Token::new("test-secret").unwrap()).unwrap(),
    );
    let response = reopened
        .oneshot(
            Request::builder()
                .uri("/api/catalog")
                .header("authorization", "Bearer test-secret")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    assert_eq!(serde_json::from_slice::<Value>(&bytes).unwrap(), catalog);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn catalog_uses_one_snapshot_during_atomic_cross_table_writes() {
    let app = TestApp::new();
    let path = app.directory.path().join("nset.sqlite3");
    let writer = std::thread::spawn(move || {
        let mut conn = Connection::open(path).unwrap();
        conn.busy_timeout(std::time::Duration::from_secs(5))
            .unwrap();
        for generation in 1..=100 {
            let id = generation.to_string();
            let tx = conn.transaction().unwrap();
            tx.execute(
                "INSERT INTO experiments VALUES(?1,?1,?2)",
                rusqlite::params![id, generation],
            )
            .unwrap();
            tx.execute(
                "INSERT INTO runs VALUES(?1,?1,?1,'running','{}','{}',?2,?2)",
                rusqlite::params![id, generation],
            )
            .unwrap();
            tx.execute(
                "INSERT INTO metrics(run_id,key,step,timestamp,value) VALUES(?1,'x',?2,?2,?2)",
                rusqlite::params![id, generation],
            )
            .unwrap();
            tx.execute(
                "INSERT INTO images VALUES(?1,?1,'x',?2,?2,'image/png',1,?1)",
                rusqlite::params![id, generation],
            )
            .unwrap();
            tx.commit().unwrap();
            std::thread::yield_now();
        }
    });
    for _ in 0..100 {
        let catalog = app.catalog().await;
        let experiments = catalog["experiments"].as_array().unwrap();
        let runs = catalog["runs"].as_array().unwrap();
        let series = catalog["series"].as_array().unwrap();
        assert_eq!(experiments.len(), runs.len());
        assert_eq!(series.len(), runs.len() * 2);
        for run in runs {
            assert!(
                experiments
                    .iter()
                    .any(|experiment| experiment["id"] == run["experiment_id"])
            );
            let related: Vec<_> = series.iter().filter(|s| s["run_id"] == run["id"]).collect();
            assert_eq!(related.len(), 2);
            for summary in related {
                assert_eq!(summary["count"], 1);
                assert_eq!(summary["last_timestamp"], run["updated_at"]);
            }
        }
    }
    writer.join().unwrap();
    assert_eq!(
        app.catalog().await["experiments"].as_array().unwrap().len(),
        100
    );
}
