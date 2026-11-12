//! The AI credit allowance in Dragonfly, fenced by the plan version: `getAiCredits`,
//! `recordAiCreditUsage` and `isAiCreditsExhausted` of `dimabot/src/utils/billing.ts`.
//!
//! Keys (`ledger/dragonfly.md`) and what happens to each at cutover (all *rebuilt*: Rust starts
//! on its own logical database and Polar is the authority):
//!
//! | Key | Written by | TTL |
//! |---|---|---|
//! | `twitch:{id}:ai:credits` | the fence's `ACCEPT_PLAN_CREDITS_SCRIPT`, [`APPLY_AI_CREDIT_USAGE`] | 300 s, or 31 days after a usage rewrite |
//! | `twitch:{id}:ai:exhaust`, `{id}:ai:exhaust` | both scripts, the exhaustion repair | none |
//! | `twitch:{id}:ai:credits:plan-version` | the plan projection (read here) | none |
//! | `twitch:{id}:ai:usage-local:{sha256(externalId)}` | [`APPLY_AI_CREDIT_USAGE`] | 31 days |
//! | `twitch:{id}:ai:credits:revision` | the generation and the debits held against Polar's figures: every debit, acknowledgement, dead letter, read of Polar and publication ([`super::balance`]) | 31 days |
//!
//! The exhaustion flags are rebuilt lazily: after a clear, a channel reads as not exhausted until
//! its next `getAiCredits` (which every paid AI path calls) or usage write. The cutover step
//! should copy them or warm them; see the package report.
//!
//! Ordering is the reference's: the version is compared with the fence in Rust before the
//! provider call (JavaScript's `<`, UTF-16 order) and again inside the script (byte order) at
//! publication, so a plan downgrade that lands while Polar is being read wins. On top of it
//! (item 4 of P2-BILLING-01b, item 1 of P2-BILLING-01c), a fetched balance is published within
//! the generation read before Polar was asked, a newer publication wins, and every local debit
//! Polar's figure may not cover yet is held against it ([`super::balance`]): spent credit never
//! comes back. A balance found without its revision belongs to a lost generation and is read
//! again from Polar. The exhaustion flags are read and repaired in one atomic step.

use super::ai_credit_limit_for_plan;
use super::balance::{self, Hold, Publication, Start};
use super::credits::{
    AI_CREDITS_CACHE_SCHEMA_VERSION, AI_CREDITS_CACHE_TTL_SECONDS, AiCredits, AiCreditsData,
    BalanceState, CreditStatus, VerifiedBalance, build_ai_credits_data_from_meter,
    read_cached_credits, unavailable_ai_credits,
};
use crate::Observer;
use crate::products::AI_CREDITS_METER_ID;
use dima_core::{Clock, Random};
use dima_model::Private;
use dima_store::dragonfly::plan_cache_fence::{
    Acceptance, CreditMode, FenceError, PlanCacheFence, TtlSeconds, credits_cache_key,
    exhaustion_cache_keys, plan_cache_fence_key, plan_cache_version,
};
use dima_store::dragonfly::{Dragonfly, DragonflyError};
use futures_util::future::BoxFuture;
use serde_json::Value;
use std::sync::Arc;

/// `APPLY_AI_CREDIT_USAGE_SCRIPT` (`billing.ts`) with the hold of local debits
/// ([`super::balance::HOLD_PRELUDE`], [`super::balance::DEBIT_GUARD_LINES`],
/// [`super::balance::DEBIT_HOLD_LINES`]): otherwise the reference's text.
pub use super::balance::DEBIT as APPLY_AI_CREDIT_USAGE;

/// 31 days, the usage rewrite's TTL and the idempotency marker's.
pub const USAGE_MARKER_TTL_SECONDS: u64 = 31 * 24 * 60 * 60;

/// The plan fields `getAiCredits` reads of a user (`Pick<IUsers, 'plan_tier' |
/// 'polar_sh_customer_id' | 'polar_plan_event_at' | 'polar_plan_event_key'>`).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct PlanOwner {
    /// `plan_tier` as stored (`None` when a lean read had none).
    pub plan_tier: Option<String>,
    /// `polar_sh_customer_id` ([`Private`]: never in `Debug`).
    pub polar_sh_customer_id: Option<Private<String>>,
    /// `polar_plan_event_at` (epoch ms).
    pub polar_plan_event_at: Option<i64>,
    /// `polar_plan_event_key`.
    pub polar_plan_event_key: Option<String>,
}

