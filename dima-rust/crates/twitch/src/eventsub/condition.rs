//! EventSub conditions: `buildExpectedEventsubCondition` (`utils/eventsub_condition.ts`), the
//! raid direction helpers (`utils/raid_direction.ts`), and the two ways the reference compares
//! conditions (`serializeCondition` in `eventsub.ts`, `subscriptionKey` in
//! `eventsub_reconciliation.ts`).
//!
//! A [`Condition`] is Twitch's `condition` object as an ordered JSON object: the order is the
//! order of the request body the reference writes (a template's own order, the channel's id
//! written in place), so the body bytes sent to Twitch are the same.
//!
//! `dima-stream` (`raid_subscriptions.rs`) has its own copy of `raidDirection` and
//! `raidConfigType` (it depends on this crate, not the other way round). Both follow
//! `raid_direction.ts`; the golden tests here pin this one to recordings of the TypeScript.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

/// `OUTGOING_RAID_EVENT`: the configuration type of an outgoing raid subscription.
pub const OUTGOING_RAID_EVENT: &str = "channel.raid.outgoing";

/// Twitch's `condition` object, keys in the order they are written.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct Condition(pub Map<String, Value>);

impl Condition {
    /// An empty condition.
    pub fn new() -> Self {
        Self::default()
    }

    /// A condition of string values, in the order given.
    pub fn of(entries: &[(&str, &str)]) -> Self {
        Self(
            entries
                .iter()
                .map(|(key, value)| ((*key).to_owned(), Value::from(*value)))
                .collect(),
        )
    }

    /// `condition || {}` of a stored or listed value: an object as it is, anything else empty.
    /// (`Object.entries` of a string would list its characters; no stored or listed condition is
    /// anything but an object.)
    pub fn from_value(value: &Value) -> Self {
        match value {
            Value::Object(map) => Self(map.clone()),
            _ => Self::default(),
        }
    }

    /// The value at `key`.
    pub fn get(&self, key: &str) -> Option<&Value> {
        self.0.get(key)
    }

    /// The text at `key` (`None` for a missing or non-text value).
    pub fn get_str(&self, key: &str) -> Option<&str> {
        self.0.get(key).and_then(Value::as_str)
    }

    /// `condition.key = value`: an existing key keeps its place, a new one goes last.
    pub fn set(&mut self, key: &str, value: &str) {
        self.0.insert(key.to_owned(), Value::from(value));
    }

    /// `delete condition.key` (the keys after it keep their order).
    pub fn remove(&mut self, key: &str) {
        self.0.shift_remove(key);
    }

    /// Whether `condition.key` is truthy.
    pub fn truthy(&self, key: &str) -> bool {
        self.0.get(key).is_some_and(dima_text::js_truthy)
    }

    /// The JSON object.
    pub fn to_value(&self) -> Value {
        Value::Object(self.0.clone())
    }

    /// The entries the reference compares: `value !== '' && value != null` (Twitch lists the
    /// unused raid direction as an empty text).
    fn populated(&self) -> impl Iterator<Item = (&String, &Value)> {
        self.0
            .iter()
            .filter(|(_, value)| !value.is_null() && value.as_str() != Some(""))
    }

    /// `serializeCondition` (`eventsub.ts`): the populated entries, keys sorted at every depth.
    /// Two conditions are the same subscription for `subscribeTwitchEvent`'s look-up exactly
    /// when these are equal. The text is internal (never stored or sent).
    pub fn identity(&self) -> String {
        let populated: Map<String, Value> = self
            .populated()
            .map(|(key, value)| (key.clone(), value.clone()))
            .collect();
        dima_text::to_js_json(&sort_deep(&Value::Object(populated)))
    }

    /// `stableCondition` (`eventsub_reconciliation.ts`): the populated entries, top-level keys
    /// sorted (nested values as they are). Internal: the reference sorts with `localeCompare`,
    /// this sorts by UTF-16 code units; both give the same text for the same set of keys, which
    /// is all the key is used for (equality).
    pub fn stable(&self) -> String {
        let mut entries: Vec<(&String, &Value)> = self.populated().collect();
        entries.sort_by(|(left, _), (right, _)| dima_text::cmp_utf16(left, right));
        let map: Map<String, Value> = entries
            .into_iter()
            .map(|(key, value)| (key.clone(), value.clone()))
            .collect();
        dima_text::to_js_json(&Value::Object(map))
    }
}

