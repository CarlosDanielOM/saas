//! [`AiService`]: the process's handles for the AI (one per process, shared), and the data of
//! the channel an AI call is made for ([`StreamerData`]).

use super::openrouter::OpenRouter;
use dima_billing::Observer;
use dima_billing::plans::credits_cache::{CreditsCache, CustomerStateSource, PlanLookup};
use dima_billing::polar::{Ingest, PolarClient, UsageSink};
use dima_commands::runtime::KeyPrefix;
use dima_core::{Clock, Random};
use dima_model::Private;
use dima_store::dragonfly::Dragonfly;
use dima_store::mongo::MongoStore;
use dima_telemetry::{Destination, LogOptions, Telemetry};
use dima_twitch::Twitch;
use dima_twitch::streamers::StreamerAccount;
use std::sync::Arc;
use std::time::Duration;
use tokio_util::task::TaskTracker;

/// `IStreamerData`: the channel an AI call is made for and pays for, as the callers pass it
/// (`{...streamer, user_id: streamer.id}` of the streamer directory).
#[derive(Clone, Default, PartialEq, Eq)]
pub struct StreamerData {
    /// `user_id`: the Twitch channel id (`None`: the reference's "Channel context unavailable").
    pub user_id: Option<String>,
    /// `name`: the Twitch login.
    pub name: Option<String>,
    /// `plan_tier` as stored (`free`, `premium`, `pro`; anything else reads as free).
    pub plan_tier: Option<String>,
    /// `polar_sh_customer_id`: who Polar bills. Without one no usage is sent to Polar (and no
    /// credit is debited), as in the reference.
    pub polar_sh_customer_id: Option<Private<String>>,
}

/// The customer id is never printed.
impl std::fmt::Debug for StreamerData {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("StreamerData")
            .field("user_id", &self.user_id)
            .field("name", &self.name)
            .field("plan_tier", &self.plan_tier)
            .field(
                "polar_sh_customer_id",
                &self.polar_sh_customer_id.as_ref().map(|_| "<private>"),
            )
            .finish()
    }
}

impl StreamerData {
    /// `{...streamer, user_id: streamer.id}` of a directory entry.
    pub fn of_account(account: &StreamerAccount) -> Self {
        let text = |value: Option<&str>| value.map(str::to_owned);
        Self {
            user_id: Some(account.id().to_owned()).filter(|id| !id.is_empty()),
            name: text(account.field("name")),
            plan_tier: text(account.plan_tier()),
            polar_sh_customer_id: account
                .polar_sh_customer_id()
                .map(|id| Private::new(id.to_owned())),
        }
    }

    /// The channel id, when it is not empty (`streamer.user_id` is truthy).
    pub fn channel_id(&self) -> Option<&str> {
        self.user_id.as_deref().filter(|id| !id.is_empty())
    }

    /// The customer id, when it is not empty.
    pub fn customer_id(&self) -> Option<&str> {
        self.polar_sh_customer_id
            .as_ref()
            .map(|id| id.expose().as_str())
            .filter(|id| !id.is_empty())
    }
}

/// What the AI needs of billing: the local credit cache (the exhaustion check and the local
/// debit), Polar (the usage events), and where accepted usage also goes (receipts, analytics).
#[derive(Clone)]
pub struct BillingDeps {
    /// Polar.
    pub polar: Arc<PolarClient>,
    /// The cached allowance, the local debit and its hold.
    pub credits: CreditsCache,
    /// Receipts and analytics of accepted usage (`usage_receipts::ReceiptSink` in production).
    pub sink: Arc<dyn UsageSink>,
    /// The errors billing recovers from.
    pub observer: Arc<dyn Observer>,
    /// The current plan of a channel's owner (`getAiCredits` with `requireVerified`).
    pub plans: Arc<dyn PlanLookup>,
}

impl std::fmt::Debug for BillingDeps {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("BillingDeps")
    }
}

/// Deadlines of the store calls this module makes (none in the reference).
#[derive(Clone, Copy, Debug)]
pub struct AiConfig {
    /// One Dragonfly or MongoDB call (the personality, the stats hash, the last answer, the
    /// credit check). Only fires on a real hang.
    pub store_deadline: Duration,
    /// The whole charge of one answer (queueing the usage event, the local debit, the receipt).
    pub usage_deadline: Duration,
}

impl Default for AiConfig {
    fn default() -> Self {
        Self {
            store_deadline: Duration::from_secs(10),
            usage_deadline: Duration::from_secs(30),
        }
    }
}

/// Everything [`AiService`] is built from. The binaries fill it at start-up.
pub struct AiDeps {
    /// The chat completions client.
    pub openrouter: OpenRouter,
    /// MongoDB: personalities and their owners.
    pub mongo: MongoStore,
    /// Dragonfly: the personality cache, the usage statistics, the last answer, credits.
    pub dragonfly: Dragonfly,
    /// The prefix of this module's own keys (empty in production; tests isolate with it). The
    /// billing crate's keys (`twitch:{id}:ai:*`) take none.
    pub keys: KeyPrefix,
    /// The streamer directory (the owner's name when a default personality is created).
    pub twitch: Twitch,
    /// Billing.
    pub billing: BillingDeps,
    /// The wall clock.
    pub clock: Arc<dyn Clock>,
    /// Trace ids, session ids and usage entry ids.
    pub random: Arc<dyn Random>,
    /// Logs (`None` in tests that do not read them).
    pub telemetry: Option<Telemetry>,
    /// Deadlines.
    pub config: AiConfig,
}