impl PlanOwner {
    /// The plan fields of a stored user.
    pub fn of(user: &dima_model::users::User) -> Self {
        Self {
            plan_tier: Some(user.plan_tier.as_str().to_owned()),
            polar_sh_customer_id: user.polar_sh_customer_id.clone(),
            polar_plan_event_at: user.polar_plan_event_at.map(|at| at.0),
            polar_plan_event_key: user.polar_plan_event_key.clone(),
        }
    }

    fn customer_id(&self) -> Option<&str> {
        self.polar_sh_customer_id
            .as_ref()
            .map(|id| id.expose().as_str())
            .filter(|id| !id.is_empty())
    }
}

/// A failed read of the current plan.
#[derive(Debug, thiserror::Error)]
#[error("current plan lookup failed: {0}")]
pub struct LookupError(pub String);

/// The current plan of the Twitch owner (`aiCreditReadDependencies.getCurrentPlan`).
pub trait PlanLookup: Send + Sync {
    /// The owner of Twitch account `twitch_id`, pinned to `customer_id` when it is not empty
    /// (the caller's value is passed as it is, as the reference passes it).
    fn current_plan<'a>(
        &'a self,
        twitch_id: &'a str,
        customer_id: Option<&'a str>,
    ) -> BoxFuture<'a, Result<Option<PlanOwner>, LookupError>>;
}

/// The customer state the credits come from (`aiCreditReadDependencies.getState`).
pub trait CustomerStateSource: Send + Sync {
    /// `GET /v1/customers/{id}/state`, as Polar sent it.
    fn customer_state<'a>(
        &'a self,
        customer_id: &'a str,
    ) -> BoxFuture<'a, Result<Value, crate::polar::PolarError>>;
}

impl CustomerStateSource for crate::polar::PolarClient {
    fn customer_state<'a>(
        &'a self,
        customer_id: &'a str,
    ) -> BoxFuture<'a, Result<Value, crate::polar::PolarError>> {
        Box::pin(self.get_customer_state_raw(customer_id))
    }
}

/// The lookup over the `users` collection, as the reference queries it.
#[derive(Clone, Debug)]
pub struct MongoPlanLookup {
    users: mongodb::Collection<bson::Document>,
}

impl MongoPlanLookup {
    /// Over `database.users`.
    pub fn new(database: &mongodb::Database) -> Self {
        Self {
            users: database.collection(dima_model::users::COLLECTION),
        }
    }

    /// `{accounts: {$elemMatch: {type: 'twitch', id}}, ...(customerId ? {polar_sh_customer_id} : {})}`.
    pub fn filter(twitch_id: &str, customer_id: Option<&str>) -> bson::Document {
        let mut filter =
            dima_model::users::by_account(dima_model::users::AccountType::Twitch, twitch_id);
        if let Some(customer) = customer_id.filter(|c| !c.is_empty()) {
            filter.insert("polar_sh_customer_id", customer);
        }
        filter
    }

    /// The selected fields of a lean read: a field of another type is an error, as
    /// `polar_plan_event_at.getTime()` would throw.
    pub fn decode(document: &bson::Document) -> Result<PlanOwner, LookupError> {
        let text = |key: &str| match document.get(key) {
            None | Some(bson::Bson::Null) => Ok(None),
            Some(bson::Bson::String(text)) => Ok(Some(text.clone())),
            Some(_) => Err(LookupError(format!("{key} is not text"))),
        };
        let customer = text("polar_sh_customer_id")?.map(Private::new);
        let at = match document.get("polar_plan_event_at") {
            None | Some(bson::Bson::Null) => None,
            Some(bson::Bson::DateTime(date)) => Some(date.timestamp_millis()),
            Some(_) => return Err(LookupError("polar_plan_event_at is not a date".into())),
        };
        Ok(PlanOwner {
            plan_tier: text("plan_tier")?,
            polar_sh_customer_id: customer,
            polar_plan_event_at: at,
            polar_plan_event_key: text("polar_plan_event_key")?,
        })
    }
}

