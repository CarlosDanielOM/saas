//! Native port of `dimabot/src/utils/temporary_roles_announcements.ts`.
//!
//! Temporary moderator/VIP removals are queued per channel and announced once
//! the role work settles. The TypeScript helper is a thin Redis list plus the
//! context-free half of `sendTwitchChatMessage`; this module reuses the native
//! `TwitchFunctions` sender instead of introducing a chat trait/mock.
//!
//! Source behavior preserved:
//! - `enqueue`: `RPUSH` a payload
//!   `{role,username,userID,removedAt}` on
//!   `twitch:temporary-roles:pending-announcements:<channelID>`, then
//!   `EXPIRE` it for 14 days (`1209600` seconds).
//! - `enqueue` normalizes the username (`String(value || '').trim()`, strip all
//!   leading `@`, lowercase) and trims `userID`.
//! - `flush`: `LRANGE 0 -1`; an empty list returns `{sent: 0}` without touching
//!   the key. Malformed JSON, non-`vip`/`moderator` roles, and entries with no
//!   usable login are skipped.
//! - Grouping is per role, in list insertion order, de-duplicated by normalized
//!   login, with `normalizeLogin(username) || normalizeLogin(userID)` as the
//!   login. VIP is sent before moderator.
//! - A group of at most `COMPRESSION_THRESHOLD` (5) users sends one message per
//!   user sequentially; a larger group sends a single `"<n> users were removed
//!   from ..."` message.
//! - The first send error stops the flush and leaves the whole list in place;
//!   `DEL` happens only after every group succeeded. `sent` counts unique logins,
//!   not messages.
//!
//! Explicit boundaries (not silently claimed):
//! - The queue is reached through an injected concrete shared
//!   `redis::aio::ConnectionManager`; construction performs no I/O. The
//!   [`TemporaryRoleAnnouncements::application`] adapter lazily resolves the
//!   existing native Redis manager for callers that do not already hold one.
//!   That manager uses the existing `utils::redis` contract (environment host
//!   and port, database 0); the source's `'TemporaryRoleAnnouncements'` client
//!   label has no native per-caller equivalent.
//! - Timestamps come from an injected [`AnnouncementClock`]; `new` uses the
//!   system clock. This keeps the source's `new Date().toISOString()` shape
//!   testable without changing the persisted format.
//! - `JSON.parse`/`JSON.stringify` are represented by `serde_json`. Deeply
//!   nested or non-finite-number payloads that V8 accepts/rejects differently
//!   are outside this ordinary typed-payload API; such an item is skipped as
//!   malformed, exactly like any other unparsable entry.
//! - JavaScript `toLowerCase()` contextual casing (for example Greek final
//!   sigma) is not reproduced; Twitch logins are ASCII. Trim and `@` stripping
//!   use the shared JavaScript whitespace rules.
//! - The chat sender's own boundaries (AST context, reply IDs, log timestamps)
//!   are documented in `functions::chats::send_message_plain`.

use crate::{
    functions::{TwitchFunctions, chats::send_message_plain::js_value_string, truthy},
    utils::{
        credit_policy::JsDate,
        js_compat::trim as js_trim,
        logger::{Clock, SystemClock},
    },
};
use redis::{RedisError, RedisResult, aio::ConnectionManager};
use serde::Serialize;
use serde_json::Value;
use std::{collections::HashSet, fmt, sync::Arc};

pub const PENDING_KEY_PREFIX: &str = "twitch:temporary-roles:pending-announcements";
/// `14 * 24 * 60 * 60`.
pub const PENDING_TTL_SECONDS: u64 = 1_209_600;
/// Compressed messages are used only when a group is strictly larger.
pub const COMPRESSION_THRESHOLD: usize = 5;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum TemporaryRole {
    Vip,
    Moderator,
}

impl TemporaryRole {
    pub const fn as_str(&self) -> &'static str {
        match self {
            Self::Vip => "vip",
            Self::Moderator => "moderator",
        }
    }

    /// Strict source comparison; only the two exact strings are roles.
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "vip" => Some(Self::Vip),
            "moderator" => Some(Self::Moderator),
            _ => None,
        }
    }
}

/// Exact source field order and names (`userID` is intentionally not camelCase).
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct PendingAnnouncementPayload {
    pub role: TemporaryRole,
    pub username: String,
    #[serde(rename = "userID")]
    pub user_id: String,
    #[serde(rename = "removedAt")]
    pub removed_at: String,
}

