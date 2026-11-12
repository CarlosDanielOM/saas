//! Fault cases of the journal, the dispatcher and the cron-job intents (`MIGRATION.md`
//! section 8): the same notification twice in sequence and at once from two instances, a process
//! that dies between writes, a lost wakeup, a duplicate key on each unique index, and MongoDB
//! silent for longer than the deadline.

mod support;

use anyhow::{Result, anyhow, ensure};
use bson::{Document, doc};
use dima_core::{ManualClock, SeededRandom};
use dima_events::config::EventsConfig;
use dima_events::contracts::policy::CONSUMERS;
use dima_events::dispatch::{DispatchEvent, Dispatcher, ensure_delivery};
use dima_events::jobs::{ClaimResult, DurableJobs, JobQueue, JobsConfig, PrepareOptions};
use dima_events::producers::twitch::TwitchNotification;
use dima_events::producers::{IngestError, Journal, Owners, WakeHint};
use dima_events::store::StoreError;
use dima_events::value::{Object, Value};
use dima_model::{cron_job_intents, domain_event_deliveries, domain_events};
use dima_store::dragonfly::QueueItem;
use dima_store::dragonfly::cron_queue::CronQueueJob;
use dima_store::mongo::MongoStore;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;
use support::with_store;

const NOW: i64 = 1_794_392_430_456;

fn object(json: serde_json::Value) -> Object {
    match Value::from_json(&json) {
        Value::Object(object) => object,
        _ => Object::new(),
    }
}

fn follow(message_id: &str) -> TwitchNotification {
    TwitchNotification {
        message_id: message_id.into(),
        message_timestamp: Some("2026-11-11T10:20:29.123456789Z".into()),
        message_retry: Some(0.0),
        stale_retry: Some(false),
        subscription: object(serde_json::json!({ "id": "sub", "type": "channel.follow", "version": "2", "condition": { "broadcaster_user_id": "1001" } })),
        event: Value::Object(object(serde_json::json!({ "broadcaster_user_id": "1001", "user_id": "7", "followed_at": "2026-11-11T10:20:29Z" }))),
        source: None,
        durable_chat_handled: true,
        durable_defense_handled: true,
    }
}

#[derive(Debug, Default)]
struct CountingHint(AtomicUsize);

impl WakeHint for CountingHint {
    fn publish(&self) {
        self.0.fetch_add(1, Ordering::SeqCst);
    }
}

async fn journal(store: &MongoStore, clock: &ManualClock, deadline: Duration) -> Result<Journal> {
    let report = support::indexes(store, &domain_events::INFO).await?;
    let config = EventsConfig { store_deadline: deadline };
    Ok(Journal::new(store.clone(), Arc::new(clock.clone()), &config, &report)?.with_owners(Owners::Fixed(None)))
}

async fn count(store: &MongoStore, collection: &str, filter: Document) -> Result<u64> {
    Ok(store.documents(collection).count_documents(filter).await?)
}

#[tokio::test]
async fn the_same_notification_twice_in_sequence_is_one_event() -> Result<()> {
    with_store(|store| async move {
        let clock = ManualClock::new(NOW);
        let hint = Arc::new(CountingHint::default());
        let journal = journal(&store, &clock, Duration::from_secs(10)).await?.with_wakeups(hint.clone());
        let first = journal.ingest_twitch(&follow("m-1"), None).await?.ok_or_else(|| anyhow!("journaled"))?;
        clock.advance(5_000);
        let second = journal.ingest_twitch(&follow("m-1"), None).await?.ok_or_else(|| anyhow!("journaled"))?;
        ensure!(first.inserted && !second.inserted);
        ensure!(first.event == second.event, "the second delivery returns the stored event");
        ensure!(count(&store, domain_events::COLLECTION, doc! {}).await? == 1);
        // The reference publishes a hint after both (a duplicate may still need a sweep).
        ensure!(hint.0.load(Ordering::SeqCst) == 2);
        Ok(())
    })
    .await
}

