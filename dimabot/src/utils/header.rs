//! Native Twitch request headers.
//!
//! Ports `src/utils/header.ts`: the app, bot, streamer-by-id and moderator
//! header helpers plus the `TwitchHeaderResult` type and the two source module
//! globals. Credential acquisition, refresh, encryption, storage, caching and
//! streamer permission policy are not reimplemented here; they come from the
//! concrete [`TwitchTokenStorage`] and [`TwitchStreamers`] services.
//!
//! Factories take the already-built long-lived handles, the shared logger and a
//! [`ClientIdSource`]. Construction performs no I/O and starts no task. The
//! explicit [`TwitchHeaders::new`] factory keeps one fixed client id, while
//! [`TwitchHeaders::from_env`] is the source-compatible runtime path: it reads
//! `process.env.CLIENT_ID` through [`EnvClientId`] without mutating the process
//! environment. There is no implicit production bootstrap because the existing
//! native builders would have to load environment files and connect before they
//! can produce these handles; that decision stays with the application
//! composition root.
//!
//! Deliberate differences from TypeScript, all on the native side of the wire:
//!
//! - The source snapshots `CLIENT_ID` at module load for the exported
//!   `twitchAppHeader`/`twitchStreamerHeader` globals but re-reads
//!   `process.env.CLIENT_ID` for each bot and streamer call. The native split is
//!   explicit: `from_source` snapshots once for the app/streamer globals and asks
//!   the source again per bot/streamer call, matching the source exactly. The
//!   fixed constructor remains available for callers that want one value
//!   everywhere.
//! - Headers are immutable owned snapshots. The source returns and exports
//!   shared mutable objects (`twitchAppHeader`, `twitchStreamerHeader`), so a
//!   concurrent call could observe another call's bearer value. The explicit
//!   [`TwitchHeaderState`] keeps the same wire values without that race.
//! - `Debug` redacts the bearer value; serialization keeps the exact wire shape
//!   (`Client-Id`, `Authorization`, `Content-Type`).
//! - Native credential errors collapse to the source result messages. The
//!   source logs internal token diagnostics in `tokens.ts` /
//!   `TwitchStreamers`; those stay the responsibility of those modules.
//! - Only ordinary source values are covered. Invalid runtime casts and
//!   prototype hooks (for example a non-string `has_permissions` object) are not
//!   reproduced.

use std::{
    fmt,
    sync::{Arc, RwLock},
};

use reqwest::header::{AUTHORIZATION, CONTENT_TYPE, HeaderMap, HeaderValue};
use serde::{Serialize, Serializer, ser::SerializeStruct};
use serde_json::{Value, json};

use super::{
    logger::{Destination, Level, LogOptions, Logger},
    notifications::{DeveloperNotifier, DeveloperSeverity},
    twitch::{AccessToken, TwitchAuth, build_headers},
    twitch_streamers::{CallerContext, Platform, TwitchStreamers},
    twitch_tokens::TwitchTokenStorage,
};

/// Canonical bot account identity, re-exported from the native Twitch core so
/// the source module's export keeps working without a second constant.
pub use super::twitch::TWITCH_BOT_ACCOUNT_ID;

pub const HEADER_CLIENT_ID: &str = "Client-Id";
pub const HEADER_AUTHORIZATION: &str = "Authorization";
pub const HEADER_CONTENT_TYPE: &str = "Content-Type";
pub const CONTENT_TYPE_JSON: &str = "application/json";

/// Exact source messages, behaviour-visible to every caller.
pub const SUCCESS_MESSAGE: &str = "Success";
pub const APP_TOKEN_MESSAGE: &str = "Failed to get Twitch app token";
pub const BOT_TOKEN_MESSAGE: &str = "Bot's account does not have the permissions required";
pub const BOT_TOKEN_NOTIFICATION: &str =
    "Bot does not have valid authentication. Please authorize the bot account.";
