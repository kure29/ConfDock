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
use tokio::sync::{Mutex, RwLock, RwLockReadGuard, Semaphore};

use crate::{
    auth::{bootstrap_admin, cleanup_expired_sessions, AuthError, LoginThrottle},
    config::{ConfigError, ServiceConfig},
};

/// Acquire the public URL read boundary used by operations that persist a
/// value derived from it. Callers intentionally keep the returned guard until
/// their database work and response DTO are complete; settings updates hold
/// the matching write guard across their SQLite update.
pub(crate) async fn read_public_url(public_url: &RwLock<String>) -> RwLockReadGuard<'_, String> {
    public_url.read().await
}

// SQLite needs an exclusive schema lock while the first connection enables
// WAL and SQLx applies migrations. Serializing startup within one process
// avoids two listeners racing to open a brand-new database; SQLx still keeps
// its migration lock for separate processes.
static STARTUP_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

pub const MAX_CONCURRENT_DIFFS: usize = 1;

#[derive(Clone)]
pub struct AppState {
    pub pool: SqlitePool,
    pub config: Arc<ServiceConfig>,
    pub public_url: Arc<RwLock<String>>,
    pub registry: Arc<TargetRegistry>,
    pub login_throttle: Arc<LoginThrottle>,
    pub diff_slots: Arc<Semaphore>,
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
        let bootstrap_password = config.bootstrap_password.take();
        let state = Self::initialize_unbootstrapped(config).await?;
        let created = bootstrap_admin(&state.pool, bootstrap_password).await?;
        if created {
            tracing::info!("ConfDock administrator created");
        }
        Ok(state)
    }

    /// Open the database, apply migrations, and construct application state
    /// without requiring or creating an administrator. CLI first-run flows use
    /// this boundary so that they can collect a password interactively.
    pub async fn initialize_unbootstrapped(config: ServiceConfig) -> Result<Self, StartError> {
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
        config.secure_database_permissions()?;
        sqlx::migrate!("./migrations")
            .run(&pool)
            .await
            .map_err(|_| StartError::Migration)?;
        config.secure_database_permissions()?;

        let public_url = crate::storage::ensure_public_url(&pool, &config.public_url)
            .await
            .map_err(|_| StartError::Migration)?;
        let public_url =
            crate::config::normalize_public_url(&public_url).map_err(|_| StartError::Migration)?;

        cleanup_expired_sessions(&pool).await?;

        Ok(Self {
            pool,
            config: Arc::new(config),
            public_url: Arc::new(RwLock::new(public_url)),
            registry: Arc::new(TargetRegistry::builtin()),
            login_throttle: Arc::new(LoginThrottle::default()),
            diff_slots: Arc::new(Semaphore::new(MAX_CONCURRENT_DIFFS)),
        })
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use tokio::sync::{oneshot, RwLock};

    use super::read_public_url;

    #[tokio::test]
    async fn public_url_operation_holds_read_lock_until_future_finishes() {
        let public_url = Arc::new(RwLock::new("https://old.example.test".to_owned()));
        let (entered_tx, entered_rx) = oneshot::channel();
        let (release_tx, release_rx) = oneshot::channel();
        let operation_url = Arc::clone(&public_url);

        let operation = tokio::spawn(async move {
            let value = read_public_url(&operation_url).await;
            assert_eq!(value.as_str(), "https://old.example.test");
            entered_tx.send(()).unwrap();
            release_rx.await.unwrap();
            value.to_owned()
        });

        entered_rx.await.unwrap();
        assert!(public_url.try_write().is_err());

        release_tx.send(()).unwrap();
        assert_eq!(operation.await.unwrap(), "https://old.example.test");

        *public_url.write().await = "https://new.example.test".to_owned();
        assert_eq!(public_url.read().await.as_str(), "https://new.example.test");
    }
}
