//! The receipt queue and its consumer against the local stores: each receipt is applied once
//! whatever delivers it (twice by the queue, by two consumer processes at once, by the queue and
//! the backfill), a stop at any write of the consumer is recovered by the next call, a receipt
//! that keeps failing ends in the dead-letter list, and the chain from a use to a settled
//! receipt recovers from a stop between its stores.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod usage_support;

use anyhow::{Context, Result};
use bson::{Bson, doc};
use dima_billing::NoopObserver;
use dima_billing::plans::credits_cache::CreditsCache;
use dima_billing::polar::{
    AcceptedUsage, Ingest, IngestMode, PolarClient, UsageEventInput, UsageSink,
};
use dima_billing::usage_backfill::{
    Backfill, BackfillConfig, BackfillQueue, BackfillTick, EnqueueInput,
};
use dima_billing::usage_ledger::LedgerConfig;
use dima_billing::usage_ledger::receipt::{QueuedReceipt, parse_queued_receipt};
use dima_billing::usage_receipts::{
    ConsumerConfig, NoTracker, ReceiptConsumer, ReceiptQueue, ReceiptSink, SettleEnd,
};
use dima_core::{ManualClock, SecretString, SeededRandom};
use dima_http::HttpClient;
use dima_http::testing::{MockResponse, MockServer, RecordedRequest};
use dima_store::dragonfly::QueueItem;
use dima_store::mongo::{MongoConfig, MongoStore};
use futures_util::future::BoxFuture;
use serde_json::{Map, Value, json};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use usage_support::{DAY, Env, Killer, NOW, ledger_state, support};

const CUSTOMER: &str = "cus_receipts_1";

fn receipt_text(
    channel: &str,
    id: &str,
    occurred_at: i64,
    credits: f64,
    enqueued_at: i64,
) -> String {
    format!(
        r#"{{"channelID":"{channel}","customerId":"{CUSTOMER}","id":"{id}","requestId":"req-{id}","occurredAt":"{}","entryKind":"usage","category":"ai_chat","operation":"message","source":"chat","adjustmentType":null,"provider":"openrouter","model":"openai/gpt-x","quantity":42,"unit":"tokens","credits":{credits},"resourceType":null,"resourceId":null,"itemized":true,"enqueuedAt":"{}"}}"#,
        dima_text::to_iso_string(occurred_at).unwrap(),
        dima_text::to_iso_string(enqueued_at).unwrap(),
    )
}

async fn push(env: &Env, texts: &[String]) -> Result<()> {
    let keys = env.receipt_keys();
    for text in texts {
        env.dragonfly.rpush(&keys.queue, &[text.as_bytes()]).await?;
    }
    Ok(())
}

fn consumer_config() -> ConsumerConfig {
    ConsumerConfig {
        // Generous on a busy machine (production: 20 s and 60 s).
        job_deadline: Duration::from_secs(60),
        tick_deadline: Duration::from_secs(120),
        ..ConsumerConfig::default()
    }
}

#[tokio::test]
async fn a_batch_is_settled_and_what_is_not_a_receipt_is_set_aside() -> Result<()> {
    support::with_mongo(|store| async move {
        let env = Env::new(store).await?;
        let channel = support::channel_id();
        let keys = env.receipt_keys();
        let config = consumer_config();
        let consumer = ReceiptConsumer {
            ledger: env.plain(),
            keys: &keys,
            config: &config,
            random: &env.random,
            observer: &NoopObserver,
        };
        let mut texts: Vec<String> = (0..3)
            .map(|i| receipt_text(&channel, &format!("aiu_{i}"), NOW - 3_600_000, 10.0, NOW))
            .collect();
        texts.push("not json".into());
        // The same receipt queued again later (other bytes, same entry id).
        texts.push(receipt_text(
            &channel,
            "aiu_0",
            NOW - 3_600_000,
            10.0,
            NOW + 5,
        ));
        push(&env, &texts).await?;
        let report = consumer.settle_batch().await?;
        assert_eq!(
            (
                report.claimed,
                report.inserted,
                report.duplicates,
                report.dead_lettered
            ),
            (5, 3, 1, 1),
            "{report:?}"
        );
        assert_eq!(report.end, SettleEnd::Drained);
        assert!(env.list(&keys.queue).await?.is_empty());
        assert!(env.list(&keys.processing).await?.is_empty());
        assert_eq!(env.list(&keys.dead).await?, ["not json"]);
        let state = ledger_state(&env.mongo).await?;
        assert_eq!(state[0].len(), 3);
        assert_eq!(state[1][0].get("transactionCount"), Some(&Bson::Int32(3)));
        assert!(
            env.dragonfly.get_text(&keys.lease).await?.is_none(),
            "released"
        );
        assert_eq!(consumer.settle_batch().await?.claimed, 0);
        env.cleanup(&[&channel]).await
    })
    .await
}

