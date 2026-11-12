//! `subscribeTwitchEvent`, `getEventsubs`, `unsubscribeTwitchEvent` and
//! `migrateLegacyBitsEventsubs` (`utils/eventsub.ts`).
//!
//! # Requests
//!
//! Every call is one Helix request with the app token (`Client-Id`, `Authorization: Bearer`,
//! `Content-Type: application/json`), sent once: no 401 refresh, no retry on 5xx, 429 or a
//! timeout, as in the reference (plain `fetch`). Each has [`EventsubSettings::request_timeout`]
//! (the reference has none).
//!
//! # A create is never sent twice
//!
//! The reference avoids duplicates in two ways, and so does this port: it never sends the same
//! create again on its own (a lost answer makes `fetch` throw; nothing retries), and Twitch
//! refuses a second subscription with the same type, version, condition and callback with 409.
//! So a create whose outcome is unknown ([`Failure::Unknown`]: the deadline passed after the
//! request left, the connection broke, the answer was unreadable, or a 2xx came without a
//! subscription) is reported, never repeated here, and nothing is stored; a later create of the
//! same subscription (a caller's retry, the next reconciliation, another process) gets 409
//! ([`SubscribeError::is_conflict`]) if the first one did reach Twitch, and the next listing
//! adopts it. A request that provably never left ([`Failure::NotSent`]) created nothing.
//!
//! # Differences from the reference
//!
//! - Where the reference throws (a network error, an unreadable answer, a MongoDB failure), the
//!   Rust functions return an error with a [`Failure`] saying what is known; the reference's
//!   callers catch the throw.
//! - A listed page that is not an object with a `data` array is an error (the reference counts
//!   a `null` page as the last one, so a listing could end early and still say `complete`).
//! - The id of a delete is URL-encoded (the reference concatenates it into the query; the same
//!   bytes for every id Twitch issues).
//! - A successful create whose subscription has no text `id` is [`Failure::Unknown`] (the
//!   reference would upsert on `{id: undefined}`).
//! - In the bits migration, a failed delete of a legacy subscription is recorded and the next one
//!   is tried even when the failure is a lost answer (the reference throws and stops there).

use super::bits::build_bits_eventsub_config;
use super::condition::{Condition, raid_config_type};
use super::js;
use super::settings::EventsubSettings;
use super::store::Eventsubs;
use super::types::{CANONICAL_BITS_EVENT_TYPE, LEGACY_BITS_EVENT_TYPES, Settings};
use crate::Twitch;
use crate::error::TwitchError;
use crate::events::{Destination, Level};
use crate::helix::{Auth, HelixError, HelixRequest};
use bson::{Bson, Document, doc};
use dima_http::Path;
use serde_json::{Map, Value, json};
use std::collections::HashSet;

/// What is known about a failed call.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Failure {
    /// Nothing was sent (no secret, no such streamer, no credential, the request could not
    /// leave): nothing changed at Twitch.
    NotSent,
    /// Twitch answered with an error (409 exists already, 403 missing authorization, 429 quota
    /// or rate limit, 4xx, 5xx): nothing was created or deleted.
    Twitch,
    /// The request may have reached Twitch and the answer was lost or unreadable: the
    /// subscription may exist (or be gone). Not repeated here.
    Unknown,
    /// A MongoDB read or write failed (for a create, Twitch may already have the subscription:
    /// see [`SubscribeError::subscription_id`]).
    Store,
}

/// A failed create, list or delete: the reference's `{error, message, status}` and what is known.
#[derive(Clone, Debug, PartialEq, thiserror::Error)]
#[error("{error}: {message} ({status})")]
pub struct SubscribeError {
    /// The reference's `error`.
    pub error: String,
    /// The reference's `message`.
    pub message: String,
    /// The reference's `status` (Twitch's status for a Twitch answer).
    pub status: u16,
    /// What is known.
    pub failure: Failure,
    /// `Ratelimit-Reset` of a 429 (epoch seconds).
    pub rate_limit_reset: Option<i64>,
    /// The subscription Twitch created when only the stored document is missing.
    pub subscription_id: Option<String>,
}

impl SubscribeError {
    fn new(error: &str, message: &str, status: u16, failure: Failure) -> Self {
        Self {
            error: error.to_owned(),
            message: message.to_owned(),
            status,
            failure,
            rate_limit_reset: None,
            subscription_id: None,
        }
    }

