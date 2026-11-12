//! Fault cases of every operation that writes (MIGRATION.md section 8): delivered twice,
//! interrupted between two writes, a timeout after the write committed (the caller retries with
//! what it had), and two processes at once. Throwaway `dima_test_billing_<id>` database, Dragonfly
//! database 9, unique channel ids; everything is removed afterwards.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::too_many_lines
)]

mod support;

use anyhow::Result;
use bson::oid::ObjectId;
use bson::{Bson, Document, doc};
use dima_billing::NoopObserver;
use dima_billing::plans::PlanTier;
use dima_billing::plans::credits_cache::{CreditsCache, UsageProjection};
use dima_billing::plans::entitlements::EntitledPlan;
use dima_billing::plans::pack_context::{PackContextCache, context_cache_key};
use dima_billing::plans::projection::{
    EffectGuard, PlanEffects, PlanOwnerState, PlanProjection, ProjectionError, ProjectionStores,
    Retention, project_credit_snapshot, project_polar_plan,
};
use dima_billing::products::AI_CREDITS_METER_ID;
use dima_core::ManualClock;
use dima_store::dragonfly::Dragonfly;
use dima_store::dragonfly::plan_cache_fence::{
    credits_cache_key, plan_cache_fence_key, plan_cache_version,
};
use dima_store::mongo::MongoStore;
use futures_util::future::BoxFuture;
use serde_json::json;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

const CUSTOMER: &str = "9b2f4c1e-3a5d-4e6f-8a7b-1c2d3e4f5a6b";
const T0: i64 = 1_793_000_000_000;

/// Retention adjustments, optionally failing the first `fail` calls.
#[derive(Default)]
struct Effects {
    calls: Mutex<Vec<(Vec<String>, PlanTier)>>,
    fail: AtomicUsize,
}

impl PlanEffects for Effects {
    fn adjust_usage_retention<'a>(
        &'a self,
        channel_ids: &'a [String],
        tier: PlanTier,
        guard: &'a EffectGuard<'a>,
    ) -> BoxFuture<'a, Result<Retention, String>> {
        Box::pin(async move {
            if self.fail.load(Ordering::SeqCst) > 0 {
                self.fail.fetch_sub(1, Ordering::SeqCst);
                return Err("retention store unavailable".into());
            }
            if guard.confirm().await.is_err() {
                return Ok(Retention::Stale);
            }
            self.calls
                .lock()
                .unwrap()
                .push((channel_ids.to_vec(), tier));
            Ok(Retention::Applied)
        })
    }
}

async fn insert_user(store: &MongoStore, channel: &str, tier: &str) -> ObjectId {
    let id = ObjectId::new();
    let now = bson::DateTime::from_millis(T0 - 86_400_000);
    store
        .documents("users")
        .insert_one(doc! {
            "_id": id, "name": "owner", "accounts": [{ "_id": ObjectId::new(), "type": "twitch", "id": channel, "actived": true }],
            "polar_sh_customer_id": CUSTOMER, "plan_tier": tier, "plan_tier_until": Bson::Null,
            "token_balance": 0, "created_at": now, "updated_at": now, "__v": 0,
        })
        .await
        .unwrap();
    id
}

async fn load(store: &MongoStore, id: ObjectId) -> (Document, PlanOwnerState) {
    let document = store
        .documents("users")
        .find_one(doc! {"_id": id})
        .await
        .unwrap()
        .unwrap();
    let user = dima_model::decode_document::<dima_model::users::User>(&document).unwrap();
    (document, PlanOwnerState::of(&user))
}

fn premium(until: i64) -> EntitledPlan {
    EntitledPlan {
        plan_tier: PlanTier::Premium,
        until_ms: Some(until),
    }
}

async fn seed_caches(dragonfly: &Dragonfly, channel: &str) {
    for key in [
        credits_cache_key(channel),
        format!("accounts:twitch:{channel}:data"),
    ] {
        dragonfly
            .set(&key, b"cached", Default::default())
            .await
            .unwrap();
    }
}

