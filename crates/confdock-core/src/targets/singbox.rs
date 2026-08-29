use crate::diagnostics::{ValidationLevel, ValidationResult};
use crate::document::ParsedDocument;
use crate::patch::{apply_span_patch, EditError, StructuredEdit};

use super::{
    AdapterCapabilities, ConfigAdapter, DetectionResult, ParseError, TargetDescriptor, TargetId,
};

pub struct SingBoxAdapter {
    descriptor: TargetDescriptor,
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
                    schema: true,
                    structured_edit: true,
                    validation_level: ValidationLevel::Static,
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

    fn detect(&self, source: &[u8]) -> DetectionResult {
        super::json::json_detection(source, self.descriptor.id.clone())
    }

    fn parse(&self, source: &[u8]) -> Result<ParsedDocument, ParseError> {
        super::json::parse_json_document(source, self.descriptor.id.clone())
    }

    fn validate(&self, source: &[u8]) -> ValidationResult {
        super::json::json_validation(source, self.descriptor.id.clone())
    }

    fn apply_edit(&self, source: &[u8], edit: StructuredEdit) -> Result<Vec<u8>, EditError> {
        let span = super::json::find_json_field(source, &edit.path, self.descriptor.id.clone())?;
        if !super::json::validate_json_literal(&edit.replacement) {
            return Err(EditError::UnsafeValue(
                "replacement must be one complete JSON literal".into(),
            ));
        }
        apply_span_patch(source, span, edit.replacement.as_bytes())
    }
}
