#![cfg(feature = "polar-billing-events")]

//! Decision boundaries for the wave-2-A Polar consumers:
//! `plan_projection` (watermark, effects, reconciliation) and
//! `credits_projection` (snapshot publication). The MongoDB/Redis/provider
//! boundary is an in-file fake, so nothing here needs a service.

use dima_rust::domain_event_contracts::polar_billing::{
    self, BillingFuture, CUSTOMER_MISMATCH, LOST_RACE, MISSING_METERS, OWNER_CHANGED,
    OWNER_MAPPING_UNRESOLVED, PolarBillingContext, PolarBillingEffects, PolarBillingStore,
    PolarCreditSnapshot, PolarCreditSnapshotRecord, PolarOwner, credits_projection, plan_projection,
};
use dima_rust::domain_event_contracts::polar_billing::entitlements::{
    self, PolarCustomerStateSource, PolarEntitlementGrant, PolarEntitlementState,
    PolarEntitlementSubscription, PolarGraceLookup, PolarGraceSubscription,
};
use dima_rust::domain_event_contracts::DomainEventEnvelope;
use dima_rust::utils::ai_credit_projection::{AI_CREDITS_METER_ID, PlanTier};
use dima_rust::utils::billing::{PLAN_PRODUCT_ID_FREE, PLAN_PRODUCT_ID_PREMIUM, PLAN_PRODUCT_ID_PRO};
use dima_rust::utils::billing::plan_tier_name;
use dima_rust::utils::credit_gift_provider::GIFT_PACK_PAIRS;
use dima_rust::utils::js_date::parse_date;
use dima_rust::utils::plan_cache_fence::{Exhaustion, TtlSeconds};
use mongodb::bson::{Bson, DateTime, Document, doc, oid::ObjectId};
use serde_json::{Value, json};
use sha2::Digest;
use std::sync::Mutex;

const CUSTOMER: &str = "polar-customer";
const EVENT_KEY: &str = "polar-webhook:delivery-1";
const OCCURRED_AT: &str = "2026-09-04T10:00:00Z";
/// `deps.now()`: distinct from the event's own timestamp by construction.
const OBSERVED: i64 = 1_788_000_000_000;

fn owner_id() -> ObjectId {
    ObjectId::parse_str("0123456789abcdef01234567").expect("owner id")
}

fn tier(value: &str) -> PlanTier {
    match value {
        "premium" => PlanTier::Premium,
        "pro" => PlanTier::Pro,
        _ => PlanTier::Free,
    }
}

fn owner(plan: PlanTier, twitch: &[&str]) -> PolarOwner {
    PolarOwner {
        owner_id: owner_id(),
        plan_tier: plan,
        plan_tier_until: None,
        polar_sh_customer_id: Some(CUSTOMER.into()),
        polar_plan_event_at: None,
        polar_plan_event_key: None,
        polar_plan_effects_pending: false,
        polar_plan_entitlement_fingerprint: None,
        twitch_account_ids: twitch.iter().map(|id| (*id).to_owned()).collect(),
    }
}

fn subscription(
    id: &str,
    product_id: &str,
    status: &str,
    current_period_end: Option<&str>,
) -> PolarEntitlementSubscription {
    PolarEntitlementSubscription {
        id: id.into(),
        product_id: product_id.into(),
        status: status.into(),
        current_period_end: current_period_end
            .map(|value| entitlements::PolarDate::Millis(parse_date(value).expect("fixture date"))),
        ends_at: None,
        trial_start: None,
        trial_end: None,
    }
}

fn premium_state() -> PolarEntitlementState {
    PolarEntitlementState {
        id: CUSTOMER.into(),
        active_subscriptions: vec![subscription(
            "subscription-1",
            PLAN_PRODUCT_ID_PREMIUM,
            "active",
            Some("2026-10-04T10:00:00Z"),
        )],
        granted_benefits: Vec::new(),
    }
}

fn free_state() -> PolarEntitlementState {
    PolarEntitlementState {
        id: CUSTOMER.into(),
        active_subscriptions: Vec::new(),
        granted_benefits: Vec::new(),
    }
}

#[derive(Debug, Clone, PartialEq)]
struct SyncCall {
    channel_id: String,
    snapshot_version: String,
    raw_payload: Option<String>,
    exhaustion: Exhaustion,
    ttl: TtlSeconds,
    plan_version: String,
}

#[derive(Default)]
struct State {
    owner: Option<PolarOwner>,
    current_owner: Option<PolarOwner>,
    lost_race: bool,
    plan_updates: Vec<(Document, Document)>,
    unsets: Vec<(ObjectId, String)>,
    credit_record: Option<PolarCreditSnapshotRecord>,
    credit_updates: Vec<(Document, Document)>,
    retention: Vec<(Vec<String>, String)>,
    invalidations: Vec<(String, String, String)>,
    deleted: Vec<String>,
    syncs: Vec<SyncCall>,
    entitlements: PolarEntitlementState,
    grace: Vec<PolarGraceSubscription>,
    fail_retention: bool,
    state_reads: usize,
    owner_reads: usize,
}

#[derive(Default)]
struct Memory {
    inner: Mutex<State>,
}

impl Memory {
    fn with(owner: PolarOwner, state: PolarEntitlementState) -> Self {
        Self {
            inner: Mutex::new(State {
                owner: Some(owner),
                entitlements: state,
                ..State::default()
            }),
        }
    }

    /// Runs one synchronous fixture mutation; guards never cross an await point.
    fn edit<T>(&self, update: impl FnOnce(&mut State) -> T) -> T {
        update(&mut self.inner.lock().expect("fixture state"))
    }

    fn context(&self) -> PolarBillingContext<'_> {
        PolarBillingContext {
            store: self,
            effects: self,
            entitlements: self,
            grace: self,
            owner_resolver: None,
            now_millis: OBSERVED,
        }
    }
}

fn apply_set(owner: &mut PolarOwner, update: &Document) {
    let Some(set) = update.get_document("$set").ok() else {
        return;
    };
    if let Ok(plan) = set.get_str("plan_tier") {
        owner.plan_tier = tier(plan);
    }
    owner.plan_tier_until = set
        .get_datetime("plan_tier_until")
        .map(|date| date.timestamp_millis())
        .unwrap_or_default();
    if let Ok(date) = set.get_datetime("polar_plan_event_at") {
        owner.polar_plan_event_at = Some(date.timestamp_millis());
    }
    if let Ok(key) = set.get_str("polar_plan_event_key") {
        owner.polar_plan_event_key = Some(key.to_owned());
    }
    if let Ok(fingerprint) = set.get_str("polar_plan_entitlement_fingerprint") {
        owner.polar_plan_entitlement_fingerprint = Some(fingerprint.to_owned());
    }
    if let Ok(pending) = set.get_bool("polar_plan_effects_pending") {
        owner.polar_plan_effects_pending = pending;
    }
}

