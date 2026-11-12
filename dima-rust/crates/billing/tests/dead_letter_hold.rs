//! One event, one hold (item 3 of P2-BILLING-02c, re-check point S4). A usage event's debit is
//! held against Polar's figure by the event itself: while it is queued or claimed, while it is
//! dead-lettered (until the long bound, a day after it was queued), and for the settle time once
//! Polar acknowledged it. The hold moves with the event between those states in the script that
//! moves the event; an operator's settle releases it at once; it never exists twice. Dragonfly
//! database 9 with channel ids no other run uses; Polar is a loopback mock that can refuse events
//! for good, and a state source the test answers.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod support;

use dima_billing::NoopObserver;
use dima_billing::free_credit_reset::{
    FreeCreditResetDecision, FreeCreditResetInput, PreviousReset, ResetUsage,
    decide_free_credit_reset,
};
use dima_billing::plans::balance::{ACK_BUCKET_MS, QUEUED_HOLD_MS, SETTLE_AFTER_ACK_MS};
use dima_billing::plans::credits::VerifiedBalance;
use dima_billing::plans::credits_cache::{
    CreditsCache, CustomerStateSource, LookupError, PlanLookup, PlanOwner,
};
use dima_billing::polar::flush::dead_letter_key;
use dima_billing::polar::{
    AcceptedUsage, Ingest, IngestMode, IngestOutcome, OperationId, PolarClient, PolarError,
    UsageEventInput, UsageSink,
};
use dima_billing::products::AI_CREDITS_METER_ID;
use dima_billing::usage_health::{Resolve, resolve_dead_letter};
use dima_core::{ManualClock, SecretString, SeededRandom};
use dima_http::HttpClient;
use dima_http::testing::{MockResponse, MockServer, RecordedRequest};
use dima_store::dragonfly::Dragonfly;
use futures_util::future::BoxFuture;
use serde_json::{Map, Value, json};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

const CUSTOMER: &str = "9b2f4c1e-3a5d-4e6f-8a7b-1c2d3e4f5a6b";
const T0: i64 = 1_793_000_000_000;
const LIMIT: f64 = 25_000.0;

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