impl PlanLookup for MongoPlanLookup {
    fn current_plan<'a>(
        &'a self,
        twitch_id: &'a str,
        customer_id: Option<&'a str>,
    ) -> BoxFuture<'a, Result<Option<PlanOwner>, LookupError>> {
        Box::pin(async move {
            let projection = bson::doc! {
                "plan_tier": 1, "polar_sh_customer_id": 1, "polar_plan_event_at": 1, "polar_plan_event_key": 1,
            };
            let found = self
                .users
                .find_one(Self::filter(twitch_id, customer_id))
                .projection(projection)
                .await
                .map_err(|error| LookupError(error.kind.to_string()))?;
            found.as_ref().map(Self::decode).transpose()
        })
    }
}

/// What the usage script did.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum UsageProjection {
    /// Nothing to record (no channel, or not a positive finite number of credits).
    Skipped,
    /// Applied, or no current snapshot to apply it to (script result 0).
    Applied,
    /// Applied and the balance reached 0 (script result 1).
    Exhausted,
    /// Already applied for this external id (script result 2).
    Duplicate,
}

/// Options of `getAiCredits`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct CreditOptions {
    /// `requireVerified`: paid moderation must not treat an unavailable estimate as credit.
    pub require_verified: bool,
}

/// The credit cache. Cheap to clone.
#[derive(Clone)]
pub struct CreditsCache {
    dragonfly: Dragonfly,
    fence: PlanCacheFence,
    clock: Arc<dyn Clock>,
    observer: Arc<dyn Observer>,
    random: Arc<dyn Random>,
}

impl std::fmt::Debug for CreditsCache {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("CreditsCache")
    }
}

fn exhausted_key(id: &str) -> [String; 2] {
    exhaustion_cache_keys(id)
}

impl CreditsCache {
    /// Over one Dragonfly handle. Generation tokens ([`super::balance`]) come from the
    /// system's randomness; [`Self::with_random`] injects another source.
    pub fn new(dragonfly: Dragonfly, clock: Arc<dyn Clock>, observer: Arc<dyn Observer>) -> Self {
        Self {
            fence: PlanCacheFence::new(dragonfly.clone()),
            dragonfly,
            clock,
            observer,
            random: Arc::new(dima_core::SystemRandom),
        }
    }

    /// The same cache drawing generation tokens from `random`.
    #[must_use]
    pub fn with_random(mut self, random: Arc<dyn Random>) -> Self {
        self.random = random;
        self
    }

    fn now_iso(&self) -> String {
        dima_text::to_iso_string(self.clock.now_ms()).unwrap_or_default()
    }

    /// A fresh generation token.
    fn generation_token(&self) -> Result<String, DragonflyError> {
        self.random
            .uuid_v4()
            .map_err(|_| DragonflyError::Reply("generation token unavailable"))
    }

    /// `recordAiCreditUsage(channelID, credits, externalId)`: the local projection of accepted
    /// usage. Best effort in the reference (errors are logged and Polar's webhook reconciles);
    /// the caller decides whether to log the error returned here.
    ///
    /// The usage is taken as acknowledged by Polar now (no queued event carries it): it is held
    /// against the balances published from Polar for [`balance::SETTLE_AFTER_ACK_MS`]
    /// (item 1 of P2-BILLING-01c). The ingest flows record queued usage through the queue
    /// instead.
    pub async fn record_ai_credit_usage(
        &self,
        channel_id: &str,
        credits: f64,
        external_id: Option<&str>,
    ) -> Result<UsageProjection, DragonflyError> {
        self.record_usage(channel_id, credits, external_id, Hold::Acknowledged)
            .await
    }

