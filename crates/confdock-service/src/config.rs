use std::{env, fs, net::SocketAddr, path::PathBuf};

#[cfg(unix)]
use std::{ffi::OsString, os::unix::fs::PermissionsExt, path::Path};

use thiserror::Error;
use url::Url;

pub const DEFAULT_LISTEN: &str = "127.0.0.1:8787";
pub const DEFAULT_DATA_DIR: &str = "/var/lib/confdock";
pub const DEFAULT_DATABASE_URL: &str = "sqlite:///var/lib/confdock/confdock.db";
pub const DEFAULT_PUBLIC_URL: &str = "http://127.0.0.1:8787";
pub const DEFAULT_SESSION_TTL_SECONDS: i64 = 604_800;
pub const DEFAULT_MAX_CONFIG_BYTES: usize = 8_388_608;
pub const MAX_SESSION_TTL_SECONDS: i64 = 31_536_000;
pub const MAX_CONFIG_BYTES: usize = 64 * 1024 * 1024;
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
    #[error("CONFDOCK_DATA_DIR must not be empty")]
    InvalidDataDirectory,
    #[error("set only one of CONFDOCK_DATA_DIR and CONFDOCK_DATABASE_URL")]
    ConflictingDatabaseLocation,
    #[error("CONFDOCK_PUBLIC_URL must be an http(s) URL without credentials, query, or fragment")]
    InvalidPublicUrl,
    #[error("CONFDOCK_SESSION_TTL_SECONDS must be between 1 and 31536000 seconds")]
    InvalidSessionTtl,
    #[error("CONFDOCK_COOKIE_SECURE must be true or false")]
    InvalidCookieSecure,
    #[error("CONFDOCK_MAX_CONFIG_BYTES must be between 1 and 67108864 bytes")]
    InvalidMaxConfigBytes,
    #[error("the SQLite database parent directory could not be created")]
    DatabaseDirectory,
    #[error(
        "the SQLite database files must be regular, non-symlink files with private permissions"
    )]
    DatabasePermissions,
}

impl ServiceConfig {
    pub fn from_env() -> Result<Self, ConfigError> {
        let listen = env::var("CONFDOCK_LISTEN")
            .unwrap_or_else(|_| DEFAULT_LISTEN.to_owned())
            .parse()
            .map_err(|_| ConfigError::InvalidListen)?;
        let database_url = match (
            env::var("CONFDOCK_DATABASE_URL").ok(),
            env::var("CONFDOCK_DATA_DIR").ok(),
        ) {
            (Some(_), Some(_)) => return Err(ConfigError::ConflictingDatabaseLocation),
            (Some(database_url), None) => database_url,
            (None, Some(data_dir)) => database_url_from_data_dir(&data_dir)?,
            (None, None) => DEFAULT_DATABASE_URL.to_owned(),
        };
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
        if !(1..=MAX_SESSION_TTL_SECONDS).contains(&session_ttl_seconds) {
            return Err(ConfigError::InvalidSessionTtl);
        }
        if !(1..=MAX_CONFIG_BYTES).contains(&max_config_bytes) {
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
            fs::create_dir_all(parent).map_err(|_| ConfigError::DatabaseDirectory)?;
        }
        self.secure_database_permissions()
    }

