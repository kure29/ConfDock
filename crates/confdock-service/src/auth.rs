use std::time::Duration;

use argon2::{
    password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString},
    Algorithm, Argon2, Params, Version,
};
use axum::http::{header, HeaderMap, HeaderValue};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use rand_core::{OsRng, RngCore};
use sha2::{Digest, Sha256};
use sqlx::{Row, SqlitePool};
use thiserror::Error;
use tokio::{
    sync::{Mutex, OwnedSemaphorePermit, Semaphore},
    time::Instant,
};
use uuid::Uuid;

use crate::config::{ServiceConfig, MAX_PASSWORD_BYTES};

pub const SESSION_COOKIE: &str = "confdock_session";
pub const SESSION_COOKIE_PATH: &str = "/api";
const PASSWORD_MIN_BYTES: usize = 8;
const ARGON2_MEMORY_KIB: u32 = 19 * 1024;
const ARGON2_ITERATIONS: u32 = 2;
const ARGON2_PARALLELISM: u32 = 1;
const PASSWORD_HASH_SLOTS: usize = 2;

#[derive(Debug, Error)]
pub enum AuthError {
    #[error("the first startup requires CONFDOCK_BOOTSTRAP_PASSWORD")]
    BootstrapPasswordRequired,
    #[error("the bootstrap password must contain 8 to 1024 bytes")]
    InvalidBootstrapPassword,
    #[error("password hashing failed")]
    PasswordHash,
    #[error("authentication database operation failed")]
    Database,
    #[error("authentication worker failed")]
    Worker,
}

#[derive(Clone, Debug)]
pub struct SessionIdentity {
    pub id: String,
    pub created_at: i64,
}

#[derive(Debug)]
pub struct LoginThrottle {
    inner: Mutex<LoginThrottleState>,
    password_hash_slots: std::sync::Arc<Semaphore>,
}

impl Default for LoginThrottle {
    fn default() -> Self {
        Self {
            inner: Mutex::new(LoginThrottleState::default()),
            password_hash_slots: std::sync::Arc::new(Semaphore::new(PASSWORD_HASH_SLOTS)),
        }
    }
}

#[derive(Debug, Default)]
struct LoginThrottleState {
    failures: u32,
    blocked_until: Option<Instant>,
}

impl LoginThrottle {
    pub async fn wait(&self) {
        let delay = {
            let state = self.inner.lock().await;
            state
                .blocked_until
                .and_then(|until| until.checked_duration_since(Instant::now()))
        };
        if let Some(delay) = delay {
            tokio::time::sleep(delay).await;
        }
    }

    pub async fn record_failure(&self) {
        let mut state = self.inner.lock().await;
        state.failures = state.failures.saturating_add(1).min(8);
        let multiplier = 1_u64 << state.failures.saturating_sub(1).min(3);
        state.blocked_until = Some(Instant::now() + Duration::from_millis(250 * multiplier));
    }

    pub async fn reset(&self) {
        *self.inner.lock().await = LoginThrottleState::default();
    }

    /// Bound the number of expensive Argon2 operations that can run at once.
    /// The semaphore is never closed during the service lifetime, so acquiring
    /// a permit cannot fail under normal operation.
    pub async fn password_hash_slot(&self) -> OwnedSemaphorePermit {
        self.password_hash_slots
            .clone()
            .acquire_owned()
            .await
            .expect("password hash semaphore remains open")
    }
}

pub async fn bootstrap_admin(
    pool: &SqlitePool,
    bootstrap_password: Option<String>,
) -> Result<bool, AuthError> {
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM admins")
        .fetch_one(pool)
        .await
        .map_err(|_| AuthError::Database)?;
    if count > 0 {
        return Ok(false);
    }

    let password = bootstrap_password.ok_or(AuthError::BootstrapPasswordRequired)?;
    if !valid_password(&password) {
        return Err(AuthError::InvalidBootstrapPassword);
    }
    let hash = hash_password_async(password).await?;
    let now = unix_timestamp();
    // Two processes can finish the first-start check at the same time.  Make
    // the insert idempotent so the loser observes an already-created admin
    // instead of turning a harmless startup race into a database failure.
    let inserted = sqlx::query(
        "INSERT INTO admins (id, password_hash, created_at, updated_at) VALUES (1, ?, ?, ?) \
         ON CONFLICT(id) DO NOTHING",
    )
    .bind(hash)
    .bind(now)
    .bind(now)
    .execute(pool)
    .await
    .map_err(|_| AuthError::Database)?;
    Ok(inserted.rows_affected() == 1)
}

pub async fn admin_exists(pool: &SqlitePool) -> Result<bool, AuthError> {
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM admins")
        .fetch_one(pool)
        .await
        .map_err(|_| AuthError::Database)?;
    Ok(count > 0)
}

