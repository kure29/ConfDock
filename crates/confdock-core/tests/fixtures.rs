use confdock_core::targets::mihomo::MihomoAdapter;
use confdock_core::{
    ConfigPath, DetectionConfidence, DiagnosticSeverity, EditError, LineEnding, NativeDocument,
    RegistryError, SchemaValueType, SourceEncoding, StructuredEdit, StructuredEditOperation,
    StructuredEditScope, TargetRegistry, ValidationLevel,
};

const MIHOMO: &[u8] = include_bytes!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../fixtures/mihomo/config.yaml"
));
const SINGBOX: &[u8] = include_bytes!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../fixtures/singbox/config.json"
));
const SURGE: &[u8] = include_bytes!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../fixtures/surge/config.conf"
));
const LOON: &[u8] = include_bytes!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../fixtures/loon/config.conf"
));
const QX: &[u8] = include_bytes!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../fixtures/quantumult_x/config.conf"
));
const SHADOWROCKET: &[u8] = include_bytes!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../fixtures/shadowrocket/config.conf"
));

fn edit(path: &str, replacement: &str) -> StructuredEdit {
    StructuredEdit::new(ConfigPath::new(path).expect("test path"), replacement)
}

#[test]
fn all_fixtures_round_trip_byte_for_byte() {
    let registry = TargetRegistry::builtin();
    for (id, source) in [
        ("mihomo", MIHOMO),
        ("sing-box", SINGBOX),
        ("surge", SURGE),
        ("loon", LOON),
        ("quantumult-x", QX),
        ("shadowrocket", SHADOWROCKET),
    ] {
        let adapter = registry.get_str(id).expect("registered adapter");
        let parsed = adapter.parse(source).expect("fixture parses");
        assert_eq!(parsed.document.bytes(), source, "{id} must preserve bytes");
        assert_eq!(
            adapter.validate(source).level,
            adapter.descriptor().capabilities.validation_level
        );
    }
}

#[test]
fn capability_contracts_match_real_schema_and_validation() {
    let registry = TargetRegistry::builtin();
    let expected = [
        ("mihomo", ValidationLevel::Static, true),
        ("sing-box", ValidationLevel::Syntax, true),
        ("surge", ValidationLevel::Basic, false),
        ("loon", ValidationLevel::Basic, false),
        ("quantumult-x", ValidationLevel::Basic, false),
        ("shadowrocket", ValidationLevel::Basic, false),
    ];
    for (id, level, has_schema) in expected {
        let adapter = registry.get_str(id).unwrap();
        assert_eq!(adapter.descriptor().capabilities.validation_level, level);
        assert_eq!(adapter.schema().is_some(), has_schema);
        assert_eq!(
            adapter
                .schema()
                .is_some_and(|schema| !schema.fields.is_empty()),
            has_schema
        );
        let [capability] = adapter.structured_edit_capabilities() else {
            panic!("{id} must expose exactly one precise structured-edit capability");
        };
        assert_eq!(
            capability.operations,
            [StructuredEditOperation::ReplaceExistingValue]
        );
        match (id, &capability.scope) {
            ("mihomo", StructuredEditScope::ExactPaths(paths)) => {
                assert_eq!(
                    paths.iter().map(ConfigPath::as_str).collect::<Vec<_>>(),
                    ["/mixed-port"]
                );
                assert_eq!(capability.value_types, [SchemaValueType::Integer]);
            }
            ("sing-box", StructuredEditScope::ExistingJsonPointerValues) => {
                assert_eq!(
                    capability.value_types,
                    [
                        SchemaValueType::String,
                        SchemaValueType::Integer,
                        SchemaValueType::Boolean,
                        SchemaValueType::Number,
                        SchemaValueType::Object,
                        SchemaValueType::Array,
                        SchemaValueType::Null,
                    ]
                );
            }
            (
                "surge" | "loon" | "quantumult-x" | "shadowrocket",
                StructuredEditScope::ExistingSectionKeys {
                    sections,
                    case_sensitive,
                },
            ) => {
                let expected_section = if id == "quantumult-x" {
                    "general"
                } else {
                    "General"
                };
                assert_eq!(sections, &[expected_section]);
                assert!(*case_sensitive);
                assert_eq!(capability.value_types, [SchemaValueType::String]);
            }
            _ => panic!("{id} structured-edit scope drifted"),
        }
        assert!(!adapter.descriptor().capabilities.native_validation);
    }
}