async fn exists(dragonfly: &Dragonfly, key: &str) -> bool {
    dragonfly.exists(&[key]).await.unwrap() == 1
}

#[tokio::test]
async fn plan_projection_fault_cases() -> Result<()> {
    let Some(dragonfly) = support::dragonfly(9).await? else {
        return Ok(());
    };
    support::with_mongo(|store| async move {
        let stores = ProjectionStores {
            mongo: &store,
            dragonfly: &dragonfly,
        };
        let channel = support::channel_id();
        let id = insert_user(&store, &channel, "free").await;
        seed_caches(&dragonfly, &channel).await;
        let effects = Effects::default();

        // A plan change: the plan fields, the fence, the caches, and the pending flag cleared.
        let (_, owner) = load(&store, id).await;
        let until = T0 + 30 * 86_400_000;
        let applied = project_polar_plan(
            stores.clone(),
            &effects,
            &owner,
            premium(until),
            T0,
            "evt-1",
            CUSTOMER,
            "fp-1",
            T0,
            &dima_core::SystemRandom,
        )
        .await?;
        assert_eq!(applied, PlanProjection::Applied);
        let (document, after) = load(&store, id).await;
        assert_eq!(document.get_str("plan_tier")?, "premium");
        assert_eq!(
            document.get_datetime("plan_tier_until")?.timestamp_millis(),
            until
        );
        assert_eq!(
            document
                .get_datetime("polar_plan_event_at")?
                .timestamp_millis(),
            T0
        );
        assert_eq!(document.get_str("polar_plan_event_key")?, "evt-1");
        assert_eq!(
            document.get_str("polar_plan_entitlement_fingerprint")?,
            "fp-1"
        );
        assert!(
            !document.contains_key("polar_plan_effects_pending"),
            "removed after the effects"
        );
        assert_eq!(
            document.get_datetime("updated_at")?.timestamp_millis(),
            T0,
            "Mongoose's timestamp"
        );
        let version = plan_cache_version(Some(T0), Some("evt-1"))?;
        assert_eq!(
            dragonfly
                .get_text(&plan_cache_fence_key(&channel))
                .await?
                .as_deref(),
            Some(version.as_str())
        );
        assert!(!exists(&dragonfly, &credits_cache_key(&channel)).await);
        assert!(!exists(&dragonfly, &format!("accounts:twitch:{channel}:data")).await);
        assert_eq!(
            effects.calls.lock().unwrap().clone(),
            vec![(vec![channel.clone()], PlanTier::Premium)]
        );
        assert_eq!(after.plan_tier, "premium");

        // Delivered twice: the same event again changes nothing and runs no effect.
        let applied = project_polar_plan(
            stores.clone(),
            &effects,
            &after,
            premium(until),
            T0,
            "evt-1",
            CUSTOMER,
            "fp-1",
            T0 + 5,
            &dima_core::SystemRandom,
        )
        .await?;
        assert_eq!(applied, PlanProjection::Applied);
        assert_eq!(effects.calls.lock().unwrap().len(), 1);
        assert_eq!(load(&store, id).await.1, after);

        // A timeout after commit: the caller retries with the owner it had before the write.
        let applied = project_polar_plan(
            stores.clone(),
            &effects,
            &owner,
            premium(until),
            T0,
            "evt-1",
            CUSTOMER,
            "fp-1",
            T0 + 6,
            &dima_core::SystemRandom,
        )
        .await?;
        assert_eq!(applied, PlanProjection::Applied);
        assert_eq!(
            effects.calls.lock().unwrap().len(),
            1,
            "decided against the replaced document (already Premium, no effect pending), so the \
             retention is not redone; the caches are invalidated again"
        );
        let (document, _) = load(&store, id).await;
        assert!(!document.contains_key("polar_plan_effects_pending"));

        // An older event that disagrees loses the race loudly; one that agrees is a no-op.
        let older = project_polar_plan(
            stores.clone(),
            &effects,
            &after,
            EntitledPlan::FREE,
            T0 - 1000,
            "evt-0",
            CUSTOMER,
            "fp-0",
            T0 + 7,
            &dima_core::SystemRandom,
        )
        .await;
        assert!(matches!(older, Err(ProjectionError::LostRace)), "{older:?}");
        let older_same = project_polar_plan(
            stores.clone(),
            &effects,
            &after,
            premium(until),
            T0 - 1000,
            "evt-0",
            CUSTOMER,
            "fp-0",
            T0 + 8,
            &dima_core::SystemRandom,
        )
        .await?;
        assert_eq!(older_same, PlanProjection::AlreadyCurrent);
        assert_eq!(load(&store, id).await.1.plan_tier, "premium");

        // Interrupted between the two writes: the plan is stored with the pending flag and the
        // caches already dropped; the retry with a later lookup redoes the effects and clears it.
        seed_caches(&dragonfly, &channel).await;
        effects.fail.store(1, Ordering::SeqCst);
        let (_, current) = load(&store, id).await;
        let pro = EntitledPlan {
            plan_tier: PlanTier::Pro,
            until_ms: None,
        };
        let failed = project_polar_plan(
            stores.clone(),
            &effects,
            &current,
            pro,
            T0 + 1000,
            "evt-2",
            CUSTOMER,
            "fp-2",
            T0 + 9,
            &dima_core::SystemRandom,
        )
        .await;
        assert!(matches!(failed, Err(ProjectionError::Retention(_))));
        let (document, pending) = load(&store, id).await;
        assert_eq!(document.get_str("plan_tier")?, "pro");
        assert_eq!(document.get("plan_tier_until"), Some(&Bson::Null));
        assert!(document.get_bool("polar_plan_effects_pending")?);
        assert!(
            !exists(&dragonfly, &credits_cache_key(&channel)).await,
            "the caches are invalidated before the retention runs (item 3)"
        );
        assert_eq!(
            dragonfly.get_text(&plan_cache_fence_key(&channel)).await?,
            Some(plan_cache_version(Some(T0 + 1000), Some("evt-2"))?)
        );
        seed_caches(&dragonfly, &channel).await;
        let retried = project_polar_plan(
            stores.clone(),
            &effects,
            &pending,
            pro,
            T0 + 2000,
            "evt-2b",
            CUSTOMER,
            "fp-2",
            T0 + 10,
            &dima_core::SystemRandom,
        )
        .await?;
        assert_eq!(retried, PlanProjection::Applied);
        let (document, _) = load(&store, id).await;
        assert!(!document.contains_key("polar_plan_effects_pending"));
        assert!(!exists(&dragonfly, &credits_cache_key(&channel)).await);
        assert_eq!(
            dragonfly.get_text(&plan_cache_fence_key(&channel)).await?,
            Some(plan_cache_version(Some(T0 + 2000), Some("evt-2b"))?)
        );

        // Two processes at once: the newer lookup wins, whatever the order; the fence ends on it.
        let (_, base) = load(&store, id).await;
        let (a, b) = tokio::join!(
            project_polar_plan(
                stores.clone(),
                &effects,
                &base,
                premium(T0 + 9e9 as i64),
                T0 + 3000,
                "evt-3",
                CUSTOMER,
                "fp-3",
                T0 + 11,
                &dima_core::SystemRandom
            ),
            project_polar_plan(
                stores.clone(),
                &effects,
                &base,
                EntitledPlan::FREE,
                T0 + 4000,
                "evt-4",
                CUSTOMER,
                "fp-4",
                T0 + 11,
                &dima_core::SystemRandom
            ),
        );
        assert!(b.is_ok(), "{b:?}");
        assert!(
            matches!(
                a,
                Ok(PlanProjection::Applied) | Err(ProjectionError::LostRace)
            ),
            "{a:?}"
        );
        let (document, _) = load(&store, id).await;
        assert_eq!(document.get_str("plan_tier")?, "free");
        assert_eq!(document.get_str("polar_plan_event_key")?, "evt-4");
        assert_eq!(
            dragonfly.get_text(&plan_cache_fence_key(&channel)).await?,
            Some(plan_cache_version(Some(T0 + 4000), Some("evt-4"))?)
        );

        // A customer link that changed under the event is a missing prerequisite.
        let other = PlanOwnerState {
            customer_id: Some("someone-else".into()),
            ..load(&store, id).await.1
        };
        let moved = project_polar_plan(
            stores.clone(),
            &effects,
            &other,
            EntitledPlan::FREE,
            T0 + 5000,
            "evt-5",
            CUSTOMER,
            "fp",
            T0 + 12,
            &dima_core::SystemRandom,
        )
        .await;
        assert!(
            matches!(moved, Err(ProjectionError::PrerequisiteMissing(_))),
            "{moved:?}"
        );

        support::cleanup(&dragonfly, &channel).await?;
        Ok(())
    })
    .await
}

