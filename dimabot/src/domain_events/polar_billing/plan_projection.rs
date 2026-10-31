//! Polar plan projection: watermark, effects, and operator reconciliation.
//!
//! Source contract: `dimabot/src/domain_events/polar_billing_events.ts`
//! (`applyPolarPlanDomainEvent`, `projectPolarPlan`,
//! `reconcilePolarPlanEntitlement`) plus the plan half of the shared
//! `PolarBillingDependencies`.
//!
//! Preserved behaviour, in the source's order:
//! - the event filter (`source == 'polar-webhook'` and a
//!   [`POLAR_PLAN_EVENT_TYPES`] type), with `billing.order.paid` additionally
//!   requiring one of the three plan product ids;
//! - `ownerUserId`-first ownership resolution and its two prerequisite errors;
//! - the pinned-customer check (`Polar plan customer does not match its pinned owner`);
//! - `observedAt` captured **before** the customer-state read, so an old webhook
//!   still reads current authority and an older in-flight lookup cannot
//!   overwrite a later one;
//! - the `billing.customer.state.changed` fingerprint short circuit;
//! - the legacy/manual paid-tier guard for meter-only snapshots;
//! - the `findOneAndUpdate` ordering fence on
//!   `polar_plan_event_at`/`polar_plan_event_key`, its lost-race error, and the
//!   prerequisite error when the owner or its customer link changed;
//! - the pending-effects bit, kept until retention and **every** cache
//!   invalidation succeed, then unset with the matching event key;
//! - reconciliation's explicit-id validation, `plan-reconciliation:<uuid>`
//!   receipt, synthetic envelope, exact-link requirement, and dry-run default.
//!
//! Deliberately NOT here: MongoDB execution (the exact filter/update documents
//! are built by [`plan_update_filter`] / [`plan_update_document`] and run by the
//! injected store), the AI-usage retention mutation (a named seam in
//! [`crate::domain_event_contracts::polar_billing::PolarBillingEffects`]), the reward and
//! gift consumers (seams in the module root), and the HTTP route.

use super::{
    CUSTOMER_MISMATCH, LOST_RACE, MISSING_EVENT_KEY, OWNER_CHANGED, PolarBillingContext,
    PolarBillingError, PolarOwner, RECONCILE_INPUT, RECONCILE_LINK, payload_object, payload_text,
    payload_value, resolve_event_owner,
};
use super::entitlements::{
    POLAR_PLAN_EVENT_TYPES, PolarEntitlementGrant, PolarEntitlementState, PolarPlan,
    polar_entitlement_fingerprint, resolve_polar_entitled_plan,
};
use crate::domain_event_contracts::DomainEventEnvelope;
use crate::utils::{
    ai_credit_projection::PlanTier,
    billing::{
        PLAN_PRODUCT_ID_FREE, PLAN_PRODUCT_ID_PREMIUM, PLAN_PRODUCT_ID_PRO,
        credit_pack_billing_context_cache_key, plan_tier_name,
    },
    credit_policy::JsDate,
    plan_cache_fence::plan_cache_version,
};
use mongodb::bson::{Bson, DateTime, Document, doc};
use serde_json::{Map, Value, json};

const STATE_CHANGED: &str = "billing.customer.state.changed";
const ORDER_PAID: &str = "billing.order.paid";
const DAY_MILLIS: i64 = 86_400_000;

fn tier_eq(left: PlanTier, right: PlanTier) -> bool {
    plan_tier_name(left) == plan_tier_name(right)
}

fn format_iso(millis: i64) -> Result<String, PolarBillingError> {
    JsDate::from_millis(millis as f64)
        .to_iso_string()
        .map_err(|error| PolarBillingError::Runtime(error.to_string()))
}

/// The consumer's event filter, exactly the `domain_event_consumers` filter.
pub fn is_polar_plan_event(event: &DomainEventEnvelope) -> bool {
    event.source() == Some("polar-webhook")
        && event
            .event_type()
            .is_some_and(|event_type| POLAR_PLAN_EVENT_TYPES.contains(&event_type))
}