#[tokio::test]
async fn the_same_notifications_at_once_from_two_instances_are_one_event_each() -> Result<()> {
    with_store(|store| async move {
        let clock = ManualClock::new(NOW);
        let name = store.database().name().to_owned();
        let Some(address) = support::mongo_address()? else { return Ok(()) };
        // A second process: its own client and connection pool.
        let proxy = support::Proxy::start(address).await?;
        let Some(other) = support::store_through(&proxy, &name).await? else { return Ok(()) };
        let a = journal(&store, &clock, Duration::from_secs(10)).await?;
        let b = journal(&other, &clock, Duration::from_secs(10)).await?;
        let mut inserted = 0;
        for round in 0..25 {
            let notification = follow(&format!("race-{round}"));
            let (x, y) = tokio::join!(a.ingest_twitch(&notification, None), b.ingest_twitch(&notification, None));
            let (x, y) = (x?.ok_or_else(|| anyhow!("journaled"))?, y?.ok_or_else(|| anyhow!("journaled"))?);
            ensure!(x.inserted != y.inserted, "round {round}: exactly one insert wins");
            ensure!(x.event.id == y.event.id, "round {round}: both see the same event");
            inserted += usize::from(x.inserted) + usize::from(y.inserted);
        }
        ensure!(inserted == 25 && count(&store, domain_events::COLLECTION, doc! {}).await? == 25);
        Ok(())
    })
    .await
}

#[tokio::test]
async fn a_process_dying_between_writes_leaves_work_the_redelivery_and_the_sweep_complete() -> Result<()> {
    with_store(|store| async move {
        let clock = ManualClock::new(NOW);
        let journal = journal(&store, &clock, Duration::from_secs(10)).await?;
        let input = dima_events::producers::twitch::normalize(&follow("crash"))?.ok_or_else(|| anyhow!("event"))?;

        // Dies after the insert, before answering Twitch: the insert is the only producer write,
        // so the event is whole; Twitch delivers again and gets "already recorded".
        let prepared = journal.prepare(&input, None)?;
        store.documents(domain_events::COLLECTION).insert_one(prepared.insert.document.clone()).await?;
        let again = journal.ingest_twitch(&follow("crash"), None).await?.ok_or_else(|| anyhow!("journaled"))?;
        ensure!(!again.inserted && count(&store, domain_events::COLLECTION, doc! {}).await? == 1);

        // The dispatcher dies after some deliveries: the marker is still set, the next sweep makes
        // the rest without duplicates and clears it.
        let report = support::indexes(&store, &domain_event_deliveries::INFO).await?;
        let stored = store.documents(domain_events::COLLECTION).find_one(doc! {}).await?.ok_or_else(|| anyhow!("event"))?;
        let event = DispatchEvent::from_document(&stored)?;
        ensure_delivery(&store, Duration::from_secs(10), NOW, "stream-analytics-v1", &event).await?;
        ensure!(count(&store, domain_events::COLLECTION, doc! { "dispatchPending": true }).await? == 1);
        let dispatcher = Dispatcher::new(store.clone(), Arc::new(clock.clone()), &EventsConfig::default(), &CONSUMERS, &report)?;
        let done = dispatcher.dispatch(100).await?;
        ensure!(done.events == 1);
        let deliveries = count(&store, domain_event_deliveries::COLLECTION, doc! {}).await?;
        ensure!(deliveries as usize == done.deliveries, "one delivery per admitting consumer: {deliveries}");
        ensure!(count(&store, domain_events::COLLECTION, doc! { "dispatchPending": true }).await? == 0);
        // A second sweep has nothing to do.
        ensure!(dispatcher.dispatch(100).await?.events == 0);
        Ok(())
    })
    .await
}

#[tokio::test]
async fn a_lost_wakeup_only_delays_the_work_until_the_sweep() -> Result<()> {
    with_store(|store| async move {
        let clock = ManualClock::new(NOW);
        // A hint publisher that loses everything.
        #[derive(Debug)]
        struct Lost;
        impl WakeHint for Lost {
            fn publish(&self) {}
        }
        let journal = journal(&store, &clock, Duration::from_secs(10)).await?.with_wakeups(Arc::new(Lost));
        journal.ingest_twitch(&follow("lost-hint"), None).await?;
        let report = support::indexes(&store, &domain_event_deliveries::INFO).await?;
        let dispatcher = Dispatcher::new(store.clone(), Arc::new(clock.clone()), &EventsConfig::default(), &CONSUMERS, &report)?;
        // The dispatcher's loop: sweep, then wait for a hint or the poll interval.
        let signal = dima_events::wakeups::PollSignal::new();
        let interval = Duration::from_millis(dima_events::contracts::policy::delivery::POLL_INTERVAL_MS as u64);
        let started = tokio::time::Instant::now();
        let mut dispatched = 0;
        for _ in 0..3 {
            dispatched += dispatcher.dispatch(100).await?.events;
            if dispatched > 0 {
                break;
            }
            signal.wait(interval).await;
        }
        ensure!(dispatched == 1, "the sweep found the event without a hint");
        ensure!(started.elapsed() < interval * 2);
        Ok(())
    })
    .await
}