impl PolarBillingStore for Memory {
    fn find_owner<'a>(&'a self, _owner_id: ObjectId) -> BillingFuture<'a, Option<PolarOwner>> {
        Box::pin(async move {
            Ok(self.edit(|state| {
                state.owner_reads += 1;
                // The first read resolves the owner; a later read is the lost-CAS
                // re-read, which must observe the *current* divergent document.
                if state.lost_race && state.owner_reads > 1 {
                    state.current_owner.clone()
                } else {
                    state.owner.clone()
                }
            }))
        })
    }

    fn plan_find_one_and_update<'a>(
        &'a self,
        filter: &'a Document,
        update: &'a Document,
    ) -> BillingFuture<'a, Option<PolarOwner>> {
        Box::pin(async move {
            let filter = filter.clone();
            let update = update.clone();
            Ok(self.edit(move |state| {
                state.plan_updates.push((filter, update.clone()));
                if state.lost_race {
                    return None;
                }
                let mut updated = state.owner.clone().expect("fixture owner");
                apply_set(&mut updated, &update);
                state.owner = Some(updated.clone());
                Some(updated)
            }))
        })
    }

    fn unset_plan_effects_pending<'a>(
        &'a self,
        owner_id: ObjectId,
        event_key: &'a str,
    ) -> BillingFuture<'a, ()> {
        Box::pin(async move {
            self.edit(|state| {
                state.unsets.push((owner_id, event_key.to_owned()));
                if let Some(owner) = state.owner.as_mut() {
                    owner.polar_plan_effects_pending = false;
                }
            });
            Ok(())
        })
    }

    fn credit_find_one_and_update<'a>(
        &'a self,
        filter: &'a Document,
        update: &'a Document,
    ) -> BillingFuture<'a, Option<PolarCreditSnapshotRecord>> {
        Box::pin(async move {
            let filter = filter.clone();
            let update = update.clone();
            Ok(self.edit(|state| {
                state.credit_updates.push((filter, update));
                state.credit_record.clone()
            }))
        })
    }

    fn credit_find_by_id<'a>(
        &'a self,
        _owner_id: ObjectId,
    ) -> BillingFuture<'a, Option<PolarCreditSnapshotRecord>> {
        Box::pin(async move { Ok(self.edit(|state| state.credit_record.clone())) })
    }
}

impl PolarBillingEffects for Memory {
    fn adjust_usage_retention<'a>(
        &'a self,
        channel_ids: &'a [String],
        plan_tier: PlanTier,
    ) -> BillingFuture<'a, ()> {
        Box::pin(async move {
            let failed = self.edit(|state| {
                if state.fail_retention {
                    return true;
                }
                state
                    .retention
                    .push((channel_ids.to_vec(), plan_tier_name(plan_tier).to_owned()));
                false
            });
            if failed {
                return Err(polar_billing::PolarBillingError::Runtime(
                    "retention fixture failure".into(),
                ));
            }
            Ok(())
        })
    }

    fn invalidate_plan<'a>(
        &'a self,
        channel_id: &'a str,
        version: &'a str,
        billing_context_key: &'a str,
    ) -> BillingFuture<'a, ()> {
        Box::pin(async move {
            self.edit(|state| {
                state.invalidations.push((
                    channel_id.to_owned(),
                    version.to_owned(),
                    billing_context_key.to_owned(),
                ));
            });
            Ok(())
        })
    }

    fn delete_cache_key<'a>(&'a self, key: &'a str) -> BillingFuture<'a, ()> {
        Box::pin(async move {
            self.edit(|state| state.deleted.push(key.to_owned()));
            Ok(())
        })
    }

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
            self.edit(|state| {
                state.syncs.push(SyncCall {
                    channel_id: channel_id.to_owned(),
                    snapshot_version: snapshot_version.to_owned(),
                    raw_payload: raw_payload.map(str::to_owned),
                    exhaustion,
                    ttl,
                    plan_version: plan_version.to_owned(),
                });
            });
            Ok(())
        })
    }
}

impl PolarCustomerStateSource for Memory {
    fn customer_state<'a>(
        &'a self,
        _customer_id: &'a str,
    ) -> BillingFuture<'a, PolarEntitlementState> {
        Box::pin(async move {
            Ok(self.edit(|state| {
                state.state_reads += 1;
                state.entitlements.clone()
            }))
        })
    }
}

impl PolarGraceLookup for Memory {
    fn grace_subscriptions<'a>(
        &'a self,
        _customer_id: &'a str,
        _grants: &'a [PolarEntitlementGrant],
    ) -> BillingFuture<'a, Vec<PolarGraceSubscription>> {
        Box::pin(async move { Ok(self.edit(|state| state.grace.clone())) })
    }
}

fn event(
    source: &str,
    event_type: &str,
    owner: Option<&str>,
    payload: Value,
) -> DomainEventEnvelope {
    let mut document = serde_json::Map::new();
    document.insert("_id".into(), json!("65e000000000000000000000"));
    document.insert("eventKey".into(), json!(EVENT_KEY));
    document.insert("sourceEventId".into(), json!("delivery-1"));
    document.insert("source".into(), json!(source));
    document.insert("type".into(), json!(event_type));
    document.insert("topic".into(), json!("domain"));
    document.insert("schemaVersion".into(), json!(1));
    if let Some(owner) = owner {
        document.insert("ownerUserId".into(), json!(owner));
    }
    document.insert("occurredAt".into(), json!(OCCURRED_AT));
    document.insert("journaledAt".into(), json!("2026-09-05T10:00:00.000Z"));
    document.insert("expiresAt".into(), json!("2026-10-05T10:00:00.000Z"));
    document.insert("payload".into(), payload);
    document.insert("metadata".into(), json!({}));
    DomainEventEnvelope::from_document(&document)
}

fn state_changed(payload: Value) -> DomainEventEnvelope {
    event(
        "polar-webhook",
        "billing.customer.state.changed",
        Some(&owner_id().to_hex()),
        payload,
    )
}

fn lifecycle(event_type: &str) -> DomainEventEnvelope {
    event(
        "polar-webhook",
        event_type,
        Some(&owner_id().to_hex()),
        json!({"customerId": CUSTOMER}),
    )
}

#[tokio::test]
async fn unrelated_events_are_ignored_before_any_io() {
    let memory = Memory::with(owner(PlanTier::Free, &[]), premium_state());
    let context = memory.context();
    let ignored = [
        event("twitch-eventsub", "billing.order.paid", Some(&owner_id().to_hex()), json!({})),
        event(
            "polar-webhook",
            "provider.polar.order.refunded",
            Some(&owner_id().to_hex()),
            json!({}),
        ),
    ];
    for envelope in &ignored {
        assert!(!plan_projection::is_polar_plan_event(envelope));
        assert!(!credits_projection::is_polar_credits_event(envelope));
        plan_projection::apply_polar_plan_domain_event(envelope, &context)
            .await
            .expect("ignored");
        credits_projection::apply_polar_credits_domain_event(envelope, &context)
            .await
            .expect("ignored");
    }
    assert_eq!(memory.edit(|state| state.owner_reads), 0);
    assert_eq!(memory.edit(|state| state.plan_updates.len()), 0);

    // A plan lifecycle event is accepted; it is still not a credits event.
    let envelope = lifecycle("billing.subscription.updated");
    assert!(plan_projection::is_polar_plan_event(&envelope));
    assert!(!credits_projection::is_polar_credits_event(&envelope));
    plan_projection::apply_polar_plan_domain_event(&envelope, &context)
        .await
        .expect("projected");
    assert_eq!(memory.edit(|state| state.plan_updates.len()), 1);
}

