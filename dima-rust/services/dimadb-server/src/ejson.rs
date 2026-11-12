//! Documents as the console shows and stores them: the Node driver's read rules followed by
//! relaxed `EJSON.serialize` (bson 6.10.4) on the way out, and relaxed `EJSON.deserialize`
//! followed by the driver's BSON serializer on the way in (`mongo.mjs`).
//!
//! This is not `dima_store::mongo::json` (which renders a `.lean()` read the way Express sends
//! it); the console speaks relaxed Extended JSON. Golden vectors written by the reference's own
//! packages are in `tests/vectors/ejson.json` (`generate.mjs`).
//!
//! **Out** (BSON to JSON):
//!
//! | BSON | JSON |
//! |---|---|
//! | int32, double, int64 | number (`-0` as `0`; int64 beyond 2^53 rounded to the nearest double) |
//! | double NaN, ±infinity | `{"$numberDouble":"NaN"}`, `"Infinity"`, `"-Infinity"` |
//! | date from 1970 to year 9999 (exclusive end `253402318800000`) | `{"$date":"<ISO, .mmm only when not zero>"}` |
//! | other dates | `{"$date":{"$numberLong":"<ms>"}}` (`"NaN"` beyond the JavaScript range) |
//! | ObjectId, Decimal128, binary, timestamp, MinKey, MaxKey, code | `$oid`, `$numberDecimal`, `$binary` (`subType` two hex digits), `$timestamp`, `$minKey`, `$maxKey`, `$code` (+`$scope`) |
//! | regular expression | `$regularExpression` after a trip through a JavaScript `RegExp`: options other than `i`, `m` are dropped, `s` becomes `g`, which then fails the whole read (`The regular expression option [g] is not supported`); the pattern is `RegExp.prototype.source` |
//! | symbol | string |
//! | undefined | `null` |
//! | DBPointer, and documents shaped like a DBRef | `{"$ref","$id","$db"?, ...fields}` |
//!
//! Object keys enumerate as in JavaScript (array indices first), repeated keys keep their first
//! position and last value.
//!
//! **In** (JSON to BSON): plain numbers are int32 when they are safe integers in the int32 range
//! (`-0` included, since `EJSON.deserialize` round-trips through `JSON.stringify`), doubles
//! otherwise; `$numberInt`, `$numberLong` and `$numberDouble` become plain numbers first (so
//! `{"$numberLong":"5"}` is stored as int32 5, and int64 fields saved through the console become
//! int32 or double: the reference's behaviour); `$date` strings go through `Date.parse` (an
//! invalid date is stored as epoch 0).
//!
//! **Not reproducible**: a stored pattern that JavaScript's `RegExp` refuses makes the Node read
//! throw; here it is rendered.

use bson::spec::BinarySubtype;
use bson::{Bson, Decimal128, Document, RawBsonRef, RawDocument};
use serde_json::{Map, Value};

use crate::js;

/// A document the reference could not render or decode, with the reference's message.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{0}")]
pub struct EjsonError(pub String);

fn err(message: impl Into<String>) -> EjsonError {
    EjsonError(message.into())
}

// ---------------------------------------------------------------------------------------------
// Out: BSON to relaxed Extended JSON.
// ---------------------------------------------------------------------------------------------

/// `EJSON.serialize(doc)` of a document the driver read, as JSON.
pub fn serialize_document(document: &RawDocument) -> Result<Value, EjsonError> {
    let mut value = render_document(document)?;
    dima_text::js_key_order(&mut value);
    Ok(value)
}

/// `EJSON.serialize` of an owned document (tests and command replies).
pub fn serialize_owned(document: &Document) -> Result<Value, EjsonError> {
    let raw = bson::RawDocumentBuf::try_from(document).map_err(|e| err(e.to_string()))?;
    serialize_document(&raw)
}

/// 253402318800000: the first millisecond `EJSON` no longer writes as ISO text.
const ISO_DATE_END: i64 = 253_402_318_800_000;
/// `Date` holds at most ±8.64e15 ms.
const JS_DATE_LIMIT: i64 = 8_640_000_000_000_000;

fn render_document(document: &RawDocument) -> Result<Value, EjsonError> {
    let mut map = Map::new();
    let mut dollar_keys_allowed: Option<bool> = None;
    for element in document {
        let (key, value) = element.map_err(|e| err(e.to_string()))?;
        let key = key.as_str();
        if dollar_keys_allowed != Some(false) && key.starts_with('$') {
            dollar_keys_allowed = Some(matches!(key, "$ref" | "$id" | "$db"));
        }
        map.insert(key.to_owned(), render(value)?);
    }
    if dollar_keys_allowed == Some(true) && is_dbref_like(&map) {
        return Ok(dbref_from_map(map));
    }
    Ok(Value::Object(map))
}

/// `isDBRefLike`: `$id` present and not null, `$ref` a string, `$db` absent or a string. `map`
/// holds rendered values: `undefined` rendered as `null` counts as null here too, and a
/// symbol (a string once rendered) is a string, as the driver promotes it.
fn is_dbref_like(map: &Map<String, Value>) -> bool {
    map.get("$id").is_some_and(|id| !id.is_null())
        && map.get("$ref").is_some_and(Value::is_string)
        && map.get("$db").is_none_or(Value::is_string)
}

/// `new DBRef($ref, $id, $db, rest)` then `toExtendedJSON`.
fn dbref_from_map(mut map: Map<String, Value>) -> Value {
    let collection = map.shift_remove("$ref").unwrap_or(Value::Null);
    let id = map.shift_remove("$id").unwrap_or(Value::Null);
    let db = map.shift_remove("$db");
    dbref_json(collection, id, db, map)
}

