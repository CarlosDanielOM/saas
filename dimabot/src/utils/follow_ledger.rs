//! Manual port of `src/utils/follow_ledger.ts`.
//!
//! The follow-relationship ledger collector. It owns the Helix follower/followed
//! pagination, the active/ended bookkeeping, mutual reconciliation and the
//! follow-start event write for `follow_relationship_ledgers`.
//!
//! Runtime boundaries:
//! - [`FollowLedgerService::new`] takes already-built handles and performs no
//!   I/O: no connection, no index installation and no environment read.
//! - [`FollowLedgerService::from_runtime`] is the single explicit wiring point.
//!   It resolves the native MongoDB/Redis handles and builds ONE
//!   [`SharedTwitchTokens`] handle for both the Helix client and the streamer
//!   directory. It creates no indexes and spawns no task.
//! - Nothing runs at import time.
//!
//! Follow-start writes are transactional on a replica set and fall back to the
//! source's non-transactional branch on a standalone deployment. The selection is
//! made by the driver at `start_transaction`/first statement: the source detects
//! the same condition by inspecting the server error, so both paths are reachable
//! with unchanged application input. [`FollowLedgerService::last_follow_start_mode`]
//! reports which path the last successful write used.
//!
//! Behaviour kept from the source: Helix page size is always `first=100` while
//! `DEFAULT_BATCH_SIZE = 250` bounds write batches (not page size); the scan is
//! `followers` (incoming) plus `followed` (outgoing) run concurrently; upserts
//! match on `(platform, follower_id, followed_id, status: 'active')`; rows that
//! disappear from a scan are ended with `missing_in_followers_scan` /
//! `missing_in_following_scan`; mutual flags are set from the reverse active set
//! and reset when the reverse edge ends; `reconcileMutualForChannel` runs after
//! both scans; `followed_at` accepts either a date or a string and falls back to
//! "now" when the value is missing or unparsable.
//!
//! Deliberate deviations are documented in
//! `migration-notes/follow-ledger-data-handoff.md`.
use std::{
    collections::{HashSet, VecDeque},
    fmt,
    future::Future,
    pin::Pin,
    sync::{
        Arc,
        atomic::{AtomicU8, Ordering},
    },
    time::Duration,
};

use futures_util::TryStreamExt;
use mongodb::{
    ClientSession, Collection, Database,
    bson::{Bson, DateTime, Document, doc},
    error::{
        Error as MongoError, ErrorKind, TRANSIENT_TRANSACTION_ERROR,
        UNKNOWN_TRANSACTION_COMMIT_RESULT, WriteFailure,
    },
    options::UpdateOneModel,
};
use redis::aio::ConnectionManager;
use reqwest::{Method, header::HeaderMap};
use serde_json::{Value, json};

use super::{
    follow_ledger_queue::javascript_iso_millis,
    js_compat::trim,
    js_date,
    links::get_twitch_helix_url,
    logger::{Destination, Level, LogOptions, Logger},
    twitch::{
        AccessToken, HelixRequest, HelixRetryPolicy, OAUTH_API_FAILURE_PREFIX,
        OAUTH_DIAGNOSTIC_TTL_SECONDS, TokenFuture, TokenSource, TwitchAuth, TwitchClient,
        TwitchCredentials, TwitchEndpoints, TwitchError, TwitchOAuthClient, api_failure_diagnostic,
    },
    twitch_headers::{
        STREAMER_PERMISSIONS_MESSAGE, STREAMER_TOKEN_MESSAGE, streamer_not_found_message,
    },
    twitch_streamers::{
        DirectoryCache, DirectoryConfig, DirectoryFuture, MetadataStore, StreamerCredentials,
        TwitchStreamers,
    },
    twitch_tokens::{CachedAccount, TokenClock, TwitchTokenStorage},
};
use crate::schemas::{
    ValidationErrors,
    follow_relationship_ledger::{
        self as ledger_schema, COLLECTION_NAME as LEDGER_COLLECTION, FollowRelationshipLedger,
    },
};

/// Source `DEFAULT_BATCH_SIZE`: the write-batch size, not the Helix page size.
pub const DEFAULT_BATCH_SIZE: usize = 250;
/// Source `FOLLOW_START_MAX_ATTEMPTS`.
pub const FOLLOW_START_MAX_ATTEMPTS: usize = 3;
/// Collection that holds streamer accounts; the channel list is read from here.
pub const USERS_COLLECTION: &str = "users";
/// Source: every scan query hard-codes the Twitch platform.
pub const PLATFORM_TWITCH: &str = "twitch";
/// Source Helix page size (`params.first = '100'`).
pub const HELIX_PAGE_SIZE: u32 = 100;
/// Source `recordFollowLedgerStart` default platform.
pub const DEFAULT_PLATFORM: &str = "twitch";
/// Messages the source returns before any scan starts.
pub const INVALID_CHANNEL_MESSAGE: &str = "Invalid channel ID";
pub const SYNC_COMPLETE_MESSAGE: &str = "Follow ledger sync completed";
/// Source `worker` tag on every Helix diagnostic for this collector.
pub const OAUTH_DIAGNOSTIC_WORKER: &str = "follow_ledger";

/// Codes the source treats as a retryable follow-start failure.
const RETRYABLE_MONGO_CODES: [i32; 5] = [11000, 112, 91, 189, 251];
/// `IllegalOperation`: a replica-set-only statement ran on a standalone server.
const ILLEGAL_OPERATION_CODE: i32 = 20;
/// Source `isTransactionUnsupportedError` phrase.
const TRANSACTION_UNSUPPORTED_PHRASE: &str =
    "transaction numbers are only allowed on a replica set member or mongos";

type MongoResult<T> = std::result::Result<T, MongoError>;

/// Which write path committed the last successful follow-start row.
///
/// The source chooses implicitly: `session.withTransaction` succeeds on a replica
/// set and its error branch runs the session-less sequence on a standalone
/// deployment. The native port surfaces the same selection so an operator can see
/// whether the deployment actually provides atomicity.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FollowStartWriteMode {
    /// A driver session committed the four operations as one transaction.
    Transactional,
    /// The deployment rejected transactions; the source's non-transactional
    /// fallback ran instead.
    StandaloneFallback,
}

impl FollowStartWriteMode {
    fn code(self) -> u8 {
        match self {
            Self::Transactional => 1,
            Self::StandaloneFallback => 2,
        }
    }

    fn from_code(code: u8) -> Option<Self> {
        match code {
            1 => Some(Self::Transactional),
            2 => Some(Self::StandaloneFallback),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Transactional => "transactional",
            Self::StandaloneFallback => "standalone_fallback",
        }
    }
}

/// Source `followed_at?: Date | string`.
///
/// `Date` is a BSON date; `Text` goes through the JavaScript date parser, and an
/// empty or unparsable string falls back to "now" exactly like `toDate()`.
#[derive(Clone, Debug, PartialEq)]
pub enum FollowLedgerDate {
    Date(DateTime),
    Text(String),
}

impl FollowLedgerDate {
    /// `toDate(value)`: a valid date is returned unchanged, a non-blank string is
    /// parsed, and anything else becomes `now`.
    pub fn resolve(&self, now: DateTime) -> DateTime {
        match self {
            Self::Date(at) => *at,
            Self::Text(text) => {
                let text = trim(text);
                if text.is_empty() {
                    return now;
                }
                js_date::parse_date(text)
                    .map(DateTime::from_millis)
                    .unwrap_or(now)
            }
        }
    }
}

/// Source `RecordFollowLedgerStartInput`. Every field is optional on the source
/// interface; `platform` is not trimmed, matching `input.platform || 'twitch'`.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct RecordFollowLedgerStartInput {
    pub follower_id: Option<String>,
    pub follower_login: Option<String>,
    pub follower_name: Option<String>,
    pub followed_id: Option<String>,
    pub followed_login: Option<String>,
    pub followed_name: Option<String>,
    pub followed_at: Option<FollowLedgerDate>,
    pub platform: Option<String>,
}

impl RecordFollowLedgerStartInput {
    /// The two identifiers are required in practice; both are still normalised
    /// the same way the source does, including the empty-string early return.
    pub fn new(follower_id: impl Into<String>, followed_id: impl Into<String>) -> Self {
        Self {
            follower_id: Some(follower_id.into()),
            followed_id: Some(followed_id.into()),
            ..Self::default()
        }
    }
}

/// A Helix `channels/followers` item after source-style normalisation.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct HelixFollowerItem {
    pub user_id: String,
    pub user_login: String,
    pub user_name: String,
    pub followed_at: String,
}

/// A Helix `channels/followed` item after source-style normalisation.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct HelixFollowedItem {
    pub broadcaster_id: String,
    pub broadcaster_login: String,
    pub broadcaster_name: String,
    pub followed_at: String,
}

/// Source `FollowSyncStats`, spread into the result by the source.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct FollowLedgerSyncStats {
    pub total_from_api: f64,
    pub requests: usize,
    pub pages: usize,
    pub active_upserts: usize,
    pub ended_count: usize,
}

impl FollowLedgerSyncStats {
    /// Source `mergeFollowSyncStats`.
    pub fn merge(self, other: Self) -> Self {
        Self {
            total_from_api: self.total_from_api + other.total_from_api,
            requests: self.requests + other.requests,
            pages: self.pages + other.pages,
            active_upserts: self.active_upserts + other.active_upserts,
            ended_count: self.ended_count + other.ended_count,
        }
    }
}

/// Hook futures are awaited before each page request, as in the source.
pub type FollowLedgerHookFuture<'a> = Pin<Box<dyn Future<Output = ()> + Send + 'a>>;
/// Source `beforeRequest?: () => Promise<void>` and its two specific variants.
pub type FollowLedgerHook = Arc<dyn Fn() -> FollowLedgerHookFuture<'static> + Send + Sync>;

