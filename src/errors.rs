use axum::{
    Json,
    http::{StatusCode, header},
    response::{IntoResponse, Response},
};
use serde_json::json;

const BUSY_MESSAGE: &str = "server busy; retry later";

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
        Self(StatusCode::SERVICE_UNAVAILABLE, BUSY_MESSAGE)
    }
}
impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let mut response = (self.0, Json(json!({"error":self.1}))).into_response();
        if self.0 == StatusCode::SERVICE_UNAVAILABLE && self.1 == BUSY_MESSAGE {
            response
                .headers_mut()
                .insert(header::RETRY_AFTER, "1".parse().unwrap());
        }
        response
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
