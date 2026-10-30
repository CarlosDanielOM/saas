//! Conversion between JSON values and BSON. JSON strings convert to BSON with
//! UTF-16 loss, and numbers follow JavaScript number semantics.
use crate::utils::{bson_compat, js_string::JsString, lossless_json::JsonValue};
use mongodb::bson::{Bson, Document};

pub fn json_bson(value: &JsonValue) -> Bson {
    match value {
        JsonValue::Null => Bson::Null,
        JsonValue::Bool(v) => Bson::Boolean(*v),
        JsonValue::Number(v) => bson_compat::js_number(*v),
        JsonValue::String(v) => Bson::String(v.to_utf8_lossy()),
        JsonValue::Array(values) => Bson::Array(values.iter().map(json_bson).collect()),
        JsonValue::Object(fields) => {
            let mut d = Document::new();
            for (k, v) in fields {
                d.insert(k.to_utf8_lossy(), json_bson(v));
            }
            Bson::Document(d)
        }
    }
}

/// Lossy compiler projection only. Non-JSON BSON values project as empty
/// objects, including nested values; do not use this view as authoritative data
/// or for business fields requiring those BSON types. Retain the original BSON
/// and patch only compiler-owned fields back into it.
pub fn compiler_bson_json(value: &Bson) -> JsonValue {
    match value {
        Bson::Null => JsonValue::Null,
        Bson::Boolean(v) => JsonValue::Bool(*v),
        Bson::Int32(v) => JsonValue::Number(f64::from(*v)),
        Bson::Int64(v) => JsonValue::Number(*v as f64),
        Bson::Double(v) => JsonValue::Number(*v),
        Bson::String(v) => JsonValue::String(v.as_str().into()),
        Bson::Array(items) => JsonValue::Array(items.iter().map(compiler_bson_json).collect()),
        Bson::Document(fields) => JsonValue::Object(
            fields
                .iter()
                .map(|(k, v)| (JsString::from(k.as_str()), compiler_bson_json(v)))
                .collect(),
        ),
        _ => JsonValue::Object(Vec::new()),
    }
}
