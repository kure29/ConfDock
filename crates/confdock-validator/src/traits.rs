use std::time::Duration;

use confdock_core::{Diagnostic, TargetId, ValidationLevel, ValidationResult};

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
    pub result: ValidationResult,
    pub validator_version: String,
    pub diagnostics: Vec<Diagnostic>,
}

impl NativeValidationResult {
    pub fn unavailable(context: &NativeValidationContext) -> Self {
        Self {
            result: ValidationResult::new(ValidationLevel::Static, Vec::new()),
            validator_version: context.validator_version.clone(),
            diagnostics: vec![Diagnostic::warning(
                "native.unavailable",
                "Native validation is not configured for this target.",
                None,
            )],
        }
    }
}

pub trait NativeValidator: Send + Sync {
    fn target(&self) -> &TargetId;
    fn validate(
        &self,
        source: &[u8],
        context: &NativeValidationContext,
    ) -> NativeValidationResult;
}
