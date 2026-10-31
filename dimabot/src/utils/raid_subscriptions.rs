//! Raid subscription preference and remote-subscription policy ported from
//! `dimabot/src/utils/raid_subscriptions.ts`.
//!
//! The TypeScript helpers own no policy that is new here: direction derivation
//! stays in [`crate::utils::eventsub::raid_direction_value`], the preference
//! document shape stays in
//! [`crate::schemas::raid_subscription_preference`], and remote EventSub
//! documents stay in [`crate::schemas::eventsub`]. This module only supplies the
//! concrete MongoDB adapter and the two document/decision boundaries the source
//! functions apply.
//!
//! Construction performs no I/O. It resolves two collection handles and never
//! connects, creates a collection, installs an index, or reads application data.
//!
//! ## Source parity notes
//!
//! * `raidPreferenceID` is the exact `` `${channelID}:${direction}` `` string.
//! * `Model.exists({...})` is `findOne(filter).select({_id: 1}).lean()` in
//!   Mongoose 8, so the deletion probe projects only `_id`. Any document (not
//!   the projected value) means "deleted".
//! * `findById(id).lean()` reads the raw stored document, and
//!   `deleted !== true` is a strict comparison. Only a stored boolean `true`
//!   is a deletion; `false`, `0`, a string, `null`, or an absent field are not.
//! * The remote lookup is
//!   `findOne({channelID, type: 'channel.raid', 'condition.<direction field>': channelID})`,
//!   projected to `enabled` and `id`, bounded by `maxTimeMS(1500)`, and read
//!   without hydration (`.lean()`). A projected-out `enabled` is treated as
//!   enabled, exactly like `config.enabled !== false`.
//! * `String(value || '')` for the event channel is ECMAScript coercion over
//!   JSON: falsy input produces an empty string, numbers use
//!   [`crate::utils::json_number::number_string`], arrays comma-join, and
//!   objects use `[object Object]`. Twitch sends strings in practice; the full
//!   rule keeps malformed payload behavior identical.
//!
//! The source files `src/utils/raid_direction.ts` and
//! `src/schemas/eventsub.schema.ts` were retired after their native ports. The
//! policy they contained lives in [`crate::utils::eventsub`] and
//! [`crate::schemas::eventsub`]; the source oracle replays the preserved
//! archived TypeScript files instead of restating that policy.

use std::{fmt, time::Duration};

use mongodb::{
    Collection, Database,
    bson::{Bson, Document, doc},
    error::Error as MongoError,
};
use serde_json::Value;

use crate::{
    schemas::{eventsub, raid_subscription_preference},
    utils::{
        eventsub::{RAID_EVENT_TYPE, RaidDirection, raid_direction_value},
        json_number::number_string,
    },
};

/// `maxTimeMS` applied to the remote EventSub configuration lookup.
pub const EVENTSUB_QUERY_MAX_TIME_MS: u64 = 1_500;

/// Explicit preference id: `channelID:direction`.
pub fn raid_preference_id(channel_id: &str, direction: RaidDirection) -> String {
    format!("{channel_id}:{}", direction.as_str())
}

/// Filter used by `Preferences.findById(...)`.
pub fn preference_id_filter(channel_id: &str, direction: RaidDirection) -> Document {
    doc! {"_id": raid_preference_id(channel_id, direction)}
}

/// Filter used by `Preferences.exists({_id, deleted: true})`.
pub fn deleted_preference_filter(channel_id: &str, direction: RaidDirection) -> Document {
    doc! {"_id": raid_preference_id(channel_id, direction), "deleted": true}
}

/// Projection used by `Model.exists` (`select({_id: 1})`).
pub fn existence_projection() -> Document {
    doc! {"_id": 1}
}

/// Filter used by `Eventsub.findOne` for one channel and raid direction.
pub fn eventsub_config_filter(channel_id: &str, direction: RaidDirection) -> Document {
    let field = match direction {
        RaidDirection::Outgoing => "from_broadcaster_user_id",
        RaidDirection::Incoming => "to_broadcaster_user_id",
    };
    let mut filter = doc! {"channelID": channel_id, "type": RAID_EVENT_TYPE};
    filter.insert(format!("condition.{field}"), channel_id);
    filter
}

/// Projection used by `.select('enabled id')`; `_id` stays included by default.
pub fn eventsub_config_projection() -> Document {
    doc! {"enabled": 1, "id": 1}
}

/// Reads the event channel for the direction under test.
///
/// Returns `None` for every JavaScript-falsy value (missing, `null`, `false`,
/// `0`, `NaN`, empty string) and the ECMAScript string form otherwise.
pub fn notification_channel_id(event: &Value, direction: RaidDirection) -> Option<String> {
    let field = match direction {
        RaidDirection::Outgoing => "from_broadcaster_user_id",
        RaidDirection::Incoming => "to_broadcaster_user_id",
    };
    let value = event.get(field);
    json_truthy(value).then(|| js_string(value.expect("truthy value is present")))
}

