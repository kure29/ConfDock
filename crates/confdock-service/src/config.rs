use std::{
    env, fs,
    net::SocketAddr,
    path::{Path, PathBuf},
};

#[cfg(unix)]
use std::{ffi::OsString, os::unix::fs::PermissionsExt};

use serde::Deserialize;
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
pub const MAX_CONFIG_FILE_BYTES: u64 = 1024 * 1024;

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
    #[error("CONFDOCK_DATA_DIR must be a non-empty absolute path")]
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
    #[error("configuration file `{path}` could not be read: {reason}")]
    ConfigFileRead { path: PathBuf, reason: String },
    #[error("configuration file `{path}` is too large (maximum {MAX_CONFIG_FILE_BYTES} bytes)")]
    ConfigFileTooLarge { path: PathBuf },
    #[error("configuration file `{path}` is invalid: {reason}")]
    ConfigFileInvalid { path: PathBuf, reason: String },
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct FileConfig {
    listen: Option<String>,
    data_dir: Option<String>,
    public_url: Option<String>,
    cookie_secure: Option<bool>,
    session_ttl_seconds: Option<i64>,
    max_config_bytes: Option<usize>,
}

#[derive(Clone, Debug, Default)]
pub struct ConfigOverrides {
    pub listen: Option<SocketAddr>,
    pub data_dir: Option<PathBuf>,
    pub public_url: Option<String>,
    pub cookie_secure: Option<bool>,
    pub session_ttl_seconds: Option<i64>,
    pub max_config_bytes: Option<usize>,
}

impl ServiceConfig {
    pub fn from_env() -> Result<Self, ConfigError> {
        Self::from_sources(None, ConfigOverrides::default())
    }

