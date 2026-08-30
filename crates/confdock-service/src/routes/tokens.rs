use axum::{
    extract::{Path, State},
    http::StatusCode,
    Json,
};

use crate::{
    dto::{AccessTokenDto, CreatedAccessTokenDto},
    error::ApiError,
    state::AppState,
    storage,
};

pub async fn list(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<Vec<AccessTokenDto>>, ApiError> {
    Ok(Json(storage::list_tokens(&state.pool, &id).await?))
}

pub async fn create(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<(StatusCode, Json<CreatedAccessTokenDto>), ApiError> {
    let token = storage::create_token(&state.pool, &id, &state.config.public_url).await?;
    Ok((StatusCode::CREATED, Json(token)))
}

pub async fn revoke(
    State(state): State<AppState>,
    Path((id, token_id)): Path<(String, String)>,
) -> Result<StatusCode, ApiError> {
    storage::revoke_token(&state.pool, &id, &token_id).await?;
    Ok(StatusCode::NO_CONTENT)
}
