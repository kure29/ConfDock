#![cfg(feature = "embedded-web")]

use std::net::SocketAddr;

use axum::{
    body::{to_bytes, Body},
    http::{header, Method, Request, Response, StatusCode},
    Router,
};
use confdock_service::{config::ServiceConfig, router, AppState};
use serde_json::json;
use tempfile::TempDir;
use tower::ServiceExt;

async fn test_app() -> (Router, TempDir) {
    let directory = tempfile::tempdir().unwrap();
    let database_url = format!(
        "sqlite://{}",
        directory.path().join("confdock.db").display()
    );
    let config = ServiceConfig::new(
        "127.0.0.1:0".parse::<SocketAddr>().unwrap(),
        database_url,
        "http://127.0.0.1:8787".to_owned(),
        Some("test-only-admin-password-123!".to_owned()),
        3600,
        false,
        1024 * 1024,
    )
    .unwrap();
    (
        router(AppState::initialize(config).await.unwrap()),
        directory,
    )
}

async fn request(app: &Router, method: Method, uri: &str) -> Response<Body> {
    app.clone()
        .oneshot(
            Request::builder()
                .method(method)
                .uri(uri)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap()
}

async fn body(response: Response<Body>) -> Vec<u8> {
    to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap()
        .to_vec()
}

fn asset_path(index: &str, attribute: &str, extension: &str) -> String {
    index
        .split(attribute)
        .skip(1)
        .map(|value| value.split('"').next().unwrap_or_default())
        .find(|value| value.ends_with(extension))
        .unwrap_or_else(|| panic!("{extension} asset not found in index.html"))
        .to_owned()
}

#[tokio::test]
async fn embedded_static_routes_preserve_spa_boundaries_mime_and_cache_contracts() {
    let (app, _directory) = test_app().await;

    let index_response = request(&app, Method::GET, "/").await;
    assert_eq!(index_response.status(), StatusCode::OK);
    assert_eq!(
        index_response.headers()[header::CONTENT_TYPE],
        "text/html; charset=utf-8"
    );
    assert_eq!(index_response.headers()[header::CACHE_CONTROL], "no-cache");
    let index = String::from_utf8(body(index_response).await).unwrap();
    assert!(index.contains("<div id=\"root\"></div>"));

    let script = asset_path(&index, "src=\"", ".js");
    let stylesheet = asset_path(&index, "href=\"", ".css");
    let script_response = request(&app, Method::GET, &script).await;
    assert_eq!(script_response.status(), StatusCode::OK);
    assert_eq!(
        script_response.headers()[header::CONTENT_TYPE],
        "application/javascript; charset=utf-8"
    );
    assert_eq!(
        script_response.headers()[header::CACHE_CONTROL],
        "public, max-age=31536000, immutable"
    );
    let script_body = String::from_utf8(body(script_response).await).unwrap();
    let wasm_module = script_body
        .split('"')
        .find(|value| value.starts_with("./confdock_wasm-") && value.ends_with(".js"))
        .unwrap_or_else(|| panic!("WASM JS module not found in {script}"));
    let module_path = format!("/assets/{}", wasm_module.trim_start_matches("./"));
    let module_response = request(&app, Method::GET, &module_path).await;
    assert_eq!(module_response.status(), StatusCode::OK);
    let module_body = String::from_utf8(body(module_response).await).unwrap();
    let wasm_reference = module_body
        .split('"')
        .find(|value| value.ends_with(".wasm"))
        .unwrap_or_else(|| panic!("WASM asset not found in {module_path}"));
    let wasm_name = wasm_reference.rsplit('/').next().unwrap();
    let wasm_path = format!("/assets/{wasm_name}");
    let wasm_response = request(&app, Method::GET, &wasm_path).await;
    assert_eq!(wasm_response.status(), StatusCode::OK);
    assert_eq!(
        wasm_response.headers()[header::CONTENT_TYPE],
        "application/wasm"
    );
    assert!(!body(wasm_response).await.is_empty());

    let css_response = request(&app, Method::GET, &stylesheet).await;
    assert_eq!(css_response.status(), StatusCode::OK);
    assert_eq!(
        css_response.headers()[header::CONTENT_TYPE],
        "text/css; charset=utf-8"
    );
    assert_eq!(
        css_response.headers()[header::CACHE_CONTROL],
        "public, max-age=31536000, immutable"
    );

    let favicon = request(&app, Method::GET, "/favicon.svg").await;
    assert_eq!(favicon.status(), StatusCode::OK);
    assert_eq!(favicon.headers()[header::CONTENT_TYPE], "image/svg+xml");

    let head = request(&app, Method::HEAD, &script).await;
    assert_eq!(head.status(), StatusCode::OK);
    assert_eq!(
        head.headers()[header::CONTENT_TYPE],
        "application/javascript; charset=utf-8"
    );
    assert!(!head.headers()[header::CONTENT_LENGTH].is_empty());
    assert!(body(head).await.is_empty());

    for method in [Method::POST, Method::PUT, Method::PATCH, Method::DELETE] {
        let response = request(&app, method, "/unknown/client-route").await;
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
    }

    let spa = request(&app, Method::GET, "/projects/demo").await;
    assert_eq!(spa.status(), StatusCode::OK);
    assert!(String::from_utf8(body(spa).await)
        .unwrap()
        .contains("id=\"root\""));

    for (path, expected_cache) in [
        ("/api/not-found", "no-store"),
        ("/sub/not-found", "no-store"),
        ("/assets/missing.js", "no-store"),
        ("/assets/missing.webp", "no-store"),
        ("/assets/%2e%2e/Cargo.toml", "no-store"),
        ("/assets/%252e%252e/Cargo.toml", "no-store"),
        ("/assets/%5cCargo.toml", "no-store"),
    ] {
        let response = request(&app, Method::GET, path).await;
        assert_eq!(response.status(), StatusCode::NOT_FOUND, "{path}");
        assert_eq!(
            response.headers()[header::CACHE_CONTROL],
            expected_cache,
            "{path}"
        );
        assert!(!body(response)
            .await
            .windows(4)
            .any(|window| window == b"root"));
    }
}

#[tokio::test]
async fn health_endpoint_checks_sqlite_and_remains_minimal() {
    let (app, _directory) = test_app().await;
    let response = request(&app, Method::GET, "/healthz").await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
    assert_eq!(
        body(response).await,
        serde_json::to_vec(&json!({"status":"ok"})).unwrap()
    );
}

#[tokio::test]
async fn health_endpoint_reports_database_failure_without_details() {
    let directory = tempfile::tempdir().unwrap();
    let database_url = format!(
        "sqlite://{}",
        directory.path().join("confdock.db").display()
    );
    let config = ServiceConfig::new(
        "127.0.0.1:0".parse::<SocketAddr>().unwrap(),
        database_url,
        "http://127.0.0.1:8787".to_owned(),
        Some("test-only-admin-password-123!".to_owned()),
        3600,
        false,
        1024 * 1024,
    )
    .unwrap();
    let state = AppState::initialize(config).await.unwrap();
    let app = router(state.clone());
    state.pool.close().await;

    let response = request(&app, Method::GET, "/healthz").await;
    assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
    let body = body(response).await;
    assert!(!body.windows(3).any(|window| window == b"db/"));
    assert!(!body.windows(6).any(|window| window == b"sqlite"));
}
