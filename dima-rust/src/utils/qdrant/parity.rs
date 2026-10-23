//! Pure source-contract helpers, exposed for independent TypeScript-oracle
//! tests. JS `||`, numeric coercion, UTF-16 lengths, and whitespace are retained
//! instead of silently substituting Rust defaults.

use super::{ChatWindowItem, RetrievedMemoryItem, SemanticChatItem};
use crate::utils::js_compat::trim;
use md5::{Digest, Md5};
use regex::Regex;
use serde_json::{Number, Value};
use std::{collections::HashSet, sync::LazyLock};

/// The first eight hexadecimal MD5 digits, interpreted as an unsigned integer.
/// The historical 32-bit collisions are preserved; memory writes/deletes check
/// payload ownership. Chat upserts intentionally retain their collision policy.
pub fn generate_qdrant_point_id(namespace: &str, entity_id: &str, timestamp: f64) -> u32 {
    let input = format!("{namespace}:{entity_id}:{}", js_number_string(timestamp));
    let digest = Md5::digest(input.as_bytes());
    u32::from_be_bytes([digest[0], digest[1], digest[2], digest[3]])
}

pub fn qdrant_point_belongs_to_memory(
    payload: Option<&Value>,
    memory_id: &str,
    channel_id: &str,
) -> bool {
    let payload = payload.unwrap_or(&Value::Null);
    string_or(&payload["memory_id"], "") == memory_id
        && string_or(&payload["channel_id"], "") == channel_id
}

pub fn build_memory_embedding_input(summary: &str, content: &str) -> String {
    trim(&format!("{}\n{}", trim(summary), trim(content))).to_owned()
}

pub const PASSIVE_CANDIDATE_SCORE: f64 = 0.45;
pub const PASSIVE_STRONG_SCORE: f64 = 0.72;
static WORDS: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"[\p{L}\p{N}_]{4,}").expect("static Unicode regex"));
const COMMON_WORDS: &[&str] = &[
    "about",
    "channel",
    "could",
    "does",
    "from",
    "have",
    "know",
    "memory",
    "memories",
    "remember",
    "that",
    "their",
    "them",
    "this",
    "what",
    "when",
    "where",
    "which",
    "with",
    "would",
    "canal",
    "como",
    "cual",
    "donde",
    "esto",
    "memoria",
    "memorias",
    "para",
    "porque",
    "recuerda",
    "recuerdas",
    "sabes",
    "sobre",
    "tiene",
];
fn distinctive_words(value: &str) -> HashSet<String> {
    WORDS
        .find_iter(&value.to_lowercase())
        .map(|m| m.as_str().to_owned())
        .filter(|word| !COMMON_WORDS.contains(&word.as_str()))
        .collect()
}
pub fn is_passive_memory_relevant(query: &str, summary: &str, score: f64) -> bool {
    if score >= PASSIVE_STRONG_SCORE {
        return true;
    }
    if score < PASSIVE_CANDIDATE_SCORE {
        return false;
    }
    let query = distinctive_words(query);
    !query.is_empty()
        && distinctive_words(summary)
            .iter()
            .any(|word| query.contains(word))
}

pub fn get_semantic_memory_limit_for_tier(tier: &str) -> usize {
    match tier {
        "pro" => 15,
        "premium" => 6,
        _ => 3,
    }
}

