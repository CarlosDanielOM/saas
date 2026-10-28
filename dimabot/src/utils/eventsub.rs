//! EventSub condition, raid-direction, and reconciliation helpers ported from
//! `dimabot/src/utils/eventsub_condition.ts`, `raid_direction.ts`,
//! `eventsub_reconciliation_policy.ts`, and the condition-serialization pieces
//! of `eventsub.ts` and `eventsub_reconciliation.ts`.
//!
//! This module is pure: it opens no connections and performs no Twitch or
//! MongoDB I/O. It is the shared core those TypeScript helpers currently
//! duplicate, so a future migration can compare and key subscriptions without
//! copying the policy.
//!
//! ## Condition shape
//!
//! [`Condition`] is a flat map of string fields. Legal EventSub conditions only
//! contain string identifiers, and Twitch represents an unused raid direction
//! as an empty string rather than omitting the field. Empty strings are
//! therefore meaningful: they are "unset" for direction purposes and are
//! removed by canonical serialization. `undefined`/`null` template fields do
//! not exist in this representation; JavaScript spread keeps such keys, but
//! every comparison here filters them out, so dropping them changes nothing
//! observable.
//!
//! ## Canonical serialization contract
//!
//! [`canonical_condition_json`] replaces both JavaScript serializers:
//!
//! - `eventsub.ts` `serializeCondition` filters `null`/`''` at the top level
//!   and then recursively sorts nested object keys before `JSON.stringify`.
//! - `eventsub_reconciliation.ts` `stableCondition` filters `null`/`''` at the
//!   top level, sorts with `String.prototype.localeCompare`, and does not
//!   recurse.
//!
//! For legal flat string conditions the two agree except for key ordering of
//! non-ASCII field names: `localeCompare` uses locale collation while this
//! canonicalizer uses Unicode code-point order (Rust `str`/`BTreeMap` order),
//! which matches JavaScript's default `Array.prototype.sort` for ASCII keys.
//! Every EventSub condition field is ASCII, so the canonical output is
//! identical to both sources for legal input. Nested values are not supported
//! here: `serializeCondition`'s recursion never applies to legal conditions,
//! and this module deliberately does not offer a general JSON canonicalizer.
//!
//! String escaping uses `serde_json`, which matches `JSON.stringify` for the
//! ASCII identifiers legal conditions contain. It is not byte-for-byte
//! equivalent for arbitrary Unicode (for example lone surrogates, which Rust
//! strings cannot hold).

use std::collections::BTreeMap;
use std::ops::Deref;

/// Canonical and historical Bits event names used by the existing EventSub store.
pub const CANONICAL_BITS_EVENT_TYPE: &str = "channel.bits.use";
pub const LEGACY_BITS_EVENT_TYPES: [&str; 2] = ["channel.cheer", "channel.bit.use"];

/// Twitch `channel.raid` subscription type.
pub const RAID_EVENT_TYPE: &str = "channel.raid";

/// Synthetic config type for an outgoing raid subscription.
pub const OUTGOING_RAID_EVENT: &str = "channel.raid.outgoing";

/// Default unhealthy ratio in `shouldTripEventsubCircuitBreaker`.
pub const DEFAULT_CIRCUIT_BREAKER_RATIO: f64 = 0.25;

/// Default minimum unhealthy count in `shouldTripEventsubCircuitBreaker`.
pub const DEFAULT_CIRCUIT_BREAKER_MIN_COUNT: usize = 5;

/// A flat EventSub condition.
///
/// Field order is not significant; comparisons and keys go through
/// [`canonical_condition_json`]. Values are strings because every legal
/// EventSub condition field is a string identifier.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Condition(BTreeMap<String, String>);

impl Condition {
    /// Creates an empty condition.
    pub fn new() -> Self {
        Self(BTreeMap::new())
    }

    /// Builds a condition from string pairs.
    ///
    /// Later duplicates replace earlier ones, matching object-literal spread.
    pub fn from_pairs<K, V>(entries: impl IntoIterator<Item = (K, V)>) -> Self
    where
        K: Into<String>,
        V: Into<String>,
    {
        Self(
            entries
                .into_iter()
                .map(|(field, value)| (field.into(), value.into()))
                .collect(),
        )
    }

    /// Returns the value for `field`, or `None` when the field is absent.
    ///
    /// An empty string is a present, "unset" value, not `None`.
    pub fn get(&self, field: &str) -> Option<&str> {
        self.0.get(field).map(String::as_str)
    }

    /// Inserts or replaces `field`, returning the previous value.
    pub fn insert(&mut self, field: impl Into<String>, value: impl Into<String>) -> Option<String> {
        self.0.insert(field.into(), value.into())
    }

    /// Removes `field`, returning the previous value.
    pub fn remove(&mut self, field: &str) -> Option<String> {
        self.0.remove(field)
    }

    /// Returns whether `field` is present, including as an empty string.
    pub fn contains_key(&self, field: &str) -> bool {
        self.0.contains_key(field)
    }

