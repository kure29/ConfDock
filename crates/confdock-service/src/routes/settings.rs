use axum::{extract::State, http::StatusCode, Json};

use crate::{
    config::normalize_public_url,
    dto::{ServiceSettingsDto, UpdateServiceSettingsRequest},
    error::ApiError,
    state::AppState,
    storage,
};

use super::json;

pub async fn get(State(state): State<AppState>) -> Json<ServiceSettingsDto> {
    Json(ServiceSettingsDto {
        public_url: state.public_url.read().await.clone(),
    })
}

pub async fn update(
    State(state): State<AppState>,
    input: Result<Json<UpdateServiceSettingsRequest>, axum::extract::rejection::JsonRejection>,
) -> Result<(StatusCode, Json<ServiceSettingsDto>), ApiError> {
    let input = json(input)?;
    let public_url = normalize_public_url(&input.public_url).map_err(|_| {
        ApiError::bad_request(
            "settings.invalid_public_url",
            "对外访问地址必须是带域名的 http:// 或 https:// 地址，不能包含路径、查询参数或片段",
        )
    })?;
    // Serialize persistence and the in-memory value so concurrent updates
    // cannot leave service-info responses ahead of (or behind) SQLite.
    let mut current = state.public_url.write().await;
    #[cfg(test)]
    state.test_hooks.settings_write_checkpoint().await;
    storage::update_public_url(&state.pool, &public_url).await?;
    *current = public_url.clone();
    Ok((StatusCode::OK, Json(ServiceSettingsDto { public_url })))
}
