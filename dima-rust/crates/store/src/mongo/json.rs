//! BSON to JSON as Express sends a `.lean()` read (ledger `mongo.md`, rules 24 and 25).
//!
//! The reference hands `res.json` the object the Node driver builds with its default read
//! options (`promoteLongs`, `promoteValues`, no `promoteBuffers`, no `bsonRegExp`), and
//! `JSON.stringify` calls each value's `toJSON`. Every rule below is pinned by the golden JSON
//! samples (raw BSON bytes and the text Node wrote for them):
//!
//! | BSON | JSON |
//! |---|---|
//! | ObjectId | 24 lowercase hex digits |
//! | date | `toISOString()` text; `null` outside the JavaScript `Date` range |
//! | int32, double | number (`NaN` and infinities `null`, `-0` as `0`) |
//! | int64 within ±2^53 | number |
//! | int64 beyond ±2^53 | `{"low":…,"high":…,"unsigned":false}` (the driver keeps a `Long` object) |
//! | Decimal128 | `{"$numberDecimal":"…"}` |
//! | binary | base64 text; subtype 4 with 16 bytes as a hyphenated UUID; subtype 2 without its inner length |
//! | regular expression, MinKey, MaxKey | `{}` |
//! | timestamp | `{"$timestamp":"<unsigned 64-bit value>"}` |
//! | JavaScript code | `{"code":…}` or `{"code":…,"scope":…}` |
//! | symbol | string |
//! | undefined | property omitted (`null` inside an array) |
//! | DBPointer, and documents shaped like a DBRef | `{"$ref":…,"$id":…,<other fields>,"$db":…}` |
//!
//! Keys keep their stored order except that array-index keys (`"0"`, `"10"`) come first in
//! numeric order, as in any JavaScript object; a repeated key keeps its first position and its
//! last value. Extended JSON (`{"$oid":…}`, `{"$date":…}`) is never produced.
//!
//! Not reproducible: a stored regular expression that JavaScript cannot compile (or whose
//! translated flags repeat, such as options `ss`) makes the whole Node read throw; here it is
//! rendered as `{}` like every other pattern.

use crate::mongo::number::JS_MAX_PROMOTED_LONG;
use bson::spec::BinarySubtype;
use bson::{Bson, Document};
use serde_json::{Map, Number, Value};

/// `document` as the JSON value Express sends for the same document read with `.lean()`.
pub fn to_json_value(document: &Document) -> Value {
    let mut value = render_document(document);
    dima_text::js_key_order(&mut value);
    value
}

/// One BSON value as JSON ([`to_json_value`] rules). `None` for `undefined`, which
/// `JSON.stringify` omits.
pub fn bson_to_json_value(value: &Bson) -> Option<Value> {
    let mut rendered = render(value)?;
    dima_text::js_key_order(&mut rendered);
    Some(rendered)
}

/// The exact bytes `res.json` writes for `document` (`JSON.stringify` text).
pub fn to_json_string(document: &Document) -> String {
    dima_text::to_js_json(&to_json_value(document))
}

/// An exclusion projection (`{"path": 0, ...}`) for the `select: false` paths of a collection,
/// which is what Mongoose adds to every query that does not ask for them with `+path`.
pub fn exclusion_projection<I, S>(paths: I) -> Document
where
    I: IntoIterator<Item = S>,
    S: Into<String>,
{
    paths
        .into_iter()
        .map(|path| (path.into(), Bson::Int32(0)))
        .collect()
}

/// Removes `select: false` paths from a document that was read without the projection (for
/// example one returned by `findOneAndUpdate`). Dotted paths descend into sub-documents and,
/// like a server-side projection, into every document of an array.
pub fn remove_paths<S: AsRef<str>>(document: &mut Document, paths: &[S]) {
    for path in paths {
        remove_path(document, path.as_ref());
    }
}

fn remove_path(document: &mut Document, path: &str) {
    match path.split_once('.') {
        None => {
            document.remove(path);
        }
        Some((head, rest)) => match document.get_mut(head) {
            Some(Bson::Document(inner)) => remove_path(inner, rest),
            Some(Bson::Array(items)) => {
                for item in items {
                    if let Bson::Document(inner) = item {
                        remove_path(inner, rest);
                    }
                }
            }
            _ => {}
        },
    }
}