#[tokio::test]
async fn a_receipt_that_keeps_failing_is_retried_then_dead_lettered() -> Result<()> {
    support::with_mongo(|store| async move {
        let mut env = Env::new(store).await?;
        env.config.lock_wait = Duration::from_millis(100);
        let channel = support::channel_id();
        let keys = env.receipt_keys();
        let config = consumer_config();
        let consumer = ReceiptConsumer {
            ledger: env.plain(),
            keys: &keys,
            config: &config,
            random: &env.random,
            observer: &NoopObserver,
        };
        let text = receipt_text(&channel, "aiu_busy", NOW - 60_000, 3.0, NOW);
        push(&env, std::slice::from_ref(&text)).await?;
        // Another writer holds the account lock for the whole test.
        let lock = dima_billing::usage_ledger::lock::lock_key(&channel, CUSTOMER);
        env.dragonfly
            .set(&lock, b"other", Default::default())
            .await?;
        for attempt in 1..=3 {
            let report = consumer.settle_batch().await?;
            if attempt < 3 {
                assert_eq!(report.retried, 1, "attempt {attempt}");
                assert_eq!(env.list(&keys.queue).await?, [text.clone()]);
            } else {
                assert_eq!(report.dead_lettered, 1);
            }
        }
        assert_eq!(env.list(&keys.dead).await?, [text.clone()]);
        assert!(env.list(&keys.queue).await?.is_empty());
        assert!(
            env.dragonfly
                .get_text(&keys.attempts(text.as_bytes()))
                .await?
                .is_none(),
            "counter dropped"
        );
        let failures = env.dragonfly.hgetall(&keys.health).await?;
        assert!(
            failures.contains(&("failures".into(), "3".into())),
            "{failures:?}"
        );
        assert!(ledger_state(&env.mongo).await?[0].is_empty());
        env.dragonfly.del(&[&lock]).await?;
        env.cleanup(&[&channel]).await
    })
    .await
}

/// A stop at every write of a batch (the claim, each ledger write, each settlement), then the
/// next call: the ledger ends as after one clean batch and the lists are empty.
#[tokio::test]
async fn a_stop_at_every_write_of_the_consumer_is_recovered_by_the_next_call() -> Result<()> {
    support::with_mongo(|store| async move {
        let env = Env::new(store).await?;
        let channel = support::channel_id();
        let keys = env.receipt_keys();
        let config = consumer_config();
        let texts = vec![
            receipt_text(&channel, "aiu_x", NOW - 3_600_000, 10.0, NOW),
            receipt_text(&channel, "aiu_y", NOW - 7_200_000, 20.0, NOW),
        ];
        let reset = || async {
            for name in [
                "ai_usage_receipts",
                "ai_usage_dailies",
                "ai_usage_dashboards",
            ] {
                env.mongo.documents(name).delete_many(doc! {}).await?;
            }
            env.cleanup(&[&channel]).await?;
            push(&env, &texts).await?;
            anyhow::Ok(())
        };
        reset().await?;
        let counter = usage_support::Counter::default();
        let clean = ReceiptConsumer {
            ledger: env.ledger(&counter),
            keys: &keys,
            config: &config,
            random: &env.random,
            observer: &NoopObserver,
        };
        assert_eq!(clean.settle_batch().await?.inserted, 2);
        let writes = counter.0.lock().unwrap().clone();
        assert_eq!(writes.len(), 11, "{writes:?}");
        let settled = ledger_state(&env.mongo).await?;
        for at in 0..writes.len() {
            reset().await?;
            let killer = Killer::new(at);
            let consumer = ReceiptConsumer {
                ledger: env.ledger(&killer),
                keys: &keys,
                config: &config,
                random: &env.random,
                observer: &NoopObserver,
            };
            assert!(
                killer.run(consumer.settle_batch()).await,
                "stopped at {}",
                writes[at]
            );
            // Every receipt is somewhere: queued, claimed or stored.
            let waiting =
                env.list(&keys.queue).await?.len() + env.list(&keys.processing).await?.len();
            assert!(waiting + ledger_state(&env.mongo).await?[0].len() >= 2);
            env.expire_locks(&channel, CUSTOMER).await?;
            let next = ReceiptConsumer {
                ledger: env.plain(),
                keys: &keys,
                config: &config,
                random: &env.random,
                observer: &NoopObserver,
            };
            let report = next.settle_batch().await?;
            assert_eq!(
                report.claimed, waiting,
                "the next call resumes exactly what was left"
            );
            assert_eq!(
                ledger_state(&env.mongo).await?,
                settled,
                "stopped at {}",
                writes[at]
            );
            assert!(
                env.list(&keys.queue).await?.is_empty()
                    && env.list(&keys.processing).await?.is_empty()
            );
            assert!(env.list(&keys.dead).await?.is_empty());
        }
        env.cleanup(&[&channel]).await
    })
    .await
}