/// Source `FollowLedgerSyncOptions`.
#[derive(Clone, Default)]
pub struct FollowLedgerSyncOptions {
    /// `Math.max(1, options.writeBatchSize || DEFAULT_BATCH_SIZE)`.
    pub write_batch_size: Option<usize>,
    pub before_request: Option<FollowLedgerHook>,
    pub before_followers_request: Option<FollowLedgerHook>,
    pub before_following_request: Option<FollowLedgerHook>,
}

impl fmt::Debug for FollowLedgerSyncOptions {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("FollowLedgerSyncOptions")
            .field("write_batch_size", &self.write_batch_size)
            .field("before_request", &self.before_request.is_some())
            .field(
                "before_followers_request",
                &self.before_followers_request.is_some(),
            )
            .field(
                "before_following_request",
                &self.before_following_request.is_some(),
            )
            .finish()
    }
}

/// Source `FollowLedgerSyncResult`. The statistics are spread into the result in
/// the source, so the same five values are top-level fields here.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct FollowLedgerSyncResult {
    pub error: bool,
    pub message: String,
    pub channel_id: Option<String>,
    /// Carried for shape parity; the source's `syncFollowLedgerForChannel` never
    /// populates it because page status is dropped by the scan helpers.
    pub status: Option<u16>,
    pub total_from_api: f64,
    pub requests: usize,
    pub pages: usize,
    pub active_upserts: usize,
    pub ended_count: usize,
}

impl FollowLedgerSyncResult {
    fn with_stats(mut self, stats: FollowLedgerSyncStats) -> Self {
        self.total_from_api = stats.total_from_api;
        self.requests = stats.requests;
        self.pages = stats.pages;
        self.active_upserts = stats.active_upserts;
        self.ended_count = stats.ended_count;
        self
    }
}

/// A sync result plus the typed failure, when one occurred.
///
/// [`FollowLedgerService::sync_follow_ledger_for_channel`] returns only the
/// source-shaped result. Callers that need a typed decision (for example a job
/// runner deciding whether to retry) read `failure` here; it is `None` for
/// pre-flight rejections only in the sense that the result already encodes them
/// as `error: true`.
#[derive(Debug)]
pub struct FollowLedgerSyncOutcome {
    pub result: FollowLedgerSyncResult,
    pub failure: Option<FollowLedgerError>,
}

/// Streamer identity and permission flag used by the sync gate.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FollowLedgerStreamer {
    /// Source `TwitchStreamers.getTwitchAccountById(channelID)?.name`.
    pub login: String,
    /// Source `has_permissions` is compared strictly against `'true'`.
    pub has_permissions: String,
}

pub type FollowLedgerFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// Source `TwitchStreamers.getTwitchAccountById`, whose failures become `null`.
pub trait FollowLedgerStreamerDirectory: Send + Sync {
    fn streamer<'a>(
        &'a self,
        channel_id: &'a str,
    ) -> FollowLedgerFuture<'a, Option<FollowLedgerStreamer>>;
}

impl FollowLedgerStreamerDirectory for TwitchStreamers {
    fn streamer<'a>(
        &'a self,
        channel_id: &'a str,
    ) -> FollowLedgerFuture<'a, Option<FollowLedgerStreamer>> {
        Box::pin(async move {
            // The source helper catches every directory error and returns null,
            // so a transport problem is reported as "not found" here too.
            self.account_by_id(channel_id)
                .await
                .ok()
                .map(|account| FollowLedgerStreamer {
                    login: account.metadata.name,
                    has_permissions: account.has_permissions,
                })
        })
    }
}

/// One [`TwitchTokenStorage`] shared by both roles the collector needs: the
/// Helix `TokenSource` and the streamer directory's `StreamerCredentials`.
///
/// The source builds one storage and reuses it (`TwitchStreamers` and
/// `getTwitchStreamerHeaderById` both flow through the token cache). Holding two
/// independent storages would double the pooled refresh leases and defeat
/// refresh coalescing, so the production root creates this once and passes the
/// same `Arc` to `TwitchStreamers::new` and to [`FollowLedgerService`]. This
/// mirrors `NativeFunctionAuth` in `functions/mod.rs`, which holds
/// `tokens: Arc<TwitchTokenStorage>` next to `directory: Arc<TwitchStreamers>`.
pub struct SharedTwitchTokens {
    storage: Arc<TwitchTokenStorage>,
}

impl SharedTwitchTokens {
    /// Wraps a storage the composition root already configured (for example with
    /// `with_refresh_guard`). No I/O.
    pub fn new(storage: TwitchTokenStorage) -> Self {
        Self {
            storage: Arc::new(storage),
        }
    }

    /// Shares an existing handle instead of taking ownership.
    pub fn from_shared(storage: Arc<TwitchTokenStorage>) -> Self {
        Self { storage }
    }

    /// The single concrete storage behind both roles.
    pub fn storage(&self) -> &Arc<TwitchTokenStorage> {
        &self.storage
    }
}

impl TokenSource for SharedTwitchTokens {
    fn token<'a>(&'a self, auth: &'a TwitchAuth) -> TokenFuture<'a> {
        // `TwitchTokenStorage` already implements `TokenSource`; delegate so the
        // mapping to `TokenSourceError` is not duplicated.
        self.storage.token(auth)
    }
}

impl StreamerCredentials for SharedTwitchTokens {
    fn snapshot<'a>(&'a self, id: &'a str) -> DirectoryFuture<'a, CachedAccount> {
        Box::pin(async move { Ok(self.storage.account_snapshot(id).await?) })
    }

    fn token<'a>(&'a self, id: &'a str) -> DirectoryFuture<'a, AccessToken> {
        Box::pin(async move { Ok(self.storage.acquire_account_token(id).await?) })
    }

    fn refresh_secret<'a>(&'a self, id: &'a str) -> DirectoryFuture<'a, String> {
        Box::pin(async move { Ok(self.storage.refresh_secret(id).await?) })
    }
}

/// Source `cacheOAuthAPIFailure` record for one exhausted Helix 401.
///
/// The follow-ledger call site does not pass request headers, so `headers` is
/// empty here exactly as the source's `requestHeaders ?? {}` fallback. The
/// transport-owned variant is described in the handoff.
pub struct OAuthApiFailureRecord<'a> {
    pub url: &'a str,
    pub method: &'a str,
    pub headers: &'a HeaderMap,
    pub status: u16,
    pub body: &'a str,
    pub worker: &'a str,
    pub operation: &'a str,
    pub channel_id: Option<&'a str>,
    pub context: Option<Value>,
    /// Known credential strings to redact from free text; usually empty.
    pub secrets: &'a [&'a str],
}

/// Failure of the OAuth debug-cache write. The collector logs and continues on
/// this error, matching `cacheOAuthAPIFailure`'s swallowed `catch`.
#[derive(Debug)]
pub enum OAuthFailureCacheError {
    Redis(redis::RedisError),
}

impl fmt::Display for OAuthFailureCacheError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Redis(error) => std::fmt::Display::fmt(error, formatter),
        }
    }
}

impl std::error::Error for OAuthFailureCacheError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Redis(error) => Some(error),
        }
    }
}

impl From<redis::RedisError> for OAuthFailureCacheError {
    fn from(error: redis::RedisError) -> Self {
        Self::Redis(error)
    }
}

/// Sanitized `cacheOAuthAPIFailure` payload.
///
/// `crate::utils::twitch::api_failure_diagnostic` already produces the transport
/// fields (timestamp, endpoint, sanitized URL/headers, clientId, status, body).
/// This adds the source's worker/operation/channelID/context fields in the
/// source's property order and applies the source's `process.env.CLIENT_ID`
/// clientId fallback when no request headers were available.
pub fn oauth_api_failure_payload(
    record: &OAuthApiFailureRecord<'_>,
    timestamp_ms: i64,
) -> Value {
    let mut payload = api_failure_diagnostic(
        &javascript_iso_millis(timestamp_ms),
        record.url,
        record.method,
        record.headers,
        record.status,
        record.body,
        record.secrets,
    );
    if let Value::Object(fields) = &mut payload {
        if fields.get("clientId").and_then(Value::as_str) == Some("unknown")
            && let Ok(client_id) = std::env::var("CLIENT_ID")
            && !client_id.is_empty()
        {
            fields.insert("clientId".into(), Value::String(client_id));
        }
        fields.insert("worker".into(), Value::String(record.worker.to_owned()));
        fields.insert(
            "operation".into(),
            Value::String(record.operation.to_owned()),
        );
        if let Some(channel_id) = record.channel_id {
            fields.insert("channelID".into(), Value::String(channel_id.to_owned()));
        }
        if let Some(context) = &record.context {
            fields.insert("context".into(), context.clone());
        }
    }
    payload
}

/// Writes the source's OAuth API failure debug cache entry:
/// `SET oauth:failures:api:<Date.now()> <json> EX 86400`.
///
/// This is the concrete adapter for the side effect `cacheOAuthAPIFailure`
/// performs. The collector calls it for its own exhausted 401s; the transport
/// (`utils::twitch`) must call the same function once its 401 hook is wired (see
/// the handoff contract). Errors are returned, not logged: callers reproduce the
/// source's swallow.
pub async fn cache_oauth_api_failure(
    connection: &mut ConnectionManager,
    record: &OAuthApiFailureRecord<'_>,
) -> Result<(), OAuthFailureCacheError> {
    let timestamp_ms = DateTime::now().timestamp_millis();
    let payload = oauth_api_failure_payload(record, timestamp_ms);
    let key = format!("{OAUTH_API_FAILURE_PREFIX}{timestamp_ms}");
    let _: () = redis::cmd("SET")
        .arg(key)
        .arg(payload.to_string())
        .arg("EX")
        .arg(OAUTH_DIAGNOSTIC_TTL_SECONDS)
        .query_async(connection)
        .await?;
    Ok(())
}

