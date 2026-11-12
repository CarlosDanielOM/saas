//! The writes a plan change makes: the user's plan fields in MongoDB, then its side effects (AI
//! usage retention, the plan fence raised and the plan caches dropped), and the credit snapshot
//! Polar's state webhook carries.
//!
//! Reference: `projectPolarPlan`, the skip rules of `applyPolarPlanDomainEvent` and the write of
//! `applyPolarCreditsDomainEvent` in `dimabot/src/domain_events/polar_billing_events.ts`. The
//! event envelope, owner resolution and dispatch stay with the event-handler package, which calls
//! these with the owner it loaded.
//!
//! **Ordering.** A plan write is versioned by when the lookup started (`observed_at`), then the
//! event key: the `$or` filter accepts a write only over an older or equal version, so an old
//! webhook that reads fresh state still wins over nothing newer. Every accepted write sets
//! `polar_plan_effects_pending: true` and returns the document it replaced; the fence
//! (`twitch:{id}:ai:credits:plan-version`) is raised with the write's version atomically with the
//! cache deletion, the retention follows when the plan differs from the replaced one, and the
//! flag is removed (filtered on the event key and time) only after both succeeded, so a retry
//! after a crash redoes the effects. Intended difference (item 3 of P2-BILLING-01b): the
//! reference decided whether to run the effects against the owner it had read before the
//! write, and ran retention before invalidating.
//!
//! **One plan change at a time per owner** (item 3 of P2-BILLING-01c, re-check finding N4). Two
//! plan writes for one owner could apply their retention in the wrong order, and Free's
//! retention deletes history: A writes Free and pauses, B writes Premium and finishes its
//! effects, A resumes and deletes. Now the write and its effects run under the owner's plan
//! effects lease in Dragonfly (`locks:plan-effects:{owner id}`, a random token, `SET NX PX`
//! [`EFFECTS_LEASE_MS`], waited for [`EFFECTS_LEASE_WAIT`]: the three processes share it), and
//! the effect is handed a guard ([`EffectGuard::confirm`]) that, immediately before anything
//! destructive, checks that this process still holds the lease (and extends it) and reads the
//! owner's plan again from MongoDB: the plan version that won must still be this write's. A
//! stale effect does nothing and says so ([`PlanProjection::Superseded`]); the pending flag is
//! cleared only by the effects of the write that won (the clear is filtered on its version).
//! The lease is a fence, not the proof: if a holder stalls past its lease, the next write may
//! go ahead, and the stalled one's next confirmation refuses. What is left is the gap between
//! a confirmation and the operation that follows it, which the effect keeps to one MongoDB
//! operation with a server time limit below [`EFFECTS_LEASE_MS`] − [`EFFECTS_DEADLINE`].
//!
//! **The writers of the usage ledger take the same lease** (item 4 of P2-BILLING-02c, re-check
//! point S5): a receipt or a backfill reads the owner's tier under it and writes the expiry it
//! implies under it ([`crate::usage_ledger::record`]), so no plan change can write the owner's
//! tier and run its retention between that read and that write.
//!
//! Writes go through `dima_model::users::INFO` (timestamps as Mongoose adds them) and the store's
//! `PlanCacheFence` (`INVALIDATE_PLAN_SCRIPT`, `SYNC_CREDITS_SCRIPT`, verbatim).

use super::PlanTier;
use super::credits::{AI_CREDITS_CACHE_TTL_SECONDS, build_ai_credits_data_from_meter};
use super::entitlements::EntitledPlan;
use super::pack_context::context_cache_key;
use crate::js;
use crate::products::{AI_CREDITS_METER_ID, LEGACY_USAGE_METER_ID};
use bson::oid::ObjectId;
use bson::{Bson, doc};
use dima_core::Random;
use dima_model::users::{AccountType, User};
use dima_model::{Private, StrEnum};
use dima_store::dragonfly::plan_cache_fence::{
    Acceptance, Exhaustion, FenceError, PlanCacheFence, credits_cache_key, exhaustion_cache_keys,
    plan_cache_fence_key, plan_cache_version, snapshot_version_key,
};
use dima_store::dragonfly::{Dragonfly, DragonflyError};
use dima_store::mongo::update::{Returned, UpdateOptions};
use dima_store::mongo::{MongoStore, WriteContext};
use futures_util::future::BoxFuture;
use serde_json::Value;