    /// Returns whether the condition has no fields at all.
    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    /// Iterates over present fields as string pairs.
    pub fn iter(&self) -> impl Iterator<Item = (&str, &str)> {
        self.0
            .iter()
            .map(|(field, value)| (field.as_str(), value.as_str()))
    }
}

impl Deref for Condition {
    type Target = BTreeMap<String, String>;

    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

impl From<BTreeMap<String, String>> for Condition {
    fn from(condition: BTreeMap<String, String>) -> Self {
        Self(condition)
    }
}

impl From<Condition> for BTreeMap<String, String> {
    fn from(condition: Condition) -> Self {
        condition.0
    }
}

impl<'a, 'b, const N: usize> From<[(&'a str, &'b str); N]> for Condition {
    fn from(entries: [(&'a str, &'b str); N]) -> Self {
        Self::from_pairs(entries)
    }
}

/// Raid subscription direction.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RaidDirection {
    Incoming,
    Outgoing,
}

impl RaidDirection {
    /// The lowercase direction used by TypeScript's `RaidDirection` union.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Incoming => "incoming",
            Self::Outgoing => "outgoing",
        }
    }
}

impl std::fmt::Display for RaidDirection {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.as_str())
    }
}

/// Returns whether `event_type` is a raid event, including the synthetic
/// outgoing config type.
pub fn is_raid_event(event_type: &str) -> bool {
    event_type == RAID_EVENT_TYPE || event_type == OUTGOING_RAID_EVENT
}

/// Derives the raid direction from a condition.
///
/// A non-empty `from_broadcaster_user_id` without a non-empty
/// `to_broadcaster_user_id` is outgoing; everything else is incoming. Empty
/// strings are falsy in the source, so `{ from: "x", to: "" }` is outgoing.
pub fn raid_direction(condition: &Condition) -> RaidDirection {
    let from = has_value(condition.get("from_broadcaster_user_id"));
    let to = has_value(condition.get("to_broadcaster_user_id"));
    direction_from_presence(from, to)
}

fn direction_from_presence(from: bool, to: bool) -> RaidDirection {
    if from && !to {
        RaidDirection::Outgoing
    } else {
        RaidDirection::Incoming
    }
}

/// Maps an outgoing `channel.raid` to the synthetic config type used by the
/// dashboard and routes; every other input is returned unchanged.
pub fn raid_config_type<'a>(event_type: &'a str, condition: &Condition) -> &'a str {
    if event_type == RAID_EVENT_TYPE && raid_direction(condition) == RaidDirection::Outgoing {
        OUTGOING_RAID_EVENT
    } else {
        event_type
    }
}

/// Builds the condition for one raid direction.
pub fn raid_condition(channel_id: &str, direction: RaidDirection) -> Condition {
    match direction {
        RaidDirection::Outgoing => Condition::from([("from_broadcaster_user_id", channel_id)]),
        RaidDirection::Incoming => Condition::from([("to_broadcaster_user_id", channel_id)]),
    }
}

/// Expands a subscription template into the condition for `channel_id`,
/// matching `buildExpectedEventsubCondition`.
///
/// `channel.raid` keeps the template's direction: when the template has a
/// non-empty `from_broadcaster_user_id` the result is outgoing (`from` replaced
/// with `channel_id`, `to` removed), otherwise it is incoming (`from` removed,
/// `to` set to `channel_id`). `user.update` sets only `user_id`; any other type
/// sets `broadcaster_user_id`. Non-channel fields such as `user_id` or
/// `moderator_user_id` are preserved.
pub fn build_expected_condition(
    subscription_type: &str,
    template: &Condition,
    channel_id: &str,
) -> Condition {
    let mut condition = template.clone();
    let (field, remove) = expected_condition_patch(
        subscription_type,
        has_value(condition.get("from_broadcaster_user_id")),
    );
    if let Some(remove) = remove {
        condition.remove(remove);
    }
    condition.insert(field, channel_id);
    condition
}

fn expected_condition_patch(
    subscription_type: &str,
    outgoing: bool,
) -> (&'static str, Option<&'static str>) {
    match subscription_type {
        RAID_EVENT_TYPE if outgoing => ("from_broadcaster_user_id", Some("to_broadcaster_user_id")),
        RAID_EVENT_TYPE => ("to_broadcaster_user_id", Some("from_broadcaster_user_id")),
        "user.update" => ("user_id", None),
        _ => ("broadcaster_user_id", None),
    }
}

/// Dynamic JSON boundary preserving unknown template fields and explicit nulls.
/// Ordinary persisted/API objects may contain these despite the TypeScript
/// condition's declared optional-string interface. Both boundaries share the
/// same field-selection policy.
pub fn build_expected_condition_value(
    subscription_type: &str,
    template: &serde_json::Value,
    channel_id: &str,
) -> serde_json::Map<String, serde_json::Value> {
    let mut condition = template.as_object().cloned().unwrap_or_default();
    let (field, remove) = expected_condition_patch(
        subscription_type,
        json_truthy(condition.get("from_broadcaster_user_id")),
    );
    if let Some(remove) = remove {
        condition.remove(remove);
    }
    condition.insert(field.into(), channel_id.into());
    condition
}