    /// [`Self::record_ai_credit_usage`] for usage whose event is held by the queue
    /// ([`Hold::Queued`]) or was acknowledged now ([`Hold::Acknowledged`]).
    pub(crate) async fn record_usage(
        &self,
        channel_id: &str,
        credits: f64,
        external_id: Option<&str>,
        hold: Hold,
    ) -> Result<UsageProjection, DragonflyError> {
        if channel_id.is_empty() || !credits.is_finite() || credits <= 0.0 {
            return Ok(UsageProjection::Skipped);
        }
        let external_id = external_id.filter(|id| !id.is_empty());
        let marker = external_id.map_or_else(
            || "untracked".to_owned(),
            |id| dima_core::crypto::sha256(id).hex(),
        );
        let [canonical, legacy] = exhausted_key(channel_id);
        let keys = [
            credits_cache_key(channel_id),
            canonical,
            legacy,
            format!("twitch:{channel_id}:ai:usage-local:{marker}"),
            balance::revision_key(channel_id),
        ];
        let now = self.clock.now_ms();
        let args = [
            dima_text::number_to_string(credits),
            self.now_iso(),
            AI_CREDITS_CACHE_SCHEMA_VERSION.to_string(),
            USAGE_MARKER_TTL_SECONDS.to_string(),
            if external_id.is_some() { "1" } else { "0" }.to_owned(),
            self.generation_token()?,
            match hold {
                Hold::Queued => String::new(),
                Hold::Acknowledged => (now + balance::SETTLE_AFTER_ACK_MS).to_string(),
            },
            balance::ACK_BUCKET_MS.to_string(),
            balance::sweep_floor(now).to_string(),
        ];
        let reply = APPLY_AI_CREDIT_USAGE
            .run_value(&self.dragonfly, &keys, &args)
            .await?;
        Ok(match dima_store::dragonfly::commands::reply::int(reply)? {
            1 => UsageProjection::Exhausted,
            2 => UsageProjection::Duplicate,
            _ => UsageProjection::Applied,
        })
    }

    async fn exhaustion_flags(&self, channel_id: &str) -> Result<(bool, bool), DragonflyError> {
        let [canonical, legacy] = exhausted_key(channel_id);
        let (canonical, legacy) = ([canonical.as_str()], [legacy.as_str()]);
        let (a, b) = tokio::join!(
            self.dragonfly.exists(&canonical),
            self.dragonfly.exists(&legacy)
        );
        Ok((a? == 1, b? == 1))
    }

    /// `isAiCreditsExhausted(channelID)`: either flag, or an exhausted cached snapshot
    /// ([`super::credits::cached_snapshot_is_exhausted`]'s rule); a missing flag is repaired. The
    /// reads and the repair are one atomic script ([`balance::EXHAUSTION`]): the reference read
    /// the flags, then set them, and a refill published between the two was undone (item 4 of
    /// P2-BILLING-01b, review finding 7).
    pub async fn is_ai_credits_exhausted(&self, channel_id: &str) -> Result<bool, DragonflyError> {
        if channel_id.is_empty() {
            return Ok(false);
        }
        let [canonical, legacy] = exhausted_key(channel_id);
        let keys = [canonical, legacy, credits_cache_key(channel_id)];
        let no_args: [&str; 0] = [];
        let reply = balance::EXHAUSTION
            .run_value(&self.dragonfly, &keys, &no_args)
            .await?;
        Ok(dima_store::dragonfly::commands::reply::int(reply)? == 1)
    }

    /// Publishes a fetched balance within the generation read before the fetch, with every
    /// uncovered debit held ([`balance::PUBLISH`]).
    async fn publish(
        &self,
        channel_id: &str,
        version: &str,
        raw: &str,
        start: &Start,
    ) -> Result<(Publication, i64), DragonflyError> {
        let [canonical, legacy] = exhausted_key(channel_id);
        let keys = [
            credits_cache_key(channel_id),
            canonical,
            legacy,
            plan_cache_fence_key(channel_id),
            balance::revision_key(channel_id),
            crate::polar::flush::queue_key(channel_id),
            crate::polar::flush::processing_key(channel_id),
        ];
        let args = [
            version.to_owned(),
            raw.to_owned(),
            AI_CREDITS_CACHE_TTL_SECONDS.to_string(),
            start.generation.clone(),
            start.publications.to_string(),
            start.as_of_ms.to_string(),
            self.clock.now_ms().to_string(),
            self.now_iso(),
            balance::REVISION_TTL_SECONDS.to_string(),
            balance::MAX_FIGURE_AGE_MS.to_string(),
            balance::QUEUED_HOLD_MS.to_string(),
            balance::MOST_QUEUED.to_string(),
        ];
        balance::publication(
            balance::PUBLISH
                .run_value(&self.dragonfly, &keys, &args)
                .await?,
        )
    }

