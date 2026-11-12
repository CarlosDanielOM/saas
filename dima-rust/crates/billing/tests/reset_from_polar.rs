//! A reset or a top-up computes from Polar's own figure (item 1 of P2-BILLING-02c, re-check
//! point S1): a verified balance carries what Polar's meter reported beside the cautious
//! spending figure (Polar's minus every local debit it may not count yet), and the monthly reset
//! is computed from Polar's, deferred while a debit whose count at Polar is not settled is held.
//! Dragonfly database 9 with channel ids no other run uses; Polar is a loopback mock (ingest) and
//! a state source the test answers.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod support;

use dima_billing::NoopObserver;
use dima_billing::free_credit_reset::{
    FreeCreditResetDecision, FreeCreditResetInput, PreviousReset, ResetUsage,
    decide_free_credit_reset,
};
use dima_billing::plans::balance::{ACK_BUCKET_MS, SETTLE_AFTER_ACK_MS};
use dima_billing::plans::credits::VerifiedBalance;
use dima_billing::plans::credits_cache::{
    CreditsCache, CustomerStateSource, LookupError, PlanLookup, PlanOwner, TopUp,
};
use dima_billing::polar::{
    AcceptedUsage, Ingest, IngestMode, IngestOutcome, PolarClient, PolarError, UsageEventInput,
    UsageSink,
};
use dima_billing::products::AI_CREDITS_METER_ID;
use dima_core::{ManualClock, SecretString, SeededRandom};
use dima_http::HttpClient;
use dima_http::testing::{MockResponse, MockServer, RecordedRequest};
use dima_store::dragonfly::Dragonfly;
use dima_store::dragonfly::plan_cache_fence::credits_cache_key;
use futures_util::future::BoxFuture;
use serde_json::{Map, Value, json};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

const CUSTOMER: &str = "9b2f4c1e-3a5d-4e6f-8a7b-1c2d3e4f5a6b";
const T0: i64 = 1_793_000_000_000;
const LIMIT: f64 = 25_000.0;
/// A clock past the settle time of everything acknowledged at `T0` (and its bucket).
const SETTLED: i64 = T0 + SETTLE_AFTER_ACK_MS + ACK_BUCKET_MS + 1;

/// Polar's customer state showing `consumed` credits used.
struct State(f64);

