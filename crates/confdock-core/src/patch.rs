use std::fmt;

use crate::document::{SourceEncoding, SourceSpan};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StructuredEdit {
    pub path: String,
    /// Replacement text is inserted verbatim. Adapters validate its syntax
    /// before applying it; callers should provide a JSON literal for JSON
    /// targets and a scalar/line value for text targets.
    pub replacement: String,
}

impl StructuredEdit {
    pub fn new(path: impl Into<String>, replacement: impl Into<String>) -> Self {
        Self {
            path: path.into(),
            replacement: replacement.into(),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum EditError {
    UnsupportedEncoding(SourceEncoding),
    ParseFailed(String),
    FieldNotFound(String),
    AmbiguousField(String),
    UnsafeValue(String),
    UnsupportedEdit(String),
}

impl fmt::Display for EditError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::UnsupportedEncoding(encoding) => {
                write!(f, "unsupported source encoding: {encoding}")
            }
            Self::ParseFailed(message) => write!(f, "cannot safely parse document: {message}"),
            Self::FieldNotFound(path) => write!(f, "field not found: {path}"),
            Self::AmbiguousField(path) => write!(f, "field is ambiguous: {path}"),
            Self::UnsafeValue(message) => write!(f, "unsafe structured edit: {message}"),
            Self::UnsupportedEdit(message) => {
                write!(f, "unsupported structured edit: {message}")
            }
        }
    }
}

impl std::error::Error for EditError {}

pub fn apply_span_patch(
    source: &[u8],
    span: SourceSpan,
    replacement: &[u8],
) -> Result<Vec<u8>, EditError> {
    if span.start > span.end || span.end > source.len() {
        return Err(EditError::ParseFailed(
            "source span is outside the document".into(),
        ));
    }
    let mut output = Vec::with_capacity(source.len() - span.len() + replacement.len());
    output.extend_from_slice(&source[..span.start]);
    output.extend_from_slice(replacement);
    output.extend_from_slice(&source[span.end..]);
    Ok(output)
}
