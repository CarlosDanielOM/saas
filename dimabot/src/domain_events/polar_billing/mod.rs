//! Polar billing domain-event consumers.
//!
//! Source contract: `dimabot/src/domain_events/polar_billing_events.ts` and
//! `dimabot/src/domain_events/polar_entitlements.ts`. Split into
//! [`entitlements`] (pure entitlement resolution and provider reads),
//! [`plan_projection`] (plan watermark, effects, reconciliation), and
//! [`credits_projection`] (credit snapshot publication). [`webhook_signature`]
//! ports the signature verification half of
//! `src/server/routes/webhooks/polarsh.webhook.ts`.
//!
//! This root module owns the shared dependency boundary: the owner record, the
//! credit-snapshot record, the store/effects/resolver traits, the error type, and
//! the two cross-team seams (`applyPolarRewardDomainEvent` and
//! `applyCreditGiftDomainEvent`). The traits stay injectable for tests and for
//! integration substitution, and concrete adapters ship in this module tree.
//!
//! Preserved behaviour: the exact event filters, the source's error messages,
//! `ownerUserId`-first ownership resolution, the plan and credit ordering fences,
//! the pending-effects lifecycle, dry-run-by-default reconciliation, and the
//! rule that a reward or gift is applied only for a confirmed paid order.
//!
//! Concrete adapters ship beside the traits:
//! [`mongo_store::MongoPolarBillingStore`] executes the exact MongoDB documents,
//! [`mongo_owner::MongoPolarOwnerResolver`] resolves the owner from the users
//! collection, and [`plan_cache_effects::PlanCacheFenceEffects`] runs plan
//! invalidation, credit synchronization, and the native
//! `utils::ai_usage_retention::AiUsageRetention` adjustment. With feature
//! `paid-order-reward`, the `reward_bridge` module composes the native
//! `utils::paid_order_reward` adapter into [`PolarRewardApplier`].
//!
//! Deliberately NOT here: the HTTP webhook route and raw-body middleware,
//! dotenv loading, and the reward/gift implementations themselves (they live in
//! `utils::paid_order_reward` and the future credit-gift module; the reward
//! composition is the `reward_bridge` above).

pub mod credits_projection;
pub mod entitlements;
pub mod mongo_owner;
pub mod mongo_store;
pub mod plan_cache_effects;
pub mod plan_projection;
#[cfg(feature = "paid-order-reward")]
pub mod reward_bridge;
pub mod webhook_signature;

use crate::domain_event_contracts::{DomainEventEnvelope, DomainEventPrerequisiteMissingError};
use crate::utils::{
    ai_credit_projection::PlanTier,
    plan_cache_fence::{Exhaustion, FenceError, TtlSeconds},
    polar::PolarError,
};
use mongodb::bson::{Document, oid::ObjectId};
use std::{fmt, future::Future, pin::Pin};
use serde_json::{Map, Value};

/// Boxed dependency future, matching `domain_event_contracts::types::DomainEventFuture`'s
/// precedent so these traits stay object-safe.
pub type BillingFuture<'a, T> =
    Pin<Box<dyn Future<Output = Result<T, PolarBillingError>> + Send + 'a>>;

pub const OWNER_MAPPING_UNRESOLVED: &str = "owner:polar customer mapping unresolved";
pub const OWNER_MISSING: &str = "owner:Polar owner no longer exists";
pub const OWNER_CHANGED: &str =
    "owner:Polar owner disappeared or customer link changed before plan update";
pub const SNAPSHOT_NOT_PERSISTED: &str =
    "owner:Polar owner credit snapshot could not be persisted";
pub const SNAPSHOT_MISSING: &str = "Polar owner credit snapshot could not be persisted";
pub const CUSTOMER_MISMATCH: &str = "Polar plan customer does not match its pinned owner";
pub const LOST_RACE: &str =
    "Polar plan projection lost ordering race to divergent or unfinished entitlement; retry fresh state";
pub const RECONCILE_INPUT: &str = "Reconciliation requires explicit ownerUserId and customerId";
pub const RECONCILE_LINK: &str = "Reconciliation owner/customer link mismatch";
pub const MISSING_METERS: &str = "Polar credit snapshot is missing meters";
pub const MISSING_EVENT_KEY: &str = "Polar plan event is missing its eventKey";
pub const REWARD_PAYLOAD: &str = "Polar rewards require a confirmed paid order";
pub const REWARD_CADENCE: &str = "Polar paid order is missing its billing cadence";
pub const GIFT_PAYLOAD: &str = "Gift requires a paid order";

