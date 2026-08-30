mod projects;
mod public;
mod session;
mod tokens;

use axum::{
    extract::{rejection::JsonRejection, DefaultBodyLimit, Request, State},
    http::{header, HeaderValue},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{delete, get, post},
    Json, Router,
};
use serde::de::DeserializeOwned;

use crate::{
    auth::{authenticate, clear_session_cookie, cookie_token},
    error::ApiError,
    state::AppState,
};

pub fn router(state: AppState) -> Router {
    let protected = Router::new()
        .route("/api/admin/password", post(session::change_password))
        .route("/api/projects", get(projects::list).post(projects::create))
        .route(
            "/api/projects/{id}",
            get(projects::get)
                .patch(projects::rename)
                .delete(projects::remove),
        )
        .route(
            "/api/projects/{id}/revisions",
            post(projects::save_revision),
        )
        .route(
            "/api/projects/{id}/tokens",
            get(tokens::list).post(tokens::create),
        )
        .route(
            "/api/projects/{id}/tokens/{token_id}",
            delete(tokens::revoke),
        )
        .route_layer(middleware::from_fn_with_state(
            state.clone(),
            require_session,
        ));

    Router::new()
        .route("/healthz", get(public::health))
        .route("/sub/{token}", get(public::subscription))
        .route("/api/service", get(public::service_info))
        .route(
            "/api/session",
            get(session::current)
                .post(session::sign_in)
                .delete(session::sign_out),
        )
        .merge(protected)
        .layer(DefaultBodyLimit::max(state.config.max_json_body_bytes()))
        .with_state(state)
}

async fn require_session(
    State(state): State<AppState>,
    mut request: Request,
    next: Next,
) -> Response {
    let token = cookie_token(request.headers()).map(str::to_owned);
    let identity = match token {
        Some(token) => match authenticate(&state.pool, &token).await {
            Ok(Some(identity)) => identity,
            Ok(None) => return with_clear_cookie(ApiError::unauthorized(), &state),
            Err(_) => return ApiError::internal().into_response(),
        },
        None => return ApiError::unauthorized().into_response(),
    };
    request.extensions_mut().insert(identity);
    next.run(request).await
}

pub(super) fn json<T: DeserializeOwned>(
    input: Result<Json<T>, JsonRejection>,
) -> Result<T, ApiError> {
    match input {
        Ok(Json(value)) => Ok(value),
        Err(rejection) if rejection.status() == axum::http::StatusCode::PAYLOAD_TOO_LARGE => {
            Err(ApiError::too_large())
        }
        Err(_) => Err(ApiError::bad_request(
            "request.invalid",
            "请求 JSON 格式无效",
        )),
    }
}

pub(super) fn with_clear_cookie(error: ApiError, state: &AppState) -> Response {
    let mut response = error.into_response();
    response
        .headers_mut()
        .insert(header::SET_COOKIE, clear_session_cookie(&state.config));
    response
}

pub(super) fn insert_set_cookie(response: &mut Response, value: HeaderValue) {
    response.headers_mut().insert(header::SET_COOKIE, value);
}
