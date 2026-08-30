use crate::diagnostics::Diagnostic;
use crate::document::{NativeDocument, ParsedDocument, SourceField, SourceSpan};
use crate::patch::EditError;
use crate::path::ConfigPath;

use serde_json::Value;

use super::{DetectionConfidence, DetectionResult, ParseError, TargetId};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum JsonValueKind {
    Object,
    Array,
    Scalar,
}

struct Scanner<'a> {
    bytes: &'a [u8],
    cursor: usize,
    base_offset: usize,
    fields: Vec<SourceField>,
}

pub(crate) fn parse_json_document(
    source: &[u8],
    target: TargetId,
) -> Result<ParsedDocument, ParseError> {
    let document = NativeDocument::from_bytes(source);
    if let Some(diagnostic) = document.encoding_diagnostic() {
        return Err(ParseError::new(vec![diagnostic]));
    }
    let base_offset = if document.encoding() == crate::document::SourceEncoding::Utf8Bom {
        3
    } else {
        0
    };
    let value: Value =
        serde_json::from_slice(&document.bytes()[base_offset..]).map_err(|error| {
            ParseError::new(vec![Diagnostic::error(
                "json.syntax",
                format!("invalid {target} JSON: {error}"),
                None,
            )])
        })?;
    if !value.is_object() {
        return Err(ParseError::new(vec![Diagnostic::error(
            "json.root_object",
            format!("{target} configuration root must be a JSON object"),
            Some(SourceSpan::new(base_offset, source.len())),
        )]));
    }
    let mut scanner = Scanner {
        bytes: &document.bytes()[base_offset..],
        cursor: 0,
        base_offset,
        fields: Vec::new(),
    };
    scanner.skip_ws();
    let result = scanner.parse_value(String::new());
    if let Err(message) = result {
        return Err(ParseError::new(vec![Diagnostic::error(
            "json.parse",
            format!("invalid {target} JSON: {message}"),
            Some(SourceSpan::new(
                scanner.base_offset + scanner.cursor,
                (scanner.base_offset + scanner.cursor + 1).min(source.len()),
            )),
        )]));
    }
    scanner.skip_ws();
    if scanner.base_offset + scanner.cursor != source.len() {
        return Err(ParseError::new(vec![Diagnostic::error(
            "json.trailing",
            "unexpected bytes after the JSON document",
            Some(SourceSpan::new(
                scanner.base_offset + scanner.cursor,
                source.len(),
            )),
        )]));
    }
    let fields = std::mem::take(&mut scanner.fields);
    drop(scanner);
    Ok(ParsedDocument::new(document, fields))
}

pub(crate) fn find_json_field(
    source: &[u8],
    path: &ConfigPath,
    target: TargetId,
) -> Result<SourceSpan, EditError> {
    let parsed = parse_json_document(source, target).map_err(|error| {
        EditError::ParseFailed(
            error
                .diagnostics
                .first()
                .map(|diagnostic| diagnostic.message.clone())
                .unwrap_or_else(|| "invalid JSON".into()),
        )
    })?;
    let matches: Vec<_> = parsed
        .fields
        .iter()
        .filter(|field| &field.path == path)
        .collect();
    match matches.as_slice() {
        [] => Err(EditError::FieldNotFound(path.to_string())),
        [_one, _two, ..] => Err(EditError::AmbiguousField(path.to_string())),
        [one] => Ok(one.value_span),
    }
}

pub(crate) fn validate_json_literal(literal: &str) -> bool {
    serde_json::from_str::<Value>(literal).is_ok()
}

pub(crate) fn json_detection(source: &[u8], target: TargetId) -> DetectionResult {
    let source = source
        .strip_prefix(&[0xef, 0xbb, 0xbf][..])
        .unwrap_or(source);
    let trimmed = source
        .iter()
        .copied()
        .find(|byte| !byte.is_ascii_whitespace());
    DetectionResult {
        target,
        confidence: if trimmed == Some(b'{') || trimmed == Some(b'[') {
            DetectionConfidence::Likely
        } else {
            DetectionConfidence::None
        },
        diagnostics: Vec::new(),
    }
}

impl<'a> Scanner<'a> {
    fn skip_ws(&mut self) {
        while self.cursor < self.bytes.len() && self.bytes[self.cursor].is_ascii_whitespace() {
            self.cursor += 1;
        }
    }

    fn parse_value(&mut self, path: String) -> Result<JsonValueKind, String> {
        self.skip_ws();
        let start = self.cursor;
        let kind = match self.bytes.get(self.cursor).copied() {
            Some(b'{') => self.parse_object(path.clone())?,
            Some(b'[') => self.parse_array(path.clone())?,
            Some(b'"') => {
                self.parse_string()?;
                JsonValueKind::Scalar
            }
            Some(b'-' | b'0'..=b'9') => {
                self.parse_number()?;
                JsonValueKind::Scalar
            }
            Some(b't') => {
                self.consume_literal(b"true")?;
                JsonValueKind::Scalar
            }
            Some(b'f') => {
                self.consume_literal(b"false")?;
                JsonValueKind::Scalar
            }
            Some(b'n') => {
                self.consume_literal(b"null")?;
                JsonValueKind::Scalar
            }
            Some(_) => return Err("unexpected value".into()),
            None => return Err("unexpected end of input".into()),
        };
        if !path.is_empty() {
            self.fields.push(SourceField {
                path: ConfigPath::new(path).expect("scanner produces valid JSON Pointers"),
                value_span: SourceSpan::new(
                    self.base_offset + start,
                    self.base_offset + self.cursor,
                ),
            });
        }
        Ok(kind)
    }