/// Typed collector failure. Neither `Display` nor `Debug` includes credentials,
/// environment values or raw Helix headers.
#[derive(Debug)]
pub enum FollowLedgerError {
    InvalidChannelId,
    StreamerNotFound { channel_id: String },
    StreamerPermissions,
    StreamerToken,
    /// Non-2xx or `error: true` Helix body; `message` is the source's message.
    HelixResponse { message: String, status: Option<u16> },
    Twitch(TwitchError),
    Mongo(MongoError),
    Redis(redis::RedisError),
    Directory(crate::utils::twitch_streamers::DirectoryError),
    Validation(ValidationErrors),
    Configuration(&'static str),
}

impl FollowLedgerError {
    /// Source `status` field, when the failure carried one.
    pub fn status(&self) -> Option<u16> {
        match self {
            Self::HelixResponse { status, .. } => *status,
            _ => None,
        }
    }
}

impl fmt::Display for FollowLedgerError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidChannelId => formatter.write_str(INVALID_CHANNEL_MESSAGE),
            Self::StreamerNotFound { channel_id } => {
                formatter.write_str(&streamer_not_found_message(channel_id))
            }
            Self::StreamerPermissions => formatter.write_str(STREAMER_PERMISSIONS_MESSAGE),
            Self::StreamerToken => formatter.write_str(STREAMER_TOKEN_MESSAGE),
            Self::HelixResponse { message, .. } => formatter.write_str(message),
            Self::Twitch(error) => std::fmt::Display::fmt(error, formatter),
            Self::Mongo(error) => std::fmt::Display::fmt(error, formatter),
            Self::Redis(error) => std::fmt::Display::fmt(error, formatter),
            Self::Directory(error) => std::fmt::Display::fmt(error, formatter),
            Self::Validation(error) => std::fmt::Display::fmt(error, formatter),
            Self::Configuration(message) => formatter.write_str(message),
        }
    }
}

impl std::error::Error for FollowLedgerError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Twitch(error) => Some(error),
            Self::Mongo(error) => Some(error),
            Self::Redis(error) => Some(error),
            Self::Directory(error) => Some(error),
            Self::Validation(error) => Some(error),
            _ => None,
        }
    }
}

impl From<MongoError> for FollowLedgerError {
    fn from(error: MongoError) -> Self {
        Self::Mongo(error)
    }
}

impl From<TwitchError> for FollowLedgerError {
    fn from(error: TwitchError) -> Self {
        Self::Twitch(error)
    }
}

impl From<ValidationErrors> for FollowLedgerError {
    fn from(error: ValidationErrors) -> Self {
        Self::Validation(error)
    }
}

/// One normalised follow-start edge. Kept as a struct so the write path has a
/// single, explicit argument instead of nine positional strings.
struct FollowStartEdge<'a> {
    platform: &'a str,
    follower_id: &'a str,
    follower_login: &'a str,
    follower_name: &'a str,
    followed_id: &'a str,
    followed_login: &'a str,
    followed_name: &'a str,
    followed_at: DateTime,
}

/// Source `SyncIncomingResult` / `SyncOutgoingResult` success payload.
struct HalfOutcome {
    stats: FollowLedgerSyncStats,
    /// Source page-level early return. Statistics collected before the failure
    /// are retained, exactly like the source.
    page_error: Option<FollowLedgerError>,
}

impl HalfOutcome {
    fn done(stats: FollowLedgerSyncStats) -> Self {
        Self {
            stats,
            page_error: None,
        }
    }

    fn failed(stats: FollowLedgerSyncStats, error: FollowLedgerError) -> Self {
        Self {
            stats,
            page_error: Some(error),
        }
    }
}

/// Concrete follow-ledger data service.
///
/// The handle holds real driver collections, the native Twitch client, the token
/// source and the streamer directory. Cloning is not offered: the Twitch client
/// and driver handles are cheap to clone, but a second service instance would
/// silently duplicate configuration.
pub struct FollowLedgerService {
    ledger: Collection<FollowRelationshipLedger>,
    users: Collection<Document>,
    twitch: TwitchClient,
    tokens: Arc<dyn TokenSource>,
    directory: Arc<dyn FollowLedgerStreamerDirectory>,
    retry: HelixRetryPolicy,
    batch_size: usize,
    logger: Option<Arc<Logger>>,
    /// Redis connection for the OAuth API failure debug cache. `None` disables
    /// the write only in dependency-injected fixtures; `from_runtime` always
    /// supplies it.
    oauth_cache: Option<ConnectionManager>,
    /// `FollowStartWriteMode` code of the last successful follow-start write.
    last_follow_start_mode: AtomicU8,
}

impl FollowLedgerService {
    /// Builds the service from existing handles. No I/O, no index installation,
    /// no environment read.
    pub fn new(
        database: Database,
        twitch: TwitchClient,
        tokens: Arc<dyn TokenSource>,
        directory: Arc<dyn FollowLedgerStreamerDirectory>,
    ) -> Self {
        Self {
            ledger: ledger_schema::collection(&database),
            users: database.collection(USERS_COLLECTION),
            twitch,
            tokens,
            directory,
            retry: HelixRetryPolicy::default(),
            batch_size: DEFAULT_BATCH_SIZE,
            logger: None,
            oauth_cache: None,
            last_follow_start_mode: AtomicU8::new(0),
        }
    }

    /// Composition root for the production token path: ONE
    /// [`SharedTwitchTokens`] supplies both the Helix `TokenSource` and the
    /// streamer directory's `StreamerCredentials`, so a refresh performed through
    /// either role is observed by the other and the refresh lease is shared.
    ///
    /// Applying `TwitchTokenStorage::with_refresh_guard` is the caller's
    /// responsibility (the native `NativeCredentials` adapter used to do it; the
    /// shared handle must be configured once, before it is wrapped).
    pub fn with_shared_tokens(
        database: Database,
        twitch: TwitchClient,
        tokens: Arc<SharedTwitchTokens>,
        store: Arc<dyn MetadataStore>,
        cache: Arc<dyn DirectoryCache>,
        clock: Arc<dyn TokenClock>,
        config: DirectoryConfig,
    ) -> std::result::Result<Self, FollowLedgerError> {
        let directory = TwitchStreamers::new(store, cache, tokens.clone(), clock, config)
            .map_err(FollowLedgerError::Directory)?;
        Ok(Self::new(database, twitch, tokens, Arc::new(directory)))
    }

    /// Enables the OAuth API failure debug cache (`cacheOAuthAPIFailure`).
    pub fn with_oauth_failure_cache(mut self, connection: ConnectionManager) -> Self {
        self.oauth_cache = Some(connection);
        self
    }

    /// Which write path the most recent successful
    /// [`Self::record_follow_ledger_start`] used. `None` before the first success.
    pub fn last_follow_start_mode(&self) -> Option<FollowStartWriteMode> {
        FollowStartWriteMode::from_code(self.last_follow_start_mode.load(Ordering::Relaxed))
    }

    /// Explicit runtime wiring: resolves the process-wide MongoDB and Redis
    /// handles plus the Twitch credentials, token storage and streamer directory.
    ///
    /// This is the only constructor that touches the environment. It installs no
    /// indexes, starts no task and stores nothing in a static.
    pub async fn from_runtime() -> std::result::Result<Self, FollowLedgerError> {
        use super::credential_crypto::CredentialCipher;
        use super::mongo::get_mongo_client;
        use super::redis::get_redis_client;
        use super::twitch_tokens::{MongoCredentialStore, RedisTokenCache, SystemTokenClock};
        use super::twitch_streamers::{MongoStreamerStore, RedisStreamerCache};

        let client = get_mongo_client()
            .await
            .map_err(FollowLedgerError::Mongo)?;
        let database = client
            .default_database()
            .ok_or(FollowLedgerError::Configuration(
                "MONGO_URI does not select a database; build FollowLedgerService::new with an explicit database",
            ))?
            .clone();
        let cache = get_redis_client()
            .await
            .map_err(FollowLedgerError::Redis)?;

        let endpoints = TwitchEndpoints::default();
        let credentials = TwitchCredentials::from_env().map_err(FollowLedgerError::Twitch)?;
        let oauth: Arc<dyn super::twitch_tokens::OAuthExchange> = Arc::new(
            TwitchOAuthClient::new(credentials, endpoints.clone(), None)
                .map_err(FollowLedgerError::Twitch)?,
        );
        let cipher = CredentialCipher::from_env().map_err(|_| {
            FollowLedgerError::Configuration(
                "SECRET_KEY is missing or unusable for Twitch credential decryption",
            )
        })?;

        // ONE storage for both roles. The directory's previous adapter
        // (`NativeCredentials`) applied this guard itself; a shared storage must
        // be configured once, before it is wrapped.
        let storage = TwitchTokenStorage::new(
            Arc::new(MongoCredentialStore::new(&database)),
            Arc::new(RedisTokenCache::new(cache.clone())),
            oauth,
            Arc::new(SystemTokenClock::default()),
            cipher,
        )
        .with_refresh_guard(Duration::from_secs(30), Duration::from_secs(25))
        .map_err(|_| {
            FollowLedgerError::Configuration("Twitch token refresh guard is not configurable")
        })?;
        let tokens = Arc::new(SharedTwitchTokens::new(storage));

        let client_id = std::env::var("CLIENT_ID")
            .ok()
            .filter(|value| !value.is_empty())
            .ok_or(FollowLedgerError::Configuration("CLIENT_ID is not set"))?;
        let twitch = TwitchClient::new(client_id, endpoints, Some(Duration::from_secs(20)))
            .map_err(FollowLedgerError::Twitch)?;

        let store = Arc::new(MongoStreamerStore::new(&database));
        let directory_cache = Arc::new(RedisStreamerCache::new(cache.clone()));
        let service = Self::with_shared_tokens(
            database,
            twitch,
            tokens,
            store,
            directory_cache,
            Arc::new(SystemTokenClock::default()),
            DirectoryConfig::default(),
        )?;
        Ok(service.with_oauth_failure_cache(cache))
    }

