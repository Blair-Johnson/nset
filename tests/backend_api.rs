use axum::{
    Router,
    body::Body,
    http::{HeaderMap, Request, StatusCode},
};
use http_body_util::BodyExt;
use nset::{AppState, api, auth::Token};
use serde_json::{Value, json};
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
    async fn raw(
        &self,
        method: &str,
        uri: &str,
        body: Vec<u8>,
        content_type: &str,
        token: Option<&str>,
    ) -> (StatusCode, HeaderMap, Vec<u8>) {
        let mut request = Request::builder()
            .method(method)
            .uri(uri)
            .header("content-type", content_type);
        if let Some(token) = token {
            request = request.header("authorization", format!("Bearer {token}"));
        }
        let response = self
            .app
            .clone()
            .oneshot(request.body(Body::from(body)).unwrap())
            .await
            .unwrap();
        let status = response.status();
        let headers = response.headers().clone();
        let bytes = response
            .into_body()
            .collect()
            .await
            .unwrap()
            .to_bytes()
            .to_vec();
        (status, headers, bytes)
    }
    async fn json(&self, method: &str, uri: &str, body: Value) -> (StatusCode, Value) {
        let (status, headers, bytes) = self
            .raw(
                method,
                uri,
                serde_json::to_vec(&body).unwrap(),
                "application/json",
                Some("test-secret"),
            )
            .await;
        assert_eq!(
            headers["content-type"],
            "application/json",
            "{}",
            String::from_utf8_lossy(&bytes)
        );
        (status, serde_json::from_slice(&bytes).unwrap())
    }
    async fn run(&self) -> String {
        let (status, exp) = self
            .json("POST", "/api/experiments", json!({"name":"test"}))
            .await;
        assert!(status == StatusCode::CREATED || status == StatusCode::OK);
        let (status, run) = self
            .json(
                "POST",
                "/api/runs",
                json!({"experiment_id":exp["id"],"name":"run"}),
            )
            .await;
        assert_eq!(status, StatusCode::CREATED, "{run}");
        run["id"].as_str().unwrap().to_owned()
    }
}
#[tokio::test]
async fn auth_required_on_all_api_routes_including_artifacts_and_unknown_paths() {
    let app = TestApp::new();
    for path in [
        "/api/health",
        "/api/experiments",
        "/api/runs",
        "/api/images/missing/content",
        "/api/no-such-route",
    ] {
        for token in [None, Some("wrong"), Some("test-secret-extra")] {
            let (status, headers, body) = app
                .raw("GET", path, vec![], "application/json", token)
                .await;
            assert_eq!(status, StatusCode::UNAUTHORIZED, "{path}");
            assert_eq!(headers["www-authenticate"], "Bearer");
            assert_eq!(
                serde_json::from_slice::<Value>(&body).unwrap(),
                json!({"error":"unauthorized"})
            );
            assert!(!headers.contains_key("access-control-allow-origin"));
        }
    }
    assert_eq!(
        app.json("GET", "/api/health", Value::Null).await,
        (StatusCode::OK, json!({"status":"ok"}))
    );
    let request = Request::builder()
        .uri("/api/health")
        .header("authorization", "Bearer test-secret")
        .header("authorization", "Bearer test-secret")
        .body(Body::empty())
        .unwrap();
    assert_eq!(
        app.app.clone().oneshot(request).await.unwrap().status(),
        StatusCode::UNAUTHORIZED
    );
}
#[tokio::test]
async fn experiments_and_runs_merge_objects_and_persist() {
    let app = TestApp::new();
    let (status, first) = app
        .json("POST", "/api/experiments", json!({"name":"<b>literal</b>"}))
        .await;
    assert_eq!(status, StatusCode::CREATED);
    let (status, second) = app
        .json("POST", "/api/experiments", json!({"name":"<b>literal</b>"}))
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(first, second);
    let (status,run) = app.json("POST","/api/runs",json!({"experiment_id":first["id"],"name":"run","params":{"a":1,"b":2},"tags":{"owner":"me"}})).await;
    assert_eq!(status, StatusCode::CREATED);
    let url = format!("/api/runs/{}", run["id"].as_str().unwrap());
    let (status, run) = app
        .json(
            "PATCH",
            &url,
            json!({"status":"finished","params":{"a":3,"c":4},"tags":{"note":"done"}}),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(run["params"], json!({"a":3,"b":2,"c":4}));
    assert_eq!(run["tags"], json!({"owner":"me","note":"done"}));
    assert_eq!(run["status"], "finished");
    // A null tag value removes that tag; other tags are untouched.
    let (status, untagged) = app.json("PATCH", &url, json!({"tags":{"note":null}})).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(untagged["tags"], json!({"owner":"me"}));
    let (_, run) = app
        .json("PATCH", &url, json!({"tags":{"note":"done"}}))
        .await;
    let (_, list) = app
        .json(
            "GET",
            &format!("/api/runs?experiment_id={}", first["id"].as_str().unwrap()),
            Value::Null,
        )
        .await;
    assert_eq!(list["runs"].as_array().unwrap().len(), 1);
    assert_eq!(
        app.json("PATCH", &url, json!({"status":"unknown"})).await.0,
        StatusCode::BAD_REQUEST
    );
    let state = AppState::open(app.directory.path(), Token::new("test-secret").unwrap()).unwrap();
    let reread = state
        .db
        .run(run["id"].as_str().unwrap().into())
        .await
        .unwrap();
    assert_eq!(reread.status, "finished");
    let conn = rusqlite::Connection::open(app.directory.path().join("nset.sqlite3")).unwrap();
    assert_eq!(
        conn.query_row("PRAGMA journal_mode", [], |row| row.get::<_, String>(0))
            .unwrap(),
        "wal"
    );
}
#[tokio::test]
async fn missing_resources_return_404_instead_of_empty_or_database_errors() {
    let app = TestApp::new();
    for (method, path, body) in [
        ("GET", "/api/runs/missing", Value::Null),
        ("GET", "/api/runs/missing/metrics?key=x", Value::Null),
        ("GET", "/api/runs/missing/metric-keys", Value::Null),
        ("GET", "/api/runs/missing/images", Value::Null),
        ("GET", "/api/images/missing/content", Value::Null),
        ("GET", "/api/runs?experiment_id=missing", Value::Null),
        ("PATCH", "/api/runs/missing", json!({"status":"failed"})),
        ("POST", "/api/runs/missing/metrics", json!({"metrics":[]})),
        (
            "POST",
            "/api/runs",
            json!({"experiment_id":"missing","name":"r"}),
        ),
        ("GET", "/api/unknown", Value::Null),
    ] {
        let (status, error) = app.json(method, path, body).await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{path}: {error}");
        assert_eq!(error, json!({"error":"resource not found"}));
    }
}
#[tokio::test]
async fn invalid_metric_batches_are_atomic_and_strict() {
    let app = TestApp::new();
    let id = app.run().await;
    let url = format!("/api/runs/{id}/metrics");
    let valid = json!({"key":"loss","step":0,"value":1.0});
    for invalid in [
        json!({"key":"loss","step":-1,"value":0.0}),
        json!({"key":"loss","step":9007199254740992_i64,"value":0.0}),
        json!({"key":"loss","step":0.5,"value":0.0}),
        json!({"key":"loss","step":0,"value":0.0,"timestamp":-1}),
        json!({"key":"loss","step":0,"value":0.0,"timestamp":9007199254740992_i64}),
        json!({"key":"","step":0,"value":0.0}),
        json!({"key":"\u{e9}".repeat(257),"step":0,"value":0.0}),
        json!({"key":"loss","step":0,"value":null}),
    ] {
        let (status, _) = app
            .json("POST", &url, json!({"metrics":[valid,invalid]}))
            .await;
        assert!(status.is_client_error());
        let (_, page) = app
            .json("GET", &format!("{url}?key=loss"), Value::Null)
            .await;
        assert_eq!(page["total"], 0);
        assert_eq!(page["snapshot"], 0);
    }
    let bad_number = br#"{"metrics":[{"key":"loss","step":0,"value":1e400}]}"#.to_vec();
    assert!(
        app.raw(
            "POST",
            &url,
            bad_number,
            "application/json",
            Some("test-secret")
        )
        .await
        .0
        .is_client_error()
    );
    let batch = vec![valid; 10001];
    assert_eq!(
        app.json("POST", &url, json!({"metrics":batch})).await.0,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(app.json("POST",&url,json!({"metrics":[{"key":"loss","step":9007199254740991_i64,"timestamp":9007199254740991_i64,"value":-2.0}]})).await.0,StatusCode::OK);
    let (_, keys) = app
        .json("GET", &format!("/api/runs/{id}/metric-keys"), Value::Null)
        .await;
    assert_eq!(keys, json!({"keys":["loss"]}));
}
#[tokio::test]
async fn metric_pagination_keeps_snapshot_while_new_data_is_inserted() {
    let app = TestApp::new();
    let id = app.run().await;
    let url = format!("/api/runs/{id}/metrics");
    let batch: Vec<_> = (0..7)
        .map(|step| json!({"key":"x","step":step,"value":step}))
        .collect();
    assert_eq!(
        app.json("POST", &url, json!({"metrics":batch})).await.0,
        StatusCode::OK
    );
    let (_, first) = app
        .json("GET", &format!("{url}?key=x&limit=3"), Value::Null)
        .await;
    let snapshot = first["snapshot"].as_i64().unwrap();
    let mut all = first["points"].as_array().unwrap().clone();
    assert_eq!(
        app.json(
            "POST",
            &url,
            json!({"metrics":[{"key":"x","step":7,"value":7},{"key":"other","step":0,"value":0}]})
        )
        .await
        .0,
        StatusCode::OK
    );
    let mut next = first["next_after"].as_i64();
    while let Some(after) = next {
        let (_, page) = app
            .json(
                "GET",
                &format!("{url}?key=x&limit=3&snapshot={snapshot}&after={after}"),
                Value::Null,
            )
            .await;
        assert_eq!(page["total"], 7);
        assert_eq!(page["snapshot"], snapshot);
        all.extend_from_slice(page["points"].as_array().unwrap());
        next = page["next_after"].as_i64();
    }
    assert_eq!(all.len(), 7);
    let seqs: Vec<_> = all.iter().map(|p| p["seq"].as_i64().unwrap()).collect();
    assert!(seqs.windows(2).all(|w| w[0] < w[1]));
    let (_, fresh) = app.json("GET", &format!("{url}?key=x"), Value::Null).await;
    assert_eq!(fresh["total"], 8);
    let (_, empty) = app
        .json("GET", &format!("{url}?key=empty"), Value::Null)
        .await;
    assert_eq!(
        empty,
        json!({"points":[],"next_after":null,"snapshot":0,"total":0})
    );
    for query in [
        "limit=0",
        "limit=50001",
        "after=-1",
        "snapshot=-1",
        "snapshot=9007199254740992",
        "after=0.5",
    ] {
        assert!(
            app.json("GET", &format!("{url}?key=x&{query}"), Value::Null)
                .await
                .0
                .is_client_error()
        );
    }
}
#[tokio::test]
async fn more_than_fifty_thousand_metrics_are_available_without_silent_cap() {
    let app = TestApp::new();
    let id = app.run().await;
    let url = format!("/api/runs/{id}/metrics");
    for start in (0..60003).step_by(10000) {
        let batch: Vec<_> = (start..(start + 10000).min(60003))
            .map(|step| json!({"key":"x","step":step,"value":step}))
            .collect();
        assert_eq!(
            app.json("POST", &url, json!({"metrics":batch})).await.0,
            StatusCode::OK
        );
    }
    let mut count = 0;
    let mut after = 0;
    let mut snapshot = None;
    loop {
        let extra = snapshot
            .map(|s| format!("&snapshot={s}"))
            .unwrap_or_default();
        let (_, page) = app
            .json(
                "GET",
                &format!("{url}?key=x&limit=17000&after={after}{extra}"),
                Value::Null,
            )
            .await;
        assert_eq!(page["total"], 60003);
        snapshot = page["snapshot"].as_i64();
        for point in page["points"].as_array().unwrap() {
            assert_eq!(point["step"], count);
            count += 1;
        }
        match page["next_after"].as_i64() {
            Some(next) => after = next,
            None => break,
        }
    }
    assert_eq!(count, 60003);
}
fn encoded_image(format: image::ImageFormat) -> Vec<u8> {
    let image = image::DynamicImage::new_rgb8(3, 2);
    let mut output = std::io::Cursor::new(Vec::new());
    image.write_to(&mut output, format).unwrap();
    output.into_inner()
}
#[tokio::test]
async fn native_images_roundtrip_with_auth_correct_mime_and_ordering() {
    let app = TestApp::new();
    let id = app.run().await;
    for (format, mime, step) in [
        (image::ImageFormat::Png, "image/png", 3),
        (image::ImageFormat::Jpeg, "image/jpeg", 2),
        (image::ImageFormat::WebP, "image/webp", 1),
    ] {
        let bytes = encoded_image(format);
        let (status, _, body) = app
            .raw(
                "POST",
                &format!("/api/runs/{id}/images?key=frame&step={step}&timestamp=123"),
                bytes.clone(),
                mime,
                Some("test-secret"),
            )
            .await;
        assert_eq!(
            status,
            StatusCode::CREATED,
            "{}",
            String::from_utf8_lossy(&body)
        );
        let metadata: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(metadata["byte_length"], bytes.len());
        assert_eq!(metadata["content_type"], mime);
        let path = format!("/api/images/{}/content", metadata["id"].as_str().unwrap());
        assert_eq!(
            app.raw("GET", &path, vec![], "", None).await.0,
            StatusCode::UNAUTHORIZED
        );
        let (status, headers, download) =
            app.raw("GET", &path, vec![], "", Some("test-secret")).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(download, bytes);
        assert_eq!(headers["content-type"], mime);
        assert_eq!(headers["x-content-type-options"], "nosniff");
        assert!(
            headers["cache-control"]
                .to_str()
                .unwrap()
                .contains("private")
        );
    }
    let (_, list) = app
        .json(
            "GET",
            &format!("/api/runs/{id}/images?key=frame"),
            Value::Null,
        )
        .await;
    assert_eq!(
        list["images"]
            .as_array()
            .unwrap()
            .iter()
            .map(|x| x["step"].as_i64().unwrap())
            .collect::<Vec<_>>(),
        vec![1, 2, 3]
    );
    assert_eq!(
        std::fs::read_dir(app.directory.path().join("images"))
            .unwrap()
            .count(),
        3
    );
}
#[tokio::test]
async fn corrupt_mismatched_and_unsafe_images_leave_no_artifacts() {
    let app = TestApp::new();
    let id = app.run().await;
    let path = format!("/api/runs/{id}/images?key=frame&step=0&timestamp=0");
    for (mime, bytes) in [
        ("image/svg+xml", b"<svg/>".to_vec()),
        ("text/html", b"<html/>".to_vec()),
        ("image/png", b"not an image".to_vec()),
        ("image/jpeg", encoded_image(image::ImageFormat::Png)),
        (
            "image/png",
            encoded_image(image::ImageFormat::Png)[..33].to_vec(),
        ),
        (
            "image/jpeg",
            encoded_image(image::ImageFormat::Jpeg)[..20].to_vec(),
        ),
        (
            "image/webp",
            encoded_image(image::ImageFormat::WebP)[..20].to_vec(),
        ),
    ] {
        assert!(
            app.raw("POST", &path, bytes, mime, Some("test-secret"))
                .await
                .0
                .is_client_error()
        );
    }
    for query in [
        "key=x&step=-1&timestamp=0",
        "key=x&step=0&timestamp=-1",
        "key=x&step=9007199254740992&timestamp=0",
        "key=&step=0&timestamp=0",
    ] {
        assert!(
            app.raw(
                "POST",
                &format!("/api/runs/{id}/images?{query}"),
                encoded_image(image::ImageFormat::Png),
                "image/png",
                Some("test-secret")
            )
            .await
            .0
            .is_client_error()
        );
    }
    assert_eq!(
        app.raw(
            "POST",
            "/api/runs/missing/images?key=x&step=0&timestamp=0",
            encoded_image(image::ImageFormat::Png),
            "image/png",
            Some("test-secret")
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        std::fs::read_dir(app.directory.path().join("images"))
            .unwrap()
            .count(),
        0
    );
    assert_eq!(
        app.json("GET", &format!("/api/runs/{id}/images"), Value::Null)
            .await
            .1,
        json!({"images":[]})
    );
}
#[tokio::test]
async fn image_database_failure_cleans_file_and_errors_are_sanitized() {
    let app = TestApp::new();
    let id = app.run().await;
    let connection = rusqlite::Connection::open(app.directory.path().join("nset.sqlite3")).unwrap();
    connection.execute_batch("CREATE TRIGGER fail_image BEFORE INSERT ON images BEGIN SELECT RAISE(ABORT, 'private database detail'); END;").unwrap();
    let (status, _, body) = app
        .raw(
            "POST",
            &format!("/api/runs/{id}/images?key=x&step=0&timestamp=0"),
            encoded_image(image::ImageFormat::Png),
            "image/png",
            Some("test-secret"),
        )
        .await;
    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
    assert_eq!(
        serde_json::from_slice::<Value>(&body).unwrap(),
        json!({"error":"internal server error"})
    );
    assert_eq!(
        std::fs::read_dir(app.directory.path().join("images"))
            .unwrap()
            .count(),
        0
    );
}
#[tokio::test]
async fn body_limit_extractor_errors_and_assets_are_safe() {
    let app = TestApp::new();
    let (status, _, bytes) = app
        .raw(
            "POST",
            "/api/experiments",
            vec![b' '; nset::config::MAX_BODY + 1],
            "application/json",
            Some("test-secret"),
        )
        .await;
    assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE);
    assert!(serde_json::from_slice::<Value>(&bytes).unwrap()["error"].is_string());
    let (status, _, bytes) = app
        .raw(
            "POST",
            "/api/experiments",
            b"{broken".to_vec(),
            "application/json",
            Some("test-secret"),
        )
        .await;
    assert!(status.is_client_error());
    assert_eq!(
        serde_json::from_slice::<Value>(&bytes).unwrap(),
        json!({"error":"invalid request"})
    );
    for path in ["/", "/runs/some-client-route"] {
        let (status, headers, body) = app.raw("GET", path, vec![], "", None).await;
        assert_eq!(status, StatusCode::OK);
        assert!(
            headers["content-type"]
                .to_str()
                .unwrap()
                .starts_with("text/html")
        );
        assert_eq!(body, include_bytes!("../web/dist/index.html"));
    }
    for path in [
        "/../Cargo.toml",
        "/%2e%2e/Cargo.toml",
        "/assets/%5cfile",
        "/assets/%00file",
    ] {
        assert_eq!(
            app.raw("GET", path, vec![], "", None).await.0,
            StatusCode::BAD_REQUEST
        );
    }
    assert_eq!(
        app.raw("GET", "/missing.js", vec![], "", None).await.0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(app.raw("HEAD", "/", vec![], "", None).await.2.len(), 0);
}
#[test]
fn token_and_config_validation() {
    use clap::{CommandFactory, FromArgMatches};
    use nset::config::{Command, Config};
    assert!(Token::new("").is_err());
    assert!(Token::new(" \n").is_err());
    let token = Token::new("secret").unwrap();
    assert!(token.matches("secret"));
    assert!(!token.matches("secret-other"));
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("token");
    std::fs::write(&path, "file-secret\r\n").unwrap();
    let cli = Config::command().mut_subcommand("serve", |command| {
        command.mut_args(|arg| arg.env(None::<&str>))
    });
    let matches = cli
        .clone()
        .try_get_matches_from(["nset", "serve", "--token-file", path.to_str().unwrap()])
        .unwrap();
    let Command::Serve(config) = Config::from_arg_matches(&matches).unwrap().command;
    assert!(config.load_token().unwrap().matches("file-secret"));
    assert_eq!(config.host, "127.0.0.1");
    assert_eq!(config.port, 8080);
    assert!(
        cli.try_get_matches_from(["nset", "serve", "--token", "one", "--token-file", "two"])
            .is_err()
    );
}

#[tokio::test]
async fn invalid_config_objects_and_explicit_null_fields_are_rejected() {
    let app = TestApp::new();
    let id = app.run().await;
    for patch in [
        json!({"params":null}),
        json!({"tags":[]}),
        json!({"status":null}),
        json!({"params":{"":1}}),
        json!({"tags":{"nested":{"":1}}}),
    ] {
        assert!(
            app.json("PATCH", &format!("/api/runs/{id}"), patch)
                .await
                .0
                .is_client_error()
        );
    }
    assert!(
        app.json(
            "POST",
            &format!("/api/runs/{id}/metrics"),
            json!({"metrics":[{"key":"x","step":0,"value":1,"timestamp":null}]})
        )
        .await
        .0
        .is_client_error()
    );
    for value in [f64::INFINITY, f64::NEG_INFINITY, f64::NAN] {
        assert!(
            nset::models::MetricInput {
                key: "x".into(),
                step: 0,
                value,
                timestamp: None
            }
            .validate()
            .is_err()
        );
    }
}

#[tokio::test]
async fn mid_batch_database_failure_rolls_back_every_metric() {
    let app = TestApp::new();
    let id = app.run().await;
    let connection = rusqlite::Connection::open(app.directory.path().join("nset.sqlite3")).unwrap();
    connection.execute_batch("CREATE TRIGGER fail_metric BEFORE INSERT ON metrics WHEN NEW.step=1 BEGIN SELECT RAISE(ABORT, 'private metric detail'); END;").unwrap();
    let url = format!("/api/runs/{id}/metrics");
    let (status, error) = app
        .json(
            "POST",
            &url,
            json!({"metrics":[{"key":"x","step":0,"value":1},{"key":"x","step":1,"value":2}]}),
        )
        .await;
    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
    assert_eq!(error, json!({"error":"internal server error"}));
    assert_eq!(
        app.json("GET", &format!("{url}?key=x"), Value::Null)
            .await
            .1["total"],
        0
    );
}

#[tokio::test]
async fn oversized_decoded_images_and_missing_files_fail_safely() {
    let app = TestApp::new();
    let id = app.run().await;
    let path = format!("/api/runs/{id}/images?key=x&step=0&timestamp=0");
    let mut bytes = std::io::Cursor::new(Vec::new());
    image::DynamicImage::new_rgb8(32769, 1)
        .write_to(&mut bytes, image::ImageFormat::Png)
        .unwrap();
    assert_eq!(
        app.raw(
            "POST",
            &path,
            bytes.into_inner(),
            "image/png",
            Some("test-secret")
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
    let (status, _, body) = app
        .raw(
            "POST",
            &path,
            encoded_image(image::ImageFormat::Png),
            "image/png",
            Some("test-secret"),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED);
    let metadata: Value = serde_json::from_slice(&body).unwrap();
    let image_id = metadata["id"].as_str().unwrap();
    let image_path = app
        .directory
        .path()
        .join("images")
        .join(format!("{image_id}.image"));
    let url = format!("/api/images/{image_id}/content");
    std::fs::write(&image_path, "short").unwrap();
    assert_eq!(
        app.json("GET", &url, Value::Null).await,
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            json!({"error":"internal server error"})
        )
    );
    std::fs::remove_file(image_path).unwrap();
    assert_eq!(
        app.json("GET", &url, Value::Null).await.0,
        StatusCode::INTERNAL_SERVER_ERROR
    );
}

#[test]
fn binary_requires_token_and_never_echoes_secret() {
    use std::process::Command;
    let directory = tempfile::tempdir().unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_nset"))
        .env_remove("NSET_TOKEN")
        .args([
            "serve",
            "--db-path",
            directory.path().join("not-created").to_str().unwrap(),
        ])
        .output()
        .unwrap();
    assert!(!output.status.success());
    assert!(!directory.path().join("not-created").exists());
    let output = Command::new(env!("CARGO_BIN_EXE_nset"))
        .env("NSET_TOKEN", "secret-that-must-not-appear")
        .arg("--help")
        .output()
        .unwrap();
    assert!(output.status.success());
    assert!(!String::from_utf8_lossy(&output.stdout).contains("secret-that-must-not-appear"));
    assert!(!String::from_utf8_lossy(&output.stderr).contains("secret-that-must-not-appear"));
}

#[tokio::test]
async fn concurrent_writers_and_readers_keep_every_observation() {
    let app = TestApp::new();
    let id = app.run().await;
    let mut tasks = Vec::new();
    // Keep the integrity workload within admission capacity. Saturation and
    // fail-fast rejection are exercised independently in backend_admission.
    let slots = std::sync::Arc::new(tokio::sync::Semaphore::new(nset::config::MAX_ACTIVE_WRITES));
    for batch in 0..20 {
        let router = app.app.clone();
        let id = id.clone();
        let slots = slots.clone();
        tasks.push(tokio::spawn(async move {
            let _permit = slots.acquire().await.unwrap();
            let metrics: Vec<_> = (0..100)
                .map(|offset| json!({"key":"x","step":batch*100+offset,"value":offset}))
                .collect();
            let request = Request::builder()
                .method("POST")
                .uri(format!("/api/runs/{id}/metrics"))
                .header("authorization", "Bearer test-secret")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::to_vec(&json!({"metrics":metrics})).unwrap(),
                ))
                .unwrap();
            assert_eq!(
                router.oneshot(request).await.unwrap().status(),
                StatusCode::OK
            );
        }));
    }
    for _ in 0..5 {
        let (status, page) = app
            .json(
                "GET",
                &format!("/api/runs/{id}/metrics?key=x&limit=50000"),
                Value::Null,
            )
            .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            page["points"].as_array().unwrap().len() as i64,
            page["total"].as_i64().unwrap()
        );
    }
    for task in tasks {
        task.await.unwrap();
    }
    let (_, page) = app
        .json("GET", &format!("/api/runs/{id}/metrics?key=x"), Value::Null)
        .await;
    assert_eq!(page["total"], 2000);
    let mut steps: Vec<_> = page["points"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| p["step"].as_i64().unwrap())
        .collect();
    steps.sort_unstable();
    assert_eq!(steps, (0..2000).collect::<Vec<_>>());
}

#[tokio::test]
async fn security_headers_cover_assets_api_errors_and_image_content() {
    let app = TestApp::new();
    let id = app.run().await;
    let (status, _, body) = app
        .raw(
            "POST",
            &format!("/api/runs/{id}/images?key=x&step=0&timestamp=0"),
            encoded_image(image::ImageFormat::Png),
            "image/png",
            Some("test-secret"),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED);
    let image: Value = serde_json::from_slice(&body).unwrap();
    let content = format!("/api/images/{}/content", image["id"].as_str().unwrap());
    for (path, token, expected) in [
        ("/", None, StatusCode::OK),
        ("/runs/client-route", None, StatusCode::OK),
        ("/missing.js", None, StatusCode::NOT_FOUND),
        ("/api/health", None, StatusCode::UNAUTHORIZED),
        ("/api/health", Some("test-secret"), StatusCode::OK),
        ("/api/missing", Some("test-secret"), StatusCode::NOT_FOUND),
        (content.as_str(), Some("test-secret"), StatusCode::OK),
    ] {
        let (status, headers, _) = app.raw("GET", path, vec![], "", token).await;
        assert_eq!(status, expected, "{path}");
        assert_eq!(
            headers["content-security-policy"],
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"
        );
        assert_eq!(headers["referrer-policy"], "no-referrer");
        assert_eq!(headers["x-frame-options"], "DENY");
        assert_eq!(headers["x-content-type-options"], "nosniff");
        assert!(!headers.contains_key("access-control-allow-origin"));
    }
}

#[tokio::test]
async fn image_timestamp_defaults_when_omitted() {
    let app = TestApp::new();
    let id = app.run().await;
    let before = nset::models::now();
    let (status, _, body) = app
        .raw(
            "POST",
            &format!("/api/runs/{id}/images?key=prediction&step=0"),
            encoded_image(image::ImageFormat::Png),
            "image/png",
            Some("test-secret"),
        )
        .await;
    assert_eq!(
        status,
        StatusCode::CREATED,
        "{}",
        String::from_utf8_lossy(&body)
    );
    let image: Value = serde_json::from_slice(&body).unwrap();
    let timestamp = image["timestamp"].as_i64().unwrap();
    assert!(timestamp >= before && timestamp <= nset::models::now());
    for invalid in ["-1", "null", "9007199254740992"] {
        let (status, _, _) = app
            .raw(
                "POST",
                &format!("/api/runs/{id}/images?key=prediction&step=0&timestamp={invalid}"),
                encoded_image(image::ImageFormat::Png),
                "image/png",
                Some("test-secret"),
            )
            .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
    }
}