#[tokio::test]
async fn wakeups_reach_a_listener_and_never_block_the_journal() -> Result<()> {
    let Some(dragonfly) = support::dragonfly(6).await? else { return Ok(()) };
    let prefix = support::key_prefix("wakeups");
    let config = dima_events::wakeups::WakeupConfig {
        channel: format!("{prefix}channel"),
        ..Default::default()
    };
    let shutdown = dima_core::Shutdown::new();
    let signal = Arc::new(dima_events::wakeups::PollSignal::new());
    let listener = dima_events::wakeups::Listener::start(&dragonfly, &config, signal.clone(), shutdown.clone());
    let (publisher, task) = dima_events::wakeups::Publisher::start(dragonfly.clone(), config.clone(), shutdown.clone());
    // Wait for the subscription, then a hint must wake the signal well before the interval.
    let mut woke = false;
    for _ in 0..20 {
        publisher.publish();
        let started = tokio::time::Instant::now();
        signal.wait(Duration::from_secs(5)).await;
        if started.elapsed() < Duration::from_secs(1) {
            woke = true;
            break;
        }
    }
    ensure!(woke && publisher.sent() > 0, "a hint wakes the listener");
    // A publisher whose Dragonfly went silent drops hints after its timeout, never blocking.
    let Some(address) = std::env::var("DIMA_TEST_DRAGONFLY").ok() else { return Ok(()) };
    let proxy = support::Proxy::start(address).await?;
    let (host, port) = proxy.address.rsplit_once(':').ok_or_else(|| anyhow!("address"))?;
    let mut silent_config = dima_store::dragonfly::DragonflyConfig::from_env_values(Some(host), Some(&format!("{port}/6")), "dima-events-tests");
    silent_config.response_timeout = Duration::from_secs(2);
    let silent = dima_store::dragonfly::Dragonfly::connect(silent_config, Default::default()).await?;
    let (cut_off, cut_task) = dima_events::wakeups::Publisher::start(silent, config.clone(), shutdown.clone());
    proxy.blackhole();
    let started = tokio::time::Instant::now();
    for _ in 0..100 {
        cut_off.publish();
    }
    ensure!(started.elapsed() < Duration::from_millis(50), "publish never waits");
    tokio::time::sleep(Duration::from_millis(900)).await;
    ensure!(cut_off.dropped() >= 1 && cut_off.sent() == 0, "a hint that cannot be sent is dropped");
    shutdown.trigger();
    listener.join().await;
    let _ = task.await;
    let _ = cut_task.await;
    support::clean_keys(&dragonfly, &prefix).await?;
    Ok(())
}

