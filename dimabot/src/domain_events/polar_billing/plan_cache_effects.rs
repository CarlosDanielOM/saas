//! Concrete `PolarBillingEffects` over the existing plan-cache fence and the
//! existing AI-usage retention adapter.
//!
//! Source contract: the effects half of `projectPolarPlan` and
//! `applyPolarCreditsDomainEvent` in
//! `dimabot/src/domain_events/polar_billing_events.ts`.
//!
//! Preserved behaviour: `adjustAiUsageRetention(channelIDs, planTier)` is the
//! native `utils::ai_usage_retention::AiUsageRetention` adapter (empty list
//! returns immediately, the tier is validated, and its five-collection mutation
//! keeps the `$max`/`$dateAdd` semantics); plan invalidation and credit
//! publication execute the existing `PlanCacheFence::invalidate_plan` /
//! `sync_credits` scripts — this module writes no Lua and issues no bespoke Redis
//! transaction; and an owner without Twitch accounts deletes the credit-pack
//! billing context key with a plain `DEL`.
//!
//! The five-key invalidation set and the five-key sync set are exposed as
//! [`invalidation_keys`] and [`sync_credits_keys`], built from the fence's own key
//! helpers so they cannot drift from the scripts.
//!
//! Deliberately NOT here: MongoDB user writes, entitlement reads, or a second
//! cache protocol. Construction performs no IO.

use super::{BillingFuture, PolarBillingEffects, PolarBillingError};
use crate::utils::{
    ai_credit_projection::PlanTier,
    ai_usage_retention::{AiUsageRetention, Clock},
    billing::plan_tier_name,
    js_string::JsString,
    lossless_json::JsonValue,
    plan_cache_fence::{
        ACCOUNTS_CACHE_KEY, Exhaustion, PlanCacheFence, TtlSeconds, account_cache_key,
        credits_cache_key, exhaustion_cache_keys, plan_cache_fence_key, snapshot_version_key,
    },
};
use mongodb::Database;
use redis::aio::ConnectionManager;

/// The source's five invalidation keys, in script order:
/// `twitch:{id}:ai:credits:plan-version`, `twitch:{id}:ai:credits`,
/// `accounts:twitch:{id}:data`, `twitch:accounts`, and the credit-pack context.
pub fn invalidation_keys(channel_id: &str, billing_context_key: &str) -> [String; 5] {
    [
        plan_cache_fence_key(channel_id),
        credits_cache_key(channel_id),
        account_cache_key(channel_id),
        ACCOUNTS_CACHE_KEY.to_owned(),
        billing_context_key.to_owned(),
    ]
}

/// The source's five sync keys, in script order: the credits payload, both
/// exhaustion flags, the snapshot version, and the plan version.
pub fn sync_credits_keys(channel_id: &str) -> [String; 5] {
    let [canonical, legacy] = exhaustion_cache_keys(channel_id);
    [
        credits_cache_key(channel_id),
        canonical,
        legacy,
        snapshot_version_key(channel_id),
        plan_cache_fence_key(channel_id),
    ]
}

fn runtime_error(context: &'static str, message: impl std::fmt::Display) -> PolarBillingError {
    PolarBillingError::Runtime(format!("{context}: {message}"))
}

/// Concrete effects. Construction performs no IO: the fence owns prepared script
/// handles and the retention adapter owns only the database handle.
#[derive(Clone)]
pub struct PlanCacheFenceEffects {
    fence: PlanCacheFence,
    retention: AiUsageRetention,
    connection: ConnectionManager,
}

impl PlanCacheFenceEffects {
    pub fn new(database: Database, connection: ConnectionManager) -> Self {
        Self::with_retention(connection, AiUsageRetention::new(database))
    }

    /// A fixture clock for the retention adapter's `.toISOString()`/`$dateAdd`
    /// boundaries; the cache operations keep their own deadlines.
    pub fn with_clock(database: Database, connection: ConnectionManager, clock: Clock) -> Self {
        Self::with_retention(connection, AiUsageRetention::with_clock(database, clock))
    }

    fn with_retention(connection: ConnectionManager, retention: AiUsageRetention) -> Self {
        Self {
            fence: PlanCacheFence::new(connection.clone()),
            retention,
            connection,
        }
    }

    /// The fence is cheap to clone and shares the injected multiplexed socket.
    pub fn fence(&self) -> &PlanCacheFence {
        &self.fence
    }
}

impl PolarBillingEffects for PlanCacheFenceEffects {
    /// `adjustAiUsageRetention(channelIDs, planTier)`.
    ///
    /// The native adapter validates the tier, returns immediately for an empty
    /// list, and performs the source's five-collection mutation with a
    /// fail-fast `Promise.all` equivalent for the two expiry deletes.
    fn adjust_usage_retention<'a>(
        &'a self,
        channel_ids: &'a [String],
        plan_tier: PlanTier,
    ) -> BillingFuture<'a, ()> {
        Box::pin(async move {
            let ids: Vec<JsString> = channel_ids
                .iter()
                .map(|id| JsString::from(id.as_str()))
                .collect();
            let tier = JsonValue::String(JsString::from(plan_tier_name(plan_tier)));
            self.retention
                .adjust(&ids, &tier)
                .await
                .map_err(|error| runtime_error("AI usage retention adjustment failed", error))
        })
    }

    /// `INVALIDATE_PLAN_SCRIPT` through the existing fence. A rejected (older)
    /// version is a normal ordering outcome, not an error.
    fn invalidate_plan<'a>(
        &'a self,
        channel_id: &'a str,
        version: &'a str,
        billing_context_key: &'a str,
    ) -> BillingFuture<'a, ()> {
        Box::pin(async move {
            self.fence
                .invalidate_plan(channel_id, version, billing_context_key)
                .await
                .map(|_| ())
                .map_err(PolarBillingError::Cache)
        })
    }

    /// A plain `DEL` used only when the owner has no Twitch accounts.
    fn delete_cache_key<'a>(&'a self, key: &'a str) -> BillingFuture<'a, ()> {
        Box::pin(async move {
            let mut connection = self.connection.clone();
            redis::cmd("DEL")
                .arg(key)
                .query_async::<i64>(&mut connection)
                .await
                .map(|_| ())
                .map_err(|error| runtime_error("Credit-pack context deletion failed", error))
        })
    }

    /// `SYNC_CREDITS_SCRIPT` through the existing fence.
    fn sync_credits<'a>(
        &'a self,
        channel_id: &'a str,
        snapshot_version: &'a str,
        raw_payload: Option<&'a str>,
        exhaustion: Exhaustion,
        ttl: TtlSeconds,
        plan_version: &'a str,
    ) -> BillingFuture<'a, ()> {
        Box::pin(async move {
            self.fence
                .sync_credits(
                    channel_id,
                    snapshot_version,
                    raw_payload,
                    exhaustion,
                    ttl,
                    plan_version,
                )
                .await
                .map(|_| ())
                .map_err(PolarBillingError::Cache)
        })
    }
}
