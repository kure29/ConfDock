use crate::document::SourceSpan;

/// Severity is intentionally small and stable so it can be serialized by a
/// future API without coupling the core to a web framework.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Ord, PartialOrd)]
pub enum DiagnosticSeverity {
    Info,
    Warning,
    Error,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Diagnostic {
    pub severity: DiagnosticSeverity,
    pub code: String,
    pub message: String,
    pub span: Option<SourceSpan>,
}

impl Diagnostic {
    pub fn new(
        severity: DiagnosticSeverity,
        code: impl Into<String>,
        message: impl Into<String>,
        span: Option<SourceSpan>,
    ) -> Self {
        Self {
            severity,
            code: code.into(),
            message: message.into(),
            span,
        }
    }

    pub fn error(
        code: impl Into<String>,
        message: impl Into<String>,
        span: Option<SourceSpan>,
    ) -> Self {
        Self::new(DiagnosticSeverity::Error, code, message, span)
    }

    pub fn warning(
        code: impl Into<String>,
        message: impl Into<String>,
        span: Option<SourceSpan>,
    ) -> Self {
        Self::new(DiagnosticSeverity::Warning, code, message, span)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Ord, PartialOrd)]
pub enum ValidationLevel {
    /// Encoding and only the most conservative structural checks were run.
    Basic,
    /// A real parser accepted the target format and required root structure.
    Syntax,
    /// Target-specific static/schema checks were run.
    Static,
    /// An external, pinned native validator also accepted the document.
    Native,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ValidationResult {
    pub level: ValidationLevel,
    pub diagnostics: Vec<Diagnostic>,
}

impl ValidationResult {
    pub fn new(level: ValidationLevel, diagnostics: Vec<Diagnostic>) -> Self {
        Self { level, diagnostics }
    }

    pub fn valid(level: ValidationLevel) -> Self {
        Self::new(level, Vec::new())
    }

    pub fn is_valid(&self) -> bool {
        !self
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.severity == DiagnosticSeverity::Error)
    }
}