fn dbref_json(
    collection: Value,
    id: Value,
    db: Option<Value>,
    fields: Map<String, Value>,
) -> Value {
    let (collection, db) = split_namespace(collection, db);
    let mut out = Map::new();
    out.insert("$ref".to_owned(), collection);
    out.insert("$id".to_owned(), id);
    if let Some(db) = db.filter(|db| js::truthy(Some(db))) {
        out.insert("$db".to_owned(), db);
    }
    out.extend(fields);
    Value::Object(out)
}

/// The DBRef constructor: a collection named `a.b` (exactly one dot) is collection `b` of
/// database `a`.
fn split_namespace(collection: Value, db: Option<Value>) -> (Value, Option<Value>) {
    if let Value::String(text) = &collection {
        let parts: Vec<&str> = text.split('.').collect();
        if let [first, second] = parts.as_slice() {
            return (Value::from(*second), Some(Value::from(*first)));
        }
    }
    (collection, db)
}

fn render(value: RawBsonRef<'_>) -> Result<Value, EjsonError> {
    Ok(match value {
        RawBsonRef::Double(n) => double(n),
        RawBsonRef::Int32(n) => Value::from(n),
        #[expect(
            clippy::cast_precision_loss,
            reason = "Long#toNumber rounds the same way"
        )]
        RawBsonRef::Int64(n) => js::number_value(n as f64),
        RawBsonRef::String(text) | RawBsonRef::Symbol(text) => Value::from(text),
        RawBsonRef::Boolean(flag) => Value::Bool(flag),
        RawBsonRef::Null | RawBsonRef::Undefined => Value::Null,
        RawBsonRef::ObjectId(oid) => wrap("$oid", Value::from(oid.to_hex())),
        RawBsonRef::DateTime(date) => date_json(date.timestamp_millis()),
        RawBsonRef::Binary(binary) => binary_json(binary.subtype, binary.bytes),
        RawBsonRef::RegularExpression(regex) => {
            let (pattern, options) = js_regex(regex.pattern.as_str(), regex.options.as_str())?;
            wrap(
                "$regularExpression",
                serde_json::json!({ "pattern": pattern, "options": options }),
            )
        }
        RawBsonRef::Timestamp(ts) => wrap(
            "$timestamp",
            serde_json::json!({ "t": ts.time, "i": ts.increment }),
        ),
        RawBsonRef::Decimal128(decimal) => {
            wrap("$numberDecimal", Value::from(decimal_text(&decimal)))
        }
        RawBsonRef::MinKey => wrap("$minKey", Value::from(1)),
        RawBsonRef::MaxKey => wrap("$maxKey", Value::from(1)),
        RawBsonRef::JavaScriptCode(code) => wrap("$code", Value::from(code)),
        RawBsonRef::JavaScriptCodeWithScope(code) => {
            let mut map = Map::new();
            map.insert("$code".to_owned(), Value::from(code.code));
            map.insert("$scope".to_owned(), render_document(code.scope)?);
            Value::Object(map)
        }
        RawBsonRef::DbPointer(_) => {
            let (namespace, oid) = db_pointer_parts(value)?;
            dbref_json(
                Value::from(namespace),
                wrap("$oid", Value::from(oid)),
                None,
                Map::new(),
            )
        }
        RawBsonRef::Array(array) => {
            let mut items = Vec::new();
            for item in array {
                items.push(render(item.map_err(|e| err(e.to_string()))?)?);
            }
            Value::Array(items)
        }
        RawBsonRef::Document(document) => render_document(document)?,
    })
}