/// Why a projection failed.
#[derive(Debug, thiserror::Error)]
pub enum ProjectionError {
    /// `DomainEventPrerequisiteMissingError`: retried later by the journal.
    #[error("prerequisite missing: {0}")]
    PrerequisiteMissing(&'static str),
    /// The write lost to a newer, different or unfinished plan: retry with fresh state.
    #[error(
        "Polar plan projection lost ordering race to divergent or unfinished entitlement; retry fresh state"
    )]
    LostRace,
    /// Another plan change of this owner holds the effects lease: nothing was written; retry
    /// later.
    #[error("another plan change of this owner is running its effects; retry later")]
    EffectsBusy,
    /// The stored snapshot is missing after the write.
    #[error("Polar owner credit snapshot could not be persisted")]
    SnapshotMissing,
    /// A stored value has a shape the reference would throw on.
    #[error("stored Polar credit snapshot is malformed")]
    MalformedSnapshot,
    /// The model refused the write.
    #[error(transparent)]
    Model(#[from] dima_model::ModelError),
    /// MongoDB failed.
    #[error(transparent)]
    Write(#[from] dima_store::mongo::write::WriteError),
    /// A stored user could not be read.
    #[error(transparent)]
    Read(#[from] dima_model::DecodeError),
    /// Dragonfly failed.
    #[error(transparent)]
    Fence(#[from] FenceError),
    /// The retention adjustment failed (or outlived [`EFFECTS_DEADLINE`]).
    #[error("AI usage retention adjustment failed: {0}")]
    Retention(String),
}

/// How long the owner's plan effects lease lasts, renewed by every confirmation.
pub const EFFECTS_LEASE_MS: u64 = 60_000;
/// How long a plan write waits for another one's effects before it gives up
/// ([`ProjectionError::EffectsBusy`]).
pub const EFFECTS_LEASE_WAIT: std::time::Duration = std::time::Duration::from_millis(2500);
/// How often it tries meanwhile.
pub const EFFECTS_LEASE_RETRY: std::time::Duration = std::time::Duration::from_millis(100);
/// The deadline of the retention adjustment: aborted past it (the lease outlives it by
/// 15 s, the margin a MongoDB operation's server time limit must stay within).
pub const EFFECTS_DEADLINE: std::time::Duration = std::time::Duration::from_secs(45);

/// `locks:plan-effects:{owner id}` (Rust-only).
pub fn effects_lease_key(owner_id: &ObjectId) -> String {
    format!("locks:plan-effects:{}", owner_id.to_hex())
}

static EXTEND_EFFECTS_LEASE: dima_store::dragonfly::Script = dima_store::dragonfly::Script::new(
    "PLAN_EFFECTS_LEASE_EXTEND",
    include_str!("lua/plan_effects_extend.lua"),
);
static RELEASE_EFFECTS_LEASE: dima_store::dragonfly::Script = dima_store::dragonfly::Script::new(
    "PLAN_EFFECTS_LEASE_RELEASE",
    include_str!("lua/plan_effects_release.lua"),
);

/// Every script of the plan effects lease, for the tests that check them.
pub fn effects_lease_scripts() -> [&'static dima_store::dragonfly::Script; 2] {
    [&EXTEND_EFFECTS_LEASE, &RELEASE_EFFECTS_LEASE]
}

/// Why an effect must not go on.
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
pub enum StaleEffect {
    /// This process no longer holds the owner's plan effects lease.
    #[error("the plan effects lease passed to another plan change")]
    LeaseLost,
    /// A newer plan write is stored: its own effects apply instead.
    #[error("a newer plan write superseded this one")]
    Superseded,
    /// The owner is gone.
    #[error("the owner disappeared")]
    OwnerGone,
    /// MongoDB or Dragonfly could not confirm; treated as stale (nothing destructive runs).
    #[error("the plan could not be confirmed: {0}")]
    Unconfirmed(String),
}

/// Handed to the effects of one plan write ([`PlanEffects::adjust_usage_retention`]).
pub struct EffectGuard<'a> {
    stores: ProjectionStores<'a>,
    owner_id: ObjectId,
    observed_at_ms: i64,
    event_key: &'a str,
    tier: PlanTier,
    lease_key: String,
    token: String,
}

impl std::fmt::Debug for EffectGuard<'_> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("EffectGuard")
            .field("tier", &self.tier)
            .finish_non_exhaustive()
    }
}