    fn parse_object(&mut self, path: String) -> Result<JsonValueKind, String> {
        self.cursor += 1;
        self.skip_ws();
        if self.consume_if(b'}') {
            return Ok(JsonValueKind::Object);
        }
        loop {
            self.skip_ws();
            if self.bytes.get(self.cursor) != Some(&b'"') {
                return Err("object key must be a string".into());
            }
            let key = self.parse_string_value()?;
            self.skip_ws();
            if !self.consume_if(b':') {
                return Err("expected ':' after object key".into());
            }
            let child_path = append_pointer(&path, &key);
            self.parse_value(child_path)?;
            self.skip_ws();
            if self.consume_if(b'}') {
                return Ok(JsonValueKind::Object);
            }
            if !self.consume_if(b',') {
                return Err("expected ',' or '}' in object".into());
            }
        }
    }

    fn parse_array(&mut self, path: String) -> Result<JsonValueKind, String> {
        self.cursor += 1;
        self.skip_ws();
        if self.consume_if(b']') {
            return Ok(JsonValueKind::Array);
        }
        let mut index = 0usize;
        loop {
            let child_path = append_pointer(&path, &index.to_string());
            self.parse_value(child_path)?;
            index += 1;
            self.skip_ws();
            if self.consume_if(b']') {
                return Ok(JsonValueKind::Array);
            }
            if !self.consume_if(b',') {
                return Err("expected ',' or ']' in array".into());
            }
        }
    }

    fn parse_string_value(&mut self) -> Result<String, String> {
        let start = self.cursor;
        self.parse_string()?;
        serde_json::from_slice(&self.bytes[start..self.cursor])
            .map_err(|error| format!("invalid JSON object key: {error}"))
    }

    fn parse_string(&mut self) -> Result<(), String> {
        if !self.consume_if(b'"') {
            return Err("expected string".into());
        }
        while self.cursor < self.bytes.len() {
            match self.bytes[self.cursor] {
                b'"' => {
                    self.cursor += 1;
                    return Ok(());
                }
                b'\\' => {
                    self.cursor += 1;
                    if self.cursor >= self.bytes.len() {
                        return Err("unterminated escape".into());
                    }
                    self.cursor += 1;
                }
                byte if byte < 0x20 => return Err("control character in string".into()),
                _ => self.cursor += 1,
            }
        }
        Err("unterminated string".into())
    }

    fn parse_number(&mut self) -> Result<(), String> {
        let start = self.cursor;
        self.consume_if(b'-');
        if self.consume_if(b'0') {
            if self
                .bytes
                .get(self.cursor)
                .is_some_and(|byte| byte.is_ascii_digit())
            {
                return Err("leading zero in number".into());
            }
        } else {
            let digits = self.consume_while(|byte| byte.is_ascii_digit());
            if digits == 0 {
                return Err("invalid number".into());
            }
        }
        if self.consume_if(b'.') && self.consume_while(|byte| byte.is_ascii_digit()) == 0 {
            return Err("invalid fraction".into());
        }
        if self
            .bytes
            .get(self.cursor)
            .is_some_and(|byte| *byte == b'e' || *byte == b'E')
        {
            self.cursor += 1;
            self.consume_if(b'+');
            self.consume_if(b'-');
            if self.consume_while(|byte| byte.is_ascii_digit()) == 0 {
                return Err("invalid exponent".into());
            }
        }
        if self.cursor == start {
            Err("invalid number".into())
        } else {
            Ok(())
        }
    }

    fn consume_literal(&mut self, literal: &[u8]) -> Result<(), String> {
        if self.bytes.get(self.cursor..self.cursor + literal.len()) == Some(literal) {
            self.cursor += literal.len();
            Ok(())
        } else {
            Err("invalid literal".into())
        }
    }

    fn consume_if(&mut self, byte: u8) -> bool {
        if self.bytes.get(self.cursor) == Some(&byte) {
            self.cursor += 1;
            true
        } else {
            false
        }
    }

    fn consume_while(&mut self, predicate: impl Fn(u8) -> bool) -> usize {
        let start = self.cursor;
        while self.cursor < self.bytes.len() && predicate(self.bytes[self.cursor]) {
            self.cursor += 1;
        }
        self.cursor - start
    }
}

fn append_pointer(path: &str, segment: &str) -> String {
    let escaped = segment.replace('~', "~0").replace('/', "~1");
    format!("{path}/{escaped}")
}
