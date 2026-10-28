use axum::{
    Router,
    body::{Body, to_bytes},
    http::{Request, StatusCode},
};
use nset::{
    AppState, api,
    auth::Token,
    db::Database,
    ingest::{DurableIngest, IngestOptions},
    live::Change,
    models::*,
};
use serde_json::{Value, json};
use std::time::Duration;
use tower::ServiceExt;

struct Fixture {
    app: Router,
    state: AppState,
    run: String,
    dir: tempfile::TempDir,
}
impl Fixture {
    async fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let state = AppState::open(dir.path(), Token::new("live-secret").unwrap()).unwrap();
        let run = create_run(&state.db).await;
        Self {
            app: api::router(state.clone()),
            state,
            run,
            dir,
        }
    }
    async fn json(&self, method: &str, uri: &str, body: Value) -> Value {
        let (status, body) = request(self.app.clone(), method, uri, body, true).await;
        assert!(status.is_success(), "{method} {uri}: {status} {body}");
        body
    }
    async fn poll(&self, cursor: &str) -> Value {
        tokio::time::timeout(
            Duration::from_secs(3),
            self.json("POST", "/api/live", json!({"cursor":cursor})),
        )
        .await
        .unwrap()
    }
}
async fn request(
    app: Router,
    method: &str,
    uri: &str,
    body: Value,
    auth: bool,
) -> (StatusCode, Value) {
    let mut req = Request::builder()
        .method(method)
        .uri(uri)
        .header("content-type", "application/json");
    if auth {
        req = req.header("authorization", "Bearer live-secret");
    }
    let response = app
        .oneshot(
            req.body(Body::from(serde_json::to_vec(&body).unwrap()))
                .unwrap(),
        )
        .await
        .unwrap();
    // Compatibility endpoints retain their existing header policy.
    if !uri.starts_with("/api/2.0/") {
        assert_eq!(response.headers()["cache-control"], "private, no-store");
    }
    let status = response.status();
    let bytes = to_bytes(response.into_body(), 16 * 1024 * 1024)
        .await
        .unwrap();
    (status, serde_json::from_slice(&bytes).unwrap())
}
async fn create_run(db: &Database) -> String {
    let (experiment, _) = db.create_experiment("live".into()).await.unwrap();
    db.create_run(NewRun {
        experiment_id: experiment.id,
        name: "run".into(),
        params: Default::default(),
        tags: Default::default(),
    })
    .await
    .unwrap()
    .id
}
fn batch(points: &[(&str, i64, i64, f64)]) -> MetricBatch {
    MetricBatch {
        metrics: points
            .iter()
            .map(|(key, step, timestamp, value)| MetricInput {
                key: (*key).into(),
                step: *step,
                timestamp: Some(*timestamp),
                value: *value,
            })
            .collect(),
    }
}

