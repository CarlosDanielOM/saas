//! The EventSub webhook ingress on port 3333 (`POST /eventsub`): the front door of the bot. Every
//! notification Twitch sends for every channel (chat messages, follows, subscriptions,
//! redemptions, stream online and offline...) arrives here. Package **P4-BOT-INGRESS**.
//!
//! TypeScript it ports (baseline `0c71108e`): `bot/eventsub.twitch.ts` (278 lines:
//! `createTwitchEventsubApp`, `twitchEventsub`, `acceptEventsubMessageTimestamp`). The bot
//! binary builds an [`Ingress`] and serves [`Ingress::app`] on [`EVENTSUB_PORT`] with
//! [`Ingress::serve_options`], wrapped in its telemetry (`Telemetry::traced_service` and
//! `web_observer`, the reference's `httpTelemetry`).
//!
//! # One delivery, step by step
//!
//! | Step | Refused with | Twitch then |
//! |---|---|---|
//! | 1. A place among [`IngressConfig::max_in_flight`] (512) requests in flight, waiting at most 1 s | 503 | redelivers |
//! | 2. Headers ([`headers`]): one printable-ASCII value each, within bounds; a signature of the one possible length; a timestamp; `Content-Type: application/json`; no compression | 403 (415 for a compressed body) | nothing: not Twitch |
//! | 3. Body ([`body`]): at most 102,400 bytes (declared or sent), within 10 s; never parsed before step 4 | 413 / 408 / 400, connection closed | nothing |
//! | 4. Signature: HMAC-SHA256 over id, timestamp and the raw body with the secret, compared in constant time | 403 | nothing: not Twitch |
//! | 5. JSON (`JSON.parse` exactly), then the timestamp ([`timestamp`]): within 10 minutes either way, or a retry of a journaled type up to 24 h old | 403 when stale | (Twitch's own retries stop) |
//! | 6. By message type: the challenge is echoed (`200 text/plain`); a revocation goes to the handler before the answer; a notification goes on | 400 for a challenge that is not text | marks the subscription failed |
//! | 7. Raids: the direction's settings (`acceptsRaidNotification`), within the 4 s deadline | 204 when the direction is off; 503 on a store failure | redelivers on 503 |
//! | 8. Journaled types: the journal write (`domain_events`, unique `eventKey`), within 4 s | 503 when it fails or times out | redelivers; a write that did land is found then |
//! | 9. Answer 204 | | done |
//! | 10. After the answer is written, on a tracked task: the message-id claim for types that are not journaled ([`dedupe`]), then the inline handler ([`handover`]) | | |
//!
//! Signed deliveries this backend can never handle (not JSON, no subscription or event, no
//! message id, refused by the journal's contract, a revocation the handler can never complete,
//! an unknown message type) are answered **204 and dead-lettered** ([`dead_letter`]) instead of
//! the reference's 400 or 503 (lead's decision): Twitch would redeliver them until it gave up,
//! and count them towards revoking the subscription.
//!
//! No database call and no per-channel count happens before step 4; refusals before it are
//! counted under fixed names only (`eventsub_ingress` metrics, [`IngressStats`]), never logged one
//! by one.
//!
//! # What a kill leaves
//!
//! - Before step 8 completes: nothing recorded, no answer: Twitch redelivers.
//! - After the journal write, before the answer: the event is in the journal with
//!   `dispatchPending`, so the dispatcher fans it out and each consumer processes it once
//!   (`dima_events::consumer`); Twitch redelivers, the duplicate key answers 204 and the inline
//!   handler is not run again (as in the reference: the inline part of that delivery is lost).
//! - After the answer: the journaled part is safe as above; the inline handler is at most once
//!   (as in the reference). For a type that is not journaled, the claim comes after the answer,
//!   so a kill before the answer never leaves a claim that would drop Twitch's redelivery.
//! - At shutdown the binary stops the listener (the server finishes open requests) and then
//!   waits for the tracked tasks with [`Ingress::drain`].
//!
//! Two deliveries of one message at the same moment, on two connections, are processed once:
//! the journal's unique key lets one insert win (the other answers 204 without the handler), and
//! the claim is `SET NX`.
//!
//! # Differences from the reference, on purpose (each is asserted by
//! `tests/ingress_recorded.rs`)
//!
//! - The two crashes of `packages.md`: a body that is not `application/json` (no content type
//!   at all, too) made `createHmac().update({})` throw, and a non-ASCII signature of the right
//!   length made `timingSafeEqual` throw; under Express 4 both rejections were unhandled and the
//!   bot exited. Both are 403 here, before the body is read. A store failure in the raid filter
//!   (step 7) was a third unhandled rejection; it is 503 here.
//! - Never-valid signed deliveries: 204 and a dead-letter record (above).
//! - A compressed body is refused (415): body-parser inflated gzip and deflate; Twitch never
//!   compresses, and inflating unverified input is work for an outsider.
//! - Header values that are repeated, not ASCII or over-long are refused (403) before the HMAC;
//!   the reference joined, decoded and hashed them, and could only have matched with the secret.
//! - A body over the limit is answered 413 without reading the rest (body-parser drained it).
//! - The message-id claim comes after the answer (see [`dedupe`]); its key lives as long as the
//!   message could pass the timestamp check.
//! - The reference logged every refused request ("Message verification failed"); here refusals
//!   are counted, and only failures of Twitch's own deliveries are logged.

