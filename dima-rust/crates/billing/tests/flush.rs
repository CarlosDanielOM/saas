//! The usage queue's flush (item 1 of P2-BILLING-01b, review findings 1 and 8) against a
//! stateful loopback Polar (it stores events once per external id, as Polar does) and
//! Dragonfly database 9 with channel ids no other run uses: an expired lease cannot delete
//! usage nobody sent, a backlog of any size drains in bounded batches, an event Polar will
//! never accept is set aside instead of blocking its channel, and a batch whose answer was lost
//! is resent with the same ids by the next process.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod support;

use dima_billing::NoopObserver;
use dima_billing::plans::credits_cache::CreditsCache;
use dima_billing::polar::flush::{
    FLUSH_MAX_EVENTS, dead_letter_key, lease_key, processing_key, queue_key,
};
use dima_billing::polar::{
    AcceptedUsage, Ingest, IngestMode, IngestOutcome, PolarClient, UsageEventInput, UsageSink,
};
use dima_core::{ManualClock, SecretString, SeededRandom};
use dima_http::HttpClient;
use dima_http::testing::{MockResponse, MockServer, RecordedRequest};
use dima_store::dragonfly::Dragonfly;
use futures_util::future::BoxFuture;
use serde_json::{Map, Value, json};
use std::collections::HashSet;
use std::sync::{Arc, Mutex};
use std::time::Duration;

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

/// How the mock answers one request, after storing what it would store.
#[derive(Clone)]
enum Answer {
    /// Store the events and answer `{inserted, duplicates}`, after `delay`.
    Store(Duration),
    /// Store the events and lose the reply.
    StoreAndDrop,
    /// Store nothing and answer 422 naming these event indices (none: an unattributed 422).
    Refuse(Vec<usize>),
}

/// Polar's event ledger and the answers to give, in order (then `Store(0)` for the rest).
#[derive(Clone, Default)]
struct Polar {
    stored: Arc<Mutex<Vec<String>>>,
    answers: Arc<Mutex<Vec<Answer>>>,
    /// External ids of each request, in order.
    requests: Arc<Mutex<Vec<Vec<String>>>>,
}

impl Polar {
    fn stored(&self) -> Vec<String> {
        self.stored.lock().unwrap().clone()
    }
    fn requests(&self) -> Vec<Vec<String>> {
        self.requests.lock().unwrap().clone()
    }
    fn answer(&self, answer: Answer) {
        self.answers.lock().unwrap().push(answer);
    }
}

async fn stateful(polar: Polar) -> MockServer {
    let server = MockServer::start().await.unwrap();
    server.fallback(move |request: &RecordedRequest| {
        let body: Value = serde_json::from_str(&request.body_text()).unwrap_or(Value::Null);
        let ids: Vec<String> = body["events"]
            .as_array()
            .cloned()
            .unwrap_or_default()
            .iter()
            .map(|e| e["external_id"].as_str().unwrap_or("").to_owned())
            .collect();
        polar.requests.lock().unwrap().push(ids.clone());
        let answer = {
            let mut answers = polar.answers.lock().unwrap();
            if answers.is_empty() {
                Answer::Store(Duration::ZERO)
            } else {
                answers.remove(0)
            }
        };
        if let Answer::Refuse(indices) = &answer {
            let detail: Vec<Value> = indices
                .iter()
                .map(|i| json!({"type": "missing", "loc": ["body", "events", i, "metadata"], "msg": "x", "input": "victim@example.com"}))
                .collect();
            return MockResponse::json(422, &json!({ "detail": detail }).to_string());
        }
        let mut stored = polar.stored.lock().unwrap();
        let known: HashSet<String> = stored.iter().cloned().collect();
        let (mut inserted, mut duplicates) = (0, 0);
        for id in ids {
            if known.contains(&id) {
                duplicates += 1;
            } else {
                inserted += 1;
                stored.push(id);
            }
        }
        match answer {
            Answer::StoreAndDrop => MockResponse::drop_connection(),
            Answer::Store(delay) => MockResponse::json(
                200,
                &format!(r#"{{"inserted":{inserted},"duplicates":{duplicates}}}"#),
            )
            .delay(delay),
            Answer::Refuse(_) => MockResponse::json(500, "{}"),
        }
    });
    server
}

/// One process: its own client, cache, randomness (so its own lease token) and clock.
struct Process {
    polar: PolarClient,
    dragonfly: Dragonfly,
    credits: CreditsCache,
    random: SeededRandom,
    clock: ManualClock,
}

impl Process {
    async fn new(server: &MockServer, seed: u64) -> Self {
        let dragonfly = support::dragonfly(9).await.unwrap().unwrap();
        let clock = ManualClock::new(1_793_000_000_000);
        Self {
            polar: PolarClient::new(
                HttpClient::builder().build().unwrap(),
                server
                    .provider(PolarClient::provider(&Default::default()))
                    .unwrap(),
                Some(SecretString::from("t")),
            ),
            credits: CreditsCache::new(
                dragonfly.clone(),
                Arc::new(clock.clone()),
                Arc::new(NoopObserver),
            ),
            dragonfly,
            random: SeededRandom::new(seed),
            clock,
        }
    }

    fn ingest(&self) -> Ingest<'_> {
        Ingest {
            polar: &self.polar,
            dragonfly: &self.dragonfly,
            credits: &self.credits,
            sink: &NoSink,
            random: &self.random,
            clock: &self.clock,
            observer: &NoopObserver,
        }
    }
}

