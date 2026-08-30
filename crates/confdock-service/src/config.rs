use std::{env, net::SocketAddr, path::PathBuf};

use thiserror::Error;
use url::Url;

pub const DEFAULT_LISTEN: &str = "127.0.0.1:8787";
pub const DEFAULT_DATABASE_URL: &str = "sqlite://data/confdock.db";
pub const DEFAULT_PUBLIC_URL: &str = "http://127.0.0.1:8787";
pub const DEFAULT_SESSION_TTL_SECONDS: i64 = 604_800;
pub const DEFAULT_MAX_CONFIG_BYTES: usize = 8_388_608;
pub const MAX_PASSWORD_BYTES: usize = 1_024;

#[derive(Clone, Debug)]
pub struct ServiceConfig {
    pub listen: SocketAddr,
    pub database_url: String,
    pub public_url: String,
    pub bootstrap_password: Option<String>,
    pub session_ttl_seconds: i64,
    pub cookie_secure: bool,
    pub max_config_bytes: usize,
}

#[derive(Debug, Error)]
pub enum ConfigError {
    #[error("CONFDOCK_LISTEN must be a valid socket address")]
    InvalidListen,
    #[error("CONFDOCK_DATABASE_URL must be a sqlite:// URL")]
    InvalidDatabaseUrl,
    #[error("CONFDOCK_PUBLIC_URL must be an http(s) URL without credentials, query, or fragment")]
    InvalidPublicUrl,
    #[error("CONFDOCK_SESSION_TTL_SECONDS must be a positive integer")]
    InvalidSessionTtl,
    #[error("CONFDOCK_COOKIE_SECURE must be true or false")]
    InvalidCookieSecure,
    #[error("CONFDOCK_MAX_CONFIG_BYTES must be a positive integer")]
    InvalidMaxConfigBytes,
    #[error("the SQLite database parent directory could not be created")]
    DatabaseDirectory,
}

impl ServiceConfig {
    pub fn from_env() -> Result<Self, ConfigError> {
        let listen = env::var("CONFDOCK_LISTEN")
            .unwrap_or_else(|_| DEFAULT_LISTEN.to_owned())
            .parse()
            .map_err(|_| ConfigError::InvalidListen)?;
        let database_url =
            env::var("CONFDOCK_DATABASE_URL").unwrap_or_else(|_| DEFAULT_DATABASE_URL.to_owned());
        let public_url =
            env::var("CONFDOCK_PUBLIC_URL").unwrap_or_else(|_| DEFAULT_PUBLIC_URL.to_owned());
        let session_ttl_seconds = parse_positive_i64(
            env::var("CONFDOCK_SESSION_TTL_SECONDS").ok().as_deref(),
            DEFAULT_SESSION_TTL_SECONDS,
        )?;
        let cookie_secure = parse_bool(env::var("CONFDOCK_COOKIE_SECURE").ok().as_deref(), false)?;
        let max_config_bytes = parse_positive_usize(
            env::var("CONFDOCK_MAX_CONFIG_BYTES").ok().as_deref(),
            DEFAULT_MAX_CONFIG_BYTES,
        )?;

        Self::new(
            listen,
            database_url,
            public_url,
            env::var("CONFDOCK_BOOTSTRAP_PASSWORD").ok(),
            session_ttl_seconds,
            cookie_secure,
            max_config_bytes,
        )
    }

    #[allow(clippy::too_many_arguments)]
    pub fn new(
        listen: SocketAddr,
        database_url: String,
        public_url: String,
        bootstrap_password: Option<String>,
        session_ttl_seconds: i64,
        cookie_secure: bool,
        max_config_bytes: usize,
    ) -> Result<Self, ConfigError> {
        if !database_url.starts_with("sqlite://") {
            return Err(ConfigError::InvalidDatabaseUrl);
        }
        let public_url = normalize_public_url(&public_url)?;
        if session_ttl_seconds <= 0 {
            return Err(ConfigError::InvalidSessionTtl);
        }
        if max_config_bytes == 0 {
            return Err(ConfigError::InvalidMaxConfigBytes);
        }
        Ok(Self {
            listen,
            database_url,
            public_url,
            bootstrap_password,
            session_ttl_seconds,
            cookie_secure,
            max_config_bytes,
        })
    }

    pub fn prepare_database_parent(&self) -> Result<(), ConfigError> {
        let Some(path) = self.database_path() else {
            return Ok(());
        };
        if let Some(parent) = path
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty())
        {
            std::fs::create_dir_all(parent).map_err(|_| ConfigError::DatabaseDirectory)?;
        }
        Ok(())
    }

    pub fn max_json_body_bytes(&self) -> usize {
        self.max_config_bytes
            .saturating_mul(2)
            .saturating_add(65_536)
    }

    fn database_path(&self) -> Option<PathBuf> {
        let raw = self.database_url.strip_prefix("sqlite://")?;
        let raw = raw.split('?').next().unwrap_or(raw);
        if raw.is_empty() || raw == ":memory:" {
            None
        } else {
            Some(PathBuf::from(raw))
        }
    }
}

fn normalize_public_url(value: &str) -> Result<String, ConfigError> {
    let parsed = Url::parse(value).map_err(|_| ConfigError::InvalidPublicUrl)?;
    if !matches!(parsed.scheme(), "http" | "https")
        || parsed.host_str().is_none()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.query().is_some()
        || parsed.fragment().is_some()
    {
        return Err(ConfigError::InvalidPublicUrl);
    }
    Ok(value.trim_end_matches('/').to_owned())
}

fn parse_bool(value: Option<&str>, default: bool) -> Result<bool, ConfigError> {
    match value {
        None => Ok(default),
        Some("true") => Ok(true),
        Some("false") => Ok(false),
        Some(_) => Err(ConfigError::InvalidCookieSecure),
    }
}

fn parse_positive_i64(value: Option<&str>, default: i64) -> Result<i64, ConfigError> {
    match value {
        None => Ok(default),
        Some(value) => value
            .parse::<i64>()
            .ok()
            .filter(|value| *value > 0)
            .ok_or(ConfigError::InvalidSessionTtl),
    }
}

fn parse_positive_usize(value: Option<&str>, default: usize) -> Result<usize, ConfigError> {
    match value {
        None => Ok(default),
        Some(value) => value
            .parse::<usize>()
            .ok()
            .filter(|value| *value > 0)
            .ok_or(ConfigError::InvalidMaxConfigBytes),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn public_url_is_validated_and_normalized() {
        assert_eq!(
            normalize_public_url("https://example.test/").unwrap(),
            "https://example.test"
        );
        assert!(normalize_public_url("file:///tmp/config").is_err());
        assert!(normalize_public_url("https://user@example.test").is_err());
        assert!(normalize_public_url("https://example.test/?token=secret").is_err());
    }
}
