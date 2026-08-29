//! Optional target schema metadata. Schemas describe editable paths but never
//! replace the native document or dictate full-file serialization.

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum SchemaValueType {
    String,
    Integer,
    Boolean,
    Number,
    Object,
    Array,
    Any,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SchemaField {
    pub path: String,
    pub value_type: SchemaValueType,
    pub description: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Default)]
pub struct TargetSchema {
    pub fields: Vec<SchemaField>,
}

impl TargetSchema {
    pub fn new(fields: Vec<SchemaField>) -> Self {
        Self { fields }
    }

    pub fn field(&self, path: &str) -> Option<&SchemaField> {
        self.fields.iter().find(|field| field.path == path)
    }
}