/// `Object.values(PRODUCT_IDS).some(id => id === payload.productId)`.
pub fn plan_order_product(payload: Option<&Map<String, Value>>) -> bool {
    payload_text(payload, "productId").is_some_and(|product_id| {
        product_id == PLAN_PRODUCT_ID_FREE
            || product_id == PLAN_PRODUCT_ID_PREMIUM
            || product_id == PLAN_PRODUCT_ID_PRO
    })
}

fn bson_instant(millis: i64) -> Bson {
    Bson::DateTime(DateTime::from_millis(millis))
}

fn optional_instant(millis: Option<i64>) -> Bson {
    match millis {
        Some(millis) => bson_instant(millis),
        None => Bson::Null,
    }
}

/// The `findOneAndUpdate` filter. `polar_sh_customer_id: owner.polar_sh_customer_id
/// || null` pins the link observed before the provider lookup, and the `$or`
/// is the source's ordering fence: an older `observedAt` cannot pass an existing
/// later watermark, while an equal instant may advance the event key.
pub fn plan_update_filter(
    owner: &PolarOwner,
    observed_at: i64,
    event_key: &str,
) -> Document {
    let pinned = match owner.pinned_customer_id() {
        Some(customer) => Bson::String(customer.to_owned()),
        None => Bson::Null,
    };
    doc! {
        "_id": owner.owner_id,
        "polar_sh_customer_id": pinned,
        "$or": [
            doc! { "polar_plan_event_at": doc! { "$exists": false } },
            doc! { "polar_plan_event_at": doc! { "$lt": bson_instant(observed_at) } },
            doc! {
                "polar_plan_event_at": bson_instant(observed_at),
                "polar_plan_event_key": doc! { "$lte": event_key },
            },
        ],
    }
}

/// The `$set` document. `polar_plan_effects_pending` is written only when the
/// projection has effects to run, exactly like the source's conditional spread.
pub fn plan_update_document(
    plan: PolarPlan,
    observed_at: i64,
    event_key: &str,
    fingerprint: &str,
    needs_effects: bool,
) -> Document {
    let mut fields = doc! {
        "plan_tier": plan_tier_name(plan.plan_tier),
        "plan_tier_until": optional_instant(plan.until),
        "polar_plan_event_at": bson_instant(observed_at),
        "polar_plan_event_key": event_key,
        "polar_plan_entitlement_fingerprint": fingerprint,
    };
    if needs_effects {
        fields.insert("polar_plan_effects_pending", true);
    }
    doc! { "$set": fields }
}

fn needs_effects(owner: &PolarOwner, plan: PolarPlan) -> bool {
    owner.polar_plan_effects_pending
        || !tier_eq(owner.plan_tier, plan.plan_tier)
        || owner.plan_tier_until != plan.until
}

/// `projectPolarPlan`: the guarded watermark write followed by the effects that
/// must complete before the pending bit is cleared.
pub async fn project_polar_plan(
    owner: &PolarOwner,
    plan: PolarPlan,
    observed_at: i64,
    event_key: &str,
    customer_id: &str,
    fingerprint: &str,
    context: &PolarBillingContext<'_>,
) -> Result<bool, PolarBillingError> {
    let needs_effects = needs_effects(owner, plan);
    let filter = plan_update_filter(owner, observed_at, event_key);
    let update = plan_update_document(plan, observed_at, event_key, fingerprint, needs_effects);
    let updated = context
        .store
        .plan_find_one_and_update(&filter, &update)
        .await?;
    let Some(updated) = updated else {
        let current = context.store.find_owner(owner.owner_id).await?;
        let Some(current) = current else {
            return Err(PolarBillingError::prerequisite(OWNER_CHANGED));
        };
        if current.pinned_customer_id() != owner.pinned_customer_id() {
            return Err(PolarBillingError::prerequisite(OWNER_CHANGED));
        }
        if !tier_eq(current.plan_tier, plan.plan_tier)
            || current.plan_tier_until != plan.until
            || current.polar_plan_effects_pending
        {
            return Err(PolarBillingError::Business(LOST_RACE.into()));
        }
        return Ok(false);
    };
    // Keep the pending bit until retention and every cache invalidation succeeds.
    // Retries after the plan write must not infer success from an unchanged tier.
    if !needs_effects && !updated.polar_plan_effects_pending {
        return Ok(true);
    }
    let twitch_accounts = &owner.twitch_account_ids;
    if !twitch_accounts.is_empty() {
        context
            .effects
            .adjust_usage_retention(twitch_accounts, plan.plan_tier)
            .await?;
    }
    let billing_context_key = credit_pack_billing_context_cache_key(customer_id);
    if twitch_accounts.is_empty() {
        context
            .effects
            .delete_cache_key(&billing_context_key)
            .await?;
    }
    // Publish a persistent monotonic fence atomically with invalidation. A
    // credits consumer that already read the old paid plan cannot refill it.
    let version = plan_cache_version(Some(observed_at), Some(event_key))?;
    for account in twitch_accounts {
        context
            .effects
            .invalidate_plan(account, &version, &billing_context_key)
            .await?;
    }
    context
        .store
        .unset_plan_effects_pending(owner.owner_id, event_key)
        .await?;
    Ok(true)
}

