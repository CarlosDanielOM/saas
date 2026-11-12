//! An unverified balance is marked as such and never becomes the basis of a grant (item 5 of
//! P2-BILLING-01b, review finding 6). Pure reads offline; `get_ai_credits` against Dragonfly
//! database 9 with channel ids no other run uses.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod support;

use dima_billing::plans::credits::{CreditStatus, read_cached_credits};

fn now() -> String {
    "2026-11-12T00:00:00.000Z".into()
}

/// The reference read a cached `unavailable` snapshot back as available whenever the caller did
/// not ask for verified credits, so a paid feature could spend an allowance nobody verified.
/// Its provenance is kept: what was unavailable stays unavailable. What it reads as exhausted
/// stays exhausted (that refuses paid work, which is safe), and the exhaustion flags follow the
/// reference.
#[test]
fn a_cached_unavailable_snapshot_never_reads_back_as_available() {
    for raw in [
        r#"{"version":3,"used":0,"limit":25000,"balance":25000,"available":false,"status":"unavailable"}"#,
        r#"{"version":3,"used":10,"limit":25000,"available":false,"status":"unavailable"}"#,
        r#"{"version":3,"used":10,"limit":25000,"balance":5,"available":true,"status":"unavailable"}"#,
        r#"{"version":3,"used":10,"limit":25000,"balance":5,"available":false}"#,
    ] {
        let read = read_cached_credits(raw, false, now).unwrap();
        assert_eq!(read.payload.status, CreditStatus::Unavailable, "{raw}");
        assert!(!read.payload.available, "{raw}");
    }
    let spent = r#"{"version":3,"used":0,"limit":25000,"balance":0,"available":false,"status":"unavailable"}"#;
    assert_eq!(
        read_cached_credits(spent, false, now)
            .unwrap()
            .payload
            .status,
        CreditStatus::Exhausted,
        "as the reference: refused either way"
    );
    let verified = r#"{"version":3,"used":10,"limit":25000,"balance":24990,"available":true,"status":"available"}"#;
    let read = read_cached_credits(verified, false, now).unwrap();
    assert_eq!(
        (read.payload.status, read.payload.available),
        (CreditStatus::Available, true)
    );
}

use dima_billing::NoopObserver;
use dima_billing::free_credit_reset::{
    FreeCreditResetDecision, FreeCreditResetInput, PreviousReset, ResetUsage,
    decide_free_credit_reset,
};
use dima_billing::plans::credits::BalanceState;
use dima_billing::plans::credits_cache::{
    CreditOptions, CreditsCache, CustomerStateSource, LookupError, PlanLookup, PlanOwner,
    UnverifiedBalance,
};
use dima_billing::polar::PolarError;
use dima_billing::products::AI_CREDITS_METER_ID;
use dima_core::ManualClock;
use futures_util::future::BoxFuture;
use serde_json::{Value, json};
use std::sync::Arc;

const T0: i64 = 1_793_000_000_000;

/// Polar's customer state, or a failure.
struct State(Option<Value>);

