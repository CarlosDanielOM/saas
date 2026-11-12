//! A balance is published under a usage revision, and the exhaustion flags are repaired only on
//! what was read (item 4 of P2-BILLING-01b, review findings 4 and 7): the interleavings the
//! review named, made deterministic. A slow fetch from Polar is a state source that waits until
//! the test lets it answer; Dragonfly is database 9 with channel ids no other run uses; the
//! webhook case writes a throwaway `dima_test_billing_<id>` database.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod support;

use anyhow::Result;
use bson::doc;
use bson::oid::ObjectId;
use dima_billing::NoopObserver;
use dima_billing::plans::credits_cache::{
    CreditOptions, CreditsCache, CustomerStateSource, LookupError, PlanLookup, PlanOwner,
};
use dima_billing::plans::projection::{ProjectionStores, project_credit_snapshot};
use dima_billing::polar::PolarError;
use dima_billing::products::AI_CREDITS_METER_ID;
use dima_core::ManualClock;
use dima_store::dragonfly::Dragonfly;
use dima_store::dragonfly::plan_cache_fence::{
    Exhaustion, PlanCacheFence, TtlSeconds, credits_cache_key, exhaustion_cache_keys,
};
use futures_util::future::BoxFuture;
use serde_json::{Value, json};
use std::sync::Arc;
use tokio::sync::Notify;

const CUSTOMER: &str = "9b2f4c1e-3a5d-4e6f-8a7b-1c2d3e4f5a6b";
const T0: i64 = 1_793_000_000_000;

/// Polar's customer state, answered only once the test says so.
struct SlowState {
    state: Value,
    started: Notify,
    answer: Notify,
}

impl SlowState {
    fn new(state: Value) -> Self {
        Self {
            state,
            started: Notify::new(),
            answer: Notify::new(),
        }
    }
}

impl CustomerStateSource for SlowState {
    fn customer_state<'a>(
        &'a self,
        _customer_id: &'a str,
    ) -> BoxFuture<'a, Result<Value, PolarError>> {
        Box::pin(async move {
            self.started.notify_one();
            self.answer.notified().await;
            Ok(self.state.clone())
        })
    }
}

struct NoLookup;

impl PlanLookup for NoLookup {
    fn current_plan<'a>(
        &'a self,
        _twitch_id: &'a str,
        _customer_id: Option<&'a str>,
    ) -> BoxFuture<'a, Result<Option<PlanOwner>, LookupError>> {
        Box::pin(async { Ok(None) })
    }
}

fn meter(consumed: f64) -> Value {
    json!({"meter_id": AI_CREDITS_METER_ID, "consumed_units": consumed, "balance": -consumed})
}

fn free_owner() -> PlanOwner {
    PlanOwner {
        plan_tier: Some("free".into()),
        polar_sh_customer_id: Some(CUSTOMER.into()),
        ..Default::default()
    }
}

async fn cached(dragonfly: &Dragonfly, channel: &str) -> Value {
    serde_json::from_str(
        &dragonfly
            .get_text(&credits_cache_key(channel))
            .await
            .unwrap()
            .unwrap_or_default(),
    )
    .unwrap_or(Value::Null)
}

async fn flags(dragonfly: &Dragonfly, channel: &str) -> i64 {
    let [canonical, legacy] = exhaustion_cache_keys(channel);
    dragonfly.exists(&[&canonical, &legacy]).await.unwrap()
}

/// Review finding 4: a local debit lands while Polar is being read (in batch mode the usage is
/// projected before Polar has it). The reference published Polar's older view over it, giving
/// the credit back, and the debit's marker stopped it from being applied again.
#[tokio::test]
async fn a_debit_made_during_a_fetch_is_not_given_back() {
    let Some(dragonfly) = support::dragonfly(9).await.unwrap() else {
        return;
    };
    let channel = support::channel_id();
    let cache = CreditsCache::new(
        dragonfly.clone(),
        Arc::new(ManualClock::new(T0)),
        Arc::new(NoopObserver),
    );
    let polar = SlowState::new(json!({"active_meters": [meter(1000.0)]}));
    let owner = free_owner();
    let fetch = cache.get_ai_credits(
        &owner,
        &channel,
        CreditOptions::default(),
        &NoLookup,
        &polar,
    );
    let meanwhile = async {
        polar.started.notified().await;
        cache
            .record_ai_credit_usage(&channel, 500.0, Some("aiu_during"))
            .await
            .unwrap();
        polar.answer.notify_one();
    };
    let (credits, ()) = tokio::join!(fetch, meanwhile);
    let credits = credits.unwrap();
    assert_eq!(credits.balance, 23_500.0, "{credits:?}");
    let stored = cached(&dragonfly, &channel).await;
    assert_eq!(stored["balance"], json!(23_500), "{stored}");
    assert_eq!(stored["used"], json!(1_500), "{stored}");
    // The same debit again is still a duplicate.
    let again = cache
        .record_ai_credit_usage(&channel, 500.0, Some("aiu_during"))
        .await
        .unwrap();
    assert_eq!(
        again,
        dima_billing::plans::credits_cache::UsageProjection::Duplicate
    );
    support::cleanup(&dragonfly, &channel).await.unwrap();
}

