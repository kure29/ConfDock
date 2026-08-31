use axum::{
    body::Body,
    extract::{Path, State},
    http::{header, HeaderValue, Response},
    Json,
};
use serde::Serialize;

use crate::{dto::ServiceInfoDto, error::ApiError, state::AppState, storage};

#[derive(Serialize)]
pub struct Health {
    status: &'static str,
}

pub async fn health(State(state): State<AppState>) -> Result<Json<Health>, ApiError> {
    sqlx::query_scalar::<_, i64>("SELECT 1")
        .fetch_one(&state.pool)
        .await
        .map_err(|_| ApiError::internal())?;
    Ok(Json(Health { status: "ok" }))
}

pub async fn service_info(State(state): State<AppState>) -> Json<ServiceInfoDto> {
    Json(ServiceInfoDto {
        version: env!("CARGO_PKG_VERSION").to_owned(),
        core: "wasm".to_owned(),
        api: "http".to_owned(),
        subscription_base: format!("{}/sub", state.config.public_url),
    })
}

pub async fn subscription(
    State(state): State<AppState>,
    Path(token): Path<String>,
) -> Result<Response<Body>, ApiError> {
    let subscription = storage::subscription(&state.pool, &token).await?;
    let filename = safe_filename(&subscription.file_name);
    let mut response = Response::new(Body::from(subscription.source));
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/octet-stream"),
    );
    response.headers_mut().insert(
        header::CONTENT_DISPOSITION,
        HeaderValue::from_str(&format!("inline; filename=\"{filename}\""))
            .expect("sanitized filename is header-safe"),
    );
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response.headers_mut().insert(
        "x-content-type-options",
        HeaderValue::from_static("nosniff"),
    );
    Ok(response)
}

fn safe_filename(value: &str) -> String {
    let sanitized: String = value
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '-') {
                character
            } else {
                '_'
            }
        })
        .take(180)
        .collect();
    if sanitized.is_empty() || matches!(sanitized.as_str(), "." | "..") {
        "config.bin".to_owned()
    } else {
        sanitized
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn served_filename_cannot_inject_headers_or_paths() {
        assert_eq!(safe_filename("../bad\r\n\"name.yaml"), ".._bad___name.yaml");
        assert_eq!(safe_filename("配置.yaml"), "__.yaml");
    }
}