    async fn accept(
        &self,
        channel_id: &str,
        payload: &AiCreditsData,
        version: &str,
        raw: &str,
        mode: CreditMode,
    ) -> Result<bool, FenceError> {
        let ttl = TtlSeconds::new(AI_CREDITS_CACHE_TTL_SECONDS)?;
        let exhausted = payload.status == CreditStatus::Exhausted;
        Ok(self
            .fence
            .accept_credits(channel_id, version, raw, mode, exhausted, ttl)
            .await?
            == Acceptance::Accepted)
    }

    /// `getAiCredits(user, twitchUserId, options)`, with how far the answer can be trusted
    /// ([`BalanceState`], item 5 of P2-BILLING-01b). Only the first cache read can fail the
    /// call (as the reference rejects then); every later failure is answered the reference's way
    /// (unavailable once a fence exists, else the plan-limit fallback), as [`BalanceState::Unknown`].
    ///
    /// `data` is what the reference answers, with one difference: a cached snapshot stored as
    /// unavailable never reads back as available ([`super::credits::read_cached_credits`]).
    /// What chat features check ("may this channel spend": [`Self::is_ai_credits_exhausted`],
    /// then `status`) is otherwise unchanged; nothing that grants, resets or tops up credits may
    /// use `data` unless [`AiCredits::verified`] gives a [`VerifiedBalance`].
    pub async fn get_ai_credits(
        &self,
        user: &PlanOwner,
        twitch_id: &str,
        options: CreditOptions,
        plans: &dyn PlanLookup,
        polar: &dyn CustomerStateSource,
    ) -> Result<AiCredits, DragonflyError> {
        let cache_key = credits_cache_key(twitch_id);
        let cached = self.dragonfly.get_text(&cache_key).await?;
        // A balance whose revision is gone belongs to a lost generation (item 1 of
        // P2-BILLING-01c): it is read again from Polar, whose begin step deletes it.
        let cached = match cached.filter(|raw| !raw.is_empty()) {
            Some(raw)
                if self
                    .dragonfly
                    .exists(&[&balance::revision_key(twitch_id)])
                    .await?
                    == 1 =>
            {
                Some(raw)
            }
            _ => None,
        };
        // A failed acceptance is ignored like a bad cache value.
        if let Some(cached) = cached
            && let Some(read) =
                read_cached_credits(&cached, options.require_verified, || self.now_iso())
            && let Ok(true) = self
                .accept(
                    twitch_id,
                    &read.payload,
                    &read.plan_version,
                    &cached,
                    CreditMode::Read,
                )
                .await
        {
            return Ok(AiCredits::unverified(read.payload, BalanceState::Cached));
        }

        let mut fence: Option<String> = None;
        let mut current_user = user.clone();
        let fetched = self
            .fetch(
                user,
                twitch_id,
                options,
                plans,
                polar,
                &mut fence,
                &mut current_user,
            )
            .await;
        let read_back = |stored: &str| {
            read_cached_credits(stored, options.require_verified, || self.now_iso())
                .map(|read| read.payload)
        };
        let unknown = || {
            AiCredits::unverified(
                unavailable_ai_credits(self.now_iso()),
                BalanceState::Unknown,
            )
        };
        match fetched {
            Ok(Fetched::NotRead(data)) => Ok(AiCredits::unverified(data, BalanceState::Unknown)),
            Ok(Fetched::Read {
                payload,
                meter,
                published,
                raw,
                generation,
                publication,
            }) => Ok(match published {
                // Stored: what Polar answered, with the debits it does not cover yet held.
                Publication::Accepted(stored) => {
                    let data = if stored == raw {
                        Some(payload.clone())
                    } else {
                        read_back(&stored)
                    };
                    match data {
                        Some(data) if meter => AiCredits::verified_by(
                            VerifiedBalance::new(
                                &data,
                                self.clock.now_ms(),
                                generation,
                                publication,
                            ),
                            data,
                        ),
                        Some(data) => AiCredits::unverified(data, BalanceState::Unknown),
                        None => AiCredits::unverified(payload, BalanceState::Unknown),
                    }
                }
                // A newer snapshot was published meanwhile: it stands, and this read verifies
                // nothing (item 2 of P2-BILLING-01c). Too many queued events to count: the
                // cached balance (which carries every local debit) stands. Without one,
                // nothing can be answered.
                Publication::Superseded(current) | Publication::Backlog(current) => {
                    match read_back(&current) {
                        Some(data) => AiCredits::unverified(data, BalanceState::Cached),
                        None => unknown(),
                    }
                }
                // The plan fence is newer, the generation was lost while Polar was read
                // (the next read starts clean), or the figure is too old.
                Publication::Fenced | Publication::Lost | Publication::Stale => unknown(),
            }),
            Err(message) => Ok(AiCredits::unverified(
                self.fallback(twitch_id, &fence, &current_user, &message)
                    .await,
                BalanceState::Unknown,
            )),
        }
    }

