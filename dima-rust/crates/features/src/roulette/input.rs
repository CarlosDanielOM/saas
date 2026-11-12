//! The roulette's error and its input checks (`roulette/model.ts:6-51`), which the duel and the
//! widgets reuse (`duel/model.ts:2`, `widgets/model.ts:3`).
//!
//! Inputs are JSON as a request body or a tool call carries it; numbers are JavaScript numbers.
//! Text limits count characters (`MIGRATION.md` section 4, first row); `trim` is JavaScript's.

use serde_json::{Map, Value};

/// `Number.MAX_SAFE_INTEGER`.
pub const MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;

/// `RouletteError`: a refusal with a code, the reference's message, the HTTP status, and the
/// 1-based import row that caused it.
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
#[error("{message}")]
pub struct RouletteError {
    /// `code` (`invalid`, `not_found`, `spinning`, `revision_conflict`...).
    pub code: String,
    /// The message shown to the streamer (and in chat by the host functions).
    pub message: String,
    /// The HTTP status.
    pub status: u16,
    /// `row`: the import row, when there is one.
    pub row: Option<usize>,
}

impl RouletteError {
    /// `fail(code, message, status)`.
    pub fn new(code: &str, message: impl Into<String>, status: u16) -> Self {
        Self {
            code: code.to_owned(),
            message: message.into(),
            status,
            row: None,
        }
    }

    /// A 400 `invalid`.
    pub fn invalid(message: impl Into<String>) -> Self {
        Self::new("invalid", message, 400)
    }

    /// The error body the routes send: `{ error, status, code, message, row? }`.
    pub fn to_json(&self) -> Value {
        let mut body = Map::new();
        body.insert("error".into(), Value::Bool(true));
        body.insert("status".into(), Value::from(self.status));
        body.insert("code".into(), Value::from(self.code.clone()));
        body.insert("message".into(), Value::from(self.message.clone()));
        if let Some(row) = self.row {
            body.insert("row".into(), Value::from(row));
        }
        Value::Object(body)
    }
}

/// `object(value)`: a plain object, or 400 "Expected an object".
pub fn object(value: &Value) -> Result<&Map<String, Value>, RouletteError> {
    value
        .as_object()
        .ok_or_else(|| RouletteError::invalid("Expected an object"))
}

/// `text(value, field, max)`: a string whose trimmed form has 1 to `max` characters; returns
/// it trimmed.
pub fn text(value: Option<&Value>, field: &str, max: usize) -> Result<String, RouletteError> {
    match value {
        Some(Value::String(raw)) => text_str(raw, field, max),
        _ => Err(text_error(field, max)),
    }
}

/// [`text`] of a string the caller already has.
pub fn text_str(raw: &str, field: &str, max: usize) -> Result<String, RouletteError> {
    let trimmed = dima_text::trim(raw);
    if trimmed.is_empty() || dima_text::char_len(trimmed) > max {
        return Err(text_error(field, max));
    }
    Ok(trimmed.to_owned())
}

fn text_error(field: &str, max: usize) -> RouletteError {
    RouletteError::invalid(format!("{field} must contain 1–{max} characters"))
}

/// `integer(value, field, min, max)` of a JSON value: a safe integer in `[min, max]`.
pub fn integer(
    value: Option<&Value>,
    field: &str,
    min: i64,
    max: i64,
) -> Result<i64, RouletteError> {
    integer_number(value.and_then(Value::as_f64), field, min, max)
}

/// [`integer`] of a JavaScript number (`integer(Number(text), …)`: `None` is not a number).
pub fn integer_number(
    value: Option<f64>,
    field: &str,
    min: i64,
    max: i64,
) -> Result<i64, RouletteError> {
    match value {
        Some(n)
            if n.fract() == 0.0
                && n.abs() <= MAX_SAFE_INTEGER as f64
                && n >= min as f64
                && n <= max as f64 =>
        {
            Ok(n as i64)
        }
        _ => Err(RouletteError::invalid(format!(
            "{field} must be an integer between {min} and {max}"
        ))),
    }
}

/// The longest item action, in characters (`actionSource`).
pub const MAX_ACTION_CHARS: usize = 8000;

/// `actionSource(value)`: text up to [`MAX_ACTION_CHARS`] characters, trimmed (empty allowed).
pub fn action_source(value: &Value) -> Result<String, RouletteError> {
    match value {
        Value::String(raw) if dima_text::char_len(raw) <= MAX_ACTION_CHARS => {
            Ok(dima_text::trim(raw).to_owned())
        }
        _ => Err(RouletteError::invalid(
            "Item action must be text up to 8000 characters",
        )),
    }
}

/// `choice(value, allowed, field)`.
pub(crate) fn choice<'a>(
    value: &Value,
    allowed: &[&'a str],
    field: &str,
) -> Result<&'a str, RouletteError> {
    value
        .as_str()
        .and_then(|v| allowed.iter().find(|a| **a == v).copied())
        .ok_or_else(|| RouletteError::invalid(format!("Invalid {field}")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn checks_carry_the_reference_messages() {
        assert_eq!(
            text(Some(&json!("  ")), "name", 120).unwrap_err().message,
            "name must contain 1–120 characters"
        );
        assert_eq!(text(Some(&json!(" 👋 ")), "name", 1).unwrap(), "👋");
        assert_eq!(
            integer(Some(&json!(1.5)), "weight", 1, MAX_SAFE_INTEGER)
                .unwrap_err()
                .message,
            "weight must be an integer between 1 and 9007199254740991"
        );
        assert_eq!(integer(Some(&json!(3)), "x", 1, 3).unwrap(), 3);
        assert!(integer(Some(&json!("3")), "x", 1, 3).is_err());
        assert_eq!(action_source(&json!("  $(user) ")).unwrap(), "$(user)");
        assert!(action_source(&json!("a".repeat(8001))).is_err());
        assert!(action_source(&json!("👋".repeat(8000))).is_ok());
    }
}
