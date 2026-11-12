//! The Twitch base of the backend: app, bot and streamer tokens with their refresh, the
//! streamer directory, the Helix and OAuth providers with the reference's headers and 401
//! retry, the typed Helix entry point, chat badges and the channel emote catalog.
//!
//! The bot, the API and the cron each build one [`Twitch`] at start-up and share it between
//! their tasks; the three processes coordinate through MongoDB and Dragonfly only.
//!
//! - [`tokens`]: where each token is stored, when it is refreshed, what a refused refresh does,
//!   and how a refresh is kept single in a process and across processes.
//! - [`streamers`]: the directory (`accounts:twitch:{id}:data`), loaded at start-up and
//!   hydrated from MongoDB on a miss.
//! - [`helix`]: the providers ([`helix_provider`], [`oauth_provider`]), the credential of each
//!   [`Auth`], and [`Twitch::helix`] with [`HelixRequest`], which the Helix wrapper packages call.
//! - [`oauth`]: the token endpoint and the classification of refused refreshes.
//! - [`badges`], [`emotes`]: `formatBadges` and `getChannelEmoteCatalog`.
//! - Recovery of answers MongoDB has not taken (`recovery.rs`): [`Twitch::start_recovery`] once
//!   per process, [`Twitch::reconcile_recovery`] on a tick and before a rollback, and the last
//!   step of [`Twitch::shutdown`].
//! - [`eventsub`]: EventSub subscriptions: the table, create, list, delete, the bits migration
//!   and the reconciliation.
//! - [`keys`]: every Dragonfly key and what happens to it at the cutover.
//! - [`config`]: the typed configuration and every pause, lease and timeout ([`Timings`]).
//!
//! Wiring, in a binary:
//!
//! ```no_run
//! # async fn demo(env: &std::collections::HashMap<&str, String>) -> Result<(), Box<dyn std::error::Error>> {
//! use dima_twitch::{Twitch, TwitchConfig, TwitchDeps, helix_provider, oauth_provider};
//! use std::sync::Arc;
//! let get = |name: &str| env.get(name).cloned().unwrap_or_else(|| "undefined".into());
//! let config = TwitchConfig::new(get("CLIENT_ID"), dima_core::SecretString::new(get("CLIENT_SECRET")));
//! let registry = dima_http::ProviderRegistry::builder()
//!     .provider(helix_provider(&config.client_id))
//!     .provider(oauth_provider())
//!     .build()?;
//! # let (mongo, dragonfly, events): (dima_store::mongo::MongoStore, dima_store::dragonfly::Dragonfly, Arc<dyn dima_twitch::TwitchEvents>) = todo!();
//! let shutdown = dima_core::Shutdown::new();
//! let twitch = Twitch::new(config, TwitchDeps {
//!     http: dima_http::HttpClient::builder().shutdown(shutdown.clone()).build()?,
//!     exchange_http: dima_twitch::exchange_client(dima_http::HttpClient::builder())?,
//!     helix: registry.get(dima_twitch::HELIX_PROVIDER)?.clone(),
//!     oauth: registry.get(dima_twitch::OAUTH_PROVIDER)?.clone(),
//!     mongo,
//!     dragonfly,
//!     cipher: dima_core::crypto::CredentialCipher::new(&get("SECRET_KEY"))?,
//!     clock: Arc::new(dima_core::SystemClock),
//!     random: Arc::new(dima_core::SystemRandom),
//!     events,
//!     shutdown: shutdown.clone(),
//! });
//! twitch.start_recovery().await; // once per process: recovery records into MongoDB (3 s at most)
//! twitch.load_streamers().await?; // start-up, as `getTwitchAccountsFromDB`
//! // ... every `Timings::recovery_interval` (5 min): twitch.reconcile_recovery().await
//! // ... on SIGTERM: shutdown.trigger(); twitch.shutdown().await; (at most
//! // `Timings::shutdown_budget()`, 17 s: the container's stop timeout must exceed it)
//! # Ok(())
//! # }
//! ```
//!
//! Rules for everything in this workspace are in `dima-rust/MIGRATION.md`.
#![forbid(unsafe_code)]
#![warn(missing_docs)]

pub mod badges;
mod base;
pub mod config;
mod credentials;
mod drain;
pub mod emotes;
mod error;
pub mod events;
pub mod eventsub;
mod flight;
pub mod functions;
pub mod helix;
pub mod keys;
mod lease;
pub mod oauth;
mod recovery;
mod refresh;
mod secret;
pub mod streamers;
pub mod tokens;

#[cfg(any(test, feature = "test-util"))]
pub use base::{FaultAction, FaultPoint};
pub use base::{Twitch, TwitchDeps};
pub use config::{TWITCH_BOT_ACCOUNT_ID, Timings, TwitchConfig};
pub use drain::exchange_client;
pub use error::TwitchError;
pub use events::{Destination, Level, LogEvent, NoopEvents, TwitchEvents};
pub use helix::{
    Auth, CredentialError, HELIX_PROVIDER, HelixError, HelixRequest, HelixResponse, OAUTH_PROVIDER,
    helix_provider, oauth_provider,
};
pub use keys::{KeySpace, RecoveryKey};
pub use oauth::{RefreshContext, RefreshFailureKind, RefreshFailureReason};
pub use recovery::RecoveryReport;
pub use secret::{AccessToken, RefreshToken};
pub use streamers::StreamerAccount;
pub use tokens::{RefreshOutcome, SignIn, SignInStored, TokenError};
