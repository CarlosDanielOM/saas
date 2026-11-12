//! The subscription table (`SUBSCRIPTION_TYPES` of `utils/eventsub.ts`) as typed data, the bits
//! type helpers, and [`Settings`], the bot's per-subscription settings that are written with a
//! subscription (`EventsubConfig`).
//!
//! The table's order is the reference's: sign-up, the repair route and the reconciliation walk it
//! in this order, so it is the order of the requests sent to Twitch.

use super::condition::{Condition, build_expected_condition};
use bson::Bson;

/// The bot account's Twitch id: the `user_id` of the chat subscriptions and the
/// `moderator_user_id` of the moderator-read ones (`MOD_ID`).
pub const BOT_USER_ID: &str = crate::config::TWITCH_BOT_ACCOUNT_ID;

/// The template value the reference writes for the channel's id before
/// [`build_expected_condition`] replaces it.
const TEMPLATE_CHANNEL: &str = "698614112";

/// `CANONICAL_BITS_EVENT_TYPE`.
pub const CANONICAL_BITS_EVENT_TYPE: &str = "channel.bits.use";

/// `LEGACY_BITS_EVENT_TYPES`, in the reference's order.
pub const LEGACY_BITS_EVENT_TYPES: [&str; 2] = ["channel.cheer", "channel.bit.use"];

/// `isLegacyBitsEventType`.
pub fn is_legacy_bits_event_type(kind: &str) -> bool {
    LEGACY_BITS_EVENT_TYPES.contains(&kind)
}

/// `isBitsEventType`.
pub fn is_bits_event_type(kind: &str) -> bool {
    kind == CANONICAL_BITS_EVENT_TYPE || is_legacy_bits_event_type(kind)
}

/// `canonicalizeEventsubType`: a legacy bits type becomes `channel.bits.use`; anything else is
/// returned as it is.
pub fn canonicalize_eventsub_type(kind: &str) -> &str {
    if is_legacy_bits_event_type(kind) {
        CANONICAL_BITS_EVENT_TYPE
    } else {
        kind
    }
}

/// `getEquivalentEventsubTypes`: the bits types (canonical first, then the legacy ones in order)
/// for any bits type; the type itself otherwise.
pub fn equivalent_eventsub_types(kind: &str) -> Vec<&str> {
    let canonical = canonicalize_eventsub_type(kind);
    if canonical == CANONICAL_BITS_EVENT_TYPE {
        let mut types = vec![CANONICAL_BITS_EVENT_TYPE];
        types.extend(LEGACY_BITS_EVENT_TYPES);
        types
    } else {
        vec![canonical]
    }
}

/// A settings field of a stored subscription: every `eventsubs` path that is neither Twitch's
/// nor the channel's identity. Identity fields (`id`, `type`, `condition`, `channelID`...) can
/// never be passed as settings (the reference spreads whatever object it is given over them).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Setting {
    /// `enabled`.
    Enabled,
    /// `message`.
    Message,
    /// `watchStreakEnabled`.
    WatchStreakEnabled,
    /// `modiversaryMessage`.
    ModiversaryMessage,
    /// `modiversaryEnabled`.
    ModiversaryEnabled,
    /// `endMessage`.
    EndMessage,
    /// `endEnabled`.
    EndEnabled,
    /// `minViewers`.
    MinViewers,
    /// `temporalBanMessage`.
    TemporalBanMessage,
    /// `clipEnabled`.
    ClipEnabled,
    /// `delay`.
    Delay,
    /// `cheerTiers`.
    CheerTiers,
    /// `todayFollows`.
    TodayFollows,
}

impl Setting {
    /// Every settings field, in schema order.
    pub const ALL: [Self; 13] = [
        Self::Enabled,
        Self::Message,
        Self::WatchStreakEnabled,
        Self::ModiversaryMessage,
        Self::ModiversaryEnabled,
        Self::EndMessage,
        Self::EndEnabled,
        Self::MinViewers,
        Self::TemporalBanMessage,
        Self::ClipEnabled,
        Self::Delay,
        Self::CheerTiers,
        Self::TodayFollows,
    ];

