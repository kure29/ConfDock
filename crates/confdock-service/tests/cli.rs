use std::{fs, process::Command};

use std::net::SocketAddr;

use confdock_service::{
    auth::{authenticate, create_session, set_password_cli},
    config::ServiceConfig,
    AppState,
};
use tempfile::TempDir;

fn binary() -> &'static str {
    env!("CARGO_BIN_EXE_confdock")
}

#[test]
fn help_and_version_do_not_touch_an_unwritable_data_directory() {
    let directory = tempfile::tempdir().unwrap();
    let data_dir = directory.path().join("not-created");
    for args in [["--help"], ["--version"]] {
        let output = Command::new(binary())
            .args(args)
            .env("CONFDOCK_DATA_DIR", &data_dir)
            .current_dir(directory.path())
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
    assert!(!data_dir.exists());
}

#[test]
fn config_check_is_database_free_and_rejects_missing_files() {
    let directory = tempfile::tempdir().unwrap();
    let config = directory.path().join("config.toml");
    fs::write(&config, "data_dir = \"relative-data\"\n").unwrap();
    let output = Command::new(binary())
        .args(["config", "check", "--config"])
        .arg(&config)
        .current_dir(directory.path())
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(!directory.path().join("relative-data").exists());

    let missing = directory.path().join("missing.toml");
    let output = Command::new(binary())
        .args(["config", "check", "--config"])
        .arg(&missing)
        .output()
        .unwrap();
    assert!(!output.status.success());
    let error = String::from_utf8_lossy(&output.stderr);
    assert!(error.contains("missing.toml"));
}

#[test]
fn non_interactive_first_start_gives_actionable_message() {
    let directory = TempDir::new().unwrap();
    let data_dir = directory.path().join("data");
    let output = Command::new(binary())
        .env("CONFDOCK_DATA_DIR", &data_dir)
        .env("CONFDOCK_LISTEN", "127.0.0.1:0")
        .args(["serve"])
        .output()
        .unwrap();
    assert!(!output.status.success());
    let error = String::from_utf8_lossy(&output.stderr);
    assert!(error.contains("confdock admin init"));
    assert!(!error.contains("Auth("));
}

#[tokio::test]
async fn cli_password_change_invalidates_existing_sessions() {
    let directory = tempfile::tempdir().unwrap();
    let config = ServiceConfig::new(
        SocketAddr::from(([127, 0, 0, 1], 0)),
        format!(
            "sqlite://{}",
            directory.path().join("confdock.db").display()
        ),
        "http://127.0.0.1:8787".to_owned(),
        Some("old-password-123".to_owned()),
        3600,
        false,
        1024,
    )
    .unwrap();
    let state = AppState::initialize(config).await.unwrap();
    let (_, old_token) = create_session(&state.pool, 3600).await.unwrap();
    let (_, other_token) = create_session(&state.pool, 3600).await.unwrap();
    set_password_cli(&state.pool, "new-password-123".to_owned())
        .await
        .unwrap();
    assert!(authenticate(&state.pool, &old_token)
        .await
        .unwrap()
        .is_none());
    assert!(authenticate(&state.pool, &other_token)
        .await
        .unwrap()
        .is_none());
}
