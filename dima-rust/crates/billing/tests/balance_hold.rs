//! Spent credit never comes back (item 1 of P2-BILLING-01c, re-check finding N1): a local debit
//! is held against every balance published from Polar until Polar's figure covers it, a replayed
//! snapshot changes nothing, and a lost revision publishes nothing. Dragonfly database 9 with
//! channel ids no other run uses; the webhook cases write a throwaway `dima_test_billing_<id>`
//! database; Polar is a loopback mock (ingest) and a state source the test answers.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod support;

use anyhow::Result;
use bson::doc;
use bson::oid::ObjectId;
use dima_billing::NoopObserver;
use dima_billing::plans::credits::BalanceState;
use dima_billing::plans::credits_cache::{
    CreditOptions, CreditsCache, CustomerStateSource, LookupError, PlanLookup, PlanOwner,
};
use dima_billing::plans::projection::{ProjectionStores, project_credit_snapshot};
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
use tokio::sync::Notify;

const CUSTOMER: &str = "9b2f4c1e-3a5d-4e6f-8a7b-1c2d3e4f5a6b";
const T0: i64 = 1_793_000_000_000;
/// The free allowance.
const LIMIT: f64 = 25_000.0;

fn meter(consumed: f64) -> Value {
    json!({"meter_id": AI_CREDITS_METER_ID, "consumed_units": consumed, "balance": -consumed})
}

/// Polar's customer state: the consumption the test sets, answered at once or when the test
/// lets it (`gate`).
struct State {
    consumed: Mutex<f64>,
    gate: Option<(Notify, Notify)>,
}

impl State {
    fn new(consumed: f64) -> Self {
        Self {
            consumed: Mutex::new(consumed),
            gate: None,
        }
    }
    fn gated(consumed: f64) -> Self {
        Self {
            consumed: Mutex::new(consumed),
            gate: Some((Notify::new(), Notify::new())),
        }
    }
    fn set(&self, consumed: f64) {
        *self.consumed.lock().unwrap() = consumed;
    }
    async fn started(&self) {
        if let Some((started, _)) = &self.gate {
            started.notified().await;
        }
    }
    fn answer(&self) {
        if let Some((_, answer)) = &self.gate {
            answer.notify_one();
        }
    }
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
            let consumed = *self.consumed.lock().unwrap();
            Ok(json!({"active_meters": [meter(consumed)]}))
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
    fn enqueue_receipt<'a>(
        &'a self,
        _usage: AcceptedUsage<'a>,
    ) -> BoxFuture<'a, Result<(), String>> {
        Box::pin(async { Ok(()) })
    }
    fn track(&self, _usage: AcceptedUsage<'_>, _metadata: &Map<String, Value>) {}
}

fn owner() -> PlanOwner {
    PlanOwner {
        plan_tier: Some("free".into()),
        polar_sh_customer_id: Some(CUSTOMER.into()),
        ..Default::default()
    }
}

/// Polar's event store: each external id once, with its credits; `refuse` makes it refuse the
/// first event of the next requests for good (422 naming it).
#[derive(Clone, Default)]
struct Ledger(
    Arc<Mutex<HashMap<String, f64>>>,
    Arc<std::sync::atomic::AtomicBool>,
);

impl Ledger {
    fn consumed(&self) -> f64 {
        self.0.lock().unwrap().values().sum()
    }
    fn refuse(&self, refuse: bool) {
        self.1.store(refuse, std::sync::atomic::Ordering::SeqCst);
    }
}

