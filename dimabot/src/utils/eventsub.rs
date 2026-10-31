//! EventSub condition, raid-direction, and reconciliation helpers ported from
//! `dimabot/src/utils/eventsub_condition.ts`, `raid_direction.ts`,
//! `eventsub_reconciliation_policy.ts`, and the condition-serialization pieces
//! of `eventsub.ts` and `eventsub_reconciliation.ts`.
//!
//! The condition helpers are pure. The feature-gated remote adapters accept
//! caller-owned clients and stores and perform I/O only when called.
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
//!
//! Existing-subscription comparison does not use this canonicalizer or the
//! strict `ICondition` view. It follows `serializeCondition`: every populated
//! top-level key participates, including keys the interface does not declare,
//! and only top-level `null` and `''` are removed.

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

/// Remote EventSub operations. Available when the shared EventSub policy,
/// Twitch functions, and ordinary application schemas are enabled together.
#[cfg(all(feature = "twitch-functions", feature = "ordinary-application-schemas"))]
pub mod remote {
    use super::raid_config_type_value;
    use crate::{
        schemas::eventsub::{schema as eventsub_schema, ICondition},
        utils::{
            js_string::write_json_utf8,
            json_number::{number_string, to_number},
            twitch::{
                AccessToken, HelixRequest, HelixRetryPolicy, TokenFuture, TokenSource, TwitchAuth,
                TwitchClient,
            },
            twitch_streamers::{CallerContext, Platform, TwitchStreamers},
        },
    };
    use futures_util::TryStreamExt;
    use mongodb::{Collection, bson::{self, Bson, Document, doc}, options::ReturnDocument};
    use reqwest::{Method, Url};
    use serde_json::{Value, json};
    use std::{collections::HashSet, future::Future, pin::Pin};

    /// Borrowed asynchronous result used by the injectable directory and store.
    pub type RemoteFuture<'a, T> = Pin<Box<dyn Future<Output = Result<T, String>> + 'a>>;

    /// Streamer lookup used before checking for an existing subscription.
    pub trait EventsubDirectory {
        /// Returns the channel name, or `None` when the account is missing.
        fn name<'a>(&'a self, channel_id: &'a str) -> RemoteFuture<'a, Option<String>>;
        /// Returns the source header error message, or `None` when it is available.
        fn header_error<'a>(&'a self, channel_id: &'a str) -> RemoteFuture<'a, Option<String>>;
    }
    impl EventsubDirectory for TwitchStreamers {
        fn name<'a>(&'a self, channel_id: &'a str) -> RemoteFuture<'a, Option<String>> {
            Box::pin(async move {
                // `getTwitchAccountById` catches every failure and returns null.
                // Its cache/console error record belongs to the directory service.
                match self.account_by_id(channel_id).await {
                    Ok(account) => Ok(Some(account.metadata.name)),
                    Err(_) => Ok(None),
                }
            })
        }
        fn header_error<'a>(&'a self, channel_id: &'a str) -> RemoteFuture<'a, Option<String>> {
            Box::pin(async move {
                // Same user-facing results as `getTwitchStreamerHeaderById`.
                // Every lookup failure is the not-found message. Every token
                // failure, including refresh, shares one message.
                // `account_token` records the refresh category when that
                // directory was given a logger. This adapter does not hold the
                // header helper's cache logger, so those `debug` lines are not
                // duplicated on stderr.
                let account = match self.account_by_id(channel_id).await {
                    Ok(account) => account,
                    Err(_) => {
                        return Ok(Some(format!(
                            "[⚠️] Streamer not found for ID: {channel_id} [/⚠️]"
                        )))
                    }
                };
                if account.has_permissions != "true" {
                    return Ok(Some("[⚠️] Streamer does not have valid permissions to access this feature, please reauthorize streamer again in https://domdimabot.com [/⚠️]".into()));
                }
                if self
                    .account_token(
                        channel_id,
                        Platform::Twitch,
                        &CallerContext::new("getTwitchStreamerHeaderById"),
                    )
                    .await
                    .is_err()
                {
                    return Ok(Some("[⚠️] Streamer does not have valid permissions token to access this feature, please reauthorize streamer again in https://domdimabot.com [/⚠️]".into()));
                }
                Ok(None)
            })
        }
    }

