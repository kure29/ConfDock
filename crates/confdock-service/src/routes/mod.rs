#[cfg(feature = "embedded-web")]
mod assets;
mod projects;
mod public;
mod session;
mod settings;
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
        .route("/api/settings", get(settings::get).patch(settings::update))
        .route("/api/projects", get(projects::list).post(projects::create))
        .route(
            "/api/projects/{id}",
            get(projects::get)
                .patch(projects::rename)
                .delete(projects::remove),
        )
        .route(
            "/api/projects/{id}/revisions",
            get(projects::list_revisions).post(projects::save_revision),
        )
        .route("/api/projects/{id}/publish", post(projects::publish))
        .route("/api/projects/{id}/revisions/diff", get(projects::diff))
        .route(
            "/api/projects/{id}/revisions/{revision_id}",
            get(projects::get_revision),
        )
        .route(
            "/api/projects/{id}/tokens",
            get(tokens::list).post(tokens::create),
        )
        .route(
            "/api/projects/{id}/tokens/{token_id}",
            delete(tokens::revoke).patch(tokens::update),
        )
        .route(
            "/api/projects/{id}/tokens/{token_id}/purge",
            post(tokens::purge),
        )
        .route_layer(middleware::from_fn_with_state(
            state.clone(),
            require_session,
        ));

    let app = Router::new()
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
        .layer(middleware::from_fn(no_store_api_responses))
        .with_state(state);

    #[cfg(feature = "embedded-web")]
    let app = app
        .route("/", get(assets::index))
        .route("/index.html", get(assets::index))
        .route("/assets/{*path}", get(assets::file))
        .route("/client-icons/{*path}", get(assets::icon))
        .route("/favicon.svg", get(assets::favicon))
        .fallback(assets::fallback);

    app
}

/// Management responses contain session and configuration metadata. Browsers
/// and intermediary caches must never retain them, including error responses
/// produced by authentication, routing, or body-limit middleware.
async fn no_store_api_responses(request: Request, next: Next) -> Response {
    let path = request.uri().path();
    let is_sensitive_endpoint = path == "/healthz"
        || path == "/api"
        || path.starts_with("/api/")
        || path == "/sub"
        || path.starts_with("/sub/");
    let mut response = next.run(request).await;
    if is_sensitive_endpoint {
        response
            .headers_mut()
            .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    }
    response
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