/// Review finding 4: a webhook publishes a newer, exhausted snapshot while a fetch that started
/// earlier is still waiting for Polar; the fetch's older, available view must not replace it or
/// clear the exhaustion flags.
#[tokio::test]
async fn a_slow_fetch_cannot_overwrite_a_newer_snapshot() -> Result<()> {
    let Some(dragonfly) = support::dragonfly(9).await? else {
        return Ok(());
    };
    support::with_mongo(|store| async move {
        let channel = support::channel_id();
        let id = ObjectId::new();
        let now = bson::DateTime::from_millis(T0 - 86_400_000);
        store
            .documents("users")
            .insert_one(doc! {
                "_id": id, "name": "owner",
                "accounts": [{ "_id": ObjectId::new(), "type": "twitch", "id": &channel, "actived": true }],
                "polar_sh_customer_id": CUSTOMER, "plan_tier": "free", "plan_tier_until": bson::Bson::Null,
                "token_balance": 0, "created_at": now, "updated_at": now, "__v": 0,
            })
            .await?;
        let cache = CreditsCache::new(
            dragonfly.clone(),
            Arc::new(ManualClock::new(T0)),
            Arc::new(NoopObserver),
        );
        let polar = SlowState::new(json!({"active_meters": [meter(1000.0)]}));
        let owner = free_owner();
        let fetch = cache.get_ai_credits(
            &owner,
            &channel,
            CreditOptions::default(),
            &NoLookup,
            &polar,
        );
        let stores = ProjectionStores {
            mongo: &store,
            dragonfly: &dragonfly,
        };
        let meanwhile = async {
            polar.started.notified().await;
            project_credit_snapshot(stores.clone(), id, T0, "snap-1", &[meter(25_000.0)], T0)
                .await
                .unwrap();
            polar.answer.notify_one();
        };
        let (credits, ()) = tokio::join!(fetch, meanwhile);
        let credits = credits?;
        let stored = cached(&dragonfly, &channel).await;
        assert_eq!(stored["status"], "exhausted", "{stored}");
        assert_eq!(stored["balance"], json!(0), "{stored}");
        assert_eq!(flags(&dragonfly, &channel).await, 2, "exhaustion kept");
        assert!(cache.is_ai_credits_exhausted(&channel).await?);
        assert_eq!(credits.balance, 0.0, "the caller sees the newer snapshot: {credits:?}");
        support::cleanup(&dragonfly, &channel).await?;
        Ok(())
    })
    .await
}

/// Review finding 7: a reader sees one exhaustion flag; a refill clears both before the reader
/// repairs; the reference's repair then recreated both and kept paid work refused. Both run on
/// one multiplexed connection, so their commands reach Dragonfly in the order they are issued:
/// the reader's reads, the refill, then (in the reference) the reader's repair.
#[tokio::test]
async fn a_flag_repair_cannot_undo_a_refill_published_after_the_read() {
    let Some(dragonfly) = support::dragonfly(9).await.unwrap() else {
        return;
    };
    let cache = CreditsCache::new(
        dragonfly.clone(),
        Arc::new(ManualClock::new(T0)),
        Arc::new(NoopObserver),
    );
    let fence = PlanCacheFence::new(dragonfly.clone());
    let ttl = TtlSeconds::new(300).unwrap();
    let available = r#"{"version":3,"used":0,"limit":25000,"balance":25000,"meterId":"m","updatedAt":"x","available":true,"status":"available"}"#;
    // Load both scripts first, so neither needs a second round trip during the race.
    let warm = support::channel_id();
    cache.is_ai_credits_exhausted(&warm).await.unwrap();
    fence
        .sync_credits(&warm, "0", Some(available), Exhaustion::Keep, ttl, "")
        .await
        .unwrap();
    support::cleanup(&dragonfly, &warm).await.unwrap();

    let channel = support::channel_id();
    let [canonical, _] = exhaustion_cache_keys(&channel);
    dragonfly
        .set(&canonical, b"true", Default::default())
        .await
        .unwrap();
    let (read, refill) = tokio::join!(
        cache.is_ai_credits_exhausted(&channel),
        fence.sync_credits(
            &channel,
            "0000000000001:refill",
            Some(available),
            Exhaustion::Available,
            ttl,
            ""
        ),
    );
    assert!(read.unwrap(), "exhausted when it was read");
    refill.unwrap();
    assert_eq!(
        flags(&dragonfly, &channel).await,
        0,
        "the refill published after the read stands"
    );
    assert!(!cache.is_ai_credits_exhausted(&channel).await.unwrap());
    support::cleanup(&dragonfly, &channel).await.unwrap();
}
