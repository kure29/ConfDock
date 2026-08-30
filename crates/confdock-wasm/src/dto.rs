use confdock_core::{
    AdapterCapabilities, ConfigPath, DetectionConfidence, DetectionResult, Diagnostic,
    DiagnosticSeverity, EditError, LineEnding, ParseError, ParsedDocument, SchemaValueType,
    SourceEncoding, SourceSpan, StructuredEditCapability, StructuredEditOperation,
    StructuredEditScope, TargetDescriptor, TargetSchema, ValidationLevel, ValidationResult,
};
use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentInfoDto {
    pub encoding: &'static str,
    pub line_ending: &'static str,
    pub has_trailing_newline: bool,
    pub byte_length: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceSpanDto {
    pub start: usize,
    pub end: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticDto {
    pub severity: &'static str,
    pub code: String,
    pub message: String,
    pub span: Option<SourceSpanDto>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ValidationResultDto {
    pub level: &'static str,
    pub diagnostics: Vec<DiagnosticDto>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectionResultDto {
    pub target: String,
    pub confidence: &'static str,
    pub diagnostics: Vec<DiagnosticDto>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AdapterCapabilitiesDto {
    pub raw_edit: bool,
    pub validation_level: &'static str,
    pub native_validation: bool,
    pub sections: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TargetDescriptorDto {
    pub id: String,
    pub display_name: String,
    pub file_extensions: Vec<String>,
    pub capabilities: AdapterCapabilitiesDto,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SchemaFieldDto {
    pub path: String,
    pub value_type: &'static str,
    pub description: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TargetSchemaDto {
    pub fields: Vec<SchemaFieldDto>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StructuredEditCapabilityDto {
    pub scope: StructuredEditScopeDto,
    pub operations: Vec<&'static str>,
    pub value_types: Vec<&'static str>,
    pub safety_notes: String,
}

#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum StructuredEditScopeDto {
    ExactPaths {
        paths: Vec<String>,
    },
    ExistingJsonPointerValues,
    ExistingSectionKeys {
        sections: Vec<String>,
        #[serde(rename = "caseSensitive")]
        case_sensitive: bool,
    },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceFieldDto {
    pub path: String,
    pub value_span: SourceSpanDto,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ParsedDocumentDto {
    pub info: DocumentInfoDto,
    pub fields: Vec<SourceFieldDto>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ParseErrorDto {
    pub diagnostics: Vec<DiagnosticDto>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditErrorDto {
    pub kind: &'static str,
    pub detail: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResultDto<T, E> {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value: Option<T>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<E>,
}

pub fn result_ok<T, E>(value: T) -> ResultDto<T, E> {
    ResultDto {
        ok: true,
        value: Some(value),
        error: None,
    }
}

pub fn result_err<T, E>(error: E) -> ResultDto<T, E> {
    ResultDto {
        ok: false,
        value: None,
        error: Some(error),
    }
}

pub fn native_document_info(source: &[u8]) -> DocumentInfoDto {
    let document = confdock_core::NativeDocument::from_bytes(source);
    DocumentInfoDto {
        encoding: encoding_name(document.encoding()),
        line_ending: line_ending_name(document.line_ending()),
        has_trailing_newline: document.has_trailing_newline(),
        byte_length: source.len(),
    }
}

pub fn source_span(span: SourceSpan) -> SourceSpanDto {
    SourceSpanDto {
        start: span.start,
        end: span.end,
    }
}

pub fn diagnostic(diagnostic: Diagnostic) -> DiagnosticDto {
    DiagnosticDto {
        severity: severity_name(diagnostic.severity),
        code: diagnostic.code,
        message: diagnostic.message,
        span: diagnostic.span.map(source_span),
    }
}

pub fn diagnostics(diagnostics: Vec<Diagnostic>) -> Vec<DiagnosticDto> {
    diagnostics.into_iter().map(diagnostic).collect()
}

pub fn validation(result: ValidationResult) -> ValidationResultDto {
    ValidationResultDto {
        level: validation_level_name(result.level),
        diagnostics: diagnostics(result.diagnostics),
    }
}

pub fn detection(result: DetectionResult) -> DetectionResultDto {
    DetectionResultDto {
        target: result.target.to_string(),
        confidence: confidence_name(result.confidence),
        diagnostics: diagnostics(result.diagnostics),
    }
}

pub fn descriptor(descriptor: &TargetDescriptor) -> TargetDescriptorDto {
    TargetDescriptorDto {
        id: descriptor.id.to_string(),
        display_name: descriptor.display_name.clone(),
        file_extensions: descriptor.file_extensions.clone(),
        capabilities: capabilities(&descriptor.capabilities),
    }
}

pub fn capabilities(capabilities: &AdapterCapabilities) -> AdapterCapabilitiesDto {
    AdapterCapabilitiesDto {
        raw_edit: capabilities.raw_edit,
        validation_level: validation_level_name(capabilities.validation_level),
        native_validation: capabilities.native_validation,
        sections: capabilities.sections.clone(),
    }
}

pub fn schema(schema: &TargetSchema) -> TargetSchemaDto {
    TargetSchemaDto {
        fields: schema
            .fields
            .iter()
            .map(|field| SchemaFieldDto {
                path: field.path.to_string(),
                value_type: schema_value_type_name(field.value_type),
                description: field.description.clone(),
            })
            .collect(),
    }
}

pub fn edit_capability(capability: &StructuredEditCapability) -> StructuredEditCapabilityDto {
    StructuredEditCapabilityDto {
        scope: edit_scope(&capability.scope),
        operations: capability
            .operations
            .iter()
            .map(|operation| operation_name(*operation))
            .collect(),
        value_types: capability
            .value_types
            .iter()
            .map(|value_type| schema_value_type_name(*value_type))
            .collect(),
        safety_notes: capability.safety_notes.clone(),
    }
}

pub fn edit_scope(scope: &StructuredEditScope) -> StructuredEditScopeDto {
    match scope {
        StructuredEditScope::ExactPaths(paths) => StructuredEditScopeDto::ExactPaths {
            paths: paths.iter().map(ConfigPath::to_string).collect(),
        },
        StructuredEditScope::ExistingJsonPointerValues => {
            StructuredEditScopeDto::ExistingJsonPointerValues
        }
        StructuredEditScope::ExistingSectionKeys {
            sections,
            case_sensitive,
        } => StructuredEditScopeDto::ExistingSectionKeys {
            sections: sections.clone(),
            case_sensitive: *case_sensitive,
        },
    }
}

pub fn parsed(document: ParsedDocument) -> ParsedDocumentDto {
    ParsedDocumentDto {
        info: native_document_info(document.document.bytes()),
        fields: document
            .fields
            .into_iter()
            .map(|field| SourceFieldDto {
                path: field.path.to_string(),
                value_span: source_span(field.value_span),
            })
            .collect(),
    }
}

pub fn parse_error(error: ParseError) -> ParseErrorDto {
    ParseErrorDto {
        diagnostics: diagnostics(error.diagnostics),
    }
}

pub fn edit_error(error: EditError) -> EditErrorDto {
    let (kind, detail) = match error {
        EditError::UnsupportedEncoding(encoding) => (
            "unsupportedEncoding",
            format!("unsupported source encoding: {encoding}"),
        ),
        EditError::ParseFailed(detail) => ("parseFailed", detail),
        EditError::FieldNotFound(detail) => ("fieldNotFound", detail),
        EditError::AmbiguousField(detail) => ("ambiguousField", detail),
        EditError::UnsafeValue(detail) => ("unsafeValue", detail),
        EditError::UnsupportedEdit(detail) => ("unsupportedEdit", detail),
    };
    EditErrorDto { kind, detail }
}

fn encoding_name(encoding: SourceEncoding) -> &'static str {
    match encoding {
        SourceEncoding::Utf8 => "utf8",
        SourceEncoding::Utf8Bom => "utf8-bom",
        SourceEncoding::Unsupported => "unsupported",
    }
}

fn line_ending_name(line_ending: LineEnding) -> &'static str {
    match line_ending {
        LineEnding::Lf => "lf",
        LineEnding::CrLf => "crlf",
        LineEnding::Mixed => "mixed",
        LineEnding::None => "none",
    }
}

fn severity_name(severity: DiagnosticSeverity) -> &'static str {
    match severity {
        DiagnosticSeverity::Info => "info",
        DiagnosticSeverity::Warning => "warning",
        DiagnosticSeverity::Error => "error",
    }
}

fn validation_level_name(level: ValidationLevel) -> &'static str {
    match level {
        ValidationLevel::Basic => "basic",
        ValidationLevel::Syntax => "syntax",
        ValidationLevel::Static => "static",
        ValidationLevel::Native => "native",
    }
}

fn confidence_name(confidence: DetectionConfidence) -> &'static str {
    match confidence {
        DetectionConfidence::None => "none",
        DetectionConfidence::Maybe => "maybe",
        DetectionConfidence::Likely => "likely",
    }
}

fn schema_value_type_name(value_type: SchemaValueType) -> &'static str {
    match value_type {
        SchemaValueType::String => "string",
        SchemaValueType::Integer => "integer",
        SchemaValueType::Boolean => "boolean",
        SchemaValueType::Number => "number",
        SchemaValueType::Object => "object",
        SchemaValueType::Array => "array",
        SchemaValueType::Null => "null",
        SchemaValueType::Any => "any",
    }
}

fn operation_name(operation: StructuredEditOperation) -> &'static str {
    match operation {
        StructuredEditOperation::ReplaceExistingValue => "replaceExistingValue",
    }
}