impl CustomerStateSource for State {
    fn customer_state<'a>(
        &'a self,
        _customer_id: &'a str,
    ) -> BoxFuture<'a, Result<Value, PolarError>> {
        Box::pin(async move {
            self.0.clone().ok_or(PolarError::Status {
                status: 503,
                mutation: false,
            })
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

fn owner() -> PlanOwner {
    PlanOwner {
        plan_tier: Some("free".into()),
        polar_sh_customer_id: Some("9b2f4c1e-3a5d-4e6f-8a7b-1c2d3e4f5a6b".into()),
        ..Default::default()
    }
}

fn meter(consumed: f64) -> Value {
    json!({"active_meters": [{"meter_id": AI_CREDITS_METER_ID, "consumed_units": consumed, "balance": -consumed}]})
}

/// Review finding 6: with Polar unreachable and an exhaustion flag, the reference invented
/// `used = limit` with `available: true`, and the monthly reset trusted it and granted a full
/// reset. Chat features still read that fallback; nothing that grants can.
#[tokio::test]
async fn an_unverified_balance_is_marked_and_never_the_basis_of_a_grant() {
    let Some(dragonfly) = support::dragonfly(9).await.unwrap() else {
        return;
    };
    let cache = CreditsCache::new(
        dragonfly.clone(),
        Arc::new(ManualClock::new(T0)),
        Arc::new(NoopObserver),
    );
    let channel = support::channel_id();
    dragonfly
        .set(
            &format!("twitch:{channel}:ai:exhaust"),
            b"true",
            Default::default(),
        )
        .await
        .unwrap();

    // Polar unreachable: the reference's answer for chat features, marked unknown.
    let down = State(None);
    let fallback = cache
        .get_ai_credits(
            &owner(),
            &channel,
            CreditOptions::default(),
            &NoLookup,
            &down,
        )
        .await
        .unwrap();
    assert_eq!(fallback.state, BalanceState::Unknown);
    assert_eq!(
        (
            fallback.data.used,
            fallback.data.available,
            fallback.data.status
        ),
        (25_000.0, true, CreditStatus::Exhausted),
        "what chat features see is the reference's"
    );
    assert_eq!(fallback.verified(), None);
    assert!(matches!(
        cache
            .verified_balance(&owner(), &channel, &NoLookup, &down)
            .await,
        Err(UnverifiedBalance::Failed(_))
    ));
    // The monthly reset cannot grant from it: a new period is deferred.
    let previous = PreviousReset {
        period_start_ms: Some(T0 - 40 * 86_400_000),
        status: "completed",
        credits: 0.0,
        external_id: "",
    };
    let reset = |usage: ResetUsage| {
        decide_free_credit_reset(&FreeCreditResetInput {
            user_id: "6650a0000000000000000001",
            period_source: "free_monthly",
            period_starts_at_ms: Some(T0 - 86_400_000),
            previous: Some(previous.clone()),
            usage,
            maximum_reset_credits: 25_000.0,
        })
    };
    let usage = fallback
        .verified()
        .as_ref()
        .map_or(ResetUsage::Unverified, ResetUsage::from);
    assert_eq!(reset(usage), FreeCreditResetDecision::Defer);

    // Polar answers: verified now, published, and a grant can be computed from it.
    let up = State(Some(meter(1234.0)));
    let verified = cache
        .verified_balance(&owner(), &channel, &NoLookup, &up)
        .await
        .unwrap();
    assert_eq!(
        (
            verified.used(),
            verified.balance(),
            verified.verified_at_ms()
        ),
        (1234.0, 23_766.0, T0)
    );
    assert!(matches!(
        reset(ResetUsage::from(&verified)),
        FreeCreditResetDecision::Grant { credits, .. } if credits == 1234.0
    ));
    // The next ordinary read is the published snapshot: cached, not verified.
    let cached = cache
        .get_ai_credits(
            &owner(),
            &channel,
            CreditOptions::default(),
            &NoLookup,
            &down,
        )
        .await
        .unwrap();
    assert_eq!(cached.state, BalanceState::Cached);
    assert_eq!(cached.data.balance, 23_766.0);
    assert_eq!(cached.verified(), None);

    // A fresh read from Polar is verified; one without the credit meter is not.
    support::cleanup(&dragonfly, &channel).await.unwrap();
    let fresh = cache
        .get_ai_credits(&owner(), &channel, CreditOptions::default(), &NoLookup, &up)
        .await
        .unwrap();
    assert_eq!(fresh.state, BalanceState::Verified { at_ms: T0 });
    assert_eq!(fresh.verified().map(|v| v.used()), Some(1234.0));
    support::cleanup(&dragonfly, &channel).await.unwrap();
    let no_meter = State(Some(json!({"active_meters": []})));
    let invented = cache
        .get_ai_credits(
            &owner(),
            &channel,
            CreditOptions::default(),
            &NoLookup,
            &no_meter,
        )
        .await
        .unwrap();
    assert_eq!(invented.state, BalanceState::Unknown);
    assert_eq!(
        cache
            .verified_balance(&owner(), &channel, &NoLookup, &no_meter)
            .await,
        Err(UnverifiedBalance::NoMeter)
    );
    support::cleanup(&dragonfly, &channel).await.unwrap();
}
