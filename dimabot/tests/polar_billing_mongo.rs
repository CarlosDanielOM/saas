#![cfg(feature = "polar-billing-events")]

//! Guarded private-Mongo coverage for the concrete Polar billing adapters:
//! `MongoPolarBillingStore`, `MongoPolarOwnerResolver`, and the plan/credits
//! projections' real `findOneAndUpdate` documents.
//!
//! Fixture contract (matching `tests/mongo_connection.rs`):
//!
//! ```sh
//! MONGO_TEST_EXPECT=billing \
//! MONGO_URI='mongodb://127.0.0.1:27017/?' \
//! DIMA_POLAR_BILLING_MONGO_DB='billing-fixture-<unique>' \
//!   cargo test --locked --test polar_billing_mongo -- --ignored \
//!     --exact polar_billing_mongo_fixture
//! ```
//!
//! The database name is required, must start with `billing-fixture-`, and is
//! dropped at the end. A missing expectation, URI, or namespace fails; nothing is
//! silently skipped inside the fixture test.

use dima_rust::domain_event_contracts::polar_billing::{
    BillingFuture, PolarBillingContext, PolarBillingEffects, PolarCreditSnapshotRecord,
    PolarOwner, credits_projection, mongo_owner::MongoPolarOwnerResolver,
    mongo_store::{MongoPolarBillingStore, default_projection},
    plan_cache_effects, plan_projection,
};
use dima_rust::domain_event_contracts::polar_billing::entitlements::{
    PolarCustomerStateSource, PolarEntitlementGrant, PolarEntitlementState,
    PolarEntitlementSubscription, PolarGraceLookup, PolarGraceSubscription,
};
use dima_rust::domain_event_contracts::DomainEventEnvelope;
use dima_rust::utils::ai_credit_projection::{AI_CREDITS_METER_ID, PlanTier};
use dima_rust::utils::billing::{PLAN_PRODUCT_ID_PREMIUM, credit_pack_billing_context_cache_key};
use dima_rust::utils::js_date::parse_date;
use dima_rust::utils::plan_cache_fence::{Exhaustion, TtlSeconds};
use mongodb::{
    Client, Database,
    bson::{Bson, Document, doc, oid::ObjectId},
};
use serde_json::json;
use std::sync::{
    Mutex,
    atomic::{AtomicBool, Ordering},
};

use dima_rust::schemas::users;

const EXPECT_ENV: &str = "MONGO_TEST_EXPECT";
const URI_ENV: &str = "MONGO_URI";
const DB_ENV: &str = "DIMA_POLAR_BILLING_MONGO_DB";
const DB_PREFIX: &str = "billing-fixture-";
const CUSTOMER: &str = "cust-1";
const EVENT_KEY: &str = "polar-webhook:delivery-1";
const OCCURRED_AT: &str = "2026-09-04T10:00:00Z";
const OBSERVED: i64 = 1_788_000_000_000;

fn fixture_owner_id() -> ObjectId {
    ObjectId::parse_str("0123456789abcdef01234567").expect("owner id")
}

async fn fixture_database() -> Database {
    let mode = std::env::var(EXPECT_ENV).unwrap_or_else(|_| {
        panic!("{EXPECT_ENV} must be set (use `billing`) against an isolated MongoDB fixture")
    });
    assert_eq!(mode, "billing", "{EXPECT_ENV} must be `billing`");
    let uri = std::env::var(URI_ENV)
        .unwrap_or_else(|_| panic!("{URI_ENV} must name a disposable MongoDB fixture"));
    let namespace = std::env::var(DB_ENV).unwrap_or_else(|_| {
        panic!("{DB_ENV} must name a unique task-owned database starting with `{DB_PREFIX}`")
    });
    assert!(
        namespace.starts_with(DB_PREFIX) && namespace.len() <= 64,
        "{DB_ENV} must be task-owned"
    );
    assert!(
        namespace
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-'),
        "{DB_ENV} must be a simple identifier"
    );
    let client = Client::with_uri_str(&uri).await.expect("MongoDB client");
    let database = client.database(&namespace);
    // Start from a clean task-owned database.
    database.drop().await.expect("drop fixture database");
    database
}

