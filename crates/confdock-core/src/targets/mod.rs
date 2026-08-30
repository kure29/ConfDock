mod common;
mod json;
pub mod loon;
pub mod mihomo;
pub mod quantumult_x;
pub mod shadowrocket;
pub mod singbox;
pub mod surge;

use std::fmt;

use crate::diagnostics::{Diagnostic, ValidationResult};
use crate::document::ParsedDocument;
use crate::patch::{EditError, StructuredEdit};
use crate::path::ConfigPath;
use crate::schema::{SchemaValueType, TargetSchema};

#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct TargetId(String);

impl TargetId {
    pub const MIHOMO: &str = "mihomo";
    pub const SING_BOX: &str = "sing-box";
    pub const SURGE: &str = "surge";
    pub const LOON: &str = "loon";
    pub const QUANTUMULT_X: &str = "quantumult-x";
    pub const SHADOWROCKET: &str = "shadowrocket";

    pub fn new(value: impl Into<String>) -> Result<Self, TargetIdError> {
        let value = value.into();
        if value.is_empty()
            || !value.bytes().all(|byte| {
                byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-' || byte == b'_'
            })
        {
            return Err(TargetIdError(value));
        }
        Ok(Self(value))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    pub fn mihomo() -> Self {
        Self::new(Self::MIHOMO).expect("built-in target id")
    }

    pub fn sing_box() -> Self {
        Self::new(Self::SING_BOX).expect("built-in target id")
    }

    pub fn surge() -> Self {
        Self::new(Self::SURGE).expect("built-in target id")
    }

    pub fn loon() -> Self {
        Self::new(Self::LOON).expect("built-in target id")
    }

    pub fn quantumult_x() -> Self {
        Self::new(Self::QUANTUMULT_X).expect("built-in target id")
    }

    pub fn shadowrocket() -> Self {
        Self::new(Self::SHADOWROCKET).expect("built-in target id")
    }
}

impl TryFrom<&str> for TargetId {
    type Error = TargetIdError;

    fn try_from(value: &str) -> Result<Self, Self::Error> {
        Self::new(value)
    }
}

impl std::str::FromStr for TargetId {
    type Err = TargetIdError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        Self::try_from(value)
    }
}

impl fmt::Display for TargetId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(f)
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TargetIdError(String);

impl fmt::Display for TargetIdError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "invalid target id: {}", self.0)
    }
}

impl std::error::Error for TargetIdError {}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DetectionConfidence {
    None,
    Maybe,
    Likely,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DetectionResult {
    pub target: TargetId,
    pub confidence: DetectionConfidence,
    pub diagnostics: Vec<Diagnostic>,
}

impl DetectionResult {
    pub fn none(target: TargetId) -> Self {
        Self {
            target,
            confidence: DetectionConfidence::None,
            diagnostics: Vec::new(),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AdapterCapabilities {
    pub raw_edit: bool,
    pub validation_level: crate::diagnostics::ValidationLevel,
    pub native_validation: bool,
    pub sections: Vec<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum StructuredEditScope {
    ExactPaths(Vec<ConfigPath>),
    ExistingJsonPointerValues,
    ExistingSectionKeys {
        sections: Vec<String>,
        case_sensitive: bool,
    },
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum StructuredEditOperation {
    ReplaceExistingValue,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StructuredEditCapability {
    pub scope: StructuredEditScope,
    pub operations: Vec<StructuredEditOperation>,
    pub value_types: Vec<SchemaValueType>,
    pub safety_notes: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TargetDescriptor {
    pub id: TargetId,
    pub display_name: String,
    pub file_extensions: Vec<String>,
    pub capabilities: AdapterCapabilities,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ParseError {
    pub diagnostics: Vec<Diagnostic>,
}

impl ParseError {
    pub fn new(diagnostics: Vec<Diagnostic>) -> Self {
        Self { diagnostics }
    }
}

impl fmt::Display for ParseError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        if let Some(diagnostic) = self.diagnostics.first() {
            write!(f, "{}: {}", diagnostic.code, diagnostic.message)
        } else {
            write!(f, "configuration parse failed")
        }
    }
}

impl std::error::Error for ParseError {}

pub trait ConfigAdapter: Send + Sync {
    fn descriptor(&self) -> &TargetDescriptor;
    fn schema(&self) -> Option<&TargetSchema>;
    fn structured_edit_capabilities(&self) -> &[StructuredEditCapability];
    fn detect(&self, source: &[u8]) -> DetectionResult;
    fn parse(&self, source: &[u8]) -> Result<ParsedDocument, ParseError>;
    fn validate(&self, source: &[u8]) -> ValidationResult;
    fn apply_edit(&self, source: &[u8], edit: StructuredEdit) -> Result<Vec<u8>, EditError>;
}

pub struct TargetRegistry {
    adapters: Vec<Box<dyn ConfigAdapter>>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RegistryError {
    DuplicateTarget(TargetId),
}

impl fmt::Display for RegistryError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::DuplicateTarget(id) => write!(formatter, "target is already registered: {id}"),
        }
    }
}

impl std::error::Error for RegistryError {}

impl Default for TargetRegistry {
    fn default() -> Self {
        Self::builtin()
    }
}

impl TargetRegistry {
    pub fn builtin() -> Self {
        let mut registry = Self {
            adapters: Vec::new(),
        };
        registry
            .register(mihomo::MihomoAdapter::new())
            .expect("unique built-in target");
        registry
            .register(singbox::SingBoxAdapter::new())
            .expect("unique built-in target");
        registry
            .register(surge::SurgeAdapter::new())
            .expect("unique built-in target");
        registry
            .register(loon::LoonAdapter::new())
            .expect("unique built-in target");
        registry
            .register(quantumult_x::QuantumultXAdapter::new())
            .expect("unique built-in target");
        registry
            .register(shadowrocket::ShadowrocketAdapter::new())
            .expect("unique built-in target");
        registry
    }

    pub fn adapters(&self) -> &[Box<dyn ConfigAdapter>] {
        &self.adapters
    }

    pub fn register<A>(&mut self, adapter: A) -> Result<(), RegistryError>
    where
        A: ConfigAdapter + 'static,
    {
        let id = adapter.descriptor().id.clone();
        if self.get(&id).is_some() {
            return Err(RegistryError::DuplicateTarget(id));
        }
        self.adapters.push(Box::new(adapter));
        Ok(())
    }

    pub fn get(&self, id: &TargetId) -> Option<&dyn ConfigAdapter> {
        self.adapters
            .iter()
            .find(|adapter| &adapter.descriptor().id == id)
            .map(|adapter| adapter.as_ref())
    }

    pub fn get_str(&self, id: &str) -> Option<&dyn ConfigAdapter> {
        self.adapters
            .iter()
            .find(|adapter| adapter.descriptor().id.as_str() == id)
            .map(|adapter| adapter.as_ref())
    }
}
