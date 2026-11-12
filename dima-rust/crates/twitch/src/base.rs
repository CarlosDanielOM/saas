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
}

#[cfg(any(test, feature = "test-util"))]
pub(crate) type FaultHook =
    Arc<dyn Fn(FaultPoint, &str) -> futures_util::future::BoxFuture<'static, ()> + Send + Sync>;

pub(crate) struct Inner {
    pub(crate) config: TwitchConfig,
    pub(crate) http: HttpClient,
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

    /// Waits until the refreshes and loads still running have finished, at most
    /// [`crate::Timings::shutdown_grace`]; `true` when they all did. Call it after the shutdown
    /// token fired: no new one starts then. A refresh is not aborted on shutdown, because one
    /// whose answer Twitch has sent must still be written (its own deadlines bound it).
    pub async fn shutdown(&self) -> bool {
        self.inner.tracker.close();
        tokio::time::timeout(
            self.inner.config.timings.shutdown_grace,
            self.inner.tracker.wait(),
        )
        .await
        .is_ok()
    }

    /// Parks every refresh at `point` until the returned future of `hook` resolves (tests:
    /// abort the process between Twitch's answer and the write).
    #[cfg(any(test, feature = "test-util"))]
    pub fn set_fault_hook(
        &self,
        hook: impl Fn(FaultPoint, &str) -> futures_util::future::BoxFuture<'static, ()>
        + Send
        + Sync
        + 'static,
    ) {
        if let Ok(mut fault) = self.inner.fault.lock() {
            *fault = Some(Arc::new(hook));
        }
    }

    /// Stops every task this handle runs at its next `.await` (tests: the process dies).
    #[cfg(any(test, feature = "test-util"))]
    pub fn kill(&self) {
        self.inner.shutdown.trigger();
        self.inner.kill.cancel();
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
    pub(crate) async fn fault(&self, point: FaultPoint, user_id: &str) {
        let hook = self.fault.lock().ok().and_then(|fault| fault.clone());
        if let Some(hook) = hook {
            hook(point, user_id).await;
        }
    }
}