fn usage(channel: &str, external: &str) -> UsageEventInput {
    UsageEventInput {
        customer_id: "cus_1".into(),
        channel_id: Some(channel.into()),
        external_id: Some(external.into()),
        cost: 0.002,
        reason: "messages".into(),
        ..Default::default()
    }
}

async fn list(dragonfly: &Dragonfly, key: &str) -> Vec<String> {
    let items: Vec<Vec<u8>> = dragonfly
        .query(redis::cmd("LRANGE").arg(key).arg(0).arg(-1))
        .await
        .unwrap();
    items
        .into_iter()
        .map(|item| String::from_utf8_lossy(&item).into_owned())
        .collect()
}

fn external_ids(items: &[String]) -> Vec<String> {
    items
        .iter()
        .map(|item| {
            let raw = item.rsplit('\n').next().unwrap_or("");
            serde_json::from_str::<Value>(raw).unwrap()["externalId"]
                .as_str()
                .unwrap()
                .to_owned()
        })
        .collect()
}

/// Review finding 1: A claims `[a]` and stalls past its lease; B takes the lease, sends `[a, b]`
/// and acknowledges them; `c` is queued; A's answer finally arrives. The reference's late
/// `LTRIM 1` deleted `c`, which nobody had sent.
#[tokio::test]
async fn a_flush_that_outlives_its_lease_deletes_nothing_it_did_not_send() {
    if support::dragonfly(9).await.unwrap().is_none() {
        return;
    }
    let polar = Polar::default();
    polar.answer(Answer::Store(Duration::from_millis(1500)));
    let server = stateful(polar.clone()).await;
    let (a, b) = (
        Process::new(&server, 1).await,
        Process::new(&server, 2).await,
    );
    let channel = support::channel_id();
    let (a_ingest, a_usage) = (a.ingest(), usage(&channel, "aiu_a"));
    let stalled = a_ingest.ingest_usage(&a_usage, IngestMode::Batch);
    let meanwhile = async {
        server.wait_for(1).await;
        // A's lease expires while its request is in flight.
        b.dragonfly.del(&[&lease_key(&channel)]).await.unwrap();
        let outcome = b
            .ingest()
            .ingest_usage(&usage(&channel, "aiu_b"), IngestMode::Batch)
            .await;
        assert_eq!(outcome, IngestOutcome::Done { message: None });
        let outcome = b
            .ingest()
            .ingest_usage(&usage(&channel, "aiu_c"), IngestMode::Cache)
            .await;
        assert_eq!(outcome, IngestOutcome::Done { message: None });
    };
    let (late, ()) = tokio::join!(stalled, meanwhile);
    assert!(!late.is_error(), "{late:?}");
    let queued = external_ids(&list(&a.dragonfly, &queue_key(&channel)).await);
    let stored = polar.stored();
    assert!(
        queued.contains(&"aiu_c".to_owned()) || stored.contains(&"aiu_c".to_owned()),
        "c was neither sent nor kept: queued {queued:?}, stored {stored:?}"
    );
    assert_eq!(stored, ["aiu_a", "aiu_b"], "a and b stored once each");
    // The next flush sends c.
    let report = b.ingest().flush(&channel).await;
    assert_eq!(report.sent, 1, "{report:?}");
    assert_eq!(polar.stored(), ["aiu_a", "aiu_b", "aiu_c"]);
    assert!(list(&a.dragonfly, &queue_key(&channel)).await.is_empty());
    assert!(
        list(&a.dragonfly, &processing_key(&channel))
            .await
            .is_empty()
    );
    support::cleanup(&a.dragonfly, &channel).await.unwrap();
}

