//! JSON.stringify view of values produced by the default Node MongoDB BSON reader.
//!
//! This is not a BSON storage conversion. Keep the original BSON for writes.
//! Unsupported reader cases fail explicitly; see the handoff for the boundary.
use crate::utils::{
    credit_policy::JsDate,
    js_string::{JsString, write_json_utf8},
    json_number::number_string,
    lossless_json::{JsonValue, array_index_str},
};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use mongodb::bson::{Bson, Document};
use std::fmt;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BsonJsJsonError(pub &'static str);
impl fmt::Display for BsonJsJsonError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.0)
    }
}
impl std::error::Error for BsonJsJsonError {}

fn string(s: impl Into<JsString>) -> JsonValue {
    JsonValue::String(s.into())
}
fn object(fields: Vec<(&str, JsonValue)>) -> JsonValue {
    JsonValue::Object(fields.into_iter().map(|(k, v)| (k.into(), v)).collect())
}

/// Project a single BSON value. A root undefined has no JSON.stringify result
/// and returns an error; nested document and array undefined follow JS rules.
pub fn bson_js_json(value: &Bson) -> Result<JsonValue, BsonJsJsonError> {
    project(value)
}

/// Write the same JSON.stringify view without building an owned JSON tree for
/// ordinary BSON values. The original BSON remains available for storage.
pub fn bson_js_json_string(value: &Bson) -> Result<String, BsonJsJsonError> {
    let mut out = String::new();
    append_bson_js_json(value, &mut out)?;
    Ok(out)
}

/// Append a complete wire value, leaving `out` unchanged on projection error.
pub fn append_bson_js_json(value: &Bson, out: &mut String) -> Result<(), BsonJsJsonError> {
    let original_len = out.len();
    if let Err(error) = write_bson(value, out) {
        out.truncate(original_len);
        return Err(error);
    }
    Ok(())
}

fn write_bson(value: &Bson, out: &mut String) -> Result<(), BsonJsJsonError> {
    match value {
        Bson::Null => out.push_str("null"),
        Bson::Boolean(v) => out.push_str(if *v { "true" } else { "false" }),
        Bson::Int32(v) => out.push_str(&number_string(f64::from(*v))),
        Bson::Int64(v) if (-9_007_199_254_740_992..=9_007_199_254_740_992).contains(v) => {
            out.push_str(&number_string(*v as f64));
        }
        Bson::Double(v) => {
            if v.is_finite() {
                out.push_str(&number_string(*v));
            } else {
                out.push_str("null");
            }
        }
        Bson::String(v) | Bson::Symbol(v) => write_json_utf8(v, out),
        Bson::Array(values) => {
            out.push('[');
            for (index, value) in values.iter().enumerate() {
                if index != 0 {
                    out.push(',');
                }
                if matches!(value, Bson::Undefined) {
                    out.push_str("null");
                } else {
                    write_bson(value, out)?;
                }
            }
            out.push(']');
        }
        Bson::Document(values) if !dbref_like(values) => {
            out.push('{');
            // Stable sort is needed only for canonical JS array-index keys.
            // Undefined document properties are omitted before enumeration.
            let entries = values.iter().filter(|(_, v)| !matches!(v, Bson::Undefined));
            if values.keys().any(|key| array_index_str(key).is_some()) {
                let mut ordered: Vec<_> = entries.collect();
                ordered.sort_by_key(|(key, _)| {
                    array_index_str(key).map_or((1, 0), |index| (0, index))
                });
                write_document_entries(ordered, out)?;
            } else {
                write_document_entries(entries, out)?;
            }
            out.push('}');
        }
        // Keep DBRef copying, special BSON representations and their errors in
        // the owned projector. Node's eager decoding and RegExp validation are
        // still reader boundaries, not checks introduced by this serializer.
        _ => project(value)?.write_json_string(out),
    }
    Ok(())
}

fn write_document_entries<'a>(
    entries: impl IntoIterator<Item = (&'a String, &'a Bson)>,
    out: &mut String,
) -> Result<(), BsonJsJsonError> {
    for (index, (key, value)) in entries.into_iter().enumerate() {
        if index != 0 {
            out.push(',');
        }
        write_json_utf8(key, out);
        out.push(':');
        write_bson(value, out)?;
    }
    Ok(())
}

