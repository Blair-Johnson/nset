use crate::errors::ApiError;
use axum::{
    body::Body,
    extract::Request,
    http::{Method, StatusCode, header},
    response::{IntoResponse, Response},
};
use rust_embed::RustEmbed;
#[derive(RustEmbed)]
#[folder = "web/dist/"]
struct Assets;

pub async fn serve(request: Request) -> Response {
    if request.method() != Method::GET && request.method() != Method::HEAD {
        return ApiError(StatusCode::METHOD_NOT_ALLOWED, "method not allowed").into_response();
    }
    let Ok(decoded) = percent_encoding::percent_decode_str(request.uri().path()).decode_utf8()
    else {
        return ApiError::bad("invalid asset path").into_response();
    };
    let path = decoded.strip_prefix('/').unwrap_or(&decoded);
    if path.split('/').any(|part| part == ".." || part == ".") || path.contains(['\\', '\0']) {
        return ApiError::bad("invalid asset path").into_response();
    }
    // A malformed or unknown API URL must never receive public SPA content.
    if path == "api" || path.starts_with("api/") {
        return ApiError::missing().into_response();
    }
    let requested = if path.is_empty() { "index.html" } else { path };
    let (asset, served_path) = match Assets::get(requested) {
        Some(asset) => (asset, requested),
        None if !path.rsplit('/').next().unwrap_or("").contains('.') => {
            let Some(asset) = Assets::get("index.html") else {
                return ApiError::missing().into_response();
            };
            (asset, "index.html")
        }
        None => return ApiError::missing().into_response(),
    };
    let mime = mime_guess::from_path(served_path)
        .first_or_octet_stream()
        .to_string();
    let mime = if mime.starts_with("text/") || mime == "application/javascript" {
        format!("{mime}; charset=utf-8")
    } else {
        mime
    };
    let length = asset.data.len();
    let body = if request.method() == Method::HEAD {
        Body::empty()
    } else {
        Body::from(asset.data.into_owned())
    };
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, mime)
        .header(header::CONTENT_LENGTH, length)
        .header(header::X_CONTENT_TYPE_OPTIONS, "nosniff")
        .header(header::CACHE_CONTROL, "no-cache")
        .body(body)
        .unwrap()
}