/// Change the administrator password for the CLI. Unlike the authenticated
/// HTTP endpoint there is no current session to preserve, so all sessions are
/// invalidated atomically with the password update.
pub async fn set_password_cli(pool: &SqlitePool, next_password: String) -> Result<(), AuthError> {
    if !valid_password(&next_password) {
        return Err(AuthError::InvalidBootstrapPassword);
    }
    let next_hash = hash_password_async(next_password).await?;
    let mut transaction = pool.begin().await.map_err(|_| AuthError::Database)?;
    sqlx::query("UPDATE admins SET password_hash = ?, updated_at = ? WHERE id = 1")
        .bind(next_hash)
        .bind(unix_timestamp())
        .execute(&mut *transaction)
        .await
        .map_err(|_| AuthError::Database)?;
    sqlx::query("DELETE FROM sessions")
        .execute(&mut *transaction)
        .await
        .map_err(|_| AuthError::Database)?;
    transaction.commit().await.map_err(|_| AuthError::Database)
}

pub fn valid_password(password: &str) -> bool {
    (PASSWORD_MIN_BYTES..=MAX_PASSWORD_BYTES).contains(&password.len())
}

pub fn hash_password(password: &str) -> Result<String, AuthError> {
    let params = Params::new(
        ARGON2_MEMORY_KIB,
        ARGON2_ITERATIONS,
        ARGON2_PARALLELISM,
        None,
    )
    .map_err(|_| AuthError::PasswordHash)?;
    let argon2 = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    let salt = SaltString::generate(&mut OsRng);
    argon2
        .hash_password(password.as_bytes(), &salt)
        .map(|hash| hash.to_string())
        .map_err(|_| AuthError::PasswordHash)
}

pub fn verify_password(password: &str, encoded_hash: &str) -> bool {
    let Ok(parsed) = PasswordHash::new(encoded_hash) else {
        return false;
    };
    Argon2::default()
        .verify_password(password.as_bytes(), &parsed)
        .is_ok()
}

pub async fn hash_password_async(password: String) -> Result<String, AuthError> {
    tokio::task::spawn_blocking(move || hash_password(&password))
        .await
        .map_err(|_| AuthError::Worker)?
}

pub async fn verify_password_async(
    password: String,
    encoded_hash: String,
) -> Result<bool, AuthError> {
    tokio::task::spawn_blocking(move || verify_password(&password, &encoded_hash))
        .await
        .map_err(|_| AuthError::Worker)
}

