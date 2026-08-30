use crate::diagnostics::{Diagnostic, ValidationLevel, ValidationResult};
use crate::document::{NativeDocument, ParsedDocument, SourceField, SourceSpan};
use crate::patch::{apply_span_patch, EditError, StructuredEdit};
use crate::path::ConfigPath;
use crate::schema::{SchemaField, SchemaValueType, TargetSchema};

use yaml_rust2::parser::{EventReceiver, Parser};
use yaml_rust2::scanner::TScalarStyle;
use yaml_rust2::{Event, Yaml};

use super::{
    AdapterCapabilities, ConfigAdapter, DetectionConfidence, DetectionResult, ParseError,
    StructuredEditCapability, StructuredEditOperation, StructuredEditScope, TargetDescriptor,
    TargetId,
};

pub struct MihomoAdapter {
    descriptor: TargetDescriptor,
    schema: TargetSchema,
    structured_edits: Vec<StructuredEditCapability>,
}

impl MihomoAdapter {
    pub fn new() -> Self {
        let mixed_port = ConfigPath::new("/mixed-port").expect("static path");
        Self {
            descriptor: TargetDescriptor {
                id: TargetId::new(TargetId::MIHOMO).expect("built-in target id"),
                display_name: "Mihomo".into(),
                file_extensions: vec!["yaml".into(), "yml".into()],
                capabilities: AdapterCapabilities {
                    raw_edit: true,
                    validation_level: ValidationLevel::Static,
                    native_validation: false,
                    sections: vec![
                        "top-level YAML mapping".into(),
                        "proxies".into(),
                        "proxy-groups".into(),
                        "rules".into(),
                    ],
                },
            },
            schema: TargetSchema::new(vec![SchemaField {
                path: mixed_port.clone(),
                value_type: SchemaValueType::Integer,
                description: "Mixed inbound port; must be between 1 and 65535.".into(),
            }]),
            structured_edits: vec![StructuredEditCapability {
                scope: StructuredEditScope::ExactPaths(vec![mixed_port]),
                operations: vec![StructuredEditOperation::ReplaceExistingValue],
                value_types: vec![SchemaValueType::Integer],
                safety_notes: "Only an unambiguous top-level decimal scalar is patched.".into(),
            }],
        }
    }
}

impl Default for MihomoAdapter {
    fn default() -> Self {
        Self::new()
    }
}

impl ConfigAdapter for MihomoAdapter {
    fn descriptor(&self) -> &TargetDescriptor {
        &self.descriptor
    }

    fn schema(&self) -> Option<&TargetSchema> {
        Some(&self.schema)
    }

    fn structured_edit_capabilities(&self) -> &[StructuredEditCapability] {
        &self.structured_edits
    }

    fn detect(&self, source: &[u8]) -> DetectionResult {
        let target = self.descriptor.id.clone();
        let confidence =
            std::str::from_utf8(source)
                .ok()
                .map_or(DetectionConfidence::None, |text| {
                    if text.lines().any(|line| {
                        line.starts_with("mixed-port:") || line.starts_with("proxy-groups:")
                    }) {
                        DetectionConfidence::Likely
                    } else {
                        DetectionConfidence::Maybe
                    }
                });
        DetectionResult {
            target,
            confidence,
            diagnostics: Vec::new(),
        }
    }

    fn parse(&self, source: &[u8]) -> Result<ParsedDocument, ParseError> {
        let (document, _) = parse_yaml_root(source, &self.descriptor.id)?;
        let fields = scan_mixed_port(&document)
            .into_iter()
            .filter_map(|occurrence| {
                occurrence.value_span.map(|value_span| SourceField {
                    path: ConfigPath::new("/mixed-port").expect("static path"),
                    value_span,
                })
            })
            .collect();
        Ok(ParsedDocument::new(document, fields))
    }

