use axum::{
    Router,
    body::{Body, Bytes},
    http::{HeaderMap, Request, StatusCode, header},
    response::{IntoResponse, Response},
};
use http_body_util::{BodyExt, Full};
use nset::{AppState, api, auth::Token, config::MAX_ACTIVE_WRITES, errors::ApiError};
use serde_json::{Value, json};
use std::{
    convert::Infallible,
    future::{Future, pending},
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    task::{Context, Poll, Waker},
};
use tower::ServiceExt;

struct TestApp {
    app: Router,
    state: AppState,
    _directory: tempfile::TempDir,
}
impl TestApp {
    fn new() -> Self {
        let directory = tempfile::tempdir().unwrap();
        let state = AppState::open(directory.path(), Token::new("test-secret").unwrap()).unwrap();
        Self {
            app: api::router(state.clone()),
            state,
            _directory: directory,
        }
    }
    async fn request(&self, method: &str, uri: &str, body: Body) -> Response {
        self.app
            .clone()
            .oneshot(request(method, uri, body, Some("test-secret")))
            .await
            .unwrap()
    }
}
fn request(method: &str, uri: &str, body: Body, token: Option<&str>) -> Request<Body> {
    let mut request = Request::builder()
        .method(method)
        .uri(uri)
        .header(header::CONTENT_TYPE, "application/json");
    if let Some(token) = token {
        request = request.header(header::AUTHORIZATION, format!("Bearer {token}"));
    }
    request.body(body).unwrap()
}
fn tracked_body() -> (Body, Arc<AtomicUsize>) {
    let polls = Arc::new(AtomicUsize::new(0));
    let count = polls.clone();
    let body = Full::new(Bytes::from_static(b"{}"));
    let body = body.map_frame(move |frame| {
        count.fetch_add(1, Ordering::SeqCst);
        frame
    });
    (Body::new(body), polls)
}
async fn json_body(response: Response) -> Value {
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    serde_json::from_slice(&bytes).unwrap()
}

#[tokio::test]
async fn saturated_writes_fail_before_body_extraction_with_busy_headers() {
    let app = TestApp::new();
    assert_eq!(app.state.write_slots.available_permits(), MAX_ACTIVE_WRITES);
    let _held = app
        .state
        .write_slots
        .try_acquire_many(MAX_ACTIVE_WRITES as u32)
        .unwrap();
    for (method, uri) in [
        ("POST", "/api/experiments"),
        ("POST", "/api/runs"),
        ("PATCH", "/api/runs/missing"),
        ("POST", "/api/runs/missing/metrics"),
        ("POST", "/api/runs/missing/images?key=image"),
    ] {
        let (body, polls) = tracked_body();
        let response = app.request(method, uri, body).await;
        assert_eq!(polls.load(Ordering::SeqCst), 0, "{method} {uri}");
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(response.headers()[header::RETRY_AFTER], "1");
        assert_eq!(response.headers()[header::CONTENT_TYPE], "application/json");
        assert_eq!(
            response.headers()[header::CACHE_CONTROL],
            "private, no-store"
        );
        assert_eq!(
            response.headers()[header::X_CONTENT_TYPE_OPTIONS],
            "nosniff"
        );
        assert_eq!(response.headers()[header::X_FRAME_OPTIONS], "DENY");
        assert!(
            response
                .headers()
                .contains_key(header::CONTENT_SECURITY_POLICY)
        );
        assert_eq!(
            json_body(response).await,
            json!({"error":"server busy; retry later"})
        );
    }
    assert_eq!(app.state.write_slots.available_permits(), 0);
}

#[tokio::test]
async fn saturated_writes_do_not_block_reads_health_assets_or_route_errors() {
    let app = TestApp::new();
    let _held = app
        .state
        .write_slots
        .try_acquire_many(MAX_ACTIVE_WRITES as u32)
        .unwrap();
    for uri in [
        "/api/health",
        "/api/experiments",
        "/api/runs",
        "/api/catalog",
    ] {
        let response = app.request("GET", uri, Body::empty()).await;
        assert_eq!(response.status(), StatusCode::OK, "{uri}");
        assert!(!response.headers().contains_key(header::RETRY_AFTER));
    }
    let response = app.request("GET", "/", Body::empty()).await;
    assert_ne!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    assert!(!response.headers().contains_key(header::RETRY_AFTER));
    for (method, uri, status) in [
        ("POST", "/api/health", StatusCode::METHOD_NOT_ALLOWED),
        ("POST", "/api/missing", StatusCode::NOT_FOUND),
        (
            "DELETE",
            "/api/runs/missing",
            StatusCode::METHOD_NOT_ALLOWED,
        ),
    ] {
        let (body, polls) = tracked_body();
        let response = app.request(method, uri, body).await;
        assert_eq!(polls.load(Ordering::SeqCst), 0);
        assert_eq!(response.status(), status);
        assert!(!response.headers().contains_key(header::RETRY_AFTER));
    }
}