#[tokio::test]
async fn order_paid_requires_one_of_the_three_plan_products() {
    let memory = Memory::with(owner(PlanTier::Free, &[]), premium_state());
    let context = memory.context();
    plan_projection::apply_polar_plan_domain_event(
        &event(
            "polar-webhook",
            "billing.order.paid",
            Some(&owner_id().to_hex()),
            json!({"productId": "00000000-0000-4000-8000-000000000000", "paid": true}),
        ),
        &context,
    )
    .await
    .expect("ignored");
    assert_eq!(memory.edit(|state| state.owner_reads), 0, "not a plan signal");
    assert_eq!(memory.edit(|state| state.plan_updates.len()), 0);

    for product in [PLAN_PRODUCT_ID_FREE, PLAN_PRODUCT_ID_PREMIUM, PLAN_PRODUCT_ID_PRO] {
        plan_projection::apply_polar_plan_domain_event(
            &event(
                "polar-webhook",
                "billing.order.paid",
                Some(&owner_id().to_hex()),
                json!({"productId": product, "paid": true}),
            ),
            &context,
        )
        .await
        .expect("projected");
    }
    assert_eq!(memory.edit(|state| state.owner_reads), 3);
    assert_eq!(memory.edit(|state| state.plan_updates.len()), 3);
}

#[tokio::test]
async fn ownership_and_pinned_customer_errors_are_typed() {
    let unresolved = event("polar-webhook", "billing.subscription.updated", None, json!({}));
    let memory = Memory::with(owner(PlanTier::Free, &[]), premium_state());
    assert_eq!(
        plan_projection::apply_polar_plan_domain_event(&unresolved, &memory.context())
            .await
            .expect_err("must fail")
            .to_string(),
        format!("Missing prerequisite: {OWNER_MAPPING_UNRESOLVED}")
    );

    let mut pinned = owner(PlanTier::Free, &[]);
    pinned.polar_sh_customer_id = Some("other-customer".into());
    let memory = Memory::with(pinned, premium_state());
    let error =
        plan_projection::apply_polar_plan_domain_event(&lifecycle("billing.subscription.updated"), &memory.context())
            .await
            .expect_err("must fail");
    assert_eq!(error.to_string(), CUSTOMER_MISMATCH);

    let memory = Memory::with(owner(PlanTier::Free, &[]), premium_state());
    memory.edit(|state| state.owner = None);
    let error =
        plan_projection::apply_polar_plan_domain_event(&lifecycle("billing.subscription.updated"), &memory.context())
            .await
            .expect_err("must fail");
    assert_eq!(
        error.to_string(),
        "Missing prerequisite: owner:Polar owner no longer exists"
    );
}

#[tokio::test]
async fn an_identical_fingerprint_skips_the_provider_read() {
    let state = premium_state();
    let mut fixture = owner(PlanTier::Premium, &[]);
    fixture.plan_tier_until = Some(parse_date("2026-10-04T10:00:00Z").expect("date"));
    fixture.polar_plan_event_key = Some("managed".into());
    fixture.polar_plan_entitlement_fingerprint = Some(
        entitlements::polar_entitlement_fingerprint(
            &state.active_subscriptions,
            &state.granted_benefits,
        )
        .expect("fingerprint"),
    );
    let memory = Memory::with(fixture, state);
    plan_projection::apply_polar_plan_domain_event(
        &state_changed(json!({
            "customerId": CUSTOMER,
            "activeSubscriptions": [{
                "id": "subscription-1",
                "productId": PLAN_PRODUCT_ID_PREMIUM,
                "status": "active",
                "currentPeriodEnd": "2026-10-04T10:00:00.000Z"
            }],
            "grantedBenefits": []
        })),
        &memory.context(),
    )
    .await
    .expect("short circuit");
    assert_eq!(memory.edit(|state| state.state_reads), 0);
    assert_eq!(memory.edit(|state| state.plan_updates.len()), 0);
}

#[tokio::test]
async fn a_meter_only_snapshot_cannot_downgrade_a_legacy_paid_tier() {
    let memory = Memory::with(owner(PlanTier::Premium, &[]), free_state());
    plan_projection::apply_polar_plan_domain_event(
        &state_changed(json!({"customerId": CUSTOMER, "meters": []})),
        &memory.context(),
    )
    .await
    .expect("guarded");
    assert_eq!(memory.edit(|state| state.state_reads), 1);
    assert_eq!(memory.edit(|state| state.plan_updates.len()), 0);

    // A real lifecycle event still reconciles that tier.
    plan_projection::apply_polar_plan_domain_event(
        &lifecycle("provider.polar.subscription.revoked"),
        &memory.context(),
    )
    .await
    .expect("reconciled");
    assert_eq!(memory.edit(|state| state.plan_updates.len()), 1);
}

#[tokio::test]
async fn the_plan_filter_encodes_the_ordering_fence() {
    let memory = Memory::with(owner(PlanTier::Free, &["twitch-owner"]), premium_state());
    plan_projection::apply_polar_plan_domain_event(
        &lifecycle("billing.subscription.updated"),
        &memory.context(),
    )
    .await
    .expect("projected");
    let (filter, update) = memory
        .edit(|state| state.plan_updates.first().expect("one update").clone());
    assert_eq!(filter.get_object_id("_id").expect("owner id"), owner_id());
    assert_eq!(
        filter.get("polar_sh_customer_id"),
        Some(&Bson::String(CUSTOMER.into()))
    );
    let branches = filter.get_array("$or").expect("$or");
    assert_eq!(branches.len(), 3);
    assert_eq!(
        branches[0],
        Bson::Document(doc! {"polar_plan_event_at": doc! {"$exists": false}})
    );
    assert_eq!(
        branches[1],
        Bson::Document(doc! {
            "polar_plan_event_at": doc! {"$lt": DateTime::from_millis(OBSERVED)}
        })
    );
    assert_eq!(
        branches[2],
        Bson::Document(doc! {
            "polar_plan_event_at": DateTime::from_millis(OBSERVED),
            "polar_plan_event_key": doc! {"$lte": EVENT_KEY}
        })
    );
    let set = update.get_document("$set").expect("$set");
    assert_eq!(set.get_str("plan_tier").expect("tier"), "premium");
    assert_eq!(set.get_str("polar_plan_event_key").expect("key"), EVENT_KEY);
    assert!(set.get_bool("polar_plan_effects_pending").expect("pending"));
}

#[tokio::test]
async fn a_lost_cas_with_divergent_state_demands_fresh_retry() {
    let mut newer = owner(PlanTier::Premium, &[]);
    newer.plan_tier_until = Some(parse_date("2026-12-01T10:00:00Z").expect("date"));
    let memory = Memory::with(owner(PlanTier::Free, &["twitch-owner"]), premium_state());
    memory.edit(|state| {
        state.lost_race = true;
        state.current_owner = Some(newer);
    });
    let error =
        plan_projection::apply_polar_plan_domain_event(&lifecycle("billing.subscription.updated"), &memory.context())
            .await
            .expect_err("must fail");
    assert_eq!(error.to_string(), LOST_RACE);

    // A vanished owner, or a changed customer link, is the prerequisite error.
    memory.edit(|state| state.current_owner = None);
    let error =
        plan_projection::apply_polar_plan_domain_event(&lifecycle("billing.subscription.updated"), &memory.context())
            .await
            .expect_err("must fail");
    assert_eq!(error.to_string(), format!("Missing prerequisite: {OWNER_CHANGED}"));

    let mut changed = owner(PlanTier::Premium, &[]);
    changed.polar_sh_customer_id = Some("changed-customer".into());
    memory.edit(|state| state.current_owner = Some(changed));
    let error =
        plan_projection::apply_polar_plan_domain_event(&lifecycle("billing.subscription.updated"), &memory.context())
            .await
            .expect_err("must fail");
    assert_eq!(error.to_string(), format!("Missing prerequisite: {OWNER_CHANGED}"));
}

