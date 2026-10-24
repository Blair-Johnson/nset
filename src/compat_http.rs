//! Same-listener compatibility boundary. No transport or alternate server runtime.
use crate::{AppState, config::MAX_BODY, errors::ApiError};
use axum::{
    Json, Router,
    body::to_bytes,
    extract::{OriginalUri, Query, Request, State},
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Response},
    routing::any,
};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use std::{collections::HashMap, io::Read, time::Duration};

pub fn api_routes() -> Router<AppState> {
    Router::new()
        .route("/2.0", any(handle))
        .route("/2.0/{*path}", any(handle))
}
pub fn root_routes() -> Router<AppState> {
    let mut router = Router::new();
    for prefix in [
        "/graphql",
        "/files",
        "/artifacts",
        "/ajax-api",
        "/compat",
        "/wandb",
    ] {
        router = router
            .route(prefix, any(handle))
            .route(&format!("{prefix}/{{*path}}"), any(handle));
    }
    router
}

fn authorized(headers: &HeaderMap, state: &AppState) -> bool {
    let mut values = headers.get_all(header::AUTHORIZATION).iter();
    let Some(value) = values.next().and_then(|v| v.to_str().ok()) else {
        return false;
    };
    if values.next().is_some() {
        return false;
    }
    if let Some(token) = value.strip_prefix("Bearer ") {
        return state.token.matches(token);
    }
    value
        .strip_prefix("Basic ")
        .and_then(|encoded| STANDARD.decode(encoded).ok())
        .and_then(|bytes| String::from_utf8(bytes).ok())
        .and_then(|decoded| decoded.strip_prefix("api:").map(str::to_owned))
        .is_some_and(|token| state.token.matches(&token))
}

fn error(path: &str, status: StatusCode, message: &'static str) -> Response {
    let default_code = match status {
        StatusCode::UNAUTHORIZED => "UNAUTHENTICATED",
        StatusCode::NOT_FOUND => "RESOURCE_DOES_NOT_EXIST",
        StatusCode::CONFLICT => "RESOURCE_CONFLICT",
        StatusCode::PAYLOAD_TOO_LARGE => "REQUEST_TOO_LARGE",
        StatusCode::SERVICE_UNAVAILABLE
        | StatusCode::TOO_MANY_REQUESTS
        | StatusCode::GATEWAY_TIMEOUT => "TEMPORARILY_UNAVAILABLE",
        _ if status.is_server_error() => "INTERNAL_ERROR",
        _ => "INVALID_PARAMETER_VALUE",
    };
    // Protocol ports may supply an explicit vendor code without expanding the
    // native API's small error type or exposing database details.
    let (code, message) = message
        .split_once(": ")
        .filter(|(code, _)| {
            !code.is_empty() && code.bytes().all(|b| b.is_ascii_uppercase() || b == b'_')
        })
        .unwrap_or((default_code, message));
    let body = if path.starts_with("/graphql") {
        json!({"errors":[{"message":message,"extensions":{"code":code}}]})
    } else {
        json!({"error_code":code,"message":message})
    };
    let mut response = (status, Json(body)).into_response();
    if status == StatusCode::UNAUTHORIZED {
        response
            .headers_mut()
            .insert(header::WWW_AUTHENTICATE, "Bearer".parse().unwrap());
    }
    if status == StatusCode::SERVICE_UNAVAILABLE || status == StatusCode::TOO_MANY_REQUESTS {
        response
            .headers_mut()
            .insert(header::RETRY_AFTER, "1".parse().unwrap());
    }
    response
}