impl EffectGuard<'_> {
    /// The tier the write stored.
    pub fn tier(&self) -> PlanTier {
        self.tier
    }

    /// Call immediately before anything destructive (a delete, a shortened lifetime): `Ok` when
    /// this process still holds the owner's plan effects lease (it is extended to
    /// [`EFFECTS_LEASE_MS`]) and the owner's stored plan is still this write's (its version,
    /// and so the tier that won). Otherwise stop, do nothing more, and return
    /// [`Retention::Stale`].
    pub async fn confirm(&self) -> Result<(), StaleEffect> {
        let unconfirmed =
            |error: &dyn std::fmt::Display| StaleEffect::Unconfirmed(error.to_string());
        let extended = EXTEND_EFFECTS_LEASE
            .run_value(
                self.stores.dragonfly,
                &[&self.lease_key],
                &[self.token.as_str(), &EFFECTS_LEASE_MS.to_string()],
            )
            .await
            .map_err(|e| unconfirmed(&e))?;
        if dima_store::dragonfly::commands::reply::int(extended).map_err(|e| unconfirmed(&e))? != 1
        {
            return Err(StaleEffect::LeaseLost);
        }
        let stored = self
            .stores
            .mongo
            .documents(dima_model::users::COLLECTION)
            .find_one(doc! { "_id": self.owner_id })
            .projection(
                doc! { "plan_tier": 1, "polar_plan_event_at": 1, "polar_plan_event_key": 1 },
            )
            .await
            .map_err(|e| unconfirmed(&e))?
            .ok_or(StaleEffect::OwnerGone)?;
        let at = match stored.get("polar_plan_event_at") {
            Some(Bson::DateTime(at)) => Some(at.timestamp_millis()),
            _ => None,
        };
        let key = stored.get_str("polar_plan_event_key").ok();
        let tier = stored.get_str("plan_tier").ok();
        if at != Some(self.observed_at_ms)
            || key != Some(self.event_key)
            || tier != Some(self.tier.as_str())
        {
            return Err(StaleEffect::Superseded);
        }
        Ok(())
    }
}

/// What the retention adjustment did.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Retention {
    /// Applied for the write's tier.
    Applied,
    /// [`EffectGuard::confirm`] refused before a destructive step: stopped there.
    Stale,
}

/// The plan side effect owned by the AI usage ledger (`adjustAiUsageRetention`, the second half
/// of this crate).
pub trait PlanEffects: Send + Sync {
    /// Adjusts the retention of the channels' usage receipts to `tier` (`guard.tier()`).
    /// Each step that deletes, or shortens a lifetime that a TTL index then enforces, is
    /// preceded by `guard.confirm()`; when it refuses, the adjustment stops at once and
    /// returns [`Retention::Stale`]. Each step is one MongoDB operation with a server time limit
    /// (`maxTimeMS`) of at most 10 s, so none can outlive the lease after a confirmation.
    fn adjust_usage_retention<'a>(
        &'a self,
        channel_ids: &'a [String],
        tier: PlanTier,
        guard: &'a EffectGuard<'a>,
    ) -> BoxFuture<'a, Result<Retention, String>>;
}

/// What [`project_polar_plan`] did.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PlanProjection {
    /// The write was applied, and its effects ran when the plan changed (the reference's
    /// `true`).
    Applied,
    /// A newer equal plan was already stored: nothing to do (the reference's `false`).
    AlreadyCurrent,
    /// The write was applied, but a newer plan write took over before its effects could run:
    /// they did nothing, and the newer write's effects apply and clear the pending flag.
    Superseded,
}

/// Where the projection writes.
#[derive(Clone)]
pub struct ProjectionStores<'a> {
    /// MongoDB.
    pub mongo: &'a MongoStore,
    /// Dragonfly.
    pub dragonfly: &'a Dragonfly,
}

/// The owner fields the plan projection reads (`IUsers` loaded lean).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PlanOwnerState {
    /// `_id`.
    pub id: ObjectId,
    /// `polar_sh_customer_id || null` ([`Private`]: never in `Debug`).
    pub customer_id: Option<Private<String>>,
    /// `plan_tier` as stored.
    pub plan_tier: String,
    /// `plan_tier_until` (epoch ms).
    pub plan_tier_until: Option<i64>,
    /// `polar_plan_effects_pending === true`.
    pub effects_pending: bool,
    /// `polar_plan_event_key`.
    pub event_key: Option<String>,
    /// `polar_plan_entitlement_fingerprint`.
    pub fingerprint: Option<String>,
    /// The Twitch account ids, in stored order.
    pub twitch_ids: Vec<String>,
}

