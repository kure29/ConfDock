use std::{io::IsTerminal, net::SocketAddr, path::PathBuf, process};

use clap::{ArgAction, Parser, Subcommand};
use confdock_service::{
    auth::{admin_exists, bootstrap_admin, set_password_cli, AuthError},
    config::{ConfigError, ConfigOverrides, ServiceConfig},
    router,
    state::{AppState, StartError},
};
use thiserror::Error;
use tracing_subscriber::EnvFilter;

#[derive(Debug, Parser)]
#[command(
    name = "confdock",
    version,
    about = "ConfDock configuration service",
    after_help = "Run `confdock admin init` before starting in a non-interactive service environment."
)]
struct Cli {
    /// Path to a TOML configuration file.
    #[arg(short = 'c', long = "config", global = true, value_name = "PATH")]
    config: Option<PathBuf>,
    /// Override the listen socket address.
    #[arg(long, global = true, value_name = "ADDR")]
    listen: Option<SocketAddr>,
    /// Override the persistent data directory.
    #[arg(long, global = true, value_name = "PATH")]
    data_dir: Option<PathBuf>,
    /// Override the public URL.
    #[arg(long, global = true, value_name = "URL")]
    public_url: Option<String>,
    /// Override whether Secure cookies are enabled.
    #[arg(long, global = true, action = ArgAction::Set, value_name = "BOOL")]
    cookie_secure: Option<bool>,
    /// Override session lifetime in seconds.
    #[arg(long, global = true, value_name = "SECONDS")]
    session_ttl_seconds: Option<i64>,
    /// Override maximum imported configuration size.
    #[arg(long, global = true, value_name = "BYTES")]
    max_config_bytes: Option<usize>,
    #[command(subcommand)]
    command: Option<Command>,
}

#[derive(Debug, Subcommand)]
enum Command {
    /// Start the HTTP service (the default command).
    Serve,
    /// Parse and validate a TOML configuration without opening SQLite.
    Config {
        #[command(subcommand)]
        command: ConfigCommand,
    },
    /// Administrator lifecycle commands.
    Admin {
        #[command(subcommand)]
        command: AdminCommand,
    },
}

#[derive(Debug, Subcommand)]
enum ConfigCommand {
    /// Validate configuration and exit.
    Check,
    /// Print one safe, machine-readable configuration value.
    Get {
        /// Field to print. Only data_dir, listen, and public_url are allowed.
        field: String,
    },
}

#[derive(Debug, Subcommand)]
enum AdminCommand {
    /// Create the fixed `admin` administrator on an empty database.
    Init,
    /// Set a new administrator password and invalidate existing sessions.
    SetPassword,
}