#[tokio::test]
async fn the_pending_bit_survives_a_failed_effect_and_clears_afterwards() {
    let memory = Memory::with(owner(PlanTier::Free, &["twitch-owner"]), premium_state());
    memory.edit(|state| state.fail_retention = true);
    let envelope = state_changed(json!({"customerId": CUSTOMER, "meters": []}));
    let error = plan_projection::apply_polar_plan_domain_event(&envelope, &memory.context())
        .await
        .expect_err("retention must fail");
    assert!(error.to_string().contains("retention fixture failure"));
    assert_eq!(memory.edit(|state| state.plan_updates.len()), 1);
    assert_eq!(memory.edit(|state| state.unsets.len()), 0, "pending retained");
    assert_eq!(memory.edit(|state| state.invalidations.len()), 0);

    memory.edit(|state| state.fail_retention = false);
    plan_projection::apply_polar_plan_domain_event(&envelope, &memory.context())
        .await
        .expect("retried");
    assert_eq!(memory.edit(|state| state.plan_updates.len()), 2);
    let retention = memory.edit(|state| state.retention.clone());
    assert_eq!(retention.len(), 1);
    assert_eq!(retention[0].0, vec!["twitch-owner".to_owned()]);
    assert_eq!(retention[0].1, "premium");
    let unsets = memory.edit(|state| state.unsets.clone());
    assert_eq!(unsets.len(), 1);
    assert_eq!(unsets[0].1, EVENT_KEY);
    let invalidations = memory.edit(|state| state.invalidations.clone());
    assert_eq!(invalidations.len(), 1);
    assert_eq!(invalidations[0].0, "twitch-owner");
    assert_eq!(
        invalidations[0].1,
        format!("{OBSERVED}:{EVENT_KEY}"),
        "the plan fence version is padded millis plus the event key"
    );
    assert_eq!(
        invalidations[0].2,
        dima_rust::utils::billing::credit_pack_billing_context_cache_key(CUSTOMER)
    );
}

#[tokio::test]
async fn an_owner_without_twitch_accounts_deletes_the_pack_context() {
    let memory = Memory::with(owner(PlanTier::Free, &[]), premium_state());
    plan_projection::apply_polar_plan_domain_event(
        &lifecycle("billing.subscription.updated"),
        &memory.context(),
    )
    .await
    .expect("projected");
    assert_eq!(memory.edit(|state| state.invalidations.len()), 0);
    assert_eq!(memory.edit(|state| state.retention.len()), 0);
    assert_eq!(
        memory.edit(|state| state.deleted.clone()),
        vec![dima_rust::utils::billing::credit_pack_billing_context_cache_key(CUSTOMER)]
    );
    assert_eq!(memory.edit(|state| state.unsets.len()), 1);
}

#[tokio::test]
async fn reconciliation_is_a_dry_run_unless_execute_is_set() {
    let memory = Memory::with(owner(PlanTier::Free, &["twitch-owner"]), premium_state());
    let input = plan_projection::ReconcileInput {
        owner_user_id: owner_id().to_hex(),
        customer_id: CUSTOMER.into(),
        execute: false,
    };
    let outcome = plan_projection::reconcile_polar_plan_entitlement(&input, &memory.context())
        .await
        .expect("dry run");
    assert!(!outcome.executed);
    assert!(!outcome.applied);
    assert_eq!(plan_tier_name(outcome.proposed.plan_tier), "premium");
    assert_eq!(plan_tier_name(outcome.before.plan_tier), "free");
    assert_eq!(memory.edit(|state| state.plan_updates.len()), 0);
    assert_eq!(memory.edit(|state| state.invalidations.len()), 0);

    let outcome = plan_projection::reconcile_polar_plan_entitlement(
        &plan_projection::ReconcileInput {
            execute: true,
            ..input
        },
        &memory.context(),
    )
    .await
    .expect("executed");
    assert!(outcome.executed && outcome.applied);
    assert_eq!(memory.edit(|state| state.plan_updates.len()), 1);
    // The synthetic receipt, not a webhook key, fences the reconciliation write.
    let key = memory.edit(|state| {
        state.plan_updates[0]
            .1
            .get_document("$set")
            .expect("$set")
            .get_str("polar_plan_event_key")
            .expect("key")
            .to_owned()
    });
    assert!(key.starts_with("plan-reconciliation:"), "{key}");
}

#[tokio::test]
async fn reconciliation_rejects_imprecise_or_mismatched_ids() {
    let memory = Memory::with(owner(PlanTier::Free, &[]), premium_state());
    let error = plan_projection::reconcile_polar_plan_entitlement(
        &plan_projection::ReconcileInput {
            owner_user_id: String::new(),
            customer_id: String::new(),
            execute: false,
        },
        &memory.context(),
    )
    .await
    .expect_err("must fail");
    assert_eq!(
        error.to_string(),
        "Reconciliation requires explicit ownerUserId and customerId"
    );
    let error = plan_projection::reconcile_polar_plan_entitlement(
        &plan_projection::ReconcileInput {
            owner_user_id: owner_id().to_hex(),
            customer_id: "wrong-customer".into(),
            execute: true,
        },
        &memory.context(),
    )
    .await
    .expect_err("must fail");
    assert_eq!(
        error.to_string(),
        "Reconciliation owner/customer link mismatch"
    );
    assert_eq!(memory.edit(|state| state.state_reads), 0);
    assert_eq!(memory.edit(|state| state.plan_updates.len()), 0);
}

fn credit_record(
    plan: PlanTier,
    accounts: &[&str],
    meters: Vec<Document>,
) -> PolarCreditSnapshotRecord {
    PolarCreditSnapshotRecord {
        owner_id: owner_id(),
        plan_tier: plan,
        polar_plan_event_at: None,
        polar_plan_event_key: None,
        twitch_account_ids: accounts.iter().map(|id| (*id).to_owned()).collect(),
        snapshot: Some(PolarCreditSnapshot {
            occurred_at: parse_date(OCCURRED_AT).expect("date"),
            event_key: EVENT_KEY.into(),
            meters,
        }),
    }
}

#[tokio::test]
async fn a_missing_meters_array_rejects_before_ownership() {
    let memory = Memory::with(owner(PlanTier::Free, &[]), premium_state());
    let error = credits_projection::apply_polar_credits_domain_event(
        &state_changed(json!({"customerId": CUSTOMER})),
        &memory.context(),
    )
    .await
    .expect_err("must fail");
    assert_eq!(error.to_string(), MISSING_METERS);
    assert_eq!(memory.edit(|state| state.owner_reads), 0);
    assert_eq!(memory.edit(|state| state.credit_updates.len()), 0);
}