pub fn raid_direction_value(condition: Option<&serde_json::Value>) -> RaidDirection {
    direction_from_presence(
        json_truthy(condition.and_then(|value| value.get("from_broadcaster_user_id"))),
        json_truthy(condition.and_then(|value| value.get("to_broadcaster_user_id"))),
    )
}

pub fn raid_config_type_value<'a>(
    event_type: &'a str,
    condition: Option<&serde_json::Value>,
) -> &'a str {
    if event_type == RAID_EVENT_TYPE && raid_direction_value(condition) == RaidDirection::Outgoing {
        OUTGOING_RAID_EVENT
    } else {
        event_type
    }
}

/// Dynamic string boundary for source callers that pass an unrecognized
/// direction; as in TypeScript, only the exact outgoing literal is outgoing.
pub fn raid_condition_value(channel_id: &str, direction: &str) -> Condition {
    raid_condition(
        channel_id,
        if direction == "outgoing" {
            RaidDirection::Outgoing
        } else {
            RaidDirection::Incoming
        },
    )
}

fn json_truthy(value: Option<&serde_json::Value>) -> bool {
    match value {
        None | Some(serde_json::Value::Null) => false,
        Some(serde_json::Value::Bool(value)) => *value,
        Some(serde_json::Value::Number(value)) => value
            .as_f64()
            .is_some_and(|value| value != 0.0 && !value.is_nan()),
        Some(serde_json::Value::String(value)) => !value.is_empty(),
        Some(serde_json::Value::Array(_) | serde_json::Value::Object(_)) => true,
    }
}

/// Whether a condition field is present with a non-empty value, matching the
/// source's truthiness check on an optional string field.
fn has_value(value: Option<&str>) -> bool {
    value.is_some_and(|value| !value.is_empty())
}

/// Applies the reconciliation circuit-breaker policy with the source defaults
/// (`ratio = 0.25`, `minCount = 5`).
pub fn should_trip_circuit_breaker(total_managed: usize, unhealthy_managed: usize) -> bool {
    should_trip_circuit_breaker_with(
        total_managed,
        unhealthy_managed,
        DEFAULT_CIRCUIT_BREAKER_RATIO,
        DEFAULT_CIRCUIT_BREAKER_MIN_COUNT,
    )
}

/// Applies the reconciliation circuit-breaker policy.
///
/// The threshold is strict: `unhealthy / total > ratio`. `min_count` is raised
/// to at least 1 and `ratio` is clamped to `0.0..=1.0`. `total_managed == 0`
/// never trips. Counts are nonnegative integers in this API; callers must
/// normalize invalid counts before conversion. A `NaN` ratio never trips,
/// matching the source's comparisons with `NaN`.
pub fn should_trip_circuit_breaker_with(
    total_managed: usize,
    unhealthy_managed: usize,
    ratio: f64,
    min_count: usize,
) -> bool {
    should_trip_circuit_breaker_numbers(
        total_managed as f64,
        unhealthy_managed as f64,
        ratio,
        min_count as f64,
    )
}

/// JavaScript-number boundary for arbitrary numeric policy inputs, including
/// fractional counts and NaN/infinity. The integer API delegates to this same
/// policy; NaN must propagate through min/max rather than Rust's NaN-ignoring
/// `f64::min` and `f64::max` behavior.
pub fn should_trip_circuit_breaker_numbers(
    total_managed: f64,
    unhealthy_managed: f64,
    ratio: f64,
    min_count: f64,
) -> bool {
    let minimum = if min_count.is_nan() {
        f64::NAN
    } else {
        min_count.max(1.0)
    };
    if total_managed <= 0.0 || unhealthy_managed < minimum {
        return false;
    }
    (unhealthy_managed / total_managed) > ratio.clamp(0.0, 1.0)
}

/// Canonical JSON for a legal flat EventSub condition.
///
/// Empty-string fields are removed, fields are ordered by Unicode code point,
/// and the result is compact JSON. This is the shared serializer for
/// `eventsub.ts` `serializeCondition` and `eventsub_reconciliation.ts`
/// `stableCondition`; see the module documentation for the documented
/// differences on non-ASCII keys and nested values.
pub fn canonical_condition_json(condition: &Condition) -> String {
    let populated: BTreeMap<&str, &str> = condition
        .iter()
        .filter(|(_, value)| !value.is_empty())
        .collect();
    serde_json::to_string(&populated).expect("a string map always serializes to JSON")
}

/// Returns whether two conditions are equal under canonical serialization.
pub fn conditions_equal(left: &Condition, right: &Condition) -> bool {
    canonical_condition_json(left) == canonical_condition_json(right)
}

/// Builds the reconciliation grouping key `type:version:condition`.
///
/// Matches `subscriptionKey` in `eventsub_reconciliation.ts`; see
/// [`canonical_condition_json`] for the key-order contract.
pub fn subscription_key(event_type: &str, version: &str, condition: &Condition) -> String {
    format!(
        "{event_type}:{version}:{}",
        canonical_condition_json(condition)
    )
}
