//! The user level a command body is evaluated with (reference:
//! `handlers/special_parser.userlevel.ts`, called by `special_parser.handler.ts` for every
//! evaluation; the engine host package uses it).
//!
//! The event is the untyped event data the evaluation runs for (a chat message, a redemption, a
//! synthetic event), read as JavaScript reads it.

use serde_json::Value;

use crate::value::{JsView, js_string, js_truthy};

/// The badge set ids that make a chatter a moderator.
pub const MODERATOR_BADGE_IDS: [&str; 4] = ["moderator", "lead_mod", "lead_moderator", "mod"];

/// The broadcaster's level, given to events without a chatter.
pub const NO_CHATTER_USER_LEVEL: f64 = 10.0;

fn property<'a>(value: &'a Value, key: &str) -> Option<&'a Value> {
    match value {
        Value::Object(_) => JsView::get(value, key),
        _ => None,
    }
}

/// `inferUserLevelFromBadges`: 7 when a badge's `set_id || id` (as text, lowercased) is a
/// moderator badge, else 1.
pub fn user_level_from_badges(event: &Value) -> f64 {
    let Some(Value::Array(badges)) = property(event, "badges") else {
        return 1.0;
    };
    for badge in badges {
        let set_id = property(badge, "set_id").filter(|value| js_truthy(*value));
        let id = set_id.or_else(|| property(badge, "id").filter(|value| js_truthy(*value)));
        let text = id.map(js_string).unwrap_or_default();
        if MODERATOR_BADGE_IDS.contains(&dima_text::to_lower(&text).as_str()) {
            return 7.0;
        }
    }
    1.0
}

/// `resolveAuthoredAstUserLevel(eventData, providedUserLevel)`: the larger of the given level
/// (when it is a finite number) and the badges' level; without a given level, 10 for an event
/// with no chatter identity (`chatter_user_id`, `chatter_user_login`, `chatter_user_name` all
/// falsy), the badges' level otherwise.
pub fn resolve_authored_user_level(event: &Value, provided: Option<f64>) -> f64 {
    let inferred = user_level_from_badges(event);
    if let Some(level) = provided.filter(|level| level.is_finite()) {
        return level.max(inferred);
    }
    let identity = ["chatter_user_id", "chatter_user_login", "chatter_user_name"]
        .iter()
        .any(|key| property(event, key).is_some_and(js_truthy));
    if identity {
        inferred
    } else {
        NO_CHATTER_USER_LEVEL
    }
}