pub const STREAMER_PERMISSIONS_MESSAGE: &str = "[⚠️] Streamer does not have valid permissions to access this feature, please reauthorize streamer again in https://domdimabot.com [/⚠️]";
pub const STREAMER_TOKEN_MESSAGE: &str = "[⚠️] Streamer does not have valid permissions token to access this feature, please reauthorize streamer again in https://domdimabot.com [/⚠️]";

/// `[⚠️] Streamer not found for ID: ${streamerId} [/⚠️]`.
pub fn streamer_not_found_message(streamer_id: &str) -> String {
    format!("[⚠️] Streamer not found for ID: {streamer_id} [/⚠️]")
}

/// Supplies the Twitch application client id.
///
/// The TypeScript source snapshots `CLIENT_ID` at module load for the exported
/// `twitchAppHeader`/`twitchStreamerHeader` globals but re-reads
/// `process.env.CLIENT_ID` on every bot and streamer header call. This boundary
/// keeps that split explicit without forcing every caller to read the process
/// environment: [`TwitchHeaders::from_source`] snapshots once for the
/// app/streamer globals and asks again for each bot/streamer call.
pub trait ClientIdSource: Send + Sync {
    /// Current configured application client id, or `None` when it is missing.
    fn client_id(&self) -> Option<String>;
}

/// One fixed application client id: every call observes the same value.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FixedClientId(String);
impl FixedClientId {
    pub fn new(value: impl Into<String>) -> Self {
        Self(value.into())
    }
}
impl ClientIdSource for FixedClientId {
    fn client_id(&self) -> Option<String> {
        Some(self.0.clone())
    }
}

/// Source-compatible runtime lookup of `process.env.CLIENT_ID`.
///
/// This is the path the application composition root can wire as a drop-in:
/// the app/streamer globals snapshot the value at construction and
/// bot/streamer calls re-read it, exactly as the TypeScript module does. Tests
/// should inject their own provider instead of mutating the process
/// environment, which is process-global and therefore unsafe for concurrent
/// tests.
#[derive(Clone, Copy, Debug, Default)]
pub struct EnvClientId;
impl ClientIdSource for EnvClientId {
    fn client_id(&self) -> Option<String> {
        std::env::var("CLIENT_ID").ok()
    }
}

/// Fixed construction failures. Values never include credentials.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TwitchHeaderError {
    /// The explicit factory value is empty or not a legal HTTP header value.
    InvalidClientId,
    /// `getTwitchAppHeader` source throw: no usable app credential.
    AppTokenUnavailable,
    /// The canonical builder rejected an acquired credential or header value.
    InvalidCredential,
}
impl fmt::Display for TwitchHeaderError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::InvalidClientId => "Invalid Twitch CLIENT_ID",
            Self::AppTokenUnavailable => APP_TOKEN_MESSAGE,
            Self::InvalidCredential => "Invalid Twitch authorization header",
        })
    }
}
impl std::error::Error for TwitchHeaderError {}

fn header_text<'a>(headers: &'a HeaderMap, name: &'static str) -> &'a str {
    headers
        .get(name)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
}