    /// Twitch has this subscription already (409).
    pub fn is_conflict(&self) -> bool {
        self.failure == Failure::Twitch && self.status == 409
    }

    /// `{error, message, status}` as the reference returns it.
    pub fn to_json(&self) -> Value {
        json!({ "error": self.error, "message": self.message, "status": self.status })
    }
}

/// A failed delete (same shape).
pub type UnsubscribeError = SubscribeError;

/// What `subscribeTwitchEvent` is asked to do.
#[derive(Clone, Copy, Debug)]
pub struct SubscribeRequest<'a> {
    /// The channel (`channelID`).
    pub channel_id: &'a str,
    /// The type.
    pub kind: &'a str,
    /// The version.
    pub version: &'a str,
    /// The condition, sent as it is.
    pub condition: &'a Condition,
    /// The settings written with it (`config`).
    pub settings: Option<&'a Settings>,
    /// `ignoreExisting`: do not return a stored subscription with the same condition.
    pub ignore_existing: bool,
    /// `appAuthOnly`: do not load the broadcaster's token first.
    pub app_auth_only: bool,
}

impl<'a> SubscribeRequest<'a> {
    /// A create of `kind` at `version` for `channel_id`.
    pub fn new(
        channel_id: &'a str,
        kind: &'a str,
        version: &'a str,
        condition: &'a Condition,
    ) -> Self {
        Self {
            channel_id,
            kind,
            version,
            condition,
            settings: None,
            ignore_existing: false,
            app_auth_only: false,
        }
    }

    /// With settings.
    #[must_use]
    pub fn settings(mut self, settings: &'a Settings) -> Self {
        self.settings = Some(settings);
        self
    }

    /// `{ignoreExisting: true}`.
    #[must_use]
    pub fn ignore_existing(mut self) -> Self {
        self.ignore_existing = true;
        self
    }

    /// `{appAuthOnly: true}`.
    #[must_use]
    pub fn app_auth_only(mut self) -> Self {
        self.app_auth_only = true;
        self
    }
}

/// A stored subscription as `toEventsubResponse` returns it (what the API sends the site).
#[derive(Clone, Debug, PartialEq)]
pub struct EventsubRecord {
    /// `_id` as text.
    pub object_id: Option<String>,
    /// Twitch's id.
    pub id: String,
    /// Twitch's status.
    pub status: String,
    /// The type, `channel.raid.outgoing` for an outgoing raid.
    pub kind: String,
    /// The version.
    pub version: String,
    /// The condition (`{}` when there is none).
    pub condition: Value,
    /// Twitch's creation time.
    pub created_at: String,
    /// The transport.
    pub transport: Value,
    /// The cost.
    pub cost: f64,
    /// The channel's login.
    pub channel: String,
    /// The channel's id.
    pub channel_id: String,
    /// `Boolean(enabled)`.
    pub enabled: bool,
    /// The message.
    pub message: String,
    /// The end message.
    pub end_message: String,
    /// `Boolean(endEnabled)`.
    pub end_enabled: bool,
    /// `Number(minViewers || 0)`.
    pub min_viewers: f64,
    /// The temporary-ban message.
    pub temporal_ban_message: String,
    /// `Boolean(clipEnabled)`.
    pub clip_enabled: bool,
    /// `Number(delay || 0)`.
    pub delay: f64,
    /// The cheer tiers (`[]` unless an array).
    pub cheer_tiers: Value,
    /// `todayFollows` as stored (left out when missing).
    pub today_follows: Option<Value>,
}

impl EventsubRecord {
    /// `toEventsubResponse(document)` of a stored document as read.
    pub fn from_document(document: &Document) -> Self {
        let get = |key: &str| document.get(key);
        let text = |key: &str| js::string_or_empty(get(key));
        let condition = match get("condition") {
            Some(value) if js::truthy(Some(value)) => js::to_json(value),
            _ => json!({}),
        };
        let kind = text("type");
        Self {
            object_id: match get("_id") {
                Some(Bson::ObjectId(id)) => Some(id.to_hex()),
                Some(value) if js::truthy(Some(value)) => Some(js::string_or_empty(Some(value))),
                _ => None,
            },
            id: text("id"),
            status: text("status"),
            kind: raid_config_type(&kind, &Condition::from_value(&condition)).to_owned(),
            version: text("version"),
            condition,
            created_at: text("created_at"),
            transport: match get("transport") {
                Some(value) if js::truthy(Some(value)) => js::to_json(value),
                _ => json!({ "method": "", "callback": "" }),
            },
            cost: js::number_or_zero(get("cost")),
            channel: text("channel"),
            channel_id: text("channelID"),
            enabled: js::truthy(get("enabled")),
            message: text("message"),
            end_message: text("endMessage"),
            end_enabled: js::truthy(get("endEnabled")),
            min_viewers: js::number_or_zero(get("minViewers")),
            temporal_ban_message: text("temporalBanMessage"),
            clip_enabled: js::truthy(get("clipEnabled")),
            delay: js::number_or_zero(get("delay")),
            cheer_tiers: match get("cheerTiers") {
                Some(value @ Bson::Array(_)) => js::to_json(value),
                _ => json!([]),
            },
            today_follows: get("todayFollows").map(js::to_json),
        }
    }

