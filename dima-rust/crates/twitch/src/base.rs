//! The one handle per process: [`Twitch`], built from [`TwitchDeps`] and a [`TwitchConfig`].

use crate::config::TwitchConfig;
use crate::emotes::ChannelEmoteCatalog;
use crate::error::TwitchError;
use crate::events::{Destination, Level, LogEvent, TwitchEvents};
use crate::flight::Flights;
use crate::secret::AccessToken;
use crate::streamers::StreamerAccount;
use crate::tokens::{FlightKey, TokenError};
use dima_core::crypto::CredentialCipher;
use dima_core::{Clock, SecureRandom, Shutdown};
use dima_http::{HttpClient, Provider};
use dima_store::dragonfly::Dragonfly;
use dima_store::mongo::MongoStore;
use serde_json::Value;
use std::collections::HashMap;
use std::fmt;
use std::future::IntoFuture;
use std::sync::{Arc, Mutex, PoisonError};
use tokio_util::task::TaskTracker;

/// Most refreshes, hydrations or catalog loads running at once in one process (one per user);
/// more than the number of streamers, so it only stops a runaway.
pub(crate) const MAX_FLIGHTS: usize = 4096;
/// Most names remembered for [`TwitchEvents::streamer_seen`] (the reference's map is unbounded;
/// past the bound it is cleared, so a streamer may be announced once more).
const MAX_SEEN: usize = 100_000;

/// What the handle uses. The binary builds each piece once at startup.
pub struct TwitchDeps {
    /// The shared outbound client.
    pub http: HttpClient,
    /// The client for refresh-token exchanges, built with [`crate::exchange_client`]: its
    /// requests outlive the process's shutdown token for the drain lifetime (see
    /// `crate::drain`).
    pub exchange_http: HttpClient,
    /// The Helix provider ([`crate::helix::helix_provider`], from the process's registry).
    pub helix: Provider,
    /// The OAuth provider ([`crate::helix::oauth_provider`]).
    pub oauth: Provider,
    /// MongoDB (the `users` collection).
    pub mongo: MongoStore,
    /// Dragonfly (Rust's own logical database).
    pub dragonfly: Dragonfly,
    /// The stored-credential cipher (`SECRET_KEY`).
    pub cipher: CredentialCipher,
    /// Wall clock (token expiry, catalog ages).
    pub clock: Arc<dyn Clock>,
    /// Randomness for IVs and lock owners.
    pub random: Arc<dyn SecureRandom>,
    /// Log and identify sink.
    pub events: Arc<dyn TwitchEvents>,
    /// The process's shutdown token: no new refresh starts once it fired.
    pub shutdown: Shutdown,
}

impl fmt::Debug for TwitchDeps {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("TwitchDeps")
            .field("helix", &self.helix)
            .field("oauth", &self.oauth)
            .field("mongo", &self.mongo)
            .finish_non_exhaustive()
    }
}

/// Everything the backend does on Twitch: tokens, the streamer directory, Helix calls, emotes.
/// One per process, cheap to clone; no global state.
#[derive(Clone)]
pub struct Twitch {
    pub(crate) inner: Arc<Inner>,
}

impl fmt::Debug for Twitch {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Twitch")
            .field("config", &self.inner.config)
            .finish_non_exhaustive()
    }
}

/// A point inside a refresh where a test can park it (feature `test-util`).
#[cfg(any(test, feature = "test-util"))]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FaultPoint {
    /// Twitch answered with new tokens; nothing is written yet.
    AfterTwitchAnswer,
    /// A rotation is about to be written to MongoDB ([`FaultAction::Fail`] makes the write fail).
    BeforePersist,
    /// A recovery record is about to be written to Dragonfly ([`FaultAction::Fail`] makes the
    /// write fail; a hook that waits longer than [`crate::Timings::park_grace`] makes it time
    /// out).
    BeforePark,
    /// A credential write to the directory hash is about to be sent (MongoDB already written).
    BeforeCacheWrite,
    /// A hydration or start-up load read the user and is about to write the hash.
    BeforeDirectoryWrite,
    /// A directory read is about to ask Dragonfly.
    DirectoryRead,
    /// A process waiting for another's refresh is about to look at the cache.
    RefreshWaitPoll,
}

