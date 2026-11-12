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
//!
//! The exhaustion flags are rebuilt lazily: after a clear, a channel reads as not exhausted until
//! its next `getAiCredits` (which every paid AI path calls) or usage write. The cutover step
//! should copy them or warm them; see the package report.
//!
//! Ordering is the reference's: the version is compared with the fence in Rust before the
//! provider call (JavaScript's `<`, UTF-16 order) and again inside the script (byte order) at
//! publication, so a plan downgrade that lands while Polar is being read wins.

use super::ai_credit_limit_for_plan;
use super::credits::{
    AI_CREDITS_CACHE_SCHEMA_VERSION, AI_CREDITS_CACHE_TTL_SECONDS, AiCreditsData, CreditStatus,
    build_ai_credits_data_from_meter, cached_snapshot_is_exhausted, read_cached_credits,
    unavailable_ai_credits,
};
use crate::Observer;
use crate::products::AI_CREDITS_METER_ID;
use dima_core::Clock;
use dima_store::dragonfly::plan_cache_fence::{
    Acceptance, CreditMode, FenceError, PlanCacheFence, TtlSeconds, credits_cache_key,
    exhaustion_cache_keys, plan_cache_fence_key, plan_cache_version,
};
use dima_store::dragonfly::{Dragonfly, DragonflyError, Script, SetOptions};
use futures_util::future::BoxFuture;
use serde_json::Value;
use std::sync::Arc;

/// `APPLY_AI_CREDIT_USAGE_SCRIPT` (`billing.ts`), verbatim.
pub static APPLY_AI_CREDIT_USAGE: Script = Script::new(
    "APPLY_AI_CREDIT_USAGE_SCRIPT",
    include_str!("lua/apply_ai_credit_usage.lua"),
);

/// 31 days, the usage rewrite's TTL and the idempotency marker's.
pub const USAGE_MARKER_TTL_SECONDS: u64 = 31 * 24 * 60 * 60;

/// The plan fields `getAiCredits` reads of a user (`Pick<IUsers, 'plan_tier' |
/// 'polar_sh_customer_id' | 'polar_plan_event_at' | 'polar_plan_event_key'>`).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct PlanOwner {
    /// `plan_tier` as stored (`None` when a lean read had none).
    pub plan_tier: Option<String>,
    /// `polar_sh_customer_id`.
    pub polar_sh_customer_id: Option<String>,
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
            polar_sh_customer_id: user
                .polar_sh_customer_id
                .as_ref()
                .map(|id| id.expose().clone()),
            polar_plan_event_at: user.polar_plan_event_at.map(|at| at.0),
            polar_plan_event_key: user.polar_plan_event_key.clone(),
        }
    }

    fn customer_id(&self) -> Option<&str> {
        self.polar_sh_customer_id
            .as_deref()
            .filter(|id| !id.is_empty())
    }
}

/// A failed read of the current plan.
#[derive(Debug, thiserror::Error)]
#[error("current plan lookup failed: {0}")]
pub struct LookupError(pub String);