    /// Attaches the shared logger. The source logs collector failures with
    /// `console.error`; those two sites emit a console-destination record.
    pub fn with_logger(mut self, logger: Arc<Logger>) -> Self {
        self.logger = Some(logger);
        self
    }

    /// Source `Math.max(1, options.writeBatchSize || DEFAULT_BATCH_SIZE)` default.
    pub fn with_write_batch_size(mut self, batch_size: usize) -> Self {
        self.batch_size = batch_size.max(1);
        self
    }

    /// Native equivalent of the source's 401 retry contract. The default is
    /// `[1000, 3000, 5000]` ms with a token reacquisition before each replay.
    pub fn with_retry_policy(mut self, retry: HelixRetryPolicy) -> Self {
        self.retry = retry;
        self
    }

    pub fn ledger(&self) -> &Collection<FollowRelationshipLedger> {
        &self.ledger
    }

    pub fn users(&self) -> &Collection<Document> {
        &self.users
    }

    pub fn ledger_collection_name(&self) -> &'static str {
        LEDGER_COLLECTION
    }

    // -----------------------------------------------------------------------
    // recordFollowLedgerStart
    // -----------------------------------------------------------------------

    /// Source `recordFollowLedgerStart`.
    ///
    /// The source returns `void` and only logs failures. This port returns the
    /// typed error so a caller can decide; the worker can ignore the value to
    /// reproduce the original control flow. A missing or blank identifier still
    /// returns `Ok(())` without touching MongoDB, as in the source.
    pub async fn record_follow_ledger_start(
        &self,
        input: &RecordFollowLedgerStartInput,
    ) -> std::result::Result<(), FollowLedgerError> {
        let platform = match input.platform.as_deref() {
            Some(value) if !value.is_empty() => value,
            _ => DEFAULT_PLATFORM,
        };
        let follower_id = normalize_owned(input.follower_id.as_deref());
        let followed_id = normalize_owned(input.followed_id.as_deref());
        if follower_id.is_empty() || followed_id.is_empty() {
            return Ok(());
        }

        let event_at = resolve_followed_at(input.followed_at.as_ref(), DateTime::now());
        let follower_login = normalize_owned(input.follower_login.as_deref());
        let follower_name = normalize_owned(input.follower_name.as_deref());
        let followed_login = normalize_owned(input.followed_login.as_deref());
        let followed_name = normalize_owned(input.followed_name.as_deref());
        let edge = FollowStartEdge {
            platform,
            follower_id: &follower_id,
            follower_login: &follower_login,
            follower_name: &follower_name,
            followed_id: &followed_id,
            followed_login: &followed_login,
            followed_name: &followed_name,
            followed_at: event_at,
        };

        let mut last_error = None;
        for attempt in 1..=FOLLOW_START_MAX_ATTEMPTS {
            match self.write_follow_start_in_transaction(&edge).await {
                Ok(()) => {
                    self.last_follow_start_mode
                        .store(FollowStartWriteMode::Transactional.code(), Ordering::Relaxed);
                    return Ok(());
                }
                Err(error) if is_transaction_unsupported(&error) => {
                    // Source `isTransactionUnsupportedError` branch: this
                    // deployment cannot run the atomic sequence, so run the same
                    // four operations without a session.
                    match self.write_follow_start(&edge, None).await {
                        Ok(()) => {
                            self.last_follow_start_mode.store(
                                FollowStartWriteMode::StandaloneFallback.code(),
                                Ordering::Relaxed,
                            );
                            return Ok(());
                        }
                        Err(fallback_error) => {
                            let retryable = is_retryable_follow_start_error(&fallback_error);
                            last_error = Some(fallback_error);
                            if retryable && attempt < FOLLOW_START_MAX_ATTEMPTS {
                                continue;
                            }
                            break;
                        }
                    }
                }
                Err(error) => {
                    let retryable = is_retryable_follow_start_error(&error);
                    last_error = Some(error);
                    if retryable && attempt < FOLLOW_START_MAX_ATTEMPTS {
                        continue;
                    }
                    break;
                }
            }
        }
        let error = last_error.unwrap_or(FollowLedgerError::Configuration(
            "follow start write produced no outcome",
        ));
        self.log_failure("recordFollowLedgerStart", &error, Some(&follower_id))
            .await;
        Err(error)
    }

    /// Source `session.withTransaction(() => writeFollowStart(session))`.
    ///
    /// The session is created per attempt and both the transaction and the
    /// session are finished before this returns: commit on success, abort on any
    /// body error. `ClientSession`'s `Drop` also aborts an open transaction, but
    /// that runs asynchronously, so it is treated only as a last-resort safety
    /// net for a panic or an unexpected early return.
    async fn write_follow_start_in_transaction(
        &self,
        edge: &FollowStartEdge<'_>,
    ) -> std::result::Result<(), FollowLedgerError> {
        let mut session = self.client_session().await?;
        // On a standalone deployment this fails with
        // `ErrorKind::Transaction {"Transactions are not supported by this
        // deployment"}`; the caller falls back to the session-less branch.
        if let Err(error) = session.start_transaction().await {
            return Err(FollowLedgerError::Mongo(error));
        }
        match self.write_follow_start(edge, Some(&mut session)).await {
            Ok(()) => match session.commit_transaction().await {
                Ok(()) => Ok(()),
                // A failed commit has already finalized the transaction; an
                // abort afterwards is invalid, and the driver owns commit
                // retry-by-apply semantics.
                Err(error) => Err(FollowLedgerError::Mongo(error)),
            },
            Err(error) => {
                // Abort before the session is dropped so nothing is left open.
                // Abort errors are ignored, matching the driver's own Drop path.
                let _ = session.abort_transaction().await;
                Err(error)
            }
        }
    }

    /// The four source operations. `session` attaches every one of them to the
    /// same transaction; `None` runs the source's standalone fallback.
    async fn write_follow_start(
        &self,
        edge: &FollowStartEdge<'_>,
        mut session: Option<&mut ClientSession>,
    ) -> std::result::Result<(), FollowLedgerError> {
        // Reverse active edge: the source reads it before ending the forward one.
        let reverse_query = self
            .ledger
            .find_one(doc! {
                "platform": edge.platform,
                "follower_id": edge.followed_id,
                "followed_id": edge.follower_id,
                "status": "active",
            })
            .projection(doc! {"_id":1,"mutual":1});
        let reverse = match session.as_deref_mut() {
            Some(session) => reverse_query.session(session).await?,
            None => reverse_query.await?,
        };
        let reverse_mutual = reverse.as_ref().is_some_and(|row| js_truthy(row.get("mutual")));

        let end_query = self.ledger.update_many(
            doc! {
                "platform": edge.platform,
                "follower_id": edge.follower_id,
                "followed_id": edge.followed_id,
                "status": "active",
            },
            doc! {
                "$set": {
                    "status": "ended",
                    "ended_at": edge.followed_at,
                    "ended_reason": "unknown",
                    "mutual": false,
                    "last_event_at": edge.followed_at,
                    "updated_at": DateTime::now(),
                }
            },
        );
        match session.as_deref_mut() {
            Some(session) => end_query.session(session).await?,
            None => end_query.await?,
        };

        let document = ledger_schema::schema().prepare_insert(
            doc! {
                "platform": edge.platform,
                "follower_id": edge.follower_id,
                "follower_login": edge.follower_login,
                "follower_name": edge.follower_name,
                "followed_id": edge.followed_id,
                "followed_login": edge.followed_login,
                "followed_name": edge.followed_name,
                "followed_at": edge.followed_at,
                "ended_at": Bson::Null,
                "ended_reason": Bson::Null,
                "mutual": reverse.is_some(),
                "status": "active",
                "last_event_at": edge.followed_at,
            },
            DateTime::now(),
        )?;
        let insert_query = self.ledger.insert_one(&document);
        match session.as_deref_mut() {
            Some(session) => insert_query.session(session).await?,
            None => insert_query.await?,
        };

        if reverse.is_some() && !reverse_mutual {
            let promote_query = self.ledger.update_one(
                doc! {
                    "platform": edge.platform,
                    "follower_id": edge.followed_id,
                    "followed_id": edge.follower_id,
                    "status": "active",
                },
                doc! {
                    "$set": {
                        "mutual": true,
                        "last_event_at": edge.followed_at,
                        "updated_at": DateTime::now(),
                    }
                },
            );
            match session.as_deref_mut() {
                Some(session) => promote_query.session(session).await?,
                None => promote_query.await?,
            };
        }
        Ok(())
    }

    async fn client_session(&self) -> std::result::Result<ClientSession, FollowLedgerError> {
        self.ledger
            .client()
            .start_session()
            .await
            .map_err(FollowLedgerError::Mongo)
    }

    // -----------------------------------------------------------------------
    // getFollowLedgerSyncChannelIDs
    // -----------------------------------------------------------------------

    /// Source `getFollowLedgerSyncChannelIDs`. The source returns `[]` on error
    /// after logging; this port returns the typed error after the same log.
    pub async fn get_follow_ledger_sync_channel_ids(
        &self,
    ) -> std::result::Result<Vec<String>, FollowLedgerError> {
        match self.read_sync_channel_ids().await {
            Ok(ids) => Ok(ids),
            Err(error) => {
                self.log_failure("getFollowLedgerSyncChannelIDs", &error, None)
                    .await;
                Err(error)
            }
        }
    }

    async fn read_sync_channel_ids(&self) -> std::result::Result<Vec<String>, FollowLedgerError> {
        let mut cursor = self
            .users
            .find(doc! {
                "accounts": {
                    "$elemMatch": {
                        "type": "twitch",
                        "actived": true,
                        "has_permissions": true,
                    }
                }
            })
            .projection(doc! {"accounts":1})
            .await?;
        let mut ids = Vec::new();
        let mut seen = HashSet::new();
        while let Some(user) = cursor.try_next().await? {
            let Some(accounts) = user.get_array("accounts").ok() else {
                continue;
            };
            for account in accounts {
                let Some(account) = account.as_document().ok() else {
                    continue;
                };
                // Source `account.type !== 'twitch'`: strict string equality.
                if account.get("type").and_then(Bson::as_str) != Some(PLATFORM_TWITCH) {
                    continue;
                }
                if !js_truthy(account.get("actived")) || !js_truthy(account.get("has_permissions")) {
                    continue;
                }
                let account_id = normalize_owned(account.get("id").and_then(Bson::as_str));
                if account_id.is_empty() {
                    continue;
                }
                // Source `Boolean(account.refresh_token?.content)`.
                let has_refresh_token = account
                    .get("refresh_token")
                    .and_then(|value| value.as_document().ok())
                    .and_then(|token| token.get("content"))
                    .is_some_and(|content| js_truthy(Some(content)));
                if !has_refresh_token {
                    continue;
                }
                if seen.insert(account_id.clone()) {
                    ids.push(account_id);
                }
            }
        }
        Ok(ids)
    }

    // -----------------------------------------------------------------------
    // syncFollowLedgerForChannel
    // -----------------------------------------------------------------------

    /// Source `syncFollowLedgerForChannel`, returning only the source-shaped
    /// result. Failures are encoded as `error: true` plus the exact message.
    pub async fn sync_follow_ledger_for_channel(
        &self,
        channel_id: &str,
        options: &FollowLedgerSyncOptions,
    ) -> FollowLedgerSyncResult {
        self.sync_follow_ledger_for_channel_outcome(channel_id, options)
            .await
            .result
    }

    /// Same flow as [`Self::sync_follow_ledger_for_channel`], but the typed
    /// failure is returned alongside the result so a job runner can classify it.
    pub async fn sync_follow_ledger_for_channel_outcome(
        &self,
        channel_id: &str,
        options: &FollowLedgerSyncOptions,
    ) -> FollowLedgerSyncOutcome {
        let channel_value = normalize_owned(Some(channel_id));

        // Source pre-flight, before its try/catch: blank channel, directory
        // lookup, permission flag, token acquisition.
        if channel_value.is_empty() {
            return failed_outcome(
                FollowLedgerError::InvalidChannelId,
                channel_id.to_owned(),
                FollowLedgerSyncStats::default(),
            );
        }
        let streamer = match self.directory.streamer(&channel_value).await {
            Some(streamer) => streamer,
            None => {
                return failed_outcome(
                    FollowLedgerError::StreamerNotFound {
                        channel_id: channel_value.clone(),
                    },
                    channel_value,
                    FollowLedgerSyncStats::default(),
                );
            }
        };
        // Source `account.has_permissions !== 'true'`: a strict comparison.
        if streamer.has_permissions != "true" {
            return failed_outcome(
                FollowLedgerError::StreamerPermissions,
                channel_value,
                FollowLedgerSyncStats::default(),
            );
        }
        let auth = TwitchAuth::Streamer(channel_value.clone());
        if self.tokens.token(&auth).await.is_err() {
            return failed_outcome(
                FollowLedgerError::StreamerToken,
                channel_value,
                FollowLedgerSyncStats::default(),
            );
        }
        let streamer_login = normalize_owned(Some(streamer.login.as_str()));

        let batch_size = match options.write_batch_size {
            Some(value) if value > 0 => value,
            _ => self.batch_size,
        };
        let before_followers = options
            .before_followers_request
            .clone()
            .or_else(|| options.before_request.clone());
        let before_following = options
            .before_following_request
            .clone()
            .or_else(|| options.before_request.clone());

        let (incoming, outgoing) = tokio::join!(
            self.sync_incoming_followers(
                &channel_value,
                &streamer_login,
                batch_size,
                before_followers
            ),
            self.sync_outgoing_followed(
                &channel_value,
                &streamer_login,
                batch_size,
                before_following
            ),
        );

        // A thrown scan error becomes the source's catch branch: zeroed stats.
        let (incoming, outgoing) = match (incoming, outgoing) {
            (Err(error), _) => {
                return failed_outcome(error, channel_value, FollowLedgerSyncStats::default());
            }
            (_, Err(error)) => {
                return failed_outcome(error, channel_value, FollowLedgerSyncStats::default());
            }
            (Ok(incoming), Ok(outgoing)) => (incoming, outgoing),
        };
        let stats = incoming.stats.merge(outgoing.stats);

        // Source checks the incoming outcome first, then the outgoing one.
        if let Some(error) = incoming.page_error {
            return failed_outcome(error, channel_value, stats);
        }
        if let Some(error) = outgoing.page_error {
            return failed_outcome(error, channel_value, stats);
        }

        if let Err(error) = self.reconcile_mutual_for_channel(&channel_value).await {
            // The source's catch branch discards the merged statistics.
            return failed_outcome(error, channel_value, FollowLedgerSyncStats::default());
        }

        FollowLedgerSyncOutcome {
            result: FollowLedgerSyncResult {
                error: false,
                message: SYNC_COMPLETE_MESSAGE.into(),
                channel_id: Some(channel_value),
                status: None,
                ..FollowLedgerSyncResult::default()
            }
            .with_stats(stats),
            failure: None,
        }
    }

    async fn sync_incoming_followers(
        &self,
        channel_id: &str,
        streamer_login: &str,
        batch_size: usize,
        hook: Option<FollowLedgerHook>,
    ) -> std::result::Result<HalfOutcome, FollowLedgerError> {
        let mut stats = FollowLedgerSyncStats::default();
        let mut seen: HashSet<String> = HashSet::new();
        let mut cursor: Option<String> = None;

        loop {
            stats.requests += 1;
            let page = match self
                .fetch_followers_page(channel_id, cursor.as_deref(), hook.as_ref())
                .await
            {
                Ok(page) => page,
                Err(error) => return Ok(HalfOutcome::failed(stats, error)),
            };
            stats.pages += 1;
            stats.total_from_api = stats.total_from_api.max(page.total);

            let mut follower_ids: Vec<String> = Vec::with_capacity(page.followers.len());
            for follower in &page.followers {
                if follower.user_id.is_empty() {
                    continue;
                }
                follower_ids.push(follower.user_id.clone());
                seen.insert(follower.user_id.clone());
            }

            let reverse_followed = if follower_ids.is_empty() {
                HashSet::new()
            } else {
                self.active_reverse_followed_ids(channel_id, &follower_ids)
                    .await?
            };

            let mut operations: Vec<UpdateOneModel> = Vec::with_capacity(page.followers.len());
            for follower in &page.followers {
                if follower.user_id.is_empty() {
                    continue;
                }
                let follow_date = resolve_followed_at(
                    Some(&FollowLedgerDate::Text(follower.followed_at.clone())),
                    DateTime::now(),
                );
                let now = DateTime::now();
                operations.push(
                    UpdateOneModel::builder()
                        .namespace(self.ledger.namespace())
                        .filter(doc! {
                            "platform": PLATFORM_TWITCH,
                            "follower_id": &follower.user_id,
                            "followed_id": channel_id,
                            "status": "active",
                        })
                        .update(doc! {
                            "$set": {
                                "follower_login": &follower.user_login,
                                "follower_name": &follower.user_name,
                                "followed_login": streamer_login,
                                "followed_name": streamer_login,
                                "followed_at": follow_date,
                                "mutual": reverse_followed.contains(&follower.user_id),
                                "ended_at": Bson::Null,
                                "ended_reason": Bson::Null,
                                "last_event_at": follow_date,
                                "status": "active",
                                "updated_at": now,
                            },
                            "$setOnInsert": {
                                "platform": PLATFORM_TWITCH,
                                "created_at": now,
                            }
                        })
                        .upsert(true)
                        .build(),
                );
            }
            let upsert_count = operations.len();
            self.run_bulk_write_in_chunks(operations, batch_size).await?;
            stats.active_upserts += upsert_count;

            let reverse_mutual_ids = ordered_unique(reverse_followed.iter().cloned());
            if !reverse_mutual_ids.is_empty() {
                self.ledger
                    .update_many(
                        doc! {
                            "platform": PLATFORM_TWITCH,
                            "status": "active",
                            "follower_id": channel_id,
                            "followed_id": {"$in": string_array(&reverse_mutual_ids)},
                        },
                        doc! {"$set": {"mutual": true, "updated_at": DateTime::now()}},
                    )
                    .await?;
            }

            match page.next_cursor {
                Some(next) if !next.is_empty() => cursor = Some(next),
                _ => break,
            }
        }

        let ended_at = DateTime::now();
        let mut end_operations: Vec<UpdateOneModel> = Vec::new();
        let mut ended_mutual_followers: Vec<String> = Vec::new();
        {
            let mut active_rows = self
                .ledger
                .find(doc! {
                    "platform": PLATFORM_TWITCH,
                    "followed_id": channel_id,
                    "status": "active",
                })
                .projection(doc! {"_id":1,"follower_id":1,"mutual":1})
                .await?;
            while let Some(row) = active_rows.try_next().await? {
                let follower_id = normalize_owned(row.get("follower_id").and_then(Bson::as_str));
                if follower_id.is_empty() || seen.contains(&follower_id) {
                    continue;
                }
                let Some(id) = row.get("_id").cloned() else {
                    continue;
                };
                end_operations.push(
                    UpdateOneModel::builder()
                        .namespace(self.ledger.namespace())
                        .filter(doc! {"_id": id, "status": "active"})
                        .update(doc! {
                            "$set": {
                                "status": "ended",
                                "ended_at": ended_at,
                                "ended_reason": "missing_in_followers_scan",
                                "mutual": false,
                                "last_event_at": ended_at,
                                "updated_at": DateTime::now(),
                            }
                        })
                        .build(),
                );
                if js_truthy(row.get("mutual")) {
                    ended_mutual_followers.push(follower_id);
                }
            }
        }
        let ended_count = end_operations.len();
        self.run_bulk_write_in_chunks(end_operations, batch_size)
            .await?;
        stats.ended_count += ended_count;

        if !ended_mutual_followers.is_empty() {
            self.ledger
                .update_many(
                    doc! {
                        "platform": PLATFORM_TWITCH,
                        "status": "active",
                        "follower_id": channel_id,
                        "followed_id": {"$in": string_array(&ended_mutual_followers)},
                        "mutual": true,
                    },
                    doc! {"$set": {"mutual": false, "updated_at": DateTime::now()}},
                )
                .await?;
        }

        Ok(HalfOutcome::done(stats))
    }

    async fn sync_outgoing_followed(
        &self,
        channel_id: &str,
        streamer_login: &str,
        batch_size: usize,
        hook: Option<FollowLedgerHook>,
    ) -> std::result::Result<HalfOutcome, FollowLedgerError> {
        let mut stats = FollowLedgerSyncStats::default();
        let mut seen: HashSet<String> = HashSet::new();
        let mut cursor: Option<String> = None;

        loop {
            stats.requests += 1;
            let page = match self
                .fetch_followed_page(channel_id, cursor.as_deref(), hook.as_ref())
                .await
            {
                Ok(page) => page,
                Err(error) => return Ok(HalfOutcome::failed(stats, error)),
            };
            stats.pages += 1;
            stats.total_from_api = stats.total_from_api.max(page.total);

            let mut followed_ids: Vec<String> = Vec::with_capacity(page.followed.len());
            for followed in &page.followed {
                if followed.broadcaster_id.is_empty() {
                    continue;
                }
                followed_ids.push(followed.broadcaster_id.clone());
                seen.insert(followed.broadcaster_id.clone());
            }

            let reverse_followers = if followed_ids.is_empty() {
                HashSet::new()
            } else {
                self.active_reverse_follower_ids(channel_id, &followed_ids)
                    .await?
            };

            let mut operations: Vec<UpdateOneModel> = Vec::with_capacity(page.followed.len());
            for followed in &page.followed {
                if followed.broadcaster_id.is_empty() {
                    continue;
                }
                let follow_date = resolve_followed_at(
                    Some(&FollowLedgerDate::Text(followed.followed_at.clone())),
                    DateTime::now(),
                );
                let now = DateTime::now();
                operations.push(
                    UpdateOneModel::builder()
                        .namespace(self.ledger.namespace())
                        .filter(doc! {
                            "platform": PLATFORM_TWITCH,
                            "follower_id": channel_id,
                            "followed_id": &followed.broadcaster_id,
                            "status": "active",
                        })
                        .update(doc! {
                            "$set": {
                                "follower_login": streamer_login,
                                "follower_name": streamer_login,
                                "followed_login": &followed.broadcaster_login,
                                "followed_name": &followed.broadcaster_name,
                                "followed_at": follow_date,
                                "mutual": reverse_followers.contains(&followed.broadcaster_id),
                                "ended_at": Bson::Null,
                                "ended_reason": Bson::Null,
                                "last_event_at": follow_date,
                                "status": "active",
                                "updated_at": now,
                            },
                            "$setOnInsert": {
                                "platform": PLATFORM_TWITCH,
                                "created_at": now,
                            }
                        })
                        .upsert(true)
                        .build(),
                );
            }
            let upsert_count = operations.len();
            self.run_bulk_write_in_chunks(operations, batch_size).await?;
            stats.active_upserts += upsert_count;

            let reverse_mutual_ids = ordered_unique(reverse_followers.iter().cloned());
            if !reverse_mutual_ids.is_empty() {
                self.ledger
                    .update_many(
                        doc! {
                            "platform": PLATFORM_TWITCH,
                            "status": "active",
                            "follower_id": {"$in": string_array(&reverse_mutual_ids)},
                            "followed_id": channel_id,
                        },
                        doc! {"$set": {"mutual": true, "updated_at": DateTime::now()}},
                    )
                    .await?;
            }

            match page.next_cursor {
                Some(next) if !next.is_empty() => cursor = Some(next),
                _ => break,
            }
        }

        let ended_at = DateTime::now();
        let mut end_operations: Vec<UpdateOneModel> = Vec::new();
        let mut ended_mutual_followed: Vec<String> = Vec::new();
        {
            let mut active_rows = self
                .ledger
                .find(doc! {
                    "platform": PLATFORM_TWITCH,
                    "follower_id": channel_id,
                    "status": "active",
                })
                .projection(doc! {"_id":1,"followed_id":1,"mutual":1})
                .await?;
            while let Some(row) = active_rows.try_next().await? {
                let followed_id = normalize_owned(row.get("followed_id").and_then(Bson::as_str));
                if followed_id.is_empty() || seen.contains(&followed_id) {
                    continue;
                }
                let Some(id) = row.get("_id").cloned() else {
                    continue;
                };
                end_operations.push(
                    UpdateOneModel::builder()
                        .namespace(self.ledger.namespace())
                        .filter(doc! {"_id": id, "status": "active"})
                        .update(doc! {
                            "$set": {
                                "status": "ended",
                                "ended_at": ended_at,
                                "ended_reason": "missing_in_following_scan",
                                "mutual": false,
                                "last_event_at": ended_at,
                                "updated_at": DateTime::now(),
                            }
                        })
                        .build(),
                );
                if js_truthy(row.get("mutual")) {
                    ended_mutual_followed.push(followed_id);
                }
            }
        }
        let ended_count = end_operations.len();
        self.run_bulk_write_in_chunks(end_operations, batch_size)
            .await?;
        stats.ended_count += ended_count;

        if !ended_mutual_followed.is_empty() {
            self.ledger
                .update_many(
                    doc! {
                        "platform": PLATFORM_TWITCH,
                        "status": "active",
                        "follower_id": {"$in": string_array(&ended_mutual_followed)},
                        "followed_id": channel_id,
                        "mutual": true,
                    },
                    doc! {"$set": {"mutual": false, "updated_at": DateTime::now()}},
                )
                .await?;
        }

        Ok(HalfOutcome::done(stats))
    }

    /// Source `reconcileMutualForChannel`: four updates in source order.
    async fn reconcile_mutual_for_channel(
        &self,
        channel_id: &str,
    ) -> std::result::Result<(), FollowLedgerError> {
        let mut outgoing_rows = self
            .ledger
            .find(doc! {
                "platform": PLATFORM_TWITCH,
                "status": "active",
                "follower_id": channel_id,
            })
            .projection(doc! {"followed_id":1})
            .await?;
        let mut outgoing: Vec<String> = Vec::new();
        while let Some(row) = outgoing_rows.try_next().await? {
            let followed_id = normalize_owned(row.get("followed_id").and_then(Bson::as_str));
            if !followed_id.is_empty() {
                outgoing.push(followed_id);
            }
        }
        let outgoing = ordered_unique(outgoing);

        let mut incoming_rows = self
            .ledger
            .find(doc! {
                "platform": PLATFORM_TWITCH,
                "status": "active",
                "followed_id": channel_id,
            })
            .projection(doc! {"follower_id":1})
            .await?;
        let mut incoming: Vec<String> = Vec::new();
        while let Some(row) = incoming_rows.try_next().await? {
            let follower_id = normalize_owned(row.get("follower_id").and_then(Bson::as_str));
            if !follower_id.is_empty() {
                incoming.push(follower_id);
            }
        }
        let incoming = ordered_unique(incoming);

        let outgoing_set: HashSet<&str> = outgoing.iter().map(String::as_str).collect();
        let incoming_set: HashSet<&str> = incoming.iter().map(String::as_str).collect();
        let outgoing_mutual: Vec<String> = outgoing
            .iter()
            .filter(|id| incoming_set.contains(id.as_str()))
            .cloned()
            .collect();
        let outgoing_non_mutual: Vec<String> = outgoing
            .iter()
            .filter(|id| !incoming_set.contains(id.as_str()))
            .cloned()
            .collect();
        let incoming_mutual: Vec<String> = incoming
            .iter()
            .filter(|id| outgoing_set.contains(id.as_str()))
            .cloned()
            .collect();
        let incoming_non_mutual: Vec<String> = incoming
            .iter()
            .filter(|id| !outgoing_set.contains(id.as_str()))
            .cloned()
            .collect();

        if !outgoing_mutual.is_empty() {
            self.ledger
                .update_many(
                    doc! {
                        "platform": PLATFORM_TWITCH,
                        "status": "active",
                        "follower_id": channel_id,
                        "followed_id": {"$in": string_array(&outgoing_mutual)},
                    },
                    doc! {"$set": {"mutual": true, "updated_at": DateTime::now()}},
                )
                .await?;
        }
        if !outgoing_non_mutual.is_empty() {
            self.ledger
                .update_many(
                    doc! {
                        "platform": PLATFORM_TWITCH,
                        "status": "active",
                        "follower_id": channel_id,
                        "followed_id": {"$in": string_array(&outgoing_non_mutual)},
                    },
                    doc! {"$set": {"mutual": false, "updated_at": DateTime::now()}},
                )
                .await?;
        }
        if !incoming_mutual.is_empty() {
            self.ledger
                .update_many(
                    doc! {
                        "platform": PLATFORM_TWITCH,
                        "status": "active",
                        "followed_id": channel_id,
                        "follower_id": {"$in": string_array(&incoming_mutual)},
                    },
                    doc! {"$set": {"mutual": true, "updated_at": DateTime::now()}},
                )
                .await?;
        }
        if !incoming_non_mutual.is_empty() {
            self.ledger
                .update_many(
                    doc! {
                        "platform": PLATFORM_TWITCH,
                        "status": "active",
                        "followed_id": channel_id,
                        "follower_id": {"$in": string_array(&incoming_non_mutual)},
                    },
                    doc! {"$set": {"mutual": false, "updated_at": DateTime::now()}},
                )
                .await?;
        }
        Ok(())
    }

    // -----------------------------------------------------------------------
    // Internal helpers
    // -----------------------------------------------------------------------

    async fn run_bulk_write_in_chunks(
        &self,
        operations: Vec<UpdateOneModel>,
        chunk_size: usize,
    ) -> std::result::Result<(), FollowLedgerError> {
        if operations.is_empty() {
            return Ok(());
        }
        let mut remaining = VecDeque::from(operations);
        let size = chunk_size.max(1);
        while !remaining.is_empty() {
            let take = remaining.len().min(size);
            let batch: Vec<UpdateOneModel> = remaining.drain(..take).collect();
            self.ledger.bulk_write(batch).ordered(false).await?;
        }
        Ok(())
    }

    /// Source `reverseActives` query in the incoming scan.
    async fn active_reverse_followed_ids(
        &self,
        channel_id: &str,
        follower_ids: &[String],
    ) -> MongoResult<HashSet<String>> {
        let mut cursor = self
            .ledger
            .find(doc! {
                "platform": PLATFORM_TWITCH,
                "status": "active",
                "follower_id": channel_id,
                "followed_id": {"$in": string_array(follower_ids)},
            })
            .projection(doc! {"followed_id":1})
            .await?;
        let mut ids = HashSet::new();
        while let Some(row) = cursor.try_next().await? {
            let followed_id = normalize_owned(row.get("followed_id").and_then(Bson::as_str));
            if !followed_id.is_empty() {
                ids.insert(followed_id);
            }
        }
        Ok(ids)
    }

    /// Source `reverseActives` query in the outgoing scan.
    async fn active_reverse_follower_ids(
        &self,
        channel_id: &str,
        followed_ids: &[String],
    ) -> MongoResult<HashSet<String>> {
        let mut cursor = self
            .ledger
            .find(doc! {
                "platform": PLATFORM_TWITCH,
                "status": "active",
                "follower_id": {"$in": string_array(followed_ids)},
                "followed_id": channel_id,
            })
            .projection(doc! {"follower_id":1})
            .await?;
        let mut ids = HashSet::new();
        while let Some(row) = cursor.try_next().await? {
            let follower_id = normalize_owned(row.get("follower_id").and_then(Bson::as_str));
            if !follower_id.is_empty() {
                ids.insert(follower_id);
            }
        }
        Ok(ids)
    }

    /// One `channels/followers` page. The hook runs before the request, and the
    /// request uses the native 401 retry policy.
    async fn fetch_followers_page(
        &self,
        channel_id: &str,
        cursor: Option<&str>,
        hook: Option<&FollowLedgerHook>,
    ) -> std::result::Result<FollowersPage, FollowLedgerError> {
        if let Some(hook) = hook {
            hook().await;
        }
        let params = followers_params(channel_id, cursor);
        let auth = TwitchAuth::Streamer(channel_id.to_owned());
        let result = self
            .twitch
            .request(
                &self.tokens,
                &auth,
                HelixRequest {
                    method: Method::GET,
                    endpoint: "channels/followers",
                    params: Some(&params),
                    body: None,
                },
                &self.retry,
            )
            .await?;
        let status = result.response.status().as_u16();
        let body = read_body(result.response).await?;
        let payload = self
            .page_payload(
                "fetch_followers_page",
                "channels/followers",
                &params,
                status,
                &body,
                cursor,
            )
            .await?;
        if !(200..300).contains(&status) || json_truthy(payload.get("error")) {
            return Err(helix_response_error(
                &payload,
                status,
                format!("Failed to fetch followers for {channel_id}"),
            ));
        }
        let followers = payload
            .get("data")
            .and_then(Value::as_array)
            .map(|items| items.iter().map(follower_item).collect())
            .unwrap_or_default();
        Ok(FollowersPage {
            followers,
            total: payload.get("total").and_then(Value::as_f64).unwrap_or(0.0),
            next_cursor: next_cursor(&payload),
        })
    }

    /// One `channels/followed` page, mirroring the followers page contract.
    async fn fetch_followed_page(
        &self,
        channel_id: &str,
        cursor: Option<&str>,
        hook: Option<&FollowLedgerHook>,
    ) -> std::result::Result<FollowedPage, FollowLedgerError> {
        if let Some(hook) = hook {
            hook().await;
        }
        let params = followed_params(channel_id, cursor);
        let auth = TwitchAuth::Streamer(channel_id.to_owned());
        let result = self
            .twitch
            .request(
                &self.tokens,
                &auth,
                HelixRequest {
                    method: Method::GET,
                    endpoint: "channels/followed",
                    params: Some(&params),
                    body: None,
                },
                &self.retry,
            )
            .await?;
        let status = result.response.status().as_u16();
        let body = read_body(result.response).await?;
        let payload = self
            .page_payload(
                "fetch_followed_page",
                "channels/followed",
                &params,
                status,
                &body,
                cursor,
            )
            .await?;
        if !(200..300).contains(&status) || json_truthy(payload.get("error")) {
            return Err(helix_response_error(
                &payload,
                status,
                format!("Failed to fetch channels followed by {channel_id}"),
            ));
        }
        let followed = payload
            .get("data")
            .and_then(Value::as_array)
            .map(|items| items.iter().map(followed_item).collect())
            .unwrap_or_default();
        Ok(FollowedPage {
            followed,
            total: payload.get("total").and_then(Value::as_f64).unwrap_or(0.0),
            next_cursor: next_cursor(&payload),
        })
    }

    /// Shared page post-processing: cache an exhausted 401 exactly where the
    /// source does, then parse the body.
    ///
    /// The source's helper logs, calls `cacheOAuthAPIFailure`, and *returns* the
    /// response; the caller then reports the non-2xx body. The same order applies
    /// here, so a cache failure never changes the page outcome.
    async fn page_payload(
        &self,
        operation: &'static str,
        endpoint: &'static str,
        params: &str,
        status: u16,
        body: &str,
        cursor: Option<&str>,
    ) -> std::result::Result<Value, FollowLedgerError> {
        if status == 401 {
            self.log_message(
                operation,
                "Twitch 401 persisted after retries. Continuing workflow.".to_owned(),
                None,
                Destination::Both,
            )
            .await;
            self.cache_api_failure(operation, endpoint, params, body, cursor)
                .await;
        }
        serde_json::from_str::<Value>(body).map_err(|_| FollowLedgerError::HelixResponse {
            message: "Twitch response body could not be read".into(),
            status: Some(status),
        })
    }

    /// Source `cacheOAuthAPIFailure`: an exhausted 401 writes one sanitized
    /// diagnostic key. Failures are logged and swallowed exactly like the
    /// source's `catch`.
    async fn cache_api_failure(
        &self,
        operation: &'static str,
        endpoint: &'static str,
        params: &str,
        body: &str,
        cursor: Option<&str>,
    ) {
        let Some(mut connection) = self.oauth_cache.clone() else {
            return;
        };
        // Source `requestUrl`; the same string the request used.
        let url = get_twitch_helix_url(endpoint, Some(params));
        // The follow-ledger call site passes no request headers, so the source
        // stores `{}` and falls back to `process.env.CLIENT_ID`.
        let headers = HeaderMap::new();
        let record = OAuthApiFailureRecord {
            url: &url,
            method: "GET",
            headers: &headers,
            status: 401,
            body,
            worker: OAUTH_DIAGNOSTIC_WORKER,
            operation,
            // Source `options.context?.channelID`; this call site's context is
            // `{ cursor }`, so the field is absent.
            channel_id: None,
            context: Some(json!({"cursor": cursor})),
            secrets: &[],
        };
        if let Err(error) = cache_oauth_api_failure(&mut connection, &record).await {
            self.log_message(
                "cacheOAuthAPIFailure",
                error.to_string(),
                None,
                Destination::Console,
            )
            .await;
        }
    }

    /// Source console.error sites. Logging is best-effort and never changes the
    /// returned error.
    async fn log_failure(
        &self,
        function: &'static str,
        error: &FollowLedgerError,
        channel_id: Option<&str>,
    ) {
        self.log_message(function, error.to_string(), channel_id, Destination::Console)
            .await;
    }

    async fn log_message(
        &self,
        function: &'static str,
        message: String,
        channel_id: Option<&str>,
        destination: Destination,
    ) {
        let Some(logger) = &self.logger else {
            return;
        };
        let payload = json!({
            "function": function,
            "message": message,
            "channelID": channel_id,
            "timestamp": javascript_iso_millis(DateTime::now().timestamp_millis()),
        });
        let _ = logger
            .log(
                Level::Error,
                payload,
                LogOptions {
                    destination,
                    platform: Some(PLATFORM_TWITCH.into()),
                    channel_id: channel_id.map(str::to_owned),
                    ..LogOptions::default()
                },
            )
            .await;
    }
}