/// The bson crate keeps a DBPointer's parts private; its canonical Extended JSON has them.
fn db_pointer_parts(value: RawBsonRef<'_>) -> Result<(String, String), EjsonError> {
    let owned = Bson::try_from(value).map_err(|e| err(e.to_string()))?;
    let ext = owned.into_canonical_extjson();
    let pointer = ext.get("$dbPointer");
    let namespace = pointer
        .and_then(|p| p.get("$ref"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    let oid = pointer
        .and_then(|p| p.get("$id"))
        .and_then(|id| id.get("$oid"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    Ok((namespace, oid))
}

fn wrap(key: &str, value: Value) -> Value {
    let mut map = Map::new();
    map.insert(key.to_owned(), value);
    Value::Object(map)
}

fn double(n: f64) -> Value {
    if n.is_nan() {
        wrap("$numberDouble", Value::from("NaN"))
    } else if n.is_infinite() {
        wrap(
            "$numberDouble",
            Value::from(if n > 0.0 { "Infinity" } else { "-Infinity" }),
        )
    } else {
        // JSON.stringify(-0) is "0".
        js::number_value(if n == 0.0 { 0.0 } else { n })
    }
}

fn date_json(ms: i64) -> Value {
    if ms > -1 && ms < ISO_DATE_END {
        let iso = dima_text::to_iso_string(ms).unwrap_or_default();
        let text = if ms.rem_euclid(1000) == 0 {
            // `isoStr.slice(0, -5) + 'Z'`
            let cut = iso.len().saturating_sub(5);
            format!("{}Z", iso.get(..cut).unwrap_or_default())
        } else {
            iso
        };
        return wrap("$date", Value::from(text));
    }
    let number = if ms.unsigned_abs() > JS_DATE_LIMIT.unsigned_abs() {
        "NaN".to_owned()
    } else {
        ms.to_string()
    };
    wrap("$date", wrap("$numberLong", Value::from(number)))
}

fn binary_json(subtype: BinarySubtype, bytes: &[u8]) -> Value {
    let code = u8::from(subtype);
    serde_json::json!({
        "$binary": {
            "base64": dima_core::crypto::encoding::encode_base64(bytes),
            "subType": format!("{code:02x}"),
        }
    })
}

/// A BSON regex after `new RegExp(source, flags)` and `new BSONRegExp(re.source, re.flags)`:
/// `(pattern, options)` or the error the reference throws.
fn js_regex(pattern: &str, options: &str) -> Result<(String, String), EjsonError> {
    let flags = js_flags(options)?;
    let mut sorted: Vec<char> = flags.chars().collect();
    sorted.sort_unstable();
    for flag in &sorted {
        if !matches!(flag, 'i' | 'm' | 'x' | 'l' | 's' | 'u') {
            return Err(err(format!(
                "The regular expression option [{flag}] is not supported"
            )));
        }
    }
    Ok((regexp_source(pattern), sorted.into_iter().collect()))
}

/// The driver's option translation (`m`→`m`, `s`→`g`, `i`→`i`, others dropped), checked and
/// normalised the way `RegExp` does (`flags` in `dgimsuvy` order).
fn js_flags(options: &str) -> Result<String, EjsonError> {
    let mapped: String = options
        .chars()
        .filter_map(|c| match c {
            'm' => Some('m'),
            's' => Some('g'),
            'i' => Some('i'),
            _ => None,
        })
        .collect();
    let mut seen = Vec::new();
    for c in mapped.chars() {
        if seen.contains(&c) {
            return Err(err(format!(
                "Invalid flags supplied to RegExp constructor '{mapped}'"
            )));
        }
        seen.push(c);
    }
    Ok("dgimsuvy".chars().filter(|c| seen.contains(c)).collect())
}

/// `RegExp.prototype.source` (V8's `EscapeRegExpSource`).
fn regexp_source(pattern: &str) -> String {
    if pattern.is_empty() {
        return "(?:)".to_owned();
    }
    let is_line_terminator = |c: char| matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}');
    let chars: Vec<char> = pattern.chars().collect();
    let mut out = String::with_capacity(pattern.len());
    let mut in_class = false;
    let mut index = 0;
    while let Some(&c) = chars.get(index) {
        let next = chars.get(index + 1).copied();
        if c == '\\' {
            match next {
                // The backslash is dropped: the line terminator is escaped on its own.
                Some(n) if is_line_terminator(n) => {
                    index += 1;
                    continue;
                }
                Some(n) => {
                    out.push('\\');
                    out.push(n);
                    index += 2;
                    continue;
                }
                None => {}
            }
        }
        match c {
            '/' if !in_class => out.push_str("\\/"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\u{2028}' => out.push_str("\\u2028"),
            '\u{2029}' => out.push_str("\\u2029"),
            _ => {
                if c == '[' {
                    in_class = true;
                } else if c == ']' {
                    in_class = false;
                }
                out.push(c);
            }
        }
        index += 1;
    }
    out
}

/// `Decimal128#toString()`.
pub fn decimal_text(decimal: &Decimal128) -> String {
    let bytes = decimal.bytes();
    let word = |at: usize| -> u32 {
        u32::from_le_bytes([
            bytes.get(at).copied().unwrap_or(0),
            bytes.get(at + 1).copied().unwrap_or(0),
            bytes.get(at + 2).copied().unwrap_or(0),
            bytes.get(at + 3).copied().unwrap_or(0),
        ])
    };
    let (low, midl, midh, high) = (word(0), word(4), word(8), word(12));
    let mut out = String::new();
    if high & 0x8000_0000 != 0 {
        out.push('-');
    }
    let combination = (high >> 26) & 0x1f;
    let (biased_exponent, msb) = if combination >> 3 == 3 {
        if combination == 30 {
            return format!("{out}Infinity");
        }
        if combination == 31 {
            return "NaN".to_owned();
        }
        ((high >> 15) & 0x3fff, 0x08 + ((high >> 14) & 0x01))
    } else {
        ((high >> 17) & 0x3fff, (high >> 14) & 0x07)
    };
    let exponent = i64::from(biased_exponent) - 6176;
    let top = u128::from((high & 0x3fff) + ((msb & 0xf) << 14));
    let coefficient =
        (top << 96) | (u128::from(midh) << 64) | (u128::from(midl) << 32) | u128::from(low);
    let digits = coefficient.to_string();
    let digit_count = i64::try_from(digits.len()).unwrap_or(0);
    let scientific_exponent = digit_count - 1 + exponent;
    if scientific_exponent >= 34 || scientific_exponent <= -7 || exponent > 0 {
        if digit_count > 34 {
            out.push('0');
            if exponent > 0 {
                out.push_str(&format!("E+{exponent}"));
            } else if exponent < 0 {
                out.push_str(&format!("E{exponent}"));
            }
            return out;
        }
        let mut chars = digits.chars();
        if let Some(first) = chars.next() {
            out.push(first);
        }
        let rest: String = chars.collect();
        if !rest.is_empty() {
            out.push('.');
            out.push_str(&rest);
        }
        out.push('E');
        if scientific_exponent > 0 {
            out.push('+');
        }
        out.push_str(&scientific_exponent.to_string());
        return out;
    }
    if exponent >= 0 {
        out.push_str(&digits);
        return out;
    }
    let radix = digit_count + exponent;
    let split = usize::try_from(radix.max(0)).unwrap_or(0);
    let (integer, fraction) = digits.split_at(split.min(digits.len()));
    if radix > 0 {
        out.push_str(integer);
    } else {
        out.push('0');
    }
    out.push('.');
    for _ in radix..0 {
        out.push('0');
    }
    out.push_str(fraction);
    out
}

/// `String(doc._id)` (the `id` field of every document row); `''` for null and undefined.
///
/// Dates print as `Date.prototype.toString()` in UTC (the container's time zone).
pub fn id_text(document: &RawDocument) -> String {
    match document.get("_id") {
        Ok(Some(value)) => string_of_bson(value),
        _ => String::new(),
    }
}

fn string_of_bson(value: RawBsonRef<'_>) -> String {
    match value {
        RawBsonRef::Null | RawBsonRef::Undefined => String::new(),
        RawBsonRef::String(text) | RawBsonRef::Symbol(text) => text.to_owned(),
        RawBsonRef::ObjectId(oid) => oid.to_hex(),
        RawBsonRef::Int32(n) => dima_text::number_to_string(f64::from(n)),
        RawBsonRef::Double(n) => dima_text::number_to_string(n),
        RawBsonRef::Int64(n) => {
            if n.unsigned_abs() <= 1 << 53 {
                #[expect(clippy::cast_precision_loss, reason = "exact within 2^53")]
                dima_text::number_to_string(n as f64)
            } else {
                n.to_string()
            }
        }
        RawBsonRef::Boolean(flag) => flag.to_string(),
        RawBsonRef::DateTime(date) => date_to_string(date.timestamp_millis()),
        RawBsonRef::Decimal128(decimal) => decimal_text(&decimal),
        RawBsonRef::Timestamp(ts) => {
            ((u64::from(ts.time) << 32) | u64::from(ts.increment)).to_string()
        }
        RawBsonRef::Binary(binary) => {
            if binary.subtype == BinarySubtype::Uuid && binary.bytes.len() == 16 {
                let hex = dima_core::crypto::encoding::encode_hex(binary.bytes);
                let part = |a: usize, b: usize| hex.get(a..b).unwrap_or_default().to_owned();
                format!(
                    "{}-{}-{}-{}-{}",
                    part(0, 8),
                    part(8, 12),
                    part(12, 16),
                    part(16, 20),
                    part(20, 32)
                )
            } else {
                String::from_utf8_lossy(binary.bytes).into_owned()
            }
        }
        RawBsonRef::RegularExpression(regex) => match js_flags(regex.options.as_str()) {
            Ok(flags) => format!("/{}/{flags}", regexp_source(regex.pattern.as_str())),
            Err(_) => String::new(),
        },
        RawBsonRef::Array(array) => {
            let parts: Vec<String> = array
                .into_iter()
                .map(|item| item.map(string_of_bson).unwrap_or_default())
                .collect();
            parts.join(",")
        }
        RawBsonRef::Document(_)
        | RawBsonRef::JavaScriptCode(_)
        | RawBsonRef::JavaScriptCodeWithScope(_)
        | RawBsonRef::MinKey
        | RawBsonRef::MaxKey
        | RawBsonRef::DbPointer(_) => "[object Object]".to_owned(),
    }
}

/// `Date.prototype.toString()` in UTC.
fn date_to_string(ms: i64) -> String {
    dima_text::to_string_utc(ms).unwrap_or_else(|| "Invalid Date".to_owned())
}

// ---------------------------------------------------------------------------------------------
// In: relaxed Extended JSON to BSON.
// ---------------------------------------------------------------------------------------------

/// What `EJSON.deserialize` leaves: JavaScript values and bson class instances.
#[derive(Debug, Clone, PartialEq)]
pub enum Js {
    /// `null`.
    Null,
    /// A boolean.
    Bool(bool),
    /// A JavaScript number.
    Number(f64),
    /// A string.
    String(String),
    /// An array.
    Array(Vec<Js>),
    /// A plain object, keys in enumeration order.
    Object(Vec<(String, Js)>),
    /// `ObjectId`.
    ObjectId(bson::oid::ObjectId),
    /// `Date` (time value; `NaN` for an invalid date).
    Date(f64),
    /// `Binary` / `UUID`.
    Binary(u8, Vec<u8>),
    /// `Decimal128`.
    Decimal(Decimal128),
    /// `BSONRegExp`.
    Regex(String, String),
    /// `Timestamp`.
    Timestamp(u32, u32),
    /// `Code`, with its scope when it is an object.
    Code(String, Option<Box<Js>>),
    /// `BSONSymbol`.
    Symbol(String),
    /// `MinKey`.
    MinKey,
    /// `MaxKey`.
    MaxKey,
    /// `DBRef`.
    DbRef {
        /// `collection`.
        collection: String,
        /// `oid` (any value).
        id: Box<Js>,
        /// `db` (absent or a string).
        db: Option<String>,
        /// The other fields.
        fields: Vec<(String, Js)>,
    },
}

impl Js {
    fn get(&self, key: &str) -> Option<&Js> {
        match self {
            Self::Object(entries) => entries.iter().find(|(k, _)| k == key).map(|(_, v)| v),
            _ => None,
        }
    }

    fn is_nullish(value: Option<&Js>) -> bool {
        matches!(value, None | Some(Js::Null))
    }

    fn truthy(&self) -> bool {
        match self {
            Self::Null => false,
            Self::Bool(flag) => *flag,
            Self::Number(n) => *n != 0.0 && !n.is_nan(),
            Self::String(text) => !text.is_empty(),
            _ => true,
        }
    }

    fn type_of(&self) -> &'static str {
        match self {
            Self::Bool(_) => "boolean",
            Self::Number(_) => "number",
            Self::String(_) => "string",
            _ => "object",
        }
    }

    /// `String(value)` for the values a codec reads as text.
    fn text(&self) -> String {
        match self {
            Self::String(text) | Self::Symbol(text) => text.clone(),
            Self::Number(n) => dima_text::number_to_string(*n),
            Self::Bool(flag) => flag.to_string(),
            Self::Null => "null".to_owned(),
            Self::Array(items) => items
                .iter()
                .map(|item| {
                    if matches!(item, Js::Null) {
                        String::new()
                    } else {
                        item.text()
                    }
                })
                .collect::<Vec<_>>()
                .join(","),
            _ => "[object Object]".to_owned(),
        }
    }

    /// The JSON text `JSON.stringify` writes for a value that is still plain JSON.
    fn to_json(&self) -> Value {
        match self {
            Self::Null => Value::Null,
            Self::Bool(flag) => Value::Bool(*flag),
            Self::Number(n) => js::number_value(*n),
            Self::String(text) | Self::Symbol(text) => Value::from(text.clone()),
            Self::Array(items) => Value::Array(items.iter().map(Js::to_json).collect()),
            Self::Object(entries) => Value::Object(
                entries
                    .iter()
                    .map(|(k, v)| (k.clone(), v.to_json()))
                    .collect(),
            ),
            _ => Value::Object(Map::new()),
        }
    }
}

/// `EJSON.deserialize(value)` (relaxed).
pub fn deserialize(value: &Value) -> Result<Js, EjsonError> {
    // `EJSON.deserialize` is `parse(JSON.stringify(value))`: `-0` becomes `0` on the way.
    revive(value, "")
}

fn revive(value: &Value, key: &str) -> Result<Js, EjsonError> {
    let plain = match value {
        Value::Null => Js::Null,
        Value::Bool(flag) => Js::Bool(*flag),
        Value::Number(number) => {
            let n = number.as_f64().unwrap_or(f64::NAN);
            Js::Number(if n == 0.0 { 0.0 } else { n })
        }
        Value::String(text) => Js::String(text.clone()),
        Value::Array(items) => {
            let mut out = Vec::with_capacity(items.len());
            for (index, item) in items.iter().enumerate() {
                out.push(revive(item, &index.to_string())?);
            }
            Js::Array(out)
        }
        Value::Object(map) => {
            let mut out = Vec::with_capacity(map.len());
            for (child_key, child) in map {
                out.push((child_key.clone(), revive(child, child_key)?));
            }
            Js::Object(out)
        }
    };
    if key.contains('\0') {
        return Err(err(format!(
            "BSON Document field names cannot contain null bytes, found: {}",
            dima_text::to_js_json(&Value::from(key))
        )));
    }
    deserialize_value(plain)
}

/// bson's `deserializeValue` for one value whose children are already deserialized.
fn deserialize_value(value: Js) -> Result<Js, EjsonError> {
    let Js::Object(entries) = &value else {
        return Ok(value);
    };
    if value.get("$undefined").is_some_and(Js::truthy) {
        return Ok(Js::Null);
    }
    let codec_key = entries
        .iter()
        .filter(|(k, v)| k.starts_with('$') && !matches!(v, Js::Null))
        .map(|(k, _)| k.as_str())
        .find(|k| {
            matches!(
                *k,
                "$oid"
                    | "$binary"
                    | "$uuid"
                    | "$symbol"
                    | "$numberInt"
                    | "$numberDecimal"
                    | "$numberDouble"
                    | "$numberLong"
                    | "$minKey"
                    | "$maxKey"
                    | "$regex"
                    | "$regularExpression"
                    | "$timestamp"
            )
        })
        .map(str::to_owned);
    if let Some(codec) = codec_key {
        return from_codec(&codec, value);
    }
    if !Js::is_nullish(value.get("$date")) {
        return date_from(value.get("$date").unwrap_or(&Js::Null));
    }
    if !Js::is_nullish(value.get("$code")) {
        let code = value.get("$code").map(Js::text).unwrap_or_default();
        let scope = match value.get("$scope") {
            Some(scope @ (Js::Object(_) | Js::Array(_))) => Some(Box::new(scope.clone())),
            Some(Js::Null) | None => None,
            // Any other truthy scope is written as code without scope by the serializer.
            Some(_) => None,
        };
        return Ok(Js::Code(code, scope));
    }
    let dbref_like = is_dbref_like_js(&value);
    let pointer = value.get("$dbPointer").filter(|v| v.truthy()).cloned();
    if dbref_like || pointer.is_some() {
        let candidate = if value.get("$ref").is_some_and(Js::truthy) {
            value.clone()
        } else {
            pointer.unwrap_or(Js::Null)
        };
        if matches!(candidate, Js::DbRef { .. }) {
            return Ok(candidate);
        }
        if let Js::Object(fields) = &candidate {
            let valid = fields
                .iter()
                .filter(|(k, _)| k.starts_with('$'))
                .all(|(k, _)| matches!(k.as_str(), "$ref" | "$id" | "$db"));
            if valid {
                return Ok(dbref_from_js(fields));
            }
        }
    }
    Ok(value)
}

fn is_dbref_like_js(value: &Js) -> bool {
    !Js::is_nullish(value.get("$id"))
        && matches!(value.get("$ref"), Some(Js::String(_)))
        && value
            .get("$db")
            .is_none_or(|db| matches!(db, Js::String(_)))
}

fn dbref_from_js(fields: &[(String, Js)]) -> Js {
    let get = |key: &str| {
        fields
            .iter()
            .find(|(k, _)| k == key)
            .map(|(_, v)| v.clone())
    };
    let collection = get("$ref")
        .map(|v| v.text())
        .unwrap_or_else(|| "undefined".to_owned());
    let mut db = match get("$db") {
        Some(Js::String(text)) => Some(text),
        _ => None,
    };
    let parts: Vec<&str> = collection.split('.').collect();
    let collection = if let [first, second] = parts.as_slice() {
        db = Some((*first).to_owned());
        (*second).to_owned()
    } else {
        collection.clone()
    };
    Js::DbRef {
        collection,
        id: Box::new(get("$id").unwrap_or(Js::Null)),
        db,
        fields: fields
            .iter()
            .filter(|(k, _)| !matches!(k.as_str(), "$ref" | "$id" | "$db"))
            .cloned()
            .collect(),
    }
}

fn from_codec(codec: &str, value: Js) -> Result<Js, EjsonError> {
    let field = |key: &str| value.get(key).cloned().unwrap_or(Js::Null);
    match codec {
        "$oid" => object_id_from(&field("$oid")),
        "$binary" | "$uuid" => binary_from(&value),
        "$symbol" => Ok(Js::Symbol(field("$symbol").text())),
        "$numberInt" => Ok(Js::Number(dima_text::parse_int(
            &field("$numberInt").text(),
            dima_text::Radix::Decimal,
        ))),
        "$numberDouble" => Ok(Js::Number(dima_text::parse_float(
            &field("$numberDouble").text(),
        ))),
        "$numberLong" => long_from(&field("$numberLong")),
        "$numberDecimal" => {
            let text = field("$numberDecimal").text();
            text.parse::<Decimal128>()
                .map(Js::Decimal)
                .map_err(|_| err(format!("{text} not a valid Decimal128 string")))
        }
        "$minKey" => Ok(Js::MinKey),
        "$maxKey" => Ok(Js::MaxKey),
        "$regex" => match field("$regex") {
            Js::String(pattern) => {
                let options = value
                    .get("$options")
                    .filter(|o| o.truthy())
                    .map(Js::text)
                    .unwrap_or_default();
                regex_from(pattern, &options)
            }
            Js::Regex(..) => Ok(value),
            _ if value.get("$regularExpression").is_some() => regular_expression_from(&value),
            _ => Err(err(format!(
                "Unexpected BSONRegExp EJSON object form: {}",
                dima_text::to_js_json(&value.to_json())
            ))),
        },
        "$regularExpression" => regular_expression_from(&value),
        "$timestamp" => timestamp_from(&field("$timestamp")),
        _ => Ok(value),
    }
}

fn object_id_from(value: &Js) -> Result<Js, EjsonError> {
    match value {
        Js::String(text) if text.len() == 24 && text.bytes().all(|b| b.is_ascii_hexdigit()) => {
            bson::oid::ObjectId::parse_str(text.to_ascii_lowercase())
                .map(Js::ObjectId)
                .map_err(|e| err(e.to_string()))
        }
        Js::String(_) => Err(err(
            "input must be a 24 character hex string, 12 byte Uint8Array, or an integer",
        )),
        // `new ObjectId(number)` generates an id with that timestamp.
        Js::Number(seconds) => {
            #[expect(
                clippy::cast_possible_truncation,
                clippy::cast_sign_loss,
                reason = "the driver writes the low 32 bits"
            )]
            let time = (*seconds as i64 as u32).to_be_bytes();
            let fresh = bson::oid::ObjectId::new().bytes();
            let mut bytes = fresh;
            bytes[..4].copy_from_slice(&time);
            Ok(Js::ObjectId(bson::oid::ObjectId::from_bytes(bytes)))
        }
        Js::ObjectId(oid) => Ok(Js::ObjectId(*oid)),
        _ => Err(err("Argument passed in does not match the accepted types")),
    }
}

fn binary_from(value: &Js) -> Result<Js, EjsonError> {
    let (subtype, data) = if let Some(binary) = value.get("$binary") {
        match binary {
            Js::String(_) => {
                return Err(err(format!(
                    "Unexpected Binary Extended JSON format {}",
                    dima_text::to_js_json(&value.to_json())
                )));
            }
            other => {
                let subtype = match other.get("subType") {
                    Some(sub) if sub.truthy() => {
                        let n = dima_text::parse_int(&sub.text(), dima_text::Radix::Hex);
                        #[expect(
                            clippy::cast_possible_truncation,
                            clippy::cast_sign_loss,
                            reason = "a Uint8Array store keeps the low byte; NaN is 0"
                        )]
                        let byte = if n.is_finite() {
                            (n as i64 & 0xff) as u8
                        } else {
                            0
                        };
                        (n, byte)
                    }
                    _ => (0.0, 0),
                };
                let data = match other.get("base64") {
                    Some(Js::String(text)) => {
                        dima_core::crypto::encoding::decode_base64_lenient(text)
                    }
                    Some(other) => {
                        dima_core::crypto::encoding::decode_base64_lenient(&other.text())
                    }
                    None => {
                        return Err(err(
                            "The first argument must be of type string or an instance of Buffer, ArrayBuffer, or Array or an Array-like Object. Received undefined",
                        ));
                    }
                };
                (subtype, data)
            }
        }
    } else {
        let text = value.get("$uuid").map(Js::text).unwrap_or_default();
        ((4.0, 4), uuid_bytes(&text)?)
    };
    if subtype.0 == 4.0 && data.len() != 16 {
        return Err(err(
            "Argument passed in UUID constructor must be a UUID, a 16 byte Buffer or a 32/36 character hex string (dashes excluded/included, format: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx).",
        ));
    }
    Ok(Js::Binary(subtype.1, data))
}

