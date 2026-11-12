//! Typed configuration: the app credentials, the bot account, the key space and every pause,
//! lease and timeout of the token pipeline.
//!
//! Only a binary reads the environment (`CLIENT_ID`, `CLIENT_SECRET`, `SECRET_KEY`); this crate
//! takes the values. Every timing has the reference's value where the reference has one; the
//! timeouts it lacks are listed in [`Timings`] with the reason for the chosen value.

use crate::keys::KeySpace;
use dima_core::SecretString;
use std::fmt;
use std::time::Duration;

/// Twitch's id of the bot account (`BOT_USER_ID` in `tokens.ts`, `TWITCH_BOT_ACCOUNT_ID` in
/// `header.ts`). Every moderator-acting Helix call runs as this account.
pub const TWITCH_BOT_ACCOUNT_ID: &str = "698614112";

/// What the crate needs to talk to Twitch for the backend.
#[derive(Clone)]
pub struct TwitchConfig {
    /// `CLIENT_ID`: the `Client-Id` header and the `client_id` of OAuth calls. The reference
    /// sends the text `undefined` when the variable is unset; the binary passes what it read.
    pub client_id: String,
    /// `CLIENT_SECRET`: the `client_secret` of OAuth calls.
    pub client_secret: SecretString,
    /// The bot account's Twitch id ([`TWITCH_BOT_ACCOUNT_ID`]).
    pub bot_user_id: String,
    /// Where the Dragonfly keys live ([`KeySpace::production`] outside tests).
    pub keys: KeySpace,
    /// Pauses, leases and timeouts.
    pub timings: Timings,
}

impl TwitchConfig {
    /// The production configuration for the given app credentials.
    pub fn new(client_id: impl Into<String>, client_secret: SecretString) -> Self {
        Self {
            client_id: client_id.into(),
            client_secret,
            bot_user_id: TWITCH_BOT_ACCOUNT_ID.to_owned(),
            keys: KeySpace::production(),
            timings: Timings::reference(),
        }
    }
}

impl fmt::Debug for TwitchConfig {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("TwitchConfig")
            .field("client_id", &self.client_id)
            .field("client_secret", &"<redacted>")
            .field("bot_user_id", &self.bot_user_id)
            .field("keys", &self.keys)
            .field("timings", &self.timings)
            .finish()
    }
}