    /// The stored path.
    pub fn path(self) -> &'static str {
        match self {
            Self::Enabled => "enabled",
            Self::Message => "message",
            Self::WatchStreakEnabled => "watchStreakEnabled",
            Self::ModiversaryMessage => "modiversaryMessage",
            Self::ModiversaryEnabled => "modiversaryEnabled",
            Self::EndMessage => "endMessage",
            Self::EndEnabled => "endEnabled",
            Self::MinViewers => "minViewers",
            Self::TemporalBanMessage => "temporalBanMessage",
            Self::ClipEnabled => "clipEnabled",
            Self::Delay => "delay",
            Self::CheerTiers => "cheerTiers",
            Self::TodayFollows => "todayFollows",
        }
    }

    /// The field stored at `path`, if it is a settings field.
    pub fn from_path(path: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|setting| setting.path() == path)
    }
}

/// Settings written with a subscription, in order. A field can hold a value, or be explicitly
/// undefined: JavaScript's spread copies an `undefined` over an earlier value, and Mongoose then
/// leaves the path out of the update. So `{...template, ...stored}` with a stored document that
/// lacks `message` writes no `message` at all, not the template's.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Settings {
    entries: Vec<(Setting, Option<Bson>)>,
}

impl Settings {
    /// No settings (`{}`).
    pub fn new() -> Self {
        Self::default()
    }

    /// `settings[key] = value` (an existing key keeps its place).
    pub fn set(&mut self, key: Setting, value: impl Into<Bson>) {
        self.put(key, Some(value.into()));
    }

    /// The same settings with `key` set.
    #[must_use]
    pub fn with(mut self, key: Setting, value: impl Into<Bson>) -> Self {
        self.set(key, value);
        self
    }

    /// `settings[key] = undefined`.
    pub fn set_undefined(&mut self, key: Setting) {
        self.put(key, None);
    }

    fn put(&mut self, key: Setting, value: Option<Bson>) {
        match self.entries.iter_mut().find(|(k, _)| *k == key) {
            Some(entry) => entry.1 = value,
            None => self.entries.push((key, value)),
        }
    }

    /// The value of `key` (`None` when absent or undefined).
    pub fn get(&self, key: Setting) -> Option<&Bson> {
        self.entries
            .iter()
            .find(|(k, _)| *k == key)
            .and_then(|(_, value)| value.as_ref())
    }

    /// Whether `key` is present (possibly undefined).
    pub fn has(&self, key: Setting) -> bool {
        self.entries.iter().any(|(k, _)| *k == key)
    }

    /// `{...self, ...over}`.
    #[must_use]
    pub fn merged(&self, over: &Self) -> Self {
        let mut merged = self.clone();
        for (key, value) in &over.entries {
            merged.put(*key, value.clone());
        }
        merged
    }

    /// The defined entries in order: what Mongoose writes.
    pub fn defined(&self) -> impl Iterator<Item = (Setting, &Bson)> {
        self.entries
            .iter()
            .filter_map(|(key, value)| value.as_ref().map(|value| (*key, value)))
    }

    /// Every entry in order, undefined ones as `None`.
    pub fn entries(&self) -> &[(Setting, Option<Bson>)] {
        &self.entries
    }

    /// Whether nothing would be written.
    pub fn is_empty(&self) -> bool {
        self.defined().next().is_none()
    }

    /// The defined entries as a `$set` document.
    pub fn to_document(&self) -> bson::Document {
        self.defined()
            .map(|(key, value)| (key.path().to_owned(), value.clone()))
            .collect()
    }
}

/// A literal of the table's default settings.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DefaultValue {
    /// A text.
    Text(&'static str),
    /// A flag.
    Flag(bool),
    /// A whole number (written as a JavaScript number: int32).
    Number(i32),
}

impl From<DefaultValue> for Bson {
    fn from(value: DefaultValue) -> Self {
        match value {
            DefaultValue::Text(text) => Bson::String(text.to_owned()),
            DefaultValue::Flag(flag) => Bson::Boolean(flag),
            DefaultValue::Number(number) => Bson::Int32(number),
        }
    }
}

/// How Twitch delivers the subscription's events. Every subscription of the reference is a
/// webhook to the configured callback; nothing else is ever created.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Transport {
    /// `{method: 'webhook', callback, secret}`.
    Webhook,
}