#[test]
fn registry_rejects_duplicate_target_ids() {
    let mut registry = TargetRegistry::builtin();
    let error = registry.register(MihomoAdapter::new()).unwrap_err();
    assert!(matches!(error, RegistryError::DuplicateTarget(id) if id.as_str() == "mihomo"));

    let mut ids: Vec<_> = registry
        .adapters()
        .iter()
        .map(|adapter| adapter.descriptor().id.as_str())
        .collect();
    ids.sort_unstable();
    ids.dedup();
    assert_eq!(ids.len(), registry.adapters().len());
}

#[test]
fn mihomo_uses_real_yaml_syntax_validation() {
    let registry = TargetRegistry::builtin();
    let adapter = registry.get_str("mihomo").unwrap();
    let invalid = adapter.validate(b"mixed-port: [7890\n");
    assert_eq!(invalid.level, ValidationLevel::Syntax);
    assert!(!invalid.is_valid());
    assert_eq!(invalid.diagnostics[0].code, "mihomo.yaml_syntax");

    assert!(adapter.validate(MIHOMO).is_valid(), "anchor/alias fixture");

    let wrong_root = adapter.validate(b"- one\n- two\n");
    assert_eq!(wrong_root.level, ValidationLevel::Syntax);
    assert_eq!(wrong_root.diagnostics[0].code, "mihomo.root_mapping");
}

#[test]
fn mihomo_static_mixed_port_diagnostics_are_precise() {
    let registry = TargetRegistry::builtin();
    let adapter = registry.get_str("mihomo").unwrap();
    let wrong_type = b"mixed-port: \"7890\"\n";
    let result = adapter.validate(wrong_type);
    assert_eq!(result.level, ValidationLevel::Static);
    assert_eq!(result.diagnostics[0].code, "mihomo.mixed_port_type");
    let span = result.diagnostics[0].span.unwrap();
    assert_eq!(span.get(wrong_type), Some(&b"\"7890\""[..]));

    let out_of_range = b"mixed-port: 70000\n";
    let result = adapter.validate(out_of_range);
    assert_eq!(result.diagnostics[0].code, "mihomo.mixed_port_range");
    let span = result.diagnostics[0].span.unwrap();
    assert_eq!(span.get(out_of_range), Some(&b"70000"[..]));
}

#[test]
fn mihomo_patch_preserves_comments_block_scalars_and_all_other_bytes() {
    let registry = TargetRegistry::builtin();
    let adapter = registry.get_str("mihomo").unwrap();
    let source = b"mixed-port: 7890 # keep this comment\nscript: |-\n  line one\n  line two\n";
    let edited = adapter
        .apply_edit(source, edit("/mixed-port", "7893"))
        .unwrap();
    assert_eq!(
        edited,
        b"mixed-port: 7893 # keep this comment\nscript: |-\n  line one\n  line two\n"
    );
}

#[test]
fn mihomo_rejects_duplicate_or_unsafe_mixed_port_spans() {
    let registry = TargetRegistry::builtin();
    let adapter = registry.get_str("mihomo").unwrap();
    let duplicate = b"mixed-port: 7890\n\"mixed-port\": 7891\n";
    assert!(matches!(
        adapter.apply_edit(duplicate, edit("/mixed-port", "7893")),
        Err(EditError::AmbiguousField(_))
    ));
    let validation = adapter.validate(duplicate);
    assert_eq!(validation.level, ValidationLevel::Static);
    assert_eq!(
        validation.diagnostics[0].code,
        "mihomo.mixed_port_duplicate"
    );

    let tagged = b"mixed-port: !!int 7890\n";
    assert!(matches!(
        adapter.apply_edit(tagged, edit("/mixed-port", "7893")),
        Err(EditError::UnsupportedEdit(_))
    ));
}

