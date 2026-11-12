//! A superseded answer is not a verified balance, and a verified balance is only what the read
//! that verified it published (item 2 of P2-BILLING-01c, re-check finding N2). Dragonfly
//! database 9 with channel ids no other run uses; Polar is a state source the test answers.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod support;

use dima_billing::NoopObserver;
use dima_billing::plans::credits_cache::{
    CreditOptions, CreditsCache, CustomerStateSource, LookupError, PlanLookup, PlanOwner, TopUp,
    UnverifiedBalance,
};
use dima_billing::polar::PolarError;
use dima_billing::products::AI_CREDITS_METER_ID;
use dima_core::ManualClock;
use dima_store::dragonfly::Dragonfly;
use dima_store::dragonfly::plan_cache_fence::credits_cache_key;
use futures_util::future::BoxFuture;
use serde_json::{Value, json};
use std::sync::Arc;
use tokio::sync::Notify;

const T0: i64 = 1_793_000_000_000;

/// Polar's state showing `consumed` credits used, answered at once or when the test lets it.
struct State {
    consumed: f64,
    gate: Option<(Notify, Notify)>,
}

impl CustomerStateSource for State {
    fn customer_state<'a>(
        &'a self,
        _customer_id: &'a str,
    ) -> BoxFuture<'a, Result<Value, PolarError>> {
        Box::pin(async move {
            if let Some((started, answer)) = &self.gate {
                started.notify_one();
                answer.notified().await;
            }
            Ok(json!({"active_meters": [{"meter_id": AI_CREDITS_METER_ID,
                "consumed_units": self.consumed, "balance": -self.consumed}]}))
        })
    }
}

