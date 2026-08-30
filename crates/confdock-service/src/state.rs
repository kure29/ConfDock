use std::{
    str::FromStr,
    sync::{Arc, OnceLock},
    time::Duration,
};

use confdock_core::TargetRegistry;
use sqlx::{
    sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions},
    SqlitePool,
};
use thiserror::Error;
use tokio::sync::Mutex;

use crate::{
    auth::{bootstrap_admin, cleanup_expired_sessions, AuthError, LoginThrottle},
    config::{ConfigError, ServiceConfig},
};

// SQLite needs an exclusive schema lock while the first connection enables
// WAL and SQLx applies migrations. Serializing startup within one process
// avoids two listeners racing to open a brand-new database; SQLx still keeps
// its migration lock for separate processes.
static STARTUP_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

#[derive(Clone)]
pub struct AppState {
    pub pool: SqlitePool,
    pub config: Arc<ServiceConfig>,
    pub registry: Arc<TargetRegistry>,
    pub login_throttle: Arc<LoginThrottle>,
}

#[derive(Debug, Error)]
pub enum StartError {
    #[error(transparent)]
    Config(#[from] ConfigError),
    #[error(transparent)]
    Auth(#[from] AuthError),
    #[error("the SQLite database could not be opened")]
    DatabaseOpen,
    #[error("the SQLite migrations could not be applied")]
    Migration,
}

impl AppState {
    pub async fn initialize(mut config: ServiceConfig) -> Result<Self, StartError> {
        let _startup_guard = STARTUP_LOCK.get_or_init(|| Mutex::new(())).lock().await;
        config.prepare_database_parent()?;
        let options = SqliteConnectOptions::from_str(&config.database_url)
            .map_err(|_| StartError::DatabaseOpen)?
            .create_if_missing(true)
            .foreign_keys(true)
            .journal_mode(SqliteJournalMode::Wal)
            .busy_timeout(Duration::from_secs(5));
        let pool = SqlitePoolOptions::new()
            .max_connections(8)
            .connect_with(options)
            .await
            .map_err(|_| StartError::DatabaseOpen)?;
        sqlx::migrate!("./migrations")
            .run(&pool)
            .await
            .map_err(|_| StartError::Migration)?;

        let bootstrap_password = config.bootstrap_password.take();
        let created = bootstrap_admin(&pool, bootstrap_password).await?;
        if created {
            tracing::info!("ConfDock administrator created");
        }
        cleanup_expired_sessions(&pool).await?;

        Ok(Self {
            pool,
            config: Arc::new(config),
            registry: Arc::new(TargetRegistry::builtin()),
            login_throttle: Arc::new(LoginThrottle::default()),
        })
    }
}