#[test]
fn singbox_rejects_invalid_escape_trailing_content_and_non_object_root() {
    let registry = TargetRegistry::builtin();
    let adapter = registry.get_str("sing-box").unwrap();
    for source in [
        &b"{\"value\": \"bad\\q\"}"[..],
        &b"{} false"[..],
        &b"[]"[..],
    ] {
        let result = adapter.validate(source);
        assert_eq!(result.level, ValidationLevel::Syntax);
        assert!(!result.is_valid());
    }
}

#[test]
fn singbox_uses_unambiguous_json_pointers() {
    let registry = TargetRegistry::builtin();
    let adapter = registry.get_str("sing-box").unwrap();
    let source = br#"{
  "a/b": 1,
  "a~b": 2,
  "a.b": 3,
  "escaped\u002fkey": 4,
  "outbounds": [{"type": "direct"}]
}"#;
    let cases = [
        ("/a~1b", "10", "\"a/b\": 10"),
        ("/a~0b", "20", "\"a~b\": 20"),
        ("/a.b", "30", "\"a.b\": 30"),
        ("/escaped~1key", "40", "\"escaped\\u002fkey\": 40"),
        ("/outbounds/0/type", "\"block\"", "\"type\": \"block\""),
    ];
    for (path, replacement, expected) in cases {
        let edited = adapter.apply_edit(source, edit(path, replacement)).unwrap();
        assert!(String::from_utf8(edited).unwrap().contains(expected));
    }
}

#[test]
fn singbox_duplicate_pointer_is_ambiguous() {
    let registry = TargetRegistry::builtin();
    let adapter = registry.get_str("sing-box").unwrap();
    let source = b"{\"log\": {\"level\": \"info\", \"level\": \"warn\"}}";
    assert!(matches!(
        adapter.apply_edit(source, edit("/log/level", "\"error\"")),
        Err(EditError::AmbiguousField(_))
    ));
}

fn assert_conf_adapter_boundaries(
    id: &str,
    source: &[u8],
    editable_path: &str,
    replacement: &str,
    complex_path: &str,
) {
    let registry = TargetRegistry::builtin();
    let adapter = registry.get_str(id).unwrap();
    let edited = adapter
        .apply_edit(source, edit(editable_path, replacement))
        .unwrap();
    assert!(String::from_utf8(edited).unwrap().contains(replacement));
    assert!(matches!(
        adapter.apply_edit(source, edit(complex_path, "unsafe")),
        Err(EditError::UnsupportedEdit(_))
    ));
}

#[test]
fn surge_only_patches_safe_general_keys() {
    assert_conf_adapter_boundaries(
        "surge",
        SURGE,
        "/General/loglevel",
        "info",
        "/Script/http-response",
    );
}

#[test]
fn loon_only_patches_safe_general_keys() {
    assert_conf_adapter_boundaries(
        "loon",
        LOON,
        "/General/dns-server",
        "1.1.1.1",
        "/Rewrite/rule",
    );
}

#[test]
fn quantumult_x_only_patches_safe_general_keys() {
    assert_conf_adapter_boundaries(
        "quantumult-x",
        QX,
        "/general/server_check_url",
        "https://example.test/new",
        "/rewrite_remote/url",
    );
}

#[test]
fn shadowrocket_only_patches_safe_general_keys() {
    assert_conf_adapter_boundaries(
        "shadowrocket",
        SHADOWROCKET,
        "/General/bypass-system",
        "false",
        "/Rule/example",
    );
}

