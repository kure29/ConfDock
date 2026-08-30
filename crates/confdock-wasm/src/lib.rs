mod dto;

use confdock_core::{
    ConfigPath, Diagnostic, StructuredEdit, TargetRegistry, ValidationLevel, ValidationResult,
};
use wasm_bindgen::prelude::*;

fn serialize<T: serde::Serialize>(value: &T) -> Result<JsValue, JsValue> {
    // Keep byte buffers as Uint8Array while making Rust `Option::None` map to
    // JavaScript `null` (the TypeScript wire shape uses null, not undefined).
    let serializer = serde_wasm_bindgen::Serializer::new().serialize_missing_as_null(true);
    value
        .serialize(&serializer)
        .map_err(|error| JsValue::from_str(&format!("failed to serialize WASM DTO: {error}")))
}

fn unknown_target(value: &str) -> Diagnostic {
    Diagnostic::error(
        "target.unknown",
        format!("unknown target id: {value}"),
        None,
    )
}

fn edit_error_result<T>(detail: impl Into<String>) -> dto::ResultDto<T, dto::EditErrorDto> {
    dto::result_err(dto::EditErrorDto {
        kind: "unsupportedEdit",
        detail: detail.into(),
    })
}

#[wasm_bindgen]
pub struct WasmConfigCore {
    registry: TargetRegistry,
}

#[wasm_bindgen]
impl WasmConfigCore {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        Self {
            registry: TargetRegistry::builtin(),
        }
    }

    pub fn targets(&self) -> Result<JsValue, JsValue> {
        let targets = self
            .registry
            .adapters()
            .iter()
            .map(|adapter| dto::descriptor(adapter.descriptor()))
            .collect::<Vec<_>>();
        serialize(&targets)
    }

    pub fn descriptor(&self, id: &str) -> Result<JsValue, JsValue> {
        match self.registry.get_str(id) {
            Some(adapter) => serialize(&dto::descriptor(adapter.descriptor())),
            None => Ok(JsValue::NULL),
        }
    }

    pub fn schema(&self, id: &str) -> Result<JsValue, JsValue> {
        match self
            .registry
            .get_str(id)
            .and_then(|adapter| adapter.schema())
        {
            Some(schema) => serialize(&dto::schema(schema)),
            None => Ok(JsValue::NULL),
        }
    }

    #[wasm_bindgen(js_name = editCapabilities)]
    pub fn edit_capabilities(&self, id: &str) -> Result<JsValue, JsValue> {
        let capabilities = self
            .registry
            .get_str(id)
            .map(|adapter| {
                adapter
                    .structured_edit_capabilities()
                    .iter()
                    .map(dto::edit_capability)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        serialize(&capabilities)
    }

    pub fn detect(&self, source: &[u8]) -> Result<JsValue, JsValue> {
        let detections = self
            .registry
            .adapters()
            .iter()
            .map(|adapter| dto::detection(adapter.detect(source)))
            .collect::<Vec<_>>();
        serialize(&detections)
    }

    pub fn validate(&self, id: &str, source: &[u8]) -> Result<JsValue, JsValue> {
        let result = match self.registry.get_str(id) {
            Some(adapter) => dto::validation(adapter.validate(source)),
            None => dto::validation(ValidationResult::new(
                ValidationLevel::Basic,
                vec![unknown_target(id)],
            )),
        };
        serialize(&result)
    }

    pub fn parse(&self, id: &str, source: &[u8]) -> Result<JsValue, JsValue> {
        let result = match self.registry.get_str(id) {
            Some(adapter) => match adapter.parse(source) {
                Ok(parsed) => dto::result_ok(dto::parsed(parsed)),
                Err(error) => dto::result_err(dto::parse_error(error)),
            },
            None => dto::result_err(dto::ParseErrorDto {
                diagnostics: vec![dto::diagnostic(unknown_target(id))],
            }),
        };
        serialize(&result)
    }

    #[wasm_bindgen(js_name = applyEdit)]
    pub fn apply_edit(
        &self,
        id: &str,
        source: &[u8],
        path: &str,
        replacement: &str,
    ) -> Result<JsValue, JsValue> {
        let Some(adapter) = self.registry.get_str(id) else {
            return serialize(&edit_error_result::<Vec<u8>>(format!(
                "unknown target id: {id}"
            )));
        };
        let path = match ConfigPath::new(path) {
            Ok(path) => path,
            Err(error) => {
                return serialize(&edit_error_result::<Vec<u8>>(format!(
                    "invalid structured edit path: {error}"
                )))
            }
        };
        let edit = StructuredEdit::new(path, replacement);
        let result = match adapter.apply_edit(source, edit) {
            Ok(bytes) => dto::result_ok(bytes),
            Err(error) => dto::result_err(dto::edit_error(error)),
        };
        serialize(&result)
    }

    #[wasm_bindgen(js_name = documentInfo)]
    pub fn document_info(&self, source: &[u8]) -> Result<JsValue, JsValue> {
        serialize(&dto::native_document_info(source))
    }
}

impl Default for WasmConfigCore {
    fn default() -> Self {
        Self::new()
    }
}
