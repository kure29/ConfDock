use crate::diagnostics::{ValidationLevel, ValidationResult};
use crate::document::ParsedDocument;
use crate::patch::{apply_span_patch, EditError, StructuredEdit};
use crate::path::ConfigPath;
use crate::schema::{SchemaField, SchemaValueType, TargetSchema};

use super::{
    AdapterCapabilities, ConfigAdapter, DetectionResult, ParseError, StructuredEditCapability,
    StructuredEditOperation, StructuredEditScope, TargetDescriptor, TargetId,
};

pub struct SingBoxAdapter {
    descriptor: TargetDescriptor,
    schema: TargetSchema,
    structured_edits: Vec<StructuredEditCapability>,
}

impl SingBoxAdapter {
    pub fn new() -> Self {
        Self {
            descriptor: TargetDescriptor {
                id: TargetId::new(TargetId::SING_BOX).expect("built-in target id"),
                display_name: "sing-box".into(),
                file_extensions: vec!["json".into()],
                capabilities: AdapterCapabilities {
                    raw_edit: true,
                    validation_level: ValidationLevel::Syntax,
                    native_validation: false,
                    sections: vec![
                        "log".into(),
                        "dns".into(),
                        "inbounds".into(),
                        "outbounds".into(),
                        "route".into(),
                    ],
                },
            },
            schema: TargetSchema::new(vec![SchemaField {
                path: ConfigPath::new("/log/level").expect("static path"),
                value_type: SchemaValueType::String,
                description: "sing-box log level.".into(),
            }]),
            structured_edits: vec![StructuredEditCapability {
                scope: StructuredEditScope::ExistingJsonPointerValues,
                operations: vec![StructuredEditOperation::ReplaceExistingValue],
                value_types: vec![
                    SchemaValueType::String,
                    SchemaValueType::Integer,
                    SchemaValueType::Boolean,
                    SchemaValueType::Number,
                    SchemaValueType::Object,
                    SchemaValueType::Array,
                    SchemaValueType::Null,
                ],
                safety_notes: "Only an existing, unique RFC 6901 value span is replaced.".into(),
            }],
        }
    }
}

impl Default for SingBoxAdapter {
    fn default() -> Self {
        Self::new()
    }
}

impl ConfigAdapter for SingBoxAdapter {
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
        super::json::json_detection(source, self.descriptor.id.clone())
    }

    fn parse(&self, source: &[u8]) -> Result<ParsedDocument, ParseError> {
        super::json::parse_json_document(source, self.descriptor.id.clone())
    }

    fn validate(&self, source: &[u8]) -> ValidationResult {
        match self.parse(source) {
            Ok(_) => ValidationResult::valid(ValidationLevel::Syntax),
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
                ValidationResult::new(level, error.diagnostics)
            }
        }
    }

    fn apply_edit(&self, source: &[u8], edit: StructuredEdit) -> Result<Vec<u8>, EditError> {
        let span = super::json::find_json_field(source, &edit.path, self.descriptor.id.clone())?;
        if !super::json::validate_json_literal(&edit.replacement) {
            return Err(EditError::UnsafeValue(
                "replacement must be one strict JSON value".into(),
            ));
        }
        apply_span_patch(source, span, edit.replacement.as_bytes())
    }
}