#[test]
fn conf_duplicate_sections_keys_and_inline_comments_are_refused() {
    let registry = TargetRegistry::builtin();
    let adapter = registry.get_str("surge").unwrap();
    let duplicate_section = b"[General]\nloglevel = notify\n[General]\nother = value\n";
    assert!(matches!(
        adapter.apply_edit(duplicate_section, edit("/General/loglevel", "info")),
        Err(EditError::AmbiguousField(_))
    ));

    let duplicate_key = b"[General]\nloglevel = notify\nloglevel = warn\n";
    assert!(matches!(
        adapter.apply_edit(duplicate_key, edit("/General/loglevel", "info")),
        Err(EditError::AmbiguousField(_))
    ));

    let inline_comment = b"[General]\nloglevel = notify # preserve\n";
    assert!(matches!(
        adapter.apply_edit(inline_comment, edit("/General/loglevel", "info")),
        Err(EditError::UnsupportedEdit(_))
    ));
}

#[test]
fn line_endings_unicode_bom_and_unknown_content_survive() {
    let registry = TargetRegistry::builtin();
    for (id, source, path, original, replacement) in [
        ("mihomo", MIHOMO, "/mixed-port", "7890", "7893"),
        ("sing-box", SINGBOX, "/log/level", "\"info\"", "\"warn\""),
        ("surge", SURGE, "/General/loglevel", "notify", "info"),
        ("loon", LOON, "/General/dns-server", "system", "1.1.1.1"),
        (
            "quantumult-x",
            QX,
            "/general/server_check_url",
            "https://example.test/check",
            "https://example.test/new",
        ),
        (
            "shadowrocket",
            SHADOWROCKET,
            "/General/bypass-system",
            "true",
            "false",
        ),
    ] {
        let adapter = registry.get_str(id).unwrap();
        let source_text = String::from_utf8(source.to_vec()).unwrap();
        let expected = source_text.replacen(original, replacement, 1).into_bytes();
        let edited = adapter.apply_edit(source, edit(path, replacement)).unwrap();
        assert_eq!(edited, expected, "{id} LF and surrounding bytes");
        assert_eq!(
            NativeDocument::from_bytes(&edited).line_ending(),
            LineEnding::Lf
        );
        assert!(NativeDocument::from_bytes(&edited).has_trailing_newline());

        let crlf_text = source_text.replace('\n', "\r\n");
        let crlf = crlf_text.as_bytes();
        let expected_crlf = crlf_text.replacen(original, replacement, 1).into_bytes();
        let edited = adapter.apply_edit(crlf, edit(path, replacement)).unwrap();
        assert_eq!(edited, expected_crlf, "{id} CRLF and surrounding bytes");
        let edited_document = NativeDocument::from_bytes(&edited);
        assert_eq!(edited_document.line_ending(), LineEnding::CrLf, "{id}");
        assert!(edited_document.has_trailing_newline(), "{id}");

        let mut bom = vec![0xef, 0xbb, 0xbf];
        bom.extend_from_slice(source);
        let mut expected_bom = vec![0xef, 0xbb, 0xbf];
        expected_bom.extend_from_slice(&expected);
        let edited = adapter.apply_edit(&bom, edit(path, replacement)).unwrap();
        assert_eq!(edited, expected_bom, "{id} BOM and surrounding bytes");
        assert_eq!(
            NativeDocument::from_bytes(&edited).encoding(),
            SourceEncoding::Utf8Bom,
            "{id}"
        );
    }
}

#[test]
fn adapters_reject_non_utf8_without_silent_conversion() {
    let registry = TargetRegistry::builtin();
    for adapter in registry.adapters() {
        let error = adapter
            .parse(&[0xff])
            .expect_err("invalid encoding must be rejected");
        let diagnostic = error.diagnostics.first().expect("encoding diagnostic");
        assert_eq!(diagnostic.code, "encoding.unsupported");
        assert_eq!(diagnostic.severity, DiagnosticSeverity::Error);
    }
    assert_eq!(
        NativeDocument::from_bytes(&[0xff]).encoding(),
        SourceEncoding::Unsupported
    );
}

#[test]
fn detection_remains_advisory() {
    let registry = TargetRegistry::builtin();
    assert_eq!(
        registry
            .get_str("mihomo")
            .unwrap()
            .detect(MIHOMO)
            .confidence,
        DetectionConfidence::Likely
    );
}
