use crate::diagnostics::Diagnostic;
use crate::document::{NativeDocument, ParsedDocument, SourceField, SourceSpan};
use crate::patch::{apply_span_patch, EditError, StructuredEdit};

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

pub(crate) fn text_detection(
    source: &[u8],
    target: TargetId,
    marker: &str,
) -> DetectionResult {
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
    pub allow_bare_rules: bool,
}

pub(crate) fn parse_ini_like(
    source: &[u8],
    options: IniParseOptions,
) -> Result<ParsedDocument, ParseError> {
    let document = validate_utf8_document(source, options.target.clone())?;
    let fields = {
        let text = document
            .as_str()
            .map_err(|_| ParseError::new(Vec::new()))?;
        let mut fields = Vec::new();
        let mut section = String::new();
        let mut offset = if document.encoding() == crate::document::SourceEncoding::Utf8Bom {
            3
        } else {
            0
        };

        for line in text.split_inclusive('\n') {
            let without_newline = line.strip_suffix('\n').unwrap_or(line);
            let content = without_newline.strip_suffix('\r').unwrap_or(without_newline);
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
                section = trimmed[1..trimmed.len() - 1].trim().to_owned();
                offset += line.len();
                continue;
            }
            if let Some(equal) = content.find('=') {
                let key = content[..equal].trim();
                if key.is_empty() {
                    offset += line.len();
                    continue;
                }
                let after_equal = &content[equal + 1..];
                let value_start_rel = equal + 1 + after_equal.len() - after_equal.trim_start().len();
                let value = content[value_start_rel..].trim_end();
                let value_start = offset + value_start_rel;
                let value_end = value_start + value.len();
                let path = if section.is_empty() {
                    key.to_owned()
                } else {
                    format!("{section}.{key}")
                };
                fields.push(SourceField {
                    path,
                    value_span: SourceSpan::new(value_start, value_end),
                });
            } else if options.allow_bare_rules && !section.is_empty() {
                fields.push(SourceField {
                    path: format!("{section}.$rule"),
                    value_span: SourceSpan::new(offset, offset + content.len()),
                });
            }
            offset += line.len();
        }
        fields
    };
    Ok(ParsedDocument::new(document, fields))
}

pub(crate) fn value_edit(
    source: &[u8],
    edit: StructuredEdit,
    options: IniParseOptions,
    safe_value: impl Fn(&str) -> bool,
) -> Result<Vec<u8>, EditError> {
    let parsed = parse_ini_like(source, options).map_err(|error| {
        EditError::ParseFailed(
            error
                .diagnostics
                .first()
                .map(|diagnostic| diagnostic.message.clone())
                .unwrap_or_else(|| "invalid text document".into()),
        )
    })?;
    if parsed.document.encoding() == crate::document::SourceEncoding::Unsupported {
        return Err(EditError::UnsupportedEncoding(parsed.document.encoding()));
    }
    let matches: Vec<_> = parsed
        .fields
        .iter()
        .filter(|field| field.path == edit.path)
        .collect();
    let field = match matches.as_slice() {
        [] => return Err(EditError::FieldNotFound(edit.path)),
        [_one, _two, ..] => return Err(EditError::AmbiguousField(edit.path)),
        [one] => *one,
    };
    if !safe_value(&edit.replacement) {
        return Err(EditError::UnsafeValue(format!(
            "value for {} is not safe",
            edit.path
        )));
    }
    apply_span_patch(source, field.value_span, edit.replacement.as_bytes())
}