fn project(value: &Bson) -> Result<JsonValue, BsonJsJsonError> {
    Ok(match value {
        Bson::Null => JsonValue::Null,
        Bson::Undefined => {
            return Err(BsonJsJsonError(
                "root BSON undefined has no JSON.stringify result",
            ));
        }
        Bson::Boolean(v) => JsonValue::Bool(*v),
        Bson::Int32(v) => JsonValue::Number(f64::from(*v)),
        Bson::Int64(v) if (-9_007_199_254_740_992..=9_007_199_254_740_992).contains(v) => {
            JsonValue::Number(*v as f64)
        }
        Bson::Int64(v) => object(vec![
            ("low", JsonValue::Number((*v as u32 as i32) as f64)),
            ("high", JsonValue::Number((*v >> 32) as i32 as f64)),
            ("unsigned", JsonValue::Bool(false)),
        ]),
        Bson::Double(v) => JsonValue::Number(*v),
        Bson::String(v) | Bson::Symbol(v) => string(v.as_str()),
        Bson::ObjectId(v) => string(v.to_hex()),
        Bson::DateTime(v) => match JsDate::from_millis(v.timestamp_millis() as f64).to_iso_string()
        {
            Ok(s) => string(s),
            Err(_) => JsonValue::Null,
        },
        Bson::Binary(v) => {
            if u8::from(v.subtype) == 4 && v.bytes.len() == 16 {
                let s: String = v.bytes.iter().map(|b| format!("{b:02x}")).collect();
                string(format!(
                    "{}-{}-{}-{}-{}",
                    &s[..8],
                    &s[8..12],
                    &s[12..16],
                    &s[16..20],
                    &s[20..]
                ))
            } else {
                string(STANDARD.encode(&v.bytes))
            }
        }
        Bson::Decimal128(v) => object(vec![("$numberDecimal", string(v.to_string()))]),
        Bson::Timestamp(v) => object(vec![(
            "$timestamp",
            string(((u64::from(v.time) << 32) | u64::from(v.increment)).to_string()),
        )]),
        Bson::MinKey | Bson::MaxKey => JsonValue::Object(Vec::new()),
        Bson::JavaScriptCode(code) => object(vec![("code", string(code.as_str()))]),
        Bson::JavaScriptCodeWithScope(code) => object(vec![
            ("code", string(code.code.as_str())),
            ("scope", document(&code.scope)?),
        ]),
        Bson::Array(values) => JsonValue::Array(
            values
                .iter()
                .map(|v| {
                    if matches!(v, Bson::Undefined) {
                        Ok(JsonValue::Null)
                    } else {
                        project(v)
                    }
                })
                .collect::<Result<_, _>>()?,
        ),
        Bson::Document(values) => document(values)?,
        // Only values accepted by the source reader belong to this projection.
        // The driver validates syntax/flags by constructing a JS RegExp; this
        // layer cannot reproduce that decoding check, but any successfully
        // constructed ordinary RegExp stringifies to an empty object.
        Bson::RegularExpression(_) => JsonValue::Object(Vec::new()),
        Bson::DbPointer(_) => {
            // bson 3 exposes DbPointer fields via its serde representation.
            // Decode this one known variant, not arbitrary Extended JSON.
            let encoded = serde_json::to_value(value)
                .map_err(|_| BsonJsJsonError("cannot extract BSON DBPointer"))?;
            let body = encoded
                .get("$dbPointer")
                .ok_or(BsonJsJsonError("invalid BSON DBPointer representation"))?;
            let namespace = body
                .get("$ref")
                .and_then(|v| v.as_str())
                .ok_or(BsonJsJsonError("invalid BSON DBPointer namespace"))?;
            let id = body
                .get("$id")
                .and_then(|v| v.get("$oid"))
                .and_then(|v| v.as_str())
                .ok_or(BsonJsJsonError("invalid BSON DBPointer object id"))?;
            let parts: Vec<_> = namespace.split('.').collect();
            let (collection, db) = if parts.len() == 2 {
                (parts[1], Some(parts[0]))
            } else {
                (namespace, None)
            };
            let mut fields = vec![("$ref", string(collection)), ("$id", string(id))];
            if let Some(db) = db {
                fields.push(("$db", string(db)));
            }
            object(fields)
        }
    })
}

// The driver's DBRef constructor receives a copy made with Object.assign.
// That copy may inherit from the decoded __proto__ value. These are the
// relevant inherited descriptors of the default SDK classes and JS RegExp.
#[derive(Clone, Copy)]
enum CopyPrototype {
    Plain,
    Bson,
    Long,
    Timestamp,
    Regex,
    ObjectId,
    Uuid,
    DbRef,
}

fn dbref_like(values: &Document) -> bool {
    let possible = values
        .keys()
        .filter(|k| k.starts_with('$'))
        .all(|k| matches!(k.as_str(), "$ref" | "$id" | "$db"));
    let reference = matches!(values.get("$ref"), Some(Bson::String(_) | Bson::Symbol(_)));
    let id = values
        .get("$id")
        .is_some_and(|v| !matches!(v, Bson::Null | Bson::Undefined));
    let db = values.get("$db");
    possible
        && reference
        && id
        && (db.is_none() || matches!(db, Some(Bson::String(_) | Bson::Symbol(_))))
}