fn render(value: &Bson) -> Option<Value> {
    Some(match value {
        Bson::Undefined => return None,
        Bson::Null => Value::Null,
        Bson::RegularExpression(_) | Bson::MinKey | Bson::MaxKey => Value::Object(Map::new()),
        Bson::Boolean(v) => Value::Bool(*v),
        Bson::String(v) | Bson::Symbol(v) => Value::String(v.clone()),
        Bson::Int32(v) => Value::from(*v),
        Bson::Double(v) => number(*v),
        Bson::Int64(v) if (-JS_MAX_PROMOTED_LONG..=JS_MAX_PROMOTED_LONG).contains(v) => {
            number(*v as f64)
        }
        Bson::Int64(v) => long_object(*v),
        Bson::ObjectId(id) => Value::String(id.to_hex()),
        Bson::DateTime(d) => {
            dima_text::to_iso_string(d.timestamp_millis()).map_or(Value::Null, Value::String)
        }
        Bson::Decimal128(d) => single("$numberDecimal", Value::String(d.to_string())),
        Bson::Binary(binary) => Value::String(binary_text(binary.subtype, &binary.bytes)),
        Bson::Timestamp(ts) => {
            let combined = (u64::from(ts.time) << 32) | u64::from(ts.increment);
            single("$timestamp", Value::String(combined.to_string()))
        }
        Bson::JavaScriptCode(code) => single("code", Value::String(code.clone())),
        Bson::JavaScriptCodeWithScope(code) => {
            let mut object = Map::new();
            object.insert("code".into(), Value::String(code.code.clone()));
            object.insert("scope".into(), render_document(&code.scope));
            Value::Object(object)
        }
        Bson::DbPointer(_) => db_pointer(value),
        Bson::Array(items) => Value::Array(
            items
                .iter()
                .map(|item| render(item).unwrap_or(Value::Null))
                .collect(),
        ),
        Bson::Document(document) => render_document(document),
    })
}

fn render_document(document: &Document) -> Value {
    if let Some(reference) = db_ref(document) {
        return reference;
    }
    let mut object = Map::new();
    for (key, value) in document {
        if let Some(rendered) = render(value) {
            object.insert(key.clone(), rendered);
        }
    }
    Value::Object(object)
}

/// A JavaScript number as JSON: integral values as integers, non-finite values as `null`.
fn number(value: f64) -> Value {
    const SAFE: f64 = 9_007_199_254_740_992.0;
    if value.fract() == 0.0 && value.abs() <= SAFE {
        // `-0` is written as `0` by JSON.stringify.
        Value::from(value as i64)
    } else {
        Number::from_f64(value).map_or(Value::Null, Value::Number)
    }
}

/// The enumerable fields of a bson `Long` object, which has no `toJSON`.
fn long_object(value: i64) -> Value {
    let low = value as i32;
    let high = (value >> 32) as i32;
    let mut object = Map::new();
    object.insert("low".into(), Value::from(low));
    object.insert("high".into(), Value::from(high));
    object.insert("unsigned".into(), Value::Bool(false));
    Value::Object(object)
}

fn single(key: &str, value: Value) -> Value {
    let mut object = Map::new();
    object.insert(key.into(), value);
    Value::Object(object)
}

fn binary_text(subtype: BinarySubtype, bytes: &[u8]) -> String {
    if subtype == BinarySubtype::Uuid && bytes.len() == 16 {
        let hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
        let parts = [
            hex.get(0..8),
            hex.get(8..12),
            hex.get(12..16),
            hex.get(16..20),
            hex.get(20..32),
        ];
        return parts
            .iter()
            .flatten()
            .copied()
            .collect::<Vec<_>>()
            .join("-");
    }
    base64(bytes)
}

/// Standard base64 with padding (`Buffer.toString('base64')`).
fn base64(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b = [
            chunk.first().copied().unwrap_or(0),
            chunk.get(1).copied().unwrap_or(0),
            chunk.get(2).copied().unwrap_or(0),
        ];
        let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
        for (i, shift) in [18, 12, 6, 0].into_iter().enumerate() {
            if i <= chunk.len() {
                out.push(char::from(ALPHABET[((n >> shift) & 63) as usize]));
            } else {
                out.push('=');
            }
        }
    }
    out
}