pub fn random_token() -> String {
    let mut bytes = [0_u8; 32];
    OsRng.fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

pub fn token_hash(token: &str) -> [u8; 32] {
    Sha256::digest(token.as_bytes()).into()
}

pub async fn create_session(
    pool: &SqlitePool,
    ttl_seconds: i64,
) -> Result<(SessionIdentity, String), AuthError> {
    cleanup_expired_sessions(pool).await?;
    let identity = SessionIdentity {
        id: Uuid::new_v4().to_string(),
        created_at: unix_timestamp(),
    };
    let plaintext = random_token();
    let hash = token_hash(&plaintext);
    sqlx::query(
        "INSERT INTO sessions (id, token_hash, created_at, expires_at, last_seen_at) \
         VALUES (?, ?, ?, ?, ?)",
    )
    .bind(&identity.id)
    .bind(hash.as_slice())
    .bind(identity.created_at)
    .bind(identity.created_at.saturating_add(ttl_seconds))
    .bind(identity.created_at)
    .execute(pool)
    .await
    .map_err(|_| AuthError::Database)?;
    Ok((identity, plaintext))
}

pub async fn authenticate(
    pool: &SqlitePool,
    token: &str,
) -> Result<Option<SessionIdentity>, AuthError> {
    if token.len() > 256 {
        return Ok(None);
    }
    let now = unix_timestamp();
    let hash = token_hash(token);
    let row =
        sqlx::query("SELECT id, created_at FROM sessions WHERE token_hash = ? AND expires_at > ?")
            .bind(hash.as_slice())
            .bind(now)
            .fetch_optional(pool)
            .await
            .map_err(|_| AuthError::Database)?;
    let Some(row) = row else {
        cleanup_expired_sessions(pool).await?;
        return Ok(None);
    };
    let identity = SessionIdentity {
        id: row.try_get("id").map_err(|_| AuthError::Database)?,
        created_at: row.try_get("created_at").map_err(|_| AuthError::Database)?,
    };
    sqlx::query("UPDATE sessions SET last_seen_at = ? WHERE id = ?")
        .bind(now)
        .bind(&identity.id)
        .execute(pool)
        .await
        .map_err(|_| AuthError::Database)?;
    Ok(Some(identity))
}

pub async fn delete_session(pool: &SqlitePool, id: &str) -> Result<(), AuthError> {
    sqlx::query("DELETE FROM sessions WHERE id = ?")
        .bind(id)
        .execute(pool)
        .await
        .map_err(|_| AuthError::Database)?;
    Ok(())
}

pub async fn cleanup_expired_sessions(pool: &SqlitePool) -> Result<(), AuthError> {
    sqlx::query("DELETE FROM sessions WHERE expires_at <= ?")
        .bind(unix_timestamp())
        .execute(pool)
        .await
        .map_err(|_| AuthError::Database)?;
    Ok(())
}

pub fn cookie_token(headers: &HeaderMap) -> Option<&str> {
    let cookie = headers.get(header::COOKIE)?.to_str().ok()?;
    cookie.split(';').find_map(|part| {
        let (name, value) = part.trim().split_once('=')?;
        (name == SESSION_COOKIE).then_some(value)
    })
}

pub fn session_cookie(token: &str, config: &ServiceConfig) -> HeaderValue {
    let secure = if config.cookie_secure { "; Secure" } else { "" };
    HeaderValue::from_str(&format!(
        "{SESSION_COOKIE}={token}; Path={SESSION_COOKIE_PATH}; HttpOnly; SameSite=Strict; Max-Age={}{}",
        config.session_ttl_seconds, secure
    ))
    .expect("generated cookie contains only header-safe characters")
}

pub fn clear_session_cookie(config: &ServiceConfig) -> HeaderValue {
    let secure = if config.cookie_secure { "; Secure" } else { "" };
    HeaderValue::from_str(&format!(
        "{SESSION_COOKIE}=; Path={SESSION_COOKIE_PATH}; HttpOnly; SameSite=Strict; Max-Age=0{secure}"
    ))
    .expect("static cookie is header-safe")
}

pub fn unix_timestamp() -> i64 {
    time::OffsetDateTime::now_utc().unix_timestamp()
}

#[cfg(test)]
mod tests {
    use std::net::SocketAddr;

    use super::*;

    #[test]
    fn passwords_use_argon2id_with_owasp_parameters() {
        let hash = hash_password("test-only-password-material").unwrap();
        assert!(hash.starts_with("$argon2id$v=19$m=19456,t=2,p=1$"));
        assert!(verify_password("test-only-password-material", &hash));
        assert!(!verify_password("wrong password", &hash));
    }

    #[test]
    fn random_tokens_are_url_safe_and_hash_stably() {
        let token = random_token();
        assert_eq!(URL_SAFE_NO_PAD.decode(&token).unwrap().len(), 32);
        assert_eq!(token_hash(&token), token_hash(&token));
        assert_ne!(token_hash(&token), token_hash("different"));
    }

    #[test]
    fn password_validation_does_not_trim() {
        assert!(!valid_password("short"));
        assert!(valid_password("        "));
        assert!(!valid_password(&"x".repeat(MAX_PASSWORD_BYTES + 1)));
    }

    #[test]
    fn secure_cookie_is_explicit_and_has_no_domain() {
        let config = ServiceConfig::new(
            "127.0.0.1:8787".parse::<SocketAddr>().unwrap(),
            "sqlite://data/test.db".to_owned(),
            "https://example.test".to_owned(),
            None,
            60,
            true,
            1024,
        )
        .unwrap();
        let header = session_cookie("safe-token", &config);
        let cookie = header.to_str().unwrap();
        assert!(cookie.contains("; Secure"));
        assert!(cookie.contains("HttpOnly"));
        assert!(cookie.contains("SameSite=Strict"));
        assert!(cookie.contains("Path=/api"));
        assert!(!cookie.contains("Domain="));
    }

    #[tokio::test]
    async fn password_hash_slots_bound_concurrent_work() {
        let throttle = std::sync::Arc::new(LoginThrottle::default());
        let first = throttle.password_hash_slot().await;
        let second = throttle.password_hash_slot().await;
        assert_eq!(throttle.password_hash_slots.available_permits(), 0);

        let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();
        let waiting = {
            let throttle = throttle.clone();
            tokio::spawn(async move {
                let _permit = throttle.password_hash_slot().await;
                let _ = ready_tx.send(());
                tokio::time::sleep(Duration::from_millis(10)).await;
            })
        };
        let mut ready_rx = ready_rx;
        assert!(
            tokio::time::timeout(Duration::from_millis(25), &mut ready_rx)
                .await
                .is_err()
        );

        drop(first);
        assert!(tokio::time::timeout(Duration::from_millis(250), ready_rx)
            .await
            .is_ok());
        drop(second);
        waiting.await.unwrap();
    }
}
