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

#[cfg(test)]
mod tests {
    use std::net::SocketAddr;

    use axum::{
        body::{to_bytes, Body},
        http::{header, Method, Request, Response, StatusCode},
        Router,
    };
    use base64::{engine::general_purpose::STANDARD, Engine as _};
    use serde_json::{json, Value};
    use tempfile::TempDir;
    use tower::ServiceExt;

    use crate::{
        auth::{create_session, SESSION_COOKIE},
        config::ServiceConfig,
        state::AppState,
    };

    async fn test_app() -> (Router, AppState, TempDir) {
        let directory = tempfile::tempdir().unwrap();
        let database_url = format!(
            "sqlite://{}",
            directory.path().join("confdock.db").display()
        );
        let config = ServiceConfig::new(
            SocketAddr::from(([127, 0, 0, 1], 0)),
            database_url,
            "http://127.0.0.1:8787".to_owned(),
            Some("test-only-admin-password-123!".to_owned()),
            3600,
            false,
            1024 * 1024,
        )
        .unwrap();
        let state = AppState::initialize(config).await.unwrap();
        let app = super::router(state.clone());
        (app, state, directory)
    }

    async fn request(
        app: &Router,
        method: Method,
        uri: &str,
        cookie: &str,
        body: Option<Value>,
    ) -> Response<Body> {
        let mut builder = Request::builder()
            .method(method)
            .uri(uri)
            .header(header::COOKIE, cookie);
        let body = match body {
            Some(body) => {
                builder = builder.header(header::CONTENT_TYPE, "application/json");
                Body::from(serde_json::to_vec(&body).unwrap())
            }
            None => Body::empty(),
        };
        app.clone()
            .oneshot(builder.body(body).unwrap())
            .await
            .unwrap()
    }

    async fn response_json(response: Response<Body>) -> Value {
        serde_json::from_slice(&to_bytes(response.into_body(), usize::MAX).await.unwrap()).unwrap()
    }

    async fn session_cookie(state: &AppState) -> String {
        let (_, token) = create_session(&state.pool, 3600).await.unwrap();
        format!("{SESSION_COOKIE}={token}")
    }

    async fn create_project(app: &Router, cookie: &str, name: &str) -> String {
        let response = request(
            app,
            Method::POST,
            "/api/projects",
            cookie,
            Some(json!({
                "name": name,
                "targetId": "sing-box",
                "fileName": "config.json",
                "source": STANDARD.encode(br#"{}"#),
            })),
        )
        .await;
        assert_eq!(response.status(), StatusCode::CREATED);
        response_json(response).await["id"]
            .as_str()
            .unwrap()
            .to_owned()
    }

    #[tokio::test]
    async fn token_handler_read_lock_precedes_settings_handler_write_lock() {
        let (app, state, _directory) = test_app().await;
        let cookie = session_cookie(&state).await;
        let project_id = create_project(&app, &cookie, "Token first").await;
        let token_uri = format!("/api/projects/{project_id}/tokens");
        let (entered, release) = state.test_hooks.install_token_read_gate().await;

        let token_app = app.clone();
        let token_cookie = cookie.clone();
        let token_task = tokio::spawn(async move {
            request(&token_app, Method::POST, &token_uri, &token_cookie, None).await
        });
        entered.await.unwrap();

        let settings_app = app.clone();
        let settings_cookie = cookie.clone();
        let settings_task = tokio::spawn(async move {
            request(
                &settings_app,
                Method::PATCH,
                "/api/settings",
                &settings_cookie,
                Some(json!({"publicUrl": "https://new.example.test"})),
            )
            .await
        });
        tokio::task::yield_now().await;
        assert!(!settings_task.is_finished());

        release.send(()).unwrap();
        let token_response = token_task.await.unwrap();
        assert_eq!(token_response.status(), StatusCode::CREATED);
        let token = response_json(token_response).await;
        assert!(token["url"]
            .as_str()
            .unwrap()
            .starts_with("http://127.0.0.1:8787/sub/"));

        let settings_response = settings_task.await.unwrap();
        assert_eq!(settings_response.status(), StatusCode::OK);
        assert_eq!(
            response_json(settings_response).await,
            json!({"publicUrl": "https://new.example.test"})
        );
        assert_eq!(
            state.public_url.read().await.as_str(),
            "https://new.example.test"
        );
        let stored: String =
            sqlx::query_scalar("SELECT public_url FROM instance_settings WHERE id = 1")
                .fetch_one(&state.pool)
                .await
                .unwrap();
        assert_eq!(stored, "https://new.example.test");
    }

    #[tokio::test]
    async fn settings_handler_write_lock_precedes_token_handler_read_lock() {
        let (app, state, _directory) = test_app().await;
        let cookie = session_cookie(&state).await;
        let project_id = create_project(&app, &cookie, "Settings first").await;
        let token_uri = format!("/api/projects/{project_id}/tokens");
        let (entered, release) = state.test_hooks.install_settings_write_gate().await;

        let settings_app = app.clone();
        let settings_cookie = cookie.clone();
        let settings_task = tokio::spawn(async move {
            request(
                &settings_app,
                Method::PATCH,
                "/api/settings",
                &settings_cookie,
                Some(json!({"publicUrl": "https://new.example.test"})),
            )
            .await
        });
        entered.await.unwrap();

        let token_app = app.clone();
        let token_cookie = cookie.clone();
        let token_task = tokio::spawn(async move {
            request(&token_app, Method::POST, &token_uri, &token_cookie, None).await
        });
        tokio::task::yield_now().await;
        assert!(!token_task.is_finished());

        release.send(()).unwrap();
        let settings_response = settings_task.await.unwrap();
        assert_eq!(settings_response.status(), StatusCode::OK);
        let token_response = token_task.await.unwrap();
        assert_eq!(token_response.status(), StatusCode::CREATED);
        let token = response_json(token_response).await;
        assert!(token["url"]
            .as_str()
            .unwrap()
            .starts_with("https://new.example.test/sub/"));
        assert_eq!(
            state.public_url.read().await.as_str(),
            "https://new.example.test"
        );
        let stored: String =
            sqlx::query_scalar("SELECT public_url FROM instance_settings WHERE id = 1")
                .fetch_one(&state.pool)
                .await
                .unwrap();
        assert_eq!(stored, "https://new.example.test");
    }
}
