use crate::{
    AppState,
    errors::{ApiError, Result},
};
use axum::{
    extract::{Request, State},
    http::{StatusCode, header},
    middleware::Next,
    response::{IntoResponse, Response},
};
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;

#[derive(Clone)]
pub struct Token([u8; 32]);
impl Token {
    pub fn new(value: &str) -> Result<Self> {
        if value.is_empty() || value.bytes().any(|b| b <= b' ' || b >= 127) {
            return Err(ApiError::bad(
                "token must be nonempty printable ASCII without whitespace",
            ));
        }
        Ok(Self(Sha256::digest(value.as_bytes()).into()))
    }
    pub fn matches(&self, candidate: &str) -> bool {
        let digest: [u8; 32] = Sha256::digest(candidate.as_bytes()).into();
        bool::from(self.0.ct_eq(&digest))
    }
}
pub async fn require_token(
    State(state): State<AppState>,
    request: Request,
    next: Next,
) -> Response {
    let mut values = request.headers().get_all(header::AUTHORIZATION).iter();
    let candidate = values
        .next()
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "));
    if values.next().is_some() || !candidate.is_some_and(|v| state.token.matches(v)) {
        let mut response = ApiError(StatusCode::UNAUTHORIZED, "unauthorized").into_response();
        response
            .headers_mut()
            .insert(header::WWW_AUTHENTICATE, "Bearer".parse().unwrap());
        return response;
    }
    next.run(request).await
}