/// What Twitch requires before it accepts the subscription (from Twitch's EventSub reference,
/// for callers and diagnostics; the reference does not check it, Twitch does, and answers 403
/// when it is missing). Webhook subscriptions are always created with the app token.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Authorization {
    /// Nothing beyond the app token.
    None,
    /// The broadcaster granted one of these scopes.
    Broadcaster(&'static [&'static str]),
    /// The bot, as the channel's moderator (`moderator_user_id`), granted one of these scopes.
    BotModerator(&'static [&'static str]),
    /// Chat as the bot (`user_id`): the bot granted `user:read:chat` and `user:bot`; the
    /// broadcaster granted `channel:bot`, or the bot is a moderator of the channel.
    ChatBot,
}

/// One entry of the table.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SubscriptionType {
    /// The type (`channel.follow`).
    pub kind: &'static str,
    /// The version (`2`).
    pub version: &'static str,
    /// The condition template; the channel's id is written in by [`Self::condition_for`].
    pub condition: &'static [(&'static str, &'static str)],
    /// The default settings written with a new subscription (`config`).
    pub config: &'static [(Setting, DefaultValue)],
    /// `autoSubscribe` (`false` only for the outgoing raid). Nothing in the reference reads it:
    /// the outgoing raid is skipped by the raid preference rule instead.
    pub auto_subscribe: bool,
    /// How events are delivered.
    pub transport: Transport,
    /// What Twitch requires (informational).
    pub authorization: Authorization,
}

impl SubscriptionType {
    /// The condition template.
    pub fn template(&self) -> Condition {
        Condition::of(self.condition)
    }

    /// `buildExpectedEventsubCondition(subscription, channelID)`.
    pub fn condition_for(&self, channel_id: &str) -> Condition {
        build_expected_condition(self.kind, &self.template(), channel_id)
    }

    /// The default settings (`subscription.config || {}`).
    pub fn default_settings(&self) -> Settings {
        let mut settings = Settings::new();
        for (key, value) in self.config {
            settings.set(*key, Bson::from(*value));
        }
        settings
    }

    /// Whether the entry has a `config` (an empty one counts: none has one).
    pub fn has_config(&self) -> bool {
        !self.config.is_empty()
    }
}

/// `WATCH_STREAK_MESSAGES.en` (`chat_notification_defaults.ts`).
pub const WATCH_STREAK_MESSAGE_EN: &str = "$(user) has a streak of $(twitch.streak) days!";

const BROADCASTER: &[(&str, &str)] = &[("broadcaster_user_id", TEMPLATE_CHANNEL)];
const CHAT: &[(&str, &str)] = &[
    ("broadcaster_user_id", TEMPLATE_CHANNEL),
    ("user_id", BOT_USER_ID),
];
const MODERATED: &[(&str, &str)] = &[
    ("broadcaster_user_id", TEMPLATE_CHANNEL),
    ("moderator_user_id", BOT_USER_ID),
];
const POLLS: Authorization =
    Authorization::Broadcaster(&["channel:read:polls", "channel:manage:polls"]);
const PREDICTIONS: Authorization =
    Authorization::Broadcaster(&["channel:read:predictions", "channel:manage:predictions"]);
const HYPE_TRAIN: Authorization = Authorization::Broadcaster(&["channel:read:hype_train"]);
const GOALS: Authorization = Authorization::Broadcaster(&["channel:read:goals"]);
const SUBSCRIPTIONS: Authorization = Authorization::Broadcaster(&["channel:read:subscriptions"]);

const fn entry(
    kind: &'static str,
    version: &'static str,
    condition: &'static [(&'static str, &'static str)],
    config: &'static [(Setting, DefaultValue)],
    authorization: Authorization,
) -> SubscriptionType {
    SubscriptionType {
        kind,
        version,
        condition,
        config,
        auto_subscribe: true,
        transport: Transport::Webhook,
        authorization,
    }
}