/// Typed consumer failure. Source-authored messages are preserved verbatim.
#[derive(Debug, Clone, PartialEq)]
pub enum PolarBillingError {
    /// `DomainEventPrerequisiteMissingError`; Display is `Missing prerequisite: …`.
    Prerequisite(DomainEventPrerequisiteMissingError),
    Entitlement(entitlements::EntitlementError),
    /// A plain source `Error(message)`.
    Business(String),
    /// Plan/credit cache protocol failure.
    Cache(FenceError),
    /// An injected adapter failure (MongoDB, Redis transport, clock, …).
    Runtime(String),
    /// BSON/JSON conversion failure.
    Serialization(String),
    Transport(PolarError),
}

impl PolarBillingError {
    pub fn prerequisite(prerequisite: &str) -> Self {
        Self::Prerequisite(DomainEventPrerequisiteMissingError::new(prerequisite))
    }
}

impl fmt::Display for PolarBillingError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Prerequisite(error) => error.fmt(f),
            Self::Entitlement(error) => error.fmt(f),
            Self::Business(message) => f.write_str(message),
            Self::Cache(error) => error.fmt(f),
            Self::Runtime(message) => f.write_str(message),
            Self::Serialization(message) => f.write_str(message),
            Self::Transport(error) => error.fmt(f),
        }
    }
}

impl std::error::Error for PolarBillingError {}

impl From<DomainEventPrerequisiteMissingError> for PolarBillingError {
    fn from(error: DomainEventPrerequisiteMissingError) -> Self {
        Self::Prerequisite(error)
    }
}

impl From<FenceError> for PolarBillingError {
    fn from(error: FenceError) -> Self {
        Self::Cache(error)
    }
}

impl From<PolarError> for PolarBillingError {
    fn from(error: PolarError) -> Self {
        Self::Transport(error)
    }
}

/// The `IUsers` projection these consumers read. Dates are epoch milliseconds at
/// the `credit_policy::JsDate` boundary; `twitch_account_ids` is
/// `accounts.filter(a => a.type === 'twitch').map(a => a.id)`.
#[derive(Debug, Clone)]
pub struct PolarOwner {
    pub owner_id: ObjectId,
    pub plan_tier: PlanTier,
    pub plan_tier_until: Option<i64>,
    pub polar_sh_customer_id: Option<String>,
    pub polar_plan_event_at: Option<i64>,
    pub polar_plan_event_key: Option<String>,
    pub polar_plan_effects_pending: bool,
    pub polar_plan_entitlement_fingerprint: Option<String>,
    pub twitch_account_ids: Vec<String>,
}

impl PolarOwner {
    /// `owner.polar_sh_customer_id || null`: an empty string is falsy in JS.
    pub fn pinned_customer_id(&self) -> Option<&str> {
        self.polar_sh_customer_id
            .as_deref()
            .filter(|customer| !customer.is_empty())
    }

    fn has_event_key(&self) -> bool {
        self.polar_plan_event_key
            .as_deref()
            .is_some_and(|key| !key.is_empty())
    }
}

/// `polar_credit_snapshot` as stored on the user document.
#[derive(Debug, Clone, PartialEq)]
pub struct PolarCreditSnapshot {
    pub occurred_at: i64,
    pub event_key: String,
    pub meters: Vec<Document>,
}

/// The owner fields the credits consumer needs after its guarded write.
#[derive(Debug, Clone)]
pub struct PolarCreditSnapshotRecord {
    pub owner_id: ObjectId,
    pub plan_tier: PlanTier,
    pub polar_plan_event_at: Option<i64>,
    pub polar_plan_event_key: Option<String>,
    pub twitch_account_ids: Vec<String>,
    pub snapshot: Option<PolarCreditSnapshot>,
}

/// Injected MongoDB reads/writes. The exact filter and update documents are
/// built by this module; `find_one_and_update` must execute them with
/// `{ returnDocument: "after" }` and the credits read must project
/// `+polar_credit_snapshot`.
pub trait PolarBillingStore: Send + Sync {
    fn find_owner<'a>(&'a self, owner_id: ObjectId) -> BillingFuture<'a, Option<PolarOwner>>;
    fn plan_find_one_and_update<'a>(
        &'a self,
        filter: &'a Document,
        update: &'a Document,
    ) -> BillingFuture<'a, Option<PolarOwner>>;
    fn unset_plan_effects_pending<'a>(
        &'a self,
        owner_id: ObjectId,
        event_key: &'a str,
    ) -> BillingFuture<'a, ()>;
    fn credit_find_one_and_update<'a>(
        &'a self,
        filter: &'a Document,
        update: &'a Document,
    ) -> BillingFuture<'a, Option<PolarCreditSnapshotRecord>>;
    fn credit_find_by_id<'a>(
        &'a self,
        owner_id: ObjectId,
    ) -> BillingFuture<'a, Option<PolarCreditSnapshotRecord>>;
}