fn uuid_bytes(text: &str) -> Result<Vec<u8>, EjsonError> {
    let hyphenated = text.len() == 36
        && text.char_indices().all(|(i, c)| {
            if matches!(i, 8 | 13 | 18 | 23) {
                c == '-'
            } else {
                c.is_ascii_hexdigit()
            }
        });
    let plain = text.len() == 32 && text.bytes().all(|b| b.is_ascii_hexdigit());
    if !hyphenated && !plain {
        return Err(err(
            "UUID string representation must be 32 hex digits or canonical hyphenated representation",
        ));
    }
    Ok(dima_core::crypto::encoding::decode_hex_lenient(
        &text.replace('-', ""),
    ))
}

fn long_from(value: &Js) -> Result<Js, EjsonError> {
    let text = value.text();
    if dima_text::utf16_len(&text) > 20 {
        return Err(err("$numberLong string is too long"));
    }
    let valid = {
        let unsigned = text.strip_prefix(['+', '-']).unwrap_or(&text);
        let digits_ok = !unsigned.is_empty() && unsigned.bytes().all(|b| b.is_ascii_digit());
        // /^(\+?0|(\+|-)?[1-9][0-9]*)$/
        digits_ok && (unsigned == "0" && !text.starts_with('-') || !unsigned.starts_with('0'))
    };
    if !valid {
        return Err(err(format!(
            "$numberLong string \"{text}\" is in an invalid format"
        )));
    }
    // `Long.fromString` wraps modulo 2^64, then `toNumber()`.
    let negative = text.starts_with('-');
    let digits = text.trim_start_matches(['+', '-']);
    let mut magnitude: u64 = 0;
    for byte in digits.bytes() {
        magnitude = magnitude
            .wrapping_mul(10)
            .wrapping_add(u64::from(byte - b'0'));
    }
    #[expect(
        clippy::cast_possible_wrap,
        reason = "two's complement wrap, as Long does"
    )]
    let signed = if negative {
        magnitude.wrapping_neg()
    } else {
        magnitude
    } as i64;
    #[expect(clippy::cast_precision_loss, reason = "Long#toNumber")]
    Ok(Js::Number(signed as f64))
}

