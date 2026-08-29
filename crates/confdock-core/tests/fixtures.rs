use confdock_core::{
    ConfigAdapter, DetectionConfidence, DiagnosticSeverity, EditError, LineEnding, NativeDocument,
    SourceEncoding, StructuredEdit, TargetRegistry, ValidationLevel,
};

const MIHOMO: &[u8] = include_bytes!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../fixtures/mihomo/config.yaml"));
const SINGBOX: &[u8] = include_bytes!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../fixtures/singbox/config.json"));
const SURGE: &[u8] = include_bytes!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../fixtures/surge/config.conf"));
const LOON: &[u8] = include_bytes!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../fixtures/loon/config.conf"));
const QX: &[u8] = include_bytes!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../fixtures/quantumult_x/config.conf"));
const SHADOWROCKET: &[u8] = include_bytes!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../fixtures/shadowrocket/config.conf"));

#[test]
fn all_fixtures_round_trip_byte_for_byte() {
    let registry = TargetRegistry::builtin();
    for (id, source) in [("mihomo", MIHOMO), ("sing-box", SINGBOX), ("surge", SURGE), ("loon", LOON), ("quantumult-x", QX), ("shadowrocket", SHADOWROCKET)] {
        let adapter = registry.get_str(id).expect("registered adapter");
        let parsed = adapter.parse(source).expect("fixture parses");
        assert_eq!(parsed.document.bytes(), source, "{id} must preserve bytes");
        assert_eq!(adapter.validate(source).level, adapter.descriptor().capabilities.validation_level);
    }
}

#[test]
fn line_endings_unicode_and_unknown_content_survive() {
    let registry = TargetRegistry::builtin();
    for (id, source, path, replacement) in [
        ("mihomo", MIHOMO, "mixed-port", "7893"),
        ("surge", SURGE, "General.loglevel", "info"),
        ("loon", LOON, "General.dns-server", "1.1.1.1"),
        ("quantumult-x", QX, "general.server_check_url", "https://example.test/new"),
        ("shadowrocket", SHADOWROCKET, "General.bypass-system", "false"),
    ] {
        let adapter = registry.get_str(id).unwrap();
        let crlf = String::from_utf8(source.to_vec()).unwrap().replace('\n', "\r\n").into_bytes();
        let edited = adapter.apply_edit(&crlf, StructuredEdit::new(path, replacement)).unwrap();
        assert_eq!(NativeDocument::from_bytes(&edited).line_ending(), LineEnding::CrLf, "{id} CRLF");
        assert!(String::from_utf8_lossy(&edited).contains("中文") || id == "mihomo" || id == "shadowrocket");
        assert!(String::from_utf8_lossy(&edited).contains("example.test") || id == "mihomo");
    }
}

#[test]
fn yaml_patch_changes_only_target_span() {
    let adapter = TargetRegistry::builtin().get_str("mihomo").unwrap();
    let edited = adapter.apply_edit(MIHOMO, StructuredEdit::new("mixed-port", "7893")).unwrap();
    assert_eq!(edited.len(), MIHOMO.len());
    let start = MIHOMO.iter().position(|byte| *byte == b'7').unwrap();
    for (index, (before, after)) in MIHOMO.iter().zip(edited.iter()).enumerate() {
        if (start..start + 4).contains(&index) {
            continue;
        }
        assert_eq!(before, after, "unrelated YAML byte changed at {index}");
    }
    assert!(String::from_utf8(edited).unwrap().contains("mixed-port: 7893"));
}

#[test]
fn json_patch_preserves_layout_order_and_unknown_fields() {
    let adapter = TargetRegistry::builtin().get_str("sing-box").unwrap();
    let edited = adapter.apply_edit(SINGBOX, StructuredEdit::new("log.level", "\"warn\"")).unwrap();
    let text = String::from_utf8(edited).unwrap();
    assert!(text.contains("\"level\": \"warn\""));
    assert!(text.contains("\"unknown-field\": { \"keep\": \"中文\" }"));
    assert!(text.contains("  \"log\": {") && text.contains("  \"outbounds\": ["));
}

#[test]
fn duplicate_key_and_unsafe_edit_are_explicit_errors() {
    let adapter = TargetRegistry::builtin().get_str("surge").unwrap();
    let duplicate = b"[General]\nloglevel = notify\nloglevel = warn\n";
    assert!(matches!(adapter.apply_edit(duplicate, StructuredEdit::new("General.loglevel", "info")), Err(EditError::AmbiguousField(_))));
    assert!(matches!(adapter.apply_edit(SURGE, StructuredEdit::new("General.loglevel", "bad\nline")), Err(EditError::UnsafeValue(_))));
}

#[test]
fn parse_diagnostics_have_stable_shape_and_spans() {
    let adapter = TargetRegistry::builtin().get_str("sing-box").unwrap();
    let result = adapter.validate(b"{\n  \"log\": }\n");
    assert_eq!(result.level, ValidationLevel::ParseOnly);
    let diagnostic = result.diagnostics.first().expect("diagnostic");
    assert_eq!(diagnostic.severity, DiagnosticSeverity::Error);
    assert!(!diagnostic.code.is_empty());
    assert!(!diagnostic.message.is_empty());
    assert!(diagnostic.span.is_some());
}

#[test]
fn detection_is_a_hint_and_capabilities_do_not_claim_native_validation() {
    let registry = TargetRegistry::builtin();
    assert_eq!(registry.get_str("mihomo").unwrap().detect(MIHOMO).confidence, DetectionConfidence::Likely);
    for adapter in registry.adapters() {
        assert!(adapter.descriptor().capabilities.raw_edit);
        assert!(!adapter.descriptor().capabilities.native_validation);
        assert_ne!(adapter.descriptor().capabilities.validation_level, ValidationLevel::Native);
    }
    assert_eq!(NativeDocument::from_bytes(&[0xff]).encoding(), SourceEncoding::Unsupported);
}

#[test]
fn utf8_bom_is_preserved_and_spans_are_offset_after_it() {
    let registry = TargetRegistry::builtin();
    let mihomo = registry.get_str("mihomo").unwrap();
    let mut yaml = vec![0xef, 0xbb, 0xbf];
    yaml.extend_from_slice(MIHOMO);
    let edited = mihomo.apply_edit(&yaml, StructuredEdit::new("mixed-port", "7893")).unwrap();
    assert!(edited.starts_with(&[0xef, 0xbb, 0xbf]));
    assert!(String::from_utf8(edited).unwrap().contains("mixed-port: 7893"));

    let singbox = registry.get_str("sing-box").unwrap();
    let mut json = vec![0xef, 0xbb, 0xbf];
    json.extend_from_slice(SINGBOX);
    let edited = singbox.apply_edit(&json, StructuredEdit::new("log.level", "\"warn\"")).unwrap();
    assert!(edited.starts_with(&[0xef, 0xbb, 0xbf]));
    assert!(String::from_utf8(edited).unwrap().contains("\"level\": \"warn\""));
}

#[test]
fn adapters_reject_non_utf8_without_silent_conversion() {
    let registry = TargetRegistry::builtin();
    for adapter in registry.adapters() {
        let error = adapter.parse(&[0xff]).expect_err("invalid encoding must be rejected");
        let diagnostic = error.diagnostics.first().expect("encoding diagnostic");
        assert_eq!(diagnostic.code, "encoding.unsupported");
        assert_eq!(diagnostic.severity, DiagnosticSeverity::Error);
    }
}