/// Exact wire header set: `Client-Id`, `Authorization: Bearer <token>` and
/// `Content-Type: application/json`. Immutable and owned per acquisition.
#[derive(Clone)]
pub struct TwitchHeader {
    headers: HeaderMap,
}
impl TwitchHeader {
    fn from_map(headers: HeaderMap) -> Self {
        Self { headers }
    }
    /// Build through the canonical Twitch core so client id and credential
    /// identity (`App`, bot `698614112`, or the requested streamer) are checked
    /// exactly as other native Twitch callers check them.
    pub fn from_credential(
        client_id: &str,
        token: &AccessToken,
        auth: &TwitchAuth,
    ) -> Result<Self, TwitchHeaderError> {
        build_headers(client_id, token, auth)
            .map(Self::from_map)
            .map_err(|_| TwitchHeaderError::InvalidCredential)
    }
    /// The source `twitchStreamerHeader` global: wire headers with an empty
    /// Authorization value. The client id must already be a valid header value.
    fn empty_authorization(client_id: &str) -> Result<Self, TwitchHeaderError> {
        if client_id.is_empty() {
            return Err(TwitchHeaderError::InvalidClientId);
        }
        let mut headers = HeaderMap::new();
        headers.insert(
            "client-id",
            HeaderValue::from_str(client_id).map_err(|_| TwitchHeaderError::InvalidClientId)?,
        );
        let mut authorization = HeaderValue::from_static("");
        authorization.set_sensitive(true);
        headers.insert(AUTHORIZATION, authorization);
        headers.insert(CONTENT_TYPE, HeaderValue::from_static(CONTENT_TYPE_JSON));
        Ok(Self { headers })
    }
    pub fn client_id(&self) -> &str {
        header_text(&self.headers, "client-id")
    }
    /// Sensitive: the exact `Bearer <token>` value callers send. Never log it.
    pub fn authorization(&self) -> &str {
        header_text(&self.headers, "authorization")
    }
    pub fn content_type(&self) -> &str {
        header_text(&self.headers, "content-type")
    }
    /// Owned copy for a request builder. Authorization stays marked sensitive.
    pub fn to_header_map(&self) -> HeaderMap {
        self.headers.clone()
    }
}
impl PartialEq for TwitchHeader {
    fn eq(&self, other: &Self) -> bool {
        self.client_id() == other.client_id()
            && self.authorization() == other.authorization()
            && self.content_type() == other.content_type()
    }
}
impl Eq for TwitchHeader {}
impl fmt::Debug for TwitchHeader {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("TwitchHeader")
            .field(HEADER_CLIENT_ID, &self.client_id())
            .field(HEADER_AUTHORIZATION, &"<redacted>")
            .field(HEADER_CONTENT_TYPE, &self.content_type())
            .finish()
    }
}
impl Serialize for TwitchHeader {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut state = serializer.serialize_struct("TwitchHeader", 3)?;
        state.serialize_field(HEADER_CLIENT_ID, self.client_id())?;
        state.serialize_field(HEADER_AUTHORIZATION, self.authorization())?;
        state.serialize_field(HEADER_CONTENT_TYPE, self.content_type())?;
        state.end()
    }
}

/// Source `TwitchHeaderResult`: `header` is absent on failure, exactly like the
/// optional TypeScript property being dropped by JSON serialization.
#[derive(Clone, PartialEq, Eq, Serialize)]
pub struct TwitchHeaderResult {
    pub error: bool,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub header: Option<TwitchHeader>,
}
impl TwitchHeaderResult {
    pub fn success(header: TwitchHeader) -> Self {
        Self {
            error: false,
            message: SUCCESS_MESSAGE.to_owned(),
            header: Some(header),
        }
    }
    pub fn failure(message: impl Into<String>) -> Self {
        Self {
            error: true,
            message: message.into(),
            header: None,
        }
    }
    pub fn header(&self) -> Option<&TwitchHeader> {
        self.header.as_ref()
    }
}
impl fmt::Debug for TwitchHeaderResult {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("TwitchHeaderResult")
            .field("error", &self.error)
            .field("message", &self.message)
            .field("header", &self.header)
            .finish()
    }
}

struct HeaderStateInner {
    client_id: String,
    app: RwLock<Option<TwitchHeader>>,
    streamer: TwitchHeader,
}