    /// The JSON the reference returns (`JSON.stringify` order; `_id` and `todayFollows` left
    /// out when undefined).
    pub fn to_json(&self) -> Value {
        let mut map = Map::new();
        if let Some(id) = &self.object_id {
            map.insert("_id".into(), Value::from(id.as_str()));
        }
        map.insert("id".into(), Value::from(self.id.as_str()));
        map.insert("status".into(), Value::from(self.status.as_str()));
        map.insert("type".into(), Value::from(self.kind.as_str()));
        map.insert("version".into(), Value::from(self.version.as_str()));
        map.insert("condition".into(), self.condition.clone());
        map.insert("created_at".into(), Value::from(self.created_at.as_str()));
        map.insert("transport".into(), self.transport.clone());
        map.insert("cost".into(), js::json_number(self.cost));
        map.insert("channel".into(), Value::from(self.channel.as_str()));
        map.insert("channelID".into(), Value::from(self.channel_id.as_str()));
        map.insert("enabled".into(), Value::from(self.enabled));
        map.insert("message".into(), Value::from(self.message.as_str()));
        map.insert("endMessage".into(), Value::from(self.end_message.as_str()));
        map.insert("endEnabled".into(), Value::from(self.end_enabled));
        map.insert("minViewers".into(), js::json_number(self.min_viewers));
        map.insert(
            "temporalBanMessage".into(),
            Value::from(self.temporal_ban_message.as_str()),
        );
        map.insert("clipEnabled".into(), Value::from(self.clip_enabled));
        map.insert("delay".into(), js::json_number(self.delay));
        map.insert("cheerTiers".into(), self.cheer_tiers.clone());
        if let Some(today) = &self.today_follows {
            map.insert("todayFollows".into(), today.clone());
        }
        Value::Object(map)
    }
}

/// A subscription as Twitch lists it, fields in Twitch's order (they are written in that order).
#[derive(Clone, Debug, PartialEq)]
pub struct RemoteEventsub(pub Map<String, Value>);

impl RemoteEventsub {
    fn text(&self, key: &str) -> &str {
        self.0.get(key).and_then(Value::as_str).unwrap_or_default()
    }

    /// `id`.
    pub fn id(&self) -> &str {
        self.text("id")
    }

    /// `status`.
    pub fn status(&self) -> &str {
        self.text("status")
    }

    /// `type`.
    pub fn kind(&self) -> &str {
        self.text("type")
    }

    /// `version`.
    pub fn version(&self) -> &str {
        self.text("version")
    }

    /// `created_at`.
    pub fn created_at(&self) -> &str {
        self.text("created_at")
    }

    /// `condition` (`{}` when it is not an object).
    pub fn condition(&self) -> Condition {
        self.0
            .get("condition")
            .map(Condition::from_value)
            .unwrap_or_default()
    }

    /// `transport` (`null` when missing).
    pub fn transport(&self) -> &Value {
        self.0.get("transport").unwrap_or(&Value::Null)
    }

    /// The fields the `eventsubs` schema knows, in Twitch's order, as the driver writes them
    /// (`$set: {...remote}`: Mongoose's strict mode drops the others).
    pub(crate) fn schema_fields(&self) -> Document {
        const FIELDS: [&str; 8] = [
            "id",
            "status",
            "type",
            "version",
            "condition",
            "created_at",
            "transport",
            "cost",
        ];
        self.0
            .iter()
            .filter(|(key, _)| FIELDS.contains(&key.as_str()))
            .map(|(key, value)| (key.clone(), js::from_json(value)))
            .collect()
    }
}