/// `SUBSCRIPTION_TYPES`, in the reference's order (30 entries: the interaction types come from
/// `INTERACTION_SUBSCRIPTIONS`, polls then predictions).
pub static SUBSCRIPTION_TYPES: [SubscriptionType; 30] = [
    entry(
        "channel.chat.message",
        "1",
        CHAT,
        &[],
        Authorization::ChatBot,
    ),
    entry(
        "channel.chat.notification",
        "1",
        CHAT,
        &[(
            Setting::Message,
            DefaultValue::Text(WATCH_STREAK_MESSAGE_EN),
        )],
        Authorization::ChatBot,
    ),
    entry(
        "channel.follow",
        "2",
        MODERATED,
        &[(
            Setting::Message,
            DefaultValue::Text("$(user) has followed, Welcome to the stream!"),
        )],
        Authorization::BotModerator(&["moderator:read:followers"]),
    ),
    entry(
        "stream.online",
        "1",
        BROADCASTER,
        &[(
            Setting::Message,
            DefaultValue::Text("$(twitch.channel) is now live! Playing $(twitch.game)"),
        )],
        Authorization::None,
    ),
    entry(
        "stream.offline",
        "1",
        BROADCASTER,
        &[(
            Setting::Message,
            DefaultValue::Text("$(twitch.channel) is now offline!"),
        )],
        Authorization::None,
    ),
    entry(
        "channel.raid",
        "1",
        &[("to_broadcaster_user_id", TEMPLATE_CHANNEL)],
        &[
            (
                Setting::Message,
                DefaultValue::Text("$(raid.channel) is raiding with $(raid.viewers) viewers!"),
            ),
            (Setting::ClipEnabled, DefaultValue::Flag(true)),
        ],
        Authorization::None,
    ),
    SubscriptionType {
        auto_subscribe: false,
        ..entry(
            "channel.raid",
            "1",
            &[("from_broadcaster_user_id", TEMPLATE_CHANNEL)],
            &[
                (Setting::Message, DefaultValue::Text("")),
                (Setting::MinViewers, DefaultValue::Number(0)),
                (Setting::ClipEnabled, DefaultValue::Flag(false)),
            ],
            Authorization::None,
        )
    },
    entry("channel.poll.begin", "1", BROADCASTER, &[], POLLS),
    entry("channel.poll.progress", "1", BROADCASTER, &[], POLLS),
    entry("channel.poll.end", "1", BROADCASTER, &[], POLLS),
    entry(
        "channel.prediction.begin",
        "1",
        BROADCASTER,
        &[],
        PREDICTIONS,
    ),
    entry(
        "channel.prediction.progress",
        "1",
        BROADCASTER,
        &[],
        PREDICTIONS,
    ),
    entry(
        "channel.prediction.lock",
        "1",
        BROADCASTER,
        &[],
        PREDICTIONS,
    ),
    entry("channel.prediction.end", "1", BROADCASTER, &[], PREDICTIONS),
    entry(
        "channel.hype_train.begin",
        "2",
        BROADCASTER,
        &[(
            Setting::Message,
            DefaultValue::Text(
                "Hype train has started! It started at $(hypetrain.progress) and will end at $(hypetrain.end)",
            ),
        )],
        HYPE_TRAIN,
    ),
    entry(
        "channel.hype_train.progress",
        "2",
        BROADCASTER,
        &[(
            Setting::Message,
            DefaultValue::Text("Hype train has progressed to level $(hypetrain.level)!"),
        )],
        HYPE_TRAIN,
    ),
    entry(
        "channel.hype_train.end",
        "2",
        BROADCASTER,
        &[(
            Setting::Message,
            DefaultValue::Text(
                "Hype train has ended! It ended at level $(hypetrain.level) with $(hypetrain.progress)% progress!",
            ),
        )],
        HYPE_TRAIN,
    ),
    entry("channel.goal.begin", "1", BROADCASTER, &[], GOALS),
    entry("channel.goal.progress", "1", BROADCASTER, &[], GOALS),
    entry("channel.goal.end", "1", BROADCASTER, &[], GOALS),
    entry(
        "channel.shoutout.receive",
        "1",
        MODERATED,
        &[(
            Setting::Message,
            DefaultValue::Text("$(shoutout.channel) has sent a shoutout to $(twitch.channel)!"),
        )],
        Authorization::BotModerator(&["moderator:read:shoutouts", "moderator:manage:shoutouts"]),
    ),
    entry(
        "channel.ad_break.begin",
        "1",
        BROADCASTER,
        &[
            (
                Setting::Message,
                DefaultValue::Text("$(ad.time) seconds of ad break has begun!"),
            ),
            (
                Setting::EndMessage,
                DefaultValue::Text("Ad break has ended!"),
            ),
            (Setting::EndEnabled, DefaultValue::Flag(true)),
        ],
        Authorization::Broadcaster(&["channel:read:ads"]),
    ),
    entry(
        "user.update",
        "1",
        &[("user_id", TEMPLATE_CHANNEL)],
        &[],
        Authorization::None,
    ),
    entry(
        "channel.subscribe",
        "1",
        BROADCASTER,
        &[(
            Setting::Message,
            DefaultValue::Text("$(user) subscribed with $(sub.tier) for the first time!"),
        )],
        SUBSCRIPTIONS,
    ),
    entry(
        "channel.subscription.gift",
        "1",
        BROADCASTER,
        &[(
            Setting::Message,
            DefaultValue::Text("$(user) gifted a $(sub.tier) subscription to $(gifted.user)!"),
        )],
        SUBSCRIPTIONS,
    ),
    entry(
        "channel.subscription.message",
        "1",
        BROADCASTER,
        &[(
            Setting::Message,
            DefaultValue::Text(
                "$(user) resubscribed with $(sub.tier) for $(sub.months) months on a row!",
            ),
        )],
        SUBSCRIPTIONS,
    ),
    entry(
        "channel.subscription.end",
        "1",
        BROADCASTER,
        &[],
        SUBSCRIPTIONS,
    ),
    entry("channel.update", "1", BROADCASTER, &[], Authorization::None),
    entry(
        CANONICAL_BITS_EVENT_TYPE,
        "1",
        BROADCASTER,
        &[(
            Setting::Message,
            DefaultValue::Text("$(user) cheered $(cheer.amount) bits!"),
        )],
        Authorization::Broadcaster(&["bits:read"]),
    ),
    // Twitch requires `moderator_user_id` for this type; the reference sends the broadcaster
    // only, so Twitch refuses the request (see the package report). Ported as it is.
    entry(
        "automod.message.hold",
        "1",
        BROADCASTER,
        &[],
        Authorization::BotModerator(&["moderator:manage:automod"]),
    ),
];