    /// Persistence operations over the canonical EventSub documents.
    pub trait EventsubStore {
        /// Finds candidates by channel, type and version.
        fn candidates<'a>(&'a self, channel: &'a str, event_type: &'a str, version: &'a str) -> RemoteFuture<'a, Vec<Document>>;
        /// Upserts the Twitch response and supplied configuration by remote ID.
        fn upsert<'a>(&'a self, document: Document) -> RemoteFuture<'a, Document>;
        /// Upserts using the original remote ID as the filter, independently of configuration.
        /// Existing stores may keep implementing `upsert`; stores that perform matching
        /// should override this method to respect the separate filter.
        fn upsert_with_source_id<'a>(&'a self, _source_id: Option<Bson>, document: Document) -> RemoteFuture<'a, Document> {
            self.upsert(document)
        }
        /// Deletes one local subscription by remote ID.
        fn delete<'a>(&'a self, id: &'a str) -> RemoteFuture<'a, ()>;
    }
    impl EventsubStore for Collection<Document> {
        fn candidates<'a>(&'a self, channel: &'a str, event_type: &'a str, version: &'a str) -> RemoteFuture<'a, Vec<Document>> {
            Box::pin(async move {
                self.find(doc! {"channelID": channel, "type": event_type, "version": version}).await.map_err(|e| e.to_string())?.try_collect().await.map_err(|e| e.to_string())
            })
        }
        fn upsert<'a>(&'a self, document: Document) -> RemoteFuture<'a, Document> {
            let source_id = document.get("id").cloned();
            self.upsert_with_source_id(source_id, document)
        }
        fn upsert_with_source_id<'a>(&'a self, source_id: Option<Bson>, document: Document) -> RemoteFuture<'a, Document> {
            Box::pin(async move {
                let original = document.clone();
                let (filter, update) = prepare_subscription_upsert_with_source_id(source_id, document)?;
                Ok(self
                    .find_one_and_update(filter, update)
                    .upsert(true)
                    .return_document(ReturnDocument::After)
                    .await
                    .map_err(|error| error.to_string())?
                    .unwrap_or(original))
            })
        }
        fn delete<'a>(&'a self, id: &'a str) -> RemoteFuture<'a, ()> {
            Box::pin(async move { self.delete_one(doc! {"id": id}).await.map_err(|e| e.to_string())?; Ok(()) })
        }
    }

    struct FixedToken(AccessToken);
    impl TokenSource for FixedToken {
        fn token<'a>(&'a self, _: &'a TwitchAuth) -> TokenFuture<'a> { Box::pin(async move { Ok(self.0.clone()) }) }
    }
    async fn app(tokens: &dyn TokenSource) -> Option<FixedToken> {
        tokens.token(&TwitchAuth::App).await.ok().filter(|t| !t.expose_secret().is_empty()).map(FixedToken)
    }
    fn query(pairs: &[(&str, &str)]) -> Result<String, String> {
        let mut url = Url::parse("http://localhost/").map_err(|e| e.to_string())?;
        url.query_pairs_mut().extend_pairs(pairs.iter().copied());
        Ok(url.query().unwrap_or_default().to_owned())
    }
    async fn request(client: &TwitchClient, token: &FixedToken, method: Method, params: Option<&str>, body: Option<&Value>) -> Result<reqwest::Response, String> {
        client.request(token, &TwitchAuth::App, HelixRequest { method, endpoint: "eventsub/subscriptions", params, body }, &HelixRetryPolicy::single_attempt()).await.map(|v| v.response).map_err(|e| e.to_string())
    }
    fn credential_error(list: bool) -> Value {
        if list { json!({"error":"Twitch app credentials are not configured","message":"Unable to list EventSub subscriptions without an app token and client ID","status":500}) }
        else { json!({"error":"Error getting Twitch app credentials","message":"An app access token and client ID are required","status":500}) }
    }
    fn value_truthy(value: &Value) -> bool {
        super::json_truthy(Some(value))
    }
    fn present_text(value: Option<&Value>) -> Option<String> {
        value.filter(|value| value_truthy(value)).map(js_text)
    }
    fn js_text(value: &Value) -> String {
        match value {
            Value::Null => "null".into(),
            Value::Bool(value) => value.to_string(),
            Value::Number(value) => value.as_f64().map(number_string).unwrap_or_else(|| value.to_string()),
            Value::String(value) => value.clone(),
            Value::Array(values) => values.iter().map(|value| if value.is_null() { String::new() } else { js_text(value) }).collect::<Vec<_>>().join(","),
            Value::Object(_) => "[object Object]".into(),
        }
    }
    fn text_or_empty(value: Option<&Value>) -> String {
        present_text(value).unwrap_or_default()
    }
    fn number_or_zero(value: Option<&Value>) -> Value {
        let Some(value) = value.filter(|value| value_truthy(value)) else { return json!(0); };
        let number = to_number(value);
        if !number.is_finite() { return Value::Null; }
        if number == 0.0 { return json!(0); }
        if number.fract() == 0.0 && number.abs() < 9_007_199_254_740_992.0 { return json!(number as i64); }
        serde_json::Number::from_f64(number).map(Value::Number).unwrap_or(Value::Null)
    }
    fn bson_truthy(value: &Bson) -> bool {
        match value {
            Bson::Null | Bson::Undefined => false,
            Bson::Boolean(value) => *value,
            Bson::Int32(value) => *value != 0,
            Bson::Int64(value) => *value != 0,
            Bson::Double(value) => *value != 0.0 && !value.is_nan(),
            Bson::String(value) => !value.is_empty(),
            _ => true,
        }
    }
    /// `findOneAndUpdate({ id }, { $set }, { upsert, new, setDefaultsOnInsert })`.
    /// Schema casting and defaults come from the eventsub schema adapter.
    /// Unknown top-level keys are omitted. Mixed condition keys are kept.
    /// Required validators and empty-Mixed minimization are not applied; the
    /// source call does not use `runValidators` or `save`.
    pub fn prepare_subscription_upsert(document: Document) -> Result<(Document, Document), String> {
        let source_id = document.get("id").cloned();
        prepare_subscription_upsert_with_source_id(source_id, document)
    }
    /// Prepares the original response ID filter independently from the updated fields.
    /// Missing JavaScript IDs serialize as BSON null under the driver's default options.
    pub fn prepare_subscription_upsert_with_source_id(source_id: Option<Bson>, document: Document) -> Result<(Document, Document), String> {
        let schema = eventsub_schema();
        let mut set = Document::new();
        for (key, value) in document {
            if schema.fields.iter().any(|field| field.name == key) { set.insert(key, value); }
        }
        let filter = doc! {"id": match source_id { None | Some(Bson::Undefined) => Bson::Null, Some(id) => id }};
        schema.prepare_equality_upsert(&filter, &Document::new(), &set, mongodb::bson::DateTime::now()).map_err(|error| error.to_string())
    }
    fn absent_condition_value(value: &Bson) -> bool {
        match value {
            Bson::Null | Bson::Undefined => true,
            Bson::String(value) => value.is_empty(),
            _ => false,
        }
    }
    /// `serializeCondition`: drop top-level null and `''`, sort keys, then
    /// `JSON.stringify(sortValueDeep(...))`.
    fn condition_population_key(value: &Bson) -> String {
        let mut out = String::new();
        match value {
            Bson::Document(document) => write_sorted_object(document, &mut out, true),
            Bson::Array(values) => {
                let document: Document = values.iter().enumerate().map(|(i, value)| (i.to_string(), value.clone())).collect();
                write_sorted_object(&document, &mut out, true);
            }
            Bson::String(value) => {
                let document: Document = value.chars().enumerate().map(|(i, ch)| (i.to_string(), Bson::String(ch.to_string()))).collect();
                write_sorted_object(&document, &mut out, true);
            }
            _ => out.push_str("{}"),
        }
        out
    }
    fn conditions_match(stored: &Bson, requested: &Bson) -> bool {
        condition_population_key(stored) == condition_population_key(requested)
    }
    // JSON.stringify enumerates array-index keys numerically even after sort().
    fn array_index(key: &str) -> Option<u32> {
        let index = key.parse::<u32>().ok()?;
        (index != u32::MAX && index.to_string() == key).then_some(index)
    }
    fn write_sorted_object(document: &Document, out: &mut String, filter_absent: bool) {
        // `JSON.stringify` omits object keys whose value is `undefined`.
        // Top-level `null` and `''` are removed only for `serializeCondition`.
        let mut entries: Vec<(&str, &Bson)> = document.iter().filter(|(_, value)| !matches!(value, Bson::Undefined) && (!filter_absent || !absent_condition_value(value))).collect();
        entries.sort_by(|left, right| match (array_index(left.0), array_index(right.0)) {
            (Some(a), Some(b)) => a.cmp(&b),
            (Some(_), None) => std::cmp::Ordering::Less,
            (None, Some(_)) => std::cmp::Ordering::Greater,
            (None, None) => left.0.encode_utf16().cmp(right.0.encode_utf16()),
        });
        out.push('{');
        for (index, (key, value)) in entries.iter().enumerate() {
            if index > 0 { out.push(','); }
            write_json_utf8(key, out);
            out.push(':');
            write_sorted_json(value, out);
        }
        out.push('}');
    }
    fn write_sorted_json(value: &Bson, out: &mut String) {
        match value {
            Bson::Null => out.push_str("null"),
            Bson::Boolean(value) => out.push_str(if *value { "true" } else { "false" }),
            Bson::Int32(value) => out.push_str(&value.to_string()),
            Bson::Int64(value) => write_number(*value as f64, out),
            Bson::Double(value) => write_number(*value, out),
            Bson::String(value) => write_json_utf8(value, out),
            Bson::ObjectId(value) => write_json_utf8(&value.to_hex(), out),
            Bson::DateTime(value) => match js_date_string(value) {
                Some(text) => write_json_utf8(&text, out),
                None => out.push_str("null"),
            },
            Bson::Array(values) => {
                out.push('[');
                for (index, value) in values.iter().enumerate() {
                    if index > 0 { out.push(','); }
                    write_sorted_json(value, out);
                }
                out.push(']');
            }
            Bson::Document(document) => write_sorted_object(document, out, false),
            _ => out.push_str("null"),
        }
    }
    fn write_number(number: f64, out: &mut String) {
        if number.is_finite() { out.push_str(&number_string(number)); } else { out.push_str("null"); }
    }
    fn js_date_string(value: &mongodb::bson::DateTime) -> Option<String> {
        let millis = value.timestamp_millis();
        let whole = mongodb::bson::DateTime::from_millis(millis.div_euclid(1000) * 1000);
        let base = whole.try_to_rfc3339_string().ok()?.replace("+00:00", "Z");
        let prefix = base.trim_end_matches('Z').split('.').next().unwrap_or("");
        if prefix.is_empty() { return None; }
        Some(format!("{prefix}.{:03}Z", millis.rem_euclid(1000)))
    }
    fn http_status(status: u16) -> u16 { if status == 0 { 502 } else { status } }
    fn subscribe_failure(payload: &Value, status: u16) -> Value {
        let status = http_status(status);
        let fallback = format!("Twitch returned HTTP {status}");
        let error = present_text(payload.get("error")).unwrap_or(fallback);
        let message = present_text(payload.get("message")).unwrap_or_else(|| error.clone());
        json!({"error": error, "message": message, "status": status})
    }
    const RESPONSE_FIELDS: [&str; 21] = ["_id", "id", "status", "type", "version", "condition", "created_at", "transport", "cost", "channel", "channelID", "enabled", "message", "endMessage", "endEnabled", "minViewers", "temporalBanMessage", "clipEnabled", "delay", "cheerTiers", "todayFollows"];
    fn projection(document: &Document) -> Result<Value, String> {
        let mut data: Value = bson::from_bson(Bson::Document(document.clone())).map_err(|error| error.to_string())?;
        let map = data.as_object_mut().ok_or_else(|| "invalid EventSub document".to_owned())?;
        match document.get("_id") {
            Some(Bson::ObjectId(id)) => { map.insert("_id".into(), json!(id.to_hex())); }
            Some(value) if bson_truthy(value) => { map.insert("_id".into(), json!(bson_text(value))); }
            _ => { map.remove("_id"); }
        }
        let condition = match map.get("condition") {
            Some(value) if value_truthy(value) => value.clone(),
            _ => json!({}),
        };
        let event_type = text_or_empty(map.get("type"));
        map.insert("type".into(), json!(raid_config_type_value(&event_type, Some(&condition))));
        map.insert("condition".into(), condition);
        for key in ["id", "status", "version", "created_at", "channel", "channelID", "message", "endMessage", "temporalBanMessage"] {
            map.insert((*key).into(), json!(text_or_empty(map.get(*key))));
        }
        let transport = match map.get("transport") {
            Some(value) if value_truthy(value) => value.clone(),
            _ => json!({"method": "", "callback": ""}),
        };
        map.insert("transport".into(), transport);
        for key in ["cost", "minViewers", "delay"] { map.insert((*key).into(), number_or_zero(map.get(*key))); }
        for key in ["enabled", "endEnabled", "clipEnabled"] { map.insert((*key).into(), json!(map.get(*key).is_some_and(value_truthy))); }
        let tiers = match map.get("cheerTiers") { Some(Value::Array(values)) => Value::Array(values.clone()), _ => json!([]) };
        map.insert("cheerTiers".into(), tiers);
        map.retain(|key, _| RESPONSE_FIELDS.contains(&key.as_str()));
        Ok(data)
    }
    fn bson_text(value: &Bson) -> String {
        match value {
            Bson::String(value) => value.clone(),
            Bson::ObjectId(value) => value.to_hex(),
            Bson::Boolean(value) => value.to_string(),
            Bson::Int32(value) => value.to_string(),
            Bson::Int64(value) => number_string(*value as f64),
            Bson::Double(value) if value.is_finite() => number_string(*value),
            Bson::Double(value) => value.to_string(),
            Bson::Array(values) => values.iter().map(|value| if matches!(value, Bson::Null | Bson::Undefined) { String::new() } else { bson_text(value) }).collect::<Vec<_>>().join(","),
            _ => "[object Object]".into(),
        }
    }

    /// Lists all Helix EventSub pages. `None` client represents missing CLIENT_ID;
    /// a supplied client is already validated by `TwitchClient::new`.
    pub async fn get_eventsubs(tokens: &dyn TokenSource, client: Option<&TwitchClient>) -> Result<Value, String> {
        let token = app(tokens).await;
        let (Some(client), Some(token)) = (client, token) else { return Ok(credential_error(true)); };
        let mut data = Vec::new(); let mut seen = HashSet::new(); let mut cursor = String::new();
        for _ in 0..1000 {
            let params = if cursor.is_empty() { query(&[("first", "100")])? } else { query(&[("first", "100"), ("after", &cursor)])? };
            let response = request(client, &token, Method::GET, Some(&params), None).await?;
            let ok = response.status().is_success();
            let mut page: Value = response.json().await.map_err(|e| e.to_string())?;
            if !ok || page.get("error").is_some_and(value_truthy) { return Ok(page); }
            if let Some(items) = page.get("data").and_then(Value::as_array) { data.extend(items.iter().cloned()); }
            let next = text_or_empty(page.pointer("/pagination/cursor"));
            if seen.contains(&next) { return Ok(json!({"error":"EventSub pagination returned a repeated cursor","status":502})); }
            if next.is_empty() {
                if !page.is_object() { page = json!({}); }
                page["total"] = json!(data.len()); page["data"] = json!(data); page["pagination"] = json!({}); page["complete"] = json!(true);
                return Ok(page);
            }
            seen.insert(next.clone());
            cursor = next;
        }
        Ok(json!({"error":"EventSub pagination exceeded safety limit","status":502}))
    }

    /// Creates a webhook subscription, or returns the matching stored record.
    /// `secret` and `client` are explicit configuration; no environment read or
    /// connection occurs until an operation is invoked. Errors from I/O propagate.
    pub async fn subscribe_twitch_event(tokens: &dyn TokenSource, client: Option<&TwitchClient>, directory: &dyn EventsubDirectory, store: &dyn EventsubStore, secret: Option<&str>, channel_id: &str, event_type: &str, version: &str, requested: &ICondition, config: Option<&Document>, ignore_existing: bool) -> Result<Value, String> {
        subscribe_twitch_event_raw(tokens, client, directory, store, secret, channel_id, event_type, version, &requested.to_bson(), config, ignore_existing).await
    }

    /// Variant preserving arbitrary JSON-compatible condition fields and values.
    pub async fn subscribe_twitch_event_raw(tokens: &dyn TokenSource, client: Option<&TwitchClient>, directory: &dyn EventsubDirectory, store: &dyn EventsubStore, secret: Option<&str>, channel_id: &str, event_type: &str, version: &str, requested: &Bson, config: Option<&Document>, ignore_existing: bool) -> Result<Value, String> {
        let Some(secret) = secret.filter(|v| !v.is_empty()) else { return Ok(json!({"error":"EventSub secret is not configured","message":"TWITCH_EVENTSUB_SECRET is not set","status":500})); };
        let Some(name) = directory.name(channel_id).await? else { return Ok(json!({"error":"Streamer not found","message":"Streamer not found","status":404})); };
        if !ignore_existing {
            for candidate in store.candidates(channel_id, event_type, version).await? {
                let empty = Bson::Document(Document::new());
                let stored = candidate.get("condition").unwrap_or(&empty);
                if !conditions_match(stored, requested) { continue; }
                // The source returns the first serialized match, then keeps it
                // only when `id` is truthy. A later document is not considered.
                if candidate.get("id").is_some_and(bson_truthy) { return projection(&candidate); }
                break;
            }
        }
        if let Some(message) = directory.header_error(channel_id).await? {
            return Ok(json!({"error":"Failed to get streamer header","message":message,"status":500}));
        }
        let token = app(tokens).await;
        let (Some(client), Some(token)) = (client, token) else {
            eprintln!("Error getting Twitch app credentials");
            return Ok(credential_error(false));
        };
        let condition_json: Value = bson::from_bson(requested.clone()).map_err(|e| e.to_string())?;
        let body = json!({"type":event_type,"version":version,"condition":condition_json,"transport":{"method":"webhook","callback":"https://subscriptions.domdimabot.com/eventsub","secret":secret}});
        let response = request(client, &token, Method::POST, None, Some(&body)).await?;
        let status = response.status().as_u16(); let ok = response.status().is_success();
        let payload: Value = response.json().await.map_err(|e| e.to_string())?;
        let first = payload.get("data").and_then(Value::as_array).and_then(|values| values.first());
        if !ok || payload.get("error").is_some_and(value_truthy) || first.is_none_or(|value| !value_truthy(value)) {
            let failure = subscribe_failure(&payload, status);
            let error = failure.get("error").and_then(Value::as_str).unwrap_or("");
            eprintln!("Error subscribing to {event_type} for {channel_id}: {error}");
            return Ok(failure);
        }
        let incoming = match first.and_then(Value::as_object) {
            Some(object) => bson::to_document(object).map_err(|e| e.to_string())?,
            None => Document::new(),
        };
        let source_id = incoming.get("id").cloned();
        let mut doc = Document::new();
        for key in ["id", "status", "type", "version", "condition", "created_at", "transport", "cost"] {
            if let Some(value) = incoming.get(key) { doc.insert(key, value.clone()); }
        }
        doc.insert("channel", name); doc.insert("channelID", channel_id);
        if let Some(config) = config { doc.extend(config.clone()); }
        projection(&store.upsert_with_source_id(source_id, doc).await?)
    }

    /// Deletes the remote subscription and its local record after a 204 or 404.
    /// Success is represented by the HTTP status; other statuses return the
    /// source-compatible error object. Transport and Mongo errors propagate.
    pub async fn unsubscribe_twitch_event(tokens: &dyn TokenSource, client: Option<&TwitchClient>, store: &dyn EventsubStore, id: &str) -> Result<Value, String> {
        let token = app(tokens).await;
        let (Some(client), Some(token)) = (client, token) else {
            eprintln!("Error getting Twitch app credentials");
            return Ok(credential_error(false));
        };
        let raw = format!("id={}", id.split('#').next().unwrap_or(""));
        let response = request(client, &token, Method::DELETE, Some(&raw), None).await?;
        let status = response.status().as_u16();
        if status == 204 || status == 404 { store.delete(id).await?; return Ok(json!({"status":status, "ok": status == 204})); }
        let data: Value = response.json().await.map_err(|e| e.to_string())?;
        let fallback = format!("Twitch returned HTTP {status}");
        let message = present_text(data.get("message")).or_else(|| present_text(data.get("error"))).unwrap_or(fallback);
        let error = present_text(data.get("error")).unwrap_or_else(|| "Failed to unsubscribe EventSub".into());
        eprintln!("Error unsubscribing to {id}: {message}");
        Ok(json!({"error": error, "message": message, "status": status}))
    }
}

#[cfg(all(feature = "twitch-functions", feature = "ordinary-application-schemas"))]
pub use remote::{get_eventsubs, subscribe_twitch_event, subscribe_twitch_event_raw, unsubscribe_twitch_event};
