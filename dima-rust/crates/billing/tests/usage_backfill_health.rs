//! The backfill queue and its jobs, the sweep, the queue health figures, the report of the
//! usage events Polar refused for good with their resolution once per operation, and the flush
//! of channels that have gone quiet, against the local stores and a loopback Polar.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod usage_support;

use anyhow::Result;
use dima_billing::NoopObserver;
use dima_billing::Observer;
use dima_billing::plans::credits_cache::CreditsCache;
use dima_billing::polar::flush::{Flush, FlushEnd, dead_letter_key, lease_key, queue_key};
use dima_billing::polar::{
    AcceptedUsage, Ingest, IngestMode, OperationId, PolarClient, UsageEventInput, UsageSink,
};
use dima_billing::usage_backfill::{
    Backfill, BackfillConfig, BackfillQueue, BackfillTick, EnqueueInput, Reason,
};
use dima_billing::usage_health::{
    HealthConfig, QuietFlush, QuietFlushConfig, Resolve, ScanBounds, dead_letter_report,
    monitor_queues, resolve_dead_letter,
};
use dima_core::SecretString;
use dima_http::HttpClient;
use dima_http::testing::{MockResponse, MockServer, RecordedRequest};
use futures_util::future::BoxFuture;
use serde_json::{Map, Value, json};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use usage_support::{DAY, Env, NOW, ledger_state, support};

const CUSTOMER: &str = "cus_backfill_1";

/// A loopback Polar: ingest stores events; the events list answers `events`, or fails with
/// `status` while it is set.
#[derive(Clone, Default)]
struct Polar {
    stored: Arc<Mutex<Vec<Value>>>,
    events: Arc<Mutex<Vec<Value>>>,
    status: Arc<Mutex<Option<u16>>>,
}

