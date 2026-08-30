use std::collections::HashSet;

use crate::diagnostics::Diagnostic;
use crate::document::{NativeDocument, ParsedDocument, SourceField, SourceSpan};
use crate::patch::{apply_span_patch, EditError, StructuredEdit};
use crate::path::ConfigPath;

use super::{DetectionConfidence, DetectionResult, ParseError, TargetId};

pub(crate) fn validate_utf8_document(
    source: &[u8],
    target: TargetId,
) -> Result<NativeDocument, ParseError> {
    let document = NativeDocument::from_bytes(source);
    if let Some(diagnostic) = document.encoding_diagnostic() {
        return Err(ParseError::new(vec![diagnostic]));
    }
    let _ = document.as_str().map_err(|_| {
        ParseError::new(vec![Diagnostic::error(
            "encoding.invalid_utf8",
            format!("{target} configuration is not valid UTF-8"),
            None,
        )])
    })?;
    Ok(document)
}

pub(crate) fn text_detection(source: &[u8], target: TargetId, marker: &str) -> DetectionResult {
    let confidence = match std::str::from_utf8(source) {
        Ok(text) if text.contains(marker) => DetectionConfidence::Likely,
        Ok(_) => DetectionConfidence::Maybe,
        Err(_) => DetectionConfidence::None,
    };
    DetectionResult {
        target,
        confidence,
        diagnostics: Vec::new(),
    }
}

#[derive(Clone)]
pub(crate) struct IniParseOptions {
    pub target: TargetId,
    pub editable_sections: &'static [&'static str],
    pub case_sensitive_sections: bool,
}

pub(crate) struct IniParsedDocument {
    pub parsed: ParsedDocument,
    duplicate_sections: HashSet<String>,
}

pub(crate) fn parse_ini_like(
    source: &[u8],
    options: IniParseOptions,
) -> Result<IniParsedDocument, ParseError> {
    let document = validate_utf8_document(source, options.target.clone())?;
    let (fields, duplicate_sections) = {
        let text = document.as_str().map_err(|_| ParseError::new(Vec::new()))?;
        let mut fields = Vec::new();
        let mut seen_sections = HashSet::new();
        let mut duplicate_sections = HashSet::new();
        let mut section: Option<String> = None;
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
            let trimmed = content.trim();
            if trimmed.is_empty()
                || trimmed.starts_with('#')
                || trimmed.starts_with(';')
                || trimmed.starts_with("//")
            {
                offset += line.len();
                continue;
            }

            if trimmed.starts_with('[') && trimmed.ends_with(']') {
                let raw_section = trimmed[1..trimmed.len() - 1].trim();
                section = matching_section(raw_section, &options).map(str::to_owned);
                if let Some(editable_section) = &section {
                    let normalized = normalize_section(editable_section, &options);
                    if !seen_sections.insert(normalized.clone()) {
                        duplicate_sections.insert(normalized);
                    }
                }
                offset += line.len();
                continue;
            }

            let Some(editable_section) = &section else {
                offset += line.len();
                continue;
            };
            let Some(equal) = content.find('=') else {
                offset += line.len();
                continue;
            };
            let key = content[..equal].trim();
            if !is_safe_key(key) {
                offset += line.len();
                continue;
            }
            let after_equal = &content[equal + 1..];
            let value_start_rel = equal + 1 + after_equal.len() - after_equal.trim_start().len();
            let value = content[value_start_rel..].trim_end();
            let value_start = offset + value_start_rel;
            fields.push(SourceField {
                path: ConfigPath::from_segments([editable_section.as_str(), key]),
                value_span: SourceSpan::new(value_start, value_start + value.len()),
            });
            offset += line.len();
        }
        (fields, duplicate_sections)
    };

    Ok(IniParsedDocument {
        parsed: ParsedDocument::new(document, fields),
        duplicate_sections,
    })
}

pub(crate) fn value_edit(
    source: &[u8],
    edit: StructuredEdit,
    options: IniParseOptions,
) -> Result<Vec<u8>, EditError> {
    let segments = edit.path.decoded_segments();
    if segments.len() != 2 {
        return Err(EditError::UnsupportedEdit(
            "CONF edits require /Section/key".into(),
        ));
    }
    let Some(editable_section) = matching_section(&segments[0], &options) else {
        return Err(EditError::UnsupportedEdit(format!(
            "section is opaque and cannot be patched safely: {}",
            segments[0]
        )));
    };

    let parsed = parse_ini_like(source, options.clone()).map_err(|error| {
        EditError::ParseFailed(
            error
                .diagnostics
                .first()
                .map(|diagnostic| diagnostic.message.clone())
                .unwrap_or_else(|| "invalid text document".into()),
        )
    })?;
    let normalized = normalize_section(editable_section, &options);
    if parsed.duplicate_sections.contains(&normalized) {
        return Err(EditError::AmbiguousField(edit.path.to_string()));
    }

    let canonical_path = ConfigPath::from_segments([editable_section, segments[1].as_str()]);
    let matches: Vec<_> = parsed
        .parsed
        .fields
        .iter()
        .filter(|field| field.path == canonical_path)
        .collect();
    let field = match matches.as_slice() {
        [] => return Err(EditError::FieldNotFound(edit.path.to_string())),
        [_one, _two, ..] => return Err(EditError::AmbiguousField(edit.path.to_string())),
        [one] => *one,
    };

    let current = field
        .value_span
        .get(source)
        .ok_or_else(|| EditError::ParseFailed("value span is outside the document".into()))?;
    if current.contains(&b'#') || current.contains(&b';') {
        return Err(EditError::UnsupportedEdit(
            "inline comment boundary is not safe to infer".into(),
        ));
    }
    if edit.replacement.is_empty()
        || edit.replacement.contains('\r')
        || edit.replacement.contains('\n')
    {
        return Err(EditError::UnsafeValue(format!(
            "value for {} is not a safe single-line replacement",
            edit.path
        )));
    }
    apply_span_patch(source, field.value_span, edit.replacement.as_bytes())
}

fn matching_section<'a>(section: &str, options: &'a IniParseOptions) -> Option<&'a str> {
    options.editable_sections.iter().copied().find(|candidate| {
        if options.case_sensitive_sections {
            *candidate == section
        } else {
            candidate.eq_ignore_ascii_case(section)
        }
    })
}

fn normalize_section(section: &str, options: &IniParseOptions) -> String {
    if options.case_sensitive_sections {
        section.to_owned()
    } else {
        section.to_ascii_lowercase()
    }
}

fn is_safe_key(key: &str) -> bool {
    !key.is_empty()
        && key
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.'))
}