/// The Twitch account ids; a missing id is `"null"`, as a template literal writes it.
fn twitch_ids(user: &User) -> Vec<String> {
    user.accounts
        .iter()
        .filter(|account| account.kind.is(AccountType::Twitch))
        .map(|account| account.id.clone().unwrap_or_else(|| "null".into()))
        .collect()
}

impl PlanOwnerState {
    /// The fields of a loaded user.
    pub fn of(user: &User) -> Self {
        Self {
            id: user.id,
            customer_id: user
                .polar_sh_customer_id
                .clone()
                .filter(|id| !id.expose().is_empty()),
            plan_tier: user.plan_tier.as_str().to_owned(),
            plan_tier_until: user.plan_tier_until.map(|at| at.0),
            effects_pending: user.polar_plan_effects_pending == Some(true),
            event_key: user.polar_plan_event_key.clone(),
            fingerprint: user.polar_plan_entitlement_fingerprint.clone(),
            twitch_ids: twitch_ids(user),
        }
    }
}

/// The first skip rule of `applyPolarPlanDomainEvent` for a `billing.customer.state.changed`
/// event that carries both arrays: nothing to do when no effect is pending, the stored plan has
/// not expired at `observed_at`, and the stored fingerprint equals the payload's.
pub fn state_change_is_unchanged(
    owner: &PlanOwnerState,
    payload_fingerprint: &str,
    observed_at_ms: i64,
) -> bool {
    !owner.effects_pending
        && owner
            .plan_tier_until
            .is_none_or(|until| until > observed_at_ms)
        && owner.fingerprint.as_deref() == Some(payload_fingerprint)
}

/// The second skip rule: a meter-only state snapshot never revokes a paid tier that Polar did not
/// set (no `polar_plan_event_key`).
pub fn state_change_keeps_unmanaged_tier(owner: &PlanOwnerState, entitled: PlanTier) -> bool {
    owner.plan_tier != "free"
        && owner.event_key.as_deref().is_none_or(str::is_empty)
        && entitled == PlanTier::Free
}

fn date(ms: i64) -> Bson {
    Bson::DateTime(bson::DateTime::from_millis(ms))
}

fn until_bson(until: Option<i64>) -> Bson {
    until.map_or(Bson::Null, date)
}

/// Takes the owner's plan effects lease, waiting [`EFFECTS_LEASE_WAIT`]; `false` when another
/// plan change (or a ledger writer) keeps it.
async fn take_effects_lease(
    dragonfly: &Dragonfly,
    key: &str,
    token: &str,
) -> Result<bool, DragonflyError> {
    take_owner_lease(dragonfly, key, token, EFFECTS_LEASE_WAIT).await
}

/// Takes the owner's plan effects lease `key` with `token` (`SET NX PX` [`EFFECTS_LEASE_MS`]),
/// trying every [`EFFECTS_LEASE_RETRY`] for `wait`; `false` when it stayed taken.
pub(crate) async fn take_owner_lease(
    dragonfly: &Dragonfly,
    key: &str,
    token: &str,
    wait: std::time::Duration,
) -> Result<bool, DragonflyError> {
    let started = tokio::time::Instant::now();
    loop {
        let options = dima_store::dragonfly::SetOptions {
            condition: dima_store::dragonfly::SetCondition::IfMissing,
            expiry: dima_store::dragonfly::SetExpiry::Millis(EFFECTS_LEASE_MS),
            get: false,
        };
        if dragonfly.set(key, token.as_bytes(), options).await?
            == dima_store::dragonfly::SetOutcome::Written
        {
            return Ok(true);
        }
        if started.elapsed() >= wait {
            return Ok(false);
        }
        tokio::time::sleep(EFFECTS_LEASE_RETRY).await;
    }
}

/// Extends the owner's plan effects lease `key` to [`EFFECTS_LEASE_MS`] if `token` still holds
/// it; `false` when it passed to another holder.
pub(crate) async fn extend_owner_lease(
    dragonfly: &Dragonfly,
    key: &str,
    token: &str,
) -> Result<bool, DragonflyError> {
    let extended = EXTEND_EFFECTS_LEASE
        .run_value(dragonfly, &[key], &[token, &EFFECTS_LEASE_MS.to_string()])
        .await?;
    Ok(dima_store::dragonfly::commands::reply::int(extended)? == 1)
}

/// Releases the owner's plan effects lease `key` if `token` still holds it (a failed release
/// expires on its own).
pub(crate) async fn release_owner_lease(dragonfly: &Dragonfly, key: &str, token: &str) {
    let _ = RELEASE_EFFECTS_LEASE
        .run_value(dragonfly, &[key], &[token])
        .await;
}

