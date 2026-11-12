//! `ingestPolarSHEvent`, `grantPolarAiCredits` and `ingestPolarNamedEvents` against the loopback
//! Polar mock and Dragonfly (database 9, unique channel ids): what is sent, queued, projected and
//! receipted, including incomplete answers, a busy lock and Polar failures.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod support;

use dima_billing::NoopObserver;
use dima_billing::plans::credits_cache::CreditsCache;
use dima_billing::polar::{
    AcceptedUsage, GrantInput, Ingest, IngestEvent, IngestMode, IngestOutcome, LlmUsage,
    OperationId, PolarClient, UsageEventInput, UsageSink, build_usage_event,
};
use dima_core::{ManualClock, SecretString};
use dima_http::HttpClient;
use dima_http::testing::{MockResponse, MockServer};
use futures_util::future::BoxFuture;
use serde_json::{Map, Value, json};
use std::sync::{Arc, Mutex};

#[derive(Default)]
struct Sink {
    receipts: Mutex<Vec<(String, String, f64)>>,
    tracked: Mutex<usize>,
}

impl UsageSink for Sink {
    fn enqueue_receipt<'a>(
        &'a self,
        usage: AcceptedUsage<'a>,
    ) -> BoxFuture<'a, Result<(), String>> {
        Box::pin(async move {
            self.receipts.lock().unwrap().push((
                usage.channel_id.into(),
                usage.context.entry_id.clone(),
                usage.credits,
            ));
            Ok(())
        })
    }
    fn track(&self, _usage: AcceptedUsage<'_>, _metadata: &Map<String, Value>) {
        *self.tracked.lock().unwrap() += 1;
    }
}

fn usage(channel: &str, external: &str) -> UsageEventInput {
    UsageEventInput {
        customer_id: "cus_1".into(),
        channel_id: Some(channel.into()),
        external_id: Some(external.into()),
        cost: 0.0015,
        reason: "messages".into(),
        llm: Some(LlmUsage {
            model: "openai/gpt-4o".into(),
            prompt_tokens: Some(10.0),
            completion_tokens: Some(5.0),
            total_tokens: Some(15.0),
        }),
        ..Default::default()
    }
}

fn body_of(events: &[IngestEvent]) -> String {
    let wire: Vec<Value> = events.iter().map(|e| e.wire().unwrap()).collect();
    dima_text::to_js_json(&json!({"events": wire}))
}