/// The driver turns a document whose `$` keys are only `$ref`, `$id` and `$db` (at least one of
/// them present) into a DBRef when `$ref` is a string, `$id` is neither null nor undefined and
/// `$db` is absent or a string.
fn db_ref(document: &Document) -> Option<Value> {
    let mut dollar_keys = document
        .keys()
        .filter(|key| key.starts_with('$'))
        .peekable();
    dollar_keys.peek()?;
    if !dollar_keys.all(|key| matches!(key.as_str(), "$ref" | "$id" | "$db")) {
        return None;
    }
    let Some(Bson::String(collection)) = document.get("$ref") else {
        return None;
    };
    let id = document
        .get("$id")
        .filter(|id| !matches!(id, Bson::Null | Bson::Undefined))?;
    let db = match document.get("$db") {
        None => None,
        Some(Bson::String(db)) => Some(db.as_str()),
        Some(_) => return None,
    };
    let fields = document
        .iter()
        .filter(|(key, _)| !matches!(key.as_str(), "$ref" | "$id" | "$db"));
    Some(db_ref_json(
        collection,
        render(id).unwrap_or(Value::Null),
        fields,
        db,
    ))
}

fn db_pointer(value: &Bson) -> Value {
    // The bson crate keeps DBPointer fields private; its extended JSON form exposes them.
    let json = value.clone().into_relaxed_extjson();
    let pointer = json.get("$dbPointer");
    let namespace = pointer
        .and_then(|p| p.get("$ref"))
        .and_then(Value::as_str)
        .unwrap_or_default();
    let id = pointer
        .and_then(|p| p.get("$id"))
        .and_then(|id| id.get("$oid"))
        .cloned()
        .unwrap_or(Value::Null);
    db_ref_json(namespace, id, std::iter::empty(), None)
}

/// `DBRef.toJSON()`: `$ref`, `$id`, the other fields, then `$db`. A collection name with exactly
/// one dot is read as `db.collection` and overrides `$db` (bson's DBRef constructor).
fn db_ref_json<'a>(
    collection: &str,
    id: Value,
    fields: impl Iterator<Item = (&'a String, &'a Bson)>,
    db: Option<&str>,
) -> Value {
    let (db, collection) = match collection.split_once('.') {
        Some((namespace_db, rest)) if !rest.contains('.') => (Some(namespace_db), rest),
        _ => (db, collection),
    };
    let mut object = Map::new();
    object.insert("$ref".into(), Value::String(collection.to_owned()));
    object.insert("$id".into(), id);
    for (key, value) in fields {
        if let Some(rendered) = render(value) {
            object.insert(key.clone(), rendered);
        }
    }
    if let Some(db) = db {
        object.insert("$db".into(), Value::String(db.to_owned()));
    }
    Value::Object(object)
}

#[cfg(test)]
mod tests {
    use super::*;
    use bson::{DateTime, doc, oid::ObjectId};

    #[test]
    fn base64_matches_node() {
        assert_eq!(base64(&[]), "");
        assert_eq!(base64(&[1, 2, 3]), "AQID");
        assert_eq!(base64(b"fn"), "Zm4=");
        assert_eq!(base64(&[0, 1, 2, 250, 255]), "AAEC+v8=");
        assert_eq!(base64(&[255]), "/w==");
    }

    #[test]
    fn renders_common_types() -> Result<(), Box<dyn std::error::Error>> {
        let id = ObjectId::parse_str("0123456789abcdef01234567")?;
        let document = doc! {
            "_id": id,
            "at": DateTime::from_millis(1_794_391_200_123),
            "n": 3.0,
            "z": -0.0,
            "big": Bson::Int64(9_007_199_254_740_993),
            "u": Bson::Undefined,
            "list": [Bson::Undefined, f64::NAN, "שלום 👋🏽"],
            "10": 1,
            "2": 2,
        };
        assert_eq!(
            to_json_string(&document),
            r#"{"2":2,"10":1,"_id":"0123456789abcdef01234567","at":"2026-11-11T10:00:00.123Z","n":3,"z":0,"big":{"low":1,"high":2097152,"unsigned":false},"list":[null,null,"שלום 👋🏽"]}"#
        );
        Ok(())
    }

    #[test]
    fn projection_helpers() {
        assert_eq!(
            exclusion_projection(["overlayToken", "a.b"]),
            doc! { "overlayToken": 0, "a.b": 0 }
        );
        let mut document = doc! {
            "keep": 1,
            "overlayToken": "secret",
            "items": [{ "secret": 1, "label": "x" }, 2, { "label": "y" }],
            "nested": { "secret": { "deep": 1 }, "ok": true },
        };
        remove_paths(
            &mut document,
            &[
                "overlayToken",
                "items.secret",
                "nested.secret",
                "missing.path",
            ],
        );
        assert_eq!(
            document,
            doc! { "keep": 1, "items": [{ "label": "x" }, 2, { "label": "y" }], "nested": { "ok": true } }
        );
    }
}
