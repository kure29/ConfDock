use std::{net::SocketAddr, sync::Arc, time::Duration};

use axum::{
    body::{to_bytes, Body},
    http::{header, Method, Request, Response, StatusCode},
    Router,
};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use confdock_service::{
    auth::{token_hash, unix_timestamp},
    config::ServiceConfig,
    router,
    state::MAX_CONCURRENT_DIFFS,
    storage, AppState,
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tempfile::TempDir;
use tower::ServiceExt;

const PASSWORD: &str = "test-only-admin-password-123!";

struct TestService {
    _directory: TempDir,
    database_url: String,
    state: AppState,
    app: Router,
}

impl TestService {
    async fn new() -> Self {
        Self::with_max_bytes(1024 * 1024).await
    }

    async fn with_max_bytes(max_bytes: usize) -> Self {
        let directory = tempfile::tempdir().unwrap();
        let database_url = format!(
            "sqlite://{}",
            directory.path().join("confdock-test.db").display()
        );
        let state = initialize(&database_url, Some(PASSWORD), max_bytes).await;
        let app = router(state.clone());
        Self {
            _directory: directory,
            database_url,
            state,
            app,
        }
    }
}

async fn initialize(database_url: &str, password: Option<&str>, max_bytes: usize) -> AppState {
    let config = ServiceConfig::new(
        "127.0.0.1:0".parse::<SocketAddr>().unwrap(),
        database_url.to_owned(),
        "http://127.0.0.1:8787/".to_owned(),
        password.map(str::to_owned),
        3600,
        false,
        max_bytes,
    )
    .unwrap();
    AppState::initialize(config).await.unwrap()
}

fn test_config(database_url: &str, password: Option<&str>) -> ServiceConfig {
    ServiceConfig::new(
        "127.0.0.1:0".parse::<SocketAddr>().unwrap(),
        database_url.to_owned(),
        "http://127.0.0.1:8787".to_owned(),
        password.map(str::to_owned),
        3600,
        false,
        1024,
    )
    .unwrap()
}

async fn request(
    app: &Router,
    method: Method,
    uri: &str,
    cookie: Option<&str>,
    body: Option<Value>,
) -> Response<Body> {
    let mut builder = Request::builder().method(method).uri(uri);
    if let Some(cookie) = cookie {
        builder = builder.header(header::COOKIE, cookie);
    }
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

async fn response_bytes(response: Response<Body>) -> Vec<u8> {
    to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap()
        .to_vec()
}

async fn login(app: &Router, password: &str) -> (String, Value) {
    let response = request(
        app,
        Method::POST,
        "/api/session",
        None,
        Some(json!({ "password": password })),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
    let cookie = response
        .headers()
        .get(header::SET_COOKIE)
        .unwrap()
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_owned();
    let body = response_json(response).await;
    (cookie, body)
}

async fn create_project(
    app: &Router,
    cookie: &str,
    name: &str,
    target_id: &str,
    file_name: &str,
    source: &[u8],
) -> Value {
    let response = request(
        app,
        Method::POST,
        "/api/projects",
        Some(cookie),
        Some(json!({
            "name": name,
            "targetId": target_id,
            "fileName": file_name,
            "source": STANDARD.encode(source),
        })),
    )
    .await;
    assert_eq!(response.status(), StatusCode::CREATED);
    response_json(response).await
}

#[tokio::test]
async fn health_service_login_cookie_session_and_logout_contract() {
    let service = TestService::new().await;

    let health = request(&service.app, Method::GET, "/healthz", None, None).await;
    assert_eq!(health.status(), StatusCode::OK);
    assert_eq!(response_json(health).await, json!({ "status": "ok" }));

    let info = request(&service.app, Method::GET, "/api/service", None, None).await;
    assert_eq!(info.status(), StatusCode::OK);
    assert_eq!(info.headers()[header::CACHE_CONTROL], "no-store");
    assert_eq!(
        response_json(info).await,
        json!({
            "version": "0.1.0",
            "core": "wasm",
            "api": "http",
            "subscriptionBase": "http://127.0.0.1:8787/sub",
        })
    );

    assert_eq!(
        request(&service.app, Method::GET, "/api/session", None, None)
            .await
            .status(),
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        request(&service.app, Method::GET, "/api/projects", None, None)
            .await
            .status(),
        StatusCode::UNAUTHORIZED
    );

    let wrong = request(
        &service.app,
        Method::POST,
        "/api/session",
        None,
        Some(json!({ "password": "wrong password" })),
    )
    .await;
    assert_eq!(wrong.status(), StatusCode::UNAUTHORIZED);
    assert_eq!(response_json(wrong).await["code"], "auth.invalid_password");

    let response = request(
        &service.app,
        Method::POST,
        "/api/session",
        None,
        Some(json!({ "password": PASSWORD })),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    let set_cookie = response
        .headers()
        .get(header::SET_COOKIE)
        .unwrap()
        .to_str()
        .unwrap()
        .to_owned();
    assert!(set_cookie.contains("HttpOnly"));
    assert!(set_cookie.contains("SameSite=Strict"));
    assert!(set_cookie.split(';').any(|part| part.trim() == "Path=/api"));
    assert!(set_cookie.contains("Max-Age=3600"));
    assert!(!set_cookie.contains("Domain="));
    assert!(!set_cookie.contains("Secure"));
    let cookie = set_cookie.split(';').next().unwrap();
    let plaintext = cookie.split_once('=').unwrap().1;
    let stored_hash: Vec<u8> = sqlx::query_scalar("SELECT token_hash FROM sessions")
        .fetch_one(&service.state.pool)
        .await
        .unwrap();
    assert_eq!(stored_hash, token_hash(plaintext));
    assert_ne!(stored_hash, plaintext.as_bytes());
    let signed_in = response_json(response).await;

    let current = request(
        &service.app,
        Method::GET,
        "/api/session",
        Some(cookie),
        None,
    )
    .await;
    assert_eq!(current.status(), StatusCode::OK);
    assert_eq!(response_json(current).await["id"], signed_in["id"]);

    let logout = request(
        &service.app,
        Method::DELETE,
        "/api/session",
        Some(cookie),
        None,
    )
    .await;
    assert_eq!(logout.status(), StatusCode::NO_CONTENT);
    assert_eq!(logout.headers()[header::CACHE_CONTROL], "no-store");
    assert!(logout
        .headers()
        .get(header::SET_COOKIE)
        .unwrap()
        .to_str()
        .unwrap()
        .contains("Max-Age=0"));
    assert!(logout.headers()[header::SET_COOKIE]
        .to_str()
        .unwrap()
        .split(';')
        .any(|part| part.trim() == "Path=/api"));
    assert_eq!(
        request(
            &service.app,
            Method::GET,
            "/api/session",
            Some(cookie),
            None,
        )
        .await
        .status(),
        StatusCode::NOT_FOUND
    );
}

#[tokio::test]
async fn management_and_subscription_errors_are_not_cached() {
    let service = TestService::new().await;

    let unauthorized = request(&service.app, Method::GET, "/api/projects", None, None).await;
    assert_eq!(unauthorized.status(), StatusCode::UNAUTHORIZED);
    assert_eq!(unauthorized.headers()[header::CACHE_CONTROL], "no-store");

    let invalid_login = request(
        &service.app,
        Method::POST,
        "/api/session",
        None,
        Some(json!({ "password": "wrong password" })),
    )
    .await;
    assert_eq!(invalid_login.status(), StatusCode::UNAUTHORIZED);
    assert_eq!(invalid_login.headers()[header::CACHE_CONTROL], "no-store");

    let unknown_api = request(&service.app, Method::GET, "/api/does-not-exist", None, None).await;
    assert_eq!(unknown_api.status(), StatusCode::NOT_FOUND);
    assert_eq!(unknown_api.headers()[header::CACHE_CONTROL], "no-store");

    let unknown_subscription =
        request(&service.app, Method::GET, "/sub/not-a-token", None, None).await;
    assert_eq!(unknown_subscription.status(), StatusCode::NOT_FOUND);
    assert_eq!(
        unknown_subscription.headers()[header::CACHE_CONTROL],
        "no-store"
    );
}

#[tokio::test]
async fn first_start_requires_a_valid_bootstrap_password() {
    let directory = tempfile::tempdir().unwrap();
    let missing_url = format!(
        "sqlite://{}",
        directory.path().join("missing-password.db").display()
    );
    let missing = AppState::initialize(test_config(&missing_url, None)).await;
    let missing_error = match missing {
        Ok(_) => panic!("missing bootstrap password must fail"),
        Err(error) => error,
    };
    assert!(missing_error
        .to_string()
        .contains("CONFDOCK_BOOTSTRAP_PASSWORD"));

    let short_url = format!(
        "sqlite://{}",
        directory.path().join("short-password.db").display()
    );
    let short = AppState::initialize(test_config(&short_url, Some("short"))).await;
    let short_error = match short {
        Ok(_) => panic!("short bootstrap password must fail"),
        Err(error) => error,
    };
    assert!(short_error.to_string().contains("8 to 1024"));
}

#[tokio::test]
async fn project_scoped_token_and_rename_operations_are_consistent_with_deletion() {
    let service = TestService::new().await;
    let (cookie, _) = login(&service.app, PASSWORD).await;

    let project = create_project(
        &service.app,
        &cookie,
        "Race",
        "sing-box",
        "config.json",
        b"{}",
    )
    .await;
    let project_id = project["id"].as_str().unwrap().to_owned();
    let project_uri = format!("/api/projects/{project_id}");

    let rename_request = request(
        &service.app,
        Method::PATCH,
        &project_uri,
        Some(&cookie),
        Some(json!({ "name": "Renamed" })),
    );
    let delete_request = request(
        &service.app,
        Method::DELETE,
        &project_uri,
        Some(&cookie),
        None,
    );
    let (renamed, deleted) = tokio::join!(rename_request, delete_request);
    assert_eq!(deleted.status(), StatusCode::NO_CONTENT);
    assert!(matches!(
        renamed.status(),
        StatusCode::OK | StatusCode::NOT_FOUND
    ));

    let project = create_project(
        &service.app,
        &cookie,
        "Token race",
        "sing-box",
        "config.json",
        b"{}",
    )
    .await;
    let project_id = project["id"].as_str().unwrap().to_owned();
    let token_collection_uri = format!("/api/projects/{project_id}/tokens");
    let project_uri = format!("/api/projects/{project_id}");
    let create_request = request(
        &service.app,
        Method::POST,
        &token_collection_uri,
        Some(&cookie),
        None,
    );
    let delete_request = request(
        &service.app,
        Method::DELETE,
        &project_uri,
        Some(&cookie),
        None,
    );
    let (created, deleted) = tokio::join!(create_request, delete_request);
    assert_eq!(deleted.status(), StatusCode::NO_CONTENT);
    assert!(matches!(
        created.status(),
        StatusCode::CREATED | StatusCode::NOT_FOUND
    ));

    let project = create_project(
        &service.app,
        &cookie,
        "Revoke race",
        "sing-box",
        "config.json",
        b"{}",
    )
    .await;
    let project_id = project["id"].as_str().unwrap().to_owned();
    let token = response_json(
        request(
            &service.app,
            Method::POST,
            &format!("/api/projects/{project_id}/tokens"),
            Some(&cookie),
            None,
        )
        .await,
    )
    .await;
    let token_id = token["token"]["id"].as_str().unwrap().to_owned();
    let revoke_uri = format!("/api/projects/{project_id}/tokens/{token_id}");
    let project_uri = format!("/api/projects/{project_id}");
    let revoke_request = request(
        &service.app,
        Method::DELETE,
        &revoke_uri,
        Some(&cookie),
        None,
    );
    let delete_request = request(
        &service.app,
        Method::DELETE,
        &project_uri,
        Some(&cookie),
        None,
    );
    let (revoked, deleted) = tokio::join!(revoke_request, delete_request);
    assert_eq!(deleted.status(), StatusCode::NO_CONTENT);
    assert!(matches!(
        revoked.status(),
        StatusCode::NO_CONTENT | StatusCode::NOT_FOUND
    ));
}

#[tokio::test]
async fn concurrent_initialization_runs_migrations_and_creates_one_admin() {
    let directory = tempfile::tempdir().unwrap();
    let database_url = format!(
        "sqlite://{}",
        directory.path().join("concurrent-start.db").display()
    );
    let first_config = test_config(&database_url, Some(PASSWORD));
    let second_config = test_config(&database_url, Some(PASSWORD));

    let (first, second) = tokio::join!(
        AppState::initialize(first_config),
        AppState::initialize(second_config),
    );
    let first = first.unwrap_or_else(|error| panic!("first initialization failed: {error}"));
    let second = second.unwrap_or_else(|error| panic!("second initialization failed: {error}"));
    let admins: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM admins")
        .fetch_one(&first.pool)
        .await
        .unwrap();
    assert_eq!(admins, 1);
    first.pool.close().await;
    second.pool.close().await;
}

#[tokio::test]
async fn project_revision_transactions_conflicts_and_persistence_are_real() {
    let service = TestService::new().await;
    let (cookie, _) = login(&service.app, PASSWORD).await;
    let original = br#"{"log":{"level":"info"},"keep":1}"#;
    let project = create_project(
        &service.app,
        &cookie,
        "  Travel  ",
        "sing-box",
        "config.json",
        original,
    )
    .await;
    assert_eq!(project["name"], "Travel");
    assert_eq!(project["source"], STANDARD.encode(original));
    assert_eq!(project["currentRevisionId"], project["servedRevisionId"]);
    assert_eq!(project["lastValidation"]["level"], "syntax");
    let project_id = project["id"].as_str().unwrap();
    let first_revision = project["currentRevisionId"].as_str().unwrap();

    let renamed = request(
        &service.app,
        Method::PATCH,
        &format!("/api/projects/{project_id}"),
        Some(&cookie),
        Some(json!({ "name": "  Updated  " })),
    )
    .await;
    assert_eq!(renamed.status(), StatusCode::OK);
    assert_eq!(response_json(renamed).await["name"], "Updated");

    let second_source = br#"{"log":{"level":"debug"},"keep":1}"#;
    let saved = request(
        &service.app,
        Method::POST,
        &format!("/api/projects/{project_id}/revisions"),
        Some(&cookie),
        Some(json!({
            "source": STANDARD.encode(second_source),
            "expectedRevisionId": first_revision,
        })),
    )
    .await;
    assert_eq!(saved.status(), StatusCode::OK);
    let saved = response_json(saved).await;
    assert_eq!(saved["unchanged"], false);
    let second_revision = saved["project"]["currentRevisionId"]
        .as_str()
        .unwrap()
        .to_owned();
    assert_eq!(
        saved["project"]["servedRevisionId"],
        saved["project"]["currentRevisionId"]
    );

    let parent: Option<String> =
        sqlx::query_scalar("SELECT parent_revision_id FROM config_revisions WHERE id = ?")
            .bind(&second_revision)
            .fetch_one(&service.state.pool)
            .await
            .unwrap();
    assert_eq!(parent.as_deref(), Some(first_revision));
    let stored_content_hash: Vec<u8> =
        sqlx::query_scalar("SELECT content_hash FROM config_revisions WHERE id = ?")
            .bind(&second_revision)
            .fetch_one(&service.state.pool)
            .await
            .unwrap();
    assert_eq!(
        stored_content_hash,
        Sha256::digest(second_source).as_slice()
    );

    let unchanged = request(
        &service.app,
        Method::POST,
        &format!("/api/projects/{project_id}/revisions"),
        Some(&cookie),
        Some(json!({
            "source": STANDARD.encode(second_source),
            "expectedRevisionId": second_revision,
        })),
    )
    .await;
    assert_eq!(response_json(unchanged).await["unchanged"], true);
    let count: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM config_revisions WHERE project_id = ?")
            .bind(project_id)
            .fetch_one(&service.state.pool)
            .await
            .unwrap();
    assert_eq!(count, 2);

    let stale = request(
        &service.app,
        Method::POST,
        &format!("/api/projects/{project_id}/revisions"),
        Some(&cookie),
        Some(json!({
            "source": STANDARD.encode(br#"{"log":{"level":"warn"}}"#),
            "expectedRevisionId": first_revision,
        })),
    )
    .await;
    assert_eq!(stale.status(), StatusCode::CONFLICT);
    assert_eq!(response_json(stale).await["code"], "revision.conflict");

    let invalid = request(
        &service.app,
        Method::POST,
        &format!("/api/projects/{project_id}/revisions"),
        Some(&cookie),
        Some(json!({
            "source": STANDARD.encode(b"{"),
            "expectedRevisionId": second_revision,
        })),
    )
    .await;
    assert_eq!(invalid.status(), StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(response_json(invalid).await["code"], "validation.failed");

    let third_a = br#"{"log":{"level":"warn"},"writer":"a"}"#;
    let third_b = br#"{"log":{"level":"error"},"writer":"b"}"#;
    let uri = format!("/api/projects/{project_id}/revisions");
    let request_a = request(
        &service.app,
        Method::POST,
        &uri,
        Some(&cookie),
        Some(json!({
            "source": STANDARD.encode(third_a),
            "expectedRevisionId": second_revision,
        })),
    );
    let request_b = request(
        &service.app,
        Method::POST,
        &uri,
        Some(&cookie),
        Some(json!({
            "source": STANDARD.encode(third_b),
            "expectedRevisionId": second_revision,
        })),
    );
    let (response_a, response_b) = tokio::join!(request_a, request_b);
    let mut statuses = [response_a.status(), response_b.status()];
    statuses.sort_by_key(|status| status.as_u16());
    assert_eq!(statuses, [StatusCode::OK, StatusCode::CONFLICT]);
    let revision_count: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM config_revisions WHERE project_id = ?")
            .bind(project_id)
            .fetch_one(&service.state.pool)
            .await
            .unwrap();
    assert_eq!(revision_count, 3);
    let distinct_numbers: i64 = sqlx::query_scalar(
        "SELECT COUNT(DISTINCT revision_no) FROM config_revisions WHERE project_id = ?",
    )
    .bind(project_id)
    .fetch_one(&service.state.pool)
    .await
    .unwrap();
    assert_eq!(distinct_numbers, 3);

    let database_url = service.database_url.clone();
    let directory = service._directory;
    drop(service.app);
    service.state.pool.close().await;
    let restarted = initialize(&database_url, None, 1024 * 1024).await;
    let persisted: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM projects")
        .fetch_one(&restarted.pool)
        .await
        .unwrap();
    assert_eq!(persisted, 1);
    restarted.pool.close().await;
    drop(directory);
}

#[tokio::test]
async fn revision_history_is_ordered_metadata_and_explicit_byte_preserving_detail() {
    let service = TestService::new().await;
    let (cookie, _) = login(&service.app, PASSWORD).await;
    let first_source = b"{}\n";
    let project = create_project(
        &service.app,
        &cookie,
        "History",
        "sing-box",
        "config.json",
        first_source,
    )
    .await;
    let project_id = project["id"].as_str().unwrap().to_owned();
    let first_revision = project["currentRevisionId"].as_str().unwrap().to_owned();

    let history_uri = format!("/api/projects/{project_id}/revisions");
    let initial = request(&service.app, Method::GET, &history_uri, Some(&cookie), None).await;
    assert_eq!(initial.status(), StatusCode::OK);
    assert_eq!(initial.headers()[header::CACHE_CONTROL], "no-store");
    let initial = response_json(initial).await;
    assert_eq!(initial["nextCursor"], Value::Null);
    assert_eq!(initial["items"].as_array().unwrap().len(), 1);
    let first = &initial["items"][0];
    assert_eq!(first["id"], first_revision);
    assert_eq!(first["revisionNo"], 1);
    assert_eq!(first["parentRevisionId"], Value::Null);
    assert_eq!(first["byteLength"], first_source.len());
    assert_eq!(
        first["contentHash"],
        hex_bytes(&Sha256::digest(first_source))
    );
    assert_eq!(first["isCurrent"], true);
    assert_eq!(first["isServed"], true);
    assert!(first.get("source").is_none());

    let second_source = b"{\"log\":{\"level\":\"warn\"}}\n";
    let saved = request(
        &service.app,
        Method::POST,
        &history_uri,
        Some(&cookie),
        Some(json!({
            "source": STANDARD.encode(second_source),
            "expectedRevisionId": first_revision,
        })),
    )
    .await;
    assert_eq!(saved.status(), StatusCode::OK);
    let second_revision = response_json(saved).await["project"]["currentRevisionId"]
        .as_str()
        .unwrap()
        .to_owned();

    let history = response_json(
        request(
            &service.app,
            Method::GET,
            &format!("{history_uri}?limit=1"),
            Some(&cookie),
            None,
        )
        .await,
    )
    .await;
    assert_eq!(history["items"].as_array().unwrap().len(), 1);
    assert_eq!(history["items"][0]["id"], second_revision);
    assert_eq!(history["items"][0]["revisionNo"], 2);
    assert_eq!(history["items"][0]["parentRevisionId"], first_revision);
    assert_eq!(history["items"][0]["isCurrent"], true);
    assert_eq!(history["items"][0]["isServed"], true);
    assert_eq!(history["nextCursor"], second_revision);

    let older = response_json(
        request(
            &service.app,
            Method::GET,
            &format!("{history_uri}?limit=1&cursor={second_revision}"),
            Some(&cookie),
            None,
        )
        .await,
    )
    .await;
    assert_eq!(older["items"].as_array().unwrap().len(), 1);
    assert_eq!(older["items"][0]["id"], first_revision);
    assert_eq!(older["items"][0]["isCurrent"], false);
    assert_eq!(older["items"][0]["isServed"], false);
    assert_eq!(older["nextCursor"], Value::Null);

    let invalid_limit = request(
        &service.app,
        Method::GET,
        &format!("{history_uri}?limit=101"),
        Some(&cookie),
        None,
    )
    .await;
    assert_eq!(invalid_limit.status(), StatusCode::BAD_REQUEST);
    assert_eq!(
        response_json(invalid_limit).await["code"],
        "request.invalid"
    );

    let malformed_limit = request(
        &service.app,
        Method::GET,
        &format!("{history_uri}?limit=not-a-number"),
        Some(&cookie),
        None,
    )
    .await;
    assert_eq!(malformed_limit.status(), StatusCode::BAD_REQUEST);
    assert_eq!(
        response_json(malformed_limit).await["code"],
        "request.invalid"
    );

    let invalid_cursor = request(
        &service.app,
        Method::GET,
        &format!("{history_uri}?cursor=missing"),
        Some(&cookie),
        None,
    )
    .await;
    assert_eq!(invalid_cursor.status(), StatusCode::BAD_REQUEST);
    assert_eq!(
        response_json(invalid_cursor).await["code"],
        "revision.invalid_cursor"
    );

    let detail_uri = format!("/api/projects/{project_id}/revisions/{second_revision}");
    let detail = request(&service.app, Method::GET, &detail_uri, Some(&cookie), None).await;
    assert_eq!(detail.status(), StatusCode::OK);
    assert_eq!(detail.headers()[header::CACHE_CONTROL], "no-store");
    let detail = response_json(detail).await;
    assert_eq!(detail["source"], STANDARD.encode(second_source));
    assert_eq!(
        detail["contentHash"],
        hex_bytes(&Sha256::digest(second_source))
    );

    let missing = request(
        &service.app,
        Method::GET,
        &format!("/api/projects/{project_id}/revisions/missing"),
        Some(&cookie),
        None,
    )
    .await;
    assert_eq!(missing.status(), StatusCode::NOT_FOUND);
    assert_eq!(response_json(missing).await["code"], "revision.not_found");

    let other_project = create_project(
        &service.app,
        &cookie,
        "Other",
        "sing-box",
        "other.json",
        b"{}",
    )
    .await;
    let other_revision = other_project["currentRevisionId"].as_str().unwrap();
    let cross_project_cursor = request(
        &service.app,
        Method::GET,
        &format!("{history_uri}?cursor={other_revision}"),
        Some(&cookie),
        None,
    )
    .await;
    assert_eq!(cross_project_cursor.status(), StatusCode::BAD_REQUEST);
    assert_eq!(
        response_json(cross_project_cursor).await["code"],
        "revision.invalid_cursor"
    );
    let cross_project = request(
        &service.app,
        Method::GET,
        &format!(
            "/api/projects/{}/revisions/{first_revision}",
            other_project["id"].as_str().unwrap()
        ),
        Some(&cookie),
        None,
    )
    .await;
    assert_eq!(cross_project.status(), StatusCode::NOT_FOUND);
    assert_eq!(
        response_json(cross_project).await["code"],
        "revision.not_found"
    );
}

#[tokio::test]
async fn revision_diff_is_authenticated_static_read_only_and_source_preserving() {
    let service = TestService::new().await;
    let (cookie, _) = login(&service.app, PASSWORD).await;
    let from_source = "[General]\r\nname=old\n家庭网络=保留\r\n".as_bytes();
    let project = create_project(
        &service.app,
        &cookie,
        "Diff",
        "surge",
        "config.conf",
        from_source,
    )
    .await;
    let project_id = project["id"].as_str().unwrap().to_owned();
    let from_revision = project["currentRevisionId"].as_str().unwrap().to_owned();
    let to_source = "[General]\r\nname=new\n家庭网络=保留\r\n".as_bytes();
    let saved = request(
        &service.app,
        Method::POST,
        &format!("/api/projects/{project_id}/revisions"),
        Some(&cookie),
        Some(json!({
            "source": STANDARD.encode(to_source),
            "expectedRevisionId": from_revision,
        })),
    )
    .await;
    assert_eq!(saved.status(), StatusCode::OK);
    let to_revision = response_json(saved).await["project"]["currentRevisionId"]
        .as_str()
        .unwrap()
        .to_owned();

    let path = format!(
        "/api/projects/{project_id}/revisions/diff?fromRevisionId={from_revision}&toRevisionId={to_revision}"
    );
    let unauthenticated = request(&service.app, Method::GET, &path, None, None).await;
    assert_eq!(unauthenticated.status(), StatusCode::UNAUTHORIZED);

    let response = request(&service.app, Method::GET, &path, Some(&cookie), None).await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
    let diff = response_json(response).await;
    assert_eq!(diff["from"]["id"], from_revision);
    assert_eq!(diff["to"]["id"], to_revision);
    assert_eq!(diff["from"]["lineEnding"], "mixed");
    assert_eq!(diff["to"]["lineEnding"], "mixed");
    assert_eq!(diff["additions"], 1);
    assert_eq!(diff["deletions"], 1);
    assert!(diff.get("source").is_none());
    assert!(diff["from"].get("source").is_none());
    assert!(diff["to"].get("source").is_none());
    assert_eq!(diff["hunks"][0]["lines"][1]["kind"], "delete");
    assert_eq!(diff["hunks"][0]["lines"][2]["kind"], "insert");

    let reverse = response_json(
        request(
            &service.app,
            Method::GET,
            &format!(
                "/api/projects/{project_id}/revisions/diff?fromRevisionId={to_revision}&toRevisionId={from_revision}"
            ),
            Some(&cookie),
            None,
        )
        .await,
    )
    .await;
    assert_eq!(reverse["from"]["id"], to_revision);
    assert_eq!(reverse["to"]["id"], from_revision);
    assert_eq!(reverse["hunks"][0]["lines"][1]["kind"], "delete");
    assert_eq!(reverse["hunks"][0]["lines"][2]["kind"], "insert");

    let identical = response_json(
        request(
            &service.app,
            Method::GET,
            &format!(
                "/api/projects/{project_id}/revisions/diff?fromRevisionId={from_revision}&toRevisionId={from_revision}"
            ),
            Some(&cookie),
            None,
        )
        .await,
    )
    .await;
    assert_eq!(identical["identical"], true);
    assert_eq!(identical["additions"], 0);
    assert_eq!(identical["deletions"], 0);
    assert_eq!(identical["hunks"].as_array().unwrap().len(), 0);

    // Missing query values are handled by the explicit static route; this
    // must not fall through to /revisions/:revision_id.
    let missing_query = request(
        &service.app,
        Method::GET,
        &format!("/api/projects/{project_id}/revisions/diff"),
        Some(&cookie),
        None,
    )
    .await;
    assert_eq!(missing_query.status(), StatusCode::BAD_REQUEST);

    let other = create_project(
        &service.app,
        &cookie,
        "Other diff",
        "surge",
        "other.conf",
        b"[General]\nother=value\n",
    )
    .await;
    let other_revision = other["currentRevisionId"].as_str().unwrap();
    let cross_project = request(
        &service.app,
        Method::GET,
        &format!(
            "/api/projects/{project_id}/revisions/diff?fromRevisionId={from_revision}&toRevisionId={other_revision}"
        ),
        Some(&cookie),
        None,
    )
    .await;
    assert_eq!(cross_project.status(), StatusCode::NOT_FOUND);
    assert_eq!(
        response_json(cross_project).await["code"],
        "revision.not_found"
    );

    let pointers: (String, String) =
        sqlx::query_as("SELECT current_revision_id, served_revision_id FROM projects WHERE id = ?")
            .bind(&project_id)
            .fetch_one(&service.state.pool)
            .await
            .unwrap();
    assert_eq!(pointers.0, to_revision);
    assert_eq!(pointers.1, to_revision);
}

#[tokio::test]
async fn revision_diff_rejects_oversized_input_before_returning_blob_data() {
    let service = TestService::new().await;
    let (cookie, _) = login(&service.app, PASSWORD).await;
    let project = create_project(
        &service.app,
        &cookie,
        "Large diff",
        "surge",
        "large.conf",
        b"[General]\nsmall=value\n",
    )
    .await;
    let project_id = project["id"].as_str().unwrap().to_owned();
    let first_revision = project["currentRevisionId"].as_str().unwrap().to_owned();
    let huge = vec![b'x'; 8 * 1024 * 1024 + 1];
    let huge_revision = "synthetic-large-revision";
    let validation_json = r#"{"level":"basic","diagnostics":[]}"#;
    sqlx::query(
        "INSERT INTO config_revisions (id, project_id, parent_revision_id, revision_no, source_bytes, content_hash, validation_level, validation_result, validator_version, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)",
    )
    .bind(huge_revision)
    .bind(&project_id)
    .bind(&first_revision)
    .bind(2_i64)
    .bind(&huge)
    .bind(Sha256::digest(&huge).as_slice())
    .bind("basic")
    .bind(validation_json)
    .bind(unix_timestamp())
    .execute(&service.state.pool)
    .await
    .unwrap();

    let before_count: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM config_revisions WHERE project_id = ?")
            .bind(&project_id)
            .fetch_one(&service.state.pool)
            .await
            .unwrap();
    let response = request(
        &service.app,
        Method::GET,
        &format!(
            "/api/projects/{project_id}/revisions/diff?fromRevisionId={first_revision}&toRevisionId={huge_revision}"
        ),
        Some(&cookie),
        None,
    )
    .await;
    assert_eq!(response.status(), StatusCode::PAYLOAD_TOO_LARGE);
    assert_eq!(
        response_json(response).await["code"],
        "revision.diff_too_large"
    );
    let after_count: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM config_revisions WHERE project_id = ?")
            .bind(&project_id)
            .fetch_one(&service.state.pool)
            .await
            .unwrap();
    assert_eq!(after_count, before_count);
    let pointers: (String, String) =
        sqlx::query_as("SELECT current_revision_id, served_revision_id FROM projects WHERE id = ?")
            .bind(&project_id)
            .fetch_one(&service.state.pool)
            .await
            .unwrap();
    assert_eq!(pointers.0, first_revision);
    assert_eq!(pointers.1, first_revision);
}

#[tokio::test]
async fn app_state_clones_share_one_diff_slot() {
    let service = TestService::new().await;
    let cloned = service.state.clone();

    assert_eq!(MAX_CONCURRENT_DIFFS, 1);
    assert!(Arc::ptr_eq(&service.state.diff_slots, &cloned.diff_slots));
    assert_eq!(cloned.diff_slots.available_permits(), 1);
    let permit = service
        .state
        .diff_slots
        .clone()
        .acquire_owned()
        .await
        .unwrap();
    assert_eq!(cloned.diff_slots.available_permits(), 0);
    drop(permit);
    assert_eq!(cloned.diff_slots.available_permits(), 1);
}

#[tokio::test]
async fn diff_waits_for_slot_before_loading_revision_blobs() {
    let service = TestService::new().await;
    let (cookie, _) = login(&service.app, PASSWORD).await;
    let project = create_project(
        &service.app,
        &cookie,
        "Queued diff load",
        "surge",
        "queued.conf",
        b"old=value\n",
    )
    .await;
    let project_id = project["id"].as_str().unwrap().to_owned();
    let from_revision_id = project["currentRevisionId"].as_str().unwrap().to_owned();
    let to_revision_id = "queued-late-revision";
    let permit = service
        .state
        .diff_slots
        .clone()
        .acquire_owned()
        .await
        .unwrap();
    let mut pending = Box::pin(storage::get_revision_diff(
        &service.state.pool,
        &service.state.diff_slots,
        &project_id,
        &from_revision_id,
        to_revision_id,
    ));

    assert!(
        tokio::time::timeout(Duration::from_millis(50), pending.as_mut())
            .await
            .is_err()
    );
    let to_source = b"new=value\n";
    sqlx::query(
        "INSERT INTO config_revisions (id, project_id, parent_revision_id, revision_no, source_bytes, content_hash, validation_level, validation_result, validator_version, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)",
    )
        .bind(to_revision_id)
        .bind(&project_id)
        .bind(&from_revision_id)
        .bind(2_i64)
        .bind(to_source.as_slice())
        .bind(Sha256::digest(to_source).as_slice())
        .bind("basic")
        .bind(r#"{"level":"basic","diagnostics":[]}"#)
        .bind(unix_timestamp())
        .execute(&service.state.pool)
        .await
        .unwrap();
    drop(permit);

    let diff = pending.await.unwrap();
    assert_eq!(diff.from.summary.id, from_revision_id);
    assert_eq!(diff.to.summary.id, to_revision_id);
    assert!(!diff.identical);
}

#[tokio::test]
async fn queued_diff_requests_share_the_slot_and_finish_after_release() {
    let service = TestService::new().await;
    let (cookie, _) = login(&service.app, PASSWORD).await;
    let project = create_project(
        &service.app,
        &cookie,
        "Queued diffs",
        "surge",
        "queued.conf",
        b"same=value\n",
    )
    .await;
    let project_id = project["id"].as_str().unwrap().to_owned();
    let revision_id = project["currentRevisionId"].as_str().unwrap().to_owned();
    let permit = service
        .state
        .diff_slots
        .clone()
        .acquire_owned()
        .await
        .unwrap();
    let mut first = Box::pin(storage::get_revision_diff(
        &service.state.pool,
        &service.state.diff_slots,
        &project_id,
        &revision_id,
        &revision_id,
    ));
    let mut second = Box::pin(storage::get_revision_diff(
        &service.state.pool,
        &service.state.diff_slots,
        &project_id,
        &revision_id,
        &revision_id,
    ));

    assert!(tokio::time::timeout(Duration::from_millis(50), async {
        tokio::join!(first.as_mut(), second.as_mut())
    })
    .await
    .is_err());
    drop(permit);

    let (first_result, second_result) = tokio::join!(first.as_mut(), second.as_mut());
    assert!(first_result.unwrap().identical);
    assert!(second_result.unwrap().identical);
    assert_eq!(service.state.diff_slots.available_permits(), 1);
}

fn hex_bytes(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

#[tokio::test]
async fn invalid_inputs_and_failed_validation_leave_no_database_residue() {
    let service = TestService::with_max_bytes(32).await;
    let (cookie, _) = login(&service.app, PASSWORD).await;

    let cases = [
        (
            json!({ "name": "ok", "targetId": "unknown", "fileName": "a.conf", "source": "eA==" }),
            StatusCode::BAD_REQUEST,
            "target.unknown",
        ),
        (
            json!({ "name": "ok", "targetId": "sing-box", "fileName": "a.json", "source": "not base64" }),
            StatusCode::BAD_REQUEST,
            "request.invalid",
        ),
        (
            json!({ "name": "\n", "targetId": "sing-box", "fileName": "a.json", "source": "e30=" }),
            StatusCode::BAD_REQUEST,
            "project.invalid_name",
        ),
        (
            json!({ "name": "ok", "targetId": "sing-box", "fileName": "../a.json", "source": "e30=" }),
            StatusCode::BAD_REQUEST,
            "request.invalid",
        ),
        (
            json!({ "name": "ok", "targetId": "sing-box", "fileName": "a.json", "source": STANDARD.encode([0xff, 0xfe]) }),
            StatusCode::BAD_REQUEST,
            "encoding.unsupported",
        ),
        (
            json!({ "name": "ok", "targetId": "sing-box", "fileName": "a.json", "source": STANDARD.encode(b"{") }),
            StatusCode::UNPROCESSABLE_ENTITY,
            "validation.failed",
        ),
        (
            json!({ "name": "ok", "targetId": "sing-box", "fileName": "a.json", "source": STANDARD.encode([0_u8; 33]) }),
            StatusCode::PAYLOAD_TOO_LARGE,
            "request.too_large",
        ),
    ];

    for (body, status, code) in cases {
        let response = request(
            &service.app,
            Method::POST,
            "/api/projects",
            Some(&cookie),
            Some(body),
        )
        .await;
        assert_eq!(response.status(), status);
        assert_eq!(response_json(response).await["code"], code);
    }
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM projects")
        .fetch_one(&service.state.pool)
        .await
        .unwrap();
    assert_eq!(count, 0);

    let oversized = json!({
        "name": "ok",
        "targetId": "sing-box",
        "fileName": "a.json",
        "source": "A".repeat(70_000),
    });
    let response = request(
        &service.app,
        Method::POST,
        "/api/projects",
        Some(&cookie),
        Some(oversized),
    )
    .await;
    assert_eq!(response.status(), StatusCode::PAYLOAD_TOO_LARGE);
    assert_eq!(response_json(response).await["code"], "request.too_large");
}

#[tokio::test]
async fn stable_tokens_store_only_hash_serve_exact_bytes_and_revoke_or_cascade() {
    let service = TestService::new().await;
    let (cookie, _) = login(&service.app, PASSWORD).await;
    let source = [
        &[0xef, 0xbb, 0xbf][..],
        b"{\r\n  \"log\": {\"level\": \"info\"},\n  \"note\": \"\xe5\xae\xb6\xe5\xba\xad\xe7\xbd\x91\xe7\xbb\x9c\"\r\n}\r\n",
    ]
    .concat();
    let project = create_project(
        &service.app,
        &cookie,
        "Bytes",
        "sing-box",
        "config.json",
        &source,
    )
    .await;
    let project_id = project["id"].as_str().unwrap();

    let created = request(
        &service.app,
        Method::POST,
        &format!("/api/projects/{project_id}/tokens"),
        Some(&cookie),
        None,
    )
    .await;
    assert_eq!(created.status(), StatusCode::CREATED);
    let created = response_json(created).await;
    let plaintext = created["plaintext"].as_str().unwrap();
    let token_id = created["token"]["id"].as_str().unwrap();
    assert_eq!(
        created["url"],
        format!("http://127.0.0.1:8787/sub/{plaintext}")
    );

    let stored_hash: Vec<u8> =
        sqlx::query_scalar("SELECT token_hash FROM access_tokens WHERE id = ?")
            .bind(token_id)
            .fetch_one(&service.state.pool)
            .await
            .unwrap();
    assert_eq!(stored_hash, token_hash(plaintext));
    assert_ne!(stored_hash, plaintext.as_bytes());

    let listed = request(
        &service.app,
        Method::GET,
        &format!("/api/projects/{project_id}/tokens"),
        Some(&cookie),
        None,
    )
    .await;
    let listed_text = String::from_utf8(response_bytes(listed).await).unwrap();
    assert!(!listed_text.contains(plaintext));

    let served = request(
        &service.app,
        Method::GET,
        &format!("/sub/{plaintext}"),
        None,
        None,
    )
    .await;
    assert_eq!(served.status(), StatusCode::OK);
    assert_eq!(
        served.headers()[header::CONTENT_TYPE],
        "application/octet-stream"
    );
    assert_eq!(served.headers()[header::CACHE_CONTROL], "no-store");
    assert_eq!(served.headers()["x-content-type-options"], "nosniff");
    assert_eq!(response_bytes(served).await, source);
    let last_used: Option<i64> =
        sqlx::query_scalar("SELECT last_used_at FROM access_tokens WHERE id = ?")
            .bind(token_id)
            .fetch_one(&service.state.pool)
            .await
            .unwrap();
    assert!(last_used.is_some());

    let revoked = request(
        &service.app,
        Method::DELETE,
        &format!("/api/projects/{project_id}/tokens/{token_id}"),
        Some(&cookie),
        None,
    )
    .await;
    assert_eq!(revoked.status(), StatusCode::NO_CONTENT);
    assert_eq!(
        request(
            &service.app,
            Method::GET,
            &format!("/sub/{plaintext}"),
            None,
            None,
        )
        .await
        .status(),
        StatusCode::NOT_FOUND
    );

    let second = response_json(
        request(
            &service.app,
            Method::POST,
            &format!("/api/projects/{project_id}/tokens"),
            Some(&cookie),
            None,
        )
        .await,
    )
    .await;
    let second_plaintext = second["plaintext"].as_str().unwrap().to_owned();
    let updated_source = [
        &[0xef, 0xbb, 0xbf][..],
        b"{\r\n  \"log\": {\"level\": \"warn\"},\n  \"note\": \"\xe5\xae\xb6\xe5\xba\xad\xe7\xbd\x91\xe7\xbb\x9c\"\r\n}\r\n",
    ]
    .concat();
    let saved = request(
        &service.app,
        Method::POST,
        &format!("/api/projects/{project_id}/revisions"),
        Some(&cookie),
        Some(json!({
            "source": STANDARD.encode(&updated_source),
            "expectedRevisionId": project["currentRevisionId"],
        })),
    )
    .await;
    assert_eq!(saved.status(), StatusCode::OK);
    let served_updated = request(
        &service.app,
        Method::GET,
        &format!("/sub/{second_plaintext}"),
        None,
        None,
    )
    .await;
    assert_eq!(response_bytes(served_updated).await, updated_source);
    assert_eq!(
        request(
            &service.app,
            Method::DELETE,
            &format!("/api/projects/{project_id}"),
            Some(&cookie),
            None,
        )
        .await
        .status(),
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        request(
            &service.app,
            Method::GET,
            &format!("/sub/{second_plaintext}"),
            None,
            None,
        )
        .await
        .status(),
        StatusCode::NOT_FOUND
    );
    let revisions: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM config_revisions")
        .fetch_one(&service.state.pool)
        .await
        .unwrap();
    let tokens: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM access_tokens")
        .fetch_one(&service.state.pool)
        .await
        .unwrap();
    assert_eq!((revisions, tokens), (0, 0));
}

#[tokio::test]
async fn password_change_keeps_current_session_revokes_others_and_bootstrap_does_not_override() {
    let service = TestService::new().await;
    let (first_cookie, _) = login(&service.app, PASSWORD).await;
    let (second_cookie, _) = login(&service.app, PASSWORD).await;

    let invalid = request(
        &service.app,
        Method::POST,
        "/api/admin/password",
        Some(&first_cookie),
        Some(json!({ "currentPassword": PASSWORD, "nextPassword": "short" })),
    )
    .await;
    assert_eq!(invalid.status(), StatusCode::BAD_REQUEST);

    let changed = request(
        &service.app,
        Method::POST,
        "/api/admin/password",
        Some(&first_cookie),
        Some(json!({
            "currentPassword": PASSWORD,
            "nextPassword": "a new secure password",
        })),
    )
    .await;
    assert_eq!(changed.status(), StatusCode::NO_CONTENT);
    assert_eq!(
        request(
            &service.app,
            Method::GET,
            "/api/projects",
            Some(&first_cookie),
            None,
        )
        .await
        .status(),
        StatusCode::OK
    );
    assert_eq!(
        request(
            &service.app,
            Method::GET,
            "/api/projects",
            Some(&second_cookie),
            None,
        )
        .await
        .status(),
        StatusCode::UNAUTHORIZED
    );

    let old_login = request(
        &service.app,
        Method::POST,
        "/api/session",
        None,
        Some(json!({ "password": PASSWORD })),
    )
    .await;
    assert_eq!(old_login.status(), StatusCode::UNAUTHORIZED);
    let _ = login(&service.app, "a new secure password").await;

    let database_url = service.database_url.clone();
    let directory = service._directory;
    drop(service.app);
    service.state.pool.close().await;
    let restarted = initialize(
        &database_url,
        Some("should not replace database password"),
        1024 * 1024,
    )
    .await;
    let restarted_app = router(restarted.clone());
    let _ = login(&restarted_app, "a new secure password").await;
    restarted.pool.close().await;
    drop(directory);
}

#[tokio::test]
async fn expired_sessions_are_rejected_cleared_and_removed() {
    let service = TestService::new().await;
    let (cookie, body) = login(&service.app, PASSWORD).await;
    sqlx::query("UPDATE sessions SET expires_at = ? WHERE id = ?")
        .bind(unix_timestamp() - 1)
        .bind(body["id"].as_str().unwrap())
        .execute(&service.state.pool)
        .await
        .unwrap();
    let current = request(
        &service.app,
        Method::GET,
        "/api/session",
        Some(&cookie),
        None,
    )
    .await;
    assert_eq!(current.status(), StatusCode::NOT_FOUND);
    assert!(current
        .headers()
        .get(header::SET_COOKIE)
        .unwrap()
        .to_str()
        .unwrap()
        .contains("Max-Age=0"));
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sessions")
        .fetch_one(&service.state.pool)
        .await
        .unwrap();
    assert_eq!(count, 0);
}

#[tokio::test]
async fn migration_enforces_foreign_keys_single_admin_and_revision_immutability() {
    let service = TestService::new().await;
    let foreign_keys: i64 = sqlx::query_scalar("PRAGMA foreign_keys")
        .fetch_one(&service.state.pool)
        .await
        .unwrap();
    let journal_mode: String = sqlx::query_scalar("PRAGMA journal_mode")
        .fetch_one(&service.state.pool)
        .await
        .unwrap();
    let busy_timeout: i64 = sqlx::query_scalar("PRAGMA busy_timeout")
        .fetch_one(&service.state.pool)
        .await
        .unwrap();
    assert_eq!(foreign_keys, 1);
    assert_eq!(journal_mode, "wal");
    assert_eq!(busy_timeout, 5000);
    assert!(sqlx::query(
        "INSERT INTO admins (id, password_hash, created_at, updated_at) VALUES (2, 'x', 0, 0)",
    )
    .execute(&service.state.pool)
    .await
    .is_err());
    assert!(sqlx::query(
        "INSERT INTO config_revisions (id, project_id, revision_no, source_bytes, content_hash, \
         validation_level, validation_result, created_at) VALUES ('r', 'missing', 1, X'', zeroblob(32), 'basic', '{}', 0)",
    )
    .execute(&service.state.pool)
    .await
    .is_err());

    let (cookie, _) = login(&service.app, PASSWORD).await;
    let project = create_project(
        &service.app,
        &cookie,
        "Immutable",
        "sing-box",
        "config.json",
        b"{}",
    )
    .await;
    assert!(
        sqlx::query("UPDATE config_revisions SET revision_no = 2 WHERE id = ?")
            .bind(project["currentRevisionId"].as_str().unwrap())
            .execute(&service.state.pool)
            .await
            .is_err()
    );
}

#[tokio::test]
async fn internal_error_response_does_not_expose_sql_database_path_or_config_bytes() {
    let service = TestService::new().await;
    let (cookie, _) = login(&service.app, PASSWORD).await;
    let project = create_project(
        &service.app,
        &cookie,
        "Safe error",
        "sing-box",
        "config.json",
        b"{}",
    )
    .await;
    let project_id = project["id"].as_str().unwrap();
    sqlx::query("UPDATE projects SET last_validation_result = 'not-json' WHERE id = ?")
        .bind(project_id)
        .execute(&service.state.pool)
        .await
        .unwrap();
    let response = request(
        &service.app,
        Method::GET,
        &format!("/api/projects/{project_id}"),
        Some(&cookie),
        None,
    )
    .await;
    assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
    let body = String::from_utf8(response_bytes(response).await).unwrap();
    assert!(body.contains("internal.error"));
    assert!(body.contains("requestId"));
    assert!(!body.contains("SELECT"));
    assert!(!body.contains("not-json"));
    assert!(!body.contains(&service.database_url));
}
