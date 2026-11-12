//! A grant carries an identity chosen before it is sent (item 2 of P2-BILLING-01b, review
//! finding 2): Polar commits a grant, the reply is lost, the process restarts and the caller
//! retries with what it persisted. Polar is a stateful loopback mock that deduplicates by
//! `external_id`, as Polar does; its ledger must hold the grant once.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod support;

use dima_billing::NoopObserver;
use dima_billing::plans::credits_cache::CreditsCache;
use dima_billing::polar::{
    AcceptedUsage, GrantInput, Ingest, IngestOutcome, OperationId, PolarClient, UsageSink,
};
use dima_core::{ManualClock, SecretString, SeededRandom};
use dima_http::HttpClient;
use dima_http::testing::{MockResponse, MockServer, RecordedRequest};
use futures_util::future::BoxFuture;
use serde_json::{Map, Value};
use std::collections::HashSet;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

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

/// Polar's event ledger: external ids stored, in order.
#[derive(Clone, Default)]
struct Ledger(Arc<Mutex<Vec<String>>>);

/// A mock that stores every event it receives (deduplicated by external id) and loses the
/// reply of the first `lost` requests after storing them.
async fn stateful_polar(ledger: Ledger, lost: usize) -> MockServer {
    let server = MockServer::start().await.unwrap();
    let calls = AtomicUsize::new(0);
    server.fallback(move |request: &RecordedRequest| {
        let body: Value = serde_json::from_str(&request.body_text()).unwrap_or(Value::Null);
        let mut stored = ledger.0.lock().unwrap();
        let known: HashSet<String> = stored.iter().cloned().collect();
        let (mut inserted, mut duplicates) = (0, 0);
        for event in body["events"].as_array().cloned().unwrap_or_default() {
            let id = event["external_id"].as_str().unwrap_or("").to_owned();
            if known.contains(&id) {
                duplicates += 1;
            } else {
                inserted += 1;
                stored.push(id);
            }
        }
        if calls.fetch_add(1, Ordering::SeqCst) < lost {
            return MockResponse::drop_connection();
        }
        MockResponse::json(
            200,
            &format!(r#"{{"inserted":{inserted},"duplicates":{duplicates}}}"#),
        )
    });
    server
}

/// One process: its own client, cache and randomness.
async fn grant_in_a_process(server: &MockServer, seed: u64, input: &GrantInput) -> IngestOutcome {
    let dragonfly = support::dragonfly(9).await.unwrap().unwrap();
    let polar = PolarClient::new(
        HttpClient::builder().build().unwrap(),
        server
            .provider(PolarClient::provider(&Default::default()))
            .unwrap(),
        Some(SecretString::from("t")),
    );
    let credits = CreditsCache::new(
        dragonfly.clone(),
        Arc::new(ManualClock::new(1_793_000_000_000)),
        Arc::new(NoopObserver),
    );
    let random = SeededRandom::new(seed);
    let ingest = Ingest {
        polar: &polar,
        dragonfly: &dragonfly,
        credits: &credits,
        sink: &NoSink,
        random: &random,
        observer: &NoopObserver,
    };
    ingest.grant_ai_credits(input).await
}

#[tokio::test]
async fn a_grant_committed_before_a_lost_reply_and_a_restart_is_granted_once() {
    if support::dragonfly(9).await.unwrap().is_none() {
        return;
    }
    let ledger = Ledger::default();
    let server = stateful_polar(ledger.clone(), 1).await;
    // What the caller persisted before calling (for the admin route: the request's operation
    // id stored with the pending grant).
    let input = GrantInput {
        customer_id: "cus_1".into(),
        channel_id: None,
        credits: 500.0,
        reason: "support".into(),
        admin_login: Some("admin".into()),
        operation_id: OperationId::new("admin-grant-6650a0000000000000000001-1").unwrap(),
        source: None,
    };
    let first = grant_in_a_process(&server, 1, &input).await;
    assert!(
        matches!(first, IngestOutcome::OutcomeUnknown { .. }),
        "{first:?}"
    );
    let committed = ledger.0.lock().unwrap().len();
    assert_eq!(committed, 1, "Polar committed it");
    // The process restarts and the caller retries with what it persisted.
    let retried = grant_in_a_process(&server, 2, &input).await;
    assert_eq!(retried, IngestOutcome::Done { message: None });
    let stored = ledger.0.lock().unwrap().clone();
    assert_eq!(
        stored.len(),
        1,
        "the retry repeated the same grant: {stored:?}"
    );
    assert_eq!(stored[0], "admin-grant-6650a0000000000000000001-1");
    let bodies: Vec<String> = server.requests().iter().map(|r| r.body_text()).collect();
    assert_eq!(bodies.len(), 2);
    assert_eq!(bodies[0], bodies[1], "the retry sent the same event");
}