/// Source `config ? ... : direction === 'incoming' && !subscription.id`.
///
/// `config` is the projected raw document, or `None` when the lookup missed.
pub fn accepts_config(
    direction: RaidDirection,
    subscription_id: Option<&str>,
    config: Option<&Document>,
) -> bool {
    match config {
        Some(config) => {
            // Strict `enabled !== false`; any other stored type is enabled.
            let enabled = !matches!(config.get("enabled"), Some(Bson::Boolean(false)));
            let id_matches = match present_id(subscription_id) {
                Some(subscription_id) => {
                    matches!(config.get("id"), Some(Bson::String(id)) if id.as_str() == subscription_id)
                }
                None => true,
            };
            enabled && id_matches
        }
        None => direction == RaidDirection::Incoming && present_id(subscription_id).is_none(),
    }
}

/// A subscription notification's `subscription` object.
#[derive(Clone, Copy, Debug, Default)]
pub struct RaidSubscriptionRef<'a> {
    pub id: Option<&'a str>,
    pub condition: Option<&'a Value>,
}

/// Concrete MongoDB adapter for the two raid collections.
#[derive(Clone, Debug)]
pub struct RaidSubscriptionStore {
    preferences: Collection<Document>,
    eventsubs: Collection<Document>,
}

impl RaidSubscriptionStore {
    /// Resolves both collection handles. Performs no I/O.
    pub fn new(database: &Database) -> Self {
        Self {
            preferences: raid_subscription_preference::schema().native_collection(database),
            eventsubs: eventsub::collection(database),
        }
    }

    /// Source `isRaidDeleted`.
    pub async fn is_raid_deleted(
        &self,
        channel_id: &str,
        direction: RaidDirection,
    ) -> Result<bool, RaidSubscriptionError> {
        Ok(self
            .preferences
            .find_one(deleted_preference_filter(channel_id, direction))
            .projection(existence_projection())
            .await?
            .is_some())
    }

    /// Source `shouldRepairRaid`.
    pub async fn should_repair_raid(
        &self,
        channel_id: &str,
        direction: RaidDirection,
    ) -> Result<bool, RaidSubscriptionError> {
        let preference = self
            .preferences
            .find_one(preference_id_filter(channel_id, direction))
            .await?;
        Ok(match preference {
            Some(preference) => !matches!(preference.get("deleted"), Some(Bson::Boolean(true))),
            None => direction == RaidDirection::Incoming,
        })
    }

    /// Source `acceptsRaidNotification`.
    pub async fn accepts_raid_notification(
        &self,
        subscription: RaidSubscriptionRef<'_>,
        event: &Value,
    ) -> Result<bool, RaidSubscriptionError> {
        let direction = raid_direction_value(subscription.condition);
        let Some(channel_id) = notification_channel_id(event, direction) else {
            return Ok(false);
        };
        if self.is_raid_deleted(&channel_id, direction).await? {
            return Ok(false);
        }
        let config = self
            .eventsubs
            .find_one(eventsub_config_filter(&channel_id, direction))
            .projection(eventsub_config_projection())
            .max_time(Duration::from_millis(EVENTSUB_QUERY_MAX_TIME_MS))
            .await?;
        Ok(accepts_config(direction, subscription.id, config.as_ref()))
    }
}

/// Read failure from either raid collection.
#[derive(Debug)]
pub enum RaidSubscriptionError {
    Mongo(MongoError),
}

impl fmt::Display for RaidSubscriptionError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Mongo(error) => write!(formatter, "raid subscription read failed: {error}"),
        }
    }
}

impl std::error::Error for RaidSubscriptionError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Mongo(error) => Some(error),
        }
    }
}

impl From<MongoError> for RaidSubscriptionError {
    fn from(error: MongoError) -> Self {
        Self::Mongo(error)
    }
}

/// JavaScript truthiness for a JSON value.
fn json_truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(value)) => *value,
        Some(Value::Number(value)) => {
            value.as_f64().is_some_and(|value| value != 0.0 && !value.is_nan())
        }
        Some(Value::String(value)) => !value.is_empty(),
        Some(Value::Array(_) | Value::Object(_)) => true,
    }
}

/// ECMAScript `String(value)` for a JSON value.
fn js_string(value: &Value) -> String {
    match value {
        Value::Null => "null".into(),
        Value::Bool(value) => value.to_string(),
        Value::Number(value) => value
            .as_f64()
            .map(number_string)
            .unwrap_or_else(|| value.to_string()),
        Value::String(value) => value.clone(),
        Value::Array(values) => values
            .iter()
            .map(|value| match value {
                Value::Null => String::new(),
                other => js_string(other),
            })
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".into(),
    }
}

/// `!subscription.id` for the declared optional string field; an empty string
/// is falsy in the source.
fn present_id(subscription_id: Option<&str>) -> Option<&str> {
    subscription_id.filter(|id| !id.is_empty())
}