    /// Restrict SQLite's primary file and WAL sidecars on Unix. SQLite creates
    /// these files itself, so this is called both before opening an existing
    /// database and immediately after opening/migrating a new one.
    pub fn secure_database_permissions(&self) -> Result<(), ConfigError> {
        let Some(path) = self.database_path() else {
            return Ok(());
        };

        #[cfg(unix)]
        {
            secure_file_if_exists(&path)?;
            for suffix in ["-wal", "-shm"] {
                let mut sidecar = OsString::from(path.as_os_str());
                sidecar.push(suffix);
                secure_file_if_exists(Path::new(&sidecar))?;
            }
        }

        #[cfg(not(unix))]
        let _ = path;

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

#[cfg(unix)]
fn secure_file_if_exists(path: &Path) -> Result<(), ConfigError> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(_) => return Err(ConfigError::DatabasePermissions),
    };
    if metadata.file_type().is_symlink() || !metadata.file_type().is_file() {
        return Err(ConfigError::DatabasePermissions);
    }
    let mut permissions = metadata.permissions();
    permissions.set_mode(0o600);
    fs::set_permissions(path, permissions).map_err(|_| ConfigError::DatabasePermissions)
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

fn database_url_from_data_dir(value: &str) -> Result<String, ConfigError> {
    let value = value.trim();
    if value.is_empty() {
        return Err(ConfigError::InvalidDataDirectory);
    }
    Ok(format!(
        "sqlite://{}",
        PathBuf::from(value).join("confdock.db").display()
    ))
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

    #[test]
    fn resource_limits_have_explicit_upper_bounds() {
        let base = |ttl, max_bytes| {
            ServiceConfig::new(
                "127.0.0.1:8787".parse().unwrap(),
                "sqlite://data/test.db".to_owned(),
                "http://127.0.0.1:8787".to_owned(),
                None,
                ttl,
                false,
                max_bytes,
            )
        };
        assert!(base(MAX_SESSION_TTL_SECONDS, MAX_CONFIG_BYTES).is_ok());
        assert!(matches!(
            base(MAX_SESSION_TTL_SECONDS + 1, MAX_CONFIG_BYTES),
            Err(ConfigError::InvalidSessionTtl)
        ));
        assert!(matches!(
            base(1, MAX_CONFIG_BYTES + 1),
            Err(ConfigError::InvalidMaxConfigBytes)
        ));
    }

    #[test]
    fn data_directory_selects_a_predictable_sqlite_path() {
        assert_eq!(
            database_url_from_data_dir("/var/lib/confdock").unwrap(),
            "sqlite:///var/lib/confdock/confdock.db"
        );
        assert!(matches!(
            database_url_from_data_dir("   "),
            Err(ConfigError::InvalidDataDirectory)
        ));
    }

    #[cfg(unix)]
    #[test]
    fn existing_database_files_are_restricted_to_owner_only() {
        use std::{fs::OpenOptions, os::unix::fs::PermissionsExt};

        let directory = tempfile::tempdir().unwrap();
        let database = directory.path().join("confdock.db");
        for suffix in ["", "-wal", "-shm"] {
            let path = directory.path().join(format!("confdock.db{suffix}"));
            OpenOptions::new()
                .create(true)
                .truncate(true)
                .write(true)
                .open(&path)
                .unwrap();
            fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
        }
        let config = ServiceConfig::new(
            "127.0.0.1:8787".parse().unwrap(),
            format!("sqlite://{}", database.display()),
            "http://127.0.0.1:8787".to_owned(),
            None,
            60,
            false,
            1024,
        )
        .unwrap();
        config.secure_database_permissions().unwrap();
        for suffix in ["", "-wal", "-shm"] {
            let path = directory.path().join(format!("confdock.db{suffix}"));
            assert_eq!(
                fs::metadata(path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn database_symlinks_are_rejected() {
        use std::os::unix::fs::symlink;

        let directory = tempfile::tempdir().unwrap();
        let target = directory.path().join("target.db");
        fs::write(&target, b"not a database").unwrap();
        let database = directory.path().join("confdock.db");
        symlink(&target, &database).unwrap();
        let config = ServiceConfig::new(
            "127.0.0.1:8787".parse().unwrap(),
            format!("sqlite://{}", database.display()),
            "http://127.0.0.1:8787".to_owned(),
            None,
            60,
            false,
            1024,
        )
        .unwrap();
        assert!(matches!(
            config.secure_database_permissions(),
            Err(ConfigError::DatabasePermissions)
        ));
    }
}