pub mod body;
pub mod config;
pub mod dead_letter;
pub mod dedupe;
mod endpoint;
pub mod handover;
pub mod headers;
pub mod timestamp;

pub use config::{BODY_LIMIT, ENV, EVENTSUB_PATH, EVENTSUB_PORT, IngressConfig};
pub use dead_letter::DeadLetterReason;
pub use handover::{
    ChatBadge, ChatEffectInput, EventsubHandler, HandlerError, HandlerOptions, NoHandler,
    Notification, Revocation, RevocationOutcome,
};

use dima_actions::metrics::BotMetrics;
use dima_core::Clock;
use dima_events::producers::Journal;
use dima_store::dragonfly::Dragonfly;
use dima_stream::raid_subscriptions::RaidSubscriptions;
use dima_telemetry::Telemetry;
use dima_web::{App, ConfigError, Router, ServeOptions};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;
use tokio::sync::Semaphore;
use tokio_util::task::TaskTracker;

/// What the ingress works with.
#[derive(Clone)]
pub struct IngressDeps {
    /// The domain event journal (`dima_events`), with its wakeups.
    pub journal: Journal,
    /// The raid notification filter (`dima_stream`).
    pub raids: RaidSubscriptions,
    /// Dragonfly (Rust's logical database): the message-id claims and the dead-letter record.
    pub dragonfly: Dragonfly,
    /// The bot runtime metrics.
    pub metrics: BotMetrics,
    /// Telemetry (counters, the trace context of the journal's `metadata.observability`, logs).
    pub telemetry: Telemetry,
    /// The wall clock.
    pub clock: Arc<dyn Clock>,
    /// The inline handlers (P4-CHAT-EVENTS).
    pub handler: Arc<dyn EventsubHandler>,
}

/// Counts since start, by outcome (fixed names; for tests and an operator).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct IngressStats {
    /// Refused before verification: no place in flight (503).
    pub overloaded: u64,
    /// Refused for their headers (403/415).
    pub bad_headers: u64,
    /// Refused for their body (413/408/400).
    pub bad_bodies: u64,
    /// Refused because the signature did not match (403).
    pub bad_signatures: u64,
    /// Signed, refused for their timestamp (403).
    pub stale: u64,
    /// Challenges answered.
    pub challenges: u64,
    /// Revocations handled (any answer).
    pub revocations: u64,
    /// Notifications answered 204 (journaled or not, duplicates included).
    pub notifications: u64,
    /// Journaled notifications found already journaled (answered without the handler).
    pub duplicates: u64,
    /// Non-journaled notifications whose claim found the id already seen.
    pub claimed_before: u64,
    /// Answered 503 because a store failed or timed out.
    pub unavailable: u64,
    /// Dead-letter records attempted.
    pub dead_letters: u64,
    /// Dead-letter records that could not be written.
    pub dead_letter_failures: u64,
    /// Inline handler runs that returned an error.
    pub handler_errors: u64,
}