impl PendingAnnouncementPayload {
    pub fn new(role: TemporaryRole, username: &str, user_id: &str, removed_at: &str) -> Self {
        Self {
            role,
            username: normalize_login(username),
            user_id: js_trim(user_id).to_owned(),
            removed_at: removed_at.to_owned(),
        }
    }
}

/// Injected time source for `removedAt`; the source uses `new Date()`.
pub trait AnnouncementClock: Send + Sync {
    fn now_iso8601(&self) -> String;
}

pub struct SystemAnnouncementClock;

impl AnnouncementClock for SystemAnnouncementClock {
    fn now_iso8601(&self) -> String {
        JsDate::from_millis(SystemClock.now_millis() as f64)
            .to_iso_string()
            .expect("system clock within JavaScript Date range")
    }
}

pub fn pending_announcements_key(channel_id: &str) -> String {
    format!("{PENDING_KEY_PREFIX}:{channel_id}")
}

/// `String(value || '').trim().replace(/^@+/, '').toLowerCase()`.
pub fn normalize_login(value: &str) -> String {
    js_trim(value).trim_start_matches('@').to_lowercase()
}

pub fn single_removal_message(role: TemporaryRole, username: &str) -> String {
    let normalized = normalize_login(username);
    let mention = if normalized.is_empty() {
        "User".to_owned()
    } else {
        format!("@{normalized}")
    };
    match role {
        TemporaryRole::Vip => format!("{mention} has been removed from VIP"),
        TemporaryRole::Moderator => format!("{mention} has been removed from moderator"),
    }
}

pub fn compressed_removal_message(role: TemporaryRole, count: usize) -> String {
    match role {
        TemporaryRole::Vip => format!("{count} users were removed from VIP"),
        TemporaryRole::Moderator => format!("{count} users were removed from moderator"),
    }
}

/// Ordered, de-duplicated logins; insertion order is the first occurrence.
#[derive(Default)]
struct OrderedLogins {
    seen: HashSet<String>,
    items: Vec<String>,
}

impl OrderedLogins {
    fn push(&mut self, login: String) {
        if self.seen.insert(login.clone()) {
            self.items.push(login);
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct GroupedAnnouncements {
    pub vip: Vec<String>,
    pub moderator: Vec<String>,
}

/// Source `String(value || '')` for a declared string field.
fn login_field(value: Option<&Value>) -> String {
    match value {
        Some(value) if truthy(value) => js_value_string(value),
        _ => String::new(),
    }
}

/// Apply the source's skip/role/dedupe rules to raw queue entries.
pub fn group_pending_announcements(items: &[String]) -> GroupedAnnouncements {
    let mut vip = OrderedLogins::default();
    let mut moderator = OrderedLogins::default();
    for raw in items {
        let Ok(parsed) = serde_json::from_str::<Value>(raw) else {
            continue;
        };
        let Some(role) = parsed
            .get("role")
            .and_then(Value::as_str)
            .and_then(TemporaryRole::parse)
        else {
            continue;
        };
        let username = normalize_login(&login_field(parsed.get("username")));
        let login = if username.is_empty() {
            normalize_login(&login_field(parsed.get("userID")))
        } else {
            username
        };
        if login.is_empty() {
            continue;
        }
        match role {
            TemporaryRole::Vip => vip.push(login),
            TemporaryRole::Moderator => moderator.push(login),
        }
    }
    GroupedAnnouncements {
        vip: vip.items,
        moderator: moderator.items,
    }
}

/// What the source's `sendRoleRemovalBatch` would do for one group.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum BatchPlan {
    /// Empty group: return without sending.
    Empty,
    /// One sequential message per entry, in order.
    Individual(Vec<String>),
    /// Strictly more than [`COMPRESSION_THRESHOLD`] entries: one message.
    Compressed(String),
}

pub fn batch_plan(role: TemporaryRole, users: &[String]) -> BatchPlan {
    if users.is_empty() {
        return BatchPlan::Empty;
    }
    if users.len() > COMPRESSION_THRESHOLD {
        return BatchPlan::Compressed(compressed_removal_message(role, users.len()));
    }
    BatchPlan::Individual(
        users
            .iter()
            .map(|user| single_removal_message(role, user))
            .collect(),
    )
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FlushResult {
    /// Unique logins announced, matching the source's return value.
    pub sent: usize,
}

#[derive(Debug)]
pub enum FlushError {
    Cache(RedisError),
    /// The source throws `new Error(response.message || default)`.
    Send(String),
}

impl fmt::Display for FlushError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Cache(error) => error.fmt(f),
            Self::Send(message) => f.write_str(message),
        }
    }
}

