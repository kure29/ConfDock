use crate::diagnostics::{ValidationLevel, ValidationResult};
use crate::document::ParsedDocument;
use crate::patch::{EditError, StructuredEdit};

use super::common::{parse_ini_like, text_detection, value_edit, IniParseOptions};
use super::{
    AdapterCapabilities, ConfigAdapter, DetectionResult, ParseError, TargetDescriptor, TargetId,
};

pub struct ShadowrocketAdapter {
    descriptor: TargetDescriptor,
}

impl ShadowrocketAdapter {
    pub fn new() -> Self {
        Self {
            descriptor: TargetDescriptor {
                id: TargetId::new(TargetId::SHADOWROCKET).expect("built-in target id"),
                display_name: "Shadowrocket".into(),
                file_extensions: vec!["conf".into()],
                capabilities: AdapterCapabilities {
                    raw_edit: true,
                    schema: false,
                    structured_edit: true,
                    validation_level: ValidationLevel::Static,
                    native_validation: false,
                    sections: vec![
                        "General".into(),
                        "Proxy".into(),
                        "Proxy Group".into(),
                        "Rule".into(),
                    ],
                },
            },
        }
    }
}

impl Default for ShadowrocketAdapter {
    fn default() -> Self {
        Self::new()
    }
}

fn options(id: TargetId) -> IniParseOptions {
    IniParseOptions {
        target: id,
        allow_bare_rules: true,
    }
}

impl ConfigAdapter for ShadowrocketAdapter {
    fn descriptor(&self) -> &TargetDescriptor {
        &self.descriptor
    }

    fn detect(&self, source: &[u8]) -> DetectionResult {
        text_detection(source, self.descriptor.id.clone(), "[General]")
    }

    fn parse(&self, source: &[u8]) -> Result<ParsedDocument, ParseError> {
        parse_ini_like(source, options(self.descriptor.id.clone()))
    }

    fn validate(&self, source: &[u8]) -> ValidationResult {
        match self.parse(source) {
            Ok(_) => ValidationResult::valid(ValidationLevel::Static),
            Err(error) => ValidationResult::new(ValidationLevel::ParseOnly, error.diagnostics),
        }
    }

    fn apply_edit(&self, source: &[u8], edit: StructuredEdit) -> Result<Vec<u8>, EditError> {
        value_edit(
            source,
            edit,
            options(self.descriptor.id.clone()),
            |value| {
                !value.contains('\r') && !value.contains('\n') && !value.trim().is_empty()
            },
        )
    }
}