#[tokio::test]
async fn credits_publish_the_snapshot_version_and_plan_version() {
    let memory = Memory::with(owner(PlanTier::Free, &[]), premium_state());
    let meters = vec![doc! {
        "meter_id": AI_CREDITS_METER_ID,
        "consumed_units": 30.0,
        "balance": -30.0,
    }];
    memory.edit(|state| {
        state.credit_record = Some(credit_record(PlanTier::Premium, &["twitch-owner"], meters));
    });
    credits_projection::apply_polar_credits_domain_event(
        &state_changed(json!({
            "customerId": CUSTOMER,
            "meters": [{
                "meter_id": AI_CREDITS_METER_ID,
                "consumed_units": 30.0,
                "balance": -30.0
            }]
        })),
        &memory.context(),
    )
    .await
    .expect("published");
    let (filter, update) = memory.edit(|state| state.credit_updates[0].clone());
    let branches = filter.get_array("$or").expect("$or");
    assert_eq!(
        branches[0],
        Bson::Document(doc! {"polar_credit_snapshot.occurredAt": doc! {"$exists": false}})
    );
    let occurred_at = parse_date(OCCURRED_AT).expect("date");
    assert_eq!(
        branches[2],
        Bson::Document(doc! {
            "polar_credit_snapshot.occurredAt": DateTime::from_millis(occurred_at),
            "polar_credit_snapshot.eventKey": doc! {"$lte": EVENT_KEY}
        })
    );
    assert!(
        update
            .get_document("$set")
            .expect("$set")
            .contains_key("polar_credit_snapshot")
    );

    let syncs = memory.edit(|state| state.syncs.clone());
    assert_eq!(syncs.len(), 1);
    let sync = &syncs[0];
    assert_eq!(sync.channel_id, "twitch-owner");
    assert_eq!(
        sync.snapshot_version,
        format!("{occurred_at:0>13}:{EVENT_KEY}")
    );
    let payload: Value =
        serde_json::from_str(sync.raw_payload.as_deref().expect("payload")).expect("json");
    assert_eq!(payload["version"], json!(3));
    assert_eq!(payload["used"], json!(30.0));
    assert_eq!(payload["limit"], json!(200_000.0));
    assert_eq!(payload["status"], json!("available"));
    assert_eq!(payload["meterId"], json!(AI_CREDITS_METER_ID));
    assert!(payload.get("__polar_plan_version").is_none());
    assert_eq!(sync.exhaustion, Exhaustion::Available);
    assert_eq!(sync.ttl, TtlSeconds::new(300).expect("ttl"));
    assert_eq!(sync.plan_version, "");
}

#[tokio::test]
async fn an_owner_without_twitch_accounts_publishes_nothing() {
    let memory = Memory::with(owner(PlanTier::Free, &[]), premium_state());
    memory.edit(|state| {
        state.credit_record = Some(credit_record(
            PlanTier::Free,
            &[],
            vec![doc! {"meter_id": AI_CREDITS_METER_ID, "balance": -1.0}],
        ));
    });
    credits_projection::apply_polar_credits_domain_event(
        &state_changed(json!({"customerId": CUSTOMER, "meters": []})),
        &memory.context(),
    )
    .await
    .expect("no accounts");
    assert_eq!(memory.edit(|state| state.credit_updates.len()), 1);
    assert_eq!(memory.edit(|state| state.syncs.len()), 0);
}

#[tokio::test]
async fn the_legacy_meter_supplies_exhaustion_without_inventing_credits() {
    for (balance, expected_flag) in [
        (Some(-2.0), Exhaustion::Exhausted),
        (Some(0.0), Exhaustion::Exhausted),
        (Some(12.0), Exhaustion::Available),
        (None, Exhaustion::Keep),
    ] {
        let memory = Memory::with(owner(PlanTier::Free, &[]), premium_state());
        let mut meter = doc! {"meter_id": credits_projection::LEGACY_USAGE_METER_ID};
        if let Some(balance) = balance {
            meter.insert("balance", balance);
        }
        memory.edit(|state| {
            state.credit_record =
                Some(credit_record(PlanTier::Free, &["twitch-owner"], vec![meter]));
        });
        credits_projection::apply_polar_credits_domain_event(
            &state_changed(json!({"customerId": CUSTOMER, "meters": []})),
            &memory.context(),
        )
        .await
        .expect("published");
        let syncs = memory.edit(|state| state.syncs.clone());
        let sync = syncs.first().expect("sync");
        assert_eq!(sync.raw_payload, None, "no credits are invented");
        assert_eq!(sync.exhaustion, expected_flag);
    }
}

#[tokio::test]
async fn a_missing_persisted_snapshot_is_a_prerequisite_error() {
    let memory = Memory::with(owner(PlanTier::Free, &["twitch-owner"]), premium_state());
    let error = credits_projection::apply_polar_credits_domain_event(
        &state_changed(json!({"customerId": CUSTOMER, "meters": []})),
        &memory.context(),
    )
    .await
    .expect_err("must fail");
    assert_eq!(
        error.to_string(),
        format!(
            "Missing prerequisite: {}",
            polar_billing::SNAPSHOT_NOT_PERSISTED
        )
    );

    memory.edit(|state| {
        state.credit_record = Some(PolarCreditSnapshotRecord {
            owner_id: owner_id(),
            plan_tier: PlanTier::Free,
            polar_plan_event_at: None,
            polar_plan_event_key: None,
            twitch_account_ids: vec!["twitch-owner".into()],
            snapshot: None,
        });
    });
    let error = credits_projection::apply_polar_credits_domain_event(
        &state_changed(json!({"customerId": CUSTOMER, "meters": []})),
        &memory.context(),
    )
    .await
    .expect_err("must fail");
    assert_eq!(error.to_string(), polar_billing::SNAPSHOT_MISSING);
}

#[test]
fn the_padded_version_string_keeps_the_source_padding() {
    assert_eq!(
        credits_projection::snapshot_version(1_788_000_000_000, "polar-webhook:delivery-1"),
        "1788000000000:polar-webhook:delivery-1"
    );
    // padStart(13, '0') pads before the minus sign, exactly like String(ms).
    assert_eq!(
        credits_projection::snapshot_version(-123, "key"),
        "000000000-123:key"
    );
}