    fn validate(&self, source: &[u8]) -> ValidationResult {
        let (document, mixed_port_values) = match parse_yaml_root(source, &self.descriptor.id) {
            Ok(parsed) => parsed,
            Err(error) => {
                let level = if error
                    .diagnostics
                    .iter()
                    .any(|diagnostic| diagnostic.code.starts_with("encoding."))
                {
                    ValidationLevel::Basic
                } else {
                    ValidationLevel::Syntax
                };
                return ValidationResult::new(level, error.diagnostics);
            }
        };

        let occurrences = scan_mixed_port(&document);
        let mut diagnostics = Vec::new();
        if mixed_port_values.len() > 1 {
            diagnostics.push(Diagnostic::error(
                "mihomo.mixed_port_duplicate",
                "mixed-port occurs more than once and is ambiguous",
                occurrences
                    .get(1)
                    .or_else(|| occurrences.first())
                    .map(|occurrence| occurrence.full_span),
            ));
        }

        if let Some(value) = mixed_port_values.first() {
            let span = occurrences.first().map(|occurrence| occurrence.full_span);
            match value {
                MixedPortValue::Integer(port) if (1..=65_535).contains(port) => {}
                MixedPortValue::Integer(_) => diagnostics.push(Diagnostic::error(
                    "mihomo.mixed_port_range",
                    "mixed-port must be between 1 and 65535",
                    span,
                )),
                _ => diagnostics.push(Diagnostic::error(
                    "mihomo.mixed_port_type",
                    "mixed-port must be an integer",
                    span,
                )),
            }
        }
        ValidationResult::new(ValidationLevel::Static, diagnostics)
    }

    fn apply_edit(&self, source: &[u8], edit: StructuredEdit) -> Result<Vec<u8>, EditError> {
        if edit.path.as_str() != "/mixed-port" {
            return Err(EditError::UnsupportedEdit(
                "Mihomo structured edits currently support only /mixed-port".into(),
            ));
        }
        let (document, mixed_port_values) =
            parse_yaml_root(source, &self.descriptor.id).map_err(parse_edit_error)?;
        let occurrences = scan_mixed_port(&document);
        if mixed_port_values.len() > 1 || occurrences.len() > 1 {
            return Err(EditError::AmbiguousField(edit.path.to_string()));
        }
        let occurrence = match occurrences.as_slice() {
            [] => return Err(EditError::FieldNotFound(edit.path.to_string())),
            [one] => one,
            _ => unreachable!("duplicate occurrences were rejected"),
        };
        let value_span = occurrence.value_span.ok_or_else(|| {
            EditError::UnsupportedEdit(
                "mixed-port value is not a safely identifiable decimal scalar".into(),
            )
        })?;
        let value = edit
            .replacement
            .parse::<u16>()
            .map_err(|_| EditError::UnsafeValue("mixed-port must be a decimal integer".into()))?;
        if value == 0 {
            return Err(EditError::UnsafeValue(
                "mixed-port must be between 1 and 65535".into(),
            ));
        }
        apply_span_patch(source, value_span, edit.replacement.as_bytes())
    }
}

fn parse_yaml_root(
    source: &[u8],
    target: &TargetId,
) -> Result<(NativeDocument, Vec<MixedPortValue>), ParseError> {
    let document = super::common::validate_utf8_document(source, target.clone())?;
    let text = document.as_str().map_err(|_| ParseError::new(Vec::new()))?;
    let mut parser = Parser::new_from_str(text);
    let mut sink = YamlEventSink::default();
    parser.load(&mut sink, true).map_err(|error| {
        ParseError::new(vec![Diagnostic::error(
            "mihomo.yaml_syntax",
            format!("invalid Mihomo YAML: {error}"),
            None,
        )])
    })?;
    let document_starts: Vec<_> = sink
        .events
        .iter()
        .enumerate()
        .filter_map(|(index, event)| matches!(event, Event::DocumentStart).then_some(index))
        .collect();
    if document_starts.len() != 1 {
        return Err(ParseError::new(vec![Diagnostic::error(
            "mihomo.document_count",
            "Mihomo configuration must contain exactly one YAML document",
            None,
        )]));
    }
    let root_index = document_starts[0] + 1;
    if !matches!(sink.events.get(root_index), Some(Event::MappingStart(..))) {
        return Err(ParseError::new(vec![Diagnostic::error(
            "mihomo.root_mapping",
            "Mihomo configuration root must be a YAML mapping",
            Some(SourceSpan::new(0, source.len())),
        )]));
    }
    let mixed_ports =
        inspect_top_level_mixed_ports(&sink.events, root_index).map_err(|message| {
            ParseError::new(vec![Diagnostic::error(
                "mihomo.yaml_structure",
                format!("could not inspect Mihomo YAML structure: {message}"),
                None,
            )])
        })?;
    Ok((document, mixed_ports))
}

#[derive(Default)]
struct YamlEventSink {
    events: Vec<Event>,
}

impl EventReceiver for YamlEventSink {
    fn on_event(&mut self, event: Event) {
        self.events.push(event);
    }
}

