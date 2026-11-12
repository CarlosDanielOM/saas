//! Pure source-contract helpers, exposed for independent TypeScript-oracle
//! tests. JS coercion and whitespace come from dima-text. The semantic message
//! minimum deliberately counts Unicode scalars under MIGRATION.md section 4.

use super::{ChatWindowItem, RetrievedMemoryItem, SemanticChatItem};
use dima_text::{number_to_string as js_number_string, trim};

use serde_json::Value;
use std::collections::HashSet;

/// The first eight hexadecimal MD5 digits, interpreted as an unsigned integer.
/// The historical 32-bit collisions are preserved; memory writes/deletes check
/// payload ownership. Chat upserts intentionally retain their collision policy.
pub fn generate_qdrant_point_id(namespace: &str, entity_id: &str, timestamp: f64) -> u32 {
    let input = format!("{namespace}:{entity_id}:{}", js_number_string(timestamp));
    let digest = dima_core::crypto::md5(input.as_bytes()).0;
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
static WORDS: std::sync::LazyLock<Result<regex::Regex, regex::Error>> =
    std::sync::LazyLock::new(|| regex::Regex::new(r"[\p{L}\p{N}_]{4,}"));
fn distinctive_words(value: &str) -> HashSet<String> {
    let Ok(words) = WORDS.as_ref() else {
        return HashSet::new();
    };
    words
        .find_iter(&dima_text::to_lower(value))
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
        .filter(|item| item.message.chars().count() >= 3 && seen.insert(item.message.clone()))
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
pub(crate) use dima_text::{js_number, js_string, js_truthy as truthy};
pub(crate) fn string_or(value: &Value, default: &str) -> String {
    if truthy(value) {
        js_string(value)
    } else {
        default.into()
    }
}
fn optional_string(value: &Value) -> Option<String> {
    truthy(value).then(|| js_string(value))
}
fn number_or_zero(value: &Value) -> f64 {
    if truthy(value) { js_number(value) } else { 0.0 }
}
pub(crate) fn normalize_timestamp(value: &Value) -> f64 {
    let n = js_number(value);
    if n.is_finite() { n.floor() } else { 0.0 }
}
