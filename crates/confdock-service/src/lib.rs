pub mod auth;
pub mod config;
pub(crate) mod diff;
pub mod dto;
pub mod error;
pub mod routes;
pub mod state;
pub mod storage;
pub mod validation;

pub use routes::router;
pub use state::{AppState, StartError};