/// `getEventsubs(userId)`: every listed subscription, the listing read to its end.
#[derive(Clone, Debug, PartialEq)]
pub struct EventsubList {
    /// The subscriptions, in Twitch's order.
    pub data: Vec<RemoteEventsub>,
    /// The last page as Twitch sent it, its `data` emptied (`total`, `total_cost`,
    /// `max_total_cost`, `pagination`, in Twitch's order).
    pub summary: Map<String, Value>,
    /// Pages read.
    pub pages: u32,
}

impl EventsubList {
    /// `{...summary, data, total, pagination: {}, complete: true}` as the reference returns it.
    pub fn to_json(&self) -> Value {
        let mut map = self.summary.clone();
        map.insert(
            "data".into(),
            Value::Array(
                self.data
                    .iter()
                    .map(|remote| Value::Object(remote.0.clone()))
                    .collect(),
            ),
        );
        map.insert("total".into(), Value::from(self.data.len()));
        map.insert("pagination".into(), json!({}));
        map.insert("complete".into(), Value::Bool(true));
        Value::Object(map)
    }
}

/// Why a listing is incomplete. Nothing may be deleted on the strength of it.
#[derive(Clone, Debug, PartialEq, thiserror::Error)]
pub enum ListError {
    /// No app token or client id (`{error: 'Twitch app credentials are not configured', ...}`).
    #[error("Twitch app credentials are not configured")]
    AppCredentials,
    /// Twitch answered a page with an error; the page as Twitch sent it (the reference returns
    /// it).
    #[error("Twitch answered a page with status {status}")]
    Twitch {
        /// The status.
        status: u16,
        /// The page.
        page: Value,
    },
    /// More pages than [`EventsubSettings::max_pages`].
    #[error("EventSub pagination exceeded safety limit")]
    PageLimit,
    /// A cursor came back that was already used.
    #[error("EventSub pagination returned a repeated cursor")]
    RepeatedCursor,
    /// A page could not be read as a page (the reference throws, or ends the listing).
    #[error("a page of the EventSub listing could not be read (status {status})")]
    Malformed {
        /// The status.
        status: u16,
    },
    /// The request failed or its answer was lost.
    #[error("the EventSub listing request failed: {0}")]
    Request(String),
}

impl ListError {
    /// What the reference returns (or would throw, as an object of the same shape).
    pub fn to_json(&self) -> Value {
        match self {
            Self::AppCredentials => json!({
                "error": "Twitch app credentials are not configured",
                "message": "Unable to list EventSub subscriptions without an app token and client ID",
                "status": 500,
            }),
            Self::Twitch { page, .. } => page.clone(),
            Self::PageLimit | Self::RepeatedCursor => {
                json!({ "error": self.to_string(), "status": 502 })
            }
            Self::Malformed { status } => json!({ "error": self.to_string(), "status": status }),
            Self::Request(_) => json!({ "error": self.to_string(), "status": 502 }),
        }
    }
}

/// A delete Twitch accepted: 204, or 404 (already gone), after which the stored document is
/// removed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Unsubscribed {
    /// 204 or 404.
    pub status: u16,
    /// Stored documents removed (0 or 1).
    pub local_deleted: u64,
}

/// `migrateLegacyBitsEventsubs`'s result.
#[derive(Clone, Debug, PartialEq)]
pub struct BitsMigration {
    /// The canonical document afterwards (as read).
    pub canonical_eventsub: Option<Document>,
    /// A canonical document existed.
    pub had_canonical_before_migration: bool,
    /// Legacy documents existed.
    pub had_legacy_before_migration: bool,
    /// The canonical subscription was created.
    pub created_canonical: bool,
    /// Legacy subscriptions deleted.
    pub removed_legacy_count: u64,
    /// What failed, as the reference words it.
    pub errors: Vec<String>,
}

impl BitsMigration {
    /// The result as the reference's `JSON.stringify` writes it.
    pub fn to_json(&self) -> Value {
        json!({
            "canonicalEventsub": self
                .canonical_eventsub
                .as_ref()
                .map_or(Value::Null, |document| js::to_json(&Bson::Document(document.clone()))),
            "hadCanonicalBeforeMigration": self.had_canonical_before_migration,
            "hadLegacyBeforeMigration": self.had_legacy_before_migration,
            "createdCanonical": self.created_canonical,
            "removedLegacyCount": self.removed_legacy_count,
            "errors": self.errors,
        })
    }
}

