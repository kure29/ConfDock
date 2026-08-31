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
    pub has_unpublished_changes: bool,
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

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishResultDto {
    pub project: ProjectDto,
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

/// One bounded page of immutable revision metadata. The cursor is the ID of
/// the last item in this page and is only meaningful for the same project.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RevisionPageDto {
    pub items: Vec<RevisionSummaryDto>,
    pub next_cursor: Option<String>,
}

/// The line-ending vocabulary used by the read-only revision diff.  A
/// document-level value may be `mixed`; individual diff lines only ever use
/// `none`, `lf`, or `crlf`.
#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum RevisionDiffLineEnding {
    None,
    Lf,
    CrLf,
    Mixed,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum RevisionDiffLineKind {
    Context,
    Delete,
    Insert,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RevisionDiffLineDto {
    pub kind: RevisionDiffLineKind,
    pub old_line_no: Option<usize>,
    pub new_line_no: Option<usize>,
    /// Text without the line-ending bytes.  Whitespace is intentionally kept.
    pub text: String,
    pub line_ending: RevisionDiffLineEnding,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RevisionDiffHunkDto {
    pub old_start: usize,
    pub old_count: usize,
    pub new_start: usize,
    pub new_count: usize,
    pub lines: Vec<RevisionDiffLineDto>,
}

/// Metadata for one side of a diff.  The regular revision summary is
/// flattened so validation and parent information remain available without
/// returning the source BLOB.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RevisionDiffDocumentDto {
    #[serde(flatten)]
    pub summary: RevisionSummaryDto,
    pub has_utf8_bom: bool,
    pub line_ending: RevisionDiffLineEnding,
    pub trailing_newline: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RevisionDiffDto {
    pub from: RevisionDiffDocumentDto,
    pub to: RevisionDiffDocumentDto,
    pub identical: bool,
    pub additions: usize,
    pub deletions: usize,
    pub hunks: Vec<RevisionDiffHunkDto>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccessTokenDto {
    pub id: String,
    pub display_name: String,
    pub prefix: String,
    pub suffix: String,
    pub created_at: String,
    pub last_used_at: Option<String>,
    pub expires_at: Option<String>,
    pub revoked_at: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatedAccessTokenDto {
    pub token: AccessTokenDto,
    pub plaintext: String,
    pub url: String,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateAccessTokenRequest {
    pub display_name: Option<String>,
    pub expires_at: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateAccessTokenRequest {
    pub display_name: String,
    pub expires_at: Option<String>,
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

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishProjectRequest {
    pub expected_current_revision_id: String,
    pub expected_served_revision_id: String,
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
