use crate::diagnostics::{Diagnostic, ValidationLevel, ValidationResult};
use crate::document::{ParsedDocument, SourceSpan};
use crate::patch::{apply_span_patch, EditError, StructuredEdit};

use super::{
    AdapterCapabilities, ConfigAdapter, DetectionConfidence, DetectionResult, ParseError,
    TargetDescriptor, TargetId,
};

pub struct MihomoAdapter {
    descriptor: TargetDescriptor,
}

impl MihomoAdapter {
    pub fn new() -> Self {
        Self {
            descriptor: TargetDescriptor {
                id: TargetId::new(TargetId::MIHOMO).expect("built-in target id"),
                display_name: "Mihomo".into(),
                file_extensions: vec!["yaml".into(), "yml".into()],
                capabilities: AdapterCapabilities {
                    raw_edit: true,
                    schema: true,
                    structured_edit: true,
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

    fn detect(&self, source: &[u8]) -> DetectionResult {
        let target = self.descriptor.id.clone();
        let confidence = std::str::from_utf8(source).ok().map_or(
            DetectionConfidence::None,
            |text| {
                if text.lines().any(|line| {
                    line.starts_with("mixed-port:") || line.starts_with("proxy-groups:")
                }) {
                    DetectionConfidence::Likely
                } else {
                    DetectionConfidence::Maybe
                }
            },
        );
        DetectionResult {
            target,
            confidence,
            diagnostics: Vec::new(),
        }
    }

    fn parse(&self, source: &[u8]) -> Result<ParsedDocument, ParseError> {
        let document = super::common::validate_utf8_document(source, self.descriptor.id.clone())?;
        let fields = {
            let text = document
                .as_str()
                .map_err(|_| ParseError::new(Vec::new()))?;
            let mut fields = Vec::new();
            let mut offset = if document.encoding() == crate::document::SourceEncoding::Utf8Bom {
                3
            } else {
                0
            };

            for line in text.split_inclusive('\n') {
                let without_newline = line.strip_suffix('\n').unwrap_or(line);
                let content = without_newline.strip_suffix('\r').unwrap_or(without_newline);
                if let Some(colon) = content.find(':') {
                    if colon == 0 || content[..colon].chars().any(char::is_whitespace) {
                        offset += line.len();
                        continue;
                    }
                    let key = &content[..colon];
                    let after = &content[colon + 1..];
                    let leading = after.len() - after.trim_start().len();
                    let value = after[leading..].trim_end();
                    if !value.is_empty() {
                        let start = offset + colon + 1 + leading;
                        fields.push(crate::document::SourceField {
                            path: key.to_owned(),
                            value_span: SourceSpan::new(start, start + value.len()),
                        });
                    }
                }
                offset += line.len();
            }
            fields
        };
        Ok(ParsedDocument::new(document, fields))
    }

    fn validate(&self, source: &[u8]) -> ValidationResult {
        let parsed = match self.parse(source) {
            Ok(parsed) => parsed,
            Err(error) => {
                return ValidationResult::new(ValidationLevel::ParseOnly, error.diagnostics)
            }
        };
        let mut diagnostics = Vec::new();
        if let Some(field) = parsed.field("mixed-port") {
            let raw = field.value_span.get(parsed.document.bytes()).unwrap_or_default();
            match std::str::from_utf8(raw)
                .ok()
                .and_then(|value| value.parse::<u16>().ok())
            {
                Some(port) if port > 0 => {}
                _ => diagnostics.push(Diagnostic::error(
                    "mihomo.mixed_port",
                    "mixed-port must be an integer between 1 and 65535",
                    Some(field.value_span),
                )),
            }
        }
        ValidationResult::new(ValidationLevel::Static, diagnostics)
    }

    fn apply_edit(&self, source: &[u8], edit: StructuredEdit) -> Result<Vec<u8>, EditError> {
        if edit.path != "mixed-port" {
            return Err(EditError::UnsupportedEdit(
                "Mihomo structured edits currently support only mixed-port".into(),
            ));
        }
        let parsed = self.parse(source).map_err(|error| {
            EditError::ParseFailed(
                error
                    .diagnostics
                    .first()
                    .map(|diagnostic| diagnostic.message.clone())
                    .unwrap_or_default(),
            )
        })?;
        let field = parsed
            .field("mixed-port")
            .ok_or_else(|| EditError::FieldNotFound(edit.path.clone()))?;
        if parsed
            .fields
            .iter()
            .filter(|candidate| candidate.path == edit.path)
            .count()
            > 1
        {
            return Err(EditError::AmbiguousField(edit.path));
        }
        let value = edit
            .replacement
            .parse::<u16>()
            .map_err(|_| EditError::UnsafeValue("mixed-port must be a decimal integer".into()))?;
        if value == 0 {
            return Err(EditError::UnsafeValue(
                "mixed-port must be between 1 and 65535".into(),
            ));
        }
        apply_span_patch(source, field.value_span, edit.replacement.as_bytes())
    }
}