/// `applyPolarPlanDomainEvent`.
pub async fn apply_polar_plan_domain_event(
    event: &DomainEventEnvelope,
    context: &PolarBillingContext<'_>,
) -> Result<(), PolarBillingError> {
    if !is_polar_plan_event(event) {
        return Ok(());
    }
    let event_type = event.event_type().unwrap_or_default();
    let payload = payload_object(event);
    // One-time credit/gift orders are not subscription entitlement signals.
    if event_type == ORDER_PAID && !plan_order_product(payload) {
        return Ok(());
    }
    let owner = resolve_event_owner(event, context.store, context.owner_resolver).await?;

    let subject_customer = event
        .get("subject")
        .and_then(Value::as_object)
        .filter(|subject| subject.get("kind").and_then(Value::as_str) == Some("customer"))
        .and_then(|subject| subject.get("id").and_then(Value::as_str));
    let customer_id = payload_text(payload, "customerId")
        .or(subject_customer)
        .filter(|customer| !customer.is_empty());
    let Some(customer_id) = customer_id else {
        return Err(PolarBillingError::Business(CUSTOMER_MISMATCH.into()));
    };
    if owner
        .pinned_customer_id()
        .is_some_and(|pinned| pinned != customer_id)
    {
        return Err(PolarBillingError::Business(CUSTOMER_MISMATCH.into()));
    }

    // Version by lookup start, not delivery time: even an old webhook reads
    // current authority, and an older in-flight request cannot overwrite a
    // later lookup.
    let observed_at = context.now_millis;
    if event_type == STATE_CHANGED {
        if let (Some(subscriptions), Some(grants)) = (
            payload_value(payload, "activeSubscriptions").and_then(Value::as_array),
            payload_value(payload, "grantedBenefits").and_then(Value::as_array),
        ) {
            let subscriptions = PolarEntitlementState::subscriptions_from_payload(subscriptions);
            let grants = PolarEntitlementGrant::list_from_json(grants);
            let fingerprint = polar_entitlement_fingerprint(&subscriptions, &grants)?;
            let fresh_enough = owner
                .plan_tier_until
                .is_none_or(|until| until > observed_at);
            if !owner.polar_plan_effects_pending
                && fresh_enough
                && owner.polar_plan_entitlement_fingerprint.as_deref()
                    == Some(fingerprint.as_str())
            {
                return Ok(());
            }
        }
    }

    let state = context.entitlements.customer_state(customer_id).await?;
    let plan = resolve_polar_entitled_plan(&state, customer_id, observed_at, context.grace).await?;
    // A meter-only snapshot does not establish that a legacy/manual paid tier was
    // Polar-managed. Actual subscription lifecycle events still reconcile it.
    if event_type == STATE_CHANGED
        && !matches!(owner.plan_tier, PlanTier::Free)
        && !owner.has_event_key()
        && matches!(plan.plan_tier, PlanTier::Free)
    {
        return Ok(());
    }
    let event_key = event
        .event_key()
        .ok_or_else(|| PolarBillingError::Business(MISSING_EVENT_KEY.into()))?;
    let fingerprint =
        polar_entitlement_fingerprint(&state.active_subscriptions, &state.granted_benefits)?;
    project_polar_plan(
        &owner,
        plan,
        observed_at,
        event_key,
        customer_id,
        &fingerprint,
        context,
    )
    .await?;
    Ok(())
}

