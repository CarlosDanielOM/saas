//! The EventSub type names a counter may carry: a fixed list, so no delivery can add a series.
//!
//! The reference keys its per-type counters (`eventsubByType`, the `eventsub:minute:*` fields)
//! by whatever `subscription.type` a signed notification carries. Every type this backend
//! subscribes to is below (the subscription table of `dima_twitch::eventsub`, the redemption and
//! moderation types the reward and chat code create, the two legacy bits types, and what the
//! production copy's `eventsubs` holds); anything else is counted as [`OTHER_TYPE`]. The
//! reference's own placeholder for a missing type, `unknown`, is kept.

/// Every EventSub type the backend subscribes to or has subscribed to, sorted.
pub const EVENTSUB_TYPES: [&str; 37] = [
    "automod.message.hold",
    "channel.ad_break.begin",
    "channel.ban",
    "channel.bit.use",
    "channel.bits.use",
    "channel.channel_points_custom_reward_redemption.add",
    "channel.channel_points_custom_reward_redemption.update",
    "channel.chat.clear",
    "channel.chat.clear_user_messages",
    "channel.chat.message",
    "channel.chat.message_delete",
    "channel.chat.notification",
    "channel.cheer",
    "channel.follow",
    "channel.goal.begin",
    "channel.goal.end",
    "channel.goal.progress",
    "channel.hype_train.begin",
    "channel.hype_train.end",
    "channel.hype_train.progress",
    "channel.poll.begin",
    "channel.poll.end",
    "channel.poll.progress",
    "channel.prediction.begin",
    "channel.prediction.end",
    "channel.prediction.lock",
    "channel.prediction.progress",
    "channel.raid",
    "channel.shoutout.receive",
    "channel.subscribe",
    "channel.subscription.end",
    "channel.subscription.gift",
    "channel.subscription.message",
    "channel.update",
    "stream.offline",
    "stream.online",
    "user.update",
];

/// What a missing type is counted as (`String(type || 'unknown')`).
pub const UNKNOWN_TYPE: &str = "unknown";

/// What a type outside [`EVENTSUB_TYPES`] is counted as.
pub const OTHER_TYPE: &str = "other";

/// The counter name of an EventSub type: itself when it is known, [`UNKNOWN_TYPE`] when empty,
/// [`OTHER_TYPE`] otherwise.
pub fn eventsub_type_name(kind: &str) -> &'static str {
    if kind.is_empty() {
        return UNKNOWN_TYPE;
    }
    match EVENTSUB_TYPES.binary_search(&kind) {
        Ok(index) => EVENTSUB_TYPES[index],
        Err(_) if kind == UNKNOWN_TYPE => UNKNOWN_TYPE,
        Err(_) => OTHER_TYPE,
    }
}

/// The position of a counter name in [`ALL_NAMES`] (known types, then `unknown`, then `other`).
pub(crate) fn slot(name: &str) -> usize {
    match EVENTSUB_TYPES.binary_search(&name) {
        Ok(index) => index,
        Err(_) if name == UNKNOWN_TYPE => EVENTSUB_TYPES.len(),
        Err(_) => EVENTSUB_TYPES.len() + 1,
    }
}

/// How many distinct counter names exist.
pub(crate) const SLOTS: usize = EVENTSUB_TYPES.len() + 2;

/// The counter name of a slot.
pub(crate) fn name_of(slot: usize) -> &'static str {
    match EVENTSUB_TYPES.get(slot) {
        Some(name) => name,
        None if slot == EVENTSUB_TYPES.len() => UNKNOWN_TYPE,
        None => OTHER_TYPE,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_list_is_sorted_and_unique() {
        assert!(EVENTSUB_TYPES.windows(2).all(|pair| pair[0] < pair[1]));
    }

    #[test]
    fn names_are_bounded() {
        assert_eq!(eventsub_type_name("channel.follow"), "channel.follow");
        assert_eq!(eventsub_type_name(""), "unknown");
        assert_eq!(eventsub_type_name("unknown"), "unknown");
        assert_eq!(eventsub_type_name("channel.made.up"), "other");
        assert_eq!(eventsub_type_name("channel.follow\u{301}"), "other");
        for slot_index in 0..SLOTS {
            assert_eq!(slot(name_of(slot_index)), slot_index);
        }
    }

    #[test]
    fn every_type_the_subscription_table_creates_is_known() {
        for entry in &dima_twitch::eventsub::SUBSCRIPTION_TYPES {
            assert_eq!(eventsub_type_name(entry.kind), entry.kind);
        }
        for legacy in dima_twitch::eventsub::LEGACY_BITS_EVENT_TYPES {
            assert_eq!(eventsub_type_name(legacy), legacy);
        }
    }
}