#[tokio::test]
async fn ingest_modes_queue_flush_and_project_as_the_reference() {
    let Some(dragonfly) = support::dragonfly(9).await.unwrap() else {
        return;
    };
    let server = MockServer::start().await.unwrap();
    let polar = PolarClient::new(
        HttpClient::builder().build().unwrap(),
        server
            .provider(PolarClient::provider(&Default::default()))
            .unwrap(),
        Some(SecretString::from("t")),
    );
    let clock = Arc::new(ManualClock::new(1_793_000_000_000));
    let credits = CreditsCache::new(dragonfly.clone(), clock, Arc::new(NoopObserver));
    let sink = Sink::default();
    let random = support::ZeroRandom;
    let ingest = Ingest {
        polar: &polar,
        dragonfly: &dragonfly,
        credits: &credits,
        sink: &sink,
        random: &random,
        observer: &NoopObserver,
    };
    let channel = support::channel_id();
    let queue = format!("twitch:{channel}:ai:polarshevent");
    let snapshot = r#"{"version":3,"used":0,"limit":25000,"balance":5000,"meterId":"m","updatedAt":"x","available":true,"status":"available"}"#;
    dragonfly
        .set(
            &format!("twitch:{channel}:ai:credits"),
            snapshot.as_bytes(),
            dima_store::dragonfly::SetOptions::ex(300),
        )
        .await
        .unwrap();
    let llen = |q: String| {
        let dragonfly = dragonfly.clone();
        async move {
            dragonfly
                .query::<i64>(redis::cmd("LLEN").arg(q))
                .await
                .unwrap()
        }
    };

    // Immediate: one event, projected and receipted once Polar stored it.
    server.push(MockResponse::json(200, r#"{"inserted":1,"duplicates":0}"#));
    let input = usage(&channel, "aiu_immediate");
    assert_eq!(
        ingest.ingest_usage(&input, IngestMode::Immediate).await,
        IngestOutcome::Done { message: None }
    );
    let (event, _) = build_usage_event(&input, &random).unwrap();
    let sent = server.wait_for(1).await;
    assert_eq!(sent[0].body_text(), body_of(std::slice::from_ref(&event)));
    assert_eq!(event.metadata["credits"], json!(150.0));
    assert_eq!(
        sink.receipts.lock().unwrap().last().map(|r| r.2),
        Some(150.0)
    );
    let after: Value = serde_json::from_str(
        &dragonfly
            .get_text(&format!("twitch:{channel}:ai:credits"))
            .await
            .unwrap()
            .unwrap(),
    )
    .unwrap();
    assert_eq!(after["balance"], json!(4850));
    assert_eq!(llen(queue.clone()).await, 0);

    // Polar failing: nothing projected, nothing receipted. A 5xx to a write may have been
    // applied, so it is an unknown outcome (item 7), with the reference's message.
    server.push(MockResponse::json(500, "{}"));
    let outcome = ingest
        .ingest_usage(&usage(&channel, "aiu_failed"), IngestMode::Immediate)
        .await;
    assert!(
        matches!(outcome, IngestOutcome::OutcomeUnknown { ref message } if message == "Polar API error 500"),
        "{outcome:?}"
    );
    assert_eq!(sink.receipts.lock().unwrap().len(), 1);

    // Cache: queued and projected, nothing sent.
    assert_eq!(
        ingest
            .ingest_usage(&usage(&channel, "aiu_cached"), IngestMode::Cache)
            .await,
        IngestOutcome::Done { message: None }
    );
    assert_eq!(llen(queue.clone()).await, 1);
    assert_eq!(server.requests().len(), 2);

    // Batch with an incomplete answer: both stay queued; the next batch resends all and trims.
    server.push(MockResponse::json(200, r#"{"inserted":1,"duplicates":0}"#));
    let outcome = ingest
        .ingest_usage(&usage(&channel, "aiu_batch_1"), IngestMode::Batch)
        .await;
    assert_eq!(
        outcome,
        IngestOutcome::Failed {
            message: "PolarSH ingest incomplete".into()
        }
    );
    assert_eq!(llen(queue.clone()).await, 2);
    server.push(MockResponse::json(200, r#"{"inserted":2,"duplicates":1}"#));
    assert_eq!(
        ingest
            .ingest_usage(&usage(&channel, "aiu_batch_2"), IngestMode::Batch)
            .await,
        IngestOutcome::Done { message: None }
    );
    let sent = server.wait_for(4).await;
    let flushed: Value = serde_json::from_str(&sent[3].body_text()).unwrap();
    let ids: Vec<_> = flushed["events"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["external_id"].as_str().unwrap().to_owned())
        .collect();
    assert_eq!(ids, ["aiu_cached", "aiu_batch_1", "aiu_batch_2"]);
    assert_eq!(llen(queue.clone()).await, 0);
    assert!(
        dragonfly
            .get_text(&format!("locks:polar-ingest:{channel}"))
            .await
            .unwrap()
            .is_none(),
        "lock released"
    );

    // A busy lock: the event is queued and projected, nothing is sent.
    dragonfly
        .set(
            &format!("locks:polar-ingest:{channel}"),
            b"other",
            dima_store::dragonfly::SetOptions::ex(30),
        )
        .await
        .unwrap();
    let outcome = ingest
        .ingest_usage(&usage(&channel, "aiu_busy"), IngestMode::Batch)
        .await;
    assert_eq!(
        outcome,
        IngestOutcome::Done {
            message: Some("queued (flush in progress)")
        }
    );
    assert_eq!(llen(queue.clone()).await, 1);
    assert_eq!(server.requests().len(), 4);

    // Validation before anything happens.
    let mut no_channel = usage(&channel, "x");
    no_channel.channel_id = None;
    assert_eq!(
        ingest.ingest_usage(&no_channel, IngestMode::Batch).await,
        IngestOutcome::Failed {
            message: "channelID is required for batch/cache modes".into()
        }
    );

    // Grants: negative usage, receipted with the channel.
    server.push(MockResponse::json(200, r#"{"inserted":1}"#));
    let grant = GrantInput {
        customer_id: "cus_1".into(),
        channel_id: Some(channel.clone()),
        credits: 500.9,
        reason: "support".into(),
        admin_login: None,
        operation_id: OperationId::new("grant-op-1").unwrap(),
        source: None,
    };
    assert_eq!(
        ingest.grant_ai_credits(&grant).await,
        IngestOutcome::Done { message: None }
    );
    let sent = server.wait_for(5).await;
    assert!(sent[4].body_text().contains(r#""credits":-500"#));
    assert_eq!(
        sink.receipts.lock().unwrap().last().map(|r| r.2),
        Some(-500.0)
    );
    let refused = GrantInput {
        credits: 0.5,
        ..grant
    };
    assert_eq!(
        ingest.grant_ai_credits(&refused).await,
        IngestOutcome::Failed {
            message: "credits must be a positive number".into()
        }
    );

    // Named events: never credits; incomplete answers are errors.
    let named = IngestEvent {
        name: "ai_assistant".into(),
        customer_id: "cus_1".into(),
        external_id: "n1".into(),
        metadata: json!({"tokens": 3}).as_object().cloned().unwrap(),
    };
    server.push(MockResponse::json(200, r#"{"inserted":0,"duplicates":0}"#));
    let error = ingest
        .ingest_named_events(std::slice::from_ref(&named))
        .await
        .unwrap_err();
    assert_eq!(
        error.to_string(),
        "PolarSH ingest incomplete (0 inserted, 0 duplicates of 1)"
    );
    assert!(error.outcome_unknown());
    let mut credit = named.clone();
    credit.metadata.insert("credits".into(), json!(1));
    let error = ingest.ingest_named_events(&[credit]).await.unwrap_err();
    assert_eq!(
        error.to_string(),
        "ingestPolarNamedEvents must not send AI credit usage"
    );
    assert!(!error.outcome_unknown());

    support::cleanup(&dragonfly, &channel).await.unwrap();
}

// Item 7 of P2-BILLING-01b (review finding 9): a write Polar may have applied (a success answer
// that cannot be read, a 5xx, a lost reply) reaches the caller as `OutcomeUnknown`, not as a
// message; nothing is projected or receipted for it.
#[tokio::test]
async fn an_ambiguous_answer_reaches_the_caller_as_an_unknown_outcome() {
    let Some(dragonfly) = support::dragonfly(9).await.unwrap() else {
        return;
    };
    let server = MockServer::start().await.unwrap();
    let polar = PolarClient::new(
        HttpClient::builder().build().unwrap(),
        server
            .provider(PolarClient::provider(&Default::default()))
            .unwrap(),
        Some(SecretString::from("t")),
    );
    let clock = Arc::new(ManualClock::new(1_793_000_000_000));
    let credits = CreditsCache::new(dragonfly.clone(), clock, Arc::new(NoopObserver));
    let sink = Sink::default();
    let random = support::ZeroRandom;
    let ingest = Ingest {
        polar: &polar,
        dragonfly: &dragonfly,
        credits: &credits,
        sink: &sink,
        random: &random,
        observer: &NoopObserver,
    };
    let channel = support::channel_id();
    for answer in [
        MockResponse::json(200, "not json"),
        MockResponse::json(502, "{}"),
        MockResponse::drop_connection(),
    ] {
        server.push(answer);
        let outcome = ingest
            .ingest_usage(&usage(&channel, "aiu_unknown"), IngestMode::Immediate)
            .await;
        assert!(
            matches!(outcome, IngestOutcome::OutcomeUnknown { .. }),
            "{outcome:?}"
        );
    }
    server.push(MockResponse::json(422, "{}"));
    let outcome = ingest
        .ingest_usage(&usage(&channel, "aiu_refused"), IngestMode::Immediate)
        .await;
    assert!(
        matches!(outcome, IngestOutcome::Failed { .. }),
        "{outcome:?}"
    );
    assert!(sink.receipts.lock().unwrap().is_empty());
    support::cleanup(&dragonfly, &channel).await.unwrap();
}