/// A Helix answer, read.
struct Answer {
    status: u16,
    rate_limit_reset: Option<i64>,
    /// The body as `response.json()` reads it (`None`: not JSON, empty or unreadable).
    body: Option<Value>,
    /// The body could not be read to its end (a lost answer, not a malformed one).
    cut: bool,
}

/// Why a request has no answer.
enum Unanswered {
    /// No app token.
    Credential,
    /// It never left.
    NotSent(String),
    /// It may have reached Twitch.
    Lost(String),
}

const JSON_LIMITS: dima_text::JsonLimits = dima_text::JsonLimits {
    max_depth: 128,
    max_bytes: 16 * 1024 * 1024,
};

fn classify(error: &dima_http::Error) -> Unanswered {
    use dima_http::Error as E;
    use dima_http::TimeoutKind;
    match error {
        E::Timeout {
            kind: TimeoutKind::Queue | TimeoutKind::Connect,
            ..
        }
        | E::Connect { .. }
        | E::Blocked { .. }
        | E::Invalid { .. }
        | E::RequestBodyTooLarge { .. } => Unanswered::NotSent(error.to_string()),
        E::RetriesExhausted { last, .. } => classify(last),
        _ => Unanswered::Lost(error.to_string()),
    }
}

/// The manager: one per process, over the process's [`Twitch`].
#[derive(Clone, Debug)]
pub struct EventsubManager {
    pub(crate) twitch: Twitch,
    pub(crate) settings: EventsubSettings,
}

impl EventsubManager {
    /// The manager of `twitch` with `settings`.
    pub fn new(twitch: Twitch, settings: EventsubSettings) -> Self {
        Self { twitch, settings }
    }

    /// The settings.
    pub fn settings(&self) -> &EventsubSettings {
        &self.settings
    }

    /// The handle.
    pub fn twitch(&self) -> &Twitch {
        &self.twitch
    }