struct FollowersPage {
    followers: Vec<HelixFollowerItem>,
    total: f64,
    next_cursor: Option<String>,
}

struct FollowedPage {
    followed: Vec<HelixFollowedItem>,
    total: f64,
    next_cursor: Option<String>,
}

fn failed_outcome(
    error: FollowLedgerError,
    channel_id: String,
    stats: FollowLedgerSyncStats,
) -> FollowLedgerSyncOutcome {
    FollowLedgerSyncOutcome {
        result: FollowLedgerSyncResult {
            error: true,
            message: error.to_string(),
            channel_id: Some(channel_id),
            // Source parity: `status` stays unset; a page status is available on
            // `FollowLedgerError::status()` through `failure`.
            status: None,
            ..FollowLedgerSyncResult::default()
        }
        .with_stats(stats),
        failure: Some(error),
    }
}

/// Source `normalizeValue`: `''` for a missing value, otherwise `trim()`.
fn normalize_owned(value: Option<&str>) -> String {
    value.map(trim).unwrap_or("").to_owned()
}

/// Source `toDate(value)` for an optional value.
fn resolve_followed_at(value: Option<&FollowLedgerDate>, now: DateTime) -> DateTime {
    value.map(|value| value.resolve(now)).unwrap_or(now)
}

/// JavaScript truthiness for a BSON value (sparse fields are `undefined`).
fn js_truthy(value: Option<&Bson>) -> bool {
    match value {
        None | Some(Bson::Null) | Some(Bson::Undefined) => false,
        Some(Bson::Boolean(value)) => *value,
        Some(Bson::Int32(value)) => *value != 0,
        Some(Bson::Int64(value)) => *value != 0,
        Some(Bson::Double(value)) => *value != 0.0 && !value.is_nan(),
        Some(Bson::String(value)) => !value.is_empty(),
        Some(_) => true,
    }
}