#[tokio::test]
async fn the_reward_and_gift_seams_keep_the_source_filters() {
    struct Rewards(Mutex<Vec<polar_billing::PaidOrderRewardInput>>);
    impl polar_billing::PolarRewardApplier for Rewards {
        fn apply_paid_order_reward<'a>(
            &'a self,
            input: &'a polar_billing::PaidOrderRewardInput,
        ) -> BillingFuture<'a, ()> {
            Box::pin(async move {
                self.0.lock().expect("rewards").push(input.clone());
                Ok(())
            })
        }
    }
    struct Gifts(Mutex<Vec<String>>);
    impl polar_billing::PolarGiftAcceptor for Gifts {
        fn accept_credit_gift_paid_order<'a>(
            &'a self,
            order_id: &'a str,
        ) -> BillingFuture<'a, ()> {
            Box::pin(async move {
                self.0.lock().expect("gifts").push(order_id.to_owned());
                Ok(())
            })
        }
    }
    let memory = Memory::with(owner(PlanTier::Free, &[]), premium_state());
    let rewards = Rewards(Mutex::new(Vec::new()));
    let gifts = Gifts(Mutex::new(Vec::new()));

    polar_billing::apply_polar_reward_domain_event(
        &event(
            "polar-webhook",
            "billing.order.paid",
            Some(&owner_id().to_hex()),
            json!({
                "paid": true, "orderId": "order-1", "subscriptionId": "sub-1",
                "totalAmount": 600, "productId": PLAN_PRODUCT_ID_PREMIUM, "cadence": "monthly"
            }),
        ),
        &memory,
        None,
        &rewards,
    )
    .await
    .expect("reward");
    let applied = rewards.0.lock().expect("rewards").clone();
    assert_eq!(
        applied,
        vec![polar_billing::PaidOrderRewardInput {
            owner_user_id: owner_id().to_hex(),
            order_id: "order-1".into(),
            product_id: PLAN_PRODUCT_ID_PREMIUM.into(),
            cadence: "monthly".into(),
        }]
    );

    // A $0 trial start, a one-time order, and a non-plan product earn nothing.
    for payload in [
        json!({"paid": true, "orderId": "o", "subscriptionId": "s", "totalAmount": 0, "productId": PLAN_PRODUCT_ID_PREMIUM, "cadence": "monthly"}),
        json!({"paid": true, "orderId": "o", "totalAmount": 600, "productId": PLAN_PRODUCT_ID_PREMIUM, "cadence": "monthly"}),
        json!({"paid": true, "orderId": "o", "subscriptionId": "s", "totalAmount": 600, "productId": PLAN_PRODUCT_ID_FREE, "cadence": "monthly"}),
        json!({"paid": false, "orderId": "o", "subscriptionId": "s", "totalAmount": 600, "productId": PLAN_PRODUCT_ID_PREMIUM, "cadence": "monthly"}),
    ] {
        polar_billing::apply_polar_reward_domain_event(
            &event(
                "polar-webhook",
                "billing.order.paid",
                Some(&owner_id().to_hex()),
                payload,
            ),
            &memory,
            None,
            &rewards,
        )
        .await
        .expect("no reward");
    }
    assert_eq!(rewards.0.lock().expect("rewards").len(), 1);

    // A gift product order reaches the gift seam; an unknown product does not.
    for (product, expected) in [(GIFT_PACK_PAIRS[0].product_id, 1), ("unknown", 1)] {
        polar_billing::apply_credit_gift_domain_event(
            &event(
                "polar-webhook",
                "billing.order.paid",
                None,
                json!({"paid": true, "orderId": "order-9", "productId": product}),
            ),
            &gifts,
        )
        .await
        .expect("gift filter");
        assert_eq!(gifts.0.lock().expect("gifts").len(), expected);
    }
    assert_eq!(
        gifts.0.lock().expect("gifts").clone(),
        vec!["order-9".to_owned()]
    );
}

// ---------------------------------------------------------------------------
// Actual-source oracle. A missing, empty, or invalid golden file is a HARD
// FAILURE: ordinary tests may run without an oracle, but this one may not.
// ---------------------------------------------------------------------------

/// Resolves the oracle's `{$f64}`, `{$array}` and `{$object}` encodings.
fn decode(value: &Value) -> Value {
    let Some(object) = value.as_object() else {
        return value.clone();
    };
    if object.get("$undefined") == Some(&Value::Bool(true)) {
        return Value::Null;
    }
    if let Some(bits) = object.get("$f64").and_then(Value::as_str) {
        let raw = u64::from_str_radix(bits, 16).expect("binary64 bits");
        return serde_json::Number::from_f64(f64::from_bits(raw))
            .map(Value::Number)
            .unwrap_or(Value::Null);
    }
    if let Some(items) = object.get("$array").and_then(Value::as_array) {
        return Value::Array(items.iter().map(decode).collect());
    }
    if let Some(items) = object.get("$object").and_then(Value::as_array) {
        let mut map = serde_json::Map::new();
        for pair in items {
            let pair = pair.as_array().expect("object entry");
            map.insert(
                pair[0].as_str().expect("object key").to_owned(),
                decode(&pair[1]),
            );
        }
        return Value::Object(map);
    }
    value.clone()
}

fn oracle() -> Value {
    let dir = std::env::var("DIMA_POLAR_BILLING_REFERENCE_DIR").unwrap_or_else(|_| {
        panic!(
            "DIMA_POLAR_BILLING_REFERENCE_DIR must name the generated reference directory; \
             generate it with `node tests/fixtures/polar_billing_events_reference.cjs --write DIR` \
             under the pinned Node image"
        )
    });
    let path = std::path::Path::new(&dir).join("polar_billing_events_reference.json");
    let raw = std::fs::read_to_string(&path).unwrap_or_else(|error| {
        panic!(
            "cannot read the actual-source oracle at {} (supplied by \
             DIMA_POLAR_BILLING_REFERENCE_DIR): {error}",
            path.display()
        )
    });
    assert!(
        !raw.trim().is_empty(),
        "the actual-source oracle at {} is empty",
        path.display()
    );
    serde_json::from_str(&raw).unwrap_or_else(|error| {
        panic!(
            "the actual-source oracle at {} is not valid JSON: {error}",
            path.display()
        )
    })
}

fn oracle_cases<'a>(root: &'a Value, id: &str) -> &'a Value {
    root.get("cases")
        .and_then(Value::as_array)
        .expect("cases")
        .iter()
        .find(|case| case.get("id").and_then(Value::as_str) == Some(id))
        .unwrap_or_else(|| panic!("oracle case {id} is missing"))
}

fn oracle_input<'a>(case: &'a Value, key: &str) -> &'a Value {
    case.get("input")
        .and_then(|input| input.get(key))
        .unwrap_or(&Value::Null)
}

fn millis_at(value: &Value) -> Option<i64> {
    value.as_str().and_then(|value| parse_date(value))
}

fn oracle_owner(input: &Value) -> PolarOwner {
    PolarOwner {
        owner_id: owner_id(),
        plan_tier: tier(
            oracle_input(input, "ownerTier")
                .as_str()
                .expect("ownerTier"),
        ),
        plan_tier_until: millis_at(oracle_input(input, "ownerUntil")),
        polar_sh_customer_id: oracle_input(input, "ownerCustomer")
            .as_str()
            .map(str::to_owned),
        polar_plan_event_at: millis_at(oracle_input(input, "ownerEventAt")),
        polar_plan_event_key: oracle_input(input, "ownerEventKey")
            .as_str()
            .map(str::to_owned),
        polar_plan_effects_pending: oracle_input(input, "ownerPending")
            .as_bool()
            .unwrap_or(false),
        polar_plan_entitlement_fingerprint: oracle_input(input, "ownerFingerprint")
            .as_str()
            .map(str::to_owned),
        twitch_account_ids: oracle_input(input, "accounts")
            .as_array()
            .map(|accounts| {
                accounts
                    .iter()
                    .filter_map(|account| account.as_str().map(str::to_owned))
                    .collect()
            })
            .unwrap_or_default(),
    }
}

/// The state that resolves to the oracle's scripted plan.
fn oracle_state(input: &Value) -> PolarEntitlementState {
    let plan = oracle_input(input, "plan");
    let tier_name = plan
        .get("planTier")
        .and_then(Value::as_str)
        .expect("plan.planTier");
    let until = plan.get("until").and_then(Value::as_str);
    PolarEntitlementState {
        id: oracle_input(input, "ownerCustomer")
            .as_str()
            .unwrap_or_default()
            .to_owned(),
        active_subscriptions: match (tier_name, until) {
            ("free", _) => Vec::new(),
            ("premium", Some(until)) => vec![subscription(
                "sub-1",
                PLAN_PRODUCT_ID_PREMIUM,
                "active",
                Some(until),
            )],
            (other, None) => panic!("unsupported scripted plan {other} without an expiry"),
            (other, Some(_)) => panic!("unsupported scripted plan {other}"),
        },
        granted_benefits: Vec::new(),
    }
}