async fn handle(
    State(state): State<AppState>,
    OriginalUri(uri): OriginalUri,
    request: Request,
) -> Response {
    let path = uri.path().to_owned();
    // Authentication precedes admission, content checks, and polling any body.
    if !authorized(request.headers(), &state) {
        return error(&path, StatusCode::UNAUTHORIZED, "unauthorized");
    }
    let method = request.method().as_str().to_owned();
    if method != "GET" && method != "POST" {
        return error(
            &path,
            StatusCode::BAD_REQUEST,
            "unsupported compatibility operation",
        );
    }
    let is_mlflow = path.starts_with("/api/2.0/mlflow/");
    let is_wandb =
        path == "/graphql" || (path.starts_with("/files/") && path.ends_with("/file_stream"));
    if !is_mlflow && !is_wandb {
        return error(
            &path,
            StatusCode::BAD_REQUEST,
            "unsupported compatibility or file operation",
        );
    }
    let Ok(permit) = state.write_slots.clone().try_acquire_owned() else {
        return error(
            &path,
            StatusCode::SERVICE_UNAVAILABLE,
            "server is busy; retry the same operation",
        );
    };
    if request
        .headers()
        .get_all(header::CONTENT_ENCODING)
        .iter()
        .count()
        > 1
    {
        return error(
            &path,
            StatusCode::BAD_REQUEST,
            "multiple content encodings are unsupported",
        );
    }
    let query = match Query::<HashMap<String, String>>::try_from_uri(&uri) {
        Ok(Query(query)) => query,
        Err(_) => return error(&path, StatusCode::BAD_REQUEST, "invalid query string"),
    };
    let encoding = request
        .headers()
        .get(header::CONTENT_ENCODING)
        .map(|v| v.to_str().unwrap_or("invalid").to_owned())
        .unwrap_or_default();
    if !matches!(encoding.as_str(), "" | "identity" | "gzip") {
        return error(
            &path,
            StatusCode::BAD_REQUEST,
            "unsupported content encoding",
        );
    }
    let decoded = tokio::time::timeout(Duration::from_secs(10), async {
        let bytes = to_bytes(request.into_body(), MAX_BODY)
            .await
            .map_err(|_| ApiError(StatusCode::PAYLOAD_TOO_LARGE, "request body exceeds 32 MiB"))?;
        let decoded = if encoding == "gzip" {
            let mut output = Vec::new();
            flate2::read::MultiGzDecoder::new(bytes.as_ref())
                .take(MAX_BODY as u64 + 1)
                .read_to_end(&mut output)
                .map_err(|_| ApiError::bad("invalid gzip body"))?;
            if output.len() > MAX_BODY {
                return Err(ApiError(
                    StatusCode::PAYLOAD_TOO_LARGE,
                    "decoded body exceeds 32 MiB",
                ));
            }
            output
        } else {
            bytes.to_vec()
        };
        let body: Value = if decoded.is_empty() {
            json!({})
        } else {
            serde_json::from_slice(&decoded).map_err(|_| ApiError::bad("invalid JSON body"))?
        };
        if !body.is_object() {
            return Err(ApiError::bad("request body must be a JSON object"));
        }
        Ok(body)
    })
    .await;
    let body = match decoded {
        Ok(Ok(body)) => body,
        Ok(Err(ApiError(status, message))) => return error(&path, status, message),
        Err(_) => {
            return error(
                &path,
                StatusCode::SERVICE_UNAVAILABLE,
                "body intake timed out",
            );
        }
    };
    let operation_path = path.clone();
    // Once an operation can write durable state, cancellation must not release
    // its run lock while an accepted DB actor job continues. A detached task owns
    // the admission permit and operation locks through completion; dropping or
    // timing out this HTTP waiter does not abort it. Shutdown drains all permits.
    let operation = tokio::spawn(async move {
        let _permit = permit;
        if is_mlflow {
            crate::compat::mlflow::handle(&state.compat, &method, &operation_path, body, &query)
                .await
        } else {
            crate::compat::wandb::handle(&state.compat, &method, &operation_path, body, &query)
                .await
        }
    });
    match tokio::time::timeout(Duration::from_secs(35), operation).await {
        Ok(Ok(Ok(body))) => Json(body).into_response(),
        Ok(Ok(Err(ApiError(status, message)))) => error(&path, status, message),
        Ok(Err(failure)) => {
            tracing::error!(%failure, "compatibility operation failed");
            error(
                &path,
                StatusCode::INTERNAL_SERVER_ERROR,
                "internal server error",
            )
        }
        Err(_) => error(
            &path,
            StatusCode::SERVICE_UNAVAILABLE,
            "operation is still completing; retry the same operation",
        ),
    }
}