/// `sortValueDeep`: objects with their keys sorted (UTF-16 order, as `Array.prototype.sort`),
/// arrays element by element. Iterative depth is bounded by the value itself (a condition is
/// one level deep in practice).
fn sort_deep(value: &Value) -> Value {
    match value {
        Value::Array(items) => Value::Array(items.iter().map(sort_deep).collect()),
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort_by(|left, right| dima_text::cmp_utf16(left, right));
            Value::Object(
                keys.into_iter()
                    .filter_map(|key| map.get(key).map(|v| (key.clone(), sort_deep(v))))
                    .collect(),
            )
        }
        other => other.clone(),
    }
}

/// `subscriptionKey(type, version, condition)`: what the reconciliation groups subscriptions by.
pub fn subscription_key(kind: &str, version: &str, condition: &Condition) -> String {
    format!("{kind}:{version}:{}", condition.stable())
}

/// `buildExpectedEventsubCondition(subscription, channelID)`: the template's condition with the
/// channel's id written in: for `channel.raid` into the direction the template names
/// (`from_broadcaster_user_id` when it is set, otherwise `to_broadcaster_user_id`, the other one
/// removed), for `user.update` into `user_id`, for every other type into
/// `broadcaster_user_id`. Other fields (the bot's `user_id` or `moderator_user_id`) are kept.
pub fn build_expected_condition(kind: &str, template: &Condition, channel_id: &str) -> Condition {
    let mut condition = template.clone();
    match kind {
        "channel.raid" => {
            if condition.truthy("from_broadcaster_user_id") {
                condition.remove("to_broadcaster_user_id");
                condition.set("from_broadcaster_user_id", channel_id);
            } else {
                condition.remove("from_broadcaster_user_id");
                condition.set("to_broadcaster_user_id", channel_id);
            }
        }
        "user.update" => condition.set("user_id", channel_id),
        _ => condition.set("broadcaster_user_id", channel_id),
    }
    condition
}

/// `resolveRemoteChannelID`: the channel a listed subscription belongs to (the first truthy of
/// `broadcaster_user_id`, `to_broadcaster_user_id`, `from_broadcaster_user_id`, `user_id`, as
/// text; `""` when none).
pub fn resolve_channel_id(condition: &Condition) -> String {
    for key in [
        "broadcaster_user_id",
        "to_broadcaster_user_id",
        "from_broadcaster_user_id",
        "user_id",
    ] {
        if let Some(value) = condition
            .get(key)
            .filter(|value| dima_text::js_truthy(*value))
        {
            return dima_text::js_string(value);
        }
    }
    String::new()
}

/// Which way a raid subscription points (`RaidDirection`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RaidDirection {
    /// `to_broadcaster_user_id`: raids into the channel.
    Incoming,
    /// `from_broadcaster_user_id`: raids the channel sends.
    Outgoing,
}

impl RaidDirection {
    /// `incoming` / `outgoing`.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Incoming => "incoming",
            Self::Outgoing => "outgoing",
        }
    }

    /// The condition field that names the channel.
    pub fn field(self) -> &'static str {
        match self {
            Self::Incoming => "to_broadcaster_user_id",
            Self::Outgoing => "from_broadcaster_user_id",
        }
    }
}

/// `raidDirection(condition)`: outgoing when `from_broadcaster_user_id` is truthy and
/// `to_broadcaster_user_id` is not; incoming otherwise (a missing condition included).
pub fn raid_direction(condition: &Condition) -> RaidDirection {
    if condition.truthy("from_broadcaster_user_id") && !condition.truthy("to_broadcaster_user_id") {
        RaidDirection::Outgoing
    } else {
        RaidDirection::Incoming
    }
}

/// `raidConfigType(type, condition)`: [`OUTGOING_RAID_EVENT`] for an outgoing `channel.raid`,
/// the type itself otherwise.
pub fn raid_config_type<'a>(kind: &'a str, condition: &Condition) -> &'a str {
    if kind == "channel.raid" && raid_direction(condition) == RaidDirection::Outgoing {
        OUTGOING_RAID_EVENT
    } else {
        kind
    }
}