fn oracle_event(input: &Value) -> DomainEventEnvelope {
    let mut document = serde_json::Map::new();
    document.insert("_id".into(), json!("65e000000000000000000000"));
    document.insert(
        "eventKey".into(),
        oracle_input(input, "eventKey").clone(),
    );
    document.insert("sourceEventId".into(), json!("delivery-1"));
    document.insert("source".into(), json!("polar-webhook"));
    document.insert("type".into(), oracle_input(input, "type").clone());
    document.insert("topic".into(), json!("domain"));
    document.insert("schemaVersion".into(), json!(1));
    document.insert("ownerUserId".into(), json!(owner_id().to_hex()));
    document.insert("subject".into(), oracle_input(input, "subject").clone());
    document.insert("occurredAt".into(), oracle_input(input, "occurredAt").clone());
    document.insert("journaledAt".into(), json!("2026-09-05T10:00:00.000Z"));
    document.insert("expiresAt".into(), json!("2026-10-05T10:00:00.000Z"));
    document.insert("payload".into(), oracle_input(input, "payload").clone());
    document.insert("metadata".into(), oracle_input(input, "metadata").clone());
    DomainEventEnvelope::from_document(&document)
}

fn date_millis(document: &Document, key: &str) -> Option<i64> {
    document
        .get_datetime(key)
        .ok()
        .map(|date| date.timestamp_millis())
}

