use axum::{
    Router,
    body::{Body, to_bytes},
    http::{Request, StatusCode},
};
use nset::{AppState, api, auth::Token, db::Database, models::*};
use serde_json::{Value, json};
use std::time::Duration;
use tower::ServiceExt;

struct Fixture {
    app: Router,
    state: AppState,
    run: String,
    _dir: tempfile::TempDir,
}
impl Fixture {
    async fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let state = AppState::open(dir.path(), Token::new("policy-secret").unwrap()).unwrap();
        let run = create_run(&state.db).await;
        Self {
            app: api::router(state.clone()),
            state,
            run,
            _dir: dir,
        }
    }
    async fn request(&self, method: &str, uri: &str, body: Value) -> (StatusCode, Value) {
        let response = self
            .app
            .clone()
            .oneshot(
                Request::builder()
                    .method(method)
                    .uri(uri)
                    .header("authorization", "Bearer policy-secret")
                    .header("content-type", "application/json")
                    .body(Body::from(serde_json::to_vec(&body).unwrap()))
                    .unwrap(),
            )
            .await
            .unwrap();
        let status = response.status();
        let bytes = to_bytes(response.into_body(), 1024 * 1024).await.unwrap();
        (
            status,
            serde_json::from_slice(&bytes)
                .unwrap_or_else(|_| json!(String::from_utf8_lossy(&bytes))),
        )
    }
    async fn json(&self, method: &str, uri: &str, body: Value) -> Value {
        let (status, body) = self.request(method, uri, body).await;
        assert_eq!(status, StatusCode::OK, "{uri}: {body}");
        body
    }
    async fn history(&self, suffix: &str) -> Value {
        self.json(
            "GET",
            &format!("/api/runs/{}/metrics?key=a{suffix}", self.run),
            Value::Null,
        )
        .await
    }
    async fn insert(&self, points: &[(&str, i64, i64, f64)]) {
        self.state
            .db
            .insert_metrics(self.run.clone(), batch(points))
            .await
            .unwrap();
    }
}
async fn create_run(db: &Database) -> String {
    let (experiment, _) = db.create_experiment("policy".into()).await.unwrap();
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
fn seqs(page: &Value) -> Vec<i64> {
    page["points"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| p["seq"].as_i64().unwrap())
        .collect()
}

#[tokio::test]
async fn raw_retention_and_latest_winners_use_seq_not_timestamp_or_step() {
    let f = Fixture::new().await;
    f.insert(&[
        ("a", 8, 100, 1.0),
        ("a", 1, 900, 2.0),
        ("a", 8, 1, 3.0),
        ("a", 1, 900, 4.0),
    ])
    .await;
    let raw = f.history("").await;
    assert_eq!(raw, f.history("&policy=all").await);
    assert_eq!(seqs(&raw), vec![1, 2, 3, 4]);
    assert_eq!(raw["total"], 4);
    let latest = f.history("&policy=latest-per-step").await;
    assert_eq!(seqs(&latest), vec![3, 4]);
    assert_eq!(latest["total"], 2);
    assert_eq!(latest["points"][0]["step"], 8);
    assert_eq!(latest["points"][0]["timestamp"], 1);
    assert_eq!(latest["points"][1]["value"], 4.0);
    assert_eq!(
        f.history("").await,
        raw,
        "projection never mutates stored rows"
    );
}

#[tokio::test]
async fn history_snapshot_paging_keeps_old_winners_and_projection_total() {
    let f = Fixture::new().await;
    f.insert(&[
        ("a", 8, 100, 1.0),
        ("b", 8, 5, 9.0),
        ("a", 1, 50, 2.0),
        ("a", 8, 0, 3.0),
    ])
    .await;
    let first = f.history("&policy=latest-per-step&limit=1").await;
    assert_eq!(seqs(&first), vec![3]);
    assert_eq!(first["next_after"], 3);
    assert_eq!(first["snapshot"], 4);
    assert_eq!(first["total"], 2);
    f.insert(&[("a", 8, 999, 4.0), ("a", 0, 999, 5.0)]).await;
    let next = f
        .history("&policy=latest-per-step&limit=1&after=3&snapshot=4")
        .await;
    assert_eq!(seqs(&next), vec![4]);
    assert_eq!(next["total"], 2, "total is not the remaining suffix count");
    assert_eq!(next["next_after"], Value::Null);
    assert_eq!(
        seqs(&f.history("&policy=latest-per-step&snapshot=3").await),
        vec![1, 3]
    );
    assert_eq!(
        seqs(
            &f.history("&policy=latest-per-step&snapshot=4&after=2")
                .await
        ),
        vec![3, 4]
    );
    assert_eq!(
        seqs(&f.history("&policy=latest-per-step&after=4").await),
        vec![5, 6]
    );
    let latest = f.history("&policy=latest-per-step").await;
    assert_eq!(seqs(&latest), vec![3, 5, 6]);
    assert_eq!(latest["total"], 3);
    let empty = f.history("&policy=latest-per-step&snapshot=0").await;
    assert_eq!(seqs(&empty), Vec::<i64>::new());
    assert_eq!(empty["total"], 0);
}

#[tokio::test]
async fn tail_mixed_policies_isolate_runs_keys_and_deliver_old_step_replacements() {
    let f = Fixture::new().await;
    let other = create_run(&f.state.db).await;
    f.insert(&[
        ("a", 8, 100, 1.0),
        ("b", 8, 100, 2.0),
        ("a", 8, 50, 3.0),
        ("b", 8, 50, 4.0),
        ("a", 1, 0, 5.0),
    ])
    .await;
    f.state
        .db
        .insert_metrics(
            other.clone(),
            batch(&[("a", 8, 1000, 6.0), ("a", 8, 0, 7.0)]),
        )
        .await
        .unwrap();
    let first = f
        .json(
            "POST",
            "/api/metrics/tail",
            json!({"limit":1,"series":[
                {"runId":f.run,"key":"a","after":0,"policy":"latest-per-step"},
                {"runId":f.run,"key":"b","after":0},
                {"runId":other,"key":"a","after":0,"policy":"latest-per-step"},
                {"runId":other,"key":"empty","after":0,"policy":"latest-per-step"}
            ]}),
        )
        .await;
    assert_eq!(seqs(&first["series"][0]), vec![3]);
    assert_eq!(first["series"][0]["snapshot"], 5);
    assert_eq!(first["series"][0]["next_after"], 3);
    assert_eq!(seqs(&first["series"][1]), vec![2]);
    assert_eq!(seqs(&first["series"][2]), vec![7]);
    assert_eq!(seqs(&first["series"][3]), Vec::<i64>::new());
    for stream in first["series"].as_array().unwrap() {
        assert!(stream.get("total").is_none());
    }
    f.insert(&[("a", 8, 1, 8.0), ("a", 1, 0, 9.0)]).await;
    let pinned = f
        .json(
            "POST",
            "/api/metrics/tail",
            json!({"limit":1,"series":[
                {"runId":f.run,"key":"a","after":3,"snapshot":5,"policy":"latest-per-step"}
            ]}),
        )
        .await;
    assert_eq!(seqs(&pinned["series"][0]), vec![5]);
    assert_eq!(pinned["series"][0]["next_after"], Value::Null);
    let tail = f
        .json(
            "POST",
            "/api/metrics/tail",
            json!({"limit":1,"series":[
                {"runId":f.run,"key":"a","after":5,"policy":"latest-per-step"}
            ]}),
        )
        .await;
    assert_eq!(seqs(&tail["series"][0]), vec![8]);
    assert_eq!(tail["series"][0]["next_after"], 8);
    assert_eq!(tail["series"][0]["points"][0]["step"], 8);
    let end = f
        .json(
            "POST",
            "/api/metrics/tail",
            json!({"series":[
                {"runId":f.run,"key":"a","after":8,"snapshot":9,"policy":"latest-per-step"}
            ]}),
        )
        .await;
    assert_eq!(seqs(&end["series"][0]), vec![9]);
    assert_eq!(end["series"][0]["next_after"], Value::Null);
    let unchanged = f
        .json(
            "POST",
            "/api/metrics/tail",
            json!({"series":[
                {"runId":f.run,"key":"a","after":9,"policy":"latest-per-step"},
                {"runId":f.run,"key":"b","after":0,"policy":"all"}
            ]}),
        )
        .await;
    assert_eq!(seqs(&unchanged["series"][0]), Vec::<i64>::new());
    assert_eq!(seqs(&unchanged["series"][1]), vec![2, 4]);
}

#[tokio::test]
async fn policy_literals_are_validated_on_both_routes() {
    let f = Fixture::new().await;
    for policy in ["latest", "LatestPerStep", "ALL", ""] {
        let (status, _) = f
            .request(
                "GET",
                &format!("/api/runs/{}/metrics?key=a&policy={policy}", f.run),
                Value::Null,
            )
            .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
    }
    for policy in [json!("unknown"), Value::Null, json!(1)] {
        let (status, _) = f
            .request(
                "POST",
                "/api/metrics/tail",
                json!({"series":[
                    {"runId":f.run,"key":"a","after":0,"policy":policy}
                ]}),
            )
            .await;
        assert!(
            status.is_client_error(),
            "invalid policy {policy}: {status}"
        );
        if policy.is_string() {
            assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
        }
    }
}

#[tokio::test]
async fn durable_retries_keep_receipt_and_seq_without_overriding_newer_winner() {
    let f = Fixture::new().await;
    let input = batch(&[("a", 8, 1000, 1.0)]);
    let receipt = f
        .state
        .ingest
        .submit(f.run.clone(), "original".into(), input.clone())
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(5), async {
        while f
            .state
            .ingest
            .receipt(f.run.clone(), "original".into())
            .await
            .unwrap()
            .state
            != "applied"
        {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    let original = f.history("").await;
    assert_eq!(seqs(&original), vec![1]);
    f.insert(&[("a", 8, 0, 2.0)]).await;
    let retry = f
        .state
        .ingest
        .submit(f.run.clone(), "original".into(), input)
        .await
        .unwrap();
    assert_eq!(retry.accepted_at, receipt.accepted_at);
    assert_eq!(retry.accepted, receipt.accepted);
    assert_eq!(retry.batch_id, receipt.batch_id);
    assert_eq!(retry.state, "applied");
    let raw = f.history("").await;
    assert_eq!(seqs(&raw), vec![1, 2]);
    assert_eq!(raw["points"][0], original["points"][0]);
    assert_eq!(seqs(&f.history("&policy=latest-per-step").await), vec![2]);
    let tail = f
        .json(
            "POST",
            "/api/metrics/tail",
            json!({"series":[
                {"runId":f.run,"key":"a","after":2,"policy":"latest-per-step"}
            ]}),
        )
        .await;
    assert_eq!(seqs(&tail["series"][0]), Vec::<i64>::new());
}