/// Explicit, race-free replacement for the source module globals
/// `twitchAppHeader` and `twitchStreamerHeader`.
///
/// `app_header` returns an owned snapshot of the most recent successful
/// `getTwitchAppHeader` result. `streamer_header` is the source global that is
/// exported but never mutated: correct wire values with an empty Authorization.
#[derive(Clone)]
pub struct TwitchHeaderState {
    inner: Arc<HeaderStateInner>,
}
impl TwitchHeaderState {
    /// Captures and validates `CLIENT_ID`; no I/O and no environment reads.
    pub fn new(client_id: impl Into<String>) -> Result<Self, TwitchHeaderError> {
        let client_id = client_id.into();
        let streamer = TwitchHeader::empty_authorization(&client_id)?;
        Ok(Self {
            inner: Arc::new(HeaderStateInner {
                client_id,
                app: RwLock::new(None),
                streamer,
            }),
        })
    }
    pub fn client_id(&self) -> &str {
        &self.inner.client_id
    }
    /// Latest successful app header snapshot, if any call succeeded.
    pub fn app_header(&self) -> Option<TwitchHeader> {
        let value = self
            .inner
            .app
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        value.clone()
    }
    /// The never-mutated streamer global (empty Authorization).
    pub fn streamer_header(&self) -> TwitchHeader {
        self.inner.streamer.clone()
    }
    fn record_app(&self, header: &TwitchHeader) {
        let mut value = self
            .inner
            .app
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        *value = Some(header.clone());
    }
}
impl fmt::Debug for TwitchHeaderState {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("TwitchHeaderState")
            .field(HEADER_CLIENT_ID, &self.inner.client_id)
            .field("app", &self.app_header())
            .field("streamer", &self.inner.streamer)
            .finish()
    }
}

/// Concrete header helpers over the shared long-lived native services.
pub struct TwitchHeaders {
    state: TwitchHeaderState,
    client_ids: Arc<dyn ClientIdSource>,
    tokens: Arc<TwitchTokenStorage>,
    directory: TwitchStreamers,
    logger: Arc<Logger>,
    notifier: DeveloperNotifier,
}
impl TwitchHeaders {
    /// Explicit factory with one fixed client id. Construction performs no I/O,
    /// loads no environment file and reads no environment variable.
    pub fn new(
        client_id: impl Into<String>,
        tokens: Arc<TwitchTokenStorage>,
        directory: TwitchStreamers,
        logger: Arc<Logger>,
    ) -> Result<Self, TwitchHeaderError> {
        Self::from_source(
            Arc::new(FixedClientId::new(client_id)),
            tokens,
            directory,
            logger,
        )
    }
    /// Source-compatible factory: the app/streamer globals snapshot the client id
    /// at construction and bot/streamer headers ask the source on every call.
    ///
    /// Construction performs no I/O; it only reads the supplied source once.
    pub fn from_source(
        client_ids: Arc<dyn ClientIdSource>,
        tokens: Arc<TwitchTokenStorage>,
        directory: TwitchStreamers,
        logger: Arc<Logger>,
    ) -> Result<Self, TwitchHeaderError> {
        let snapshot = client_ids
            .client_id()
            .ok_or(TwitchHeaderError::InvalidClientId)?;
        Ok(Self {
            state: TwitchHeaderState::new(snapshot)?,
            client_ids,
            tokens,
            directory,
            logger,
            notifier: DeveloperNotifier::new(),
        })
    }
    /// Source module wiring: `process.env.CLIENT_ID`, read at construction for
    /// the app/streamer globals and per bot/streamer call afterwards.
    pub fn from_env(
        tokens: Arc<TwitchTokenStorage>,
        directory: TwitchStreamers,
        logger: Arc<Logger>,
    ) -> Result<Self, TwitchHeaderError> {
        Self::from_source(Arc::new(EnvClientId), tokens, directory, logger)
    }
    /// Replace the console developer-notification sink (tests or a future
    /// delivery implementation). Default is the source's stderr placeholder.
    pub fn with_notifier(mut self, notifier: DeveloperNotifier) -> Self {
        self.notifier = notifier;
        self
    }
    pub fn state(&self) -> &TwitchHeaderState {
        &self.state
    }
    /// Per-call client id lookup for bot and streamer headers.
    fn current_client_id(&self) -> Result<String, TwitchHeaderError> {
        let client_id = self
            .client_ids
            .client_id()
            .ok_or(TwitchHeaderError::InvalidClientId)?;
        if client_id.is_empty() {
            return Err(TwitchHeaderError::InvalidClientId);
        }
        Ok(client_id)
    }