/// Review finding 8: a backlog goes out in batches of at most `FLUSH_MAX_EVENTS`, each request
/// far below the HTTP crate's 8 MiB limit, and drains completely.
#[tokio::test]
async fn a_large_backlog_drains_in_bounded_batches() {
    if support::dragonfly(9).await.unwrap().is_none() {
        return;
    }
    let polar = Polar::default();
    let server = stateful(polar.clone()).await;
    let process = Process::new(&server, 3).await;
    let channel = support::channel_id();
    for n in 0..250 {
        let outcome = process
            .ingest()
            .ingest_usage(&usage(&channel, &format!("aiu_{n:03}")), IngestMode::Cache)
            .await;
        assert_eq!(outcome, IngestOutcome::Done { message: None });
    }
    let outcome = process
        .ingest()
        .ingest_usage(&usage(&channel, "aiu_last"), IngestMode::Batch)
        .await;
    assert_eq!(outcome, IngestOutcome::Done { message: None });
    let requests = polar.requests();
    assert!(
        requests.iter().all(|r| r.len() <= FLUSH_MAX_EVENTS),
        "{:?}",
        requests.iter().map(Vec::len).collect::<Vec<_>>()
    );
    assert_eq!(polar.stored().len(), 251);
    let mut expected: Vec<String> = (0..250).map(|n| format!("aiu_{n:03}")).collect();
    expected.push("aiu_last".into());
    assert_eq!(polar.stored(), expected, "queue order kept");

    // Events too big for one request together: batches are cut by bytes as well.
    let big = Process::new(&server, 4).await;
    let wide = support::channel_id();
    let reason = "r".repeat(200 * 1024);
    for n in 0..6 {
        let mut input = usage(&wide, &format!("big_{n}"));
        input.reason = reason.clone();
        big.ingest().ingest_usage(&input, IngestMode::Cache).await;
    }
    let before = polar.requests().len();
    let report = big.ingest().flush(&wide).await;
    assert_eq!(report.sent, 6, "{report:?}");
    let sizes: Vec<usize> = polar.requests()[before..].iter().map(Vec::len).collect();
    assert!(sizes.iter().all(|n| *n <= 2), "{sizes:?}");
    support::cleanup(&process.dragonfly, &channel)
        .await
        .unwrap();
    support::cleanup(&process.dragonfly, &wide).await.unwrap();
}

