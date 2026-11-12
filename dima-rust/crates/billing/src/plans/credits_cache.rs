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
//! | `twitch:{id}:ai:credits:revision` | every debit and publication ([`super::balance`]) | 31 days |
//!
//! The exhaustion flags are rebuilt lazily: after a clear, a channel reads as not exhausted until
//! its next `getAiCredits` (which every paid AI path calls) or usage write. The cutover step
//! should copy them or warm them; see the package report.
//!
//! Ordering is the reference's: the version is compared with the fence in Rust before the
//! provider call (JavaScript's `<`, UTF-16 order) and again inside the script (byte order) at
//! publication, so a plan downgrade that lands while Polar is being read wins. On top of it
//! (item 4 of P2-BILLING-01b), a fetched balance is published under the usage revision read
//! before Polar was asked ([`super::balance`]): a newer publication wins, and local debits made
//! meanwhile are applied instead of being overwritten. The exhaustion flags are read and repaired
//! in one atomic step.

use super::ai_credit_limit_for_plan;
use super::balance::{self, Publication, Revision};
use super::credits::{
    AI_CREDITS_CACHE_SCHEMA_VERSION, AI_CREDITS_CACHE_TTL_SECONDS, AiCredits, AiCreditsData,
    BalanceState, CreditStatus, VerifiedBalance, build_ai_credits_data_from_meter,
    read_cached_credits, unavailable_ai_credits,
};
use crate::Observer;
use crate::products::AI_CREDITS_METER_ID;
use dima_core::Clock;
use dima_model::Private;
use dima_store::dragonfly::plan_cache_fence::{
    Acceptance, CreditMode, FenceError, PlanCacheFence, TtlSeconds, credits_cache_key,
    exhaustion_cache_keys, plan_cache_fence_key, plan_cache_version,
};
use dima_store::dragonfly::{Dragonfly, DragonflyError};
use futures_util::future::BoxFuture;
use serde_json::Value;
use std::sync::Arc;

/// `APPLY_AI_CREDIT_USAGE_SCRIPT` (`billing.ts`) with the usage revision
/// ([`super::balance::DEBIT_REVISION_LINES`]): otherwise the reference's text.
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
    /// Over one Dragonfly handle.
    pub fn new(dragonfly: Dragonfly, clock: Arc<dyn Clock>, observer: Arc<dyn Observer>) -> Self {
        Self {
            fence: PlanCacheFence::new(dragonfly.clone()),
            dragonfly,
            clock,
            observer,
        }
    }

    fn now_iso(&self) -> String {
        dima_text::to_iso_string(self.clock.now_ms()).unwrap_or_default()
    }

    /// `recordAiCreditUsage(channelID, credits, externalId)`: the local projection of accepted
    /// usage. Best effort in the reference (errors are logged and Polar's webhook reconciles);
    /// the caller decides whether to log the error returned here.
    pub async fn record_ai_credit_usage(
        &self,
        channel_id: &str,
        credits: f64,
        external_id: Option<&str>,
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
        let args = [
            dima_text::number_to_string(credits),
            self.now_iso(),
            AI_CREDITS_CACHE_SCHEMA_VERSION.to_string(),
            USAGE_MARKER_TTL_SECONDS.to_string(),
            if external_id.is_some() { "1" } else { "0" }.to_owned(),
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

    /// Publishes a fetched balance under the revision read before the fetch
    /// ([`balance::PUBLISH`]).
    async fn publish(
        &self,
        channel_id: &str,
        version: &str,
        raw: &str,
        start: Revision,
    ) -> Result<Publication, DragonflyError> {
        let [canonical, legacy] = exhausted_key(channel_id);
        let keys = [
            credits_cache_key(channel_id),
            canonical,
            legacy,
            plan_cache_fence_key(channel_id),
            balance::revision_key(channel_id),
        ];
        let args = [
            version.to_owned(),
            raw.to_owned(),
            AI_CREDITS_CACHE_TTL_SECONDS.to_string(),
            start.rev.to_string(),
            start.debits.to_string(),
            self.now_iso(),
            balance::REVISION_TTL_SECONDS.to_string(),
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
        // A failed acceptance is ignored like a bad cache value.
        if let Some(cached) = cached.filter(|raw| !raw.is_empty())
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
            return Ok(AiCredits {
                data: read.payload,
                state: BalanceState::Cached,
            });
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
        match fetched {
            Ok(Fetched::NotRead(data)) => Ok(AiCredits {
                data,
                state: BalanceState::Unknown,
            }),
            Ok(Fetched::Read {
                payload,
                meter,
                published,
                raw,
            }) => {
                let read = if meter {
                    BalanceState::Verified {
                        at_ms: self.clock.now_ms(),
                    }
                } else {
                    BalanceState::Unknown
                };
                Ok(match published {
                    Publication::Accepted(stored) if stored == raw => AiCredits {
                        data: payload,
                        state: read,
                    },
                    // Debits made during the fetch were applied to what Polar answered.
                    Publication::Accepted(stored) => AiCredits {
                        data: read_back(&stored).unwrap_or(payload),
                        state: read,
                    },
                    // A newer snapshot was published meanwhile: it stands.
                    Publication::Superseded(current) => match read_back(&current) {
                        Some(data) => AiCredits {
                            data,
                            state: BalanceState::Cached,
                        },
                        None => AiCredits {
                            data: payload,
                            state: read,
                        },
                    },
                    Publication::Fenced => AiCredits {
                        data: unavailable_ai_credits(self.now_iso()),
                        state: BalanceState::Unknown,
                    },
                })
            }
            Err(message) => Ok(AiCredits {
                data: self
                    .fallback(twitch_id, &fence, &current_user, &message)
                    .await,
                state: BalanceState::Unknown,
            }),
        }
    }

    /// A balance read from Polar now, for anything that grants, resets or tops up credits:
    /// the cache is not consulted, and an answer without the AI credit meter, a plan fence that
    /// refuses the read, or any failure is [`UnverifiedBalance`], never the reference's
    /// invented fallback. What Polar answered is published like any fetch.
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
        match self
            .fetch(
                user,
                twitch_id,
                options,
                plans,
                polar,
                &mut fence,
                &mut current_user,
            )
            .await
        {
            Ok(Fetched::Read {
                published: Publication::Fenced,
                ..
            }) => Err(UnverifiedBalance::Fenced),
            Ok(Fetched::Read { meter: false, .. }) => Err(UnverifiedBalance::NoMeter),
            Ok(Fetched::Read { payload, .. }) => {
                Ok(VerifiedBalance::new(&payload, self.clock.now_ms()))
            }
            Ok(Fetched::NotRead(_)) => Err(UnverifiedBalance::NotRead),
            Err(message) => {
                self.observer.error("verifiedAiCredits", &message);
                Err(UnverifiedBalance::Failed(message))
            }
        }
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
        // The usage revision before Polar is asked (item 4).
        let start = balance::read_revision(&self.dragonfly, twitch_id)
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
        if options.require_verified && meter.is_none() {
            payload.available = false;
            payload.status = CreditStatus::Unavailable;
        }
        let raw = payload.to_cache_text(&version);
        let published = self
            .publish(twitch_id, &version, &raw, start)
            .await
            .map_err(|e| e.to_string())?;
        Ok(Fetched::Read {
            payload,
            meter: meter.is_some(),
            published,
            raw,
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
    },
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
    /// Polar or Dragonfly failed.
    #[error("credit usage unavailable: {0}")]
    Failed(String),
}