/// What the fault hook makes of a point (feature `test-util`).
#[cfg(any(test, feature = "test-util"))]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum FaultAction {
    /// Go on.
    #[default]
    Continue,
    /// The operation at this point fails as a store failure would.
    Fail,
}

#[cfg(any(test, feature = "test-util"))]
impl From<()> for FaultAction {
    fn from((): ()) -> Self {
        Self::Continue
    }
}

#[cfg(any(test, feature = "test-util"))]
pub(crate) type FaultHook = Arc<
    dyn Fn(FaultPoint, &str) -> futures_util::future::BoxFuture<'static, FaultAction> + Send + Sync,
>;

pub(crate) struct Inner {
    pub(crate) config: TwitchConfig,
    pub(crate) http: HttpClient,
    pub(crate) exchange_http: HttpClient,
    /// Fires when the drain lifetime of exchanges ends ([`Twitch::shutdown`]) or at
    /// [`Twitch::kill`]: an exchange still running is cancelled, a rotation not yet in MongoDB
    /// is parked.
    pub(crate) drain_expired: Shutdown,
    /// Answers Twitch gave that MongoDB has not taken yet (encrypted), per streamer (see
    /// `crate::recovery`).
    pub(crate) answers: crate::recovery::Registry,
    pub(crate) helix: Provider,
    pub(crate) oauth: Provider,
    pub(crate) mongo: MongoStore,
    pub(crate) dragonfly: Dragonfly,
    pub(crate) cipher: CredentialCipher,
    pub(crate) clock: Arc<dyn Clock>,
    pub(crate) random: Arc<dyn SecureRandom>,
    pub(crate) events: Arc<dyn TwitchEvents>,
    pub(crate) shutdown: Shutdown,
    pub(crate) tracker: TaskTracker,
    /// Cancelled only by [`Twitch::kill`] (tests); production never aborts a running refresh.
    pub(crate) kill: tokio_util::sync::CancellationToken,
    pub(crate) token_flights: Flights<FlightKey, Result<AccessToken, TokenError>>,
    pub(crate) app_flight: Flights<(), Option<AccessToken>>,
    pub(crate) hydrate_flights: Flights<String, Result<Option<StreamerAccount>, TwitchError>>,
    pub(crate) emote_flights: Flights<String, ChannelEmoteCatalog>,
    pub(crate) permission_checks: crate::credentials::PermissionChecks,
    pub(crate) gates: crate::lease::Gates,
    /// Tokens a 401-driven refresh produced, or could not replace, with when (see
    /// [`crate::Timings::unhelpful_refresh_window`]).
    pub(crate) unhelpful_refreshes: Mutex<HashMap<[u8; 32], tokio::time::Instant>>,
    seen: Mutex<HashMap<String, String>>,
    #[cfg(any(test, feature = "test-util"))]
    pub(crate) fault: Mutex<Option<FaultHook>>,
}

impl Twitch {
    /// The handle. Does no I/O.
    pub fn new(config: TwitchConfig, deps: TwitchDeps) -> Self {
        Self {
            inner: Arc::new(Inner {
                config,
                http: deps.http,
                exchange_http: deps.exchange_http,
                drain_expired: Shutdown::new(),
                answers: crate::recovery::Registry::default(),
                helix: deps.helix,
                oauth: deps.oauth,
                mongo: deps.mongo,
                dragonfly: deps.dragonfly,
                cipher: deps.cipher,
                clock: deps.clock,
                random: deps.random,
                events: deps.events,
                shutdown: deps.shutdown,
                tracker: TaskTracker::new(),
                kill: tokio_util::sync::CancellationToken::new(),
                token_flights: Flights::new(MAX_FLIGHTS),
                app_flight: Flights::new(1),
                hydrate_flights: Flights::new(MAX_FLIGHTS),
                emote_flights: Flights::new(MAX_FLIGHTS),
                permission_checks: Mutex::new(HashMap::new()),
                gates: crate::lease::Gates::default(),
                unhelpful_refreshes: Mutex::new(HashMap::new()),
                seen: Mutex::new(HashMap::new()),
                #[cfg(any(test, feature = "test-util"))]
                fault: Mutex::new(None),
            }),
        }
    }

    /// The configuration.
    pub fn config(&self) -> &TwitchConfig {
        &self.inner.config
    }