#[derive(Debug, Error)]
enum CliError {
    #[error(transparent)]
    Config(#[from] ConfigError),
    #[error(transparent)]
    Start(#[from] StartError),
    #[error(transparent)]
    Auth(#[from] AuthError),
    #[error("{0}")]
    Message(String),
}

impl Cli {
    fn overrides(&self) -> ConfigOverrides {
        ConfigOverrides {
            listen: self.listen,
            data_dir: self.data_dir.clone(),
            public_url: self.public_url.clone(),
            cookie_secure: self.cookie_secure,
            session_ttl_seconds: self.session_ttl_seconds,
            max_config_bytes: self.max_config_bytes,
        }
    }
}

#[tokio::main]
async fn main() {
    if let Err(error) = run().await {
        eprintln!("Error: {error}");
        process::exit(1);
    }
}

async fn run() -> Result<(), CliError> {
    // Clap handles --help/--version before this function returns. No tracing,
    // filesystem, database, or network initialization happens on those paths.
    let cli = Cli::parse();
    let config = ServiceConfig::from_sources(cli.config.as_deref(), cli.overrides())?;
    let command = cli.command.unwrap_or(Command::Serve);
    let config_path = cli.config.clone();

    match &command {
        Command::Config {
            command: ConfigCommand::Check,
        } => {
            println!("Configuration is valid.");
            return Ok(());
        }
        Command::Config {
            command: ConfigCommand::Get { field },
        } => {
            let value = config.safe_value(field).map_err(CliError::Message)?;
            println!("{value}");
            return Ok(());
        }
        _ => {}
    }

    init_tracing()?;
    match command {
        Command::Serve => serve(config, config_path.as_ref()).await,
        Command::Admin {
            command: AdminCommand::Init,
        } => admin_init(config).await,
        Command::Admin {
            command: AdminCommand::SetPassword,
        } => admin_set_password(config).await,
        Command::Config { .. } => unreachable!("config subcommands are handled above"),
    }
}

fn init_tracing() -> Result<(), CliError> {
    let log_filter = if std::env::var_os("RUST_LOG").is_some() {
        EnvFilter::try_from_default_env().map_err(|error| CliError::Message(error.to_string()))?
    } else {
        EnvFilter::new("info")
    };
    tracing_subscriber::fmt().with_env_filter(log_filter).init();
    Ok(())
}

async fn serve(config: ServiceConfig, config_path: Option<&PathBuf>) -> Result<(), CliError> {
    let listen = config.listen;
    let state = if config.bootstrap_password.is_some() {
        AppState::initialize(config).await?
    } else {
        let state = AppState::initialize_unbootstrapped(config.clone()).await?;
        if !admin_exists(&state.pool).await? {
            if !interactive_terminal() {
                return Err(CliError::Message(non_interactive_message(config_path)));
            }
            println!("ConfDock is not initialized.\nAdministrator username: admin");
            let password = prompt_new_password()?;
            let created = bootstrap_admin(&state.pool, Some(password)).await?;
            if !created {
                return Err(CliError::Message(
                    "ConfDock is already initialized.".to_owned(),
                ));
            }
            println!("Administrator initialized successfully.");
        }
        state
    };
    let listener = tokio::net::TcpListener::bind(listen)
        .await
        .map_err(|error| CliError::Message(format!("could not bind {listen}: {error}")))?;
    tracing::info!(%listen, "ConfDock API listening");
    axum::serve(listener, router(state))
        .with_graceful_shutdown(shutdown_signal())
        .await
        .map_err(|error| CliError::Message(format!("server failed: {error}")))?;
    Ok(())
}

async fn admin_init(config: ServiceConfig) -> Result<(), CliError> {
    if !interactive_terminal() {
        return Err(CliError::Message(
            "administrator initialization requires an interactive terminal".to_owned(),
        ));
    }
    let mut config = config;
    config.bootstrap_password = None;
    let state = AppState::initialize_unbootstrapped(config).await?;
    if admin_exists(&state.pool).await? {
        return Err(CliError::Message(
            "ConfDock is already initialized.".to_owned(),
        ));
    }
    println!("ConfDock is not initialized.\nAdministrator username: admin");
    let password = prompt_new_password()?;
    if !bootstrap_admin(&state.pool, Some(password)).await? {
        return Err(CliError::Message(
            "ConfDock is already initialized.".to_owned(),
        ));
    }
    println!("Administrator initialized successfully.");
    Ok(())
}

async fn admin_set_password(config: ServiceConfig) -> Result<(), CliError> {
    if !interactive_terminal() {
        return Err(CliError::Message(
            "administrator password changes require an interactive terminal".to_owned(),
        ));
    }
    let mut config = config;
    config.bootstrap_password = None;
    let state = AppState::initialize_unbootstrapped(config).await?;
    if !admin_exists(&state.pool).await? {
        return Err(CliError::Message(
            "ConfDock is not initialized. Run `confdock admin init` first.".to_owned(),
        ));
    }
    let password = prompt_new_password()?;
    set_password_cli(&state.pool, password).await?;
    println!("Administrator password updated successfully.");
    Ok(())
}

fn interactive_terminal() -> bool {
    std::io::stdin().is_terminal() && std::io::stderr().is_terminal()
}

fn prompt_new_password() -> Result<String, CliError> {
    let password = rpassword::prompt_password("Enter administrator password: ")
        .map_err(|_| CliError::Message("could not read administrator password".to_owned()))?;
    let confirmation =
        rpassword::prompt_password("Confirm administrator password: ").map_err(|_| {
            CliError::Message("could not read administrator password confirmation".to_owned())
        })?;
    if password != confirmation {
        return Err(CliError::Message(
            "administrator passwords do not match".to_owned(),
        ));
    }
    Ok(password)
}

fn non_interactive_message(config: Option<&PathBuf>) -> String {
    let command = config
        .map(|path| format!("confdock admin init --config {}", path.display()))
        .unwrap_or_else(|| "confdock admin init".to_owned());
    format!("ConfDock is not initialized. Run `{command}` in an interactive terminal.")
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
    tokio::select! { _ = ctrl_c => {}, _ = terminate => {} }
    tracing::info!("ConfDock is shutting down");
}
