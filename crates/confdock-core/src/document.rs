use std::fmt;

use crate::diagnostics::{Diagnostic, DiagnosticSeverity};
use crate::path::ConfigPath;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct SourceSpan {
    pub start: usize,
    pub end: usize,
}

impl SourceSpan {
    pub const fn new(start: usize, end: usize) -> Self {
        Self { start, end }
    }

    pub fn len(self) -> usize {
        self.end.saturating_sub(self.start)
    }

    pub fn is_empty(self) -> bool {
        self.start >= self.end
    }

    pub fn get(self, source: &[u8]) -> Option<&[u8]> {
        source.get(self.start..self.end)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SourceEncoding {
    Utf8,
    Utf8Bom,
    Unsupported,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum LineEnding {
    Lf,
    CrLf,
    Mixed,
    None,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NativeDocument {
    source: Vec<u8>,
    encoding: SourceEncoding,
    line_ending: LineEnding,
    trailing_newline: bool,
}

impl NativeDocument {
    pub fn from_bytes(source: &[u8]) -> Self {
        let encoding = detect_encoding(source);
        let line_ending = detect_line_ending(source);
        let trailing_newline = source.ends_with(b"\n");
        Self {
            source: source.to_vec(),
            encoding,
            line_ending,
            trailing_newline,
        }
    }

    pub fn bytes(&self) -> &[u8] {
        &self.source
    }

    pub fn source_bytes(&self) -> &[u8] {
        self.bytes()
    }

    pub fn into_bytes(self) -> Vec<u8> {
        self.source
    }

    pub fn encoding(&self) -> SourceEncoding {
        self.encoding
    }

    pub fn line_ending(&self) -> LineEnding {
        self.line_ending
    }

    pub fn has_trailing_newline(&self) -> bool {
        self.trailing_newline
    }

    pub fn encoding_diagnostic(&self) -> Option<Diagnostic> {
        (self.encoding == SourceEncoding::Unsupported).then_some(Diagnostic::new(
            DiagnosticSeverity::Error,
            "encoding.unsupported",
            "Only UTF-8 and UTF-8 with BOM are supported; the source was not changed.",
            None,
        ))
    }

    pub fn as_str(&self) -> Result<&str, std::str::Utf8Error> {
        let bytes = self
            .source
            .strip_prefix(&[0xef, 0xbb, 0xbf][..])
            .unwrap_or(&self.source);
        std::str::from_utf8(bytes)
    }
}

impl From<Vec<u8>> for NativeDocument {
    fn from(source: Vec<u8>) -> Self {
        Self::from_bytes(&source)
    }
}

impl AsRef<[u8]> for NativeDocument {
    fn as_ref(&self) -> &[u8] {
        self.bytes()
    }
}

impl fmt::Display for SourceEncoding {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Utf8 => write!(f, "UTF-8"),
            Self::Utf8Bom => write!(f, "UTF-8 BOM"),
            Self::Unsupported => write!(f, "unsupported"),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SourceField {
    pub path: ConfigPath,
    /// Span of the complete value, excluding surrounding whitespace.
    pub value_span: SourceSpan,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ParsedDocument {
    pub document: NativeDocument,
    pub fields: Vec<SourceField>,
}

impl ParsedDocument {
    pub fn new(document: NativeDocument, fields: Vec<SourceField>) -> Self {
        Self { document, fields }
    }

    pub fn field(&self, path: &ConfigPath) -> Option<&SourceField> {
        self.fields.iter().find(|field| &field.path == path)
    }
}

fn detect_encoding(source: &[u8]) -> SourceEncoding {
    if source.starts_with(&[0xef, 0xbb, 0xbf]) {
        if std::str::from_utf8(&source[3..]).is_ok() {
            SourceEncoding::Utf8Bom
        } else {
            SourceEncoding::Unsupported
        }
    } else if std::str::from_utf8(source).is_ok() {
        SourceEncoding::Utf8
    } else {
        SourceEncoding::Unsupported
    }
}

fn detect_line_ending(source: &[u8]) -> LineEnding {
    let mut lf = 0;
    let mut crlf = 0;
    let mut index = 0;
    while index < source.len() {
        if source[index] == b'\n' {
            if index > 0 && source[index - 1] == b'\r' {
                crlf += 1;
            } else {
                lf += 1;
            }
        }
        index += 1;
    }
    match (lf, crlf) {
        (0, 0) => LineEnding::None,
        (0, _) => LineEnding::CrLf,
        (_, 0) => LineEnding::Lf,
        _ => LineEnding::Mixed,
    }
}