    /// The drain: call it after the process's shutdown token fired (no new refresh is sent
    /// then). Exchanges already sent and the writes of their answers go on for up to
    /// [`crate::Timings::exchange_drain`]; then an exchange still waiting for Twitch is
    /// cancelled, and the **last step** parks every answer MongoDB has not taken in Dragonfly
    /// (review F1/F4: whatever the registry still holds, however far its own write got), within
    /// [`crate::Timings::park_grace`]. The next refresh of that streamer, in any process, or the
    /// reconciliation applies it. An answer both stores refuse then is lost and logged
    /// (`token_refresh_lost`, once per streamer).
    ///
    /// The whole call takes at most [`crate::Timings::shutdown_budget`] (17 s with the
    /// reference timings), so the binary's stop timeout (Compose `stop_grace_period`) must exceed
    /// it. `true` when everything finished within the drain lifetime.
    pub async fn shutdown(&self) -> bool {
        let inner = &self.inner;
        inner.tracker.close();
        let timings = &inner.config.timings;
        let drained = tokio::time::timeout(timings.exchange_drain, inner.tracker.wait())
            .await
            .is_ok();
        if !drained {
            inner.drain_expired.trigger();
        }
        let parked = inner.park_remaining().await;
        drained && parked
    }

    /// Parks every refresh at `point` until the returned future of `hook` resolves (tests:
    /// abort the process between Twitch's answer and the write).
    #[cfg(any(test, feature = "test-util"))]
    pub fn set_fault_hook<A: Into<FaultAction> + 'static>(
        &self,
        hook: impl Fn(FaultPoint, &str) -> futures_util::future::BoxFuture<'static, A>
        + Send
        + Sync
        + 'static,
    ) {
        use futures_util::FutureExt;
        let hook: FaultHook = Arc::new(move |point, id| hook(point, id).map(Into::into).boxed());
        if let Ok(mut fault) = self.inner.fault.lock() {
            *fault = Some(hook);
        }
    }

    /// Stops every task this handle runs at its next `.await` (tests: the process dies).
    #[cfg(any(test, feature = "test-util"))]
    pub fn kill(&self) {
        self.inner.shutdown.trigger();
        self.inner.kill.cancel();
        self.inner.drain_expired.trigger();
        self.inner.tracker.close();
    }
}

impl Inner {
    /// One log entry (`logger.ts` call).
    pub(crate) fn log(
        &self,
        level: Level,
        destination: Destination,
        channel_id: Option<&str>,
        data: Value,
    ) {
        self.events.log(&LogEvent {
            level,
            destination,
            channel_id,
            data: &data,
        });
    }

    /// `identifyStreamer`: announced once per process and name.
    pub(crate) fn streamer_seen(&self, channel_id: &str, name: &str) {
        if channel_id.is_empty() || name.is_empty() {
            return;
        }
        {
            let mut seen = self.seen.lock().unwrap_or_else(PoisonError::into_inner);
            if seen.get(channel_id).is_some_and(|known| known == name) {
                return;
            }
            if seen.len() >= MAX_SEEN {
                seen.clear();
            }
            seen.insert(channel_id.to_owned(), name.to_owned());
        }
        self.events.streamer_seen(channel_id, name);
    }

    /// Runs one MongoDB operation under [`crate::Timings::store_deadline`].
    pub(crate) async fn mongo_op<T, E: fmt::Display>(
        &self,
        op: &'static str,
        work: impl IntoFuture<Output = Result<T, E>>,
    ) -> Result<T, TwitchError> {
        match tokio::time::timeout(self.config.timings.store_deadline, work.into_future()).await {
            Ok(result) => result.map_err(|error| TwitchError::mongo(op, error)),
            Err(_) => Err(TwitchError::MongoTimeout { op }),
        }
    }

    pub(crate) fn now_secs(&self) -> i64 {
        self.clock.now_secs()
    }

    pub(crate) fn now_ms(&self) -> i64 {
        self.clock.now_ms()
    }

    #[cfg(any(test, feature = "test-util"))]
    pub(crate) async fn fault(&self, point: FaultPoint, user_id: &str) -> FaultAction {
        let hook = self.fault.lock().ok().and_then(|fault| fault.clone());
        match hook {
            Some(hook) => hook(point, user_id).await,
            None => FaultAction::Continue,
        }
    }
}
