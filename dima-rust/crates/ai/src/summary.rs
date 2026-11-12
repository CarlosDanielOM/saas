//! Stream-summary schema and pure normalization. No model or store calls.
//!
//! Schema lengths (headline 120, recap 2000, highlight 500) are our storage/text
//! validation limits, counted in scalars. The schema sent to the provider is
//! preserved verbatim; provider maxLength numbers remain 120/2000/500.
//! Array bounds: 8 highlights, 50 parsed actions, 8 evidence strings. The sanitizer
//! takes a typed action cap (startup default 24, minimum 5). Diagnostic snippets
//! use 800 scalars for schema errors and at most 160 for JSON syntax errors.
//! Schema diagnostics preserve reference text. JSON correction prompts deliberately
//! use Rust's clear parser diagnostic rather than JavaScript runtime wording:
//! every syntax error names line and column (including EOF), with no model text
//! in the diagnostic and only the short raw_snippet excerpt. Parser wording is
//! an accepted migration difference, not an unresolved parity gap.
//! Quirk: runtime accepts arbitrary action type strings although provider schema
//! restricts the type enum; nulls are rejected despite the reference's comment.
use serde::{Deserialize, Serialize};
use serde_json::Value;
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ActionKind {
    Create,
    Edit,
    Archive,
    Delete,
    Noop,
}
fn low() -> crate::memory::Risk {
    crate::memory::Risk::Low
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Action {
    pub action: ActionKind,
    #[serde(default, rename = "type")]
    pub kind: String,
    #[serde(default)]
    pub target_memory_id: String,
    #[serde(default)]
    pub summary: String,
    #[serde(default)]
    pub content: String,
    #[serde(default)]
    pub confidence: f64,
    #[serde(default = "low")]
    pub risk: crate::memory::Risk,
    #[serde(default)]
    pub reason: String,
    #[serde(default)]
    pub evidence: Vec<String>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Summary {
    pub headline: String,
    pub recap: String,
    pub highlights: Vec<String>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Response {
    pub summary: Summary,
    pub actions: Vec<Action>,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Phase {
    Empty,
    Json,
    Schema,
}
#[derive(Debug, thiserror::Error)]
#[error("Stream summary failed in {phase:?}: {detail}")]
pub struct ParseError {
    pub phase: Phase,
    pub detail: String,
    pub raw_snippet: String,
}
fn failure(phase: Phase, detail: impl Into<String>, raw: &str) -> ParseError {
    ParseError {
        phase,
        detail: detail.into(),
        raw_snippet: dima_text::truncate_chars(raw, 800).into(),
    }
}
/// Exact schema offered to OpenRouter; object order retained from the reference.
pub fn provider_schema() -> Result<Value, serde_json::Error> {
    serde_json::from_str(include_str!("summary_schema.json"))
}
pub fn validate(value: Value) -> Result<Response, ParseError> {
    let mut issues = Vec::new();
    let summary = value.get("summary");
    if check_type(summary, "object", "summary", &mut issues) {
        let summary = &value["summary"];
        check_string(
            summary.get("headline"),
            "summary.headline",
            1,
            120,
            &mut issues,
        );
        check_string(summary.get("recap"), "summary.recap", 1, 2000, &mut issues);
        if check_type(
            summary.get("highlights"),
            "array",
            "summary.highlights",
            &mut issues,
        ) && let Some(a) = summary["highlights"].as_array()
        {
            for (i, v) in a.iter().enumerate() {
                check_string(
                    Some(v),
                    &format!("summary.highlights.{i}"),
                    0,
                    500,
                    &mut issues,
                );
            }
            array_max(a.len(), 8, "summary.highlights", &mut issues);
        }
    }
    if check_type(value.get("actions"), "array", "actions", &mut issues)
        && let Some(a) = value["actions"].as_array()
    {
        for (i, v) in a.iter().enumerate() {
            let path = format!("actions.{i}");
            if !check_type(Some(v), "object", &path, &mut issues) {
                continue;
            }
            check_enum(
                v.get("action"),
                &["create", "edit", "archive", "delete", "noop"],
                &format!("{path}.action"),
                &mut issues,
            );
            for key in ["type", "targetMemoryId", "summary", "content"] {
                if v.get(key).is_some() {
                    check_type(v.get(key), "string", &format!("{path}.{key}"), &mut issues);
                }
            }
            if let Some(n) = v.get("confidence")
                && check_type(
                    Some(n),
                    "number",
                    &format!("{path}.confidence"),
                    &mut issues,
                )
            {
                let n = n.as_f64().unwrap_or(0.0);
                if n < 0.0 {
                    issues.push(format!(
                        "{path}.confidence: Too small: expected number to be >=0"
                    ));
                }
                if n > 1.0 {
                    issues.push(format!(
                        "{path}.confidence: Too big: expected number to be <=1"
                    ));
                }
            }
            if v.get("risk").is_some() {
                check_enum(
                    v.get("risk"),
                    &["low", "medium", "high"],
                    &format!("{path}.risk"),
                    &mut issues,
                );
            }
            if v.get("reason").is_some() {
                check_type(
                    v.get("reason"),
                    "string",
                    &format!("{path}.reason"),
                    &mut issues,
                );
            }
            if v.get("evidence").is_some()
                && check_type(
                    v.get("evidence"),
                    "array",
                    &format!("{path}.evidence"),
                    &mut issues,
                )
                && let Some(a) = v["evidence"].as_array()
            {
                for (i, v) in a.iter().enumerate() {
                    check_type(
                        Some(v),
                        "string",
                        &format!("{path}.evidence.{i}"),
                        &mut issues,
                    );
                }
            }
        }
        array_max(a.len(), 50, "actions", &mut issues);
    }
    if !issues.is_empty() {
        return Err(failure(
            Phase::Schema,
            format!("Schema validation failed: {}", issues.join("; ")),
            "",
        ));
    }
    serde_json::from_value(value).map_err(|_| failure(Phase::Schema, "Invalid summary fields", ""))
}
fn type_name(v: Option<&Value>) -> &'static str {
    match v {
        None => "undefined",
        Some(Value::Null) => "null",
        Some(Value::Bool(_)) => "boolean",
        Some(Value::Number(_)) => "number",
        Some(Value::String(_)) => "string",
        Some(Value::Array(_)) => "array",
        Some(Value::Object(_)) => "object",
    }
}
fn check_type(v: Option<&Value>, expected: &str, path: &str, issues: &mut Vec<String>) -> bool {
    let actual = type_name(v);
    if actual == expected {
        true
    } else {
        issues.push(format!(
            "{path}: Invalid input: expected {expected}, received {actual}"
        ));
        false
    }
}
fn check_string(v: Option<&Value>, path: &str, min: usize, max: usize, issues: &mut Vec<String>) {
    if check_type(v, "string", path, issues)
        && let Some(s) = v.and_then(Value::as_str)
    {
        let n = s.chars().count();
        if n < min {
            issues.push(format!(
                "{path}: Too small: expected string to have >={min} characters"
            ));
        }
        if n > max {
            issues.push(format!(
                "{path}: Too big: expected string to have <={max} characters"
            ));
        }
    }
}
fn check_enum(v: Option<&Value>, options: &[&str], path: &str, issues: &mut Vec<String>) {
    if !v
        .and_then(Value::as_str)
        .is_some_and(|s| options.contains(&s))
    {
        issues.push(format!(
            "{path}: Invalid option: expected one of {}",
            options
                .iter()
                .map(|s| format!("\"{s}\""))
                .collect::<Vec<_>>()
                .join("|")
        ));
    }
}
fn array_max(n: usize, max: usize, path: &str, issues: &mut Vec<String>) {
    if n > max {
        issues.push(format!(
            "{path}: Too big: expected array to have <={max} items"
        ));
    }
}

pub fn parse_stream_summary_response(raw: &str) -> Result<Response, ParseError> {
    if raw.is_empty() {
        return Err(failure(Phase::Empty, "Empty response from LLM", ""));
    }
    let mut cleaned = dima_text::trim(raw);
    if let Some(rest) = cleaned.strip_prefix("```") {
        cleaned = rest.strip_prefix("json").unwrap_or(rest);
        cleaned = dima_text::trim(cleaned);
        cleaned = cleaned.strip_suffix("```").unwrap_or(cleaned);
        cleaned = dima_text::trim(cleaned);
    }
    if cleaned.is_empty() {
        return Err(failure(
            Phase::Empty,
            "Response was empty after stripping markdown fences",
            raw,
        ));
    }
    let value: Value =
        serde_json::from_slice(dima_text::sanitize_lone_surrogates(cleaned.as_bytes()).as_ref())
            .map_err(|e: serde_json::Error| {
                let mut error = failure(Phase::Json, format!("JSON parse error: {e}"), "");
                error.raw_snippet = dima_text::truncate_chars(cleaned, 160).into();
                error
            })?;
    if !value.is_object() {
        return Err(failure(
            Phase::Json,
            "Response is not a JSON object",
            cleaned,
        ));
    }
    validate(value).map_err(|mut e| {
        e.raw_snippet = dima_text::truncate_chars(cleaned, 800).into();
        e
    })
}
pub fn sanitize_stream_summary_response(
    mut r: Response,
    default_headline: &str,
    default_recap: &str,
    max_actions: usize,
) -> Response {
    r.summary.headline = dima_text::trim(&r.summary.headline).into();
    if r.summary.headline.is_empty() {
        r.summary.headline = default_headline.into();
    }
    r.summary.recap = dima_text::trim(&r.summary.recap).into();
    if r.summary.recap.is_empty() {
        r.summary.recap = default_recap.into();
    }
    r.summary.highlights = r
        .summary
        .highlights
        .into_iter()
        .map(|s| dima_text::trim(&s).into())
        .filter(|s: &String| !s.is_empty())
        .take(8)
        .collect();
    for a in &mut r.actions {
        for s in [
            &mut a.kind,
            &mut a.target_memory_id,
            &mut a.summary,
            &mut a.content,
            &mut a.reason,
        ] {
            *s = dima_text::trim(s).into();
        }
        a.confidence = if a.confidence.is_finite() {
            a.confidence.clamp(0.0, 1.0)
        } else {
            0.0
        };
        a.evidence = a
            .evidence
            .iter()
            .map(|s| dima_text::trim(s).into())
            .filter(|s: &String| !s.is_empty())
            .take(8)
            .collect();
    }
    r.actions.truncate(max_actions.max(5));
    r
}
