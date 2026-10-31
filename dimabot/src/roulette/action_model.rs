//! Roulette winner-action identity and script checks.
//!
//! Ports `dimabot/src/roulette/action-model.ts`. The source file is the
//! `DrawActor` / `WinnerAction` contract. Syntax validation lives with the
//! service that refuses to store an item script: a non-empty action is
//! accepted only when `SyntaxEngine::typescript_compatible().parse` accepts
//! it, which is the native form of `parse(source).error` from
//! `utils/ast_parser/parser.ts`. Identity still comes only from the
//! authenticated API or the server AST context. An empty script is stored
//! and is not parsed.

#![cfg(feature = "widgets-runtime")]

use crate::roulette_runtime::model::{RouletteError, fail};
use crate::utils::ast_syntax::SyntaxEngine;
use crate::utils::js_string::JsString;
use crate::utils::lossless_json::JsonValue;
use serde::{Deserialize, Serialize};
use std::fmt;

/// Authenticated drawer. Optional `argument` is the literal AST argument.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DrawActor {
    pub user_id: String,
    pub user_login: String,
    pub user_display_name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub argument: Option<String>,
}

/// Persisted winner-action lifecycle. Discriminants match the source strings.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ActionStatus {
    Pending,
    Running,
    Done,
    Failed,
    Skipped,
}

impl ActionStatus {
    /// Wire discriminant (`pending`, `running`, `done`, `failed`, `skipped`).
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Running => "running",
            Self::Done => "done",
            Self::Failed => "failed",
            Self::Skipped => "skipped",
        }
    }
}

impl fmt::Display for ActionStatus {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

/// One delayed item script. `source` is the raw action text, not a rendered chat line.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WinnerAction {
    pub draw_id: String,
    pub roulette_id: String,
    pub item_id: String,
    pub label: String,
    pub source: String,
    pub due_at: i64,
    pub status: ActionStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub actor: Option<DrawActor>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started_at: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub finished_at: Option<i64>,
}

fn actor_string(value: Option<&JsonValue>, max: usize) -> Result<String, RouletteError> {
    match value {
        Some(JsonValue::String(text)) if text.len() <= max => text
            .as_str()
            .map(str::to_owned)
            .ok_or_else(|| fail("invalid", "Invalid draw actor", 400)),
        _ => Err(fail("invalid", "Invalid draw actor", 400)),
    }
}

/// Service gate: strings only, UTF-16 length above the cap is rejected.
/// Empty strings are accepted; `argument` may be absent.
pub fn parse_actor(value: &JsonValue) -> Result<DrawActor, RouletteError> {
    let JsonValue::Object(_) = value else {
        return Err(fail("invalid", "Invalid draw actor", 400));
    };
    let user_id = actor_string(value.get("userId"), 100)?;
    let user_login = actor_string(value.get("userLogin"), 100)?;
    let user_display_name = actor_string(value.get("userDisplayName"), 120)?;
    let argument = match value.get("argument") {
        None | Some(JsonValue::Null) => None,
        Some(JsonValue::String(argument)) if argument.len() <= 2000 => Some(
            argument
                .as_str()
                .ok_or_else(|| fail("invalid", "Invalid draw actor", 400))?
                .to_owned(),
        ),
        Some(_) => return Err(fail("invalid", "Invalid draw actor", 400)),
    };
    Ok(DrawActor {
        user_id,
        user_login,
        user_display_name,
        argument,
    })
}

/// Actor already built by a trusted caller. Same UTF-16 caps as `parse_actor`.
pub fn validate_actor(actor: &DrawActor) -> Result<(), RouletteError> {
    let argument = actor.argument.as_deref().unwrap_or("");
    if JsString::from(actor.user_id.as_str()).len() > 100
        || JsString::from(actor.user_login.as_str()).len() > 100
        || JsString::from(actor.user_display_name.as_str()).len() > 120
        || JsString::from(argument).len() > 2000
    {
        return Err(fail("invalid", "Invalid draw actor", 400));
    }
    Ok(())
}

/// Non-empty item scripts must parse. Empty text is allowed and is not parsed.
///
/// The TypeScript service only consults `parse().error`, which the legacy
/// parser sets on tokenizer failure. The native TypeScript-compatible engine
/// reports that same class of syntax failure as `Err`.
pub fn validate_action_syntax(source: &str) -> Result<(), RouletteError> {
    if source.is_empty() {
        return Ok(());
    }
    SyntaxEngine::typescript_compatible()
        .parse(source)
        .map(|_| ())
        .map_err(|_| fail("invalid_action", "Invalid AST syntax in item action", 400))
}

/// Service gate: `add`/`update` with an `action` field.
pub fn validate_action_field(value: &JsonValue) -> Result<String, RouletteError> {
    let source = crate::roulette_runtime::model::action_source(value)?;
    validate_action_syntax(&source)?;
    Ok(source)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn actor_json() -> JsonValue {
        JsonValue::Object(vec![
            (JsString::from("userId"), JsonValue::String(JsString::from("1"))),
            (JsString::from("userLogin"), JsonValue::String(JsString::from("ada"))),
            (
                JsString::from("userDisplayName"),
                JsonValue::String(JsString::from("Ada")),
            ),
        ])
    }

    #[test]
    fn actor_limits_match_the_service_gate() {
        let parsed = parse_actor(&actor_json()).expect("actor");
        assert_eq!(parsed.user_login, "ada");
        let mut huge = actor_json();
        if let JsonValue::Object(fields) = &mut huge {
            fields[0].1 = JsonValue::String(JsString::from("x".repeat(101)));
        }
        assert_eq!(parse_actor(&huge).unwrap_err().code, "invalid");
        let mut named = parsed.clone();
        named.argument = Some("a".repeat(2001));
        assert_eq!(validate_actor(&named).unwrap_err().code, "invalid");
    }

    #[test]
    fn empty_actions_skip_parse_and_broken_calls_do_not() {
        assert_eq!(validate_action_syntax("").unwrap(), ());
        assert_eq!(
            validate_action_field(&JsonValue::String(JsString::from(""))).unwrap(),
            ""
        );
        let error = validate_action_syntax("$(timer").unwrap_err();
        assert_eq!(error.code, "invalid_action");
        assert_eq!(error.message, "Invalid AST syntax in item action");
        assert!(validate_action_syntax("plain text").is_ok());
    }

    #[test]
    fn status_discriminants_are_the_source_strings() {
        assert_eq!(ActionStatus::Pending.as_str(), "pending");
        assert_eq!(ActionStatus::Running.as_str(), "running");
        assert_eq!(ActionStatus::Done.as_str(), "done");
        assert_eq!(ActionStatus::Failed.as_str(), "failed");
        assert_eq!(ActionStatus::Skipped.as_str(), "skipped");
    }
}