    /// A balance read from Polar now, for anything that resets or tops up credits: the cache
    /// is not consulted, and only a read whose publication was accepted is verified: what it
    /// stored, read back (Polar's figure with the debits it does not cover yet held). An
    /// answer without the AI credit meter, a newer publication since the read began (item 2
    /// of P2-BILLING-01c, re-check finding N2), a plan fence that refuses it, a read that could
    /// not be published, or any failure is [`UnverifiedBalance`], never the superseded figures
    /// or the reference's invented fallback.
    pub async fn verified_balance(
        &self,
        user: &PlanOwner,
        twitch_id: &str,
        plans: &dyn PlanLookup,
        polar: &dyn CustomerStateSource,
    ) -> Result<VerifiedBalance, UnverifiedBalance> {
        let mut fence: Option<String> = None;
        let mut current_user = user.clone();
        let options = CreditOptions {
            require_verified: true,
        };
        let fetched = self
            .fetch(
                user,
                twitch_id,
                options,
                plans,
                polar,
                &mut fence,
                &mut current_user,
            )
            .await;
        match fetched {
            Ok(Fetched::Read {
                published: Publication::Fenced,
                ..
            }) => Err(UnverifiedBalance::Fenced),
            Ok(Fetched::Read { meter: false, .. }) => Err(UnverifiedBalance::NoMeter),
            Ok(Fetched::Read {
                published,
                generation,
                publication,
                ..
            }) => match published {
                Publication::Accepted(stored) => {
                    read_cached_credits(&stored, true, || self.now_iso())
                        .map(|read| {
                            VerifiedBalance::new(
                                &read.payload,
                                self.clock.now_ms(),
                                generation,
                                publication,
                            )
                        })
                        .ok_or_else(|| {
                            UnverifiedBalance::Failed("published balance unreadable".into())
                        })
                }
                Publication::Superseded(_) => Err(UnverifiedBalance::Superseded),
                Publication::Fenced => Err(UnverifiedBalance::Fenced),
                Publication::Lost | Publication::Backlog(_) | Publication::Stale => {
                    Err(UnverifiedBalance::NotPublished)
                }
            },
            Ok(Fetched::NotRead(_)) => Err(UnverifiedBalance::NotRead),
            Err(message) => {
                self.observer.error("verifiedAiCredits", &message);
                Err(UnverifiedBalance::Failed(message))
            }
        }
    }