/// The reference's quirk: one event Polar refuses blocked its channel for ever. Now it is set
/// aside with the reason and the rest goes on, whether Polar names it or not, and whether it
/// was queued before (an old or corrupted item) or is refused at admission.
#[tokio::test]
async fn an_event_polar_refuses_is_set_aside_and_the_rest_flows() {
    if support::dragonfly(9).await.unwrap().is_none() {
        return;
    }
    let polar = Polar::default();
    let server = stateful(polar.clone()).await;
    let process = Process::new(&server, 5).await;
    let channel = support::channel_id();
    let queue = queue_key(&channel);
    // Items already queued that can never be sent: not an event, and one the SDK refuses.
    process
        .dragonfly
        .rpush(&queue, &[b"not json".as_slice()])
        .await
        .unwrap();
    let refused = json!({"name": "ai_usage", "customerId": "cus_1", "externalId": "aiu_null",
                         "metadata": {"credits": null}})
    .to_string();
    process
        .dragonfly
        .rpush(&queue, &[refused.as_bytes()])
        .await
        .unwrap();
    for id in ["aiu_1", "aiu_2", "aiu_3"] {
        process
            .ingest()
            .ingest_usage(&usage(&channel, id), IngestMode::Cache)
            .await;
    }
    // Polar names the second sendable event (aiu_2) as invalid.
    polar.answer(Answer::Refuse(vec![1]));
    let report = process.ingest().flush(&channel).await;
    assert_eq!(report.sent, 2, "{report:?}");
    assert_eq!(report.dead_lettered, 3, "{report:?}");
    assert_eq!(polar.stored(), ["aiu_1", "aiu_3"]);
    let dead = list(&process.dragonfly, &dead_letter_key(&channel)).await;
    assert_eq!(dead.len(), 3);
    assert!(dead[0].starts_with(r#"{"reason":"not a queued usage event","at":1793000000000}"#));
    assert!(dead[0].ends_with("\nnot json"));
    assert!(dead[1].contains("not accepted by Polar"), "{}", dead[1]);
    assert!(dead[1].ends_with(&format!("\n{refused}")));
    assert!(
        dead[2].contains("Polar refused it (422 missing)"),
        "{}",
        dead[2]
    );
    assert!(!dead[2].contains("victim"), "Polar's echo is never kept");
    assert!(list(&process.dragonfly, &queue).await.is_empty());

    // An unattributed refusal: the flush finds the bad event one at a time.
    for id in ["aiu_4", "aiu_5", "aiu_6"] {
        process
            .ingest()
            .ingest_usage(&usage(&channel, id), IngestMode::Cache)
            .await;
    }
    polar.answer(Answer::Refuse(vec![]));
    polar.answer(Answer::Store(Duration::ZERO));
    polar.answer(Answer::Refuse(vec![]));
    let report = process.ingest().flush(&channel).await;
    assert_eq!((report.sent, report.dead_lettered), (2, 1), "{report:?}");
    assert_eq!(polar.stored(), ["aiu_1", "aiu_3", "aiu_4", "aiu_6"]);

    // Refused at admission: never queued, set aside, nothing sent.
    let mut nan = usage(&channel, "aiu_nan");
    nan.cost = f64::NAN;
    let outcome = process.ingest().ingest_usage(&nan, IngestMode::Batch).await;
    assert!(
        matches!(outcome, IngestOutcome::Failed { .. }),
        "{outcome:?}"
    );
    assert!(list(&process.dragonfly, &queue).await.is_empty());
    assert_eq!(
        list(&process.dragonfly, &dead_letter_key(&channel))
            .await
            .len(),
        5
    );
    support::cleanup(&process.dragonfly, &channel)
        .await
        .unwrap();
}

/// Polar stores a batch and the reply is lost; the process stops. Another process's flush
/// resends that batch first, with the same external ids, and Polar holds each event once.
#[tokio::test]
async fn a_batch_whose_reply_was_lost_is_resent_with_the_same_ids_after_a_restart() {
    if support::dragonfly(9).await.unwrap().is_none() {
        return;
    }
    let polar = Polar::default();
    polar.answer(Answer::StoreAndDrop);
    let server = stateful(polar.clone()).await;
    let channel = support::channel_id();
    let first = Process::new(&server, 6).await;
    for id in ["aiu_x", "aiu_y"] {
        first
            .ingest()
            .ingest_usage(&usage(&channel, id), IngestMode::Cache)
            .await;
    }
    let outcome = first
        .ingest()
        .ingest_usage(&usage(&channel, "aiu_z"), IngestMode::Batch)
        .await;
    assert!(
        matches!(outcome, IngestOutcome::OutcomeUnknown { .. }),
        "{outcome:?}"
    );
    assert_eq!(
        external_ids(&list(&first.dragonfly, &processing_key(&channel)).await),
        ["aiu_x", "aiu_y", "aiu_z"],
        "the batch is kept"
    );
    drop(first);
    let second = Process::new(&server, 7).await;
    second
        .ingest()
        .ingest_usage(&usage(&channel, "aiu_w"), IngestMode::Cache)
        .await;
    let report = second.ingest().flush(&channel).await;
    assert_eq!((report.resumed, report.sent), (3, 4), "{report:?}");
    let requests = polar.requests();
    assert_eq!(requests[1], ["aiu_x", "aiu_y", "aiu_z", "aiu_w"]);
    assert_eq!(polar.stored(), ["aiu_x", "aiu_y", "aiu_z", "aiu_w"]);
    assert!(
        list(&second.dragonfly, &processing_key(&channel))
            .await
            .is_empty()
    );
    support::cleanup(&second.dragonfly, &channel).await.unwrap();
}

/// Item 6 of P2-BILLING-01c (re-check finding N7): a destination key of the wrong type. The
/// dead-letter and requeue scripts removed the item from the processing list first and then
/// failed on the push, and Lua does not undo the removal: the item was lost. Every script that
/// moves an item between two keys now checks both types before it changes anything; the flush
/// stops with a store failure and the item stays where it was.
#[tokio::test]
async fn a_destination_of_the_wrong_type_never_loses_an_item() {
    if support::dragonfly(9).await.unwrap().is_none() {
        return;
    }
    use dima_billing::polar::flush::FlushEnd;
    let server = MockServer::start().await.unwrap();
    let process = Process::new(&server, 8).await;
    let channel = support::channel_id();
    let (queue, processing, dead) = (
        queue_key(&channel),
        processing_key(&channel),
        dead_letter_key(&channel),
    );
    let string = |key: String| {
        let dragonfly = process.dragonfly.clone();
        async move {
            dragonfly.del(&[&key]).await.unwrap();
            dragonfly
                .set(&key, b"not a list", Default::default())
                .await
                .unwrap();
        }
    };

    // Dead letter: the item cannot be sent and the dead-letter key holds a string.
    process
        .dragonfly
        .rpush(&queue, &[b"not json".as_slice()])
        .await
        .unwrap();
    string(dead.clone()).await;
    let report = process.ingest().flush(&channel).await;
    assert!(
        matches!(report.end, FlushEnd::StoreFailed { .. }),
        "{report:?}"
    );
    assert_eq!(
        list(&process.dragonfly, &processing).await,
        ["not json"],
        "the item is kept"
    );
    process.dragonfly.del(&[&processing, &dead]).await.unwrap();

    // Requeue: Polar refuses the first event of the batch for good and the rest goes back to
    // the queue, which holds a string by the time the answer arrives.
    for id in ["aiu_bad", "aiu_good"] {
        process
            .ingest()
            .ingest_usage(&usage(&channel, id), IngestMode::Cache)
            .await;
    }
    let refusal = json!({"detail": [{"type": "missing", "loc": ["body", "events", 0, "metadata"], "msg": "x"}]});
    server.push(MockResponse::json(422, &refusal.to_string()).delay(Duration::from_millis(300)));
    let flush = process.ingest();
    let flushing = flush.flush(&channel);
    let meanwhile = async {
        server.wait_for(1).await;
        string(queue.clone()).await;
    };
    let (report, ()) = tokio::join!(flushing, meanwhile);
    assert!(
        matches!(report.end, FlushEnd::StoreFailed { .. }),
        "{report:?}"
    );
    assert_eq!(
        external_ids(&list(&process.dragonfly, &processing).await),
        ["aiu_good"],
        "the event to requeue is kept"
    );
    assert_eq!(
        list(&process.dragonfly, &dead).await.len(),
        1,
        "the refused one was set aside"
    );
    support::cleanup(&process.dragonfly, &channel)
        .await
        .unwrap();
}
