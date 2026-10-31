//! Alert event filtering from `alert-events.ts` and its source tests.
//! Gift recipients are suppressed, resubscriptions are deduplicated per channel,
//! and unrelated event types are unaffected.

use crate::utils::lossless_json::JsonValue;

/// Subscription duplicate suppression window in milliseconds.
pub const SUB_REPEAT_MS: i64 = 10 * 60_000;
/// Domain type to overlay alert kind mapping.
pub const ALERT_DOMAIN_TYPES: [(&str, &str); 5] = [
    ("channel.follow.received", "follow"),
    ("channel.bits.received", "bits"),
    ("channel.subscription.received", "sub"),
    ("channel.subscription.gifted", "sub"),
    ("channel.raid.received", "raid"),
];

/// Stateful source-order subscription deduplicator.
#[derive(Default)]
pub struct AlertEventFilter {
    subs: Vec<(Vec<u16>, i64)>,
}

impl AlertEventFilter {
    /// Map a journal event to an alert kind, if it should be shown.
    pub fn kind(&mut self, channel: &str, event_type: &str, event: &JsonValue, at: i64) -> Option<&'static str> {
        let kind = ALERT_DOMAIN_TYPES.iter().find(|(name, _)| *name == event_type)?.1;
        if event_type != "channel.subscription.received" {
            return Some(kind);
        }
        let fields = match event {
            JsonValue::Object(fields) => fields.as_slice(),
            _ => &[],
        };
        let field = |name: &str| fields.iter().find(|(key, _)| key.as_str() == Some(name)).map(|(_, value)| value);
        if matches!(field("is_gift"), Some(JsonValue::Bool(true))) {
            return None;
        }
        // TypeScript Map iteration stops at the first entry that has not expired.
        while self.subs.first().is_some_and(|(_, seen)| i128::from(at) - i128::from(*seen) >= i128::from(SUB_REPEAT_MS)) {
            self.subs.remove(0);
        }
        let user = match field("user_id") {
            Some(JsonValue::String(user)) if !user.is_empty() => user,
            _ => return Some(kind),
        };
        // Preserve arbitrary UTF-16 identifiers, including lone surrogates.
        let mut key: Vec<u16> = channel.encode_utf16().collect();
        key.push(b':' as u16);
        key.extend(user.code_units());
        if let Some(index) = self.subs.iter().position(|(existing, _)| *existing == key) {
            if (i128::from(at) - i128::from(self.subs[index].1)).abs() < i128::from(SUB_REPEAT_MS) {
                return None;
            }
            self.subs.remove(index);
        }
        self.subs.push((key, at));
        Some(kind)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn event(user: &str, gift: bool) -> JsonValue {
        JsonValue::Object(vec![("user_id".into(), JsonValue::String(user.into())), ("is_gift".into(), JsonValue::Bool(gift))])
    }
    #[test]
    fn gift_bomb_only_shows_gifter() {
        let mut filter = AlertEventFilter::default();
        assert_eq!(filter.kind("1", "channel.subscription.gifted", &event("g", false), 0), Some("sub"));
        assert_eq!(filter.kind("1", "channel.subscription.received", &event("r", true), 1), None);
    }
    #[test]
    fn subscriptions_deduplicate_per_channel_until_expiry() {
        let mut filter = AlertEventFilter::default();
        let event = event("u", false);
        assert_eq!(filter.kind("1", "channel.subscription.received", &event, 0), Some("sub"));
        assert_eq!(filter.kind("1", "channel.subscription.received", &event, 8_000), None);
        assert_eq!(filter.kind("2", "channel.subscription.received", &event, 8_000), Some("sub"));
        assert_eq!(filter.kind("1", "channel.subscription.received", &event, SUB_REPEAT_MS + 1), Some("sub"));
    }
    #[test]
    fn other_types_are_not_deduplicated() {
        let mut filter = AlertEventFilter::default();
        let event = event("u", false);
        for (kind, result) in [("channel.follow.received", Some("follow")), ("channel.bits.received", Some("bits")), ("channel.raid.received", Some("raid")), ("channel.subscription.ended", None)] {
            assert_eq!(filter.kind("1", kind, &event, 0), result);
            assert_eq!(filter.kind("1", kind, &event, 1), result);
        }
    }
}