#[derive(Default)]
struct Counters {
    overloaded: AtomicU64,
    bad_headers: AtomicU64,
    bad_bodies: AtomicU64,
    bad_signatures: AtomicU64,
    stale: AtomicU64,
    challenges: AtomicU64,
    revocations: AtomicU64,
    notifications: AtomicU64,
    duplicates: AtomicU64,
    claimed_before: AtomicU64,
    unavailable: AtomicU64,
    dead_letters: AtomicU64,
    dead_letter_failures: AtomicU64,
    handler_errors: AtomicU64,
}

fn bump(counter: &AtomicU64) {
    counter.fetch_add(1, Ordering::Relaxed);
}

struct Inner {
    config: IngressConfig,
    deps: IngressDeps,
    admission: Arc<Semaphore>,
    tasks: TaskTracker,
    counters: Counters,
    dead_letters: dead_letter::DeadLetters,
}

/// The ingress (cheap to clone: one shared state). It is the state of its own router.
#[derive(Clone)]
pub struct Ingress {
    inner: Arc<Inner>,
}

impl std::fmt::Debug for Ingress {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Ingress")
            .field("config", &self.inner.config)
            .field("stats", &self.stats())
            .finish_non_exhaustive()
    }
}

impl Ingress {
    /// An ingress with `config` over `deps`.
    pub fn new(config: IngressConfig, deps: IngressDeps) -> Self {
        let dead_letters = dead_letter::DeadLetters {
            key: format!("{}eventsub:dead-letter", config.key_prefix),
            count_key: format!("{}eventsub:dead-letter:count", config.key_prefix),
            max: config.dead_letter_max.max(1),
            body_bytes: config.dead_letter_body_bytes,
            ttl_seconds: config.dead_letter_ttl_seconds,
            deadline: config.dead_letter_deadline,
        };
        Self {
            inner: Arc::new(Inner {
                admission: Arc::new(Semaphore::new(config.max_in_flight.max(1))),
                tasks: TaskTracker::new(),
                counters: Counters::default(),
                dead_letters,
                config,
                deps,
            }),
        }
    }

    /// The configuration.
    pub fn config(&self) -> &IngressConfig {
        &self.inner.config
    }

    /// The router: `POST /eventsub`; every other request gets Express's 404 page.
    pub fn router(&self) -> Router<Self> {
        let mut router = Router::new();
        router.post(EVENTSUB_PATH, endpoint::eventsub);
        router
    }

    /// The application to serve on [`EVENTSUB_PORT`].
    pub fn app(&self) -> Result<App<Self>, ConfigError> {
        App::new(self.router(), self.clone())
    }

    /// The server settings ([`IngressConfig::serve_options`]).
    pub fn serve_options(&self) -> ServeOptions {
        self.inner.config.serve_options()
    }

    /// Waits for the processing started after answers (the inline handlers) to finish, at most
    /// `deadline`; `true` when everything finished. Call it after the server stopped accepting.
    pub async fn drain(&self, deadline: Duration) -> bool {
        self.inner.tasks.close();
        tokio::time::timeout(deadline, self.inner.tasks.wait())
            .await
            .is_ok()
    }

    /// Processing tasks still running.
    pub fn tasks_in_flight(&self) -> usize {
        self.inner.tasks.len()
    }

    /// Counts since start.
    pub fn stats(&self) -> IngressStats {
        let c = &self.inner.counters;
        let get = |counter: &AtomicU64| counter.load(Ordering::Relaxed);
        IngressStats {
            overloaded: get(&c.overloaded),
            bad_headers: get(&c.bad_headers),
            bad_bodies: get(&c.bad_bodies),
            bad_signatures: get(&c.bad_signatures),
            stale: get(&c.stale),
            challenges: get(&c.challenges),
            revocations: get(&c.revocations),
            notifications: get(&c.notifications),
            duplicates: get(&c.duplicates),
            claimed_before: get(&c.claimed_before),
            unavailable: get(&c.unavailable),
            dead_letters: get(&c.dead_letters),
            dead_letter_failures: get(&c.dead_letter_failures),
            handler_errors: get(&c.handler_errors),
        }
    }
}
