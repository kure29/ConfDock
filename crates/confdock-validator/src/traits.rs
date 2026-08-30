use std::time::Duration;

use confdock_core::{Diagnostic, TargetId, ValidationResult};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NativeValidationContext {
    pub target: TargetId,
    pub validator_version: String,
    pub timeout: Duration,
    pub max_output_bytes: usize,
}

impl NativeValidationContext {
    pub fn mihomo(version: impl Into<String>) -> Self {
        Self {
            target: TargetId::new(TargetId::MIHOMO).expect("built-in target id"),
            validator_version: version.into(),
            timeout: Duration::from_secs(10),
            max_output_bytes: 64 * 1024,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NativeValidationResult {
    pub status: NativeValidationStatus,
    pub result: ValidationResult,
    pub validator_version: Option<String>,
}

impl NativeValidationResult {
    pub fn unavailable(mut result: ValidationResult) -> Self {
        result.diagnostics.push(Diagnostic::warning(
            "native.unavailable",
            "Native validation was not executed.",
            None,
        ));
        Self {
            status: NativeValidationStatus::Unavailable,
            result,
            validator_version: None,
        }
    }

    pub fn completed(mut result: ValidationResult, validator_version: impl Into<String>) -> Self {
        result.level = confdock_core::ValidationLevel::Native;
        Self {
            status: NativeValidationStatus::Completed,
            result,
            validator_version: Some(validator_version.into()),
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum NativeValidationStatus {
    Completed,
    Unavailable,
}

pub trait NativeValidator: Send + Sync {
    fn target(&self) -> &TargetId;
    fn validate(&self, source: &[u8], context: &NativeValidationContext) -> NativeValidationResult;
}

#[cfg(test)]
mod tests {
    use confdock_core::{DiagnosticSeverity, ValidationLevel, ValidationResult};

    use super::{NativeValidationResult, NativeValidationStatus};

    #[test]
    fn unavailable_uses_the_unified_diagnostic_collection() {
        let result =
            NativeValidationResult::unavailable(ValidationResult::valid(ValidationLevel::Static));
        assert_eq!(result.status, NativeValidationStatus::Unavailable);
        assert_eq!(result.result.level, ValidationLevel::Static);
        assert_eq!(result.validator_version, None);
        assert_eq!(result.result.diagnostics.len(), 1);
        assert_eq!(result.result.diagnostics[0].code, "native.unavailable");
        assert_eq!(
            result.result.diagnostics[0].severity,
            DiagnosticSeverity::Warning
        );
    }

    #[test]
    fn completed_records_native_level_and_version() {
        let result = NativeValidationResult::completed(
            ValidationResult::valid(ValidationLevel::Static),
            "1.2.3",
        );
        assert_eq!(result.status, NativeValidationStatus::Completed);
        assert_eq!(result.result.level, ValidationLevel::Native);
        assert_eq!(result.validator_version.as_deref(), Some("1.2.3"));
    }
}
