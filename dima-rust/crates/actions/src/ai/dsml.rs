//! DSML tool-call recovery (`utils/ai/openrouter/ai.ts`, lines 541–611): some providers (DeepSeek
//! upstreams) return tool calls as DSML markup inside `message.content` instead of the structured
//! `tool_calls` field:
//!
//! ```text
//! <｜DSML｜tool_calls><｜DSML｜invoke name="X">
//! <｜DSML｜parameter name="y" string="true">value</｜DSML｜parameter>
//! </｜DSML｜invoke></｜DSML｜tool_calls>
//! ```
//!
//! Without recovery the markup leaks into chat as the bot's reply. [`strip_dsml_markup`] removes
//! it from text; [`recover_dsml_tool_calls`] turns it into the structured shape. The patterns are
//! the reference's regular expressions with JavaScript's `\s` spelled out (Rust's `\s` also
//! matches U+0085 and not U+FEFF); `$` is the end of the text (no `m` flag), and the lazy body
//! with its alternation keeps the reference's leftmost-first matching, so the same text gives the
//! same calls (recorded: `tests/ai_recorded.rs`).

use regex::Regex;
use serde_json::{Map, Value};
use std::sync::LazyLock;

/// `DSML_TOOL_CALLS_MARKER`.
pub const DSML_TOOL_CALLS_MARKER: &str = "<｜DSML｜tool_calls>";

/// JavaScript's `\s`.
const JS_SPACE: &str = r"[\t\n\x0B\x0C\r \u{A0}\u{1680}\u{2000}-\u{200A}\u{2028}\u{2029}\u{202F}\u{205F}\u{3000}\u{FEFF}]";

#[allow(clippy::expect_used)] // constant patterns, checked by the tests
static INVOKE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(
        r#"<｜DSML｜invoke name="([^"]+)"{JS_SPACE}*>((?s:.)*?)(?:</｜DSML｜invoke>|\z)"#
    ))
    .expect("the invoke pattern compiles")
});

#[allow(clippy::expect_used)] // constant patterns, checked by the tests
static PARAMETER: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(
        r#"<｜DSML｜parameter name="([^"]+)" string="(true|false)"{JS_SPACE}*>((?s:.)*?)(?:</｜DSML｜parameter>|\z)"#
    ))
    .expect("the parameter pattern compiles")
});

#[allow(clippy::expect_used)] // constant patterns, checked by the tests
static STRAY_TAG: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"</?｜DSML｜[^>]*>?").expect("the stray tag pattern compiles"));

/// `stripDsmlMarkup(content)`: the text before the DSML block (always the tail of the message),
/// stray DSML tags removed, trimmed. `""` when the message was only a tool call.
pub fn strip_dsml_markup(content: &str) -> String {
    let before = match content.find(DSML_TOOL_CALLS_MARKER) {
        Some(at) => content.get(..at).unwrap_or(content),
        None => content,
    };
    dima_text::trim(&STRAY_TAG.replace_all(before, "")).to_owned()
}