/// Injected cache and ledger effects.
pub trait PolarBillingEffects: Send + Sync {
    /// `adjustAiUsageRetention(channelIDs, planTier)`.
    ///
    /// Implemented by
    /// [`plan_cache_effects::PlanCacheFenceEffects`] through the native
    /// `utils::ai_usage_retention::AiUsageRetention` adapter, which owns the
    /// source's five-collection mutation (`$max` `coverageStart`, `$dateAdd`
    /// receipt/daily expiry) and its fail-fast expiry deletes.
    fn adjust_usage_retention<'a>(
        &'a self,
        channel_ids: &'a [String],
        plan_tier: PlanTier,
    ) -> BillingFuture<'a, ()>;
    /// `INVALIDATE_PLAN_SCRIPT` via `PlanCacheFence::invalidate_plan`.
    fn invalidate_plan<'a>(
        &'a self,
        channel_id: &'a str,
        version: &'a str,
        billing_context_key: &'a str,
    ) -> BillingFuture<'a, ()>;
    /// A plain `DEL` of one cache key (the credit-pack billing context).
    fn delete_cache_key<'a>(&'a self, key: &'a str) -> BillingFuture<'a, ()>;
    /// `SYNC_CREDITS_SCRIPT` via `PlanCacheFence::sync_credits`.
    fn sync_credits<'a>(
        &'a self,
        channel_id: &'a str,
        snapshot_version: &'a str,
        raw_payload: Option<&'a str>,
        exhaustion: Exhaustion,
        ttl: TtlSeconds,
        plan_version: &'a str,
    ) -> BillingFuture<'a, ()>;
}

/// `polarWebhookProducer.resolveOwner?: (event) => string | undefined`.
pub trait PolarOwnerResolver: Send + Sync {
    fn resolve_owner_user_id<'a>(
        &'a self,
        event: &'a DomainEventEnvelope,
    ) -> BillingFuture<'a, Option<String>>;
}

/// Everything a consumer needs. Construction performs no IO.
#[derive(Clone, Copy)]
pub struct PolarBillingContext<'a> {
    pub store: &'a dyn PolarBillingStore,
    pub effects: &'a dyn PolarBillingEffects,
    pub entitlements: &'a dyn entitlements::PolarCustomerStateSource,
    pub grace: &'a dyn entitlements::PolarGraceLookup,
    pub owner_resolver: Option<&'a dyn PolarOwnerResolver>,
    /// `deps.now()` captured once per event, before the customer-state read.
    pub now_millis: i64,
}

/// The payload object, exactly the source's `event.payload as PolarBillingPayload`.
pub(crate) fn payload_object(event: &DomainEventEnvelope) -> Option<&Map<String, Value>> {
    event.get("payload").and_then(Value::as_object)
}

pub(crate) fn payload_value<'a>(
    payload: Option<&'a Map<String, Value>>,
    key: &str,
) -> Option<&'a Value> {
    payload.and_then(|payload| payload.get(key))
}

/// A non-nullish string field (`payload.x` used as a string).
pub(crate) fn payload_text<'a>(
    payload: Option<&'a Map<String, Value>>,
    key: &str,
) -> Option<&'a str> {
    payload_value(payload, key).and_then(Value::as_str)
}

pub(crate) fn payload_bool(
    payload: Option<&Map<String, Value>>,
    key: &str,
) -> Option<bool> {
    payload_value(payload, key).and_then(Value::as_bool)
}

pub(crate) fn payload_number(
    payload: Option<&Map<String, Value>>,
    key: &str,
) -> Option<f64> {
    payload_value(payload, key).and_then(Value::as_f64)
}

/// `getOwner(event)`: `event.ownerUserId || resolveOwner?.(event)`, then the
/// users document.
pub async fn resolve_event_owner(
    event: &DomainEventEnvelope,
    store: &dyn PolarBillingStore,
    resolver: Option<&dyn PolarOwnerResolver>,
) -> Result<PolarOwner, PolarBillingError> {
    let owner_user_id = match event
        .get("ownerUserId")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
    {
        Some(id) => id.to_owned(),
        None => match resolver {
            Some(resolver) => resolver
                .resolve_owner_user_id(event)
                .await?
                .filter(|id| !id.is_empty())
                .ok_or_else(|| PolarBillingError::prerequisite(OWNER_MAPPING_UNRESOLVED))?,
            None => return Err(PolarBillingError::prerequisite(OWNER_MAPPING_UNRESOLVED)),
        },
    };
    let owner_id = ObjectId::parse_str(&owner_user_id)
        .map_err(|_| PolarBillingError::prerequisite(OWNER_MAPPING_UNRESOLVED))?;
    store
        .find_owner(owner_id)
        .await?
        .ok_or_else(|| PolarBillingError::prerequisite(OWNER_MISSING))
}