/// JavaScript truthiness for a JSON value.
fn json_truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(value)) => *value,
        Some(Value::Number(value)) => value.as_f64().is_some_and(|value| value != 0.0),
        Some(Value::String(value)) => !value.is_empty(),
        Some(Value::Array(_)) | Some(Value::Object(_)) => true,
    }
}

/// Source `Array.from(set)`: insertion order with duplicates removed.
fn ordered_unique(values: impl IntoIterator<Item = String>) -> Vec<String> {
    let mut seen = HashSet::new();
    values
        .into_iter()
        .filter(|value| !value.is_empty() && seen.insert(value.clone()))
        .collect()
}

/// Explicit BSON string array for an `$in` predicate.
fn string_array(values: &[String]) -> Bson {
    Bson::Array(
        values
            .iter()
            .map(|value| Bson::String(value.clone()))
            .collect(),
    )
}

fn json_text(value: Option<&Value>) -> String {
    normalize_owned(value.and_then(Value::as_str))
}

fn follower_item(value: &Value) -> HelixFollowerItem {
    HelixFollowerItem {
        user_id: json_text(value.get("user_id")),
        user_login: json_text(value.get("user_login")),
        user_name: json_text(value.get("user_name")),
        followed_at: json_text(value.get("followed_at")),
    }
}