#[tokio::test]
async fn a_duplicate_key_on_each_unique_index_means_already_done() -> Result<()> {
    with_store(|store| async move {
        let clock = ManualClock::new(NOW);
        let journal = journal(&store, &clock, Duration::from_secs(10)).await?;
        // `eventKey_1`: the second insert reads the first event back.
        let first = journal.ingest_twitch(&follow("dup"), None).await?.ok_or_else(|| anyhow!("event"))?;
        let second = journal.ingest_twitch(&follow("dup"), None).await?.ok_or_else(|| anyhow!("event"))?;
        ensure!(first.inserted && !second.inserted);
        // `source_1_sourceEventId_1_type_1` with another key (a state the journal cannot make:
        // the key is a function of the three): the reference rethrows the insert error, so does
        // this; the caller answers 503 and nothing is half-written.
        let input = dima_events::producers::twitch::normalize(&follow("triple"))?.ok_or_else(|| anyhow!("event"))?;
        let mut foreign = journal.prepare(&input, None)?.insert.document;
        foreign.insert("eventKey", "another-key");
        store.documents(domain_events::COLLECTION).insert_one(foreign).await?;
        match journal.append(&input, None).await {
            Err(IngestError::Store(error)) => ensure!(
                dima_events::store::duplicate_key(&error).and_then(|d| d.index).as_deref() == Some("source_1_sourceEventId_1_type_1")
            ),
            other => return Err(anyhow!("expected the duplicate-key error, got {other:?}")),
        }
        ensure!(count(&store, domain_events::COLLECTION, doc! { "sourceEventId": "triple" }).await? == 1);

        // `consumer_1_eventKey_1`: two dispatchers creating the same delivery at once.
        support::indexes(&store, &domain_event_deliveries::INFO).await?;
        let stored = store.documents(domain_events::COLLECTION).find_one(doc! { "sourceEventId": "dup" }).await?.ok_or_else(|| anyhow!("event"))?;
        let event = DispatchEvent::from_document(&stored)?;
        let deadline = Duration::from_secs(10);
        for _ in 0..10 {
            let (x, y) = tokio::join!(
                ensure_delivery(&store, deadline, NOW, "race-v1", &event),
                ensure_delivery(&store, deadline, NOW, "race-v1", &event)
            );
            ensure!(x?.get("_id") == y?.get("_id"));
        }
        ensure!(count(&store, domain_event_deliveries::COLLECTION, doc! { "consumer": "race-v1" }).await? == 1);

        // `jobID_1`, `automaticKey_1`, `activeKey_1`: concurrent acceptances of one job.
        let report = support::indexes(&store, &cron_job_intents::INFO).await?;
        let jobs = DurableJobs::new(store.clone(), NoQueue, Arc::new(clock.clone()), Arc::new(SeededRandom::new(7)), JobsConfig::default(), &report)?;
        let queue = "cron:stream-memory:queue";
        let job = |id: &str, session: &str, dedupe: &str| CronQueueJob {
            id: id.into(),
            job: "stream-memory-summary".into(),
            requested_at: "2026-11-11T10:20:30.456Z".into(),
            requested_by: None,
            user_id: None,
            account_id: None,
            channel_id: Some("1001".into()),
            data: Some(serde_json::json!({ "source": "stream_offline", "sessionID": session })),
            dedupe_key: Some(dedupe.into()),
        };
        let options = PrepareOptions { dedupe_seconds: 60.0, acceptance_key: None, legacy_accepted: false };
        for (x, y, why) in [
            (job("same-id", "s-1", "d-1"), job("same-id", "s-1", "d-1"), "jobID"),
            (job("auto-a", "s-2", "d-2"), job("auto-b", "s-2", "d-3"), "automaticKey"),
            (job("active-a", "s-3", "d-4"), job("active-b", "s-4", "d-4"), "activeKey"),
        ] {
            let (a, b) = tokio::join!(jobs.prepare(&x, queue, &options), jobs.prepare(&y, queue, &options));
            let (a, b) = (a?, b?);
            ensure!(a.created != b.created, "{why}: one acceptance wins");
            ensure!(a.job == b.job, "{why}: both return the canonical job");
        }
        ensure!(count(&store, cron_job_intents::COLLECTION, doc! {}).await? == 3);
        // Two workers claiming the same delivered job: one lease.
        let claimed = job("same-id", "s-1", "d-1");
        let (a, b) = tokio::join!(jobs.claim(&claimed, queue, "w-1"), jobs.claim(&claimed, queue, "w-2"));
        let winners = [a?, b?].iter().filter(|r| matches!(r, ClaimResult::Claimed { .. })).count();
        ensure!(winners == 1, "exactly one claim wins");
        Ok(())
    })
    .await
}

#[derive(Clone, Copy, Debug)]
struct NoQueue;

impl JobQueue for NoQueue {
    async fn publish(&self, _: &str, _: Option<&str>, _: &QueueItem) -> Result<bool, StoreError> {
        Ok(true)
    }

    async fn marker_exists(&self, _: &str) -> Result<bool, StoreError> {
        Ok(false)
    }
}