#[tokio::test]
async fn credit_snapshot_fault_cases() -> Result<()> {
    let Some(dragonfly) = support::dragonfly(9).await? else {
        return Ok(());
    };
    support::with_mongo(|store| async move {
        let stores = ProjectionStores { mongo: &store, dragonfly: &dragonfly };
        let channel = support::channel_id();
        let id = insert_user(&store, &channel, "premium").await;
        let newer = [json!({"meter_id": AI_CREDITS_METER_ID, "consumed_units": 200_000, "balance": -200_000})];
        let older = [json!({"meter_id": AI_CREDITS_METER_ID, "consumed_units": 10, "balance": -10})];

        let first = project_credit_snapshot(stores.clone(), id, T0 + 1000, "snap-2", &newer, T0, &dima_core::SystemRandom).await?.unwrap();
        assert_eq!(first.accepted.len(), 1);
        let cached = dragonfly.get_text(&credits_cache_key(&channel)).await?.unwrap();
        assert!(cached.contains(r#""status":"exhausted""#), "{cached}");
        assert!(exists(&dragonfly, &format!("twitch:{channel}:ai:exhaust")).await);
        let stored = store.documents("users").find_one(doc! {"_id": id}).await?.unwrap();
        let snapshot = stored.get_document("polar_credit_snapshot")?;
        assert_eq!(snapshot.get_str("eventKey")?, "snap-2");
        assert!(matches!(snapshot.get_array("meters")?[0].as_document().unwrap().get("consumed_units"), Some(Bson::Int32(200_000))));

        // Delivered twice: the same snapshot is accepted again with the same result.
        let again = project_credit_snapshot(stores.clone(), id, T0 + 1000, "snap-2", &newer, T0 + 1, &dima_core::SystemRandom).await?.unwrap();
        assert_eq!(again.payload, first.payload);

        // An older snapshot arriving late is not stored; the newer one is published again.
        let late = project_credit_snapshot(stores.clone(), id, T0, "snap-1", &older, T0 + 2, &dima_core::SystemRandom).await?.unwrap();
        assert_eq!(late.snapshot_version, first.snapshot_version);
        let stored = store.documents("users").find_one(doc! {"_id": id}).await?.unwrap();
        assert_eq!(stored.get_document("polar_credit_snapshot")?.get_str("eventKey")?, "snap-2");

        // Two at once: the newest wins in MongoDB and in the cache.
        let (a, b) = tokio::join!(
            project_credit_snapshot(stores.clone(), id, T0 + 3000, "snap-4", &older, T0 + 3, &dima_core::SystemRandom),
            project_credit_snapshot(stores.clone(), id, T0 + 2000, "snap-3", &newer, T0 + 3, &dima_core::SystemRandom),
        );
        a?;
        b?;
        let stored = store.documents("users").find_one(doc! {"_id": id}).await?.unwrap();
        assert_eq!(stored.get_document("polar_credit_snapshot")?.get_str("eventKey")?, "snap-4");
        assert!(dragonfly.get_text(&format!("twitch:{channel}:ai:credits:polar-version")).await?.unwrap().ends_with(":snap-4"));
        assert!(!exists(&dragonfly, &format!("twitch:{channel}:ai:exhaust")).await, "the newest snapshot has credits left");

        support::cleanup(&dragonfly, &channel).await?;
        Ok(())
    })
    .await
}

#[tokio::test]
async fn usage_projection_and_pack_context_fault_cases() -> Result<()> {
    let Some(dragonfly) = support::dragonfly(9).await? else {
        return Ok(());
    };
    let channel = support::channel_id();
    let clock = Arc::new(ManualClock::new(T0));
    let cache = CreditsCache::new(dragonfly.clone(), clock.clone(), Arc::new(NoopObserver));
    let snapshot = r#"{"version":3,"used":0,"limit":25000,"balance":100,"meterId":"m","updatedAt":"x","available":true,"status":"available"}"#;
    dragonfly
        .set(
            &credits_cache_key(&channel),
            snapshot.as_bytes(),
            dima_store::dragonfly::SetOptions::ex(300),
        )
        .await?;
    support::plant_revision(&dragonfly, &channel).await?;

    // Delivered twice: one application per external id; the marker lives 31 days.
    assert_eq!(
        cache
            .record_ai_credit_usage(&channel, 10.2, Some("aiu_1"))
            .await?,
        UsageProjection::Applied
    );
    assert_eq!(
        cache
            .record_ai_credit_usage(&channel, 10.2, Some("aiu_1"))
            .await?,
        UsageProjection::Duplicate
    );
    let marker = format!(
        "twitch:{channel}:ai:usage-local:{}",
        dima_core::crypto::sha256("aiu_1").hex()
    );
    assert!(
        matches!(dragonfly.ttl(&marker).await?, dima_store::dragonfly::Ttl::Seconds(s) if s > 2_678_000)
    );
    let after: serde_json::Value = serde_json::from_str(
        &dragonfly
            .get_text(&credits_cache_key(&channel))
            .await?
            .unwrap(),
    )?;
    assert_eq!(
        (after["used"].as_f64(), after["balance"].as_f64()),
        (Some(11.0), Some(89.0))
    );

    // Two processes at once with the same id: exactly one applies.
    let outcomes = futures_util::future::join_all(
        (0..8).map(|_| cache.record_ai_credit_usage(&channel, 1.0, Some("aiu_same"))),
    )
    .await;
    let applied = outcomes
        .iter()
        .filter(|o| matches!(o, Ok(UsageProjection::Applied)))
        .count();
    assert_eq!(applied, 1, "{outcomes:?}");
    // Distinct ids at once all apply, atomically.
    let outcomes = futures_util::future::join_all((0..8).map(|n| {
        let (cache, channel) = (cache.clone(), channel.clone());
        async move {
            cache
                .record_ai_credit_usage(&channel, 11.0, Some(&format!("aiu_{n}_x")))
                .await
        }
    }))
    .await;
    assert!(outcomes.iter().all(Result::is_ok));
    let after: serde_json::Value = serde_json::from_str(
        &dragonfly
            .get_text(&credits_cache_key(&channel))
            .await?
            .unwrap(),
    )?;
    assert_eq!(after["balance"].as_f64(), Some(89.0 - 1.0 - 88.0));
    assert_eq!(after["status"], "exhausted");
    assert!(cache.is_ai_credits_exhausted(&channel).await?);
    // A repair of one missing flag.
    dragonfly.del(&[&format!("{channel}:ai:exhaust")]).await?;
    assert!(cache.is_ai_credits_exhausted(&channel).await?);
    assert!(exists(&dragonfly, &format!("{channel}:ai:exhaust")).await);

    // The pack context: stored with the seconds left (at most 120), refused for a past expiry.
    let customer = format!("cust-{channel}");
    let packs = PackContextCache::new(dragonfly.clone());
    let ends = dima_text::to_iso_string(T0 + 60_500).unwrap();
    assert!(
        packs
            .store(&customer, PlanTier::Pro, Some(&ends), clock.as_ref())
            .await
    );
    assert!(matches!(
        dragonfly.ttl(&context_cache_key(&customer)).await?,
        dima_store::dragonfly::Ttl::Seconds(61)
    ));
    assert_eq!(
        packs
            .load(&customer, clock.as_ref())
            .await
            .map(|c| c.plan_tier),
        Some(PlanTier::Pro)
    );
    assert!(
        !packs
            .store(
                &customer,
                PlanTier::Pro,
                Some(&dima_text::to_iso_string(T0).unwrap()),
                clock.as_ref()
            )
            .await
    );
    clock.set(T0 + 61_000);
    assert_eq!(
        packs.load(&customer, clock.as_ref()).await,
        None,
        "an expired paid context is not trusted"
    );
    packs.forget(&customer).await?;
    support::cleanup(&dragonfly, &channel).await?;
    Ok(())
}

/// Item 3 of P2-BILLING-01b (review finding 3), the review's interleaving: two processes both
/// read the owner on Free. The older one (A) installs Premium and finishes its effects; Premium
/// caches are filled. The newer one (B) resolves Free and, deciding against the Free owner it
/// read, used to write Free over Premium and return without raising the fence or dropping the
/// Premium caches. The change is decided against the document replaced, so B invalidates.
#[tokio::test]
async fn a_stale_owner_cannot_suppress_the_invalidation_of_a_plan_change() -> Result<()> {
    let Some(dragonfly) = support::dragonfly(9).await? else {
        return Ok(());
    };
    support::with_mongo(|store| async move {
        let stores = ProjectionStores {
            mongo: &store,
            dragonfly: &dragonfly,
        };
        let channel = support::channel_id();
        let id = insert_user(&store, &channel, "free").await;
        let effects = Effects::default();
        let (_, both_read) = load(&store, id).await;
        assert_eq!(both_read.plan_tier, "free");

        let until = T0 + 30 * 86_400_000;
        let a = project_polar_plan(
            stores.clone(),
            &effects,
            &both_read,
            premium(until),
            T0 + 1000,
            "evt-a",
            CUSTOMER,
            "fp-a",
            T0 + 1,
            &dima_core::SystemRandom,
        )
        .await?;
        assert_eq!(a, PlanProjection::Applied);
        // Premium caches, filled after A's effects.
        seed_caches(&dragonfly, &channel).await;

        let b = project_polar_plan(
            stores.clone(),
            &effects,
            &both_read,
            EntitledPlan::FREE,
            T0 + 2000,
            "evt-b",
            CUSTOMER,
            "fp-b",
            T0 + 2,
            &dima_core::SystemRandom,
        )
        .await?;
        assert_eq!(b, PlanProjection::Applied);
        let (document, after) = load(&store, id).await;
        assert_eq!(document.get_str("plan_tier")?, "free");
        assert!(!after.effects_pending);
        assert_eq!(
            dragonfly.get_text(&plan_cache_fence_key(&channel)).await?,
            Some(plan_cache_version(Some(T0 + 2000), Some("evt-b"))?),
            "the fence is raised to B's version"
        );
        assert!(
            !exists(&dragonfly, &credits_cache_key(&channel)).await,
            "Premium credits dropped"
        );
        assert!(!exists(&dragonfly, &format!("accounts:twitch:{channel}:data")).await);
        assert_eq!(
            effects.calls.lock().unwrap().last().cloned(),
            Some((vec![channel.clone()], PlanTier::Free)),
            "retention follows the plan actually replaced"
        );
        support::cleanup(&dragonfly, &channel).await?;
        Ok(())
    })
    .await
}