async fn polar_server(ledger: Ledger) -> MockServer {
    let server = MockServer::start().await.unwrap();
    server.fallback(move |request: &RecordedRequest| {
        let body: Value = serde_json::from_str(&request.body_text()).unwrap_or(Value::Null);
        if ledger.1.load(std::sync::atomic::Ordering::SeqCst) {
            let refusal = json!({"detail": [{"type": "missing", "loc": ["body", "events", 0, "metadata"], "msg": "x"}]});
            return MockResponse::json(422, &refusal.to_string());
        }
        let mut stored = ledger.0.lock().unwrap();
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

/// One process: its own Dragonfly connection, cache, Polar client and lease randomness, on a
/// clock shared with the others.
struct Process {
    dragonfly: Dragonfly,
    cache: CreditsCache,
    polar: PolarClient,
    random: SeededRandom,
    clock: ManualClock,
}

impl Process {
    async fn new(server: &MockServer, clock: &ManualClock, seed: u64) -> Self {
        let dragonfly = support::dragonfly(9).await.unwrap().unwrap();
        Self {
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
            random: SeededRandom::new(seed),
            clock: clock.clone(),
        }
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

    /// Queues one usage event of `credits` credits and debits it locally (cache mode: nothing
    /// is sent).
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

    async fn read(&self, channel: &str, polar: &State) -> dima_billing::plans::credits::AiCredits {
        self.cache
            .get_ai_credits(
                &owner(),
                channel,
                CreditOptions::default(),
                &NoLookup,
                polar,
            )
            .await
            .unwrap()
    }
}

async fn cached_balance(dragonfly: &Dragonfly, channel: &str) -> Option<f64> {
    let raw = dragonfly
        .get_text(&credits_cache_key(channel))
        .await
        .unwrap()?;
    serde_json::from_str::<Value>(&raw).unwrap()["balance"].as_f64()
}

/// N1, first sequence: 25,000 credits are spent, then the balance is fetched before Polar's
/// meter shows that usage. The fetch started from a revision that already counted the debit,
/// so nothing was replayed and the publication gave the 25,000 back.
#[tokio::test]
async fn credit_spent_just_before_a_fetch_is_not_given_back() {
    if support::dragonfly(9).await.unwrap().is_none() {
        return;
    }
    let ledger = Ledger::default();
    let server = polar_server(ledger.clone()).await;
    let clock = ManualClock::new(T0);
    let process = Process::new(&server, &clock, 1).await;

    // A debit recorded directly (Polar acknowledged it: an immediate ingest).
    let channel = support::channel_id();
    process
        .cache
        .record_ai_credit_usage(&channel, 25_000.0, Some("aiu_all"))
        .await
        .unwrap();
    let polar = State::new(0.0);
    let read = process.read(&channel, &polar).await;
    assert_eq!(read.data.balance, 0.0, "{read:?}");
    assert_eq!(
        cached_balance(&process.dragonfly, &channel).await,
        Some(0.0)
    );
    assert!(
        process
            .cache
            .is_ai_credits_exhausted(&channel)
            .await
            .unwrap()
    );
    support::cleanup(&process.dragonfly, &channel)
        .await
        .unwrap();

    // The same with the usage still queued for the flush.
    let channel = support::channel_id();
    process.spend(&channel, "aiu_queued", 25_000.0).await;
    let read = process.read(&channel, &polar).await;
    assert_eq!(read.data.balance, 0.0, "{read:?}");
    assert!(
        process
            .cache
            .is_ai_credits_exhausted(&channel)
            .await
            .unwrap()
    );
    support::cleanup(&process.dragonfly, &channel)
        .await
        .unwrap();
}

/// N1, second sequence: snapshot S is published, credit is spent, and S is published again
/// (a webhook delivered twice). The equal version was accepted and the debit disappeared.
#[tokio::test]
async fn publishing_the_same_snapshot_again_changes_nothing() -> Result<()> {
    let Some(dragonfly) = support::dragonfly(9).await? else {
        return Ok(());
    };
    let ledger = Ledger::default();
    let server = polar_server(ledger.clone()).await;
    support::with_mongo(|store| async move {
        let clock = ManualClock::new(T0);
        let process = Process::new(&server, &clock, 2).await;
        let channel = support::channel_id();
        let id = ObjectId::new();
        let then = bson::DateTime::from_millis(T0 - 86_400_000);
        store
            .documents("users")
            .insert_one(doc! {
                "_id": id, "name": "owner",
                "accounts": [{ "_id": ObjectId::new(), "type": "twitch", "id": &channel, "actived": true }],
                "polar_sh_customer_id": CUSTOMER, "plan_tier": "free", "plan_tier_until": bson::Bson::Null,
                "token_balance": 0, "created_at": then, "updated_at": then, "__v": 0,
            })
            .await?;
        let stores = ProjectionStores {
            mongo: &store,
            dragonfly: &dragonfly,
        };
        let meters = [meter(1000.0)];
        let publish =
            || project_credit_snapshot(stores.clone(), id, T0, "snap-s", &meters, T0, &dima_core::SystemRandom);
        publish().await?;
        assert_eq!(cached_balance(&dragonfly, &channel).await, Some(24_000.0));
        // Spent once acknowledged, once still queued.
        process
            .cache
            .record_ai_credit_usage(&channel, 300.0, Some("aiu_acked"))
            .await?;
        process.spend(&channel, "aiu_queued", 200.0).await;
        assert_eq!(cached_balance(&dragonfly, &channel).await, Some(23_500.0));
        for _ in 0..2 {
            publish().await?;
            assert_eq!(
                cached_balance(&dragonfly, &channel).await,
                Some(23_500.0),
                "a replay changes nothing"
            );
        }
        // Spent again between two replays: still nothing given back.
        process.spend(&channel, "aiu_later", 100.0).await;
        publish().await?;
        assert_eq!(cached_balance(&dragonfly, &channel).await, Some(23_400.0));
        support::cleanup(&dragonfly, &channel).await?;
        Ok(())
    })
    .await
}

/// N1, third sequence: a fetch starts while the channel has no revision yet; credit is spent
/// (which creates it), then the revision key is evicted; the fetch then published Polar's older
/// figure as if nothing had happened. Now it publishes nothing, and the next read starts clean.
/// The same for a balance found without its revision.
#[tokio::test]
async fn a_fetch_that_began_before_the_revision_was_lost_publishes_nothing() {
    if support::dragonfly(9).await.unwrap().is_none() {
        return;
    }
    let ledger = Ledger::default();
    let server = polar_server(ledger.clone()).await;
    let clock = ManualClock::new(T0);
    let process = Process::new(&server, &clock, 3).await;
    let channel = support::channel_id();
    let revision = dima_billing::plans::balance::revision_key(&channel);
    let polar = State::gated(1000.0);
    let fetch = process.read(&channel, &polar);
    let meanwhile = async {
        polar.started().await;
        process
            .cache
            .record_ai_credit_usage(&channel, 500.0, Some("aiu_during"))
            .await
            .unwrap();
        process.dragonfly.del(&[&revision]).await.unwrap();
        polar.answer();
    };
    let (read, ()) = tokio::join!(fetch, meanwhile);
    assert_eq!(read.state, BalanceState::Unknown, "{read:?}");
    assert_eq!(
        cached_balance(&process.dragonfly, &channel).await,
        None,
        "nothing published"
    );
    // The next read starts clean: Polar's figure, under a new revision.
    let fresh = process.read(&channel, &State::new(1000.0)).await;
    assert_eq!(fresh.data.balance, 24_000.0, "{fresh:?}");
    assert_eq!(
        cached_balance(&process.dragonfly, &channel).await,
        Some(24_000.0)
    );

    // A balance without its revision (evicted alone) is not served: the read starts clean.
    process.dragonfly.del(&[&revision]).await.unwrap();
    let read = process.read(&channel, &State::new(2000.0)).await;
    assert_eq!(read.data.balance, 23_000.0, "{read:?}");
    support::cleanup(&process.dragonfly, &channel)
        .await
        .unwrap();
}

/// One step of a sequence.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Step {
    /// 500 credits spent: the event queued and debited locally.
    Debit,
    /// The flush: Polar stores the event and the flush acknowledges it.
    Ack,
    /// A fetch begins (its generation is read and Polar is asked).
    Begin,
    /// Polar answers and the fetch publishes.
    Publish,
}

/// Runs `order` on a fresh channel; Polar's meter counts what it stored at once (`instant`) or
/// nothing yet. `wipe` empties Dragonfly of the channel's keys before that step (a restart of
/// an empty Dragonfly), `None` never. Returns the balance cached after the sequence and whether
/// the wipe hit between the fetch's begin and its publication.
async fn run(
    process: &Process,
    ledger: &Ledger,
    order: [Step; 4],
    instant: bool,
    wipe: Option<usize>,
) -> (String, Option<f64>) {
    let channel = support::channel_id();
    let polar = State::gated(0.0);
    let begin = order.iter().position(|s| *s == Step::Begin).unwrap();
    let publish = order.iter().position(|s| *s == Step::Publish).unwrap();
    let step = |index: usize| {
        let (channel, ledger, polar) = (channel.clone(), ledger.clone(), &polar);
        async move {
            if wipe == Some(index) {
                support::cleanup(&process.dragonfly, &channel)
                    .await
                    .unwrap();
            }
            match order[index] {
                Step::Debit => process.spend(&channel, "aiu_step", 500.0).await,
                Step::Ack => {
                    process.ingest().flush(&channel).await;
                }
                Step::Begin | Step::Publish => {}
            }
            if index + 1 == publish {
                // Polar's figure, as its meter shows it when it answers.
                polar.set(if instant { ledger.consumed() } else { 0.0 });
            }
        }
    };
    for index in 0..begin {
        step(index).await;
    }
    if wipe == Some(begin) {
        support::cleanup(&process.dragonfly, &channel)
            .await
            .unwrap();
    }
    let fetch = process.read(&channel, &polar);
    let driver = async {
        polar.started().await;
        for index in begin + 1..publish {
            step(index).await;
        }
        if begin + 1 == publish {
            polar.set(if instant { ledger.consumed() } else { 0.0 });
        }
        if wipe == Some(publish) {
            support::cleanup(&process.dragonfly, &channel)
                .await
                .unwrap();
        }
        polar.answer();
    };
    let (_, ()) = tokio::join!(fetch, driver);
    for index in publish + 1..order.len() {
        step(index).await;
    }
    if wipe == Some(order.len()) {
        support::cleanup(&process.dragonfly, &channel)
            .await
            .unwrap();
    }
    let balance = cached_balance(&process.dragonfly, &channel).await;
    (channel, balance)
}

/// A debit, a flush acknowledgement and a fetch in every order, with Polar's meter counting at
/// once or not yet: the cached balance is never more than what is truly left (25,000 - 500), at
/// most one debit less (counted on both sides for a while), and exact once the debit is
/// covered.
#[tokio::test]
async fn a_debit_an_acknowledgement_and_a_fetch_in_every_order() {
    if support::dragonfly(9).await.unwrap().is_none() {
        return;
    }
    use Step::{Ack, Begin, Debit, Publish};
    let ledger = Ledger::default();
    let server = polar_server(ledger.clone()).await;
    let clock = ManualClock::new(T0);
    let process = Process::new(&server, &clock, 4).await;
    let truly_left = LIMIT - 500.0;
    let orders = [
        [Debit, Ack, Begin, Publish],
        [Debit, Begin, Ack, Publish],
        [Debit, Begin, Publish, Ack],
        [Begin, Debit, Ack, Publish],
        [Begin, Debit, Publish, Ack],
        [Begin, Publish, Debit, Ack],
    ];
    for instant in [true, false] {
        for order in orders {
            clock.set(T0);
            ledger.0.lock().unwrap().clear();
            let (channel, balance) = run(&process, &ledger, order, instant, None).await;
            let acked_before_answer =
                order.iter().position(|s| *s == Ack) < order.iter().position(|s| *s == Publish);
            // Counted twice for a while only when Polar's meter already shows it.
            let expected = if instant && acked_before_answer {
                truly_left - 500.0
            } else {
                truly_left
            };
            assert_eq!(balance, Some(expected), "{order:?} instant {instant}");
            // Once the debit is covered (acknowledged two minutes before the figure's date),
            // the balance is exact.
            clock.set(T0 + dima_billing::plans::balance::SETTLE_AFTER_ACK_MS + 30_000);
            process
                .dragonfly
                .del(&[&credits_cache_key(&channel)])
                .await
                .unwrap();
            let settled = process.read(&channel, &State::new(500.0)).await;
            assert_eq!(
                settled.data.balance, truly_left,
                "{order:?} instant {instant}"
            );
            support::cleanup(&process.dragonfly, &channel)
                .await
                .unwrap();
        }
    }
}

/// Two processes, each with its own connection: one fetch waits for Polar while the other
/// spends, flushes and publishes. The slower answer is refused (a newer one stands), and a
/// debit the other process queued meanwhile is held against the first one's figure.
#[tokio::test]
async fn two_processes_never_give_spent_credit_back() {
    if support::dragonfly(9).await.unwrap().is_none() {
        return;
    }
    let ledger = Ledger::default();
    let server = polar_server(ledger.clone()).await;
    let clock = ManualClock::new(T0);
    let (first, second) = (
        Process::new(&server, &clock, 5).await,
        Process::new(&server, &clock, 6).await,
    );

    // The second spends, flushes and publishes while the first waits for Polar.
    let channel = support::channel_id();
    let slow = State::gated(0.0);
    let fetch = first.read(&channel, &slow);
    let meanwhile = async {
        slow.started().await;
        second.spend(&channel, "aiu_second", 500.0).await;
        second.ingest().flush(&channel).await;
        let read = second.read(&channel, &State::new(ledger.consumed())).await;
        assert_eq!(
            read.data.balance,
            LIMIT - 1000.0,
            "counted twice for a while"
        );
        slow.answer();
    };
    let (read, ()) = tokio::join!(fetch, meanwhile);
    assert_eq!(read.state, BalanceState::Cached, "{read:?}");
    assert_eq!(read.data.balance, LIMIT - 1000.0);
    assert_eq!(
        cached_balance(&first.dragonfly, &channel).await,
        Some(LIMIT - 1000.0)
    );
    support::cleanup(&first.dragonfly, &channel).await.unwrap();

    // The second only queues: the first's older figure holds it.
    let channel = support::channel_id();
    let slow = State::gated(0.0);
    let fetch = first.read(&channel, &slow);
    let meanwhile = async {
        slow.started().await;
        second.spend(&channel, "aiu_queued", 700.0).await;
        slow.answer();
    };
    let (read, ()) = tokio::join!(fetch, meanwhile);
    assert_eq!(read.data.balance, LIMIT - 700.0, "{read:?}");
    assert_eq!(
        cached_balance(&second.dragonfly, &channel).await,
        Some(LIMIT - 700.0)
    );
    support::cleanup(&first.dragonfly, &channel).await.unwrap();
}

/// Dragonfly restarted empty between any two steps of a debit, its acknowledgement and a fetch
/// (and before the first, and after the last): a fetch that began before the loss publishes
/// nothing, and the next read starts clean from Polar's figure. What was queued is lost with
/// the restart (Polar never gets it), so Polar's figure is then all there is.
#[tokio::test]
async fn dragonfly_restarted_empty_between_any_two_steps() {
    if support::dragonfly(9).await.unwrap().is_none() {
        return;
    }
    use Step::{Ack, Begin, Debit, Publish};
    let ledger = Ledger::default();
    let server = polar_server(ledger.clone()).await;
    let clock = ManualClock::new(T0);
    let process = Process::new(&server, &clock, 7).await;
    let (mut wiped, mut lost) = (0, 0);
    for order in [[Debit, Begin, Ack, Publish], [Begin, Debit, Publish, Ack]] {
        for wipe in 0..=4 {
            ledger.0.lock().unwrap().clear();
            let (channel, balance) = run(&process, &ledger, order, true, Some(wipe)).await;
            let begin = order.iter().position(|s| *s == Begin).unwrap();
            let publish = order.iter().position(|s| *s == Publish).unwrap();
            let polar_left = LIMIT - ledger.consumed();
            wiped += 1;
            if wipe > begin && wipe <= publish {
                lost += 1;
                // The fetch began in the lost generation: nothing published. A debit made
                // after the wipe applies to no balance either.
                assert_eq!(balance, None, "{order:?} wiped before step {wipe}");
            } else if let Some(balance) = balance {
                assert!(balance <= polar_left, "{order:?} wipe {wipe}: {balance}");
            }
            // The next read starts clean: Polar's figure with what is still queued held.
            let next = process.read(&channel, &State::new(ledger.consumed())).await;
            let queued = process
                .dragonfly
                .query::<i64>(redis::cmd("LLEN").arg(format!("twitch:{channel}:ai:polarshevent")))
                .await
                .unwrap();
            let held = if queued > 0 { 500.0 } else { 0.0 };
            assert!(
                next.data.balance <= polar_left - held,
                "{order:?} wipe {wipe}: {next:?}"
            );
            assert_eq!(
                cached_balance(&process.dragonfly, &channel).await,
                Some(next.data.balance)
            );
            support::cleanup(&process.dragonfly, &channel)
                .await
                .unwrap();
        }
    }
    assert_eq!(
        (wiped, lost),
        (10, 4),
        "every gap of both orders; four inside a fetch"
    );
}

/// No debit is held for ever: an acknowledged one is released two minutes after Polar stored
/// it, a queued one that is never flushed a day after it was queued, a dead-lettered one a day
/// after it was queued (held by its entry: item 3 of P2-BILLING-02c); the revision hash keeps a
/// bounded number of buckets.
#[tokio::test]
async fn a_debit_is_held_for_a_bounded_time() {
    if support::dragonfly(9).await.unwrap().is_none() {
        return;
    }
    use dima_billing::plans::balance::{
        MAX_HOLD_FIELDS, QUEUED_HOLD_MS, SETTLE_AFTER_ACK_MS, revision_key,
    };
    let ledger = Ledger::default();
    let server = polar_server(ledger.clone()).await;
    let clock = ManualClock::new(T0);
    let process = Process::new(&server, &clock, 8).await;
    let fresh = |channel: &str| {
        let channel = channel.to_owned();
        let dragonfly = process.dragonfly.clone();
        async move {
            dragonfly
                .del(&[&credits_cache_key(&channel)])
                .await
                .unwrap();
        }
    };

    // Acknowledged: Polar's meter shows it at once; held (counted twice) for two minutes.
    let channel = support::channel_id();
    process
        .cache
        .record_ai_credit_usage(&channel, 500.0, Some("aiu_acked"))
        .await
        .unwrap();
    assert_eq!(
        process
            .read(&channel, &State::new(500.0))
            .await
            .data
            .balance,
        LIMIT - 1000.0
    );
    clock.set(T0 + SETTLE_AFTER_ACK_MS - 1);
    fresh(&channel).await;
    assert_eq!(
        process
            .read(&channel, &State::new(500.0))
            .await
            .data
            .balance,
        LIMIT - 1000.0
    );
    clock.set(T0 + SETTLE_AFTER_ACK_MS + 30_000);
    fresh(&channel).await;
    assert_eq!(
        process
            .read(&channel, &State::new(500.0))
            .await
            .data
            .balance,
        LIMIT - 500.0
    );
    support::cleanup(&process.dragonfly, &channel)
        .await
        .unwrap();

    // Queued and never flushed (Polar does not have it): held a day at most.
    clock.set(T0);
    let channel = support::channel_id();
    process.spend(&channel, "aiu_stuck", 500.0).await;
    clock.set(T0 + QUEUED_HOLD_MS - 1);
    assert_eq!(
        process.read(&channel, &State::new(0.0)).await.data.balance,
        LIMIT - 500.0
    );
    clock.set(T0 + QUEUED_HOLD_MS);
    fresh(&channel).await;
    assert_eq!(
        process.read(&channel, &State::new(0.0)).await.data.balance,
        LIMIT
    );
    support::cleanup(&process.dragonfly, &channel)
        .await
        .unwrap();

    // Dead-lettered (Polar refuses it for good): held a day after it was queued.
    clock.set(T0);
    let channel = support::channel_id();
    process.spend(&channel, "aiu_refused", 500.0).await;
    ledger.refuse(true);
    let report = process.ingest().flush(&channel).await;
    ledger.refuse(false);
    assert_eq!(report.dead_lettered, 1, "{report:?}");
    clock.set(T0 + QUEUED_HOLD_MS - 1);
    assert_eq!(
        process.read(&channel, &State::new(0.0)).await.data.balance,
        LIMIT - 500.0
    );
    clock.set(T0 + QUEUED_HOLD_MS);
    fresh(&channel).await;
    assert_eq!(
        process.read(&channel, &State::new(0.0)).await.data.balance,
        LIMIT
    );
    support::cleanup(&process.dragonfly, &channel)
        .await
        .unwrap();

    // Many acknowledgements over a long time: old buckets are swept by every write.
    clock.set(T0);
    let channel = support::channel_id();
    for n in 0..400 {
        clock.set(T0 + n * 20_000);
        process
            .cache
            .record_ai_credit_usage(&channel, 1.0, Some(&format!("aiu_{n}")))
            .await
            .unwrap();
    }
    let fields: i64 = process
        .dragonfly
        .query(redis::cmd("HLEN").arg(revision_key(&channel)))
        .await
        .unwrap();
    assert!(fields <= MAX_HOLD_FIELDS + 2, "{fields} fields");
    assert!(
        fields > 100,
        "{fields} fields: the last hour's buckets are kept"
    );
    support::cleanup(&process.dragonfly, &channel)
        .await
        .unwrap();
}

/// More queued events than a publication counts (`MOST_QUEUED`): nothing is published, the
/// cached balance (which carries every local debit) stands, and without one no balance is
/// answered as verified.
#[tokio::test]
async fn a_backlog_too_long_to_count_publishes_nothing() {
    if support::dragonfly(9).await.unwrap().is_none() {
        return;
    }
    use dima_billing::plans::balance::MOST_QUEUED;
    let ledger = Ledger::default();
    let server = polar_server(ledger.clone()).await;
    let clock = ManualClock::new(T0);
    let process = Process::new(&server, &clock, 9).await;
    let channel = support::channel_id();
    let item = br#"{"name":"ai_usage","customerId":"c","externalId":"x","metadata":{"credits":1},"queuedAt":1793000000000}"#;
    let items: Vec<&[u8]> = (0..=MOST_QUEUED).map(|_| item.as_slice()).collect();
    process
        .dragonfly
        .rpush(&format!("twitch:{channel}:ai:polarshevent"), &items)
        .await
        .unwrap();
    let read = process.read(&channel, &State::new(0.0)).await;
    assert_eq!(read.state, BalanceState::Unknown, "{read:?}");
    assert!(!read.data.available);
    assert_eq!(cached_balance(&process.dragonfly, &channel).await, None);
    // One fewer can be counted: every one of them is held.
    let _: Vec<u8> = process
        .dragonfly
        .query(redis::cmd("RPOP").arg(format!("twitch:{channel}:ai:polarshevent")))
        .await
        .unwrap();
    let read = process.read(&channel, &State::new(0.0)).await;
    #[allow(clippy::cast_precision_loss)]
    let held = MOST_QUEUED as f64;
    assert_eq!(read.data.balance, LIMIT - held, "{read:?}");
    support::cleanup(&process.dragonfly, &channel)
        .await
        .unwrap();
}
