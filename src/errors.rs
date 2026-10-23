use axum::{
    Json,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use serde_json::json;

#[derive(Debug)]
pub struct ApiError(pub StatusCode, pub &'static str);
pub type Result<T> = std::result::Result<T, ApiError>;
impl ApiError {
    pub fn bad(message: &'static str) -> Self {
        Self(StatusCode::BAD_REQUEST, message)
    }
    pub fn missing() -> Self {
        Self(StatusCode::NOT_FOUND, "resource not found")
    }
    pub fn internal(error: impl std::fmt::Display) -> Self {
        tracing::error!(%error, "internal server error");
        Self(StatusCode::INTERNAL_SERVER_ERROR, "internal server error")
    }
    pub fn busy() -> Self {
        Self(StatusCode::SERVICE_UNAVAILABLE, "server busy; retry later")
    }
}
impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.0, Json(json!({"error":self.1}))).into_response()
    }
}
impl From<rusqlite::Error> for ApiError {
    fn from(error: rusqlite::Error) -> Self {
        Self::internal(error)
    }
}
impl From<std::io::Error> for ApiError {
    fn from(error: std::io::Error) -> Self {
        Self::internal(error)
    }
}