/// `raidCondition(channelID, direction)`.
pub fn raid_condition(channel_id: &str, direction: RaidDirection) -> Condition {
    Condition::of(&[(direction.field(), channel_id)])
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;
    use serde_json::json;

    fn template(value: Value) -> Condition {
        Condition::from_value(&value)
    }

    /// `eventsub_reconciliation.test.ts`: "builds channel-specific EventSub conditions without
    /// replacing bot identities".
    #[test]
    fn builds_channel_specific_eventsub_conditions_without_replacing_bot_identities() {
        let chat = template(json!({"broadcaster_user_id": "template", "user_id": "698614112"}));
        let follow =
            template(json!({"broadcaster_user_id": "template", "moderator_user_id": "698614112"}));
        let raid = template(json!({"to_broadcaster_user_id": "template"}));
        let user = template(json!({"user_id": "template"}));
        assert_eq!(
            build_expected_condition("channel.chat.message", &chat, "channel-1").to_value(),
            json!({"broadcaster_user_id": "channel-1", "user_id": "698614112"})
        );
        assert_eq!(
            build_expected_condition("channel.follow", &follow, "channel-1").to_value(),
            json!({"broadcaster_user_id": "channel-1", "moderator_user_id": "698614112"})
        );
        assert_eq!(
            build_expected_condition("channel.raid", &raid, "channel-1").to_value(),
            json!({"to_broadcaster_user_id": "channel-1"})
        );
        assert_eq!(
            build_expected_condition("user.update", &user, "channel-1").to_value(),
            json!({"user_id": "channel-1"})
        );
    }

    #[test]
    fn keys_keep_their_place_and_new_ones_go_last() {
        let raid = template(json!({"to_broadcaster_user_id": "x", "from_broadcaster_user_id": ""}));
        let built = build_expected_condition("channel.raid", &raid, "42");
        assert_eq!(
            serde_json::to_string(&built).unwrap(),
            r#"{"to_broadcaster_user_id":"42"}"#
        );
        let both =
            template(json!({"from_broadcaster_user_id": "a", "to_broadcaster_user_id": "b"}));
        let built = build_expected_condition("channel.raid", &both, "42");
        assert_eq!(
            serde_json::to_string(&built).unwrap(),
            r#"{"from_broadcaster_user_id":"42"}"#
        );
        let empty = build_expected_condition("stream.online", &Condition::new(), "🙂");
        assert_eq!(
            serde_json::to_string(&empty).unwrap(),
            r#"{"broadcaster_user_id":"🙂"}"#
        );
    }

    #[test]
    fn identities_ignore_empty_fields_and_order() {
        let a = template(json!({"to_broadcaster_user_id": "1", "from_broadcaster_user_id": ""}));
        let b = template(json!({"from_broadcaster_user_id": null, "to_broadcaster_user_id": "1"}));
        let c = template(json!({"to_broadcaster_user_id": "1"}));
        assert_eq!(a.identity(), c.identity());
        assert_eq!(b.identity(), c.identity());
        assert_eq!(a.stable(), c.stable());
        let d = template(json!({"user_id": "2", "broadcaster_user_id": "1"}));
        let e = template(json!({"broadcaster_user_id": "1", "user_id": "2"}));
        assert_eq!(d.identity(), e.identity());
        assert_eq!(d.stable(), e.stable());
        assert_eq!(
            subscription_key("stream.online", "1", &e),
            r#"stream.online:1:{"broadcaster_user_id":"1","user_id":"2"}"#
        );
        assert_ne!(
            template(json!({"broadcaster_user_id": "1"})).identity(),
            template(json!({"broadcaster_user_id": 1})).identity()
        );
    }

    #[test]
    fn raid_directions_follow_raid_direction_ts() {
        for (condition, direction, kind) in [
            (json!({}), RaidDirection::Incoming, "channel.raid"),
            (
                json!({"from_broadcaster_user_id": "a"}),
                RaidDirection::Outgoing,
                OUTGOING_RAID_EVENT,
            ),
            (
                json!({"to_broadcaster_user_id": "b"}),
                RaidDirection::Incoming,
                "channel.raid",
            ),
            (
                json!({"from_broadcaster_user_id": "a", "to_broadcaster_user_id": "b"}),
                RaidDirection::Incoming,
                "channel.raid",
            ),
            (
                json!({"from_broadcaster_user_id": "a", "to_broadcaster_user_id": ""}),
                RaidDirection::Outgoing,
                OUTGOING_RAID_EVENT,
            ),
        ] {
            let condition = template(condition);
            assert_eq!(raid_direction(&condition), direction);
            assert_eq!(raid_config_type("channel.raid", &condition), kind);
            assert_eq!(
                raid_config_type("stream.online", &condition),
                "stream.online"
            );
        }
        assert_eq!(
            raid_condition("7", RaidDirection::Outgoing).to_value(),
            json!({"from_broadcaster_user_id": "7"})
        );
    }

    #[test]
    fn remote_channel_is_the_first_truthy_field() {
        let raid = template(json!({"from_broadcaster_user_id": "", "to_broadcaster_user_id": "9"}));
        assert_eq!(resolve_channel_id(&raid), "9");
        let user = template(json!({"user_id": "5"}));
        assert_eq!(resolve_channel_id(&user), "5");
        let chat = template(json!({"broadcaster_user_id": "1", "user_id": "698614112"}));
        assert_eq!(resolve_channel_id(&chat), "1");
        assert_eq!(resolve_channel_id(&Condition::new()), "");
        assert_eq!(resolve_channel_id(&template(json!({"user_id": 12}))), "12");
    }
}