/// `recoverDsmlToolCalls(content)`: the invokes as structured tool calls (`{id, type:
/// "function", function: {name, arguments}}`), tolerant of truncated output (missing closing
/// tags); `None` when no invoke is found. `now_ms` is `Date.now()` for the ids
/// (`dsml_<now>_<n>`).
///
/// Each parameter's value is trimmed (JavaScript's `trim`); `string="true"` keeps it as text,
/// `true`/`false` become booleans, other text that `Number()` reads as a number (not `""`)
/// becomes that number (`JSON.stringify` writes a non-finite one as `null`), anything else
/// stays text. The arguments object enumerates as JavaScript's does (index-like names first; a
/// repeated name keeps its first place and its last value; `__proto__` is dropped, since
/// assigning a primitive to it sets nothing).
pub fn recover_dsml_tool_calls(content: &str, now_ms: i64) -> Option<Vec<Value>> {
    let mut recovered = Vec::new();
    for invoke in INVOKE.captures_iter(content) {
        let name = invoke.get(1).map_or("", |m| m.as_str());
        let body = invoke.get(2).map_or("", |m| m.as_str());
        let mut args = Map::new();
        for parameter in PARAMETER.captures_iter(body) {
            let param = parameter.get(1).map_or("", |m| m.as_str());
            let is_string = parameter.get(2).is_some_and(|m| m.as_str() == "true");
            let value = dima_text::trim(parameter.get(3).map_or("", |m| m.as_str()));
            if param == "__proto__" {
                continue;
            }
            let value = if is_string {
                Value::from(value)
            } else if value == "true" || value == "false" {
                Value::Bool(value == "true")
            } else {
                let number = dima_text::parse_number(value);
                if !value.is_empty() && !number.is_nan() {
                    dima_text::js_number_value(number)
                } else {
                    Value::from(value)
                }
            };
            args.insert(param.to_owned(), value);
        }
        let mut args = Value::Object(args);
        dima_text::js_key_order(&mut args);
        let index = recovered.len();
        recovered.push(serde_json::json!({
            "id": format!("dsml_{now_ms}_{index}"),
            "type": "function",
            "function": { "name": name, "arguments": dima_text::to_js_json(&args) },
        }));
    }
    (!recovered.is_empty()).then_some(recovered)
}

/// What the harness did with an assistant message that carried DSML markup.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DsmlOutcome {
    /// No markup (or structured tool calls were already there): nothing changed.
    Untouched,
    /// Tool calls were recovered into `tool_calls`; the content is the text before them, or
    /// removed when there was none (`cleanedContent || undefined`).
    Recovered(usize),
    /// No usable invoke: the markup was stripped from the content.
    Stripped,
}

/// The DSML fallback of the harness (`chat`, lines 1129–1163 of `ai.ts`, applied by
/// [`crate::ai::turn`] to every round): when the assistant message has no structured tool calls
/// and its content (text) holds the marker, recover the calls into `tool_calls` (dropping the
/// content when nothing else was said) or strip the markup.
pub fn apply_dsml_fallback(message: &mut Map<String, Value>, now_ms: i64) -> DsmlOutcome {
    let has_calls = message
        .get("tool_calls")
        .and_then(Value::as_array)
        .is_some_and(|calls| !calls.is_empty());
    let Some(content) = message.get("content").and_then(Value::as_str) else {
        return DsmlOutcome::Untouched;
    };
    if has_calls || !content.contains(DSML_TOOL_CALLS_MARKER) {
        return DsmlOutcome::Untouched;
    }
    let recovered = recover_dsml_tool_calls(content, now_ms);
    let cleaned = strip_dsml_markup(content);
    match recovered {
        Some(calls) => {
            let count = calls.len();
            message.insert("tool_calls".into(), Value::Array(calls));
            if cleaned.is_empty() {
                // `content = cleanedContent || undefined`: the key stays and is left out by
                // `JSON.stringify` when the message is sent back.
                message.remove("content");
            } else {
                message.insert("content".into(), Value::from(cleaned));
            }
            DsmlOutcome::Recovered(count)
        }
        None => {
            message.insert("content".into(), Value::from(cleaned));
            DsmlOutcome::Stripped
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn patterns_compile() {
        assert!(INVOKE.is_match(r#"<｜DSML｜invoke name="a">"#));
        assert!(PARAMETER.is_match(r#"<｜DSML｜parameter name="a" string="true">"#));
        assert!(STRAY_TAG.is_match("</｜DSML｜x>"));
    }

    #[test]
    fn javascript_space_is_not_rusts() {
        // U+FEFF is JavaScript whitespace; U+0085 is not.
        assert!(recover_dsml_tool_calls("<｜DSML｜invoke name=\"a\"\u{FEFF}>", 1).is_some());
        assert!(recover_dsml_tool_calls("<｜DSML｜invoke name=\"a\"\u{85}>", 1).is_none());
    }
}
