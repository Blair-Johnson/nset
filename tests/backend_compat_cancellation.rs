use axum::{
    Router,
    body::{Body, to_bytes},
    http::{Request, StatusCode},
};
use nset::{AppState, api, auth::Token};
use serde_json::{Value, json};
use std::time::Duration;
use tower::ServiceExt;

async fn call(router: Router, path: &str, value: Value) -> (StatusCode, Value) {
    let response = router
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(path)
                .header("authorization", "Bearer cancellation-test")
                .header("content-type", "application/json")
                .body(Body::from(serde_json::to_vec(&value).unwrap()))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let body = to_bytes(response.into_body(), 1024 * 1024).await.unwrap();
    (status, serde_json::from_slice(&body).unwrap())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cancelled_waiter_keeps_operation_lock_until_queued_actor_write_finishes() {
    let directory = tempfile::tempdir().unwrap();
    let state = AppState::open(directory.path(), Token::new("cancellation-test").unwrap()).unwrap();
    let router = api::router(state.clone());
    let (status, experiment) = call(
        router.clone(),
        "/api/2.0/mlflow/experiments/create",
        json!({"name":"cancelled"}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let (status, run) = call(
        router.clone(),
        "/api/2.0/mlflow/runs/create",
        json!({"experiment_id":experiment["experiment_id"],"start_time":1}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let rid = run["run"]["info"]["run_id"].as_str().unwrap().to_owned();
    let capacity = state.write_slots.available_permits();
    let connection = rusqlite::Connection::open(directory.path().join("nset.sqlite3")).unwrap();
    connection.execute_batch("BEGIN IMMEDIATE").unwrap();
    let first = tokio::spawn(call(
        router.clone(),
        "/api/2.0/mlflow/runs/log-batch",
        json!({"run_id":rid,"params":[{"key":"immutable","value":"first"}]}),
    ));
    tokio::time::timeout(Duration::from_secs(2), async {
        while state.write_slots.available_permits() == capacity {
            tokio::time::sleep(Duration::from_millis(2)).await;
        }
    })
    .await
    .unwrap();
    // The per-run operation is blocked in the SQLite writer, not awaiting a body.
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(
        tokio::time::timeout(
            Duration::from_millis(20),
            state.compat.lock(&format!("mlflow:run:{rid}"))
        )
        .await
        .is_err()
    );
    first.abort();
    let _ = first.await;
    assert_eq!(
        state.write_slots.available_permits(),
        capacity - 1,
        "a cancelled HTTP waiter must not release an executing operation's permit"
    );
    let second = tokio::spawn(call(
        router.clone(),
        "/api/2.0/mlflow/runs/log-batch",
        json!({"run_id":rid,"params":[{"key":"immutable","value":"second"}]}),
    ));
    tokio::time::sleep(Duration::from_millis(30)).await;
    connection.execute_batch("ROLLBACK").unwrap();
    let (status, _) = tokio::time::timeout(Duration::from_secs(5), second)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        status,
        StatusCode::BAD_REQUEST,
        "retry must observe the first immutable value"
    );
    let native = state.db.runs(None).await.unwrap();
    assert_eq!(native.len(), 1);
    assert_eq!(native[0].params["immutable"], "first");
    assert_eq!(state.write_slots.available_permits(), capacity);
}
