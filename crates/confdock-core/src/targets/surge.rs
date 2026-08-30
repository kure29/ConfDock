use crate::diagnostics::{ValidationLevel, ValidationResult};
use crate::document::ParsedDocument;
use crate::patch::{EditError, StructuredEdit};
use crate::schema::{SchemaValueType, TargetSchema};

use super::common::{parse_ini_like, text_detection, value_edit, IniParseOptions};
use super::{
    AdapterCapabilities, ConfigAdapter, DetectionResult, ParseError, StructuredEditCapability,
    StructuredEditOperation, StructuredEditScope, TargetDescriptor, TargetId,
};

pub struct SurgeAdapter {
    descriptor: TargetDescriptor,
    structured_edits: Vec<StructuredEditCapability>,
}

impl SurgeAdapter {
    pub fn new() -> Self {
        Self {
            descriptor: TargetDescriptor {
                id: TargetId::new(TargetId::SURGE).expect("built-in target id"),
                display_name: "Surge".into(),
                file_extensions: vec!["conf".into()],
                capabilities: AdapterCapabilities {
                    raw_edit: true,
                    validation_level: ValidationLevel::Basic,
                    native_validation: false,
                    sections: vec![
                        "General".into(),
                        "Proxy".into(),
                        "Proxy Group".into(),
                        "Rule".into(),
                        "Script".into(),
                        "URL Rewrite".into(),
                    ],
                },
            },
            structured_edits: general_section_capability("General"),
        }
    }
}

impl Default for SurgeAdapter {
    fn default() -> Self {
        Self::new()
    }
}

fn options(id: TargetId) -> IniParseOptions {
    IniParseOptions {
        target: id,
        editable_sections: &["General"],
        case_sensitive_sections: true,
    }
}

fn general_section_capability(section: &str) -> Vec<StructuredEditCapability> {
    vec![StructuredEditCapability {
        scope: StructuredEditScope::ExistingSectionKeys {
            sections: vec![section.into()],
            case_sensitive: true,
        },
        operations: vec![StructuredEditOperation::ReplaceExistingValue],
        value_types: vec![SchemaValueType::String],
        safety_notes: "Only unique existing General keys without inline comments are patchable."
            .into(),
    }]
}

impl ConfigAdapter for SurgeAdapter {
    fn descriptor(&self) -> &TargetDescriptor {
        &self.descriptor
    }

    fn schema(&self) -> Option<&TargetSchema> {
        None
    }

    fn structured_edit_capabilities(&self) -> &[StructuredEditCapability] {
        &self.structured_edits
    }

    fn detect(&self, source: &[u8]) -> DetectionResult {
        text_detection(source, self.descriptor.id.clone(), "[General]")
    }

    fn parse(&self, source: &[u8]) -> Result<ParsedDocument, ParseError> {
        parse_ini_like(source, options(self.descriptor.id.clone())).map(|parsed| parsed.parsed)
    }

    fn validate(&self, source: &[u8]) -> ValidationResult {
        match self.parse(source) {
            Ok(_) => ValidationResult::valid(ValidationLevel::Basic),
            Err(error) => ValidationResult::new(ValidationLevel::Basic, error.diagnostics),
        }
    }

    fn apply_edit(&self, source: &[u8], edit: StructuredEdit) -> Result<Vec<u8>, EditError> {
        value_edit(source, edit, options(self.descriptor.id.clone()))
    }
}