fn regex_from(pattern: String, options: &str) -> Result<Js, EjsonError> {
    let mut sorted: Vec<char> = options.chars().collect();
    sorted.sort_by(|a, b| dima_text::cmp_utf16(&a.to_string(), &b.to_string()));
    let options: String = sorted.into_iter().collect();
    if pattern.contains('\0') {
        return Err(err(format!(
            "BSON Regex patterns cannot contain null bytes, found: {}",
            dima_text::to_js_json(&Value::from(pattern))
        )));
    }
    if options.contains('\0') {
        return Err(err(format!(
            "BSON Regex options cannot contain null bytes, found: {}",
            dima_text::to_js_json(&Value::from(options))
        )));
    }
    if let Some(bad) = options
        .chars()
        .find(|c| !matches!(c, 'i' | 'm' | 'x' | 'l' | 's' | 'u'))
    {
        return Err(err(format!(
            "The regular expression option [{bad}] is not supported"
        )));
    }
    Ok(Js::Regex(pattern, options))
}

fn regular_expression_from(value: &Js) -> Result<Js, EjsonError> {
    let inner = value.get("$regularExpression").cloned().unwrap_or(Js::Null);
    let pattern = inner
        .get("pattern")
        .map(Js::text)
        .unwrap_or_else(|| "undefined".to_owned());
    let options = inner
        .get("options")
        .filter(|o| o.truthy())
        .map(Js::text)
        .unwrap_or_default();
    regex_from(pattern, &options)
}

