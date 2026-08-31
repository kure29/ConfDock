use confdock_service::{config::ServiceConfig, router, AppState};
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let log_filter = if std::env::var_os("RUST_LOG").is_some() {
        EnvFilter::try_from_default_env()?
    } else {
        EnvFilter::new("info")
    };
    tracing_subscriber::fmt().with_env_filter(log_filter).init();
    let config = ServiceConfig::from_env()?;
    let listen = config.listen;
    let state = AppState::initialize(config).await?;
    let listener = tokio::net::TcpListener::bind(listen).await?;
    tracing::info!(%listen, "ConfDock API listening");
    axum::serve(listener, router(state))
        .with_graceful_shutdown(shutdown_signal())
        .await?;
    Ok(())
}

async fn shutdown_signal() {
    let ctrl_c = async {
        tokio::signal::ctrl_c()
            .await
            .expect("failed to install Ctrl+C handler");
    };

    #[cfg(unix)]
    let terminate = async {
        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("failed to install SIGTERM handler")
            .recv()
            .await;
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
    }
    tracing::info!("ConfDock is shutting down");
}