#[tokio::test]
async fn authentication_precedes_admission_even_when_saturated() {
    let app = TestApp::new();
    let _held = app
        .state
        .write_slots
        .try_acquire_many(MAX_ACTIVE_WRITES as u32)
        .unwrap();
    for (method, uri) in [
        ("POST", "/api/experiments"),
        ("PATCH", "/api/runs/missing"),
        ("GET", "/api/health"),
    ] {
        for token in [None, Some("wrong")] {
            let (body, polls) = tracked_body();
            let response = app
                .app
                .clone()
                .oneshot(request(method, uri, body, token))
                .await
                .unwrap();
            assert_eq!(polls.load(Ordering::SeqCst), 0);
            assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
            assert_eq!(response.headers()[header::WWW_AUTHENTICATE], "Bearer");
            assert!(!response.headers().contains_key(header::RETRY_AFTER));
            assert_eq!(json_body(response).await, json!({"error":"unauthorized"}));
        }
    }
}

#[tokio::test]
async fn extraction_validation_and_completed_handlers_release_admission() {
    let app = TestApp::new();
    let _held = app
        .state
        .write_slots
        .try_acquire_many((MAX_ACTIVE_WRITES - 1) as u32)
        .unwrap();
    for (method, uri, body, status) in [
        ("POST", "/api/experiments", "{", StatusCode::BAD_REQUEST),
        (
            "POST",
            "/api/experiments",
            r#"{"name":""}"#,
            StatusCode::BAD_REQUEST,
        ),
        ("PATCH", "/api/runs/missing", "{", StatusCode::BAD_REQUEST),
        ("PATCH", "/api/runs/missing", "{}", StatusCode::NOT_FOUND),
    ] {
        let response = app.request(method, uri, Body::from(body)).await;
        assert_eq!(response.status(), status);
        assert!(!response.headers().contains_key(header::RETRY_AFTER));
        assert_eq!(app.state.write_slots.available_permits(), 1);
        assert!(json_body(response).await["error"].is_string());
    }
    let response = app
        .request(
            "POST",
            "/api/experiments",
            Body::from(r#"{"name":"admission"}"#),
        )
        .await;
    assert_eq!(response.status(), StatusCode::CREATED);
    assert!(!response.headers().contains_key(header::RETRY_AFTER));
    // Released when the handler responds, not when the response body is consumed.
    assert_eq!(app.state.write_slots.available_permits(), 1);
    let experiment = json_body(response).await;
    let response = app
        .request(
            "POST",
            "/api/runs",
            Body::from(json!({"experiment_id":experiment["id"],"name":"run"}).to_string()),
        )
        .await;
    assert_eq!(response.status(), StatusCode::CREATED);
    assert_eq!(app.state.write_slots.available_permits(), 1);
    let run = json_body(response).await;
    let response = app
        .request(
            "PATCH",
            &format!("/api/runs/{}", run["id"].as_str().unwrap()),
            Body::from(r#"{"status":"finished"}"#),
        )
        .await;
    assert_eq!(response.status(), StatusCode::OK);
    assert!(!response.headers().contains_key(header::RETRY_AFTER));
    assert_eq!(app.state.write_slots.available_permits(), 1);
    assert_eq!(json_body(response).await["status"], "finished");
}

#[tokio::test]
async fn cancellation_during_extraction_releases_admission() {
    let app = TestApp::new();
    let _held = app
        .state
        .write_slots
        .try_acquire_many((MAX_ACTIVE_WRITES - 1) as u32)
        .unwrap();
    for (method, uri) in [("POST", "/api/experiments"), ("PATCH", "/api/runs/missing")] {
        // Extraction cannot complete until trailers arrive. Poll explicitly and
        // cancel by dropping: no spawned task, sleeps, or scheduler timing races.
        let body = Full::new(Bytes::from_static(b"{}"))
            .with_trailers(pending::<Option<Result<HeaderMap, Infallible>>>());
        let mut response = Box::pin(app.app.clone().oneshot(request(
            method,
            uri,
            Body::new(body),
            Some("test-secret"),
        )));
        assert!(matches!(
            response
                .as_mut()
                .poll(&mut Context::from_waker(Waker::noop())),
            Poll::Pending
        ));
        assert_eq!(app.state.write_slots.available_permits(), 0);
        let (body, polls) = tracked_body();
        let rejected = app.request(method, uri, body).await;
        assert_eq!(rejected.status(), StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(polls.load(Ordering::SeqCst), 0);
        drop(response);
        assert_eq!(app.state.write_slots.available_permits(), 1);
    }
    let response = app
        .request(
            "POST",
            "/api/experiments",
            Body::from(r#"{"name":"after-cancel"}"#),
        )
        .await;
    assert_eq!(response.status(), StatusCode::CREATED);
    assert_eq!(app.state.write_slots.available_permits(), 1);
}

#[test]
fn retry_after_is_only_added_to_explicit_busy_errors() {
    assert_eq!(
        ApiError::busy().into_response().headers()[header::RETRY_AFTER],
        "1"
    );
    for error in [
        ApiError::bad("invalid input"),
        ApiError::missing(),
        ApiError(StatusCode::INTERNAL_SERVER_ERROR, "internal server error"),
        ApiError(StatusCode::SERVICE_UNAVAILABLE, "maintenance"),
        ApiError(StatusCode::BAD_REQUEST, "server busy; retry later"),
    ] {
        assert!(
            !error
                .into_response()
                .headers()
                .contains_key(header::RETRY_AFTER)
        );
    }
}