/// Preserve first duplicate, then sort by score and timestamp. A repeated
/// phrase with a later/higher-score point does not replace the first point.
pub fn select_semantic_chat_items(
    channel_id: &str,
    points: &[Value],
    threshold: f64,
    limit: usize,
) -> Vec<SemanticChatItem> {
    let mut seen = HashSet::new();
    let mut items: Vec<_> = points
        .iter()
        .filter_map(parse_semantic_chat_point)
        .filter(|item| item.channel_id == channel_id && item.score >= threshold)
        .filter(|item| {
            item.message.encode_utf16().count() >= 3 && seen.insert(item.message.clone())
        })
        .collect();
    items.sort_by(|a, b| {
        descending(a.score, b.score).then_with(|| {
            if a.score == b.score {
                descending(a.timestamp, b.timestamp)
            } else {
                std::cmp::Ordering::Equal
            }
        })
    });
    items.truncate(limit);
    items
}
pub fn parse_semantic_chat_point(point: &Value) -> Option<SemanticChatItem> {
    let payload = &point["payload"];
    let message = trim(&string_or(&payload["message"], "")).to_owned();
    let channel_id = trim(&string_or(&payload["channel_id"], "")).to_owned();
    if message.is_empty() || channel_id.is_empty() {
        return None;
    }
    let score = point
        .get("score")
        .filter(|v| !v.is_null())
        .unwrap_or(&point["distance"]);
    Some(SemanticChatItem {
        score: number_or_zero(score),
        channel_id,
        username: string_or(&payload["username"], "unknown"),
        user_id: string_or(&payload["user_id"], "unknown"),
        message,
        timestamp: number_or_zero(&payload["timestamp"]),
        language: optional_string(&payload["language"]),
    })
}
pub fn parse_chat_window_point(point: &Value) -> Option<ChatWindowItem> {
    let payload = &point["payload"];
    let message = trim(&string_or(&payload["message"], "")).to_owned();
    let channel_id = trim(&string_or(&payload["channel_id"], "")).to_owned();
    let timestamp = normalize_timestamp(&payload["timestamp"]);
    if message.is_empty() || channel_id.is_empty() || timestamp <= 0.0 {
        return None;
    }
    Some(ChatWindowItem {
        channel_id,
        username: string_or(&payload["username"], "unknown"),
        user_id: string_or(&payload["user_id"], "unknown"),
        message,
        timestamp,
        language: optional_string(&payload["language"]),
    })
}
pub fn parse_memory_point(point: &Value) -> Option<RetrievedMemoryItem> {
    let payload = &point["payload"];
    let content = trim(&string_or(&payload["content"], "")).to_owned();
    let channel_id = trim(&string_or(&payload["channel_id"], "")).to_owned();
    let memory_id = trim(&if truthy(&payload["memory_id"]) {
        js_string(&payload["memory_id"])
    } else {
        string_or(&point["id"], "")
    })
    .to_owned();
    if content.is_empty() || channel_id.is_empty() || memory_id.is_empty() {
        return None;
    }
    let raw_score = point
        .get("score")
        .filter(|v| !v.is_null())
        .unwrap_or(&point["distance"]);
    Some(RetrievedMemoryItem {
        score: raw_score.as_f64().unwrap_or(0.0),
        qdrant_point_id: if point["id"].is_null() {
            String::new()
        } else {
            js_string(&point["id"])
        },
        memory_id,
        channel_id,
        memory_type: string_or(&payload["memory_type"], "channel_lore"),
        status: string_or(&payload["status"], "confirmed"),
        risk: string_or(&payload["risk"], "low"),
        confidence: number_or_zero(&payload["confidence"]),
        subject_scope: string_or(&payload["subject_scope"], "channel"),
        subject_username: optional_string(&payload["subject_username"]),
        subject_user_id: optional_string(&payload["subject_user_id"]),
        summary: string_or(&payload["summary"], &content),
        content,
        updated_at: number_or_zero(&payload["updated_at"]),
    })
}

/// REST/client-shaped results accepted by TS query/search/queryPoints fallbacks.
/// The native backend returns a points vector directly; custom REST adapters
/// can reuse this normalization without changing the retrieval algorithms.
pub fn normalize_qdrant_points(raw: &Value) -> Vec<Value> {
    raw.as_array()
        .or_else(|| raw["points"].as_array())
        .or_else(|| raw["result"].as_array())
        .or_else(|| raw["hits"].as_array())
        .cloned()
        .unwrap_or_default()
}