/// `reconcilePolarPlanEntitlement` input.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ReconcileInput {
    pub owner_user_id: String,
    pub customer_id: String,
    pub execute: bool,
}

/// `reconcilePolarPlanEntitlement` result.
#[derive(Debug, Clone)]
pub struct ReconcileOutcome {
    pub owner_user_id: String,
    pub customer_id: String,
    pub executed: bool,
    pub applied: bool,
    pub before: PolarPlan,
    pub proposed: PolarPlan,
}

fn is_object_id_hex(value: &str) -> bool {
    value.len() == 24 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

/// Targeted operator repair. No scans, journal replay, credits, or rewards.
/// Dry-run by default: the plan is projected only when `execute` is true.
pub async fn reconcile_polar_plan_entitlement(
    input: &ReconcileInput,
    context: &PolarBillingContext<'_>,
) -> Result<ReconcileOutcome, PolarBillingError> {
    if !is_object_id_hex(&input.owner_user_id) || input.customer_id.trim().is_empty() {
        return Err(PolarBillingError::Business(RECONCILE_INPUT.into()));
    }
    let observed_at = context.now_millis;
    let owner_user_id = input.owner_user_id.clone();
    let customer_id = input.customer_id.clone();
    let receipt = format!("plan-reconciliation:{}", uuid::Uuid::new_v4());
    let occurred_at = format_iso(observed_at)?;
    let mut document = Map::new();
    // The synthetic envelope is never journaled; `_id` is present for shape only.
    document.insert("_id".into(), json!(mongodb::bson::oid::ObjectId::new().to_hex()));
    document.insert("eventKey".into(), json!(receipt.clone()));
    document.insert("sourceEventId".into(), json!(receipt.clone()));
    document.insert("source".into(), json!("polar-webhook"));
    document.insert("type".into(), json!(STATE_CHANGED));
    document.insert("topic".into(), json!("domain"));
    document.insert("schemaVersion".into(), json!(1));
    document.insert("ownerUserId".into(), json!(owner_user_id.clone()));
    document.insert(
        "subject".into(),
        json!({"provider": "polar", "kind": "customer", "id": customer_id.clone()}),
    );
    document.insert("occurredAt".into(), json!(occurred_at));
    document.insert("journaledAt".into(), json!(occurred_at));
    document.insert(
        "expiresAt".into(),
        json!(format_iso(observed_at + DAY_MILLIS)?),
    );
    document.insert(
        "payload".into(),
        json!({"customerId": customer_id.clone(), "meters": []}),
    );
    document.insert(
        "metadata".into(),
        json!({"originalEventType": "customer_state_changed"}),
    );
    let event = DomainEventEnvelope::from_document(&document);

    let owner = resolve_event_owner(&event, context.store, context.owner_resolver).await?;
    // Unlike webhook ownership resolution, a manual repair requires an existing
    // exact link.
    if owner.owner_id.to_hex() != owner_user_id
        || owner.pinned_customer_id() != Some(customer_id.as_str())
    {
        return Err(PolarBillingError::Business(RECONCILE_LINK.into()));
    }
    let state = context.entitlements.customer_state(&customer_id).await?;
    let proposed = resolve_polar_entitled_plan(&state, &customer_id, observed_at, context.grace).await?;
    let applied = if input.execute {
        let fingerprint =
            polar_entitlement_fingerprint(&state.active_subscriptions, &state.granted_benefits)?;
        project_polar_plan(
            &owner,
            proposed,
            observed_at,
            &receipt,
            &customer_id,
            &fingerprint,
            context,
        )
        .await?
    } else {
        false
    };
    Ok(ReconcileOutcome {
        owner_user_id,
        customer_id,
        executed: input.execute,
        applied,
        before: PolarPlan {
            plan_tier: owner.plan_tier,
            until: owner.plan_tier_until,
        },
        proposed,
    })
}
