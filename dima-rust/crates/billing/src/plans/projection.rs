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
//! webhook that reads fresh state still wins over nothing newer. A write that changes the plan
//! sets `polar_plan_effects_pending: true`; the flag is removed (filtered on the event key) only
//! after retention and every cache invalidation succeeded, so a retry after a crash redoes the
//! effects. The fence (`twitch:{id}:ai:credits:plan-version`) is raised with the same version
//! atomically with the cache deletion.
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
use dima_model::StrEnum;
use dima_model::users::{AccountType, User};
use dima_store::dragonfly::Dragonfly;
use dima_store::dragonfly::plan_cache_fence::{
    Acceptance, Exhaustion, FenceError, PlanCacheFence, TtlSeconds, plan_cache_version,
};
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
    /// The retention adjustment failed.
    #[error("AI usage retention adjustment failed: {0}")]
    Retention(String),
}

/// The plan side effect owned by the AI usage ledger (`adjustAiUsageRetention`, the second half
/// of this crate).
pub trait PlanEffects: Send + Sync {
    /// Adjusts the retention of the channels' usage receipts to `tier`.
    fn adjust_usage_retention<'a>(
        &'a self,
        channel_ids: &'a [String],
        tier: PlanTier,
    ) -> BoxFuture<'a, Result<(), String>>;
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
    /// `polar_sh_customer_id || null`.
    pub customer_id: Option<String>,
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
                .as_ref()
                .map(|id| id.expose().clone())
                .filter(|id| !id.is_empty()),
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

/// `projectPolarPlan(owner, plan, observedAt, eventKey, customerId, deps, fingerprint)`: `true`
/// when this write was applied (and its effects ran), `false` when a newer equal plan was
/// already stored.
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
) -> Result<bool, ProjectionError> {
    let needs_effects = owner.effects_pending
        || owner.plan_tier != plan.plan_tier.as_str()
        || owner.plan_tier_until != plan.until_ms;
    let customer = owner.customer_id.as_deref().map_or(Bson::Null, Bson::from);
    let filter = doc! {
        "_id": owner.id,
        "polar_sh_customer_id": customer,
        "$or": [
            { "polar_plan_event_at": { "$exists": false } },
            { "polar_plan_event_at": { "$lt": date(observed_at_ms) } },
            { "polar_plan_event_at": date(observed_at_ms), "polar_plan_event_key": { "$lte": event_key } },
        ],
    };
    let mut set = doc! {
        "plan_tier": plan.plan_tier.as_str(),
        "plan_tier_until": until_bson(plan.until_ms),
        "polar_plan_event_at": date(observed_at_ms),
        "polar_plan_event_key": event_key,
        "polar_plan_entitlement_fingerprint": fingerprint,
    };
    if needs_effects {
        set.insert("polar_plan_effects_pending", true);
    }
    let mut ctx = WriteContext::new(now_ms);
    let prepared = dima_model::users::INFO.prepare_find_one_and_update(
        &filter,
        doc! { "$set": set },
        UpdateOptions::default(),
        Returned::After,
        &mut ctx,
    )?;
    let updated = stores
        .mongo
        .writes(dima_model::users::COLLECTION)
        .find_one_and_update(&prepared)
        .await?;
    let Some(updated) = updated else {
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
        return Ok(false);
    };
    let updated_pending = updated
        .get_bool("polar_plan_effects_pending")
        .unwrap_or(false);
    if !needs_effects && !updated_pending {
        return Ok(true);
    }
    if !owner.twitch_ids.is_empty() {
        effects
            .adjust_usage_retention(&owner.twitch_ids, plan.plan_tier)
            .await
            .map_err(ProjectionError::Retention)?;
    }
    let context_key = context_cache_key(customer_id);
    if owner.twitch_ids.is_empty() {
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
    for id in &owner.twitch_ids {
        // A newer fence (0) means a later plan write already invalidated: nothing to redo.
        let _: Acceptance = fence.invalidate_plan(id, &version, &context_key).await?;
    }
    let mut ctx = WriteContext::new(now_ms);
    let clear = dima_model::users::INFO.prepare_update(
        &doc! { "_id": owner.id, "polar_plan_event_key": event_key },
        doc! { "$unset": { "polar_plan_effects_pending": "" } },
        UpdateOptions::default(),
        &mut ctx,
    )?;
    stores
        .mongo
        .writes(dima_model::users::COLLECTION)
        .update_one(&clear)
        .await?;
    Ok(true)
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
pub async fn project_credit_snapshot(
    stores: ProjectionStores<'_>,
    owner_id: ObjectId,
    occurred_at_ms: i64,
    event_key: &str,
    meters: &[Value],
    now_ms: i64,
) -> Result<Option<CreditSync>, ProjectionError> {
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
    let fence = PlanCacheFence::new(stores.dragonfly.clone());
    let ttl = TtlSeconds::new(AI_CREDITS_CACHE_TTL_SECONDS)?;
    let mut accepted = Vec::with_capacity(twitch.len());
    for id in &twitch {
        accepted.push(
            fence
                .sync_credits(
                    id,
                    &snapshot_version,
                    (!payload.is_empty()).then_some(payload.as_str()),
                    exhaustion,
                    ttl,
                    &plan_version,
                )
                .await?,
        );
    }
    Ok(Some(CreditSync {
        snapshot_version,
        payload,
        exhaustion,
        accepted,
    }))
}