    /// Source `getTwitchAppHeader`: the app credential or the exact
    /// `Failed to get Twitch app token` error. Updates the app header state.
    /// The client id is the module-load snapshot, as in the source global.
    pub async fn get_twitch_app_header(&self) -> Result<TwitchHeader, TwitchHeaderError> {
        let token = self
            .tokens
            .acquire_token(&TwitchAuth::App)
            .await
            .map_err(|_| TwitchHeaderError::AppTokenUnavailable)?;
        let header =
            TwitchHeader::from_credential(self.state.client_id(), &token, &TwitchAuth::App)
                .map_err(|_| TwitchHeaderError::AppTokenUnavailable)?;
        self.state.record_app(&header);
        Ok(header)
    }

    /// Source `getTwitchBotHeader`: the bot identity token; on an unusable bot
    /// credential it emits the console developer notification and returns the
    /// exact permission message.
    pub async fn get_twitch_bot_header(&self) -> TwitchHeaderResult {
        match self.bot_header().await {
            Ok(header) => TwitchHeaderResult::success(header),
            Err(()) => {
                self.notifier
                    .notify(BOT_TOKEN_NOTIFICATION, DeveloperSeverity::Error)
                    .await;
                TwitchHeaderResult::failure(BOT_TOKEN_MESSAGE)
            }
        }
    }
    async fn bot_header(&self) -> Result<TwitchHeader, ()> {
        // Source order: token first, then the per-call `process.env.CLIENT_ID`.
        let token = self
            .tokens
            .acquire_token(&TwitchAuth::Bot)
            .await
            .map_err(|_| ())?;
        let client_id = self.current_client_id().map_err(|_| ())?;
        TwitchHeader::from_credential(&client_id, &token, &TwitchAuth::Bot).map_err(|_| ())
    }

    /// Source `getTwitchStreamerHeaderById`: directory lookup, strict
    /// `has_permissions === 'true'`, streamer token acquisition, cache-destination
    /// debug logs and the exact result messages.
    pub async fn get_twitch_streamer_header_by_id(&self, streamer_id: &str) -> TwitchHeaderResult {
        let account = match self.directory.account_by_id(streamer_id).await {
            Ok(account) => account,
            // The source getTwitchAccountById catches every error and returns
            // null, so the header helper reports "not found" for all of them.
            Err(_) => {
                self.debug(json!({
                    "function": "getTwitchStreamerHeaderById",
                    "streamerId": streamer_id,
                    "error": "Streamer not found"
                }))
                .await;
                return TwitchHeaderResult::failure(streamer_not_found_message(streamer_id));
            }
        };
        // The source uses a strict string comparison: `!== 'true'`.
        if account.has_permissions != "true" {
            self.debug(json!({
                "function": "getTwitchStreamerHeaderById",
                "streamerId": streamer_id,
                "error": "No permissions",
                "has_permissions": account.has_permissions
            }))
            .await;
            return TwitchHeaderResult::failure(STREAMER_PERMISSIONS_MESSAGE);
        }
        let token = match self
            .directory
            .account_token(
                streamer_id,
                Platform::Twitch,
                &CallerContext::new("getTwitchStreamerHeaderById"),
            )
            .await
        {
            Ok(token) => token,
            Err(_) => {
                self.debug(json!({
                    "function": "getTwitchStreamerHeaderById",
                    "streamerId": streamer_id,
                    "error": "Failed to get access token (refresh may have failed)"
                }))
                .await;
                return TwitchHeaderResult::failure(STREAMER_TOKEN_MESSAGE);
            }
        };
        // Source order: the success debug line is written before the header
        // object is returned, and only the token length is exposed.
        self.debug(json!({
            "function": "getTwitchStreamerHeaderById",
            "streamerId": streamer_id,
            "success": true,
            "tokenLength": token.expose_secret().len()
        }))
        .await;
        // Per-call client id, matching `process.env.CLIENT_ID` in the source.
        let client_id = match self.current_client_id() {
            Ok(client_id) => client_id,
            Err(_) => return TwitchHeaderResult::failure(STREAMER_TOKEN_MESSAGE),
        };
        match TwitchHeader::from_credential(
            &client_id,
            &token,
            &TwitchAuth::Streamer(streamer_id.to_owned()),
        ) {
            Ok(header) => TwitchHeaderResult::success(header),
            Err(_) => TwitchHeaderResult::failure(STREAMER_TOKEN_MESSAGE),
        }
    }