/// The AI's handles. Cheap to share (`Arc`).
///
/// Work that must finish once a provider has answered (charging it) runs on the service's
/// [`TaskTracker`], detached from the caller, so a caller dropped at the message's deadline
/// cannot leave a charge half done. At shutdown the binary closes and waits for it
/// ([`AiService::shutdown`]).
pub struct AiService {
    pub(crate) deps: AiDeps,
    pub(crate) tasks: TaskTracker,
}

impl std::fmt::Debug for AiService {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("AiService")
    }
}

impl AiService {
    /// The service over `deps`.
    pub fn new(deps: AiDeps) -> Arc<Self> {
        Arc::new(Self {
            deps,
            tasks: TaskTracker::new(),
        })
    }

    /// The handles.
    pub fn deps(&self) -> &AiDeps {
        &self.deps
    }

    /// Stops accepting detached work and waits for what is running (charges and flushes) for
    /// at most `budget`; answers whether everything finished. A charge still running when the
    /// process exits has its event queued already or was never queued (see [`super::usage`]).
    pub async fn shutdown(&self, budget: Duration) -> bool {
        self.tasks.close();
        tokio::time::timeout(budget, self.tasks.wait()).await.is_ok()
    }

    /// Waits until no detached work is running (tests).
    pub async fn settle(&self) {
        while !self.tasks.is_empty() {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    }

    /// The ingest flows of the billing crate over these handles.
    pub(crate) fn ingest(&self) -> Ingest<'_> {
        let billing = &self.deps.billing;
        Ingest {
            polar: &billing.polar,
            dragonfly: &self.deps.dragonfly,
            credits: &billing.credits,
            sink: billing.sink.as_ref(),
            random: self.deps.random.as_ref(),
            clock: self.deps.clock.as_ref(),
            observer: billing.observer.as_ref(),
        }
    }

    /// `prefix + key` for this module's own keys.
    pub(crate) fn key(&self, key: impl std::fmt::Display) -> String {
        self.deps.keys.key(key)
    }

    /// Logs an error (never a prompt, an answer or a provider's body).
    pub(crate) fn log_error(&self, data: &serde_json::Value, channel_id: &str) {
        if let Some(telemetry) = &self.deps.telemetry {
            telemetry.error(data, LogOptions::new().channel(channel_id));
        }
    }

    /// Logs a debug line to the console only (as the reference's `destination: "console"`).
    pub(crate) fn log_debug(&self, data: &serde_json::Value, channel_id: &str) {
        if let Some(telemetry) = &self.deps.telemetry {
            let mut options = LogOptions::new().channel(channel_id);
            options.destination = Destination::Console;
            telemetry.debug(data, options);
        }
    }

    /// `true` once the channel's AI credits are exhausted: `isAiCreditsExhausted` (either
    /// exhaustion flag, or the cached spending balance at or below 0: the cautious figure,
    /// Polar's minus every local debit it may not count yet).
    pub async fn credits_exhausted(&self, channel_id: &str) -> Result<bool, super::AiError> {
        tokio::time::timeout(
            self.deps.config.store_deadline,
            self.deps.billing.credits.is_ai_credits_exhausted(channel_id),
        )
        .await
        .map_err(|_| super::AiError::Store("credit check timed out"))?
        .map_err(|_| super::AiError::Store("credit check failed"))
    }

    /// `getAiCredits(..., {requireVerified: true}).status !== 'available'`: what pets and
    /// standalone text with `verifyCredits` add to the exhaustion check.
    pub async fn credits_unverified(
        &self,
        channel_id: &str,
        streamer: &StreamerData,
    ) -> Result<bool, super::AiError> {
        let owner = dima_billing::plans::credits_cache::PlanOwner {
            plan_tier: Some(
                streamer
                    .plan_tier
                    .clone()
                    .unwrap_or_else(|| "free".to_owned()),
            ),
            polar_sh_customer_id: Some(Private::new(
                streamer.customer_id().unwrap_or_default().to_owned(),
            )),
            polar_plan_event_at: None,
            polar_plan_event_key: None,
        };
        let billing = &self.deps.billing;
        let state: &dyn CustomerStateSource = billing.polar.as_ref();
        let credits = billing
            .credits
            .get_ai_credits(
                &owner,
                channel_id,
                dima_billing::plans::credits_cache::CreditOptions {
                    require_verified: true,
                },
                billing.plans.as_ref(),
                state,
            )
            .await
            .map_err(|_| super::AiError::Store("credit read failed"))?;
        Ok(credits.data.status != dima_billing::plans::credits::CreditStatus::Available)
    }
}