/// The child process of the race below: settles the shared queue with its own lease key (two
/// consumers that each believe they hold the lease, as after a stall) until it is empty.
#[tokio::test]
async fn child_consumer() -> Result<()> {
    let (Ok(database), Ok(prefix), Ok(name)) = (
        std::env::var("DIMA_USAGE_CHILD_DATABASE"),
        std::env::var("DIMA_USAGE_CHILD_PREFIX"),
        std::env::var("DIMA_USAGE_CHILD_NAME"),
    ) else {
        return Ok(());
    };
    let mut config = MongoConfig::new(std::env::var("DIMA_TEST_MONGO_URI")?);
    config.database = Some(database);
    let mongo = MongoStore::connect(&config, None).await?;
    let dragonfly = support::dragonfly(9).await?.context("dragonfly")?;
    let clock = ManualClock::new(NOW);
    let random = SeededRandom::new(name.len() as u64 * 7919);
    let ledger_config = LedgerConfig {
        op_deadline: Duration::from_secs(60),
        ..LedgerConfig::default()
    };
    let ledger = dima_billing::usage_ledger::Ledger {
        mongo: &mongo,
        dragonfly: &dragonfly,
        clock: &clock,
        random: &random,
        config: &ledger_config,
        boundary: &dima_billing::usage_ledger::NoBoundary,
    };
    let mut keys = dima_billing::usage_receipts::receipt_keys_prefixed(&prefix);
    keys.lease = format!("{prefix}lease-{name}");
    let config = ConsumerConfig {
        batch_size: 3,
        ..consumer_config()
    };
    let consumer = ReceiptConsumer {
        ledger,
        keys: &keys,
        config: &config,
        random: &random,
        observer: &NoopObserver,
    };
    let mut settled = 0;
    for _ in 0..500 {
        let report = consumer.settle_batch().await?;
        settled += report.inserted + report.duplicates;
        if report.claimed == 0 {
            break;
        }
    }
    println!("CHILD {name} settled {settled}");
    Ok(())
}