/// `projectPolarPlan(owner, plan, observedAt, eventKey, customerId, deps, fingerprint)`.
///
/// Item 3 of P2-BILLING-01b (review finding 3). Whether the plan changed is decided against
/// the document this write **replaced**, which the conditional update returns atomically with
/// the write (`returnDocument: 'before'`), not against `owner` as the caller read it earlier:
/// two processes that both read Free could otherwise let the newer one write Free over the
/// older one's Premium and skip the invalidation. Every accepted write sets
/// `polar_plan_effects_pending` and then, in this order: raises the fence to its version and
/// drops the plan caches (always, so no stale cache stays readable while retention runs),
/// adjusts the usage retention when the plan differs from the replaced one (or the replaced
/// one had effects pending), and clears the flag (filtered on this write's event key and
/// time). `owner` still names the customer link the write requires.
///
/// Item 3 of P2-BILLING-01c (re-check finding N4): all of it runs under the owner's plan
/// effects lease (see the module docs; `random` draws its token), the retention under
/// [`EFFECTS_DEADLINE`] and behind [`EffectGuard::confirm`]; a write whose effects were
/// overtaken does nothing more and answers [`PlanProjection::Superseded`].
#[allow(clippy::too_many_arguments)]
pub async fn project_polar_plan(
    stores: ProjectionStores<'_>,
    effects: &dyn PlanEffects,
    owner: &PlanOwnerState,
    plan: EntitledPlan,
    observed_at_ms: i64,
    event_key: &str,
    customer_id: &str,
    fingerprint: &str,
    now_ms: i64,
    random: &dyn Random,
) -> Result<PlanProjection, ProjectionError> {
    let redis = |source| FenceError::Redis {
        write_outcome_unknown: true,
        source,
    };
    let lease_key = effects_lease_key(&owner.id);
    let token = random
        .uuid_v4()
        .map_err(|_| redis(DragonflyError::Reply("lease token unavailable")))?;
    if !take_effects_lease(stores.dragonfly, &lease_key, &token)
        .await
        .map_err(redis)?
    {
        return Err(ProjectionError::EffectsBusy);
    }
    let outcome = project_under_lease(
        stores.clone(),
        effects,
        owner,
        plan,
        observed_at_ms,
        event_key,
        customer_id,
        fingerprint,
        now_ms,
        (&lease_key, &token),
    )
    .await;
    // Released only if still ours; a failed release expires on its own.
    let _ = RELEASE_EFFECTS_LEASE
        .run_value(stores.dragonfly, &[&lease_key], &[token.as_str()])
        .await;
    outcome
}

