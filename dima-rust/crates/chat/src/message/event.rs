//! The chat message as the handler reads it (`IChatMessage`): the event Twitch sent, kept whole
//! for the command language and the recorders, and its fields read once, as JavaScript reads
//! them.
//!
//! Twitch sends every field as text; a field of another type is read as absent (the reference
//! compares with `===` and calls string methods, so the same message would fail or not match
//! there). The one field the reference cannot do without is the text: an event without
//! `message.text` is refused before anything happens (the reference ran its first steps, then
//! threw at `text.match`: intended difference, `MessageError::NoText`).

use dima_commands::permissions::ChatAuthor;
use dima_stream::stream_activity::{Fragment, FragmentEmote};
use dima_twitch::badges::Badge;
use serde_json::{Map, Value};

/// One chat message (`channel.chat.message`).
#[derive(Clone, Debug)]
pub struct ChatEvent {
    /// The event as Twitch sent it (the command language's `eventData`).
    pub json: Value,
    /// `broadcaster_user_id`.
    pub broadcaster_user_id: Option<String>,
    /// `chatter_user_id`.
    pub chatter_user_id: Option<String>,
    /// `chatter_user_login`.
    pub chatter_user_login: Option<String>,
    /// `chatter_user_name`.
    pub chatter_user_name: Option<String>,
    /// `message_id`.
    pub message_id: Option<String>,
    /// `message.text`.
    pub text: String,
    /// `badges`, each field as text (`''` when absent).
    pub badges: Vec<Badge>,
    /// The badge set ids identity resolution reads: `set_id ?? id`, as text (`badgeSetIds`).
    pub badge_set_ids: Vec<String>,
    /// `source_broadcaster_user_id` (shared chat).
    pub source_broadcaster_user_id: Option<String>,
}

/// Why an event is not a chat message the handler can read.
#[derive(Clone, Copy, Debug, PartialEq, Eq, thiserror::Error)]
pub enum MessageError {
    /// `message.text` is missing or not text.
    #[error("the chat message has no text")]
    NoText,
}

fn text(object: &Map<String, Value>, key: &str) -> Option<String> {
    object.get(key).and_then(Value::as_str).map(str::to_owned)
}

/// `String(x)` for the scalars a badge field may hold; `None` for null or absent.
fn js_text(value: Option<&Value>) -> Option<String> {
    match value? {
        Value::Null => None,
        Value::String(text) => Some(text.clone()),
        Value::Bool(flag) => Some(flag.to_string()),
        Value::Number(number) => Some(dima_text::number_to_string(
            number.as_f64().unwrap_or(f64::NAN),
        )),
        Value::Array(_) | Value::Object(_) => Some(String::new()),
    }
}

impl ChatEvent {
    /// Reads the event of a notification.
    pub fn from_json(json: Value) -> Result<Self, MessageError> {
        let Value::Object(object) = &json else {
            return Err(MessageError::NoText);
        };
        let Some(message_text) = object
            .get("message")
            .and_then(|message| message.get("text"))
            .and_then(Value::as_str)
            .map(str::to_owned)
        else {
            return Err(MessageError::NoText);
        };
        let raw_badges = object.get("badges").and_then(Value::as_array);
        let badges = raw_badges
            .map(|items| {
                items
                    .iter()
                    .map(|badge| Badge {
                        set_id: badge
                            .get("set_id")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_owned(),
                        id: badge
                            .get("id")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_owned(),
                        info: badge
                            .get("info")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_owned(),
                    })
                    .collect()
            })
            .unwrap_or_default();
        // `badgeSetIds`: `set_id` when present and not null, else `id`, as text.
        let badge_set_ids = raw_badges
            .map(|items| {
                items
                    .iter()
                    .map(|badge| {
                        js_text(badge.get("set_id"))
                            .or_else(|| js_text(badge.get("id")))
                            .unwrap_or_default()
                    })
                    .collect()
            })
            .unwrap_or_default();
        Ok(Self {
            broadcaster_user_id: text(object, "broadcaster_user_id"),
            chatter_user_id: text(object, "chatter_user_id"),
            chatter_user_login: text(object, "chatter_user_login"),
            chatter_user_name: text(object, "chatter_user_name"),
            message_id: text(object, "message_id"),
            text: message_text,
            badges,
            badge_set_ids,
            source_broadcaster_user_id: text(object, "source_broadcaster_user_id"),
            json,
        })
    }

    /// `chatter_user_id || ''`.
    pub fn chatter_id(&self) -> &str {
        self.chatter_user_id.as_deref().unwrap_or_default()
    }

    /// `chatter_user_login || ''`.
    pub fn chatter_login(&self) -> &str {
        self.chatter_user_login.as_deref().unwrap_or_default()
    }

    /// `chatter_user_name || ''`.
    pub fn chatter_name(&self) -> &str {
        self.chatter_user_name.as_deref().unwrap_or_default()
    }

    /// `message_id || ''`.
    pub fn id(&self) -> &str {
        self.message_id.as_deref().unwrap_or_default()
    }

    /// The author as identity resolution reads it.
    pub fn author(&self) -> ChatAuthor<'_, impl Iterator<Item = &str> + Clone> {
        ChatAuthor {
            user_id: self.chatter_id(),
            login: self.chatter_login(),
            badge_set_ids: self.badge_set_ids.iter().map(String::as_str),
        }
    }

    /// Whether a badge of `set_id` is present (`badges.some(b => b.set_id === …)`).
    pub fn has_badge(&self, set_id: &str) -> bool {
        self.badges.iter().any(|badge| badge.set_id == set_id)
    }

    /// `message.fragments`, as the stream recorders read them (a fragment without text reads
    /// `''`, one that is not an object is skipped).
    pub fn fragments(&self) -> Vec<Fragment> {
        let Some(items) = self
            .json
            .get("message")
            .and_then(|message| message.get("fragments"))
            .and_then(Value::as_array)
        else {
            return Vec::new();
        };
        items
            .iter()
            .filter(|item| item.is_object())
            .map(|item| Fragment {
                r#type: item
                    .get("type")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned(),
                text: item
                    .get("text")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned(),
                emote: item
                    .get("emote")
                    .filter(|emote| emote.is_object())
                    .map(|emote| FragmentEmote {
                        id: emote.get("id").and_then(Value::as_str).map(str::to_owned),
                    }),
            })
            .collect()
    }

    /// The event as the command language's value (`eventData`).
    pub fn engine_value(&self) -> dima_engine::value::Value {
        dima_engine::value::Value::from(self.json.clone())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn fields_are_read_as_javascript_reads_them() {
        let event = ChatEvent::from_json(json!({
            "broadcaster_user_id": "1001", "chatter_user_id": 5, "chatter_user_login": "viewer",
            "message_id": "m-1", "message": {"text": "hola 👋🏽", "fragments": [
                {"type": "text", "text": "hola "}, {"type": "emote", "text": "Kappa", "emote": {"id": "25"}}, 3]},
            "badges": [{"set_id": "subscriber", "id": "12", "info": "16"}, {"set_id": null, "id": "vip"}, {"id": 7}],
        }))
        .unwrap_or_else(|_| unreachable!());
        assert_eq!(event.chatter_user_id, None, "a number is not an id");
        assert_eq!(event.text, "hola 👋🏽");
        assert_eq!(event.badge_set_ids, ["subscriber", "vip", "7"]);
        assert!(event.has_badge("subscriber") && !event.has_badge("vip"));
        assert_eq!(event.fragments().len(), 2);
        assert_eq!(
            ChatEvent::from_json(json!({"message": {}})).err(),
            Some(MessageError::NoText)
        );
    }
}