    pub fn from_sources(
        config_path: Option<&Path>,
        overrides: ConfigOverrides,
    ) -> Result<Self, ConfigError> {
        let file = config_path.map(load_file).transpose()?.unwrap_or_default();
        let config_base = config_path
            .map(canonical_config_path)
            .transpose()?
            .and_then(|path| path.parent().map(Path::to_path_buf));

        let listen = if let Some(value) = overrides.listen {
            value
        } else {
            let base = if let Some(value) = file.listen.as_deref() {
                value
                    .parse()
                    .map_err(|_| config_file_error(config_path, ConfigError::InvalidListen))?
            } else {
                DEFAULT_LISTEN.parse().expect("default listen is valid")
            };
            match env::var_os("CONFDOCK_LISTEN") {
                Some(value) => value
                    .to_str()
                    .ok_or(ConfigError::InvalidListen)?
                    .parse()
                    .map_err(|_| ConfigError::InvalidListen)?,
                None => base,
            }
        };

        let env_data_dir = env::var("CONFDOCK_DATA_DIR").ok();
        let env_database_url = env::var("CONFDOCK_DATABASE_URL").ok();
        if env_data_dir.is_some() && env_database_url.is_some() {
            return Err(ConfigError::ConflictingDatabaseLocation);
        }
        let file_data_dir = file
            .data_dir
            .as_deref()
            .map(|raw| {
                let path = PathBuf::from(raw.trim());
                if path.as_os_str().is_empty() {
                    return Err(config_file_error(
                        config_path,
                        ConfigError::InvalidDataDirectory,
                    ));
                }
                if path.is_absolute() {
                    Ok(path)
                } else {
                    config_base
                        .as_ref()
                        .map(|base| base.join(path))
                        .ok_or_else(|| {
                            config_file_error(config_path, ConfigError::InvalidDataDirectory)
                        })
                }
            })
            .transpose()?;
        let data_dir_override = overrides.data_dir.is_some();
        let selected_data_dir = if let Some(path) = overrides.data_dir {
            Some(path)
        } else if let Some(path) = env_data_dir {
            // Preserve the existing environment-variable contract: DATA_DIR
            // must be an absolute path.
            Some(PathBuf::from(path.trim()))
        } else {
            file_data_dir
        };
        let database_url = if let Some(database_url) = env_database_url {
            database_url
        } else if let Some(data_dir) = selected_data_dir {
            if config_path.is_none()
                || env::var_os("CONFDOCK_DATA_DIR").is_some()
                || data_dir_override
            {
                database_url_from_data_dir(&data_dir.to_string_lossy())?
            } else {
                database_url_from_path(&data_dir)?
            }
        } else {
            DEFAULT_DATABASE_URL.to_owned()
        };

        let public_url = overrides
            .public_url
            .or_else(|| env::var("CONFDOCK_PUBLIC_URL").ok())
            .or(file.public_url)
            .unwrap_or_else(|| DEFAULT_PUBLIC_URL.to_owned());
        let session_ttl_seconds = if let Some(value) = overrides.session_ttl_seconds {
            value
        } else if let Some(value) = env::var_os("CONFDOCK_SESSION_TTL_SECONDS") {
            value
                .to_str()
                .ok_or(ConfigError::InvalidSessionTtl)?
                .parse()
                .map_err(|_| ConfigError::InvalidSessionTtl)?
        } else {
            file.session_ttl_seconds
                .unwrap_or(DEFAULT_SESSION_TTL_SECONDS)
        };
        let cookie_secure = if let Some(value) = overrides.cookie_secure {
            value
        } else if env::var_os("CONFDOCK_COOKIE_SECURE").is_some() {
            parse_env_bool("CONFDOCK_COOKIE_SECURE", false)?
        } else {
            file.cookie_secure.unwrap_or(false)
        };
        let max_config_bytes = if let Some(value) = overrides.max_config_bytes {
            value
        } else if let Some(value) = env::var_os("CONFDOCK_MAX_CONFIG_BYTES") {
            value
                .to_str()
                .ok_or(ConfigError::InvalidMaxConfigBytes)?
                .parse()
                .map_err(|_| ConfigError::InvalidMaxConfigBytes)?
        } else {
            file.max_config_bytes.unwrap_or(DEFAULT_MAX_CONFIG_BYTES)
        };

        let result = Self::new(
            listen,
            database_url,
            public_url,
            env::var("CONFDOCK_BOOTSTRAP_PASSWORD").ok(),
            session_ttl_seconds,
            cookie_secure,
            max_config_bytes,
        );
        match result {
            Ok(config) => Ok(config),
            Err(error) => match config_path {
                Some(path) => Err(ConfigError::ConfigFileInvalid {
                    path: path.to_path_buf(),
                    reason: error.to_string(),
                }),
                None => Err(error),
            },
        }
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
            let metadata =
                fs::symlink_metadata(parent).map_err(|_| ConfigError::DatabaseDirectory)?;
            if metadata.file_type().is_symlink() || !metadata.file_type().is_dir() {
                return Err(ConfigError::DatabaseDirectory);
            }
        }
        self.secure_database_permissions()
    }

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

    /// Return a deliberately small, non-sensitive set of values for scripts.
    /// This method never opens SQLite or creates a directory.
    pub fn safe_value(&self, field: &str) -> Result<String, String> {
        let value = match field {
            "listen" => self.listen.to_string(),
            "public_url" => self.public_url.clone(),
            "data_dir" => self
                .database_path()
                .and_then(|path| path.parent().map(Path::to_path_buf))
                .ok_or_else(|| "data_dir is not a filesystem path".to_owned())?
                .to_string_lossy()
                .into_owned(),
            _ => {
                return Err(format!(
                    "unsupported config field `{field}` (allowed: data_dir, listen, public_url)"
                ))
            }
        };
        if value.chars().any(char::is_control) {
            return Err(format!(
                "config field `{field}` contains control characters"
            ));
        }
        Ok(value)
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

fn database_url_from_data_dir(value: &str) -> Result<String, ConfigError> {
    let value = value.trim();
    if value.is_empty() || !PathBuf::from(value).is_absolute() {
        return Err(ConfigError::InvalidDataDirectory);
    }
    database_url_from_path(&PathBuf::from(value))
}

fn database_url_from_path(path: &Path) -> Result<String, ConfigError> {
    if path.as_os_str().is_empty() {
        return Err(ConfigError::InvalidDataDirectory);
    }
    Ok(format!("sqlite://{}", path.join("confdock.db").display()))
}

fn canonical_config_path(path: &Path) -> Result<PathBuf, ConfigError> {
    fs::canonicalize(path).map_err(|error| ConfigError::ConfigFileRead {
        path: path.to_path_buf(),
        reason: error.to_string(),
    })
}

fn config_file_error(path: Option<&Path>, error: ConfigError) -> ConfigError {
    match path {
        Some(path) => ConfigError::ConfigFileInvalid {
            path: path.to_path_buf(),
            reason: error.to_string(),
        },
        None => error,
    }
}

fn load_file(path: &Path) -> Result<FileConfig, ConfigError> {
    let canonical = canonical_config_path(path)?;
    let metadata = fs::metadata(&canonical).map_err(|error| ConfigError::ConfigFileRead {
        path: path.to_path_buf(),
        reason: error.to_string(),
    })?;
    if !metadata.is_file() {
        return Err(ConfigError::ConfigFileRead {
            path: path.to_path_buf(),
            reason: "not a regular file".to_owned(),
        });
    }
    if metadata.len() > MAX_CONFIG_FILE_BYTES {
        return Err(ConfigError::ConfigFileTooLarge {
            path: path.to_path_buf(),
        });
    }
    let bytes = fs::read(&canonical).map_err(|error| ConfigError::ConfigFileRead {
        path: path.to_path_buf(),
        reason: error.to_string(),
    })?;
    let text = std::str::from_utf8(&bytes).map_err(|error| ConfigError::ConfigFileInvalid {
        path: path.to_path_buf(),
        reason: error.to_string(),
    })?;
    toml::from_str(text).map_err(|error| ConfigError::ConfigFileInvalid {
        path: path.to_path_buf(),
        reason: error.to_string(),
    })
}

fn parse_env_bool(name: &str, default: bool) -> Result<bool, ConfigError> {
    match env::var(name) {
        Ok(value) if value == "true" => Ok(true),
        Ok(value) if value == "false" => Ok(false),
        Ok(_) => Err(ConfigError::InvalidCookieSecure),
        Err(_) => Ok(default),
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
        assert!(matches!(
            database_url_from_data_dir("relative-data"),
            Err(ConfigError::InvalidDataDirectory)
        ));
    }

    #[test]
    fn safe_config_values_reject_unknown_fields_and_control_characters() {
        let config = ServiceConfig::new(
            "127.0.0.1:8787".parse().unwrap(),
            "sqlite:///tmp/data\n/confdock.db".to_owned(),
            "http://127.0.0.1:8787".to_owned(),
            None,
            60,
            false,
            1024,
        )
        .unwrap();
        assert_eq!(config.safe_value("listen").unwrap(), "127.0.0.1:8787");
        assert!(config.safe_value("database_url").is_err());
        assert!(config.safe_value("data_dir").is_err());
    }

    #[test]
    fn toml_configuration_is_strict_and_resolves_relative_data_dir() {
        let directory = tempfile::tempdir().unwrap();
        let config_path = directory.path().join("config.toml");
        fs::write(
            &config_path,
            "listen = \"127.0.0.1:9000\"\ndata_dir = \"data\"\npublic_url = \"https://example.test/\"\n",
        )
        .unwrap();
        let config =
            ServiceConfig::from_sources(Some(&config_path), ConfigOverrides::default()).unwrap();
        assert_eq!(
            config.listen,
            "127.0.0.1:9000".parse::<SocketAddr>().unwrap()
        );
        assert_eq!(
            config.database_url,
            format!(
                "sqlite://{}/data/confdock.db",
                fs::canonicalize(directory.path()).unwrap().display()
            )
        );
        assert_eq!(config.public_url, "https://example.test");

        fs::write(&config_path, "unknown = true\n").unwrap();
        let error = ServiceConfig::from_sources(Some(&config_path), ConfigOverrides::default())
            .unwrap_err();
        let message = error.to_string();
        assert!(message.contains("config.toml"));
        assert!(message.contains("unknown"));
    }

    #[test]
    fn missing_and_oversized_config_files_are_rejected() {
        let directory = tempfile::tempdir().unwrap();
        let missing = directory.path().join("missing.toml");
        assert!(matches!(
            ServiceConfig::from_sources(Some(&missing), ConfigOverrides::default()),
            Err(ConfigError::ConfigFileRead { .. })
        ));
        let oversized = directory.path().join("large.toml");
        fs::write(&oversized, vec![b'#'; (MAX_CONFIG_FILE_BYTES + 1) as usize]).unwrap();
        assert!(matches!(
            ServiceConfig::from_sources(Some(&oversized), ConfigOverrides::default()),
            Err(ConfigError::ConfigFileTooLarge { .. })
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
    #[cfg(unix)]
    #[test]
    fn configured_data_directory_symlinks_are_rejected() {
        use std::os::unix::fs::symlink;
        let directory = tempfile::tempdir().unwrap();
        let target = directory.path().join("real-data");
        fs::create_dir(&target).unwrap();
        let link = directory.path().join("data");
        symlink(&target, &link).unwrap();
        let database = link.join("confdock.db");
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
            config.prepare_database_parent(),
            Err(ConfigError::DatabaseDirectory)
        ));
    }
}