#[tokio::test]
async fn two_consumer_processes_at_once_apply_each_receipt_once() -> Result<()> {
    if std::env::var("DIMA_USAGE_CHILD_NAME").is_ok() {
        return Ok(());
    }
    support::with_mongo(|store| async move {
        let env = Env::new(store).await?;
        let channel = support::channel_id();
        let keys = env.receipt_keys();
        // 30 receipts, a third of them queued twice.
        let mut texts = Vec::new();
        for i in 0..30 {
            texts.push(receipt_text(
                &channel,
                &format!("aiu_{i}"),
                NOW - (i + 1) * 60_000,
                (i + 1) as f64,
                NOW,
            ));
            if i % 3 == 0 {
                texts.push(receipt_text(
                    &channel,
                    &format!("aiu_{i}"),
                    NOW - (i + 1) * 60_000,
                    (i + 1) as f64,
                    NOW + 1,
                ));
            }
        }
        push(&env, &texts).await?;
        let database = env.mongo.database().name().to_owned();
        let exe = std::env::current_exe()?;
        let spawn = |name: &str| {
            tokio::process::Command::new(&exe)
                .args([
                    "--exact",
                    "child_consumer",
                    "--nocapture",
                    "--test-threads",
                    "1",
                ])
                .env("DIMA_USAGE_CHILD_DATABASE", &database)
                .env("DIMA_USAGE_CHILD_PREFIX", &env.prefix)
                .env("DIMA_USAGE_CHILD_NAME", name)
                .kill_on_drop(true)
                .output()
        };
        let (a, b) = tokio::join!(spawn("a"), spawn("b"));
        let (a, b) = (a?, b?);
        assert!(a.status.success() && b.status.success(), "{a:?} {b:?}");
        let state = ledger_state(&env.mongo).await?;
        assert_eq!(state[0].len(), 30, "each receipt stored once");
        let counted: i32 = state[1]
            .iter()
            .map(|d| d.get_i32("transactionCount").unwrap())
            .sum();
        let spent: i32 = state[1]
            .iter()
            .map(|d| d.get_i32("spentCredits").unwrap())
            .sum();
        assert_eq!((counted, spent), (30, (1..=30).sum::<i32>()));
        assert!(
            env.list(&keys.queue).await?.is_empty() && env.list(&keys.processing).await?.is_empty()
        );
        let output = format!(
            "{}{}",
            String::from_utf8_lossy(&a.stdout),
            String::from_utf8_lossy(&b.stdout)
        );
        assert!(
            output.contains("CHILD a settled") && output.contains("CHILD b settled"),
            "{output}"
        );
        env.cleanup(&[&channel]).await
    })
    .await
}

/// Polar as the chain needs it: ingest stores events once per external id; the events list
/// serves them back to the backfill.
#[derive(Clone, Default)]
struct Polar {
    events: Arc<Mutex<Vec<Value>>>,
}