fn subscription(product_id: &str, status: &str, end: &str) -> PolarEntitlementSubscription {
    PolarEntitlementSubscription {
        id: "sub-1".into(),
        product_id: product_id.into(),
        status: status.into(),
        current_period_end: Some(dima_rust::domain_event_contracts::polar_billing::entitlements::PolarDate::Millis(
            parse_date(end).expect("date"),
        )),
        ends_at: None,
        trial_start: None,
        trial_end: None,
    }
}

struct FixedEntitlements {
    state: PolarEntitlementState,
}

impl PolarCustomerStateSource for FixedEntitlements {
    fn customer_state<'a>(
        &'a self,
        _customer_id: &'a str,
    ) -> BillingFuture<'a, PolarEntitlementState> {
        let state = self.state.clone();
        Box::pin(async move { Ok(state) })
    }
}

impl PolarGraceLookup for FixedEntitlements {
    fn grace_subscriptions<'a>(
        &'a self,
        _customer_id: &'a str,
        _grants: &'a [PolarEntitlementGrant],
    ) -> BillingFuture<'a, Vec<PolarGraceSubscription>> {
        Box::pin(async move { Ok(Vec::new()) })
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
struct RecordingEffects {
    fail_retention: AtomicBool,
    retention: Mutex<Vec<(Vec<String>, String)>>,
    invalidations: Mutex<Vec<(String, String, String)>>,
    deleted: Mutex<Vec<String>>,
    syncs: Mutex<Vec<SyncCall>>,
}

impl PolarBillingEffects for RecordingEffects {
    fn adjust_usage_retention<'a>(
        &'a self,
        channel_ids: &'a [String],
        plan_tier: PlanTier,
    ) -> BillingFuture<'a, ()> {
        Box::pin(async move {
            if self.fail_retention.load(Ordering::SeqCst) {
                return Err(dima_rust::domain_event_contracts::polar_billing::PolarBillingError::Runtime(
                    "retention fixture failure".into(),
                ));
            }
            self.retention.lock().expect("retention").push((
                channel_ids.to_vec(),
                dima_rust::utils::billing::plan_tier_name(plan_tier).to_owned(),
            ));
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
            self.invalidations.lock().expect("invalidations").push((
                channel_id.to_owned(),
                version.to_owned(),
                billing_context_key.to_owned(),
            ));
            Ok(())
        })
    }

    fn delete_cache_key<'a>(&'a self, key: &'a str) -> BillingFuture<'a, ()> {
        Box::pin(async move {
            self.deleted.lock().expect("deleted").push(key.to_owned());
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
            self.syncs.lock().expect("syncs").push(SyncCall {
                channel_id: channel_id.to_owned(),
                snapshot_version: snapshot_version.to_owned(),
                raw_payload: raw_payload.map(str::to_owned),
                exhaustion,
                ttl,
                plan_version: plan_version.to_owned(),
            });
            Ok(())
        })
    }
}

fn event(event_type: &str, payload: serde_json::Value) -> DomainEventEnvelope {
    let mut document = serde_json::Map::new();
    document.insert("_id".into(), json!("65e000000000000000000000"));
    document.insert("eventKey".into(), json!(EVENT_KEY));
    document.insert("sourceEventId".into(), json!("delivery-1"));
    document.insert("source".into(), json!("polar-webhook"));
    document.insert("type".into(), json!(event_type));
    document.insert("topic".into(), json!("domain"));
    document.insert("schemaVersion".into(), json!(1));
    document.insert("ownerUserId".into(), json!(fixture_owner_id().to_hex()));
    document.insert("occurredAt".into(), json!(OCCURRED_AT));
    document.insert("journaledAt".into(), json!("2026-09-05T10:00:00.000Z"));
    document.insert("expiresAt".into(), json!("2026-10-05T10:00:00.000Z"));
    document.insert("payload".into(), payload);
    document.insert("metadata".into(), json!({}));
    DomainEventEnvelope::from_document(&document)
}

