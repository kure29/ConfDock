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
    state::AppState,
    storage,
    validation::{token_display_name, token_expiry, DEFAULT_TOKEN_DISPLAY_NAME},
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
    let token = storage::create_token(
        &state.pool,
        &id,
        &display_name,
        expires_at,
        &state.config.public_url,
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
    Ok(Json(
        storage::update_token(&state.pool, &id, &token_id, &display_name, expires_at).await?,
    ))
}

pub async fn revoke(
    State(state): State<AppState>,
    Path((id, token_id)): Path<(String, String)>,
) -> Result<StatusCode, ApiError> {
    storage::revoke_token(&state.pool, &id, &token_id).await?;
    Ok(StatusCode::NO_CONTENT)
}