fn copy_prototype(value: &Bson) -> CopyPrototype {
    match value {
        Bson::Int64(v) if !(-9_007_199_254_740_992..=9_007_199_254_740_992).contains(v) => {
            CopyPrototype::Long
        }
        Bson::Timestamp(_) => CopyPrototype::Timestamp,
        Bson::RegularExpression(_) => CopyPrototype::Regex,
        Bson::ObjectId(_) => CopyPrototype::ObjectId,
        Bson::Binary(v) if u8::from(v.subtype) == 4 && v.bytes.len() == 16 => CopyPrototype::Uuid,
        Bson::Document(v) if dbref_like(v) => CopyPrototype::DbRef,
        Bson::DbPointer(_) => CopyPrototype::DbRef,
        Bson::Binary(_)
        | Bson::Decimal128(_)
        | Bson::JavaScriptCode(_)
        | Bson::JavaScriptCodeWithScope(_)
        | Bson::MinKey
        | Bson::MaxKey => CopyPrototype::Bson,
        _ => CopyPrototype::Plain,
    }
}

fn readonly_copy_property(proto: CopyPrototype, key: &str) -> bool {
    match proto {
        CopyPrototype::Plain => false,
        CopyPrototype::Regex => matches!(
            key,
            "source"
                | "flags"
                | "hasIndices"
                | "global"
                | "ignoreCase"
                | "multiline"
                | "dotAll"
                | "unicode"
                | "unicodeSets"
                | "sticky"
        ),
        CopyPrototype::Long => matches!(key, "_bsontype" | "__isLong__"),
        CopyPrototype::Timestamp => matches!(key, "_bsontype" | "__isLong__" | "i" | "t"),
        _ => key == "_bsontype",
    }
}

fn copy_setter(proto: CopyPrototype, key: &str) -> Option<&'static str> {
    match (proto, key) {
        (CopyPrototype::ObjectId | CopyPrototype::Uuid, "id") => Some("buffer"),
        (CopyPrototype::DbRef, "namespace") => Some("collection"),
        _ => None,
    }
}

fn document(values: &Document) -> Result<JsonValue, BsonJsJsonError> {
    // The driver's DBRef recognition is disabled by any dollar-prefixed field
    // other than these three. Its toJSON moves $ref/$id first and $db last.
    if dbref_like(values) {
        let reference = match values.get("$ref").unwrap() {
            Bson::String(s) | Bson::Symbol(s) => s,
            _ => unreachable!(),
        };
        let id = values.get("$id").unwrap();
        let db = values.get("$db");
        let parts: Vec<_> = reference.split('.').collect();
        let (collection, derived_db) = if parts.len() == 2 {
            (parts[1], Some(parts[0]))
        } else {
            (reference.as_str(), None)
        };
        // Model Object.assign({}, decodedDocument), then its deletions of
        // $ref, $id and $db. Numeric indices enumerate first in JS, but none
        // are accessor names; the shared JSON writer orders them afterwards.
        let mut copy: Vec<(&str, &Bson)> = Vec::new();
        let mut proto = CopyPrototype::Plain;
        for (key, value) in values.iter() {
            if key == "__proto__" {
                proto = copy_prototype(value);
                continue;
            }
            if readonly_copy_property(proto, key) && !copy.iter().any(|(k, _)| *k == key.as_str()) {
                return Err(BsonJsJsonError(
                    "DBRef Object.assign encounters an inherited read-only property",
                ));
            }
            let destination = if copy.iter().any(|(k, _)| *k == key.as_str()) {
                key.as_str()
            } else {
                copy_setter(proto, key).unwrap_or(key.as_str())
            };
            if let Some((_, old)) = copy.iter_mut().find(|(k, _)| *k == destination) {
                *old = value;
            } else {
                copy.push((destination, value));
            }
        }
        let mut fields = vec![
            (JsString::from("$ref"), string(collection)),
            (JsString::from("$id"), project(id)?),
        ];
        for (key, value) in copy {
            if matches!(key, "$ref" | "$id" | "$db") || matches!(value, Bson::Undefined) {
                continue;
            }
            fields.push((key.into(), project(value)?));
        }
        if let Some(db) = derived_db {
            fields.push(("$db".into(), string(db)));
        } else if let Some(db) = db {
            fields.push(("$db".into(), project(db)?));
        }
        return Ok(JsonValue::Object(fields));
    }
    let mut fields = Vec::with_capacity(values.len());
    for (k, v) in values.iter() {
        if !matches!(v, Bson::Undefined) {
            fields.push((k.as_str().into(), project(v)?));
        }
    }
    Ok(JsonValue::Object(fields))
}