    pub(crate) fn store(&self) -> Eventsubs<'_> {
        Eventsubs::new(&self.twitch.inner)
    }

    fn log_error(&self, channel: Option<&str>, message: String) {
        self.twitch.inner.log(
            Level::Error,
            Destination::Console,
            channel,
            json!({ "message": message }),
        );
    }

    async fn send(&self, request: HelixRequest) -> Result<Answer, Unanswered> {
        let request = request.timeout(self.settings.request_timeout);
        let response = match self.twitch.helix(request).await {
            Ok(response) => response,
            Err(HelixError::Credential { .. }) => return Err(Unanswered::Credential),
            Err(HelixError::Http(error)) => return Err(classify(&error)),
        };
        let status = response.status().as_u16();
        let rate_limit_reset = response
            .headers()
            .get("ratelimit-reset")
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.trim().parse::<i64>().ok());
        let (body, cut) = match response.into_response().bytes().await {
            Ok(bytes) => {
                let text = String::from_utf8_lossy(&bytes);
                (dima_text::parse_js_json(&text, JSON_LIMITS).ok(), false)
            }
            Err(_) => (None, true),
        };
        Ok(Answer {
            status,
            rate_limit_reset,
            body,
            cut,
        })
    }

    fn app_credentials_error() -> SubscribeError {
        SubscribeError::new(
            "Error getting Twitch app credentials",
            "An app access token and client ID are required",
            500,
            Failure::NotSent,
        )
    }

    fn has_client_id(&self) -> bool {
        !self.twitch.config().client_id.is_empty()
    }

    /// `findExistingEventsub`: the first stored subscription of the channel with this type,
    /// version and condition (empty fields ignored).
    async fn find_existing(
        &self,
        request: &SubscribeRequest<'_>,
    ) -> Result<Option<Document>, TwitchError> {
        let wanted = request.condition.identity();
        let found = self
            .store()
            .find(
                "eventsubs.find existing",
                doc! { "channelID": request.channel_id, "type": request.kind, "version": request.version },
            )
            .await?;
        Ok(found.into_iter().find(|document| {
            let condition = document
                .get("condition")
                .map(js::to_json)
                .unwrap_or(Value::Null);
            Condition::from_value(&condition).identity() == wanted
        }))
    }

    /// `subscribeTwitchEvent(channelID, type, version, condition, config, options)`.
    pub async fn subscribe(
        &self,
        request: &SubscribeRequest<'_>,
    ) -> Result<EventsubRecord, SubscribeError> {
        let Some(body) =
            self.settings
                .create_body(request.kind, request.version, request.condition)
        else {
            return Err(SubscribeError::new(
                "EventSub secret is not configured",
                "TWITCH_EVENTSUB_SECRET is not set",
                500,
                Failure::NotSent,
            ));
        };
        let Some(streamer) = self.twitch.streamer(request.channel_id).await else {
            return Err(SubscribeError::new(
                "Streamer not found",
                "Streamer not found",
                404,
                Failure::NotSent,
            ));
        };
        if !request.ignore_existing {
            let existing = self.find_existing(request).await.map_err(|error| {
                SubscribeError::new(
                    "Failed to read stored EventSub subscriptions",
                    &error.to_string(),
                    500,
                    Failure::Store,
                )
            })?;
            if let Some(existing) = existing.filter(|e| js::truthy(e.get("id"))) {
                return Ok(EventsubRecord::from_document(&existing));
            }
        }
        if !request.app_auth_only
            && let Err(error) = self
                .twitch
                .streamer_credential(request.channel_id, None)
                .await
        {
            return Err(SubscribeError::new(
                "Failed to get streamer header",
                &error.message(),
                500,
                Failure::NotSent,
            ));
        }
        if !self.has_client_id() {
            self.log_error(None, "Error getting Twitch app credentials".into());
            return Err(Self::app_credentials_error());
        }
        let answer = self
            .send(
                HelixRequest::post(Path::fixed("/eventsub/subscriptions"), Auth::App)
                    .json(body)
                    .operation("subscribeTwitchEvent"),
            )
            .await;
        let answer = match answer {
            Ok(answer) => answer,
            Err(Unanswered::Credential) => {
                self.log_error(None, "Error getting Twitch app credentials".into());
                return Err(Self::app_credentials_error());
            }
            Err(Unanswered::NotSent(reason)) => {
                return Err(SubscribeError::new(
                    "Twitch request failed",
                    &reason,
                    502,
                    Failure::NotSent,
                ));
            }
            Err(Unanswered::Lost(reason)) => {
                return Err(SubscribeError::new(
                    "Twitch request failed",
                    &reason,
                    502,
                    Failure::Unknown,
                ));
            }
        };
        let ok = (200..300).contains(&answer.status);
        let data = answer.body.clone().unwrap_or(Value::Null);
        let first = data
            .get("data")
            .and_then(Value::as_array)
            .and_then(|items| items.first())
            .filter(|first| dima_text::js_truthy(*first));
        let data_error = data.get("error").filter(|e| dima_text::js_truthy(*e));
        if answer.body.is_none() || !ok || data_error.is_some() || first.is_none() {
            let error = data_error.map_or_else(
                || format!("Twitch returned HTTP {}", answer.status),
                dima_text::js_string,
            );
            let message = data
                .get("message")
                .filter(|m| dima_text::js_truthy(*m))
                .map_or_else(|| error.clone(), dima_text::js_string);
            self.log_error(
                Some(request.channel_id),
                format!(
                    "Error subscribing to {} for {}: {error}",
                    request.kind, request.channel_id
                ),
            );
            let failure = if ok || answer.cut {
                Failure::Unknown
            } else {
                Failure::Twitch
            };
            let mut failed = SubscribeError::new(&error, &message, answer.status, failure);
            failed.rate_limit_reset = answer.rate_limit_reset;
            return Err(failed);
        }
        let Some(Value::Object(created)) = first.cloned() else {
            return Err(SubscribeError::new(
                "Twitch returned an unreadable subscription",
                "Twitch returned an unreadable subscription",
                answer.status,
                Failure::Unknown,
            ));
        };
        let created = RemoteEventsub(created);
        let id = created.id().to_owned();
        if id.is_empty() {
            return Err(SubscribeError::new(
                "Twitch returned a subscription without an id",
                "Twitch returned a subscription without an id",
                answer.status,
                Failure::Unknown,
            ));
        }
        // `{...eventsubPayload, ...(config || {})}`: Twitch's fields, the channel, the settings.
        let mut payload = Document::new();
        for key in [
            "id",
            "status",
            "type",
            "version",
            "condition",
            "created_at",
            "transport",
            "cost",
        ] {
            if let Some(value) = created.0.get(key) {
                payload.insert(key, js::from_json(value));
            }
        }
        // `streamer.name` (left out when the directory entry has none, as `undefined` is).
        if let Some(name) = streamer.field("name") {
            payload.insert("channel", name);
        }
        payload.insert("channelID", request.channel_id);
        let mut set = payload.clone();
        if let Some(settings) = request.settings {
            set.extend(settings.to_document());
        }
        let stored = self
            .store()
            .set_returning("eventsubs.findOneAndUpdate", doc! { "id": &id }, set, true)
            .await
            .map_err(|error| {
                let mut failed = SubscribeError::new(
                    "Failed to store EventSub subscription",
                    &error.to_string(),
                    500,
                    Failure::Store,
                );
                failed.subscription_id = Some(id.clone());
                failed
            })?;
        Ok(EventsubRecord::from_document(
            stored.as_ref().unwrap_or(&payload),
        ))
    }

    /// `getEventsubs(userId)`: every page (`first=100`, then `after`), at most
    /// [`EventsubSettings::max_pages`]. Errors only for a listing not read to its end.
    pub async fn list(&self, user_id: Option<&str>) -> Result<EventsubList, ListError> {
        if !self.has_client_id() {
            return Err(ListError::AppCredentials);
        }
        let mut data = Vec::new();
        let mut seen: HashSet<String> = HashSet::new();
        let mut cursor = String::new();
        let summary;
        let mut pages = 0_u32;
        loop {
            pages += 1;
            if pages > self.settings.max_pages {
                return Err(ListError::PageLimit);
            }
            let mut request = HelixRequest::get(Path::fixed("/eventsub/subscriptions"), Auth::App)
                .query("first", "100")
                .operation("getEventsubs");
            if let Some(user) = user_id.filter(|user| !user.is_empty()) {
                request = request.query("user_id", user);
            }
            if !cursor.is_empty() {
                request = request.query("after", cursor.as_str());
            }
            let answer = match self.send(request).await {
                Ok(answer) => answer,
                Err(Unanswered::Credential) => return Err(ListError::AppCredentials),
                Err(Unanswered::NotSent(reason) | Unanswered::Lost(reason)) => {
                    return Err(ListError::Request(reason));
                }
            };
            let Some(page) = answer.body else {
                return Err(ListError::Malformed {
                    status: answer.status,
                });
            };
            let ok = (200..300).contains(&answer.status);
            if !ok || page.get("error").is_some_and(dima_text::js_truthy) {
                return Err(ListError::Twitch {
                    status: answer.status,
                    page,
                });
            }
            let Value::Object(mut page) = page else {
                return Err(ListError::Malformed {
                    status: answer.status,
                });
            };
            // The items move out; the key keeps its place for `{...summary, data, ...}`.
            let Some(Value::Array(items)) = page.get_mut("data").map(std::mem::take) else {
                return Err(ListError::Malformed {
                    status: answer.status,
                });
            };
            for item in items {
                match item {
                    Value::Object(item) => data.push(RemoteEventsub(item)),
                    _ => {
                        return Err(ListError::Malformed {
                            status: answer.status,
                        });
                    }
                }
            }
            let next = page
                .get("pagination")
                .and_then(|p| p.get("cursor"))
                .filter(|c| dima_text::js_truthy(*c))
                .map(dima_text::js_string)
                .unwrap_or_default();
            if seen.contains(&next) {
                return Err(ListError::RepeatedCursor);
            }
            if next.is_empty() {
                summary = page;
                break;
            }
            seen.insert(next.clone());
            cursor = next;
        }
        Ok(EventsubList {
            data,
            summary,
            pages,
        })
    }

    /// `unsubscribeTwitchEvent(id)`: 204 and 404 are success (the subscription is gone either
    /// way) and remove the stored document.
    pub async fn unsubscribe(&self, id: &str) -> Result<Unsubscribed, UnsubscribeError> {
        if !self.has_client_id() {
            self.log_error(None, "Error getting Twitch app credentials".into());
            return Err(Self::app_credentials_error());
        }
        let answer = self
            .send(
                HelixRequest::delete(Path::fixed("/eventsub/subscriptions"), Auth::App)
                    .query("id", id)
                    .operation("unsubscribeTwitchEvent"),
            )
            .await;
        let answer = match answer {
            Ok(answer) => answer,
            Err(Unanswered::Credential) => {
                self.log_error(None, "Error getting Twitch app credentials".into());
                return Err(Self::app_credentials_error());
            }
            Err(Unanswered::NotSent(reason)) => {
                return Err(SubscribeError::new(
                    "Failed to unsubscribe EventSub",
                    &reason,
                    502,
                    Failure::NotSent,
                ));
            }
            Err(Unanswered::Lost(reason)) => {
                return Err(SubscribeError::new(
                    "Failed to unsubscribe EventSub",
                    &reason,
                    502,
                    Failure::Unknown,
                ));
            }
        };
        if answer.status == 204 || answer.status == 404 {
            let local_deleted = self
                .store()
                .delete_one("eventsubs.deleteOne", doc! { "id": id })
                .await
                .map_err(|error| {
                    SubscribeError::new(
                        "Failed to remove stored EventSub subscription",
                        &error.to_string(),
                        500,
                        Failure::Store,
                    )
                })?;
            return Ok(Unsubscribed {
                status: answer.status,
                local_deleted,
            });
        }
        let data = answer.body.unwrap_or(Value::Null);
        let truthy = |key: &str| data.get(key).filter(|v| dima_text::js_truthy(*v));
        let message = truthy("message").or_else(|| truthy("error")).map_or_else(
            || format!("Twitch returned HTTP {}", answer.status),
            dima_text::js_string,
        );
        let error = truthy("error").map_or_else(
            || "Failed to unsubscribe EventSub".to_owned(),
            dima_text::js_string,
        );
        self.log_error(None, format!("Error unsubscribing to {id}: {message}"));
        let mut failed = SubscribeError::new(&error, &message, answer.status, Failure::Twitch);
        failed.rate_limit_reset = answer.rate_limit_reset;
        Err(failed)
    }

    /// `migrateLegacyBitsEventsubs(channelID)`: create the canonical `channel.bits.use` with the
    /// merged settings first (or merge them into the existing one), then delete each legacy
    /// subscription. A failure half-way leaves the canonical subscription and whatever legacy
    /// ones could not be deleted (both deliver; the bot skips the legacy events of a channel
    /// that has the canonical one); the next run deletes the rest. A store failure is an error
    /// (the reference throws).
    pub async fn migrate_legacy_bits(
        &self,
        channel_id: &str,
    ) -> Result<BitsMigration, TwitchError> {
        let store = self.store();
        let canonical = store
            .find_one(
                "eventsubs.findOne canonical bits",
                doc! { "channelID": channel_id, "type": CANONICAL_BITS_EVENT_TYPE },
            )
            .await?;
        let legacy = store
            .find(
                "eventsubs.find legacy bits",
                doc! { "channelID": channel_id, "type": { "$in": LEGACY_BITS_EVENT_TYPES.to_vec() } },
            )
            .await?;
        let mut result = BitsMigration {
            canonical_eventsub: canonical.clone(),
            had_canonical_before_migration: canonical.is_some(),
            had_legacy_before_migration: !legacy.is_empty(),
            created_canonical: false,
            removed_legacy_count: 0,
            errors: Vec::new(),
        };
        if legacy.is_empty() {
            return Ok(result);
        }
        let merged = build_bits_eventsub_config(canonical.as_ref(), &legacy);
        let current = match &canonical {
            None => {
                let condition = Condition::of(&[("broadcaster_user_id", channel_id)]);
                let request =
                    SubscribeRequest::new(channel_id, CANONICAL_BITS_EVENT_TYPE, "1", &condition)
                        .settings(&merged);
                if let Err(error) = self.subscribe(&request).await {
                    result.errors.push(if error.message.is_empty() {
                        "Failed to create canonical bits eventsub".to_owned()
                    } else {
                        error.message
                    });
                    return Ok(result);
                }
                result.created_canonical = true;
                store
                    .find_one(
                        "eventsubs.findOne canonical bits",
                        doc! { "channelID": channel_id, "type": CANONICAL_BITS_EVENT_TYPE },
                    )
                    .await?
            }
            Some(document) => {
                let object_id = super::store::filter_value(document, "_id");
                store
                    .set_returning(
                        "eventsubs.findOneAndUpdate canonical bits",
                        doc! { "_id": object_id },
                        merged.to_document(),
                        false,
                    )
                    .await?
            }
        };
        for document in &legacy {
            // `${value}` of a lean value (`undefined` when missing).
            let template = |key: &str| {
                document.get(key).map_or_else(
                    || "undefined".to_owned(),
                    |value| dima_text::js_string_with(value, js::js),
                )
            };
            let id = template("id");
            if self.unsubscribe(&id).await.is_err() {
                let kind = template("type");
                result.errors.push(format!("Failed to remove {kind}"));
                continue;
            }
            result.removed_legacy_count += 1;
        }
        result.canonical_eventsub = current;
        Ok(result)
    }
}
