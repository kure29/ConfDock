use confdock_core::{
    Diagnostic, DiagnosticSeverity, SourceSpan, ValidationLevel, ValidationResult,
};
use serde::{Deserialize, Serialize};
use time::{format_description::well_known::Rfc3339, OffsetDateTime};

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceSpanDto {
    pub start: usize,
    pub end: usize,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticDto {
    pub severity: String,
    pub code: String,
    pub message: String,
    pub span: Option<SourceSpanDto>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ValidationResultDto {
    pub level: String,
    pub diagnostics: Vec<DiagnosticDto>,
}

impl ValidationResultDto {
    pub fn from_core(result: &ValidationResult) -> Self {
        Self {
            level: validation_level_name(result.level).to_owned(),
            diagnostics: result.diagnostics.iter().map(diagnostic).collect(),
        }
    }

    pub fn has_code(&self, code: &str) -> bool {
        self.diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == code)
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AdminSessionDto {
    pub id: String,
    pub created_at: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSummaryDto {
    pub id: String,
    pub name: String,
    pub target_id: String,
    pub file_name: String,
    pub updated_at: String,
    pub byte_length: usize,
    pub last_validation: ValidationResultDto,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectDto {
    #[serde(flatten)]
    pub summary: ProjectSummaryDto,
    pub source: String,
    pub current_revision_id: String,
    pub served_revision_id: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveResultDto {
    pub project: ProjectDto,
    pub validation: ValidationResultDto,
    pub unchanged: bool,
}

/// Metadata for one immutable revision. Source bytes stay out of the history
/// list so opening a project does not duplicate every stored document over
/// the management API.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RevisionSummaryDto {
    pub id: String,
    pub revision_no: i64,
    pub parent_revision_id: Option<String>,
    pub created_at: String,
    pub byte_length: usize,
    pub content_hash: String,
    pub validation: ValidationResultDto,
    pub validator_version: Option<String>,
    pub is_current: bool,
    pub is_served: bool,
}

/// One immutable revision with its original bytes, returned only when the
/// authenticated administrator explicitly opens that history entry.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RevisionDto {
    #[serde(flatten)]
    pub summary: RevisionSummaryDto,
    pub source: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccessTokenDto {
    pub id: String,
    pub prefix: String,
    pub suffix: String,
    pub created_at: String,
    pub last_used_at: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatedAccessTokenDto {
    pub token: AccessTokenDto,
    pub plaintext: String,
    pub url: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceInfoDto {
    pub version: String,
    pub core: String,
    pub api: String,
    pub subscription_base: String,
}

#[derive(Debug, Deserialize)]
pub struct SignInRequest {
    pub password: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangePasswordRequest {
    pub current_password: String,
    pub next_password: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateProjectRequest {
    pub name: String,
    pub target_id: String,
    pub file_name: String,
    pub source: String,
}

#[derive(Debug, Deserialize)]
pub struct RenameProjectRequest {
    pub name: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveRevisionRequest {
    pub source: String,
    pub expected_revision_id: String,
}

pub fn timestamp_to_iso(timestamp: i64) -> Option<String> {
    OffsetDateTime::from_unix_timestamp(timestamp)
        .ok()?
        .format(&Rfc3339)
        .ok()
}

pub fn validation_level_name(level: ValidationLevel) -> &'static str {
    match level {
        ValidationLevel::Basic => "basic",
        ValidationLevel::Syntax => "syntax",
        ValidationLevel::Static => "static",
        ValidationLevel::Native => "native",
    }
}

fn diagnostic(value: &Diagnostic) -> DiagnosticDto {
    DiagnosticDto {
        severity: match value.severity {
            DiagnosticSeverity::Info => "info",
            DiagnosticSeverity::Warning => "warning",
            DiagnosticSeverity::Error => "error",
        }
        .to_owned(),
        code: value.code.clone(),
        message: value.message.clone(),
        span: value.span.map(source_span),
    }
}

fn source_span(value: SourceSpan) -> SourceSpanDto {
    SourceSpanDto {
        start: value.start,
        end: value.end,
    }
}

#[cfg(test)]
mod tests {
    use confdock_core::{Diagnostic, SourceSpan, ValidationLevel, ValidationResult};

    use super::*;

    #[test]
    fn validation_mapping_is_explicit_and_camel_case_ready() {
        let result = ValidationResult::new(
            ValidationLevel::Static,
            vec![Diagnostic::error(
                "test.code",
                "safe detail",
                Some(SourceSpan::new(3, 7)),
            )],
        );
        let dto = ValidationResultDto::from_core(&result);
        assert_eq!(dto.level, "static");
        assert_eq!(dto.diagnostics[0].severity, "error");
        assert_eq!(
            dto.diagnostics[0].span,
            Some(SourceSpanDto { start: 3, end: 7 })
        );
        assert_eq!(
            serde_json::to_value(dto).unwrap()["diagnostics"][0]["span"]["start"],
            3
        );
    }
}