/// Every pause, lease and timeout of this crate.
///
/// | Field | Value | Source |
/// |---|---|---|
/// | `refresh_lock_ttl` | 5 s | `REFRESH_LOCK_TTL_MS` (`twitch_streamers.class.ts`); renewed every third of it while the holder works (Rust only) |
/// | `exchange_marker_ttl` | 30 s | Rust only: how long a refresh whose outcome is unknown (lost answer, dead holder) blocks the next exchange of that streamer; renewed while the holder lives |
/// | `refresh_wait` | 4.5 s | `REFRESH_WAIT_TIMEOUT_MS`; a hard bound here (the reference's wait can overrun by its cache commands) |
/// | `refresh_wait_poll` | 150 ms | `REFRESH_WAIT_POLL_MS` |
/// | `token_expiry_skew_secs` | 300 | `TOKEN_EXPIRY_SKEW_SECONDS` |
/// | `waiter_expiry_skew_secs` | 60 | the literal `60` of `waitForRefreshedToken` and `refreshTwitchToken` |
/// | `refresh_attempts` | 3 | `REFRESH_MAX_ATTEMPTS` (`tokens.ts`) |
/// | `refresh_backoff` | 400 ms, 900 ms | `REFRESH_RETRY_BACKOFF_MS` (900 ms past the list) |
/// | `oauth_timeout` | 10 s | none in the reference (`fetch` without a signal); generous, fires only on a hang |
/// | `helix_refresh_deadline` | 15 s | none in the reference; covers the 4.5 s lock wait plus a slow refresh, well under the HTTP crate's 60 s |
/// | `store_deadline` | 10 s | none in the reference (Mongoose without `maxTimeMS`); one MongoDB operation |
/// | `emote_timeout` | 3 s | `AbortSignal.timeout(3000)` (`twitch_emotes.ts`) |
/// | `exchange_drain` | 15 s | Rust only: how long an exchange already sent, and the write of its answer, go on after shutdown (one 10 s attempt plus 5 s to write); see `crate::drain` |
/// | `park_grace` | 2 s | Rust only: after the drain, how long a rotation MongoDB has not taken may take to be parked in Dragonfly |
/// | `persist_retry` | 200 ms doubling to 2 s | Rust only: the pause between writes of a rotation MongoDB refused (never a new exchange) |
/// | `park_ttl` | 30 days | Rust only: how long a parked rotation waits for the next refresh of its streamer |
/// | `directory_read` | 500 ms | Rust only: the default deadline of a directory read ([`crate::Twitch::streamer`]); the chat path uses it. A read is one Dragonfly script round trip (well under a millisecond on the host), a miss adds one MongoDB read and one write (a few milliseconds), so it fires only when a store is unhealthy; a hydration it started goes on in the background |
/// | `unhelpful_refresh_window` | 60 s | Rust only: after a 401-driven refresh of the app or bot token, how long a 401 for the token it produced (or for the one it could not replace) does not refresh again |
/// | `permission_recheck` | 30 s | Rust only: how long a "no permissions" confirmed by MongoDB is not checked again (per streamer and cached generation) |
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Timings {
    /// Lease of the cross-process refresh lock (`SET NX PX`), renewed while it is held.
    pub refresh_lock_ttl: Duration,
    /// Lifetime of the exchange marker (see [`crate::tokens`]), renewed while its holder lives.
    pub exchange_marker_ttl: Duration,
    /// How long a caller that lost the lock waits for the winner's token.
    pub refresh_wait: Duration,
    /// How often it looks.
    pub refresh_wait_poll: Duration,
    /// A cached token is used only while it has more than this many seconds left.
    pub token_expiry_skew_secs: i64,
    /// The smaller margin a waiter and the rotation check accept.
    pub waiter_expiry_skew_secs: i64,
    /// Attempts of one OAuth refresh.
    pub refresh_attempts: u32,
    /// The pause before each retry of a refresh (the last value repeats).
    pub refresh_backoff: Vec<Duration>,
    /// Deadline of one OAuth attempt (headers and body).
    pub oauth_timeout: Duration,
    /// How long a Helix call waits for a new token after a 401.
    pub helix_refresh_deadline: Duration,
    /// Deadline of one MongoDB operation.
    pub store_deadline: Duration,
    /// Deadline of the channel emote request.
    pub emote_timeout: Duration,
    /// How long exchanges already sent, and the writes of their answers, go on after shutdown.
    pub exchange_drain: Duration,
    /// How long, after the drain, a rotation not yet in MongoDB may take to be parked.
    pub park_grace: Duration,
    /// The first pause between writes of a rotation MongoDB refused (it doubles).
    pub persist_retry: Duration,
    /// The longest such pause.
    pub persist_retry_max: Duration,
    /// How long a parked rotation is kept.
    pub park_ttl: Duration,
    /// How long a cached "no permissions" that MongoDB confirmed is trusted without asking
    /// MongoDB again.
    pub permission_recheck: Duration,
    /// The default deadline of a directory read.
    pub directory_read: Duration,
    /// How long a 401 for a token a refresh just produced (or could not replace) does not
    /// refresh the app or bot token again.
    pub unhelpful_refresh_window: Duration,
}

impl Timings {
    /// The reference's values (see the table on [`Timings`]).
    pub fn reference() -> Self {
        Self {
            refresh_lock_ttl: Duration::from_millis(5000),
            exchange_marker_ttl: Duration::from_secs(30),
            refresh_wait: Duration::from_millis(4500),
            refresh_wait_poll: Duration::from_millis(150),
            token_expiry_skew_secs: 300,
            waiter_expiry_skew_secs: 60,
            refresh_attempts: 3,
            refresh_backoff: vec![Duration::from_millis(400), Duration::from_millis(900)],
            oauth_timeout: Duration::from_secs(10),
            helix_refresh_deadline: Duration::from_secs(15),
            store_deadline: Duration::from_secs(10),
            emote_timeout: Duration::from_secs(3),
            exchange_drain: Duration::from_secs(15),
            park_grace: Duration::from_secs(2),
            persist_retry: Duration::from_millis(200),
            persist_retry_max: Duration::from_secs(2),
            park_ttl: Duration::from_secs(30 * 24 * 3600),
            permission_recheck: Duration::from_secs(30),
            directory_read: Duration::from_millis(500),
            unhelpful_refresh_window: Duration::from_secs(60),
        }
    }

    /// The pause before retry `index` (0-based): the list's value, 900 ms past its end
    /// (`REFRESH_RETRY_BACKOFF_MS[attempt] ?? 900`).
    pub(crate) fn backoff(&self, index: usize) -> Duration {
        self.refresh_backoff
            .get(index)
            .copied()
            .unwrap_or(Duration::from_millis(900))
    }
}

impl Default for Timings {
    fn default() -> Self {
        Self::reference()
    }
}