    /// The local top-up after a grant Polar accepted (`adminGrantAiCredits` writes the balance
    /// before the grant plus the credits, until Polar's own figure shows them): `credits`
    /// (whole credits above 0) are added to the cached balance's limit and balance, which turn
    /// available, and the exhaustion flags are removed when credit is left, as the reference
    /// does. Item 2 of P2-BILLING-01c: it takes the balance the read verified, not a number,
    /// and applies only on top of that read's own publication (the debits made since stay
    /// applied), once: after any newer publication, a retry of the same top-up, another
    /// channel's balance, a lost generation or an expired balance it changes nothing
    /// ([`TopUp::Refused`]; the grant shows when Polar's figure does).
    pub async fn top_up(
        &self,
        channel_id: &str,
        credits: f64,
        verified: &VerifiedBalance,
    ) -> Result<TopUp, DragonflyError> {
        let credits = credits.floor();
        if channel_id.is_empty() || !credits.is_finite() || credits <= 0.0 {
            return Ok(TopUp::Refused);
        }
        let (generation, publication) = verified.publication();
        let [canonical, legacy] = exhausted_key(channel_id);
        let keys = [
            credits_cache_key(channel_id),
            canonical,
            legacy,
            balance::revision_key(channel_id),
        ];
        let args = [
            dima_text::number_to_string(credits),
            generation.to_owned(),
            publication.to_string(),
            self.now_iso(),
            AI_CREDITS_CACHE_TTL_SECONDS.to_string(),
            AI_CREDITS_METER_ID.to_owned(),
            AI_CREDITS_CACHE_SCHEMA_VERSION.to_string(),
        ];
        let reply = balance::TOP_UP
            .run_value(&self.dragonfly, &keys, &args)
            .await?;
        Ok(
            if dima_store::dragonfly::commands::reply::int(reply)? == 1 {
                TopUp::Applied
            } else {
                TopUp::Refused
            },
        )
    }

    /// The fetch branch of `getAiCredits`: the plan fence, the customer, Polar's state, then
    /// the publication under the usage revision.
    #[allow(clippy::too_many_arguments)]
    async fn fetch(
        &self,
        user: &PlanOwner,
        twitch_id: &str,
        options: CreditOptions,
        plans: &dyn PlanLookup,
        polar: &dyn CustomerStateSource,
        fence: &mut Option<String>,
        current_user: &mut PlanOwner,
    ) -> Result<Fetched, String> {
        *fence = self
            .dragonfly
            .get_text(&plan_cache_fence_key(twitch_id))
            .await
            .map_err(|e| e.to_string())?
            .filter(|fence| !fence.is_empty());
        let mut version = String::new();
        if let Some(fence) = fence.as_deref() {
            let Some(current) = plans
                .current_plan(
                    twitch_id,
                    user.polar_sh_customer_id
                        .as_ref()
                        .map(|id| id.expose().as_str()),
                )
                .await
                .map_err(|e| e.to_string())?
            else {
                return Ok(Fetched::NotRead(unavailable_ai_credits(self.now_iso())));
            };
            version = plan_cache_version(
                current.polar_plan_event_at,
                current.polar_plan_event_key.as_deref(),
            )
            .map_err(|e| e.to_string())?;
            if dima_text::cmp_utf16(&version, fence).is_lt() {
                return Ok(Fetched::NotRead(unavailable_ai_credits(self.now_iso())));
            }
            *current_user = current;
        }
        let Some(customer_id) = current_user.customer_id() else {
            let mut data = unavailable_ai_credits(self.now_iso());
            if fence.is_none() {
                let limit = ai_credit_limit_for_plan(current_user.plan_tier.as_deref());
                data.limit = limit;
                data.balance = limit;
            }
            return Ok(Fetched::NotRead(data));
        };
        // The generation before Polar is asked (item 1 of P2-BILLING-01c).
        let token = self.generation_token().map_err(|e| e.to_string())?;
        let start = balance::begin(&self.dragonfly, twitch_id, &token, self.clock.now_ms())
            .await
            .map_err(|e| e.to_string())?;
        let state = polar
            .customer_state(customer_id)
            .await
            .map_err(|e| e.to_string())?;
        let meter = state
            .get("active_meters")
            .and_then(Value::as_array)
            .and_then(|meters| {
                meters.iter().find(|meter| {
                    meter.get("meter_id").and_then(Value::as_str) == Some(AI_CREDITS_METER_ID)
                })
            });
        let mut payload = build_ai_credits_data_from_meter(
            meter,
            current_user.plan_tier.as_deref(),
            self.now_iso(),
        );
        // No AI credit meter: the reference's estimate (available, the plan's allowance) is
        // kept on purpose (re-check finding N3, set aside by the lead): a new paying customer
        // may have no meter until its first usage is recorded, and refusing it would keep that
        // channel from ever spending. It is answered as `BalanceState::Unknown` and never as a
        // `VerifiedBalance`, so no reset or top-up runs on it. Pinned by
        // `tests/verified_balance.rs::a_customer_without_a_meter_keeps_the_estimate_and_nothing_runs_on_it`.
        if options.require_verified && meter.is_none() {
            payload.available = false;
            payload.status = CreditStatus::Unavailable;
        }
        let raw = payload.to_cache_text(&version);
        let (published, publication) = self
            .publish(twitch_id, &version, &raw, &start)
            .await
            .map_err(|e| e.to_string())?;
        Ok(Fetched::Read {
            payload,
            meter: meter.is_some(),
            published,
            raw,
            generation: start.generation,
            publication,
        })
    }