#[tokio::test]
async fn authenticated_read_routes_bypass_write_admission_and_validate_inputs() {
    let f = Fixture::new().await;
    let _slots = f
        .state
        .write_slots
        .acquire_many(f.state.write_slots.available_permits() as u32)
        .await
        .unwrap();
    for (method, path, body) in [
        ("GET", "/api/live", json!(null)),
        ("POST", "/api/live", json!({"cursor":"foreign:0"})),
        (
            "POST",
            "/api/metrics/tail",
            json!({"series":[{"runId":"secret-missing", "key":"x", "after":0}]}),
        ),
    ] {
        let (status, _) = request(f.app.clone(), method, path, body, false).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
    }
    assert!(f.json("GET", "/api/live", json!(null)).await["cursor"].is_string());
    assert_eq!(f.poll("foreign:0").await["reset"], true);
    assert_eq!(
        f.json("POST", "/api/metrics/tail", json!({"series":[]}))
            .await,
        json!({"series":[]})
    );
    let (status, _) = request(
        f.app.clone(),
        "POST",
        "/api/metrics/tail",
        json!({"series":[{"runId":"missing", "key":"x", "after":0}]}),
        true,
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    // Existing Json extraction reports schema/type errors as 422, whereas
    // successfully decoded requests with invalid bounds report 400.
    for body in [
        json!({}),
        json!({"series":null}),
        json!({"series":[],"limit":null}),
        json!({"series":[],"extra":1}),
        json!({"series":[{"runId":f.run,"key":"x","after":0.5}]}),
        json!({"series":[{"runId":f.run,"key":"x","after":0,"snapshot":null}]}),
        json!({"series":[{"runId":f.run,"key":"x","after":0,"extra":1}]}),
    ] {
        let (status, _) = request(
            f.app.clone(),
            "POST",
            "/api/metrics/tail",
            body.clone(),
            true,
        )
        .await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");
    }
    for body in [
        json!({"series":[],"limit":0}),
        json!({"series":[],"limit":1001}),
        json!({"series":[{"runId":f.run,"key":"x","after":-1}]}),
        json!({"series":[{"runId":f.run,"key":"x","after":MAX_SAFE+1}]}),
        json!({"series":[{"runId":f.run,"key":"","after":0}]}),
        json!({"series":[{"runId":f.run,"key":"x","after":0,"snapshot":1}]}),
        json!({"series":[{"runId":f.run,"key":"x","after":1,"snapshot":0}]}),
        json!({"series":vec![json!({"runId":f.run,"key":"x","after":0});65]}),
        json!({"series":vec![json!({"runId":f.run,"key":"x","after":0});2]}),
    ] {
        let (status, _) = request(
            f.app.clone(),
            "POST",
            "/api/metrics/tail",
            body.clone(),
            true,
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    }
    for body in [
        json!({}),
        json!({"cursor":null}),
        json!({"cursor":7}),
        json!({"cursor":"x", "extra":1}),
    ] {
        let (status, _) = request(f.app.clone(), "POST", "/api/live", body, true).await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    }
    let (status, _) = request(
        f.app.clone(),
        "POST",
        "/api/live",
        json!({"cursor":"x".repeat(513)}),
        true,
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn commit_wakes_http_poll_with_per_batch_counts_and_replay() {
    let f = Fixture::new().await;
    let cursor = f.json("GET", "/api/live", json!(null)).await["cursor"]
        .as_str()
        .unwrap()
        .to_string();
    let pending = tokio::spawn(request(
        f.app.clone(),
        "POST",
        "/api/live",
        json!({"cursor":cursor}),
        true,
    ));
    tokio::task::yield_now().await;
    f.state
        .db
        .insert_metrics(
            f.run.clone(),
            batch(&[
                ("loss", 9, 8_000_000_000_000_000, 1.0),
                ("loss", 9, 50, 2.0),
                ("other", 0, 0, 4.0),
            ]),
        )
        .await
        .unwrap();
    let first_updated_at = f.state.db.catalog().await.unwrap().runs[0].updated_at;
    f.state
        .db
        .insert_metrics(f.run.clone(), batch(&[("loss", 1, 2, 3.0)]))
        .await
        .unwrap();
    let (status, response) = tokio::time::timeout(Duration::from_secs(3), pending)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(status, StatusCode::OK);
    assert_eq!(response["reset"], false);
    let replay = f.poll(&cursor).await;
    // Replay from the old cursor retains both commits even if scheduling let the
    // original poll return between them.
    let changes = replay["changes"].as_array().unwrap();
    assert_eq!(changes.len(), 3);
    let loss: Vec<_> = changes.iter().filter(|v| v["key"] == "loss").collect();
    assert_eq!(loss.len(), 2);
    assert_eq!(loss[0]["count"], 2);
    assert_eq!(loss[0]["high"], 2);
    assert_eq!(
        loss[0]["last"],
        json!({"seq":2,"key":"loss","step":9,"timestamp":50,"value":2.0})
    );
    assert_eq!(loss[1]["count"], 1);
    assert_eq!(loss[1]["high"], 4);
    assert_eq!(loss[1]["runId"], f.run);
    let catalog = f.json("GET", "/api/catalog", json!(null)).await;
    assert_eq!(catalog["metric_seq"], 4);
    for change in changes {
        assert!(change["runUpdatedAt"].is_i64());
        let expected = if change["high"] == 4 {
            catalog["runs"][0]["updated_at"].clone()
        } else {
            json!(first_updated_at)
        };
        assert_eq!(change["runUpdatedAt"], expected);
        assert_ne!(change["runUpdatedAt"], change["last"]["timestamp"]);
    }
    assert_eq!(
        catalog["series"]
            .as_array()
            .unwrap()
            .iter()
            .find(|v| v["key"] == "loss")
            .unwrap()["count"],
        3
    );
    // Publication implies rows are query-visible, including non-monotonic time.
    let tail = f
        .json(
            "POST",
            "/api/metrics/tail",
            json!({"series":[{"runId":f.run,"key":"loss","after":0}]}),
        )
        .await;
    assert_eq!(tail["series"][0]["points"].as_array().unwrap().len(), 3);
    assert_eq!(tail["series"][0]["snapshot"], 4);
    assert!(tail["series"][0].get("total").is_none());
}

#[tokio::test]
async fn tails_pin_each_stream_and_follow_seq_not_step_or_time() {
    let f = Fixture::new().await;
    f.state
        .db
        .insert_metrics(
            f.run.clone(),
            batch(&[
                ("a", 8, 100, 1.0),
                ("b", 0, 0, 5.0),
                ("a", 8, 50, 2.0),
                ("a", 1, 3, 3.0),
            ]),
        )
        .await
        .unwrap();
    let first = f.json("POST", "/api/metrics/tail", json!({"series":[{"runId":f.run,"key":"a","after":0},{"runId":f.run,"key":"b","after":0},{"runId":f.run,"key":"empty","after":0}],"limit":1})).await;
    assert_eq!(first["series"][0]["snapshot"], 4);
    assert_eq!(first["series"][0]["next_after"], 1);
    assert_eq!(first["series"][1]["snapshot"], 2);
    assert_eq!(first["series"][1]["next_after"], Value::Null);
    assert_eq!(first["series"][2]["snapshot"], 0);
    f.state
        .db
        .insert_metrics(f.run.clone(), batch(&[("a", 0, 1, 9.0), ("b", 0, 0, 6.0)]))
        .await
        .unwrap();
    // after=2 is a legal global seq gap in stream a, not an error or an offset.
    let page = f
        .json(
            "POST",
            "/api/metrics/tail",
            json!({"series":[{"runId":f.run,"key":"a","after":2,"snapshot":4}],"limit":1}),
        )
        .await;
    assert_eq!(page["series"][0]["points"][0]["seq"], 3);
    assert_eq!(page["series"][0]["next_after"], 3);
    let end = f
        .json(
            "POST",
            "/api/metrics/tail",
            json!({"series":[{"runId":f.run,"key":"a","after":3,"snapshot":4}],"limit":1}),
        )
        .await;
    assert_eq!(end["series"][0]["points"][0]["seq"], 4);
    assert_eq!(end["series"][0]["next_after"], Value::Null);
    let next = f
        .json(
            "POST",
            "/api/metrics/tail",
            json!({"series":[{"runId":f.run,"key":"a","after":4}]}),
        )
        .await;
    assert_eq!(next["series"][0]["snapshot"], 5);
    assert_eq!(next["series"][0]["points"][0]["timestamp"], 1);
    let unchanged = f
        .json(
            "POST",
            "/api/metrics/tail",
            json!({"series":[{"runId":f.run,"key":"a","after":5}]}),
        )
        .await;
    assert_eq!(unchanged["series"][0]["points"], json!([]));
    assert_eq!(unchanged["series"][0]["next_after"], Value::Null);
    let history = f
        .json(
            "GET",
            &format!("/api/runs/{}/metrics?key=a", f.run),
            json!(null),
        )
        .await;
    assert_eq!(
        history["total"], 4,
        "the existing count-bearing API remains unchanged"
    );
}

#[tokio::test]
async fn rollback_and_noops_do_not_publish() {
    let f = Fixture::new().await;
    let live = f.state.db.live();
    let cursor = live.cursor();
    let conn = rusqlite::Connection::open(f.dir.path().join("nset.sqlite3")).unwrap();
    f.state
        .db
        .insert_metrics(f.run.clone(), batch(&[("x", 0, 0, 1.0)]))
        .await
        .unwrap();
    let response = tokio::time::timeout(Duration::from_secs(3), live.poll(&cursor))
        .await
        .unwrap()
        .unwrap();
    assert!(matches!(
        &response.changes[0],
        Change::Metric { count: 1, .. }
    ));
    let cursor = live.cursor();
    conn.execute_batch("CREATE TRIGGER reject_metric BEFORE INSERT ON metrics WHEN NEW.key='reject' BEGIN SELECT RAISE(ABORT,'test'); END").unwrap();
    assert!(
        f.state
            .db
            .insert_metrics(
                f.run.clone(),
                batch(&[("x", 1, 1, 2.0), ("reject", 0, 0, 0.0)])
            )
            .await
            .is_err()
    );
    assert_eq!(live.cursor(), cursor);
    f.state
        .db
        .insert_metrics(f.run.clone(), MetricBatch { metrics: vec![] })
        .await
        .unwrap();
    f.state.db.create_experiment("live".into()).await.unwrap();
    f.state
        .db
        .patch_run(
            f.run.clone(),
            PatchRun {
                status: Some("running".into()),
                params: Some(Default::default()),
                tags: None,
            },
        )
        .await
        .unwrap();
    assert_eq!(live.cursor(), cursor);
    let catalog = f.state.db.catalog().await.unwrap();
    assert_eq!(catalog.metric_seq, 1);
    assert_eq!(catalog.series[0].count, 1);
}

#[tokio::test]
async fn catalog_image_compat_and_poll_abort_reset_contract() {
    let f = Fixture::new().await;
    let live = f.state.db.live();
    let cursor = live.cursor();
    let pending = tokio::spawn(request(
        f.app.clone(),
        "POST",
        "/api/live",
        json!({"cursor":cursor}),
        true,
    ));
    tokio::task::yield_now().await;
    pending.abort();
    let _ = pending.await;
    f.state
        .db
        .patch_run(
            f.run.clone(),
            PatchRun {
                status: Some("finished".into()),
                params: None,
                tags: None,
            },
        )
        .await
        .unwrap();
    assert_eq!(
        f.poll(&cursor).await["changes"],
        json!([{"kind":"catalog"}])
    );
    let cursor = live.cursor();
    let image = f
        .state
        .db
        .insert_image(
            f.run.clone(),
            ImageQuery {
                key: "preview".into(),
                step: 0,
                timestamp: 0,
            },
            "image/png".into(),
            vec![1, 2, 3],
        )
        .await
        .unwrap();
    assert_eq!(
        f.poll(&cursor).await["changes"],
        json!([{"kind":"image","runId":f.run,"key":"preview"},{"kind":"catalog"}])
    );
    assert_eq!(
        f.state.db.images(f.run.clone(), None).await.unwrap()[0].id,
        image.id
    );
    let experiment = f
        .json(
            "POST",
            "/api/2.0/mlflow/experiments/create",
            json!({"name":"compat-live"}),
        )
        .await;
    let cursor = live.cursor();
    f.json(
        "POST",
        "/api/2.0/mlflow/runs/create",
        json!({"experiment_id":experiment["experiment_id"], "start_time":1}),
    )
    .await;
    assert!(
        f.poll(&cursor).await["changes"]
            .as_array()
            .unwrap()
            .iter()
            .any(|v| v["kind"] == "catalog")
    );
    let reset = f.poll("another-process:0").await;
    assert_eq!(reset["reset"], true);
    assert_eq!(reset["changes"], json!([]));
    let future = format!(
        "{}:18446744073709551615",
        live.cursor().split(':').next().unwrap()
    );
    assert_eq!(f.poll(&future).await["reset"], true);
    let cursor = live.cursor();
    for _ in 0..4097 {
        live.publish(Change::Catalog);
    }
    assert_eq!(f.poll(&cursor).await["reset"], true);
}

#[tokio::test]
async fn durable_intake_is_silent_until_query_commit_and_replay_is_silent() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::open(dir.path()).unwrap();
    let run = create_run(&db).await;
    let live = db.live();
    let cursor = live.cursor();
    let ingest = DurableIngest::open(
        dir.path(),
        db.clone(),
        IngestOptions {
            paused: true,
            poll_interval_ms: 5,
            ..Default::default()
        },
    )
    .unwrap();
    let input = batch(&[("loss", 3, 20, 1.0), ("loss", 3, 10, 2.0)]);
    let receipt = ingest
        .submit(run.clone(), "batch".into(), input.clone())
        .await
        .unwrap();
    assert_eq!(receipt.state, "pending");
    assert_eq!(live.cursor(), cursor);
    assert_eq!(db.catalog().await.unwrap().metric_seq, 0);
    drop(ingest);
    let ingest = DurableIngest::open(
        dir.path(),
        db.clone(),
        IngestOptions {
            poll_interval_ms: 5,
            ..Default::default()
        },
    )
    .unwrap();
    let response = tokio::time::timeout(Duration::from_secs(5), live.poll(&cursor))
        .await
        .unwrap()
        .unwrap();
    assert!(!response.reset);
    assert_eq!(response.changes.len(), 1);
    assert!(matches!(
        &response.changes[0],
        Change::Metric {
            high: 2,
            count: 2,
            ..
        }
    ));
    let catalog = db.catalog().await.unwrap();
    assert_eq!(catalog.metric_seq, 2);
    assert_eq!(catalog.series[0].count, 2);
    let payload = serde_json::to_value(&response).unwrap();
    assert_eq!(
        payload["changes"][0]["runUpdatedAt"],
        catalog.runs[0].updated_at
    );
    assert_ne!(
        payload["changes"][0]["runUpdatedAt"],
        payload["changes"][0]["last"]["timestamp"]
    );
    let cursor = live.cursor();
    tokio::time::timeout(Duration::from_secs(3), async {
        while ingest
            .receipt(run.clone(), "batch".into())
            .await
            .unwrap()
            .state
            != "applied"
        {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    assert_eq!(
        ingest
            .submit(run.clone(), "batch".into(), input)
            .await
            .unwrap()
            .state,
        "applied"
    );
    assert_eq!(live.cursor(), cursor);
    drop(ingest);
    drop(db);
    let restarted = Database::open(dir.path()).unwrap();
    assert!(restarted.live().poll(&cursor).await.unwrap().reset);
}

#[tokio::test]
async fn catalog_watermark_and_summaries_share_one_sqlite_snapshot() {
    let f = Fixture::new().await;
    let db = f.state.db.clone();
    let run = f.run.clone();
    let writes = tokio::spawn(async move {
        for i in 0..30 {
            db.insert_metrics(run.clone(), batch(&[("x", i, i, 1.0), ("y", i, i, 2.0)]))
                .await
                .unwrap();
        }
    });
    for _ in 0..30 {
        let catalog = f.state.db.catalog().await.unwrap();
        let count: i64 = catalog.series.iter().map(|s| s.count).sum();
        assert_eq!(catalog.metric_seq, count);
        assert_eq!(catalog.metric_seq % 2, 0, "never expose half a batch");
    }
    writes.await.unwrap();
}