/// The current plan of the Twitch owner (`aiCreditReadDependencies.getCurrentPlan`).
pub trait PlanLookup: Send + Sync {
    /// The owner of Twitch account `twitch_id`, pinned to `customer_id` when given.
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
        let at = match document.get("polar_plan_event_at") {
            None | Some(bson::Bson::Null) => None,
            Some(bson::Bson::DateTime(date)) => Some(date.timestamp_millis()),
            Some(_) => return Err(LookupError("polar_plan_event_at is not a date".into())),
        };
        Ok(PlanOwner {
            plan_tier: text("plan_tier")?,
            polar_sh_customer_id: text("polar_sh_customer_id")?,
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

    async fn set_exhausted(&self, channel_id: &str) -> Result<(), DragonflyError> {
        let [canonical, legacy] = exhausted_key(channel_id);
        let (a, b) = tokio::join!(
            self.dragonfly
                .set(&canonical, b"true", SetOptions::default()),
            self.dragonfly.set(&legacy, b"true", SetOptions::default()),
        );
        a?;
        b?;
        Ok(())
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

    /// `isAiCreditsExhausted(channelID)`: either flag, or an exhausted cached snapshot; a missing
    /// flag is repaired.
    pub async fn is_ai_credits_exhausted(&self, channel_id: &str) -> Result<bool, DragonflyError> {
        if channel_id.is_empty() {
            return Ok(false);
        }
        let (canonical, legacy) = self.exhaustion_flags(channel_id).await?;
        if canonical || legacy {
            if !(canonical && legacy) {
                self.set_exhausted(channel_id).await?;
            }
            return Ok(true);
        }
        let Some(cached) = self
            .dragonfly
            .get_text(&credits_cache_key(channel_id))
            .await?
        else {
            return Ok(false);
        };
        if cached.is_empty() {
            return Ok(false);
        }
        let exhausted = cached_snapshot_is_exhausted(&cached);
        if exhausted {
            self.set_exhausted(channel_id).await?;
        }
        Ok(exhausted)
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

    /// `getAiCredits(user, twitchUserId, options)`. Only the first cache read can fail the call
    /// (as the reference rejects then); every later failure is answered the reference's way
    /// (unavailable once a fence exists, else the plan-limit fallback).
    pub async fn get_ai_credits(
        &self,
        user: &PlanOwner,
        twitch_id: &str,
        options: CreditOptions,
        plans: &dyn PlanLookup,
        polar: &dyn CustomerStateSource,
    ) -> Result<AiCreditsData, DragonflyError> {
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
            return Ok(read.payload);
        }

        let mut fence: Option<String> = None;
        let mut current_user = user.clone();
        let attempt: Result<AiCreditsData, String> = async {
            fence = self
                .dragonfly
                .get_text(&plan_cache_fence_key(twitch_id))
                .await
                .map_err(|e| e.to_string())?
                .filter(|fence| !fence.is_empty());
            let mut version = String::new();
            if let Some(fence) = &fence {
                let Some(current) = plans
                    .current_plan(twitch_id, user.customer_id())
                    .await
                    .map_err(|e| e.to_string())?
                else {
                    return Ok(unavailable_ai_credits(self.now_iso()));
                };
                version = plan_cache_version(
                    current.polar_plan_event_at,
                    current.polar_plan_event_key.as_deref(),
                )
                .map_err(|e| e.to_string())?;
                if dima_text::cmp_utf16(&version, fence).is_lt() {
                    return Ok(unavailable_ai_credits(self.now_iso()));
                }
                current_user = current;
            }
            let Some(customer_id) = current_user.customer_id() else {
                let mut data = unavailable_ai_credits(self.now_iso());
                if fence.is_none() {
                    let limit = ai_credit_limit_for_plan(current_user.plan_tier.as_deref());
                    data.limit = limit;
                    data.balance = limit;
                }
                return Ok(data);
            };
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
            let accepted = self
                .accept(twitch_id, &payload, &version, &raw, CreditMode::Write)
                .await
                .map_err(|e| e.to_string())?;
            Ok(if accepted {
                payload
            } else {
                unavailable_ai_credits(self.now_iso())
            })
        }
        .await;

        match attempt {
            Ok(data) => Ok(data),
            Err(message) => {
                self.observer.error(
                    "getAiCredits",
                    &format!("Polar fetch failed, returning fallback from plan limit: {message}"),
                );
                // A fence that exists now (or a failure to read it) cannot revive a paid
                // allowance or touch the exhaustion flags.
                let fenced = match &fence {
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
                    return Ok(unavailable_ai_credits(self.now_iso()));
                }
                let limit = ai_credit_limit_for_plan(current_user.plan_tier.as_deref());
                let exhausted =
                    matches!(self.exhaustion_flags(twitch_id).await, Ok((a, b)) if a || b);
                Ok(AiCreditsData {
                    version: AI_CREDITS_CACHE_SCHEMA_VERSION,
                    used: if exhausted { limit } else { 0.0 },
                    limit,
                    balance: if exhausted { 0.0 } else { limit },
                    meter_id: AI_CREDITS_METER_ID.into(),
                    updated_at: self.now_iso(),
                    // Quirk kept: `available` is true exactly when the fallback says exhausted.
                    available: exhausted,
                    status: if exhausted {
                        CreditStatus::Exhausted
                    } else {
                        CreditStatus::Unavailable
                    },
                })
            }
        }
    }
}