async fn insert_owner(database: &Database, id: ObjectId, customer: &str, twitch: &[&str]) {
    let accounts: Vec<Bson> = twitch
        .iter()
        .map(|channel| Bson::Document(doc! {"type": "twitch", "id": *channel}))
        .collect();
    users::schema()
        .native_collection(database)
        .insert_one(doc! {
            "_id": id,
            "name": "Owner",
            "email": "owner@example.com",
            "plan_tier": "free",
            "polar_sh_customer_id": customer,
            "accounts": accounts,
        })
        .await
        .expect("insert fixture owner");
}

async fn read_document(database: &Database, id: ObjectId) -> Document {
    users::schema()
        .native_collection(database)
        .find_one(doc! {"_id": id})
        .await
        .expect("read fixture owner")
        .expect("fixture owner exists")
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires an explicitly provided isolated MongoDB fixture; set MONGO_TEST_EXPECT and MONGO_URI"]
async fn polar_billing_mongo_fixture() {
    let database = fixture_database().await;
    let owner_id = fixture_owner_id();
    insert_owner(&database, owner_id, CUSTOMER, &["chan-1"]).await;

    let store = MongoPolarBillingStore::new(database.clone());
    let premium = FixedEntitlements {
        state: PolarEntitlementState {
            id: CUSTOMER.into(),
            active_subscriptions: vec![subscription(
                PLAN_PRODUCT_ID_PREMIUM,
                "active",
                "2026-10-04T10:00:00Z",
            )],
            granted_benefits: Vec::new(),
        },
    };
    let free = FixedEntitlements {
        state: PolarEntitlementState {
            id: CUSTOMER.into(),
            active_subscriptions: Vec::new(),
            granted_benefits: Vec::new(),
        },
    };
    let effects = RecordingEffects::default();
    let context = PolarBillingContext {
        store: &store,
        effects: &effects,
        entitlements: &premium,
        grace: &premium,
        owner_resolver: None,
        now_millis: OBSERVED,
    };

    // 1. The schema-backed owner read filters Twitch accounts.
    let owner = store.find_owner(owner_id).await.expect("owner").expect("exists");
    assert_eq!(owner.twitch_account_ids, vec!["chan-1".to_owned()]);
    assert_eq!(
        dima_rust::utils::billing::plan_tier_name(owner.plan_tier),
        "free"
    );
    assert_eq!(owner.pinned_customer_id(), Some(CUSTOMER));

    // 2. A successful plan projection writes the source $set, runs every effect,
    //    and clears the pending bit.
    plan_projection::apply_polar_plan_domain_event(
        &event(
            "billing.subscription.updated",
            json!({"customerId": CUSTOMER}),
        ),
        &context,
    )
    .await
    .expect("projected");
    let projected = read_document(&database, owner_id).await;
    assert_eq!(projected.get_str("plan_tier").expect("tier"), "premium");
    assert_eq!(
        projected
            .get_datetime("plan_tier_until")
            .expect("until")
            .timestamp_millis(),
        parse_date("2026-10-04T10:00:00Z").expect("date")
    );
    assert_eq!(
        projected
            .get_str("polar_plan_event_key")
            .expect("key"),
        EVENT_KEY
    );
    assert_eq!(
        projected
            .get_datetime("polar_plan_event_at")
            .expect("at")
            .timestamp_millis(),
        OBSERVED
    );
    assert!(
        projected
            .get_str("polar_plan_entitlement_fingerprint")
            .expect("fingerprint")
            .len()
            == 64
    );
    assert!(
        !projected
            .get_bool("polar_plan_effects_pending")
            .unwrap_or(false),
        "the pending bit is cleared after every effect succeeds"
    );
    let retention = effects.retention.lock().expect("retention").clone();
    assert_eq!(retention, vec![(vec!["chan-1".to_owned()], "premium".to_owned())]);
    let invalidations = effects.invalidations.lock().expect("invalidations").clone();
    assert_eq!(invalidations.len(), 1);
    assert_eq!(invalidations[0].0, "chan-1");
    assert_eq!(invalidations[0].1, format!("{OBSERVED}:{EVENT_KEY}"));
    assert_eq!(
        invalidations[0].2,
        credit_pack_billing_context_cache_key(CUSTOMER)
    );
    // The key set the adapter would send matches the source's five keys.
    assert_eq!(
        plan_cache_effects::invalidation_keys("chan-1", &invalidations[0].2),
        [
            "twitch:chan-1:ai:credits:plan-version".to_owned(),
            "twitch:chan-1:ai:credits".to_owned(),
            "accounts:twitch:chan-1:data".to_owned(),
            "twitch:accounts".to_owned(),
            credit_pack_billing_context_cache_key(CUSTOMER),
        ]
    );

    // 3. A failed effect keeps the pending bit so a retry cannot infer success
    //    from an unchanged tier.
    effects.fail_retention.store(true, Ordering::SeqCst);
    let failing_context = PolarBillingContext {
        store: &store,
        effects: &effects,
        entitlements: &free,
        grace: &free,
        owner_resolver: None,
        now_millis: OBSERVED + 1_000,
    };
    let mut retry_event = event(
        "billing.subscription.updated",
        json!({"customerId": CUSTOMER}),
    );
    let mut fields = retry_event.fields().clone();
    fields.insert("eventKey".into(), json!("polar-webhook:delivery-2"));
    retry_event = DomainEventEnvelope::from_document(&fields);
    plan_projection::apply_polar_plan_domain_event(&retry_event, &failing_context)
        .await
        .expect_err("retention must fail");
    let pending = read_document(&database, owner_id).await;
    assert_eq!(pending.get_str("plan_tier").expect("tier"), "free");
    assert!(
        pending
            .get_bool("polar_plan_effects_pending")
            .expect("pending"),
        "the pending bit survives a failed effect"
    );
    effects.fail_retention.store(false, Ordering::SeqCst);
    plan_projection::apply_polar_plan_domain_event(&retry_event, &failing_context)
        .await
        .expect("retried");
    assert!(
        !read_document(&database, owner_id)
            .await
            .get_bool("polar_plan_effects_pending")
            .unwrap_or(false)
    );

    // 4. An older observation cannot pass the stored watermark, and a divergent
    //    current plan demands a fresh retry.
    let mut stale_event = event(
        "billing.subscription.updated",
        json!({"customerId": CUSTOMER}),
    );
    let mut fields = stale_event.fields().clone();
    fields.insert("eventKey".into(), json!("polar-webhook:delivery-0"));
    stale_event = DomainEventEnvelope::from_document(&fields);
    // The stale proposal is Premium while the stored plan is Free, so the lost
    // CAS is genuinely divergent rather than an unchanged no-op.
    let stale_context = PolarBillingContext {
        entitlements: &premium,
        grace: &premium,
        now_millis: OBSERVED - 1_000,
        ..failing_context
    };
    let error = plan_projection::apply_polar_plan_domain_event(&stale_event, &stale_context)
        .await
        .expect_err("stale projection must lose");
    assert_eq!(
        error.to_string(),
        "Polar plan projection lost ordering race to divergent or unfinished entitlement; retry fresh state"
    );
    assert_eq!(
        read_document(&database, owner_id)
            .await
            .get_str("polar_plan_event_key")
            .expect("key"),
        "polar-webhook:delivery-2"
    );

    // 5. The credit snapshot write needs the `+polar_credit_snapshot` projection,
    //    while the default projection keeps it hidden.
    let meters = json!([{
        "meter_id": AI_CREDITS_METER_ID,
        "consumed_units": 30.0,
        "balance": -30.0
    }]);
    credits_projection::apply_polar_credits_domain_event(
        &event(
            "billing.customer.state.changed",
            json!({"customerId": CUSTOMER, "meters": meters}),
        ),
        &context,
    )
    .await
    .expect("credits projected");
    let record = store
        .credit_find_by_id(owner_id)
        .await
        .expect("snapshot read")
        .expect("record");
    let snapshot = record.snapshot.as_ref().expect("stored snapshot");
    assert_eq!(snapshot.event_key, EVENT_KEY);
    assert_eq!(snapshot.meters.len(), 1);
    assert_eq!(
        snapshot.meters[0].get_str("meter_id").expect("meter"),
        AI_CREDITS_METER_ID
    );
    let hidden = users::schema()
        .native_collection(&database)
        .find_one(doc! {"_id": owner_id})
        .projection(default_projection())
        .await
        .expect("default projection read")
        .expect("owner");
    assert!(
        !hidden.contains_key("polar_credit_snapshot"),
        "the default projection hides the snapshot, as `.lean()` does"
    );
    let syncs = effects.syncs.lock().expect("syncs").clone();
    assert_eq!(syncs.len(), 1);
    assert_eq!(
        syncs[0].snapshot_version,
        format!(
            "{:0>13}:{EVENT_KEY}",
            parse_date(OCCURRED_AT).expect("date")
        )
    );
    assert_eq!(
        plan_cache_effects::sync_credits_keys("chan-1"),
        [
            "twitch:chan-1:ai:credits".to_owned(),
            "twitch:chan-1:ai:exhaust".to_owned(),
            "chan-1:ai:exhaust".to_owned(),
            "twitch:chan-1:ai:credits:polar-version".to_owned(),
            "twitch:chan-1:ai:credits:plan-version".to_owned(),
        ]
    );

    // 6. A stale credit event falls back to the stored snapshot, not its own.
    let mut stale_credits = event(
        "billing.customer.state.changed",
        json!({"customerId": CUSTOMER, "meters": []}),
    );
    let mut fields = stale_credits.fields().clone();
    fields.insert("eventKey".into(), json!("polar-webhook:delivery-0"));
    fields.insert("occurredAt".into(), json!("2026-09-03T10:00:00.000Z"));
    stale_credits = DomainEventEnvelope::from_document(&fields);
    credits_projection::apply_polar_credits_domain_event(&stale_credits, &context)
        .await
        .expect("stale credits fall back");
    let syncs = effects.syncs.lock().expect("syncs").clone();
    assert_eq!(syncs.len(), 2);
    assert_eq!(
        syncs[1].snapshot_version,
        format!(
            "{:0>13}:{EVENT_KEY}",
            parse_date(OCCURRED_AT).expect("date")
        ),
        "the stored snapshot wins over the stale event"
    );

    // 7. `unset_plan_effects_pending` matches the event key, not just the owner.
    users::schema()
        .native_collection(&database)
        .update_one(
            doc! {"_id": owner_id},
            doc! {"$set": {"polar_plan_effects_pending": true}},
        )
        .await
        .expect("set pending");
    store
        .unset_plan_effects_pending(owner_id, "polar-webhook:other")
        .await
        .expect("mismatched ack");
    assert!(
        read_document(&database, owner_id)
            .await
            .get_bool("polar_plan_effects_pending")
            .expect("pending")
    );
    store
        .unset_plan_effects_pending(owner_id, "polar-webhook:delivery-2")
        .await
        .expect("matching ack");
    assert!(
        !read_document(&database, owner_id)
            .await
            .get_bool("polar_plan_effects_pending")
            .unwrap_or(false)
    );

    // 8. Owner resolution: pinned link, external ObjectId, legacy Twitch channel.
    let resolver = MongoPolarOwnerResolver::new(database.clone());
    let linked = resolver
        .resolve_owner(&customer_event(json!({"provider": "polar", "kind": "customer", "id": CUSTOMER}), json!({})))
        .await
        .expect("resolved")
        .expect("owner");
    assert_eq!(linked.owner_id, owner_id);
    assert_eq!(linked.pinned_customer_id(), Some(CUSTOMER));

    let external_id = ObjectId::parse_str("0123456789abcdef01234568").expect("id");
    insert_owner(&database, external_id, "cust-2", &["chan-2"]).await;
    let external = resolver
        .resolve_owner(&customer_event(
            json!({"provider": "polar", "kind": "customer", "id": "cust-2"}),
            json!({"externalCustomerId": external_id.to_hex()}),
        ))
        .await
        .expect("resolved")
        .expect("owner");
    assert_eq!(external.owner_id, external_id);

    let legacy_id = ObjectId::parse_str("0123456789abcdef01234569").expect("id");
    insert_owner(&database, legacy_id, "", &["chan-legacy"]).await;
    let legacy = resolver
        .resolve_owner(&customer_event(
            json!({"provider": "polar", "kind": "customer", "id": "cust-3"}),
            json!({"legacyTwitchChannelId": "chan-legacy"}),
        ))
        .await
        .expect("resolved")
        .expect("owner");
    assert_eq!(legacy.owner_id, legacy_id);

    let missing = resolver
        .resolve_owner(&customer_event(
            json!({"provider": "polar", "kind": "customer", "id": "cust-unmapped"}),
            json!({}),
        ))
        .await
        .expect_err("unmapped customer is a prerequisite failure");
    assert_eq!(
        missing.to_string(),
        "Missing prerequisite: owner:polar customer mapping unresolved"
    );

    // A non-customer subject is not an ownership failure.
    let unrelated = resolver
        .resolve_owner(&customer_event(
            json!({"provider": "twitch", "kind": "streaming-account", "id": "chan-1"}),
            json!({}),
        ))
        .await
        .expect("not an owner event");
    assert!(unrelated.is_none());

    database.drop().await.expect("drop fixture database");
}

fn customer_event(subject: serde_json::Value, metadata: serde_json::Value) -> DomainEventEnvelope {
    let mut document = serde_json::Map::new();
    document.insert("_id".into(), json!("65e000000000000000000000"));
    document.insert("eventKey".into(), json!(EVENT_KEY));
    document.insert("sourceEventId".into(), json!("delivery-1"));
    document.insert("source".into(), json!("polar-webhook"));
    document.insert("type".into(), json!("billing.customer.state.changed"));
    document.insert("topic".into(), json!("domain"));
    document.insert("schemaVersion".into(), json!(1));
    document.insert("subject".into(), subject);
    document.insert("occurredAt".into(), json!(OCCURRED_AT));
    document.insert("journaledAt".into(), json!("2026-09-05T10:00:00.000Z"));
    document.insert("expiresAt".into(), json!("2026-10-05T10:00:00.000Z"));
    document.insert("payload".into(), json!({"customerId": CUSTOMER}));
    document.insert("metadata".into(), metadata);
    DomainEventEnvelope::from_document(&document)
}

/// Pure assertions that need no fixture: the adapter's key builders must equal
/// the source's literal key sets.
#[test]
fn the_effect_key_sets_match_the_source() {
    let context = credit_pack_billing_context_cache_key(CUSTOMER);
    assert_eq!(
        plan_cache_effects::invalidation_keys("chan", &context),
        [
            "twitch:chan:ai:credits:plan-version".to_owned(),
            "twitch:chan:ai:credits".to_owned(),
            "accounts:twitch:chan:data".to_owned(),
            "twitch:accounts".to_owned(),
            context.clone(),
        ]
    );
    assert_eq!(
        plan_cache_effects::sync_credits_keys("chan"),
        [
            "twitch:chan:ai:credits".to_owned(),
            "twitch:chan:ai:exhaust".to_owned(),
            "chan:ai:exhaust".to_owned(),
            "twitch:chan:ai:credits:polar-version".to_owned(),
            "twitch:chan:ai:credits:plan-version".to_owned(),
        ]
    );
}