pub(crate) fn descending(a: f64, b: f64) -> std::cmp::Ordering {
    b.partial_cmp(&a).unwrap_or(std::cmp::Ordering::Equal)
}
pub(crate) fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(v) => *v,
        Value::Number(v) => v.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Value::String(v) => !v.is_empty(),
        _ => true,
    }
}
pub(crate) fn js_string(value: &Value) -> String {
    match value {
        Value::Null => "null".into(),
        Value::Bool(v) => v.to_string(),
        Value::Number(v) => js_number_string(v.as_f64().unwrap_or(f64::NAN)),
        Value::String(v) => v.clone(),
        Value::Array(v) => v
            .iter()
            .map(|v| {
                if v.is_null() {
                    String::new()
                } else {
                    js_string(v)
                }
            })
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".into(),
    }
}
pub(crate) fn string_or(value: &Value, default: &str) -> String {
    if truthy(value) {
        js_string(value)
    } else {
        default.to_owned()
    }
}
fn optional_string(value: &Value) -> Option<String> {
    truthy(value).then(|| js_string(value))
}
pub(crate) fn js_number(value: &Value) -> f64 {
    match value {
        Value::Null => 0.0,
        Value::Bool(v) => {
            if *v {
                1.0
            } else {
                0.0
            }
        }
        Value::Number(v) => v.as_f64().unwrap_or(f64::NAN),
        Value::String(v) => {
            let value = trim(v);
            if value.is_empty() {
                return 0.0;
            }
            for (prefix, radix) in [
                ("0x", 16),
                ("0X", 16),
                ("0b", 2),
                ("0B", 2),
                ("0o", 8),
                ("0O", 8),
            ] {
                if let Some(digits) = value.strip_prefix(prefix) {
                    return u64::from_str_radix(digits, radix)
                        .map(|n| n as f64)
                        .unwrap_or(f64::NAN);
                }
            }
            if matches!(
                value,
                "inf" | "+inf" | "-inf" | "infinity" | "+infinity" | "-infinity"
            ) {
                return f64::NAN;
            }
            value.parse().unwrap_or(f64::NAN)
        }
        Value::Array(_) => js_number(&Value::String(js_string(value))),
        Value::Object(_) => f64::NAN,
    }
}
fn number_or_zero(value: &Value) -> f64 {
    if truthy(value) { js_number(value) } else { 0.0 }
}
pub(crate) fn normalize_timestamp(value: &Value) -> f64 {
    let value = js_number(value);
    if value.is_finite() {
        value.floor()
    } else {
        0.0
    }
}
pub(crate) fn js_number_string(value: f64) -> String {
    if value == 0.0 {
        return "0".into();
    }
    if value.is_nan() {
        return "NaN".into();
    }
    if value == f64::INFINITY {
        return "Infinity".into();
    }
    if value == f64::NEG_INFINITY {
        return "-Infinity".into();
    }
    if value.abs() >= 1e21 || value.abs() < 1e-6 {
        let scientific = format!("{value:e}");
        if let Some((mantissa, exponent)) = scientific.split_once('e') {
            let exponent = exponent.parse::<i32>().unwrap_or(0);
            return format!(
                "{mantissa}e{}{exponent}",
                if exponent >= 0 { "+" } else { "" }
            );
        }
    }
    value.to_string()
}

/// Match Node's JSON integer encoding before converting to Qdrant Value:
/// integral i64-range numbers use IntegerValue, fractions use DoubleValue.
/// Nonfinite numbers serialize as null, matching JSON.stringify.
pub fn qdrant_number_payload(value: f64) -> Value {
    if !value.is_finite() {
        return Value::Null;
    }
    if value.fract() == 0.0 {
        // Parse the JSON decimal rather than casting the binary f64: beyond
        // 2^53 the shortest JSON integer can differ from that binary integer.
        if let Ok(integer) = js_number_string(value).parse::<i64>() {
            return Value::Number(Number::from(integer));
        }
    }
    Number::from_f64(value)
        .map(Value::Number)
        .unwrap_or(Value::Null)
}