impl std::error::Error for FlushError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Cache(error) => Some(error),
            Self::Send(_) => None,
        }
    }
}

/// Concrete announcement queue bound to the shared native Redis manager and the
/// existing native Twitch function adapter. Construction performs no I/O.
pub struct TemporaryRoleAnnouncements {
    cache: ConnectionManager,
    functions: TwitchFunctions,
    clock: Arc<dyn AnnouncementClock>,
}

impl TemporaryRoleAnnouncements {
    pub fn new(cache: ConnectionManager, functions: TwitchFunctions) -> Self {
        Self::with_clock(cache, functions, Arc::new(SystemAnnouncementClock))
    }

    pub fn with_clock(
        cache: ConnectionManager,
        functions: TwitchFunctions,
        clock: Arc<dyn AnnouncementClock>,
    ) -> Self {
        Self {
            cache,
            functions,
            clock,
        }
    }

    /// Lazy application adapter: resolves the process-wide native Redis manager
    /// on first use. Kept out of the constructor so importing/building this
    /// module never reads the environment or connects.
    pub async fn application(functions: TwitchFunctions) -> RedisResult<Self> {
        Ok(Self::new(
            crate::utils::redis::get_redis_client().await?,
            functions,
        ))
    }

    /// Append one removal and refresh the queue TTL.
    pub async fn enqueue(
        &self,
        channel_id: &str,
        role: TemporaryRole,
        username: &str,
        user_id: &str,
    ) -> RedisResult<()> {
        let key = pending_announcements_key(channel_id);
        let payload =
            PendingAnnouncementPayload::new(role, username, user_id, &self.clock.now_iso8601());
        let json = serde_json::to_string(&payload).expect("pending announcement serializes");
        let mut connection = self.cache.clone();
        let _: i64 = redis::cmd("RPUSH")
            .arg(key.as_str())
            .arg(json.as_str())
            .query_async(&mut connection)
            .await?;
        let _: i64 = redis::cmd("EXPIRE")
            .arg(key.as_str())
            .arg(PENDING_TTL_SECONDS)
            .query_async(&mut connection)
            .await?;
        Ok(())
    }

    /// Announce all pending removals for one channel.
    pub async fn flush(&self, channel_id: &str) -> Result<FlushResult, FlushError> {
        let key = pending_announcements_key(channel_id);
        let mut connection = self.cache.clone();
        let raw: Vec<Vec<u8>> = redis::cmd("LRANGE")
            .arg(key.as_str())
            .arg(0)
            .arg(-1)
            .query_async(&mut connection)
            .await
            .map_err(FlushError::Cache)?;

        if raw.is_empty() {
            return Ok(FlushResult { sent: 0 });
        }

        // Node's UTF-8 string decoding replaces invalid sequences; keep that
        // observable "unparsable entry" behavior instead of failing the flush.
        let items: Vec<String> = raw
            .into_iter()
            .map(|item| String::from_utf8_lossy(&item).into_owned())
            .collect();
        let grouped = group_pending_announcements(&items);

        for (role, users) in [
            (TemporaryRole::Vip, &grouped.vip),
            (TemporaryRole::Moderator, &grouped.moderator),
        ] {
            match batch_plan(role, users) {
                BatchPlan::Empty => {}
                BatchPlan::Compressed(message) => {
                    let response = self
                        .functions
                        .send_message_plain(channel_id, &message)
                        .await;
                    if response.error {
                        return Err(FlushError::Send(
                            response
                                .message_text_or("Failed sending compressed role removal message"),
                        ));
                    }
                }
                BatchPlan::Individual(messages) => {
                    for message in messages {
                        let response = self
                            .functions
                            .send_message_plain(channel_id, &message)
                            .await;
                        if response.error {
                            return Err(FlushError::Send(
                                response.message_text_or("Failed sending role removal message"),
                            ));
                        }
                    }
                }
            }
        }

        let _: i64 = redis::cmd("DEL")
            .arg(key.as_str())
            .query_async(&mut connection)
            .await
            .map_err(FlushError::Cache)?;
        Ok(FlushResult {
            sent: grouped.vip.len() + grouped.moderator.len(),
        })
    }
}