fn timestamp_from(value: &Js) -> Result<Js, EjsonError> {
    let part = |key: &str, label: &str| -> Result<f64, EjsonError> {
        match value.get(key) {
            Some(Js::Number(n)) => Ok(*n),
            _ => Err(err(format!(
                "Timestamp constructed from {{ t, i }} must provide {label} as a number"
            ))),
        }
    };
    let t = part("t", "t")?;
    let i = part("i", "i")?;
    if t < 0.0 || t.is_nan() {
        return Err(err(
            "Timestamp constructed from { t, i } must provide a positive t",
        ));
    }
    if i < 0.0 || i.is_nan() {
        return Err(err(
            "Timestamp constructed from { t, i } must provide a positive i",
        ));
    }
    if t > f64::from(u32::MAX) {
        return Err(err(
            "Timestamp constructed from { t, i } must provide t equal or less than uint32 max",
        ));
    }
    if i > f64::from(u32::MAX) {
        return Err(err(
            "Timestamp constructed from { t, i } must provide i equal or less than uint32 max",
        ));
    }
    #[expect(
        clippy::cast_possible_truncation,
        clippy::cast_sign_loss,
        reason = "checked range; Long truncates"
    )]
    Ok(Js::Timestamp(t as u32, i as u32))
}

fn date_from(value: &Js) -> Result<Js, EjsonError> {
    match value {
        Js::String(text) => Ok(Js::Date(
            #[expect(clippy::cast_precision_loss, reason = "time values are within 8.64e15")]
            dima_text::parse_date(text).map_or(f64::NAN, |ms| ms as f64),
        )),
        Js::Number(n) => Ok(Js::Date(time_clip(*n))),
        other => Err(err(format!(
            "Unrecognized type for EJSON date: {}",
            other.type_of()
        ))),
    }
}

