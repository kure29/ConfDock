//! ConfDock's source-preserving configuration core.
//!
//! The core intentionally owns no persistence or HTTP concerns. It operates on
//! native bytes and returns spans/diagnostics that can be consumed by a WASM
//! editor or a server process.

pub mod diagnostics;
pub mod document;
pub mod patch;
pub mod path;
pub mod schema;
pub mod targets;

pub use diagnostics::{Diagnostic, DiagnosticSeverity, ValidationLevel, ValidationResult};
pub use document::{
    LineEnding, NativeDocument, ParsedDocument, SourceEncoding, SourceField, SourceSpan,
};
pub use patch::{apply_span_patch, EditError, StructuredEdit};
pub use path::{ConfigPath, ConfigPathError};
pub use schema::{SchemaField, SchemaValueType, TargetSchema};
pub use targets::{
    AdapterCapabilities, ConfigAdapter, DetectionConfidence, DetectionResult, ParseError,
    RegistryError, StructuredEditCapability, StructuredEditOperation, StructuredEditScope,
    TargetDescriptor, TargetId, TargetRegistry,
};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_document_round_trips_bytes_and_metadata() {
        let source = b"# \xe4\xb8\xad\xe6\x96\x87\r\nkey = value\r\n";
        let document = NativeDocument::from_bytes(source);
        assert_eq!(document.bytes(), source);
        assert_eq!(document.encoding(), SourceEncoding::Utf8);
        assert_eq!(document.line_ending(), LineEnding::CrLf);
        assert!(document.has_trailing_newline());
    }

    #[test]
    fn unsupported_encoding_is_reported_without_conversion() {
        let document = NativeDocument::from_bytes(&[0xff, 0xfe, 0xfd]);
        assert_eq!(document.encoding(), SourceEncoding::Unsupported);
        assert!(document.encoding_diagnostic().is_some());
        assert_eq!(document.bytes(), &[0xff, 0xfe, 0xfd]);
    }

    #[test]
    fn registry_contains_all_builtin_targets() {
        let registry = TargetRegistry::builtin();
        let ids: Vec<_> = registry
            .adapters()
            .iter()
            .map(|adapter| adapter.descriptor().id.as_str())
            .collect();
        assert_eq!(
            ids,
            vec![
                "mihomo",
                "sing-box",
                "surge",
                "loon",
                "quantumult-x",
                "shadowrocket"
            ]
        );
    }
}
