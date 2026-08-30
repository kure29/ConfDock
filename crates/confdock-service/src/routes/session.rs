use axum::{
    extract::{rejection::JsonRejection, Extension, State},
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use sqlx::Row;

use crate::{
    auth::{
        authenticate, cookie_token, create_session, delete_session, hash_password_async,
        session_cookie, unix_timestamp, valid_password, verify_password_async, SessionIdentity,
    },
    dto::{timestamp_to_iso, AdminSessionDto, ChangePasswordRequest, SignInRequest},
    error::ApiError,
    state::AppState,
};

use super::{insert_set_cookie, json, with_clear_cookie};

pub async fn current(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let token = cookie_token(&headers).map(str::to_owned);
    let Some(token) = token else {
        return StatusCode::NOT_FOUND.into_response();
    };
    match authenticate(&state.pool, &token).await {
        Ok(Some(identity)) => match session_dto(identity) {
            Ok(session) => Json(session).into_response(),
            Err(error) => error.into_response(),
        },
        Ok(None) => {
            let mut response = StatusCode::NOT_FOUND.into_response();
            insert_set_cookie(
                &mut response,
                crate::auth::clear_session_cookie(&state.config),
            );
            response
        }
        Err(_) => ApiError::internal().into_response(),
    }
}

pub async fn sign_in(
    State(state): State<AppState>,
    input: Result<Json<SignInRequest>, JsonRejection>,
) -> Result<Response, ApiError> {
    let input = json(input)?;
    state.login_throttle.wait().await;
    let hash: Option<String> = sqlx::query_scalar("SELECT password_hash FROM admins WHERE id = 1")
        .fetch_optional(&state.pool)
        .await
        .map_err(|_| ApiError::internal())?;
    let valid = {
        let _hash_slot = state.login_throttle.password_hash_slot().await;
        if valid_password(&input.password) {
            match hash {
                Some(hash) => verify_password_async(input.password, hash)
                    .await
                    .map_err(|_| ApiError::internal())?,
                None => false,
            }
        } else {
            false
        }
    };
    if !valid {
        state.login_throttle.record_failure().await;
        return Err(ApiError::new(
            StatusCode::UNAUTHORIZED,
            "auth.invalid_password",
            "密码不正确",
        ));
    }
    state.login_throttle.reset().await;
    let (identity, plaintext) = create_session(&state.pool, state.config.session_ttl_seconds)
        .await
        .map_err(|_| ApiError::internal())?;
    let mut response = Json(session_dto(identity)?).into_response();
    insert_set_cookie(&mut response, session_cookie(&plaintext, &state.config));
    Ok(response)
}

pub async fn sign_out(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let token = cookie_token(&headers).map(str::to_owned);
    let Some(token) = token else {
        return ApiError::unauthorized().into_response();
    };
    let identity = match authenticate(&state.pool, &token).await {
        Ok(Some(identity)) => identity,
        Ok(None) => return with_clear_cookie(ApiError::unauthorized(), &state),
        Err(_) => return ApiError::internal().into_response(),
    };
    if delete_session(&state.pool, &identity.id).await.is_err() {
        return ApiError::internal().into_response();
    }
    let mut response = StatusCode::NO_CONTENT.into_response();
    response.headers_mut().insert(
        header::SET_COOKIE,
        crate::auth::clear_session_cookie(&state.config),
    );
    response
}

pub async fn change_password(
    State(state): State<AppState>,
    Extension(identity): Extension<SessionIdentity>,
    input: Result<Json<ChangePasswordRequest>, JsonRejection>,
) -> Result<StatusCode, ApiError> {
    let input = json(input)?;
    if !valid_password(&input.next_password) {
        return Err(ApiError::bad_request(
            "request.invalid",
            "新密码必须包含 8 到 1024 个字节",
        ));
    }
    if !valid_password(&input.current_password) {
        return Err(ApiError::new(
            StatusCode::UNAUTHORIZED,
            "auth.invalid_password",
            "当前密码不正确",
        ));
    }
    let hash: String = sqlx::query("SELECT password_hash FROM admins WHERE id = 1")
        .fetch_one(&state.pool)
        .await
        .map_err(|_| ApiError::internal())?
        .try_get("password_hash")
        .map_err(|_| ApiError::internal())?;
    let verified = {
        let _hash_slot = state.login_throttle.password_hash_slot().await;
        verify_password_async(input.current_password.clone(), hash)
            .await
            .map_err(|_| ApiError::internal())?
    };
    if !verified {
        return Err(ApiError::new(
            StatusCode::UNAUTHORIZED,
            "auth.invalid_password",
            "当前密码不正确",
        ));
    }
    let next_hash = {
        let _hash_slot = state.login_throttle.password_hash_slot().await;
        hash_password_async(input.next_password)
            .await
            .map_err(|_| ApiError::internal())?
    };
    let mut transaction = state.pool.begin().await.map_err(|_| ApiError::internal())?;
    sqlx::query("UPDATE admins SET password_hash = ?, updated_at = ? WHERE id = 1")
        .bind(next_hash)
        .bind(unix_timestamp())
        .execute(&mut *transaction)
        .await
        .map_err(|_| ApiError::internal())?;
    sqlx::query("DELETE FROM sessions WHERE id <> ?")
        .bind(&identity.id)
        .execute(&mut *transaction)
        .await
        .map_err(|_| ApiError::internal())?;
    transaction
        .commit()
        .await
        .map_err(|_| ApiError::internal())?;
    Ok(StatusCode::NO_CONTENT)
}

fn session_dto(identity: SessionIdentity) -> Result<AdminSessionDto, ApiError> {
    Ok(AdminSessionDto {
        id: identity.id,
        created_at: timestamp_to_iso(identity.created_at).ok_or_else(ApiError::internal)?,
    })
}
