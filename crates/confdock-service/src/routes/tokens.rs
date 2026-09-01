use axum::{
    extract::{rejection::JsonRejection, Path, State},
    http::StatusCode,
    Json,
};

use crate::{
    auth::unix_timestamp,
    dto::{
        AccessTokenDto, CreateAccessTokenRequest, CreatedAccessTokenDto, UpdateAccessTokenRequest,
    },
    error::ApiError,
    state::{read_public_url, AppState},
    storage,
    validation::{token_display_name, token_expiry, token_timestamp, DEFAULT_TOKEN_DISPLAY_NAME},
};

use super::json;

pub async fn list(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<Vec<AccessTokenDto>>, ApiError> {
    Ok(Json(storage::list_tokens(&state.pool, &id).await?))
}

pub async fn create(
    State(state): State<AppState>,
    Path(id): Path<String>,
    input: Result<Option<Json<CreateAccessTokenRequest>>, JsonRejection>,
) -> Result<(StatusCode, Json<CreatedAccessTokenDto>), ApiError> {
    let input = input
        .map_err(|_| ApiError::bad_request("request.invalid", "请求 JSON 格式无效"))?
        .map(|Json(value)| value)
        .unwrap_or_default();
    let display_name = match input.display_name.as_deref() {
        Some(value) => token_display_name(value)?,
        None => DEFAULT_TOKEN_DISPLAY_NAME.to_owned(),
    };
    let expires_at = token_expiry(input.expires_at.as_deref(), unix_timestamp())?;
    // Keep the read lock until token persistence and the response DTO are
    // complete. Settings updates hold the matching write lock across their
    // SQLite update, giving these operations an explicit linearization point.
    let public_url = read_public_url(&state.public_url).await;
    #[cfg(test)]
    state.test_hooks.token_read_checkpoint().await;
    let token = storage::create_token(
        &state.pool,
        &id,
        &display_name,
        expires_at,
        public_url.as_str(),
    )
    .await?;
    Ok((StatusCode::CREATED, Json(token)))
}

pub async fn update(
    State(state): State<AppState>,
    Path((id, token_id)): Path<(String, String)>,
    input: Result<Json<UpdateAccessTokenRequest>, JsonRejection>,
) -> Result<Json<AccessTokenDto>, ApiError> {
    let input = json(input)?;
    let display_name = token_display_name(&input.display_name)?;
    let expires_at = token_expiry(input.expires_at.as_deref(), unix_timestamp())?;
    let expected_display_name = token_display_name(&input.expected_display_name)?;
    let expected_expires_at = token_timestamp(input.expected_expires_at.as_deref())?;
    Ok(Json(
        storage::update_token(
            &state.pool,
            &id,
            &token_id,
            &display_name,
            expires_at,
            &expected_display_name,
            expected_expires_at,
        )
        .await?,
    ))
}

pub async fn revoke(
    State(state): State<AppState>,
    Path((id, token_id)): Path<(String, String)>,
) -> Result<StatusCode, ApiError> {
    storage::revoke_token(&state.pool, &id, &token_id).await?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn purge(
    State(state): State<AppState>,
    Path((id, token_id)): Path<(String, String)>,
) -> Result<StatusCode, ApiError> {
    storage::delete_revoked_token(&state.pool, &id, &token_id).await?;
    Ok(StatusCode::NO_CONTENT)
}