/// `TimeClip`.
fn time_clip(n: f64) -> f64 {
    if !n.is_finite() || n.abs() > 8.64e15 {
        return f64::NAN;
    }
    let t = n.trunc();
    if t == 0.0 { 0.0 } else { t }
}

// ---------------------------------------------------------------------------------------------
// The driver's serializer.
// ---------------------------------------------------------------------------------------------

/// A value as the driver serializes it.
pub fn to_bson(value: &Js) -> Bson {
    match value {
        Js::Null => Bson::Null,
        Js::Bool(flag) => Bson::Boolean(*flag),
        Js::Number(n) => number_bson(*n),
        Js::String(text) => Bson::String(text.clone()),
        Js::Array(items) => Bson::Array(items.iter().map(to_bson).collect()),
        Js::Object(entries) => Bson::Document(entries_document(entries)),
        Js::ObjectId(oid) => Bson::ObjectId(*oid),
        Js::Date(t) => {
            #[expect(
                clippy::cast_possible_truncation,
                reason = "time values are integral and within 8.64e15"
            )]
            let ms = if t.is_nan() { 0 } else { *t as i64 };
            Bson::DateTime(bson::DateTime::from_millis(ms))
        }
        Js::Binary(subtype, bytes) => Bson::Binary(bson::Binary {
            subtype: BinarySubtype::from(*subtype),
            bytes: bytes.clone(),
        }),
        Js::Decimal(decimal) => Bson::Decimal128(*decimal),
        Js::Regex(pattern, options) => {
            // Null bytes were refused when the value was built.
            match (
                bson::raw::CString::try_from(pattern.clone()),
                bson::raw::CString::try_from(options.clone()),
            ) {
                (Ok(pattern), Ok(options)) => {
                    Bson::RegularExpression(bson::Regex { pattern, options })
                }
                _ => Bson::Null,
            }
        }
        Js::Timestamp(t, i) => Bson::Timestamp(bson::Timestamp {
            time: *t,
            increment: *i,
        }),
        Js::Code(code, None) => Bson::JavaScriptCode(code.clone()),
        Js::Code(code, Some(scope)) => {
            let scope = match to_bson(scope) {
                Bson::Document(document) => document,
                Bson::Array(items) => items
                    .into_iter()
                    .enumerate()
                    .map(|(index, item)| (index.to_string(), item))
                    .collect(),
                _ => Document::new(),
            };
            Bson::JavaScriptCodeWithScope(bson::JavaScriptCodeWithScope {
                code: code.clone(),
                scope,
            })
        }
        Js::Symbol(text) => Bson::Symbol(text.clone()),
        Js::MinKey => Bson::MinKey,
        Js::MaxKey => Bson::MaxKey,
        Js::DbRef {
            collection,
            id,
            db,
            fields,
        } => {
            let mut entries = vec![
                ("$ref".to_owned(), Js::String(collection.clone())),
                ("$id".to_owned(), (**id).clone()),
            ];
            if let Some(db) = db {
                entries.push(("$db".to_owned(), Js::String(db.clone())));
            }
            for (key, value) in fields {
                match entries.iter_mut().find(|(k, _)| k == key) {
                    Some(entry) => entry.1 = value.clone(),
                    None => entries.push((key.clone(), value.clone())),
                }
            }
            Bson::Document(entries_document(&js_ordered(entries)))
        }
    }
}