#[tokio::test]
async fn mongodb_silent_past_the_deadline_fails_retryably_and_nothing_counts_as_done() -> Result<()> {
    with_store(|store| async move {
        let clock = ManualClock::new(NOW);
        let name = store.database().name().to_owned();
        let Some(address) = support::mongo_address()? else { return Ok(()) };
        let proxy = support::Proxy::start(address).await?;
        let Some(through) = support::store_through(&proxy, &name).await? else { return Ok(()) };
        let deadline = Duration::from_millis(300);
        let journal = journal(&through, &clock, deadline).await?;
        let report = support::indexes(&store, &domain_event_deliveries::INFO).await?;
        let dispatcher = Dispatcher::new(through.clone(), Arc::new(clock.clone()), &EventsConfig { store_deadline: deadline }, &CONSUMERS, &report)?;
        journal.ingest_twitch(&follow("before"), None).await?;

        proxy.blackhole();
        let started = tokio::time::Instant::now();
        let error = match journal.ingest_twitch(&follow("silent"), None).await {
            Err(error) => error,
            Ok(other) => return Err(anyhow!("expected a timeout, got {other:?}")),
        };
        ensure!(matches!(error, IngestError::Store(StoreError::Timeout { .. })), "{error}");
        ensure!(!error.is_permanent(), "the caller answers 503 and Twitch delivers again");
        ensure!(started.elapsed() < Duration::from_secs(2));
        let dispatch = dispatcher.dispatch(100).await;
        ensure!(matches!(dispatch, Err(dima_events::dispatch::DispatchError::Store(StoreError::Timeout { .. }))));

        proxy.restore();
        // Twitch delivers again: exactly one event, the marker still set, and the sweep completes.
        let mut recovered = None;
        for _ in 0..20 {
            match journal.ingest_twitch(&follow("silent"), None).await {
                Ok(result) => {
                    recovered = result;
                    break;
                }
                Err(_) => tokio::time::sleep(Duration::from_millis(200)).await,
            }
        }
        ensure!(recovered.is_some(), "the redelivery is journaled once the server answers");
        ensure!(count(&store, domain_events::COLLECTION, doc! { "sourceEventId": "silent" }).await? == 1);
        let mut events = 0;
        for _ in 0..20 {
            match dispatcher.dispatch(100).await {
                Ok(done) => {
                    events += done.events;
                    break;
                }
                Err(_) => tokio::time::sleep(Duration::from_millis(200)).await,
            }
        }
        ensure!(events == 2 && count(&store, domain_events::COLLECTION, doc! { "dispatchPending": true }).await? == 0);
        Ok(())
    })
    .await
}

#[tokio::test]
async fn a_worker_dying_mid_job_leaves_it_uncertain_and_an_unpublished_intent_is_republished() -> Result<()> {
    with_store(|store| async move {
        let clock = ManualClock::new(NOW);
        let report = support::indexes(&store, &cron_job_intents::INFO).await?;
        let published = Arc::new(AtomicUsize::new(0));
        #[derive(Clone)]
        struct Counting(Arc<AtomicUsize>);
        impl JobQueue for Counting {
            async fn publish(&self, _: &str, _: Option<&str>, _: &QueueItem) -> Result<bool, StoreError> {
                self.0.fetch_add(1, Ordering::SeqCst);
                Ok(true)
            }
            async fn marker_exists(&self, _: &str) -> Result<bool, StoreError> {
                Ok(false)
            }
        }
        let jobs = DurableJobs::new(store.clone(), Counting(published.clone()), Arc::new(clock.clone()), Arc::new(SeededRandom::new(1)), JobsConfig::default(), &report)?;
        let queue = "cron:clip-recommendations:queue";
        let job = CronQueueJob {
            id: "clip-1".into(),
            job: "clip-recommendation-analysis".into(),
            requested_at: "2026-11-11T10:20:30.456Z".into(),
            requested_by: None,
            user_id: None,
            account_id: None,
            channel_id: Some("1001".into()),
            data: None,
            dedupe_key: Some("cron:jobs:dedupe:clip".into()),
        };
        // Accepted, then the process dies before publishing: the recovery sweep publishes it.
        jobs.prepare(&job, queue, &PrepareOptions { dedupe_seconds: 3600.0, acceptance_key: None, legacy_accepted: false }).await?;
        let recovered = jobs.recover(queue, 10).await?;
        ensure!(recovered.examined == 1 && published.load(Ordering::SeqCst) == 1);
        // Claimed, then the worker dies: never claimed again, uncertain once the lease expires.
        let claim = match jobs.claim(&job, queue, "w-1").await? {
            ClaimResult::Claimed { claim, .. } => claim,
            other => return Err(anyhow!("expected a claim, got {other:?}")),
        };
        ensure!(matches!(jobs.claim(&job, queue, "w-2").await?, ClaimResult::Busy { .. }));
        clock.advance(dima_events::jobs::LEASE_MS + 1);
        ensure!(!jobs.complete(&claim).await?, "a completion after the lease is refused");
        ensure!(jobs.recover(queue, 10).await?.uncertain == 1);
        ensure!(matches!(jobs.claim(&job, queue, "w-2").await?, ClaimResult::Terminal { .. }));
        Ok(())
    })
    .await
}