#[allow(clippy::too_many_arguments)]
async fn project_under_lease(
    stores: ProjectionStores<'_>,
    effects: &dyn PlanEffects,
    owner: &PlanOwnerState,
    plan: EntitledPlan,
    observed_at_ms: i64,
    event_key: &str,
    customer_id: &str,
    fingerprint: &str,
    now_ms: i64,
    (lease_key, token): (&str, &str),
) -> Result<PlanProjection, ProjectionError> {
    let customer = owner
        .customer_id
        .as_ref()
        .map_or(Bson::Null, |id| Bson::from(id.expose().as_str()));
    let filter = doc! {
        "_id": owner.id,
        "polar_sh_customer_id": customer,
        "$or": [
            { "polar_plan_event_at": { "$exists": false } },
            { "polar_plan_event_at": { "$lt": date(observed_at_ms) } },
            { "polar_plan_event_at": date(observed_at_ms), "polar_plan_event_key": { "$lte": event_key } },
        ],
    };
    let set = doc! {
        "plan_tier": plan.plan_tier.as_str(),
        "plan_tier_until": until_bson(plan.until_ms),
        "polar_plan_event_at": date(observed_at_ms),
        "polar_plan_event_key": event_key,
        "polar_plan_entitlement_fingerprint": fingerprint,
        "polar_plan_effects_pending": true,
    };
    let mut ctx = WriteContext::new(now_ms);
    let prepared = dima_model::users::INFO.prepare_find_one_and_update(
        &filter,
        doc! { "$set": set },
        UpdateOptions::default(),
        Returned::Before,
        &mut ctx,
    )?;
    let replaced = stores
        .mongo
        .writes(dima_model::users::COLLECTION)
        .find_one_and_update(&prepared)
        .await?;
    let Some(replaced) = replaced else {
        let current = stores
            .mongo
            .documents(dima_model::users::COLLECTION)
            .find_one(doc! { "_id": owner.id })
            .await
            .map_err(dima_store::mongo::write::WriteError::from)?;
        let Some(current) = current else {
            return Err(ProjectionError::PrerequisiteMissing(
                "owner:Polar owner disappeared or customer link changed before plan update",
            ));
        };
        let current = PlanOwnerState::of(&dima_model::decode_document::<User>(&current)?);
        if current.customer_id != owner.customer_id {
            return Err(ProjectionError::PrerequisiteMissing(
                "owner:Polar owner disappeared or customer link changed before plan update",
            ));
        }
        if current.plan_tier != plan.plan_tier.as_str()
            || current.plan_tier_until != plan.until_ms
            || current.effects_pending
        {
            return Err(ProjectionError::LostRace);
        }
        return Ok(PlanProjection::AlreadyCurrent);
    };
    let replaced = PlanOwnerState::of(&dima_model::decode_document::<User>(&replaced)?);
    let plan_changed = replaced.effects_pending
        || replaced.plan_tier != plan.plan_tier.as_str()
        || replaced.plan_tier_until != plan.until_ms;
    let twitch_ids = &replaced.twitch_ids;

    let context_key = context_cache_key(customer_id);
    if twitch_ids.is_empty() {
        stores
            .dragonfly
            .del(&[&context_key])
            .await
            .map_err(|source| FenceError::Redis {
                write_outcome_unknown: true,
                source,
            })?;
    }
    let fence = PlanCacheFence::new(stores.dragonfly.clone());
    let version = plan_cache_version(Some(observed_at_ms), Some(event_key))?;
    for id in twitch_ids {
        // A newer fence (0) means a later plan write already invalidated: nothing to redo.
        let _: Acceptance = fence.invalidate_plan(id, &version, &context_key).await?;
    }
    if plan_changed && !twitch_ids.is_empty() {
        let guard = EffectGuard {
            stores: stores.clone(),
            owner_id: owner.id,
            observed_at_ms,
            event_key,
            tier: plan.plan_tier,
            lease_key: lease_key.to_owned(),
            token: token.to_owned(),
        };
        // The tier that won is read again before the effects start, and by the effect before
        // each destructive step.
        if guard.confirm().await.is_err() {
            return Ok(PlanProjection::Superseded);
        }
        let retention = tokio::time::timeout(
            EFFECTS_DEADLINE,
            effects.adjust_usage_retention(twitch_ids, plan.plan_tier, &guard),
        )
        .await
        .map_err(|_| ProjectionError::Retention("deadline exceeded".into()))?
        .map_err(ProjectionError::Retention)?;
        if retention == Retention::Stale {
            return Ok(PlanProjection::Superseded);
        }
    }
    let mut ctx = WriteContext::new(now_ms);
    let clear = dima_model::users::INFO.prepare_update(
        &doc! {
            "_id": owner.id,
            "polar_plan_event_key": event_key,
            "polar_plan_event_at": date(observed_at_ms),
        },
        doc! { "$unset": { "polar_plan_effects_pending": "" } },
        UpdateOptions::default(),
        &mut ctx,
    )?;
    stores
        .mongo
        .writes(dima_model::users::COLLECTION)
        .update_one(&clear)
        .await?;
    Ok(PlanProjection::Applied)
}

/// `payload.meters` as stored by Mongoose in a Mixed array: numbers as the driver writes them.
fn meters_bson(meters: &[Value]) -> Bson {
    fn convert(value: &Value) -> Bson {
        match value {
            Value::Null => Bson::Null,
            Value::Bool(flag) => Bson::Boolean(*flag),
            Value::Number(number) => {
                dima_store::mongo::number::js_number(number.as_f64().unwrap_or(f64::NAN))
            }
            Value::String(text) => Bson::String(text.clone()),
            Value::Array(items) => Bson::Array(items.iter().map(convert).collect()),
            Value::Object(object) => Bson::Document(
                object
                    .iter()
                    .map(|(k, v)| (k.clone(), convert(v)))
                    .collect(),
            ),
        }
    }
    Bson::Array(meters.iter().map(convert).collect())
}

/// What the credit projection published.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CreditSync {
    /// The snapshot version (`occurredAt` padded, `:`, event key).
    pub snapshot_version: String,
    /// The cached credits value (empty when the snapshot has no credit meter).
    pub payload: String,
    /// The exhaustion argument.
    pub exhaustion: Exhaustion,
    /// One result per Twitch account.
    pub accepted: Vec<Acceptance>,
}