impl CustomerStateSource for State {
    fn customer_state<'a>(
        &'a self,
        _customer_id: &'a str,
    ) -> BoxFuture<'a, Result<Value, PolarError>> {
        let consumed = self.0;
        Box::pin(async move {
            Ok(json!({"active_meters": [{"meter_id": AI_CREDITS_METER_ID,
                "consumed_units": consumed, "balance": -consumed}]}))
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

struct NoSink;

impl UsageSink for NoSink {
    fn enqueue_receipt<'a>(&'a self, _: AcceptedUsage<'a>) -> BoxFuture<'a, Result<(), String>> {
        Box::pin(async { Ok(()) })
    }
    fn track(&self, _: AcceptedUsage<'_>, _: &Map<String, Value>) {}
}

fn owner() -> PlanOwner {
    PlanOwner {
        plan_tier: Some("free".into()),
        polar_sh_customer_id: Some(CUSTOMER.into()),
        ..Default::default()
    }
}

/// Polar's event store: each external id once.
async fn polar_server() -> MockServer {
    let stored: Arc<Mutex<HashMap<String, f64>>> = Arc::default();
    let server = MockServer::start().await.unwrap();
    server.fallback(move |request: &RecordedRequest| {
        let body: Value = serde_json::from_str(&request.body_text()).unwrap_or(Value::Null);
        let mut stored = stored.lock().unwrap();
        let (mut inserted, mut duplicates) = (0, 0);
        for event in body["events"].as_array().cloned().unwrap_or_default() {
            let id = event["external_id"].as_str().unwrap_or("").to_owned();
            match stored.entry(id) {
                std::collections::hash_map::Entry::Occupied(_) => duplicates += 1,
                std::collections::hash_map::Entry::Vacant(slot) => {
                    inserted += 1;
                    slot.insert(event["metadata"]["credits"].as_f64().unwrap_or(0.0));
                }
            }
        }
        MockResponse::json(
            200,
            &format!(r#"{{"inserted":{inserted},"duplicates":{duplicates}}}"#),
        )
    });
    server
}

struct Env {
    dragonfly: Dragonfly,
    cache: CreditsCache,
    polar: PolarClient,
    clock: ManualClock,
    random: SeededRandom,
    _server: MockServer,
}

impl Env {
    async fn new(seed: u64) -> Option<Self> {
        let dragonfly = support::dragonfly(9).await.unwrap()?;
        let server = polar_server().await;
        let clock = ManualClock::new(T0);
        Some(Self {
            cache: CreditsCache::new(
                dragonfly.clone(),
                Arc::new(clock.clone()),
                Arc::new(NoopObserver),
            ),
            polar: PolarClient::new(
                HttpClient::builder().build().unwrap(),
                server
                    .provider(PolarClient::provider(&Default::default()))
                    .unwrap(),
                Some(SecretString::from("t")),
            ),
            dragonfly,
            clock,
            random: SeededRandom::new(seed),
            _server: server,
        })
    }

    fn ingest(&self) -> Ingest<'_> {
        Ingest {
            polar: &self.polar,
            dragonfly: &self.dragonfly,
            credits: &self.cache,
            sink: &NoSink,
            random: &self.random,
            clock: &self.clock,
            observer: &NoopObserver,
        }
    }

    /// Queues one usage event and debits it locally (cache mode: nothing is sent).
    async fn spend(&self, channel: &str, external: &str, credits: f64) {
        let input = UsageEventInput {
            customer_id: CUSTOMER.into(),
            channel_id: Some(channel.into()),
            external_id: Some(external.into()),
            cost: credits / 1000.0,
            reason: "messages".into(),
            ..Default::default()
        };
        assert_eq!(
            self.ingest().ingest_usage(&input, IngestMode::Cache).await,
            IngestOutcome::Done { message: None }
        );
    }

    async fn verified(&self, channel: &str, consumed: f64) -> VerifiedBalance {
        self.cache
            .verified_balance(&owner(), channel, &NoLookup, &State(consumed))
            .await
            .unwrap()
    }

    async fn cached_balance(&self, channel: &str) -> f64 {
        let raw = self
            .dragonfly
            .get_text(&credits_cache_key(channel))
            .await
            .unwrap()
            .unwrap();
        serde_json::from_str::<Value>(&raw).unwrap()["balance"]
            .as_f64()
            .unwrap()
    }
}

/// The worker's decision for a new period, the previous one completed.
fn reset(verified: &VerifiedBalance) -> FreeCreditResetDecision {
    let start = dima_text::parse_date("2026-11-01T00:00:00.000Z").unwrap();
    let previous = dima_text::parse_date("2026-10-01T00:00:00.000Z").unwrap();
    decide_free_credit_reset(&FreeCreditResetInput {
        user_id: "user-1",
        period_source: "free_monthly",
        period_starts_at_ms: Some(start),
        previous: Some(PreviousReset {
            period_start_ms: Some(previous),
            status: "completed",
            credits: 0.0,
            external_id: "free-credit-reset-user-1-2026-10-01",
        }),
        usage: ResetUsage::from(verified),
        maximum_reset_credits: LIMIT,
    })
}

fn grant(credits: f64) -> FreeCreditResetDecision {
    FreeCreditResetDecision::Grant {
        credits,
        external_id: "free-credit-reset-user-1-2026-11-01".into(),
    }
}

/// S1 as the review reproduced it: debit 500; Polar already reports those 500; the publication
/// holds the debit on top and the cautious figure says 1,000 used. The reset granted 1,000 for
/// 500 consumed. Now it waits while the debit is held (Polar's figure may or may not count it),
/// then grants what Polar counted: 500.
#[tokio::test]
async fn the_review_sequence_grants_what_polar_counted() {
    let Some(env) = Env::new(21).await else {
        return;
    };
    let channel = support::channel_id();
    env.cache
        .record_ai_credit_usage(&channel, 500.0, Some("aiu_s1"))
        .await
        .unwrap();
    let held = env.verified(&channel, 500.0).await;
    assert_eq!(reset(&held), FreeCreditResetDecision::Defer, "{held:?}");
    env.clock.set(SETTLED);
    let settled = env.verified(&channel, 500.0).await;
    assert_eq!(reset(&settled), grant(500.0), "{settled:?}");
    support::cleanup(&env.dragonfly, &channel).await.unwrap();
}

/// A debit Polar does not count yet: queued (not sent), then acknowledged while Polar's meter
/// still lags. The reset waits through both; once the meter counts it and the hold is
/// released, it grants Polar's figure, which now includes the debit. Nothing is granted from the
/// cautious figure at any point.
#[tokio::test]
async fn a_reset_waits_for_holds_polar_does_not_count_yet() {
    let Some(env) = Env::new(22).await else {
        return;
    };
    let channel = support::channel_id();
    env.spend(&channel, "aiu_queued", 500.0).await;
    let queued = env.verified(&channel, 0.0).await;
    assert_eq!(
        reset(&queued),
        FreeCreditResetDecision::Defer,
        "queued: {queued:?}"
    );
    let report = env.ingest().flush(&channel).await;
    assert_eq!(report.sent, 1, "{report:?}");
    let lagging = env.verified(&channel, 0.0).await;
    assert_eq!(
        reset(&lagging),
        FreeCreditResetDecision::Defer,
        "acknowledged: {lagging:?}"
    );
    env.clock.set(SETTLED);
    let counted = env.verified(&channel, 500.0).await;
    assert_eq!(reset(&counted), grant(500.0), "{counted:?}");
    support::cleanup(&env.dragonfly, &channel).await.unwrap();
}

/// The figures a verified balance carries: Polar's own beside the spending figure, the hold and
/// its unsettled part, for a debit Polar already counts and one it does not count yet.
#[tokio::test]
async fn a_verified_balance_carries_polar_s_figure_beside_the_spending_figure() {
    let Some(env) = Env::new(23).await else {
        return;
    };
    let channel = support::channel_id();
    env.cache
        .record_ai_credit_usage(&channel, 500.0, Some("aiu_figures"))
        .await
        .unwrap();
    for (consumed, polar_balance) in [(500.0, LIMIT - 500.0), (0.0, LIMIT)] {
        let verified = env.verified(&channel, consumed).await;
        let (polar, spending) = (verified.polar_reported(), verified.for_spending());
        assert_eq!((polar.used, polar.balance), (consumed, polar_balance));
        assert_eq!(
            (spending.used, spending.balance),
            (consumed + 500.0, polar_balance - 500.0)
        );
        assert_eq!((verified.held(), verified.unsettled_held()), (500.0, 500.0));
    }
    env.clock.set(SETTLED);
    let settled = env.verified(&channel, 500.0).await;
    assert_eq!(settled.polar_reported(), settled.for_spending());
    assert_eq!((settled.held(), settled.unsettled_held()), (0.0, 0.0));
    support::cleanup(&env.dragonfly, &channel).await.unwrap();
}

/// The top-up after an admin grant adds the credits to the spending figure the verified read
/// stored, whether or not Polar already counts a held debit: adding them to Polar's figure would
/// give a debit Polar does not count yet back (the hold stays until it settles).
#[tokio::test]
async fn a_top_up_adds_to_the_spending_figure_whatever_polar_counts() {
    let Some(env) = Env::new(24).await else {
        return;
    };
    for (consumed, expected) in [
        // Polar counts the 500 already: shown twice for at most the settle time.
        (500.0, LIMIT - 1000.0 + 1000.0),
        // Polar does not count them yet: Polar's figure plus the grant would give them back.
        (0.0, LIMIT - 500.0 + 1000.0),
    ] {
        let channel = support::channel_id();
        env.cache
            .record_ai_credit_usage(&channel, 500.0, Some("aiu_top_up"))
            .await
            .unwrap();
        let verified = env.verified(&channel, consumed).await;
        assert_eq!(
            env.cache.top_up(&channel, 1000.0, &verified).await.unwrap(),
            TopUp::Applied
        );
        assert_eq!(env.cached_balance(&channel).await, expected);
        assert_eq!(
            expected,
            verified.for_spending().balance + 1000.0,
            "the spending figure plus the grant"
        );
        assert!(expected <= verified.polar_reported().balance + 1000.0);
        support::cleanup(&env.dragonfly, &channel).await.unwrap();
    }
}