/// Polar's event store; while `refuse` is set it refuses the first event of every request for
/// good (422 naming it).
async fn polar_server(refuse: Arc<AtomicBool>) -> MockServer {
    let stored: Arc<Mutex<HashMap<String, f64>>> = Arc::default();
    let server = MockServer::start().await.unwrap();
    server.fallback(move |request: &RecordedRequest| {
        if refuse.load(Ordering::SeqCst) {
            let refusal = json!({"detail": [{"type": "missing", "loc": ["body", "events", 0, "metadata"], "msg": "x"}]});
            return MockResponse::json(422, &refusal.to_string());
        }
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
    refuse: Arc<AtomicBool>,
    channel: String,
    operations: Mutex<Vec<String>>,
    _server: MockServer,
}

impl Env {
    async fn new(seed: u64) -> Option<Self> {
        let dragonfly = support::dragonfly(9).await.unwrap()?;
        let refuse = Arc::new(AtomicBool::new(false));
        let server = polar_server(refuse.clone()).await;
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
            refuse,
            channel: support::channel_id(),
            operations: Mutex::new(Vec::new()),
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
    async fn spend(&self, external: &str, credits: f64) {
        let input = UsageEventInput {
            customer_id: CUSTOMER.into(),
            channel_id: Some(self.channel.clone()),
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

    /// Flushes with Polar refusing every event for good: all of them are dead-lettered.
    async fn refused_flush(&self) {
        self.refuse.store(true, Ordering::SeqCst);
        let report = self.ingest().flush(&self.channel).await;
        self.refuse.store(false, Ordering::SeqCst);
        assert!(report.dead_lettered >= 1, "{report:?}");
    }

    async fn flush(&self) {
        let report = self.ingest().flush(&self.channel).await;
        assert!(report.sent >= 1, "{report:?}");
    }

    async fn dead_letters(&self) -> Vec<Vec<u8>> {
        self.dragonfly
            .query(
                redis::cmd("LRANGE")
                    .arg(dead_letter_key(&self.channel))
                    .arg(0)
                    .arg(-1),
            )
            .await
            .unwrap()
    }

    /// An operator settles or requeues the only dead letter.
    async fn resolve(&self, action: Resolve) {
        let entries = self.dead_letters().await;
        assert_eq!(entries.len(), 1, "one dead letter");
        let operation = format!(
            "op-{}-{}",
            self.channel,
            self.operations.lock().unwrap().len()
        );
        self.operations.lock().unwrap().push(operation.clone());
        let resolution = resolve_dead_letter(
            &self.dragonfly,
            &self.channel,
            &entries[0],
            &OperationId::new(&operation).unwrap(),
            action,
        )
        .await
        .unwrap();
        assert!(!resolution.repeated, "{resolution:?}");
    }

    async fn verified(&self, consumed: f64) -> VerifiedBalance {
        self.cache
            .verified_balance(&owner(), &self.channel, &NoLookup, &State(consumed))
            .await
            .unwrap()
    }
}

/// Every key of the channel (operation records carry the channel in their id) is deleted when
/// the test ends, whether it passed or not.
impl Drop for Env {
    fn drop(&mut self) {
        let channel = self.channel.clone();
        let _ = std::thread::spawn(move || {
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap();
            runtime.block_on(async {
                if let Ok(Some(dragonfly)) = support::dragonfly(9).await {
                    support::cleanup(&dragonfly, &channel).await.unwrap();
                }
            });
        })
        .join();
    }
}

/// Dead-lettered, requeued by an operator, then billed: one hold at every step, released by
/// the settle time once Polar acknowledged it. Before, the dead letter's hold stayed beside the
/// acknowledgement's and Polar's own count, for about a day.
#[tokio::test]
async fn dead_lettered_requeued_and_billed_is_held_once() {
    let Some(env) = Env::new(31).await else {
        return;
    };
    env.spend("aiu_requeued", 500.0).await;
    env.refused_flush().await;
    assert_eq!(env.verified(0.0).await.held(), 500.0, "dead-lettered");
    env.clock.set(T0 + 60 * 60 * 1000);
    env.resolve(Resolve::Requeue).await;
    assert_eq!(env.verified(0.0).await.held(), 500.0, "requeued");
    env.flush().await;
    let billed = T0 + 60 * 60 * 1000;
    // Polar's meter counts it: shown twice only for the settle time (S3, kept).
    assert_eq!(env.verified(500.0).await.held(), 500.0, "acknowledged");
    env.clock.set(billed + SETTLE_AFTER_ACK_MS + ACK_BUCKET_MS);
    let settled = env.verified(500.0).await;
    assert_eq!(
        settled.held(),
        0.0,
        "released by the settle time: {settled:?}"
    );
    assert_eq!(settled.for_spending().balance, LIMIT - 500.0);
}

/// Refused three times (each time requeued by an operator): still one hold, released by the
/// long bound a day after it was queued.
#[tokio::test]
async fn dead_lettered_three_times_is_held_once() {
    let Some(env) = Env::new(32).await else {
        return;
    };
    env.spend("aiu_thrice", 500.0).await;
    env.refused_flush().await;
    for _ in 0..2 {
        env.resolve(Resolve::Requeue).await;
        env.refused_flush().await;
    }
    assert_eq!(env.dead_letters().await.len(), 1);
    let held = env.verified(0.0).await;
    assert_eq!(held.held(), 500.0, "{held:?}");
    assert_eq!(held.for_spending().balance, LIMIT - 500.0);
    env.clock.set(T0 + QUEUED_HOLD_MS - 1);
    assert_eq!(env.verified(0.0).await.held(), 500.0, "dead and unresolved");
    env.clock.set(T0 + QUEUED_HOLD_MS);
    assert_eq!(env.verified(0.0).await.held(), 0.0, "the long bound");
}

/// Dead-lettered, then settled by an operator as never to be billed: released at once.
#[tokio::test]
async fn dead_lettered_then_settled_is_released_at_once() {
    let Some(env) = Env::new(33).await else {
        return;
    };
    env.spend("aiu_settled", 500.0).await;
    env.refused_flush().await;
    assert_eq!(env.verified(0.0).await.held(), 500.0);
    env.resolve(Resolve::Settle).await;
    let released = env.verified(0.0).await;
    assert_eq!(released.held(), 0.0, "{released:?}");
    assert_eq!(released.for_spending().balance, LIMIT);
}

/// A dead letter is held (Polar never counts it) but certainly not in Polar's figure: the
/// reset computes from Polar's figure without waiting for it. An event refused before it was
/// queued debited nothing and holds nothing.
#[tokio::test]
async fn a_dead_letter_does_not_defer_the_reset_and_an_admission_refusal_holds_nothing() {
    let Some(env) = Env::new(34).await else {
        return;
    };
    env.spend("aiu_dead", 500.0).await;
    env.refused_flush().await;
    let refused = UsageEventInput {
        customer_id: CUSTOMER.into(),
        channel_id: Some(env.channel.clone()),
        external_id: Some("aiu_nan".into()),
        cost: f64::NAN,
        reason: "messages".into(),
        ..Default::default()
    };
    assert!(matches!(
        env.ingest().ingest_usage(&refused, IngestMode::Cache).await,
        IngestOutcome::Failed { .. }
    ));
    assert_eq!(env.dead_letters().await.len(), 2);
    let verified = env.verified(1200.0).await;
    assert_eq!(
        (verified.held(), verified.unsettled_held()),
        (500.0, 0.0),
        "{verified:?}"
    );
    let start = dima_text::parse_date("2026-11-01T00:00:00.000Z").unwrap();
    let decision = decide_free_credit_reset(&FreeCreditResetInput {
        user_id: "user-1",
        period_source: "free_monthly",
        period_starts_at_ms: Some(start),
        previous: Some(PreviousReset {
            period_start_ms: Some(dima_text::parse_date("2026-10-01T00:00:00.000Z").unwrap()),
            status: "completed",
            credits: 0.0,
            external_id: "x",
        }),
        usage: ResetUsage::from(&verified),
        maximum_reset_credits: LIMIT,
    });
    assert_eq!(
        decision,
        FreeCreditResetDecision::Grant {
            credits: 1200.0,
            external_id: "free-credit-reset-user-1-2026-11-01".into()
        }
    );
}

/// A long dead-letter list is read newest first within the bound: entries set aside more than
/// the long bound ago are left unread and hold nothing; more recent entries than the bound can
/// count publish nothing (the cached balance stands), as a long queue does.
#[tokio::test]
async fn a_long_dead_letter_list_is_read_within_its_bound() {
    use dima_billing::plans::balance::MOST_QUEUED;
    use dima_billing::plans::credits_cache::UnverifiedBalance;
    let Some(env) = Env::new(35).await else {
        return;
    };
    let entry = |at: i64, credits: i64| {
        format!(
            "{}\n{}",
            json!({"reason": "Polar refused it (422 missing)", "at": at}),
            json!({"name": "ai_usage", "customerId": CUSTOMER, "externalId": format!("aiu_{at}"),
                "metadata": {"credits": credits}, "queuedAt": at})
        )
    };
    let old = entry(T0 - 2 * QUEUED_HOLD_MS, 1);
    let olds: Vec<&[u8]> = (0..=MOST_QUEUED).map(|_| old.as_bytes()).collect();
    let key = dead_letter_key(&env.channel);
    env.dragonfly.rpush(&key, &olds).await.unwrap();
    let recent = entry(T0 - 1000, 7);
    env.dragonfly
        .rpush(&key, &[recent.as_bytes()])
        .await
        .unwrap();
    let verified = env.verified(0.0).await;
    assert_eq!(verified.held(), 7.0, "only the recent entry: {verified:?}");
    let recents: Vec<&[u8]> = (0..MOST_QUEUED).map(|_| recent.as_bytes()).collect();
    env.dragonfly.rpush(&key, &recents).await.unwrap();
    assert_eq!(
        env.cache
            .verified_balance(&owner(), &env.channel, &NoLookup, &State(0.0))
            .await,
        Err(UnverifiedBalance::NotPublished)
    );
}
