use crate::{
    AppState, assets, auth,
    config::MAX_BODY,
    errors::{ApiError, Result},
    models::*,
};
use axum::{
    Json, Router,
    body::Bytes,
    extract::{DefaultBodyLimit, Path, Query, Request, State},
    http::{HeaderMap, StatusCode, header},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, patch, post, put},
};
use serde::Deserialize;
use serde_json::{Value, json};

pub fn router(state: AppState) -> Router {
    // Only supported writes pass through admission. Authentication below wraps
    // this layer, so unauthorized requests return 401 even when slots are full.
    let admission = middleware::from_fn_with_state(state.clone(), admit_write);
    let writes = Router::new()
        .route(
            "/experiments",
            post(create_experiment).route_layer(admission.clone()),
        )
        .route("/runs", post(create_run).route_layer(admission.clone()))
        .route(
            "/runs/{id}",
            patch(patch_run).route_layer(admission.clone()),
        )
        .route(
            "/runs/{id}/metrics",
            post(insert_metrics).route_layer(admission.clone()),
        )
        .route(
            "/runs/{id}/images",
            post(insert_image).route_layer(admission.clone()),
        )
        .route(
            "/runs/{id}/ingest/{batch_id}",
            put(durable_submit).route_layer(admission),
        );
    let api = Router::new()
        .route("/health", get(|| async { Json(json!({"status":"ok"})) }))
        .route("/catalog", get(catalog))
        .route("/runs/{id}/ingest/{batch_id}", get(durable_receipt))
        .route("/ingest/status", get(durable_status))
        .route("/experiments", get(experiments))
        .route("/runs", get(runs))
        .route("/runs/{id}", get(run))
        .route("/runs/{id}/metrics", get(metrics))
        .route("/runs/{id}/metric-keys", get(metric_keys))
        .route("/runs/{id}/images", get(images))
        .route("/images/{id}/content", get(image_content))
        .merge(writes)
        .fallback(|| async { ApiError::missing() })
        .layer(middleware::from_fn_with_state(
            state.clone(),
            auth::require_token,
        ))
        .layer(DefaultBodyLimit::max(MAX_BODY))
        .layer(middleware::from_fn(normalize_errors));
    Router::new()
        .nest("/api", api.merge(crate::compat_http::api_routes()))
        .merge(crate::compat_http::root_routes())
        .fallback(assets::serve)
        .layer(middleware::from_fn(security_headers))
        .with_state(state)
}
async fn admit_write(State(state): State<AppState>, request: Request, next: Next) -> Response {
    let Ok(permit) = state.write_slots.try_acquire() else {
        return ApiError::busy().into_response();
    };
    // Acquire before extractors poll the body; retain until the handler returns.
    // Dropping this future also releases the permit, but does not cancel DB jobs
    // that were already accepted. A lost response does not imply a failed write.
    let response = next.run(request).await;
    drop(permit);
    response
}
async fn security_headers(request: Request, next: Next) -> Response {
    let mut response = next.run(request).await;
    let headers = response.headers_mut();
    // Bundled scripts only; uPlot needs inline styles and OSD displays blob images.
    headers.insert(
        header::CONTENT_SECURITY_POLICY,
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"
            .parse()
            .unwrap(),
    );
    headers.insert(header::REFERRER_POLICY, "no-referrer".parse().unwrap());
    headers.insert(header::X_FRAME_OPTIONS, "DENY".parse().unwrap());
    headers.insert(header::X_CONTENT_TYPE_OPTIONS, "nosniff".parse().unwrap());
    response
}
async fn normalize_errors(request: Request, next: Next) -> Response {
    let mut response = next.run(request).await;
    if (response.status().is_client_error() || response.status().is_server_error())
        && response
            .headers()
            .get(header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            != Some("application/json")
    {
        let status = response.status();
        response = ApiError(
            status,
            match status {
                StatusCode::PAYLOAD_TOO_LARGE => "request body exceeds 32 MiB",
                StatusCode::METHOD_NOT_ALLOWED => "method not allowed",
                StatusCode::NOT_FOUND => "resource not found",
                StatusCode::UNSUPPORTED_MEDIA_TYPE => "unsupported content type",
                _ => "invalid request",
            },
        )
        .into_response();
    }
    response
        .headers_mut()
        .insert(header::X_CONTENT_TYPE_OPTIONS, "nosniff".parse().unwrap());
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, "private, no-store".parse().unwrap());
    response
}
async fn catalog(State(state): State<AppState>) -> Result<Json<Catalog>> {
    Ok(Json(state.db.catalog().await?))
}
async fn experiments(State(state): State<AppState>) -> Result<Json<Value>> {
    Ok(Json(json!({"experiments":state.db.experiments().await?})))
}
async fn create_experiment(
    State(state): State<AppState>,
    Json(input): Json<NewExperiment>,
) -> Result<Response> {
    let (experiment, created) = state.db.create_experiment(input.name).await?;
    Ok((
        if created {
            StatusCode::CREATED
        } else {
            StatusCode::OK
        },
        Json(experiment),
    )
        .into_response())
}
#[derive(Deserialize)]
struct RunQuery {
    experiment_id: Option<String>,
}
async fn runs(State(state): State<AppState>, Query(query): Query<RunQuery>) -> Result<Json<Value>> {
    Ok(Json(
        json!({"runs":state.db.runs(query.experiment_id).await?}),
    ))
}
async fn create_run(State(state): State<AppState>, Json(input): Json<NewRun>) -> Result<Response> {
    Ok((StatusCode::CREATED, Json(state.db.create_run(input).await?)).into_response())
}
async fn run(State(state): State<AppState>, Path(id): Path<String>) -> Result<Json<Run>> {
    Ok(Json(state.db.run(id).await?))
}
async fn patch_run(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(input): Json<PatchRun>,
) -> Result<Json<Run>> {
    Ok(Json(state.db.patch_run(id, input).await?))
}
async fn insert_metrics(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(input): Json<MetricBatch>,
) -> Result<Json<Value>> {
    Ok(Json(
        json!({"inserted":state.db.insert_metrics(id,input).await?}),
    ))
}
async fn metric_keys(State(state): State<AppState>, Path(id): Path<String>) -> Result<Json<Value>> {
    Ok(Json(json!({"keys":state.db.metric_keys(id).await?})))
}
async fn metrics(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(query): Query<MetricQuery>,
) -> Result<Json<MetricPage>> {
    Ok(Json(state.db.metrics(id, query).await?))
}
#[derive(Deserialize)]
struct ImageFilter {
    key: Option<String>,
}
async fn images(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(query): Query<ImageFilter>,
) -> Result<Json<Value>> {
    Ok(Json(json!({"images":state.db.images(id,query.key).await?})))
}
async fn insert_image(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(query): Query<ImageQuery>,
    headers: HeaderMap,
    bytes: Bytes,
) -> Result<Response> {
    name(&query.key)?;
    safe(query.step)?;
    safe(query.timestamp)?;
    let content_type = headers
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    let format = match content_type {
        "image/png" => image::ImageFormat::Png,
        "image/jpeg" => image::ImageFormat::Jpeg,
        "image/webp" => image::ImageFormat::WebP,
        _ => {
            return Err(ApiError(
                StatusCode::UNSUPPORTED_MEDIA_TYPE,
                "only raw PNG, JPEG, and WebP are supported",
            ));
        }
    };
    let content_type = content_type.to_owned();
    // Avoid decoding even a valid large image for an unknown run.
    state.db.run(id.clone()).await?;
    let permit = state
        .image_slots
        .clone()
        .try_acquire_owned()
        .map_err(|_| ApiError::busy())?;
    let bytes = tokio::task::spawn_blocking(move || -> Result<Vec<u8>> {
        let _permit = permit;
        if image::guess_format(&bytes).ok() != Some(format) {
            return Err(ApiError::bad("image content type does not match bytes"));
        }
        let mut reader = image::ImageReader::with_format(std::io::Cursor::new(&bytes), format);
        let mut limits = image::Limits::default();
        limits.max_image_width = Some(32768);
        limits.max_image_height = Some(32768);
        limits.max_alloc = Some(256 * 1024 * 1024);
        reader.limits(limits);
        // Full decode, not just dimensions: truncated/header-only files must fail.
        let decoded = reader
            .decode()
            .map_err(|_| ApiError::bad("invalid, corrupt, or oversized image"))?;
        if decoded.width() == 0 || decoded.height() == 0 {
            return Err(ApiError::bad("empty image"));
        }
        Ok(bytes.to_vec())
    })
    .await
    .map_err(ApiError::internal)??;
    Ok((
        StatusCode::CREATED,
        Json(
            state
                .db
                .insert_image(id, query, content_type, bytes)
                .await?,
        ),
    )
        .into_response())
}
async fn image_content(State(state): State<AppState>, Path(id): Path<String>) -> Result<Response> {
    let (image, bytes) = state.db.image_content(id).await?;
    let content_type = match image.content_type.as_str() {
        "image/png" => "image/png",
        "image/jpeg" => "image/jpeg",
        "image/webp" => "image/webp",
        _ => return Err(ApiError::internal("invalid stored content type")),
    };
    Ok((
        [
            (header::CONTENT_TYPE, content_type),
            (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
            (header::CACHE_CONTROL, "private, no-store"),
        ],
        bytes,
    )
        .into_response())
}

async fn durable_submit(
    State(state): State<AppState>,
    Path((run_id, batch_id)): Path<(String, String)>,
    Json(batch): Json<MetricBatch>,
) -> Result<Response> {
    let receipt = state.ingest.submit(run_id, batch_id, batch).await?;
    Ok((StatusCode::ACCEPTED, Json(receipt)).into_response())
}

async fn durable_receipt(
    State(state): State<AppState>,
    Path((run_id, batch_id)): Path<(String, String)>,
) -> Result<Json<crate::ingest::IngestReceipt>> {
    Ok(Json(state.ingest.receipt(run_id, batch_id).await?))
}

async fn durable_status(
    State(state): State<AppState>,
) -> Result<Json<crate::ingest::IngestStatus>> {
    Ok(Json(state.ingest.status().await?))
}