#[derive(Clone, Copy)]
enum MixedPortValue {
    Integer(i64),
    Other,
}

fn inspect_top_level_mixed_ports(
    events: &[Event],
    root_index: usize,
) -> Result<Vec<MixedPortValue>, &'static str> {
    let mut cursor = root_index + 1;
    let mut values = Vec::new();
    loop {
        match events.get(cursor) {
            Some(Event::MappingEnd) => return Ok(values),
            Some(_) => {}
            None => return Err("mapping did not end"),
        }

        let is_mixed_port = matches!(
            events.get(cursor),
            Some(Event::Scalar(key, _, _, _)) if key == "mixed-port"
        );
        cursor = skip_yaml_node(events, cursor)?;
        if is_mixed_port {
            values.push(classify_mixed_port(events.get(cursor)));
        }
        cursor = skip_yaml_node(events, cursor)?;
    }
}

fn classify_mixed_port(event: Option<&Event>) -> MixedPortValue {
    let Some(Event::Scalar(value, style, _, tag)) = event else {
        return MixedPortValue::Other;
    };
    if *style != TScalarStyle::Plain {
        return MixedPortValue::Other;
    }

    let integer = if let Some(tag) = tag {
        (tag.handle == "tag:yaml.org,2002:" && tag.suffix == "int")
            .then(|| value.parse::<i64>().ok())
            .flatten()
    } else {
        match Yaml::from_str(value) {
            Yaml::Integer(integer) => Some(integer),
            _ => None,
        }
    };
    integer.map_or(MixedPortValue::Other, MixedPortValue::Integer)
}

fn skip_yaml_node(events: &[Event], index: usize) -> Result<usize, &'static str> {
    match events.get(index) {
        Some(Event::Scalar(..) | Event::Alias(..)) => Ok(index + 1),
        Some(Event::SequenceStart(..)) => {
            let mut cursor = index + 1;
            loop {
                match events.get(cursor) {
                    Some(Event::SequenceEnd) => return Ok(cursor + 1),
                    Some(_) => cursor = skip_yaml_node(events, cursor)?,
                    None => return Err("sequence did not end"),
                }
            }
        }
        Some(Event::MappingStart(..)) => {
            let mut cursor = index + 1;
            loop {
                match events.get(cursor) {
                    Some(Event::MappingEnd) => return Ok(cursor + 1),
                    Some(_) => {
                        cursor = skip_yaml_node(events, cursor)?;
                        cursor = skip_yaml_node(events, cursor)?;
                    }
                    None => return Err("mapping did not end"),
                }
            }
        }
        _ => Err("expected a YAML node"),
    }
}

#[derive(Clone, Copy)]
struct MixedPortOccurrence {
    value_span: Option<SourceSpan>,
    full_span: SourceSpan,
}

fn scan_mixed_port(document: &NativeDocument) -> Vec<MixedPortOccurrence> {
    let Ok(text) = document.as_str() else {
        return Vec::new();
    };
    let mut occurrences = Vec::new();
    let mut offset = if document.encoding() == crate::document::SourceEncoding::Utf8Bom {
        3
    } else {
        0
    };
    for line in text.split_inclusive('\n') {
        let without_newline = line.strip_suffix('\n').unwrap_or(line);
        let content = without_newline
            .strip_suffix('\r')
            .unwrap_or(without_newline);
        if let Some(after_key) = content.strip_prefix("mixed-port:") {
            let leading = after_key.len() - after_key.trim_start().len();
            let value_start = offset + "mixed-port:".len() + leading;
            let trimmed = after_key[leading..].trim_end();
            let full_span = SourceSpan::new(value_start, value_start + trimmed.len());
            let digits = trimmed
                .bytes()
                .take_while(|byte| byte.is_ascii_digit())
                .count();
            let remainder = &trimmed[digits..];
            let safely_terminated = digits > 0
                && (remainder.trim().is_empty() || remainder.trim_start().starts_with('#'));
            occurrences.push(MixedPortOccurrence {
                value_span: safely_terminated
                    .then_some(SourceSpan::new(value_start, value_start + digits)),
                full_span,
            });
        }
        offset += line.len();
    }
    occurrences
}

fn parse_edit_error(error: ParseError) -> EditError {
    EditError::ParseFailed(
        error
            .diagnostics
            .first()
            .map(|diagnostic| diagnostic.message.clone())
            .unwrap_or_else(|| "invalid YAML document".into()),
    )
}