/// Whether `kind` at `version` is in the table.
pub fn is_managed_type(kind: &str, version: &str) -> bool {
    SUBSCRIPTION_TYPES
        .iter()
        .any(|entry| entry.kind == kind && entry.version == version)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bits_helpers_match_the_reference() {
        assert!(is_legacy_bits_event_type("channel.cheer"));
        assert!(is_legacy_bits_event_type("channel.bit.use"));
        assert!(!is_legacy_bits_event_type(CANONICAL_BITS_EVENT_TYPE));
        assert!(is_bits_event_type(CANONICAL_BITS_EVENT_TYPE));
        assert!(!is_bits_event_type("channel.follow"));
        assert_eq!(
            canonicalize_eventsub_type("channel.cheer"),
            CANONICAL_BITS_EVENT_TYPE
        );
        assert_eq!(
            canonicalize_eventsub_type("channel.follow"),
            "channel.follow"
        );
        assert_eq!(
            equivalent_eventsub_types("channel.bit.use"),
            ["channel.bits.use", "channel.cheer", "channel.bit.use"]
        );
        assert_eq!(equivalent_eventsub_types("x"), ["x"]);
    }

    #[test]
    fn settings_spread_like_javascript() {
        let template = Settings::new()
            .with(Setting::Message, "hi")
            .with(Setting::ClipEnabled, true);
        let mut stored = Settings::new();
        stored.set_undefined(Setting::Message);
        stored.set(Setting::Enabled, false);
        let merged = template.merged(&stored);
        let keys: Vec<_> = merged.entries().iter().map(|(k, _)| k.path()).collect();
        assert_eq!(keys, ["message", "clipEnabled", "enabled"]);
        assert_eq!(
            merged.to_document(),
            bson::doc! {"clipEnabled": true, "enabled": false}
        );
        assert_eq!(Setting::from_path("cheerTiers"), Some(Setting::CheerTiers));
        assert_eq!(Setting::from_path("channelID"), None);
    }

    #[test]
    fn table_has_the_reference_shape() {
        assert_eq!(SUBSCRIPTION_TYPES.len(), 30);
        assert_eq!(
            SUBSCRIPTION_TYPES
                .iter()
                .filter(|t| !t.auto_subscribe)
                .count(),
            1
        );
        assert!(is_managed_type("channel.follow", "2"));
        assert!(!is_managed_type("channel.follow", "1"));
        assert!(!is_managed_type("channel.cheer", "1"));
    }
}