fn followed_item(value: &Value) -> HelixFollowedItem {
    HelixFollowedItem {
        broadcaster_id: json_text(value.get("broadcaster_id")),
        broadcaster_login: json_text(value.get("broadcaster_login")),
        broadcaster_name: json_text(value.get("broadcaster_name")),
        followed_at: json_text(value.get("followed_at")),
    }
}

/// Source `payload.pagination?.cursor || null`: an empty cursor ends the scan.
pub fn next_cursor(payload: &Value) -> Option<String> {
    payload
        .get("pagination")
        .and_then(Value::as_object)
        .and_then(|pagination| pagination.get("cursor"))
        .and_then(Value::as_str)
        .filter(|cursor| !cursor.is_empty())
        .map(str::to_owned)
}

fn helix_response_error(payload: &Value, status: u16, fallback: String) -> FollowLedgerError {
    let message = payload
        .get("message")
        .and_then(Value::as_str)
        .filter(|message| !message.is_empty())
        .map(str::to_owned)
        .unwrap_or(fallback);
    // Source `payload.status || response.status`.
    let status = payload
        .get("status")
        .and_then(Value::as_u64)
        .filter(|status| *status != 0)
        .map(|status| status.min(u64::from(u16::MAX)) as u16)
        .unwrap_or(status);
    FollowLedgerError::HelixResponse {
        message,
        status: Some(status),
    }
}