fn oracle_plan_summary(memory: &Memory, error: Option<String>) -> Value {
    let state = memory.state();
    let (filter, update) = state
        .plan_updates
        .first()
        .cloned()
        .unwrap_or_else(|| (Document::new(), Document::new()));
    let set = update.get_document("$set").cloned().unwrap_or_default();
    let customer = match filter.get("polar_sh_customer_id") {
        Some(Bson::String(value)) => json!(value),
        _ => Value::Null,
    };
    let branches: Vec<Value> = filter
        .get_array("$or")
        .map(|branches| {
            branches
                .iter()
                .map(|branch| {
                    let branch = branch.as_document().cloned().unwrap_or_default();
                    let at = branch
                        .get_document("polar_plan_event_at")
                        .cloned()
                        .unwrap_or_default();
                    json!({
                        "exists": at.get_bool("$exists").ok() == Some(false),
                        "lt": date_millis(&at, "$lt").map_or(Value::Null, |value| json!(value as f64)),
                        "eq": date_millis(&branch, "polar_plan_event_at")
                            .map_or(Value::Null, |value| json!(value as f64)),
                        "keyLte": match branch.get_document("polar_plan_event_key").ok().and_then(|key| key.get_str("$lte").ok()) {
                            Some(value) => json!(value),
                            None => Value::Null,
                        },
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    let invalidation: Vec<Value> = state
        .invalidations
        .iter()
        .map(|(channel, version, billing_key)| {
            let keys: Vec<Value> = polar_billing::plan_cache_effects::invalidation_keys(
                channel,
                billing_key,
            )
            .iter()
            .map(|key| json!(key))
            .collect();
            json!({"keys": keys, "args": [json!(version)]})
        })
        .collect();
    json!({
        "filter": {"customer": customer, "branches": branches},
        "set": {
            "tier": match set.get_str("plan_tier") { Ok(value) => json!(value), Err(_) => Value::Null },
            "until": date_millis(&set, "plan_tier_until").map_or(Value::Null, |value| json!(value as f64)),
            "eventAt": date_millis(&set, "polar_plan_event_at").map_or(Value::Null, |value| json!(value as f64)),
            "eventKey": match set.get_str("polar_plan_event_key") { Ok(value) => json!(value), Err(_) => Value::Null },
            "fingerprint": match set.get_str("polar_plan_entitlement_fingerprint") { Ok(value) => json!(value), Err(_) => Value::Null },
            "pending": set.get_bool("polar_plan_effects_pending").unwrap_or(false),
        },
        "acknowledges": state.unsets.iter().map(|(id, key)| json!({
            "owner": id.to_hex(),
            "key": key,
            "unset": ["polar_plan_effects_pending"],
        })).collect::<Vec<_>>(),
        "invalidation": invalidation,
        "deleted": state.deleted.clone(),
        "retention": state.retention.iter().map(|(ids, tier)| json!({"ids": ids, "tier": tier})).collect::<Vec<_>>(),
        "error": error.map_or(Value::Null, Value::String),
    })
}

fn oracle_credit_summary(memory: &Memory, error: Option<String>) -> Value {
    let state = memory.state();
    let filter = state
        .credit_updates
        .first()
        .map(|(filter, _)| filter.clone())
        .unwrap_or_default();
    let snapshot = state
        .credit_updates
        .first()
        .and_then(|(_, update)| update.get_document("$set").ok())
        .and_then(|set| set.get_document("polar_credit_snapshot").ok())
        .cloned()
        .unwrap_or_default();
    let branches: Vec<Value> = filter
        .get_array("$or")
        .map(|branches| {
            branches
                .iter()
                .map(|branch| {
                    let branch = branch.as_document().cloned().unwrap_or_default();
                    let at = branch
                        .get_document("polar_credit_snapshot.occurredAt")
                        .cloned()
                        .unwrap_or_default();
                    json!({
                        "exists": at.get_bool("$exists").ok() == Some(false),
                        "lt": date_millis(&at, "$lt").map_or(Value::Null, |value| json!(value as f64)),
                        "eq": date_millis(&branch, "polar_credit_snapshot.occurredAt")
                            .map_or(Value::Null, |value| json!(value as f64)),
                        "keyLte": match branch.get_document("polar_credit_snapshot.eventKey").ok().and_then(|key| key.get_str("$lte").ok()) {
                            Some(value) => json!(value),
                            None => Value::Null,
                        },
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    let meters: Vec<Value> = snapshot
        .get_array("meters")
        .map(|meters| {
            meters
                .iter()
                .filter_map(|meter| meter.as_document())
                .filter_map(|meter| meter.get_str("meter_id").ok())
                .map(|id| json!(id))
                .collect()
        })
        .unwrap_or_default();
    let sync: Vec<Value> = state
        .syncs
        .iter()
        .map(|call| {
            let keys: Vec<Value> =
                polar_billing::plan_cache_effects::sync_credits_keys(&call.channel_id)
                    .iter()
                    .map(|key| json!(key))
                    .collect();
            json!({
                "keys": keys,
                "args": [
                    json!(call.snapshot_version),
                    call.raw_payload.clone().map_or(Value::Null, Value::String),
                    match call.exhaustion {
                        Exhaustion::Keep => json!(""),
                        Exhaustion::Exhausted => json!("1"),
                        Exhaustion::Available => json!("0"),
                    },
                    json!(call.ttl.get().to_string()),
                    json!(call.plan_version),
                ],
            })
        })
        .collect();
    json!({
        "filter": {"branches": branches},
        "snapshot": {
            "occurredAt": date_millis(&snapshot, "occurredAt").map_or(Value::Null, |value| json!(value as f64)),
            "eventKey": match snapshot.get_str("eventKey") { Ok(value) => json!(value), Err(_) => Value::Null },
            "meters": meters,
        },
        "sync": sync,
        "error": error.map_or(Value::Null, Value::String),
    })
}

#[tokio::test]
async fn the_actual_source_plan_and_credit_projections_match() {
    let root = oracle();
    let metadata = root.get("metadata").expect("metadata");
    assert_eq!(metadata.get("schema").and_then(Value::as_u64), Some(1));
    assert_eq!(metadata.get("node").and_then(Value::as_str), Some("v24.22.1"));
    assert_eq!(
        metadata.get("v8").and_then(Value::as_str),
        Some("13.6.233.17-node.58")
    );
    assert_eq!(
        metadata.get("typescript").and_then(Value::as_str),
        Some("5.9.3")
    );
    assert!(
        metadata
            .get("typeDiagnostics")
            .and_then(Value::as_array)
            .expect("typeDiagnostics")
            .is_empty()
    );
    let hashes = metadata.get("hashes").expect("hashes");
    let base = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    for (key, file, pin) in [
        (
            "events",
            "src/domain_events/polar_billing_events.ts",
            "bf134b805840bfee44b94f861736976dc6739ac535e75c6bf2203ae11a54948d",
        ),
        (
            "entitlements",
            "src/domain_events/polar_entitlements.ts",
            "681d065391cdb2853959b52074476d5406e321c51cfa640d72d0c2e057795b81",
        ),
        (
            "billing",
            "src/utils/billing.ts",
            "a14d58f094e58dbb34ff5191cbb09b792759187adaca862413873fa83c780c0d",
        ),
        (
            "package",
            "package.json",
            "cc4939f6416a91d4bfaa5bcdd3d448d2f74103a88bb269e0a8e393615cf32cef",
        ),
        (
            "lock",
            "package-lock.json",
            "abdf5aa71a8272423ebb9358d7aaa87edd7e65f6605c325fe231a4bcef70eeb7",
        ),
    ] {
        assert_eq!(hashes.get(key).and_then(Value::as_str), Some(pin), "{key}");
        assert_eq!(
            format!(
                "{:x}",
                sha2::Sha256::digest(std::fs::read(base.join(file)).unwrap())
            ),
            pin,
            "{key}"
        );
    }
    let constants = metadata.get("constants").expect("constants");
    assert_eq!(
        constants.get("meterId").and_then(Value::as_str),
        Some(AI_CREDITS_METER_ID)
    );
    assert_eq!(
        constants.get("legacyMeterId").and_then(Value::as_str),
        Some(credits_projection::LEGACY_USAGE_METER_ID)
    );
    assert_eq!(
        constants.get("versionField").and_then(Value::as_str),
        Some(dima_rust::utils::plan_cache_fence::PLAN_CACHE_VERSION_FIELD)
    );
    assert_eq!(
        constants.get("productIds").and_then(|ids| ids.get("PREMIUM")).and_then(Value::as_str),
        Some(PLAN_PRODUCT_ID_PREMIUM)
    );
    let event_types = decode(constants.get("planEventTypes").expect("planEventTypes"));
    let event_types = event_types.as_array().expect("event types");
    let mut expected = entitlements::POLAR_PLAN_EVENT_TYPES.to_vec();
    assert_eq!(event_types.len(), expected.len());
    for (actual, native) in event_types.iter().zip(expected.drain(..)) {
        assert_eq!(actual.as_str(), Some(native));
    }

    for id in [
        "plan-projection",
        "plan-no-twitch",
        "plan-legacy-guard",
        "plan-lost-race",
    ] {
        let case = oracle_cases(&root, id);
        let input = case.get("input").expect("input");
        let memory = Memory::with(oracle_owner(input), oracle_state(input));
        let now = oracle_input(input, "now").as_f64().expect("now") as i64;
        let context = PolarBillingContext {
            now_millis: now,
            ..memory.context()
        };
        if oracle_input(input, "afterUpdate").as_bool() == Some(false) {
            let after_find = oracle_input(input, "afterFind");
            memory.edit(|state| {
                state.lost_race = true;
                state.current_owner = Some(oracle_owner(&json!({
                    "ownerTier": after_find.get("ownerTier").cloned().unwrap_or(Value::Null),
                    "ownerUntil": after_find.get("ownerUntil").cloned().unwrap_or(Value::Null),
                    "ownerCustomer": oracle_input(input, "ownerCustomer").clone(),
                    "accounts": [],
                })));
            });
        }
        let error = plan_projection::apply_polar_plan_domain_event(
            &oracle_event(input),
            &context,
        )
        .await
        .err()
        .map(|error| error.to_string());
        let actual = oracle_plan_summary(&memory, error);
        assert_eq!(actual, decode(case.get("expected").expect("expected")), "{id}");
    }

    for id in ["credits-publish", "credits-legacy-meter"] {
        let case = oracle_cases(&root, id);
        let input = case.get("input").expect("input");
        let memory = Memory::with(oracle_owner(input), oracle_state(input));
        let occurred_at = millis_at(oracle_input(input, "occurredAt")).expect("occurredAt");
        let meters: Vec<Document> = oracle_input(input, "payload")
            .get("meters")
            .and_then(Value::as_array)
            .expect("meters")
            .iter()
            .map(|meter| mongodb::bson::serialize_to_document(meter).expect("meter"))
            .collect();
        memory.edit(|state| {
            state.credit_record = Some(PolarCreditSnapshotRecord {
                owner_id: owner_id(),
                plan_tier: tier(
                    oracle_input(input, "ownerTier")
                        .as_str()
                        .expect("ownerTier"),
                ),
                polar_plan_event_at: millis_at(oracle_input(input, "ownerEventAt")),
                polar_plan_event_key: oracle_input(input, "ownerEventKey")
                    .as_str()
                    .map(str::to_owned),
                twitch_account_ids: oracle_owner(input).twitch_account_ids,
                snapshot: Some(PolarCreditSnapshot {
                    occurred_at,
                    event_key: oracle_input(input, "eventKey")
                        .as_str()
                        .expect("eventKey")
                        .to_owned(),
                    meters,
                }),
            });
        });
        let error = credits_projection::apply_polar_credits_domain_event(
            &oracle_event(input),
            &memory.context(),
        )
        .await
        .err()
        .map(|error| error.to_string());
        let actual = oracle_credit_summary(&memory, error);
        assert_eq!(actual, decode(case.get("expected").expect("expected")), "{id}");
    }

    let case = oracle_cases(&root, "plan-reconcile-dry-run");
    let input = case.get("input").expect("input");
    let memory = Memory::with(oracle_owner(input), oracle_state(input));
    let outcome = plan_projection::reconcile_polar_plan_entitlement(
        &plan_projection::ReconcileInput {
            owner_user_id: oracle_input(input, "ownerUserId")
                .as_str()
                .expect("ownerUserId")
                .to_owned(),
            customer_id: oracle_input(input, "ownerCustomer")
                .as_str()
                .expect("ownerCustomer")
                .to_owned(),
            execute: oracle_input(input, "execute").as_bool().unwrap_or(false),
        },
        &memory.context(),
    )
    .await
    .expect("dry run");
    let expected = decode(case.get("expected").expect("expected"));
    assert_eq!(outcome.executed, expected["executed"].as_bool().unwrap());
    assert_eq!(outcome.applied, expected["applied"].as_bool().unwrap());
    assert_eq!(
        plan_tier_name(outcome.proposed.plan_tier),
        expected["proposed"]["tier"].as_str().unwrap()
    );
    assert_eq!(
        plan_tier_name(outcome.before.plan_tier),
        expected["before"]["tier"].as_str().unwrap()
    );
    assert_eq!(
        memory.edit(|state| state.plan_updates.len()) as f64,
        expected["updates"].as_f64().unwrap()
    );
}