    /// The reference's answer when the read failed: unavailable once a fence exists (or cannot
    /// be read), else the plan limit, "exhausted" when a flag says so.
    async fn fallback(
        &self,
        twitch_id: &str,
        fence: &Option<String>,
        current_user: &PlanOwner,
        message: &str,
    ) -> AiCreditsData {
        self.observer.error(
            "getAiCredits",
            &format!("Polar fetch failed, returning fallback from plan limit: {message}"),
        );
        // A fence that exists now (or a failure to read it) cannot revive a paid allowance or
        // touch the exhaustion flags.
        let fenced = match fence {
            Some(_) => true,
            None => match self
                .dragonfly
                .get_text(&plan_cache_fence_key(twitch_id))
                .await
            {
                Ok(value) => value.is_some_and(|v| !v.is_empty()),
                Err(_) => true,
            },
        };
        if fenced {
            return unavailable_ai_credits(self.now_iso());
        }
        let limit = ai_credit_limit_for_plan(current_user.plan_tier.as_deref());
        let exhausted = matches!(self.exhaustion_flags(twitch_id).await, Ok((a, b)) if a || b);
        AiCreditsData {
            version: AI_CREDITS_CACHE_SCHEMA_VERSION,
            used: if exhausted { limit } else { 0.0 },
            limit,
            balance: if exhausted { 0.0 } else { limit },
            meter_id: AI_CREDITS_METER_ID.into(),
            updated_at: self.now_iso(),
            // Quirk kept for what chat features read: `available` is true exactly when the
            // fallback says exhausted (which refuses paid work). The state is `Unknown`, so it
            // can never become the basis of a grant (item 5 of P2-BILLING-01b).
            available: exhausted,
            status: if exhausted {
                CreditStatus::Exhausted
            } else {
                CreditStatus::Unavailable
            },
        }
    }
}

/// What the fetch branch produced.
enum Fetched {
    /// Not read from Polar (the fence refused it, no owner, no customer): the reference's
    /// answer.
    NotRead(AiCreditsData),
    /// Polar answered.
    Read {
        payload: AiCreditsData,
        meter: bool,
        published: Publication,
        raw: String,
        /// The generation the read began in.
        generation: String,
        /// The publications accepted in it once this one was (when it was).
        publication: i64,
    },
}

/// What [`CreditsCache::top_up`] did.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TopUp {
    /// Added to the balance the read published.
    Applied,
    /// Nothing changed (see [`CreditsCache::top_up`]).
    Refused,
}

/// Why [`CreditsCache::verified_balance`] has no verified balance to give.
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
pub enum UnverifiedBalance {
    /// The plan fence refused the read, or the user has no owner or no customer.
    #[error("credit usage cannot be verified for this account")]
    NotRead,
    /// Polar's state has no AI credit meter.
    #[error("Polar reported no AI credit meter")]
    NoMeter,
    /// A newer plan fence refused the publication.
    #[error("a newer plan change superseded the read")]
    Fenced,
    /// A newer balance was published while Polar was read: this read's figures are not
    /// verified (item 2 of P2-BILLING-01c).
    #[error("a newer balance was published while Polar was read")]
    Superseded,
    /// The read could not be published: the generation was lost, too many queued events wait
    /// to be counted, or the figure is too old ([`super::balance::Publication`]).
    #[error("the balance read from Polar could not be published")]
    NotPublished,
    /// Polar or Dragonfly failed.
    #[error("credit usage unavailable: {0}")]
    Failed(String),
}