/// `Object.assign` order: array-index keys first.
fn js_ordered(entries: Vec<(String, Js)>) -> Vec<(String, Js)> {
    let mut keys = Value::Object(
        entries
            .iter()
            .map(|(k, _)| (k.clone(), Value::Null))
            .collect(),
    );
    dima_text::js_key_order(&mut keys);
    let order: Vec<String> = keys
        .as_object()
        .map(|m| m.keys().cloned().collect())
        .unwrap_or_default();
    let mut out = Vec::with_capacity(entries.len());
    for key in order {
        if let Some(entry) = entries.iter().find(|(k, _)| *k == key) {
            out.push(entry.clone());
        }
    }
    out
}

fn entries_document(entries: &[(String, Js)]) -> Document {
    let mut document = Document::new();
    for (key, value) in entries {
        document.insert(key.clone(), to_bson(value));
    }
    document
}

/// `serializeNumber`: int32 for safe integers in the int32 range (not `-0`), double otherwise.
pub fn number_bson(n: f64) -> Bson {
    let negative_zero = n == 0.0 && n.is_sign_negative();
    if !negative_zero
        && js::is_integer(n)
        && (f64::from(i32::MIN)..=f64::from(i32::MAX)).contains(&n)
    {
        #[expect(clippy::cast_possible_truncation, reason = "checked to be an int32")]
        return Bson::Int32(n as i32);
    }
    Bson::Double(n)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bson_value_text_contract() {
        let value = Js::Array(vec![
            Js::Null,
            Js::Number(-0.0),
            Js::Array(vec![Js::String("😀".into()), Js::Null]),
            Js::Symbol("symbol".into()),
        ]);
        assert_eq!(value.text(), ",0,😀,,symbol");
        assert!(Js::Symbol(String::new()).truthy());
        assert_eq!(Js::Symbol(String::new()).text(), "");
        assert!(!Js::Number(f64::NAN).truthy());
    }

    #[test]
    fn shared_date_contract() {
        for ms in [
            -8_640_000_000_000_000,
            -1,
            0,
            8_640_000_000_000_000,
            i64::MAX,
        ] {
            let expected =
                dima_text::to_string_utc(ms).unwrap_or_else(|| "Invalid Date".to_owned());
            assert_eq!(date_to_string(ms), expected);
        }
        let ms = dima_text::date_utc(-1, 0, 1, 0, 0, 0, 0).unwrap();
        // Node vectors: non-ISO negative years have four digits; the old copy used six.
        assert_eq!(
            date_to_string(ms),
            "Fri Jan 01 -0001 00:00:00 GMT+0000 (Coordinated Universal Time)"
        );
    }

    #[test]
    fn regexp_source_escapes_like_v8() {
        assert_eq!(regexp_source("a/b"), "a\\/b");
        assert_eq!(regexp_source("[/]"), "[/]");
        assert_eq!(regexp_source("\\/"), "\\/");
        assert_eq!(regexp_source(""), "(?:)");
        assert_eq!(regexp_source("x\ny"), "x\\ny");
        assert_eq!(regexp_source("a\u{2028}b\rc"), "a\\u2028b\\rc");
        assert_eq!(regexp_source("a\\\nb"), "a\\nb");
    }

    #[test]
    fn flags_follow_the_driver_and_regexp() {
        assert_eq!(js_flags("imx").ok().as_deref(), Some("im"));
        assert_eq!(js_flags("mi").ok().as_deref(), Some("im"));
        assert!(js_flags("ii").is_err());
        assert_eq!(
            js_regex("a", "s").err().map(|e| e.0).as_deref(),
            Some("The regular expression option [g] is not supported")
        );
    }

    #[test]
    fn date_strings() {
        assert_eq!(
            date_to_string(1_794_391_200_000),
            "Wed Nov 11 2026 10:00:00 GMT+0000 (Coordinated Universal Time)"
        );
        assert_eq!(
            date_json(0),
            serde_json::json!({"$date": "1970-01-01T00:00:00Z"})
        );
        assert_eq!(
            date_json(-1),
            serde_json::json!({"$date": {"$numberLong": "-1"}})
        );
    }
}