fn now(consumed: f64) -> State {
    State {
        consumed,
        gate: None,
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

fn owner() -> PlanOwner {
    PlanOwner {
        plan_tier: Some("free".into()),
        polar_sh_customer_id: Some("9b2f4c1e-3a5d-4e6f-8a7b-1c2d3e4f5a6b".into()),
        ..Default::default()
    }
}

async fn process() -> Option<(Dragonfly, CreditsCache)> {
    let dragonfly = support::dragonfly(9).await.unwrap()?;
    let cache = CreditsCache::new(
        dragonfly.clone(),
        Arc::new(ManualClock::new(T0)),
        Arc::new(NoopObserver),
    );
    Some((dragonfly, cache))
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

/// N2: a read that will show 25,000 used starts; a newer refill showing nothing used is
/// published; the old read finishes. The cache keeps the refill, and the old read, refused as
/// superseded, must not certify its 25,000, which could drive a reset or a top-up nobody is owed.
#[tokio::test]
async fn a_superseded_read_is_not_a_verified_balance() {
    let Some((dragonfly, first)) = process().await else {
        return;
    };
    let (_, second) = process().await.unwrap();
    let channel = support::channel_id();
    let slow = State {
        consumed: 25_000.0,
        gate: Some((Notify::new(), Notify::new())),
    };
    let user = owner();
    let old = first.verified_balance(&user, &channel, &NoLookup, &slow);
    let refill = async {
        if let Some((started, answer)) = &slow.gate {
            started.notified().await;
            let read = second
                .get_ai_credits(
                    &owner(),
                    &channel,
                    CreditOptions::default(),
                    &NoLookup,
                    &now(0.0),
                )
                .await
                .unwrap();
            assert_eq!(read.data.balance, 25_000.0);
            answer.notify_one();
        }
    };
    let (old, ()) = tokio::join!(old, refill);
    assert_eq!(old, Err(UnverifiedBalance::Superseded), "{old:?}");
    assert_eq!(cached(&dragonfly, &channel).await["used"], json!(0));

    // The same through `get_ai_credits`: the newer balance, not verified.
    let slow = State {
        consumed: 25_000.0,
        gate: Some((Notify::new(), Notify::new())),
    };
    dragonfly
        .del(&[&credits_cache_key(&channel)])
        .await
        .unwrap();
    let old = first.get_ai_credits(&user, &channel, CreditOptions::default(), &NoLookup, &slow);
    let refill = async {
        if let Some((started, answer)) = &slow.gate {
            started.notified().await;
            second
                .get_ai_credits(
                    &owner(),
                    &channel,
                    CreditOptions::default(),
                    &NoLookup,
                    &now(0.0),
                )
                .await
                .unwrap();
            answer.notify_one();
        }
    };
    let (old, ()) = tokio::join!(old, refill);
    let old = old.unwrap();
    assert_eq!(old.data.used, 0.0, "{old:?}");
    assert_eq!(old.verified(), None);
    support::cleanup(&dragonfly, &channel).await.unwrap();
}

/// A verified balance is what was accepted and reconciled, read back: Polar's figure with the
/// debits it does not cover yet held.
#[tokio::test]
async fn a_verified_balance_is_what_was_published() {
    let Some((dragonfly, cache)) = process().await else {
        return;
    };
    let channel = support::channel_id();
    cache
        .record_ai_credit_usage(&channel, 500.0, Some("aiu_held"))
        .await
        .unwrap();
    let verified = cache
        .verified_balance(&owner(), &channel, &NoLookup, &now(1000.0))
        .await
        .unwrap();
    assert_eq!((verified.used(), verified.balance()), (1500.0, 23_500.0));
    assert_eq!(cached(&dragonfly, &channel).await["balance"], json!(23_500));
    let read = cache
        .get_ai_credits(
            &owner(),
            &channel,
            CreditOptions::default(),
            &NoLookup,
            &now(1000.0),
        )
        .await
        .unwrap();
    assert_eq!(read.verified(), None, "a cached read verifies nothing");
    support::cleanup(&dragonfly, &channel).await.unwrap();
}

/// The top-up after an admin grant (`adminGrantAiCredits` writes `before + credits` to the
/// cache) takes the balance the read verified: it applies on top of that read's publication
/// (keeping the debits made since), once; after any newer publication it changes nothing.
#[tokio::test]
async fn a_top_up_applies_once_on_top_of_the_read_that_verified_it() {
    let Some((dragonfly, cache)) = process().await else {
        return;
    };
    let channel = support::channel_id();
    let verified = cache
        .verified_balance(&owner(), &channel, &NoLookup, &now(25_000.0))
        .await
        .unwrap();
    assert_eq!(verified.balance(), 0.0);
    assert!(cache.is_ai_credits_exhausted(&channel).await.unwrap());
    cache
        .record_ai_credit_usage(&channel, 10.0, Some("aiu_since"))
        .await
        .unwrap();
    assert_eq!(
        cache.top_up(&channel, 1000.0, &verified).await.unwrap(),
        TopUp::Applied
    );
    let after = cached(&dragonfly, &channel).await;
    assert_eq!(
        (&after["limit"], &after["balance"], &after["status"]),
        (&json!(26_000), &json!(990), &json!("available"))
    );
    assert!(!cache.is_ai_credits_exhausted(&channel).await.unwrap());
    // A retry of the same top-up does not add the grant twice.
    assert_eq!(
        cache.top_up(&channel, 1000.0, &verified).await.unwrap(),
        TopUp::Refused
    );
    assert_eq!(cached(&dragonfly, &channel).await["balance"], json!(990));

    // A newer publication since the read: nothing changes.
    let verified = cache
        .verified_balance(&owner(), &channel, &NoLookup, &now(0.0))
        .await
        .unwrap();
    dragonfly
        .del(&[&credits_cache_key(&channel)])
        .await
        .unwrap();
    cache
        .get_ai_credits(
            &owner(),
            &channel,
            CreditOptions::default(),
            &NoLookup,
            &now(0.0),
        )
        .await
        .unwrap();
    let before = cached(&dragonfly, &channel).await;
    assert_eq!(
        cache.top_up(&channel, 1000.0, &verified).await.unwrap(),
        TopUp::Refused
    );
    assert_eq!(cached(&dragonfly, &channel).await, before);
    // Another channel's verified balance tops up nothing here.
    let other = support::channel_id();
    let elsewhere = cache
        .verified_balance(&owner(), &other, &NoLookup, &now(0.0))
        .await
        .unwrap();
    assert_eq!(
        cache.top_up(&channel, 1000.0, &elsewhere).await.unwrap(),
        TopUp::Refused
    );
    support::cleanup(&dragonfly, &channel).await.unwrap();
    support::cleanup(&dragonfly, &other).await.unwrap();
}
