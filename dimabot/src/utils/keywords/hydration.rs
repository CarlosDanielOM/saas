//! The Commands schema projection/defaults needed by keyword body reads.
//!
//! This ports the application schema behavior, not the Mongoose implementation.
//! Field names and JSON representations stay compatible with cached documents.

use super::KeywordNativeError;
use crate::utils::{credit_policy::JsDate, json_number};
use base64::{Engine, engine::general_purpose::STANDARD};
use mongodb::bson::{Bson, DateTime, Document};
use serde_json::{Map, Value, json};

pub fn command_body_from_document(
    mut row: Document,
    now: DateTime,
) -> Result<Value, KeywordNativeError> {
    for field in ["blocks", "availability", "availabilityLease"] {
        row.remove(field);
    }
    let variables = row.remove("variables");
    let Value::Object(mut body) = document_json(row) else {
        unreachable!("document conversion returns an object")
    };
    for (field, value) in [
        ("activation", json!("command")),
        ("message", json!("")),
        ("authoring", json!("text")),
        ("responses", json!([])),
        ("permissions", json!({})),
        ("type", json!("command")),
        ("platform", json!("twitch")),
        ("reserved", json!(false)),
        ("description", json!("No description provided.")),
        ("cooldown", json!(20)),
        ("count", json!(0)),
        ("userLevelName", json!("everyone")),
        ("userLevel", json!(0)),
        ("permissionExpression", Value::Null),
        ("enabled", json!(true)),
        ("paused", json!(false)),
        ("premiumRequired", json!(false)),
        ("premiumLevelRequired", json!(0)),
    ] {
        body.entry(field).or_insert(value);
    }
    if !body.contains_key("createdAt") {
        body.insert("createdAt".into(), date_json(now));
    }
    let (day, month, year) = local_calendar(now)?;
    if !body.contains_key("date") {
        body.insert("date".into(), json!({}));
    }
    if let Some(date) = body.get_mut("date").and_then(Value::as_object_mut) {
        date.entry("day").or_insert(json!(day));
        date.entry("month").or_insert(json!(month));
        date.entry("year").or_insert(json!(year));
    }
    // Nested keyword settings has its own default but no implicit parent.
    if let Some(settings) = body
        .get_mut("keywordSettings")
        .and_then(Value::as_object_mut)
    {
        settings.entry("matchMode").or_insert(json!("start"));
    }
    // A Mongoose Map flattens to a plain object without minimizing its empty
    // value; a plain empty permissions object is minimized away instead.
    let variables = match variables {
        None => json!({}),
        Some(Bson::Null) => Value::Null,
        Some(Bson::Document(values)) => {
            let mut map = Map::new();
            for (key, value) in values {
                let value = bson_json(value).unwrap_or(Value::Null);
                let string = match value {
                    Value::Null => Value::Null,
                    Value::String(_) => value,
                    Value::Bool(value) => json!(if value { "true" } else { "false" }),
                    Value::Number(value) => json!(json_number::number_string(
                        value.as_f64().unwrap_or(f64::NAN)
                    )),
                    _ => return Err(KeywordNativeError::InvalidCommandRow),
                };
                map.insert(key, string);
            }
            Value::Object(map)
        }
        _ => return Err(KeywordNativeError::InvalidCommandRow),
    };
    body.insert("variables".into(), variables);
    Ok(Value::Object(body))
}

/// Mongoose's default JSON serialization minimizes empty plain objects, while
/// retaining Maps and empty objects directly inside arrays. Uncached reads
/// retain defaults and empty objects just like the original document instance.
pub fn command_body_cache_value(body: &Value) -> Value {
    fn minimize(value: &Value, array_child: bool) -> Option<Value> {
        Some(match value {
            Value::Object(object) => {
                let object: Map<String, Value> = object
                    .iter()
                    .filter_map(|(key, value)| {
                        minimize(value, false).map(|value| (key.clone(), value))
                    })
                    .collect();
                if object.is_empty() && !array_child {
                    return None;
                }
                Value::Object(object)
            }
            Value::Array(values) => Value::Array(
                values
                    .iter()
                    .map(|value| minimize(value, true).unwrap_or(Value::Null))
                    .collect(),
            ),
            _ => value.clone(),
        })
    }
    let Some(object) = body.as_object() else {
        return body.clone();
    };
    Value::Object(
        object
            .iter()
            .filter_map(|(key, value)| {
                if key == "variables" {
                    Some((key.clone(), value.clone()))
                } else {
                    minimize(value, false).map(|value| (key.clone(), value))
                }
            })
            .collect(),
    )
}

fn date_json(value: DateTime) -> Value {
    JsDate::from_millis(value.timestamp_millis() as f64)
        .to_iso_string()
        .map_or(Value::Null, Value::String)
}
fn document_json(document: Document) -> Value {
    Value::Object(
        document
            .into_iter()
            .filter_map(|(key, value)| bson_json(value).map(|value| (key, value)))
            .collect(),
    )
}
fn bson_json(value: Bson) -> Option<Value> {
    Some(match value {
        Bson::Undefined => return None,
        Bson::Null => Value::Null,
        Bson::Boolean(value) => json!(value),
        Bson::String(value) => json!(value),
        Bson::Int32(value) => json!(value),
        Bson::Int64(value) => json!(value as f64),
        Bson::Double(value) => Value::from(value),
        Bson::ObjectId(value) => json!(value.to_hex()),
        Bson::DateTime(value) => date_json(value),
        Bson::Array(values) => Value::Array(
            values
                .into_iter()
                .map(|value| bson_json(value).unwrap_or(Value::Null))
                .collect(),
        ),
        Bson::Document(value) => document_json(value),
        Bson::Binary(value) => json!(STANDARD.encode(value.bytes)),
        Bson::RegularExpression(_) | Bson::MinKey | Bson::MaxKey => json!({}),
        Bson::Decimal128(value) => json!({"$numberDecimal":value.to_string()}),
        Bson::Timestamp(value) => {
            json!({"$timestamp":((u64::from(value.time)<<32)|u64::from(value.increment)).to_string()})
        }
        Bson::JavaScriptCode(code) => json!({"code":code}),
        Bson::JavaScriptCodeWithScope(value) => {
            json!({"code":value.code,"scope":document_json(value.scope)})
        }
        // Deprecated BSON DBPointer is not a Commands schema field. Retain its
        // driver-provided extended representation instead of dropping data.
        other => serde_json::to_value(other).expect("BSON DBPointer is JSON serializable"),
    })
}

#[cfg(unix)]
fn local_calendar(now: DateTime) -> Result<(i32, i32, i32), KeywordNativeError> {
    let seconds = now.timestamp_millis().div_euclid(1000) as _;
    let mut local: libc::tm = unsafe { std::mem::zeroed() };
    // localtime_r writes only caller-owned storage and preserves the process
    // timezone used by JavaScript's getDate/getMonth/getFullYear defaults.
    if unsafe { libc::localtime_r(&seconds, &mut local) }.is_null() {
        return Err(KeywordNativeError::InvalidClock);
    }
    Ok((local.tm_mday, local.tm_mon + 1, local.tm_year + 1900))
}
#[cfg(not(unix))]
fn local_calendar(_now: DateTime) -> Result<(i32, i32, i32), KeywordNativeError> {
    Err(KeywordNativeError::InvalidClock)
}