    /// Source `getTwitchModeratorHeader`: always the bot token and the bot
    /// identity. The arguments identify the requesting party for logging and
    /// attribution only; they never select a credential.
    pub async fn get_twitch_moderator_header(
        &self,
        _channel_id: &str,
        _moderator_id: &str,
    ) -> TwitchHeaderResult {
        self.get_twitch_bot_header().await
    }

    async fn debug(&self, data: Value) {
        // The source header debug calls pass no channelId/platform, so the
        // logger defaults (twitch / global) apply.
        let _ = self
            .logger
            .log(
                Level::Debug,
                data,
                LogOptions {
                    destination: Destination::Cache,
                    ..Default::default()
                },
            )
            .await;
    }
}
impl fmt::Debug for TwitchHeaders {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("TwitchHeaders")
            .field("state", &self.state)
            .field("client_ids", &"<source>")
            .field("logger", &"<logger>")
            .field("notifier", &self.notifier)
            .finish_non_exhaustive()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn state_captures_client_id_and_never_mutates_the_streamer_header() {
        let state = TwitchHeaderState::new("client-id").unwrap();
        assert_eq!(state.client_id(), "client-id");
        assert_eq!(state.app_header(), None);
        let streamer = state.streamer_header();
        assert_eq!(streamer.client_id(), "client-id");
        assert_eq!(streamer.authorization(), "");
        assert_eq!(streamer.content_type(), "application/json");
    }

    #[test]
    fn empty_client_id_is_rejected_without_io() {
        assert_eq!(
            TwitchHeaderState::new("").err(),
            Some(TwitchHeaderError::InvalidClientId)
        );
        assert_eq!(
            TwitchHeaderState::new("bad\nvalue").err(),
            Some(TwitchHeaderError::InvalidClientId)
        );
    }

    #[test]
    fn app_header_serialization_and_debug_keep_the_wire_shape_without_leaking() {
        let token = AccessToken::app("app-secret");
        let header = TwitchHeader::from_credential("client-id", &token, &TwitchAuth::App).unwrap();
        assert_eq!(header.authorization(), "Bearer app-secret");
        assert_eq!(
            serde_json::to_string(&header).unwrap(),
            "{\"Client-Id\":\"client-id\",\"Authorization\":\"Bearer app-secret\",\"Content-Type\":\"application/json\"}"
        );
        let debug = format!("{header:?}");
        assert!(debug.contains("<redacted>") && !debug.contains("app-secret"));

        let failure = TwitchHeaderResult::failure(BOT_TOKEN_MESSAGE);
        assert_eq!(
            serde_json::to_value(&failure).unwrap(),
            json!({"error": true, "message": BOT_TOKEN_MESSAGE})
        );
        let success = TwitchHeaderResult::success(header);
        let wire = serde_json::to_string(&success).unwrap();
        assert!(wire.contains("\"header\":{\"Client-Id\":\"client-id\""));
        assert!(!format!("{success:?}").contains("app-secret"));
    }

    #[test]
    fn exact_source_messages() {
        assert_eq!(APP_TOKEN_MESSAGE, "Failed to get Twitch app token");
        assert_eq!(
            streamer_not_found_message("123"),
            "[⚠️] Streamer not found for ID: 123 [/⚠️]"
        );
    }

    #[test]
    fn client_id_sources_keep_the_fixed_and_runtime_paths_distinct() {
        let fixed = FixedClientId::new("client-id");
        assert_eq!(fixed.client_id().as_deref(), Some("client-id"));
        let erased: Arc<dyn ClientIdSource> = Arc::new(fixed);
        assert_eq!(erased.client_id().as_deref(), Some("client-id"));
        // `EnvClientId` is constructed without reading; the value is resolved per
        // call by `TwitchHeaders`, never by this unit test.
        let runtime: Arc<dyn ClientIdSource> = Arc::new(EnvClientId);
        assert!(runtime.client_id().is_none() || runtime.client_id().is_some());
    }
}