/// Source `response.text()`. One read serves both the payload parse and the
/// 401 diagnostic body; a body that cannot be read at all fails the page with a
/// sanitized message and produces no cache record.
async fn read_body(response: reqwest::Response) -> std::result::Result<String, FollowLedgerError> {
    let status = response.status().as_u16();
    response
        .text()
        .await
        .map_err(|_| FollowLedgerError::HelixResponse {
            message: "Twitch response body could not be read".into(),
            status: Some(status),
        })
}

/// Query string for `channels/followers`, as `URLSearchParams` would encode it.
pub fn followers_params(channel_id: &str, cursor: Option<&str>) -> String {
    page_params("broadcaster_id", channel_id, cursor)
}

/// Query string for `channels/followed`.
pub fn followed_params(channel_id: &str, cursor: Option<&str>) -> String {
    page_params("user_id", channel_id, cursor)
}

/// `new URLSearchParams({ <idKey>: channelID, first: '100' })` plus `after`.
fn page_params(id_key: &str, channel_id: &str, cursor: Option<&str>) -> String {
    let mut params = format!(
        "{id_key}={}&first={HELIX_PAGE_SIZE}",
        form_encode(channel_id)
    );
    if let Some(cursor) = cursor {
        params.push_str("&after=");
        params.push_str(&form_encode(cursor));
    }
    params
}

/// `URLSearchParams` serialisation (application/x-www-form-urlencoded): alnum
/// and `*-._` are literal, space is `+`, everything else is percent-encoded.
pub fn form_encode(text: &str) -> String {
    let mut encoded = String::with_capacity(text.len());
    for byte in text.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'*' | b'-' | b'.' | b'_' => {
                encoded.push(char::from(*byte));
            }
            b' ' => encoded.push('+'),
            other => encoded.push_str(&format!("%{other:02X}")),
        }
    }
    encoded
}

/// Source `isRetryableFollowStartError`.
fn is_retryable_follow_start_error(error: &FollowLedgerError) -> bool {
    let FollowLedgerError::Mongo(error) = error else {
        return false;
    };
    retryable_mongo_error(error)
}

/// Codes and driver labels the source treats as retryable.
fn retryable_mongo_error(error: &MongoError) -> bool {
    if mongo_error_codes(error)
        .iter()
        .any(|code| RETRYABLE_MONGO_CODES.contains(code))
    {
        return true;
    }
    // Real driver label accessor (pinned mongodb 3.9.1,
    // `error::Error::contains_label`, src/error.rs:267).
    error.contains_label(TRANSIENT_TRANSACTION_ERROR)
        || error.contains_label(UNKNOWN_TRANSACTION_COMMIT_RESULT)
}

/// Source `isTransactionUnsupportedError`, plus the two ways the pinned driver
/// refuses a transaction before the server sees it.
///
/// 1. `start_transaction` rejects a topology that cannot run transactions:
///    `ErrorKind::Transaction {"Transactions are not supported by this
///    deployment"}` (mongodb-3.9.1/src/client/session/action.rs:33-37, reached
///    when `transaction_support_status` is `Unsupported`, see
///    src/sdam/description/topology.rs:759-775).
/// 2. `start_session` rejects deployments without session support
///    (`ErrorKind::SessionsNotSupported`, src/error.rs:720-722).
/// 3. A replica-set-capable topology whose server still refuses the statement
///    reports `IllegalOperation` (code 20) with the source's phrase
///    (src/error.rs:680-683 `ErrorKind::Command`).
fn is_transaction_unsupported(error: &FollowLedgerError) -> bool {
    let FollowLedgerError::Mongo(error) = error else {
        return false;
    };
    match error.kind.as_ref() {
        ErrorKind::SessionsNotSupported => true,
        ErrorKind::Transaction { message, .. } => message.contains("not supported"),
        ErrorKind::Command(command) => {
            command.code == ILLEGAL_OPERATION_CODE
                || command
                    .message
                    .to_ascii_lowercase()
                    .contains(TRANSACTION_UNSUPPORTED_PHRASE)
        }
        // A statement-level rejection arrives as a write or bulk-write failure.
        ErrorKind::Write(WriteFailure::WriteError(write)) => write.code == ILLEGAL_OPERATION_CODE,
        ErrorKind::BulkWrite(failure) => failure
            .write_errors
            .values()
            .any(|write| write.code == ILLEGAL_OPERATION_CODE),
        _ => false,
    }
}

fn mongo_error_codes(error: &MongoError) -> Vec<i32> {
    match error.kind.as_ref() {
        ErrorKind::Command(command) => vec![command.code],
        ErrorKind::Write(WriteFailure::WriteError(write)) => vec![write.code],
        ErrorKind::BulkWrite(failure) => failure
            .write_errors
            .values()
            .map(|write| write.code)
            .collect(),
        _ => Vec::new(),
    }
}