async fn mock(polar: Polar) -> MockServer {
    let server = MockServer::start().await.unwrap();
    server.fallback(move |request: &RecordedRequest| {
        if request.path() == "/v1/events/ingest" {
            let body: Value = serde_json::from_str(&request.body_text()).unwrap_or(Value::Null);
            let events = body["events"].as_array().cloned().unwrap_or_default();
            let count = events.len();
            polar.stored.lock().unwrap().extend(events);
            return MockResponse::json(200, &format!(r#"{{"inserted":{count},"duplicates":0}}"#));
        }
        if let Some(status) = *polar.status.lock().unwrap() {
            return MockResponse::json(status, "{}");
        }
        let query = request.query().unwrap_or("");
        let items = if query.contains("source=user") {
            polar.events.lock().unwrap().clone()
        } else {
            Vec::new()
        };
        MockResponse::json(
            200,
            &json!({"items": items, "pagination": {"max_page": 1}}).to_string(),
        )
    });
    server
}

fn client(server: &MockServer) -> PolarClient {
    PolarClient::new(
        HttpClient::builder().build().unwrap(),
        server
            .provider(PolarClient::provider(&Default::default()))
            .unwrap(),
        Some(SecretString::from("t")),
    )
}

fn usage_event(id: &str, at: i64, credits: f64) -> Value {
    json!({"id": format!("polar-{id}"), "name": "ai_usage", "source": "user", "timestamp": dima_text::to_iso_string(at).unwrap(),
        "metadata": {"schema_version": 1, "entry_id": id, "request_id": id, "entry_kind": "usage", "category": "tts", "operation": "synthesize", "provider": "fish", "credits": credits}})
}

#[derive(Default)]
struct Log(Mutex<Vec<String>>);

impl Observer for Log {
    fn error(&self, operation: &'static str, message: &str) {
        self.0
            .lock()
            .unwrap()
            .push(format!("{operation}: {message}"));
    }
}

#[tokio::test]
async fn backfill_jobs_are_deduplicated_synced_skipped_and_dead_lettered() -> Result<()> {
    support::with_mongo(|store| async move {
        let env = Env::new(store).await?;
        let channel = support::channel_id();
        usage_support::user(&env.mongo, &channel, CUSTOMER, "pro").await?;
        let polar_state = Polar::default();
        polar_state.events.lock().unwrap().extend([
            usage_event("aiu_1", NOW - DAY, 40.0),
            usage_event("aiu_2", NOW - 2 * DAY, 2.0),
        ]);
        let server = mock(polar_state.clone()).await;
        let polar = client(&server);
        let keys = env.backfill_keys();
        let config = BackfillConfig {
            job_deadline: Duration::from_secs(120),
            ..BackfillConfig::default()
        };
        let queue = BackfillQueue {
            dragonfly: &env.dragonfly,
            keys: &keys,
            config: &config,
            random: &env.random,
        };
        let log = Log::default();
        let backfill = Backfill {
            queue,
            ledger: env.plain(),
            events: &polar,
            credit_reads: &polar,
            observer: &log,
        };
        let input = EnqueueInput {
            channel_id: &channel,
            customer_id: CUSTOMER,
            plan_tier: Some("pro"),
            coverage_start_ms: None,
            reason: Some(Reason::DailySweep),
            now_ms: NOW,
        };
        let (first, job) = queue.enqueue(&input).await?;
        let (second, _) = queue.enqueue(&input).await?;
        assert!(
            first && !second,
            "one job per channel and customer at a time"
        );
        assert_eq!(
            dima_text::to_iso_string(job.coverage_start_ms).unwrap(),
            "2026-08-15T00:00:00.000Z"
        );
        let tick = backfill.run_one().await?;
        let BackfillTick::Synced(result) = tick else {
            panic!("{tick:?}")
        };
        assert_eq!(result.transaction_count, 2);
        assert_eq!(ledger_state(&env.mongo).await?[0].len(), 2);
        assert!(
            env.dragonfly
                .get_text(&keys.dedupe(&channel, CUSTOMER))
                .await?
                .is_none(),
            "dedupe freed"
        );
        assert_eq!(backfill.run_one().await?, BackfillTick::Idle);
        // A fresh ledger is left alone (a sweep's freshness is a day).
        queue.enqueue(&input).await?;
        let BackfillTick::Synced(fresh) = backfill.run_one().await? else {
            panic!()
        };
        assert!(!fresh.synced);
        // The channel moved to another customer: settled without reading Polar.
        let other = EnqueueInput {
            customer_id: "cus_other",
            ..input
        };
        queue.enqueue(&other).await?;
        assert_eq!(backfill.run_one().await?, BackfillTick::Skipped);
        // Not a job.
        env.dragonfly
            .rpush(&keys.jobs.queue, &[b"{".as_slice()])
            .await?;
        assert_eq!(backfill.run_one().await?, BackfillTick::Invalid);
        assert_eq!(env.list(&keys.jobs.dead).await?, ["{"]);
        // Polar fails: three attempts, then the dead-letter list, and the dedupe key is freed.
        *polar_state.status.lock().unwrap() = Some(500);
        env.clock.advance(61_000);
        let page_view = EnqueueInput {
            reason: None,
            now_ms: NOW + 61_000,
            ..input
        };
        queue.enqueue(&page_view).await?;
        for attempt in 1..=3 {
            let BackfillTick::Failed { dead, .. } = backfill.run_one().await? else {
                panic!("attempt {attempt}")
            };
            assert_eq!(dead, attempt == 3);
        }
        assert_eq!(env.list(&keys.jobs.dead).await?.len(), 2);
        assert!(
            env.dragonfly
                .get_text(&keys.dedupe(&channel, CUSTOMER))
                .await?
                .is_none()
        );
        assert!(
            log.0
                .lock()
                .unwrap()
                .iter()
                .any(|m| m.contains("exhausted retries"))
        );
        env.cleanup(&[&channel]).await
    })
    .await
}

#[tokio::test]
async fn the_sweep_asks_once_for_every_channel_with_a_customer() -> Result<()> {
    support::with_mongo(|store| async move {
        let env = Env::new(store).await?;
        let (a, b) = (support::channel_id(), support::channel_id());
        usage_support::user(&env.mongo, &a, CUSTOMER, "premium").await?;
        usage_support::user(&env.mongo, &b, "cus_two", "free").await?;
        env.mongo.documents("users").insert_one(bson::doc! {"accounts": [{"type": "twitch", "id": "no-customer"}], "polar_sh_customer_id": ""}).await?;
        let server = mock(Polar::default()).await;
        let polar = client(&server);
        let keys = env.backfill_keys();
        let config = BackfillConfig { sweep_page: 1, ..BackfillConfig::default() };
        let queue = BackfillQueue { dragonfly: &env.dragonfly, keys: &keys, config: &config, random: &env.random };
        let backfill = Backfill { queue, ledger: env.plain(), events: &polar, credit_reads: &polar, observer: &NoopObserver };
        assert_eq!(backfill.enqueue_sweep(Reason::StartupSweep).await?, 2);
        assert!(env.dragonfly.get_text(&keys.sweep_lock).await?.is_none(), "released");
        assert_eq!(backfill.enqueue_sweep(Reason::DailySweep).await?, 0, "already waiting");
        let jobs = env.list(&keys.jobs.queue).await?;
        assert_eq!(jobs.len(), 2);
        assert!(jobs.iter().all(|j| j.contains("\"reason\":\"startup_sweep\"")));
        env.cleanup(&[&a, &b]).await
    })
    .await
}

#[tokio::test]
async fn queue_health_reports_ages_stalls_dead_letters_and_failures() -> Result<()> {
    let Some(dragonfly) = support::dragonfly(9).await? else {
        return Ok(());
    };
    let prefix = format!("t{}:", support::channel_id());
    let keys = dima_billing::usage_receipts::receipt_keys_prefixed(&prefix);
    let old = json!({"id": "x", "enqueuedAt": dima_text::to_iso_string(NOW - 1_000_000).unwrap()})
        .to_string();
    dragonfly.rpush(&keys.queue, &[old.as_bytes()]).await?;
    dragonfly
        .rpush(&keys.processing, &[b"claimed".as_slice()])
        .await?;
    dragonfly.rpush(&keys.dead, &[b"dead".as_slice()]).await?;
    let since = (NOW - 950_000).to_string();
    dragonfly
        .hset(
            &keys.health,
            &[
                ("processingSince", since.as_bytes()),
                ("failures", b"4".as_slice()),
            ],
        )
        .await?;
    let log = Log::default();
    let statuses =
        monitor_queues(&dragonfly, &[&keys], &HealthConfig::default(), NOW, &log).await?;
    let status = &statuses[0];
    assert_eq!((status.pending, status.processing, status.dead), (1, 1, 1));
    assert_eq!(status.oldest_age_seconds, 1000.0);
    assert_eq!(status.processing_age_seconds, 950.0);
    assert_eq!(
        status.reasons,
        [
            "queue_age",
            "processing_stalled",
            "dead_letters",
            "repeated_failures"
        ]
    );
    let snapshot: Value =
        serde_json::from_str(&dragonfly.get_text(&keys.snapshot()).await?.unwrap())?;
    assert_eq!(snapshot["checkedAt"], "2026-11-12T12:00:00.000Z");
    // The failures were observed: the next check no longer repeats that reason, and one alert
    // per five minutes.
    let again = monitor_queues(
        &dragonfly,
        &[&keys],
        &HealthConfig::default(),
        NOW + 1000,
        &log,
    )
    .await?;
    assert!(!again[0].reasons.contains(&"repeated_failures"));
    assert_eq!(log.0.lock().unwrap().len(), 1);
    support::cleanup(&dragonfly, &prefix).await
}

#[tokio::test]
async fn dead_letters_are_reported_and_resolved_once_per_operation() -> Result<()> {
    let Some(dragonfly) = support::dragonfly(9).await? else {
        return Ok(());
    };
    let base = support::channel_id();
    let (a, b) = (format!("{base}1"), format!("{base}2"));
    let entry = |reason: &str, at: i64, id: &str, credits: f64| {
        format!(
            "{}\n{}",
            json!({"reason": reason, "at": at}),
            json!({"name": "ai_usage", "customerId": "c", "externalId": id, "metadata": {"credits": credits}, "queuedAt": at - 5})
        )
    };
    let (a1, a2) = (
        entry("Polar refused it (422 missing)", NOW - 9000, "e1", 150.0),
        entry("not a queued usage event", NOW - 100, "e2", 2.0),
    );
    let b1 = entry("Polar refused it (422 missing)", NOW - 50, "e3", 7.0);
    dragonfly
        .rpush(&dead_letter_key(&a), &[a1.as_bytes(), a2.as_bytes()])
        .await?;
    dragonfly
        .rpush(&dead_letter_key(&b), &[b1.as_bytes()])
        .await?;
    let bounds = ScanBounds {
        pattern: format!("twitch:{base}*:ai:polarshevent*"),
        count: 50,
        pages: 1000,
    };
    let report = dead_letter_report(&dragonfly, &bounds, "0").await?;
    assert!(report.complete);
    assert_eq!(report.total_count, 3);
    assert_eq!(report.total_credits, 159.0);
    assert_eq!(
        report.reasons.get("Polar refused it (422 missing)"),
        Some(&2)
    );
    let channel_a = report.channels.iter().find(|c| c.channel_id == a).unwrap();
    assert_eq!(
        (channel_a.count, channel_a.oldest_at_ms, channel_a.credits),
        (2, Some(NOW - 9000), 152.0)
    );
    // Requeue a1 under an operation id; a repeat changes nothing.
    let op = OperationId::new("op-requeue-1")?;
    let first = resolve_dead_letter(&dragonfly, &a, a1.as_bytes(), &op, Resolve::Requeue).await?;
    assert_eq!(
        (first.outcome.as_str(), first.repeated),
        ("requeued", false)
    );
    let repeat = resolve_dead_letter(&dragonfly, &a, a1.as_bytes(), &op, Resolve::Requeue).await?;
    assert_eq!(
        (repeat.outcome.as_str(), repeat.repeated),
        ("requeued", true)
    );
    let queued: Vec<Vec<u8>> = dragonfly
        .query(redis::cmd("LRANGE").arg(queue_key(&a)).arg(0).arg(-1))
        .await?;
    assert_eq!(queued.len(), 1, "requeued once");
    assert_eq!(
        serde_json::from_slice::<Value>(&queued[0])?["externalId"],
        "e1"
    );
    // The same operation id for another entry is a conflict; a settle drops its entry.
    let reused = resolve_dead_letter(&dragonfly, &a, a2.as_bytes(), &op, Resolve::Settle).await?;
    assert_eq!(reused.outcome, "conflict");
    let settle = resolve_dead_letter(
        &dragonfly,
        &a,
        a2.as_bytes(),
        &OperationId::new("op-settle-1")?,
        Resolve::Settle,
    )
    .await?;
    assert_eq!(settle.outcome, "settled");
    let missing = resolve_dead_letter(
        &dragonfly,
        &b,
        a2.as_bytes(),
        &OperationId::new("op-missing-1")?,
        Resolve::Settle,
    )
    .await?;
    assert_eq!(missing.outcome, "missing");
    let after = dead_letter_report(&dragonfly, &bounds, "0").await?;
    assert_eq!(after.total_count, 1);
    for operation in ["op-requeue-1", "op-settle-1", "op-missing-1"] {
        dragonfly
            .del(&[&dima_billing::usage_health::resolution_key(
                &OperationId::new(operation)?,
            )])
            .await?;
    }
    support::cleanup(&dragonfly, &base).await
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

#[tokio::test]
async fn channels_that_went_quiet_are_flushed() -> Result<()> {
    let Some(dragonfly) = support::dragonfly(9).await? else {
        return Ok(());
    };
    let base = support::channel_id();
    let (quiet, recent, busy) = (format!("{base}1"), format!("{base}2"), format!("{base}3"));
    let polar_state = Polar::default();
    let server = mock(polar_state.clone()).await;
    let polar = client(&server);
    let clock = dima_core::ManualClock::new(NOW - 120_000);
    let random = dima_core::SeededRandom::new(11);
    let credits = CreditsCache::new(
        dragonfly.clone(),
        Arc::new(clock.clone()),
        Arc::new(NoopObserver),
    );
    let ingest = Ingest {
        polar: &polar,
        dragonfly: &dragonfly,
        credits: &credits,
        sink: &NoSink,
        random: &random,
        clock: &clock,
        observer: &NoopObserver,
    };
    let usage = |channel: &str, id: &str| UsageEventInput {
        customer_id: "cus_q".into(),
        channel_id: Some(channel.into()),
        external_id: Some(id.into()),
        cost: 0.001,
        reason: "messages".into(),
        ..Default::default()
    };
    // Cache mode queues without flushing: the quiet channel's event is two minutes old.
    assert!(
        !ingest
            .ingest_usage(&usage(&quiet, "q1"), IngestMode::Cache)
            .await
            .is_error()
    );
    assert!(
        !ingest
            .ingest_usage(&usage(&busy, "b1"), IngestMode::Cache)
            .await
            .is_error()
    );
    clock.set(NOW);
    assert!(
        !ingest
            .ingest_usage(&usage(&recent, "r1"), IngestMode::Cache)
            .await
            .is_error()
    );
    dragonfly
        .set(&lease_key(&busy), b"another-flush", Default::default())
        .await?;
    let flush = Flush {
        polar: &polar,
        dragonfly: &dragonfly,
        random: &random,
        clock: &clock,
        observer: &NoopObserver,
    };
    let config = QuietFlushConfig {
        scan: ScanBounds {
            pattern: format!("twitch:{base}*:ai:polarshevent*"),
            count: 50,
            pages: 1000,
        },
        ..QuietFlushConfig::default()
    };
    let quiet_flush = QuietFlush {
        flush,
        dragonfly: &dragonfly,
        config: &config,
    };
    let report = quiet_flush.tick("0").await?;
    assert_eq!(
        report
            .flushed
            .iter()
            .map(|(c, r)| (c.as_str(), r.end.clone(), r.sent))
            .collect::<Vec<_>>(),
        [(quiet.as_str(), FlushEnd::Drained, 1)]
    );
    assert_eq!(report.busy, 1);
    assert_eq!(report.next_cursor, "0", "the walk completed");
    // A minute later the other channel is quiet too.
    clock.advance(61_000);
    dragonfly.del(&[&lease_key(&busy)]).await?;
    let report = quiet_flush.tick("0").await?;
    let mut flushed: Vec<&str> = report.flushed.iter().map(|(c, _)| c.as_str()).collect();
    flushed.sort_unstable();
    let mut expected = vec![recent.as_str(), busy.as_str()];
    expected.sort_unstable();
    assert_eq!(flushed, expected);
    let ids: Vec<String> = polar_state
        .stored
        .lock()
        .unwrap()
        .iter()
        .map(|e| e["external_id"].as_str().unwrap().to_owned())
        .collect();
    assert_eq!(ids.len(), 3);
    assert!(
        quiet_flush.tick("0").await?.flushed.is_empty(),
        "nothing waits"
    );
    support::cleanup(&dragonfly, &base).await
}