/// `{x} <= 0` with JavaScript's coercion (`null <= 0` is true).
fn le_zero(value: &Value) -> bool {
    js::number(Some(value)) <= 0.0
}

/// The write of `applyPolarCreditsDomainEvent`: keep the newest snapshot on the user, then
/// publish the credits it implies to every Twitch account, fenced by the plan and snapshot
/// versions. `None` when the owner has no Twitch account.
///
/// Each account's publication happens within the generation read before anything else, and
/// every local debit the snapshot (dated by its `occurredAt`) may not cover is held against it
/// (item 1 of P2-BILLING-01c: [`super::balance`]); publishing the same snapshot again stores the
/// same balance. An account whose generation was lost meanwhile publishes nothing
/// ([`Acceptance::Rejected`]); its next read starts clean. `random` draws the generation token
/// of an account that has none yet.
#[allow(clippy::too_many_arguments)]
pub async fn project_credit_snapshot(
    stores: ProjectionStores<'_>,
    owner_id: ObjectId,
    occurred_at_ms: i64,
    event_key: &str,
    meters: &[Value],
    now_ms: i64,
    random: &dyn Random,
) -> Result<Option<CreditSync>, ProjectionError> {
    // The generation of every account of the owner before anything is read (the accounts are
    // read again from the stored document below; one missing here publishes nothing).
    let mut started: Vec<(String, super::balance::Start)> = Vec::new();
    if let Some(stored) = stores
        .mongo
        .documents(dima_model::users::COLLECTION)
        .find_one(doc! { "_id": owner_id })
        .await
        .map_err(dima_store::mongo::write::WriteError::from)?
    {
        for id in twitch_ids(&dima_model::decode_document::<User>(&stored)?) {
            let redis = |source| FenceError::Redis {
                write_outcome_unknown: true,
                source,
            };
            let token = random
                .uuid_v4()
                .map_err(|_| redis(DragonflyError::Reply("generation token unavailable")))?;
            let start = super::balance::begin(stores.dragonfly, &id, &token, now_ms)
                .await
                .map_err(redis)?;
            started.push((id, start));
        }
    }
    let filter = doc! {
        "_id": owner_id,
        "$or": [
            { "polar_credit_snapshot.occurredAt": { "$exists": false } },
            { "polar_credit_snapshot.occurredAt": { "$lt": date(occurred_at_ms) } },
            { "polar_credit_snapshot.occurredAt": date(occurred_at_ms), "polar_credit_snapshot.eventKey": { "$lte": event_key } },
        ],
    };
    let snapshot = doc! { "occurredAt": date(occurred_at_ms), "eventKey": event_key, "meters": meters_bson(meters) };
    let mut ctx = WriteContext::new(now_ms);
    let prepared = dima_model::users::INFO.prepare_find_one_and_update(
        &filter,
        doc! { "$set": { "polar_credit_snapshot": snapshot } },
        UpdateOptions::default(),
        Returned::After,
        &mut ctx,
    )?;
    let updated = match stores
        .mongo
        .writes(dima_model::users::COLLECTION)
        .find_one_and_update(&prepared)
        .await?
    {
        Some(updated) => Some(updated),
        None => stores
            .mongo
            .documents(dima_model::users::COLLECTION)
            .find_one(doc! { "_id": owner_id })
            .await
            .map_err(dima_store::mongo::write::WriteError::from)?,
    };
    let Some(updated) = updated else {
        return Err(ProjectionError::PrerequisiteMissing(
            "owner:Polar owner credit snapshot could not be persisted",
        ));
    };
    let user = dima_model::decode_document::<User>(&updated)?;
    let Some(current) = updated.get_document("polar_credit_snapshot").ok() else {
        return Err(ProjectionError::SnapshotMissing);
    };
    let current_at = match current.get("occurredAt") {
        Some(Bson::DateTime(at)) => at.timestamp_millis(),
        _ => return Err(ProjectionError::MalformedSnapshot),
    };
    let current_key = current
        .get_str("eventKey")
        .map_err(|_| ProjectionError::MalformedSnapshot)?;
    let stored_meters: Vec<Value> = match current.get("meters") {
        Some(Bson::Array(items)) => items.iter().map(js::bson_to_json).collect(),
        _ => return Err(ProjectionError::MalformedSnapshot),
    };
    // `meters.find(meter => meter.meter_id === …)` throws on a `null` entry.
    let find = |id: &str| -> Result<Option<&Value>, ProjectionError> {
        for meter in &stored_meters {
            if meter.is_null() {
                return Err(ProjectionError::MalformedSnapshot);
            }
            if meter.get("meter_id").and_then(Value::as_str) == Some(id) {
                return Ok(Some(meter));
            }
        }
        Ok(None)
    };
    let credits_meter = find(AI_CREDITS_METER_ID)?;
    let legacy_meter = find(LEGACY_USAGE_METER_ID)?;
    let occurred_iso =
        dima_text::to_iso_string(current_at).ok_or(ProjectionError::MalformedSnapshot)?;
    let credits = credits_meter.map(|meter| {
        build_ai_credits_data_from_meter(Some(meter), Some(user.plan_tier.as_str()), occurred_iso)
    });
    // `credits?.balance ?? legacyMeter?.balance`, then `=== undefined ? '' : <= 0 ? '1' : '0'`.
    let exhaustion = match (
        &credits,
        legacy_meter.and_then(|meter| meter.get("balance")),
    ) {
        (Some(credits), _) => {
            if credits.balance <= 0.0 {
                Exhaustion::Exhausted
            } else {
                Exhaustion::Available
            }
        }
        (None, Some(balance)) => {
            if le_zero(balance) {
                Exhaustion::Exhausted
            } else {
                Exhaustion::Available
            }
        }
        (None, None) => Exhaustion::Keep,
    };
    let plan_version = plan_cache_version(
        user.polar_plan_event_at.map(|at| at.0),
        user.polar_plan_event_key.as_deref(),
    )?;
    let twitch = twitch_ids(&user);
    if twitch.is_empty() {
        return Ok(None);
    }
    let payload = match &credits {
        Some(credits) => {
            let mut map = credits.to_json();
            if !plan_version.is_empty() {
                map.insert(
                    dima_store::dragonfly::plan_cache_fence::PLAN_CACHE_VERSION_FIELD.into(),
                    Value::from(plan_version.as_str()),
                );
            }
            dima_text::to_js_json(&Value::Object(map))
        }
        None => String::new(),
    };
    let snapshot_version = format!(
        "{}:{current_key}",
        dima_text::pad_start(&current_at.to_string(), 13, "0")
    );
    let updated_at = dima_text::to_iso_string(now_ms).unwrap_or_default();
    let mut accepted = Vec::with_capacity(twitch.len());
    for id in &twitch {
        let Some((_, start)) = started.iter().find(|(known, _)| known == id) else {
            // An account added after the projection began: its generation was not read.
            accepted.push(Acceptance::Rejected);
            continue;
        };
        let [canonical, legacy] = exhaustion_cache_keys(id);
        let keys = [
            credits_cache_key(id),
            canonical,
            legacy,
            snapshot_version_key(id),
            plan_cache_fence_key(id),
            super::balance::revision_key(id),
            crate::polar::flush::queue_key(id),
            crate::polar::flush::processing_key(id),
            crate::polar::flush::dead_letter_key(id),
        ];
        let args = [
            snapshot_version.clone(),
            payload.clone(),
            match exhaustion {
                Exhaustion::Keep => String::new(),
                Exhaustion::Exhausted => "1".to_owned(),
                Exhaustion::Available => "0".to_owned(),
            },
            AI_CREDITS_CACHE_TTL_SECONDS.to_string(),
            plan_version.clone(),
            start.generation.clone(),
            current_at.to_string(),
            now_ms.to_string(),
            updated_at.clone(),
            super::balance::REVISION_TTL_SECONDS.to_string(),
            super::balance::MAX_FIGURE_AGE_MS.to_string(),
            super::balance::QUEUED_HOLD_MS.to_string(),
            super::balance::MOST_QUEUED.to_string(),
            super::balance::DEAD_LETTER_SKEW_MS.to_string(),
        ];
        let reply = super::balance::SYNC
            .run_value(stores.dragonfly, &keys, &args)
            .await
            .map_err(|source| FenceError::Redis {
                write_outcome_unknown: true,
                source,
            })?;
        accepted.push(
            match dima_store::dragonfly::commands::reply::int(reply)
                .map_err(|_| FenceError::Protocol)?
            {
                1 => Acceptance::Accepted,
                // A newer fence, a lost generation, a backlog too long to count or a snapshot
                // too old: nothing published.
                0 | 3 | 4 | 5 => Acceptance::Rejected,
                _ => return Err(FenceError::Protocol.into()),
            },
        );
    }
    Ok(Some(CreditSync {
        snapshot_version,
        payload,
        exhaustion,
        accepted,
    }))
}