/// `applyPaidOrderReward` input, resolved to the canonical owner and order.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PaidOrderRewardInput {
    pub owner_user_id: String,
    pub order_id: String,
    pub product_id: String,
    pub cadence: String,
}

/// SEAM: `src/utils/paid_order_reward.ts::applyPaidOrderReward` is owned by
/// team2-api-data and is not natively ported. It is a required application
/// adapter, not an optional detail.
pub trait PolarRewardApplier: Send + Sync {
    fn apply_paid_order_reward<'a>(
        &'a self,
        input: &'a PaidOrderRewardInput,
    ) -> BillingFuture<'a, ()>;
}

/// `applyPolarRewardDomainEvent`.
pub async fn apply_polar_reward_domain_event(
    event: &DomainEventEnvelope,
    store: &dyn PolarBillingStore,
    resolver: Option<&dyn PolarOwnerResolver>,
    rewards: &dyn PolarRewardApplier,
) -> Result<(), PolarBillingError> {
    if event.source() != Some("polar-webhook") || event.event_type() != Some("billing.order.paid") {
        return Ok(());
    }
    let payload = payload_object(event);
    if payload_bool(payload, "paid") != Some(true) {
        return Err(PolarBillingError::Business(REWARD_PAYLOAD.into()));
    }
    let Some(order_id) = payload_text(payload, "orderId").filter(|id| !id.is_empty()) else {
        return Err(PolarBillingError::Business(REWARD_PAYLOAD.into()));
    };
    // Polar also emits order.paid for $0 trial starts. One-time orders have no
    // subscription. Older journal rows without an amount must fail closed.
    let subscription_id = payload_text(payload, "subscriptionId").filter(|id| !id.is_empty());
    if subscription_id.is_none() {
        return Ok(());
    }
    let total_amount = payload_number(payload, "totalAmount");
    if total_amount.is_none_or(|amount| amount <= 0.0) {
        return Ok(());
    }
    let Some(product_id) = payload_text(payload, "productId").filter(|product_id| {
        *product_id == crate::utils::billing::PLAN_PRODUCT_ID_PREMIUM
            || *product_id == crate::utils::billing::PLAN_PRODUCT_ID_PRO
    }) else {
        return Ok(());
    };
    let Some(cadence) = payload_text(payload, "cadence").filter(|cadence| !cadence.is_empty())
    else {
        return Err(PolarBillingError::Business(REWARD_CADENCE.into()));
    };
    let owner = resolve_event_owner(event, store, resolver).await?;
    rewards
        .apply_paid_order_reward(&PaidOrderRewardInput {
            owner_user_id: owner.owner_id.to_hex(),
            order_id: order_id.to_owned(),
            product_id: product_id.to_owned(),
            cadence: cadence.to_owned(),
        })
        .await
}

/// SEAM: `src/utils/credit_gifts.ts::acceptCreditGiftPaidOrder` is scheduled for
/// a later team1 wave.
pub trait PolarGiftAcceptor: Send + Sync {
    fn accept_credit_gift_paid_order<'a>(&'a self, order_id: &'a str) -> BillingFuture<'a, ()>;
}

/// `applyCreditGiftDomainEvent`.
pub async fn apply_credit_gift_domain_event(
    event: &DomainEventEnvelope,
    gifts: &dyn PolarGiftAcceptor,
) -> Result<(), PolarBillingError> {
    if event.source() != Some("polar-webhook") || event.event_type() != Some("billing.order.paid") {
        return Ok(());
    }
    let payload = payload_object(event);
    let is_gift_product = payload_text(payload, "productId").is_some_and(|product_id| {
        crate::utils::credit_gift_provider::GIFT_PACK_PAIRS
            .iter()
            .any(|pair| pair.product_id == product_id)
    });
    if !is_gift_product {
        return Ok(());
    }
    // `typeof orderId !== 'string'` is the source check; an empty string passes it.
    let Some(order_id) = payload_text(payload, "orderId") else {
        return Err(PolarBillingError::Business(GIFT_PAYLOAD.into()));
    };
    if payload_bool(payload, "paid") != Some(true) {
        return Err(PolarBillingError::Business(GIFT_PAYLOAD.into()));
    }
    gifts.accept_credit_gift_paid_order(order_id).await
}