async fn polar_mock(polar: Polar) -> MockServer {
    let server = MockServer::start().await.unwrap();
    server.fallback(move |request: &RecordedRequest| {
        if request.path() == "/v1/events/ingest" {
            let body: Value = serde_json::from_str(&request.body_text()).unwrap_or(Value::Null);
            let mut stored = polar.events.lock().unwrap();
            let (mut inserted, mut duplicates) = (0, 0);
            for event in body["events"].as_array().cloned().unwrap_or_default() {
                let id = event["external_id"].clone();
                if stored.iter().any(|e| e["external_id"] == id) {
                    duplicates += 1;
                } else {
                    inserted += 1;
                    stored.push(event);
                }
            }
            return MockResponse::json(200, &format!(r#"{{"inserted":{inserted},"duplicates":{duplicates}}}"#));
        }
        if request.path() == "/v1/events/" {
            let query = request.query().unwrap_or("");
            let items: Vec<Value> = if query.contains("source=user") && query.contains("page=1") {
                polar.events.lock().unwrap().iter().enumerate().map(|(i, e)| json!({
                    "id": format!("polar-{i}"), "name": e["name"], "source": "user",
                    "timestamp": dima_text::to_iso_string(NOW - 600_000).unwrap(), "metadata": e["metadata"],
                })).collect()
            } else {
                Vec::new()
            };
            return MockResponse::json(200, &json!({"items": items, "pagination": {"max_page": 1}}).to_string());
        }
        MockResponse::json(404, "{}")
    });
    server
}

/// The process stopped between queueing the usage and queueing its receipt: no receipt.
struct Stopped;

impl UsageSink for Stopped {
    fn enqueue_receipt<'a>(
        &'a self,
        _usage: AcceptedUsage<'a>,
    ) -> BoxFuture<'a, Result<(), String>> {
        Box::pin(async { Ok(()) })
    }
    fn track(&self, _usage: AcceptedUsage<'_>, _metadata: &Map<String, Value>) {}
}

/// Use 1 goes through every step; use 2's process stops after the usage was queued and debited,
/// before its receipt was queued. The flush delivers both to Polar; the consumer settles use
/// 1's receipt; the backfill restores use 2's from Polar under the same entry id and finds use
/// 1's already stored. Each receipt is stored once, with the credits Polar was sent.
#[tokio::test]
async fn the_chain_from_a_use_to_a_receipt_recovers_a_stop_between_its_stores() -> Result<()> {
    support::with_mongo(|store| async move {
        let env = Env::new(store).await?;
        let channel = support::channel_id();
        usage_support::user(&env.mongo, &channel, CUSTOMER, "premium").await?;
        let polar_state = Polar::default();
        let server = polar_mock(polar_state.clone()).await;
        let polar = PolarClient::new(
            HttpClient::builder().build()?,
            server.provider(PolarClient::provider(&Default::default()))?,
            Some(SecretString::from("t")),
        );
        let clock = env.clock.clone();
        let credits = CreditsCache::new(
            env.dragonfly.clone(),
            Arc::new(clock.clone()),
            Arc::new(NoopObserver),
        );
        let keys = env.receipt_keys();
        let sink = ReceiptSink {
            queue: ReceiptQueue {
                dragonfly: &env.dragonfly,
                keys: &keys,
                clock: &env.clock,
            },
            tracker: &NoTracker,
        };
        let ingest = |sink: &'static dyn UsageSink| Ingest {
            polar: &polar,
            dragonfly: &env.dragonfly,
            credits: &credits,
            sink,
            random: &env.random,
            clock: &env.clock,
            observer: &NoopObserver,
        };
        let usage = |external: &str| UsageEventInput {
            customer_id: CUSTOMER.into(),
            channel_id: Some(channel.clone()),
            external_id: Some(external.into()),
            cost: 0.002,
            reason: "messages".into(),
            ..Default::default()
        };
        // Use 1: every step.
        let full = Ingest {
            sink: &sink,
            ..ingest(&Stopped)
        };
        assert!(
            !full
                .ingest_usage(&usage("aiu_use_1"), IngestMode::Batch)
                .await
                .is_error()
        );
        // Use 2: stopped before its receipt.
        assert!(
            !ingest(&Stopped)
                .ingest_usage(&usage("aiu_use_2"), IngestMode::Batch)
                .await
                .is_error()
        );
        assert_eq!(
            polar_state.events.lock().unwrap().len(),
            2,
            "both reached Polar"
        );
        assert_eq!(env.list(&keys.queue).await?.len(), 1, "one receipt queued");
        // The consumer settles the queued receipt.
        let config = consumer_config();
        let consumer = ReceiptConsumer {
            ledger: env.plain(),
            keys: &keys,
            config: &config,
            random: &env.random,
            observer: &NoopObserver,
        };
        assert_eq!(consumer.settle_batch().await?.inserted, 1);
        // The backfill (as the usage page asks for it) restores the other from Polar.
        let backfill_keys = env.backfill_keys();
        let backfill_config = BackfillConfig {
            job_deadline: Duration::from_secs(120),
            ..BackfillConfig::default()
        };
        let queue = BackfillQueue {
            dragonfly: &env.dragonfly,
            keys: &backfill_keys,
            config: &backfill_config,
            random: &env.random,
        };
        let (enqueued, _) = queue
            .enqueue(&EnqueueInput {
                channel_id: &channel,
                customer_id: CUSTOMER,
                plan_tier: Some("premium"),
                coverage_start_ms: None,
                reason: None,
                now_ms: NOW,
            })
            .await?;
        assert!(enqueued);
        let backfill = Backfill {
            queue,
            ledger: env.plain(),
            events: &polar,
            credit_reads: &polar,
            observer: &NoopObserver,
        };
        let tick = backfill.run_one().await?;
        assert!(
            matches!(&tick, BackfillTick::Synced(result) if result.transaction_count == 2),
            "{tick:?}"
        );
        let state = ledger_state(&env.mongo).await?;
        let ids: Vec<&str> = state[0]
            .iter()
            .map(|d| d.get_str("entryId").unwrap())
            .collect();
        assert_eq!(ids, ["aiu_use_1", "aiu_use_2"], "each once");
        for receipt in &state[0] {
            assert_eq!(
                receipt.get("credits"),
                Some(&Bson::Int32(2)),
                "Math.ceil(0.002 * 1000)"
            );
        }
        let counted: i32 = state[1]
            .iter()
            .map(|d| d.get_i32("transactionCount").unwrap())
            .sum();
        assert_eq!(counted, 2);
        // The dedupe key was freed: a later page view can ask again.
        assert!(
            env.dragonfly
                .get_text(&backfill_keys.dedupe(&channel, CUSTOMER))
                .await?
                .is_none()
        );
        let _: Option<QueuedReceipt> = parse_queued_receipt(b"{}");
        let _ = (DAY, QueueItem::from_popped(Vec::new()));
        env.cleanup(&[&channel]).await
    })
    .await
}
