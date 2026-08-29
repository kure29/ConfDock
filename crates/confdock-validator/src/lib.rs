//! Optional native-validation process boundary.
//!
//! This crate defines the contract only. A future implementation may spawn a
//! pinned Mihomo binary in a sandbox; the WASM-compatible core never performs
//! process execution.

pub mod native;
pub mod traits;

pub use native::NativeProcessPolicy;
pub use traits::{NativeValidationContext, NativeValidationResult, NativeValidator};
