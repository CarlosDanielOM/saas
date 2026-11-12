//! Fault and race cases of the consumer runtime with real MongoDB (and Dragonfly for the
//! wakeups): two runtimes competing for the same deliveries; a runtime killed while a handler
//! runs; a handler that finishes after losing its lease; a heartbeat that finds the lease gone;
//! a lost wakeup; the store silent or losing a reply at each write; a poison event; a slow
//! consumer beside a fast one; shutdown with a handler in flight; the execution limit; a handler
//! that cannot be stopped; the batch and concurrency bounds; deliveries the TypeScript runtime
//! left behind at the cutover.

mod support;

use anyhow::{Result, anyhow, bail, ensure};
use bson::{Bson, Document, doc};
use dima_core::{Clock, ManualClock, Shutdown, SystemClock, SystemRandom};
use dima_events::config::EventsConfig;
use dima_events::consumer::{
    Consumer, ConsumerConfig, ConsumerError, DeliveryContext, DrainResult, Engine, Handler,
    Outcome, Runtime, StopReason,
};
use dima_events::contracts::policy::ConsumerDefinition;
use dima_events::contracts::{JournalInput, SubjectInput, Topic};
use dima_events::dispatch::Dispatcher;
use dima_events::envelope::Envelope;
use dima_events::producers::{Journal, WakeHint};
use dima_events::value::{Object, Value};
use dima_model::{domain_event_checkpoints, domain_event_deliveries, domain_events};
use dima_store::mongo::MongoStore;
use futures_util::future::BoxFuture;
use std::collections::HashMap;
use std::future::Future;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use support::{Proxy, with_store};
use tokio::sync::Notify;

/// Short timings so the cases run in seconds.
const FAST: ConsumerConfig = ConsumerConfig {
    poll_interval_ms: 250,
    batch_size: 100,
    max_attempts: 5,
    lease_ms: 5_000,
    execution_timeout_ms: 10_000,
    operation_timeout_ms: 60_000,
    shutdown_grace_ms: 500,
    restart_delay_ms: 100,
    abort_grace_ms: 1_000,
};

fn fault_filter() -> Document {
    doc! { "source": "fault" }
}

fn other_filter() -> Document {
    doc! { "source": "fault-other" }
}

static FAULT: ConsumerDefinition = ConsumerDefinition {
    consumer: "fault-v1",
    topics: &[Topic::Domain],
    schema_versions: &[1.0],
    admin_replay: false,
    max_event_age_ms: None,
    event_filter: fault_filter,
};

static OTHER: ConsumerDefinition = ConsumerDefinition {
    consumer: "fault-other-v1",
    event_filter: other_filter,
    ..FAULT
};

static ONE: [ConsumerDefinition; 1] = [FAULT];
static BOTH: [ConsumerDefinition; 2] = [FAULT, OTHER];

/// Scripted handlers (by `payload.script`): `ok`; `fail`; `block` (never returns); `block-once`
/// (blocks on its first call, then returns); `wait` (returns once released); `sleep-300`;
/// `slow` (2 s); `sync-block` (holds its thread 2.5 s without yielding).
#[derive(Debug, Default)]
struct Behaviour {
    calls: Mutex<HashMap<String, u32>>,
    running: AtomicUsize,
    peak: AtomicUsize,
    entered: Notify,
    release: Notify,
    finished: Mutex<Vec<String>>,
}

struct Running<'a>(&'a Behaviour);

impl Drop for Running<'_> {
    fn drop(&mut self) {
        self.0.running.fetch_sub(1, Ordering::SeqCst);
    }
}

impl Behaviour {
    fn calls(&self, key: &str) -> u32 {
        self.calls
            .lock()
            .map(|c| c.get(key).copied().unwrap_or(0))
            .unwrap_or(0)
    }

    fn total(&self) -> u32 {
        self.calls.lock().map(|c| c.values().sum()).unwrap_or(0)
    }
}

impl Handler for Behaviour {
    fn handle<'a>(
        &'a self,
        event: &'a Envelope,
        _context: &'a DeliveryContext,
    ) -> BoxFuture<'a, Outcome> {
        Box::pin(async move {
            let n = match self.calls.lock() {
                Ok(mut calls) => {
                    let n = calls.entry(event.event_key.clone()).or_insert(0);
                    *n += 1;
                    *n
                }
                Err(_) => 0,
            };
            let running = self.running.fetch_add(1, Ordering::SeqCst) + 1;
            self.peak.fetch_max(running, Ordering::SeqCst);
            let _running = Running(self);
            let outcome = match event.payload.at("script").as_str() {
                Some("fail") => Outcome::Failed("boom".into()),
                Some("block") => {
                    self.entered.notify_one();
                    std::future::pending::<Outcome>().await
                }
                Some("block-once") if n == 1 => {
                    self.entered.notify_one();
                    std::future::pending::<Outcome>().await
                }
                Some("wait") => {
                    self.entered.notify_one();
                    self.release.notified().await;
                    Outcome::Done
                }
                Some("sleep-300") => {
                    self.entered.notify_one();
                    tokio::time::sleep(Duration::from_millis(300)).await;
                    Outcome::Done
                }
                Some("slow") => {
                    tokio::time::sleep(Duration::from_secs(2)).await;
                    Outcome::Done
                }
                Some("sync-block") => {
                    self.entered.notify_one();
                    std::thread::sleep(Duration::from_millis(2_500));
                    Outcome::Done
                }
                _ => Outcome::Done,
            };
            if let Ok(mut finished) = self.finished.lock() {
                finished.push(event.event_key.clone());
            }
            outcome
        })
    }
}

fn key(source: &str, id: &str) -> String {
    format!("{source}:{id}:fault.event")
}

async fn journal(
    store: &MongoStore,
    clock: Arc<dyn Clock>,
    source: &str,
    items: &[(&str, &str)],
) -> Result<()> {
    let report = support::indexes(store, &domain_events::INFO).await?;
    let journal = Journal::new(store.clone(), clock, &EventsConfig::default(), &report)?;
    journal_with(&journal, source, items).await
}

async fn journal_with(journal: &Journal, source: &str, items: &[(&str, &str)]) -> Result<()> {
    for (id, script) in items {
        let mut payload = Object::new();
        payload.insert("script", Value::from(*script));
        journal
            .append(
                &JournalInput {
                    source: source.into(),
                    source_event_id: (*id).into(),
                    kind: "fault.event".into(),
                    topic: Topic::Domain,
                    schema_version: None,
                    owner_user_id: None,
                    subject: Some(SubjectInput {
                        provider: "fault".into(),
                        kind: "resource".into(),
                        id: "r".into(),
                    }),
                    channel_id: None,
                    stream_id: None,
                    occurred_at: None,
                    payload,
                    metadata: None,
                    retention_seconds: None,
                },
                None,
            )
            .await?;
    }
    Ok(())
}

fn events_config() -> EventsConfig {
    EventsConfig {
        store_deadline: Duration::from_secs(2),
    }
}

async fn engine(
    store: &MongoStore,
    clock: Arc<dyn Clock>,
    config: ConsumerConfig,
) -> Result<Engine> {
    let report = support::indexes(store, &domain_event_deliveries::INFO).await?;
    support::indexes(store, &domain_event_checkpoints::INFO).await?;
    Ok(Engine::new(
        store.clone(),
        clock,
        Arc::new(SystemRandom),
        config,
        &events_config(),
        &report,
    )?)
}

async fn runtime(
    store: &MongoStore,
    config: ConsumerConfig,
    consumers: Vec<Consumer>,
    dispatched: &'static [ConsumerDefinition],
) -> Result<Runtime> {
    let clock: Arc<dyn Clock> = Arc::new(SystemClock);
    let report = support::indexes(store, &domain_event_deliveries::INFO).await?;
    let engine = engine(store, clock.clone(), config).await?;
    let dispatcher = Dispatcher::new(store.clone(), clock, &events_config(), dispatched, &report)?;
    Ok(Runtime::new(engine, consumers)?.with_dispatcher(dispatcher))
}

fn consumer_of(definition: &'static ConsumerDefinition, behaviour: &Arc<Behaviour>) -> Consumer {
    let handler: Arc<dyn Handler> = behaviour.clone();
    Consumer {
        definition,
        handler,
    }
}

async fn delivery(store: &MongoStore, consumer: &str, key: &str) -> Result<Document> {
    store
        .documents(domain_event_deliveries::COLLECTION)
        .find_one(doc! { "consumer": consumer, "eventKey": key })
        .await?
        .ok_or_else(|| anyhow!("no delivery {consumer}/{key}"))
}

async fn count(store: &MongoStore, filter: Document) -> Result<u64> {
    Ok(store
        .documents(domain_event_deliveries::COLLECTION)
        .count_documents(filter)
        .await?)
}

/// Waits for `check` to hold, polling every 50 ms, at most `limit`.
async fn until<F, Fut>(what: &str, limit: Duration, mut check: F) -> Result<()>
where
    F: FnMut() -> Fut,
    Fut: Future<Output = Result<bool>>,
{
    let started = tokio::time::Instant::now();
    loop {
        if check().await? {
            return Ok(());
        }
        if started.elapsed() > limit {
            bail!("{what}: not within {limit:?}");
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

fn status(document: &Document) -> &str {
    document.get_str("status").unwrap_or_default()
}

fn attempts(document: &Document) -> i64 {
    match document.get("attempts") {
        Some(Bson::Int32(n)) => i64::from(*n),
        Some(Bson::Int64(n)) => *n,
        Some(Bson::Double(n)) => *n as i64,
        _ => -1,
    }
}

fn date_ms(document: &Document, field: &str) -> Option<i64> {
    document
        .get_datetime(field)
        .ok()
        .map(|d| d.timestamp_millis())
}

/// Starts `runtime` as a task stopped by `shutdown`.
fn spawn(
    runtime: Runtime,
    shutdown: &Shutdown,
) -> tokio::task::JoinHandle<Result<(), ConsumerError>> {
    let shutdown = shutdown.clone();
    tokio::spawn(async move { runtime.run(&shutdown).await })
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn two_runtimes_compete_and_each_delivery_runs_once() -> Result<()> {
    with_store(|store| async move {
        let Some(address) = support::mongo_address()? else {
            return Ok(());
        };
        let proxy = Proxy::start(address).await?;
        let name = store.database().name().to_owned();
        let Some(other) = support::store_through(&proxy, &name).await? else {
            return Ok(());
        };
        let items: Vec<(String, &str)> = (0..40).map(|i| (format!("race-{i:02}"), "ok")).collect();
        let items: Vec<(&str, &str)> = items.iter().map(|(id, s)| (id.as_str(), *s)).collect();
        journal(&store, Arc::new(SystemClock), "fault", &items).await?;
        let behaviour = Arc::new(Behaviour::default());
        let shutdown = Shutdown::new();
        let a = spawn(
            runtime(&store, FAST, vec![consumer_of(&FAULT, &behaviour)], &ONE).await?,
            &shutdown,
        );
        let b = spawn(
            runtime(&other, FAST, vec![consumer_of(&FAULT, &behaviour)], &ONE).await?,
            &shutdown,
        );
        until("all succeeded", Duration::from_secs(30), || async {
            Ok(count(&store, doc! { "status": "succeeded" }).await? == 40)
        })
        .await?;
        shutdown.trigger();
        a.await??;
        b.await??;
        ensure!(
            behaviour.total() == 40,
            "{} handler runs for 40 deliveries",
            behaviour.total()
        );
        for (id, _) in &items {
            ensure!(
                behaviour.calls(&key("fault", id)) == 1,
                "{id} ran more than once"
            );
            let stored = delivery(&store, "fault-v1", &key("fault", id)).await?;
            ensure!(
                attempts(&stored) == 1,
                "{id}: a lost claim race spends no attempt"
            );
        }
        ensure!(
            count(&store, doc! {}).await? == 40,
            "one delivery per event"
        );
        Ok(())
    })
    .await
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_runtime_killed_mid_handler_leaves_the_delivery_to_be_retried_after_its_lease()
-> Result<()> {
    with_store(|store| async move {
        journal(
            &store,
            Arc::new(SystemClock),
            "fault",
            &[("killed", "block-once")],
        )
        .await?;
        let behaviour = Arc::new(Behaviour::default());
        let first = spawn(
            runtime(&store, FAST, vec![consumer_of(&FAULT, &behaviour)], &ONE).await?,
            &Shutdown::new(),
        );
        tokio::time::timeout(Duration::from_secs(10), behaviour.entered.notified()).await?;
        // The process dies: its task is dropped with the handler in it.
        first.abort();
        let _ = first.await;
        let key = key("fault", "killed");
        let held = delivery(&store, "fault-v1", &key).await?;
        ensure!(
            status(&held) == "processing" && attempts(&held) == 1,
            "{held}"
        );
        let lease_end = date_ms(&held, "lockedUntil").ok_or_else(|| anyhow!("lease"))?;
        ensure!(
            behaviour.running.load(Ordering::SeqCst) == 0,
            "the handler was stopped"
        );
        // Another process takes it up once the lease has expired.
        let shutdown = Shutdown::new();
        let second = spawn(
            runtime(&store, FAST, vec![consumer_of(&FAULT, &behaviour)], &ONE).await?,
            &shutdown,
        );
        until(
            "retried after the lease",
            Duration::from_secs(15),
            || async { Ok(status(&delivery(&store, "fault-v1", &key).await?) == "succeeded") },
        )
        .await?;
        shutdown.trigger();
        second.await??;
        let done = delivery(&store, "fault-v1", &key).await?;
        ensure!(attempts(&done) == 2 && behaviour.calls(&key) == 2);
        ensure!(
            date_ms(&done, "completedAt").is_some_and(|at| at >= lease_end),
            "not taken before the lease expired"
        );
        Ok(())
    })
    .await
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_handler_finishing_after_its_lease_was_taken_records_nothing() -> Result<()> {
    with_store(|store| async move {
        journal(&store, Arc::new(SystemClock), "fault", &[("late", "wait")]).await?;
        let behaviour = Arc::new(Behaviour::default());
        let engine = engine(&store, Arc::new(SystemClock), FAST).await?;
        let consumer = consumer_of(&FAULT, &behaviour);
        let pass = {
            let engine = engine.clone();
            let consumer = consumer.clone();
            tokio::spawn(async move { engine.drain(&consumer, &Shutdown::new()).await })
        };
        tokio::time::timeout(Duration::from_secs(10), behaviour.entered.notified()).await?;
        // Another holder now has the lease (as after an expiry and a new claim).
        let key = key("fault", "late");
        store
            .documents(domain_event_deliveries::COLLECTION)
            .update_one(
                doc! { "eventKey": key.as_str() },
                doc! { "$set": { "leaseToken": "thief", "lockedUntil": bson::DateTime::from_millis(SystemClock.now_ms() + 60_000) } },
            )
            .await?;
        behaviour.release.notify_one();
        let result = pass.await??;
        ensure!(result.succeeded == 0 && result.deferred >= 1, "{result:?}");
        let stored = delivery(&store, "fault-v1", &key).await?;
        ensure!(
            status(&stored) == "processing" && stored.get_str("leaseToken")? == "thief",
            "the refused completion changed nothing: {stored}"
        );
        Ok(())
    })
    .await
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_heartbeat_that_finds_the_lease_gone_stops_the_handler() -> Result<()> {
    with_store(|store| async move {
        journal(
            &store,
            Arc::new(SystemClock),
            "fault",
            &[("stolen", "block")],
        )
        .await?;
        let behaviour = Arc::new(Behaviour::default());
        let engine = engine(&store, Arc::new(SystemClock), FAST).await?;
        let consumer = consumer_of(&FAULT, &behaviour);
        let started = tokio::time::Instant::now();
        let pass = {
            let consumer = consumer.clone();
            tokio::spawn(async move { engine.drain(&consumer, &Shutdown::new()).await })
        };
        tokio::time::timeout(Duration::from_secs(10), behaviour.entered.notified()).await?;
        let key = key("fault", "stolen");
        store
            .documents(domain_event_deliveries::COLLECTION)
            .update_one(
                doc! { "eventKey": key.as_str() },
                doc! { "$set": { "leaseToken": "thief" } },
            )
            .await?;
        let result = tokio::time::timeout(Duration::from_secs(10), pass).await??;
        ensure!(
            matches!(
                result,
                Err(ConsumerError::Stopped {
                    reason: StopReason::LeaseLost,
                    ..
                })
            ),
            "{result:?}"
        );
        // The first heartbeat (a third of the lease) found it.
        ensure!(started.elapsed() < Duration::from_millis(4_000));
        ensure!(
            behaviour.running.load(Ordering::SeqCst) == 0,
            "aborted and joined"
        );
        let stored = delivery(&store, "fault-v1", &key).await?;
        ensure!(status(&stored) == "processing" && stored.get_str("leaseToken")? == "thief");
        Ok(())
    })
    .await
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_lost_wakeup_only_delays_work_until_the_sweep() -> Result<()> {
    let Some(dragonfly) = support::dragonfly(6).await? else {
        return Ok(());
    };
    let prefix = support::key_prefix("consumer-wakeups");
    let channel = format!("{prefix}channel");
    let hints = dragonfly.clone();
    let outcome = with_store(|store| async move {
        let wakeups = dima_events::wakeups::WakeupConfig {
            channel,
            ..Default::default()
        };
        let slow_sweep = ConsumerConfig {
            poll_interval_ms: 4_000,
            ..FAST
        };
        let behaviour = Arc::new(Behaviour::default());
        let shutdown = Shutdown::new();
        let running = spawn(
            runtime(
                &store,
                slow_sweep,
                vec![consumer_of(&FAULT, &behaviour)],
                &ONE,
            )
            .await?
            .with_wakeups(hints.clone(), wakeups.clone()),
            &shutdown,
        );
        let (publisher, publishing) =
            dima_events::wakeups::Publisher::start(hints.clone(), wakeups, shutdown.clone());
        let report = support::indexes(&store, &domain_events::INFO).await?;
        let hinted = Journal::new(
            store.clone(),
            Arc::new(SystemClock),
            &EventsConfig::default(),
            &report,
        )?
        .with_wakeups(Arc::new(publisher));
        // Let the first sweeps pass and the subscription settle.
        tokio::time::sleep(Duration::from_millis(1_500)).await;
        let mut fast = false;
        for round in 0..5 {
            let id = format!("hinted-{round}");
            let started = tokio::time::Instant::now();
            journal_with(&hinted, "fault", &[(id.as_str(), "ok")]).await?;
            until("hinted", Duration::from_secs(10), || async {
                Ok(behaviour.calls(&key("fault", &id)) == 1)
            })
            .await?;
            if started.elapsed() < Duration::from_millis(2_000) {
                fast = true;
                break;
            }
        }
        ensure!(
            fast,
            "a hint wakes the dispatcher and the consumer before the sweep"
        );
        // No hint at all: the sweep still finds the work.
        #[derive(Debug)]
        struct Lost;
        impl WakeHint for Lost {
            fn publish(&self) {}
        }
        let unhinted = Journal::new(
            store.clone(),
            Arc::new(SystemClock),
            &EventsConfig::default(),
            &report,
        )?
        .with_wakeups(Arc::new(Lost));
        journal_with(&unhinted, "fault", &[("lost-hint", "ok")]).await?;
        until("swept", Duration::from_secs(10), || async {
            Ok(behaviour.calls(&key("fault", "lost-hint")) == 1)
        })
        .await?;
        shutdown.trigger();
        running.await??;
        let _ = publishing.await;
        Ok(())
    })
    .await;
    // Hints are pub/sub messages and leave no key; clean the prefix all the same.
    support::clean_keys(&dragonfly, &prefix).await?;
    outcome
}

/// One store fault at one write: what the pass says, what is stored, and what the next pass
/// does. `ManualClock` moves the leases; the store calls are real, through the proxy.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_store_silent_or_losing_a_reply_at_each_write() -> Result<()> {
    struct Case {
        name: &'static str,
        script: &'static str,
        needles: &'static [&'static [u8]],
        lose_reply: bool,
        dispatch_first: bool,
        delete_event: bool,
    }
    let cases = [
        Case {
            name: "claim, reply lost",
            script: "ok",
            needles: &[b"findAndModify\0", b"$inc"],
            lose_reply: true,
            dispatch_first: true,
            delete_event: false,
        },
        Case {
            name: "claim, request lost",
            script: "ok",
            needles: &[b"findAndModify\0", b"$inc"],
            lose_reply: false,
            dispatch_first: true,
            delete_event: false,
        },
        Case {
            name: "completion, reply lost",
            script: "ok",
            needles: &[b"update\0", b"succeeded"],
            lose_reply: true,
            dispatch_first: true,
            delete_event: false,
        },
        Case {
            name: "completion, request lost",
            script: "ok",
            needles: &[b"update\0", b"succeeded"],
            lose_reply: false,
            dispatch_first: true,
            delete_event: false,
        },
        Case {
            name: "failure, reply lost",
            script: "fail",
            needles: &[b"update\0", b"handler_failed"],
            lose_reply: true,
            dispatch_first: true,
            delete_event: false,
        },
        Case {
            name: "failure, request lost",
            script: "fail",
            needles: &[b"update\0", b"handler_failed"],
            lose_reply: false,
            dispatch_first: true,
            delete_event: false,
        },
        Case {
            name: "delivery creation, reply lost",
            script: "ok",
            needles: &[b"findAndModify\0", b"$setOnInsert"],
            lose_reply: true,
            dispatch_first: false,
            delete_event: false,
        },
        Case {
            name: "checkpoint, reply lost",
            script: "ok",
            needles: &[b"update\0", b"domain_event_checkpoints"],
            lose_reply: true,
            dispatch_first: false,
            delete_event: false,
        },
        Case {
            name: "checkpoint, request lost",
            script: "ok",
            needles: &[b"update\0", b"domain_event_checkpoints"],
            lose_reply: false,
            dispatch_first: false,
            delete_event: false,
        },
        Case {
            name: "missing journal, reply lost",
            script: "ok",
            needles: &[b"update\0", b"journal_missing"],
            lose_reply: true,
            dispatch_first: true,
            delete_event: true,
        },
    ];
    for case in cases {
        with_store(|store| async move {
            let name = case.name;
            let Some(address) = support::mongo_address()? else {
                return Ok(());
            };
            let proxy = Proxy::start_mongo(address).await?;
            let Some(through) = support::store_through(&proxy, store.database().name()).await? else {
                return Ok(());
            };
            through.ping().await?;
            let clock = ManualClock::new(1_794_392_430_456);
            journal(&store, Arc::new(clock.clone()), "fault", &[("faulty", case.script)]).await?;
            let key = key("fault", "faulty");
            if case.dispatch_first {
                let report = support::indexes(&store, &domain_event_deliveries::INFO).await?;
                Dispatcher::new(store.clone(), Arc::new(clock.clone()), &events_config(), &ONE, &report)?
                    .dispatch(100)
                    .await?;
            }
            if case.delete_event {
                store.documents(domain_events::COLLECTION).delete_one(doc! { "eventKey": key.as_str() }).await?;
            }
            let behaviour = Arc::new(Behaviour::default());
            let consumer = consumer_of(&FAULT, &behaviour);
            let engine = engine(&through, Arc::new(clock.clone()), FAST).await?;
            let shutdown = Shutdown::new();
            if case.lose_reply {
                proxy.lose_reply_to(case.needles);
            } else {
                proxy.drop_request_to(case.needles);
            }
            let first = engine.drain(&consumer, &shutdown).await;
            ensure!(proxy.replies_lost() == 1, "{name}: the trapped write was sent");
            let stored = store.documents(domain_event_deliveries::COLLECTION).find_one(doc! { "eventKey": key.as_str() }).await?;
            let checkpoint = store.documents(domain_event_checkpoints::COLLECTION).find_one(doc! {}).await?;
            match name {
                // Reconciled by its token: the handler ran once and the outcome is recorded.
                "claim, reply lost" => {
                    let result = first?;
                    ensure!(result.succeeded == 1, "{name}: {result:?}");
                    ensure!(stored.as_ref().is_some_and(|d| status(d) == "succeeded" && attempts(d) == 1), "{name}: {stored:?}");
                }
                _ => {
                    let error = first.err().ok_or_else(|| anyhow!("{name}: the pass must fail"))?;
                    ensure!(
                        matches!(&error, ConsumerError::Store(e) if e.outcome_unknown())
                            || matches!(&error, ConsumerError::Dispatch(dima_events::dispatch::DispatchError::Store(e)) if e.outcome_unknown()),
                        "{name}: {error}"
                    );
                }
            }
            // What is durably true now.
            let state = stored.as_ref().map(|d| (status(d).to_owned(), attempts(d)));
            let expected: Option<(&str, i64)> = match name {
                "claim, reply lost" => Some(("succeeded", 1)),
                "claim, request lost" => Some(("pending", 0)),
                "completion, reply lost" => Some(("succeeded", 1)),
                "completion, request lost" => Some(("processing", 1)),
                "failure, reply lost" => Some(("retry", 1)),
                "failure, request lost" => Some(("processing", 1)),
                "delivery creation, reply lost" => Some(("pending", 0)),
                "checkpoint, reply lost" | "checkpoint, request lost" => Some(("succeeded", 1)),
                "missing journal, reply lost" => Some(("dead", 0)),
                _ => None,
            };
            ensure!(
                state.as_ref().map(|(s, a)| (s.as_str(), *a)) == expected,
                "{name}: stored {state:?}, expected {expected:?}"
            );
            match name {
                "checkpoint, reply lost" => ensure!(checkpoint.is_some(), "{name}: committed"),
                "checkpoint, request lost" => ensure!(checkpoint.is_none(), "{name}: never sent"),
                _ => {}
            }
            // The next passes, past any lease and retry time: each converges, and a handler runs
            // again only where nothing recorded its outcome (at least once).
            clock.advance(60 * 60_000);
            for _ in 0..3 {
                engine.drain(&consumer, &shutdown).await?;
                clock.advance(60 * 60_000);
            }
            let settled = store.documents(domain_event_deliveries::COLLECTION).find_one(doc! { "eventKey": key.as_str() }).await?;
            let runs = behaviour.calls(&key);
            let (want_status, want_runs) = match name {
                "claim, reply lost" | "claim, request lost" | "completion, reply lost" => ("succeeded", 1),
                "completion, request lost" => ("succeeded", 2),
                "failure, reply lost" | "failure, request lost" => ("retry", 4),
                "delivery creation, reply lost" => ("succeeded", 1),
                "checkpoint, reply lost" | "checkpoint, request lost" => ("succeeded", 1),
                "missing journal, reply lost" => ("dead", 0),
                _ => bail!("{name}"),
            };
            ensure!(
                settled.as_ref().map(status) == Some(want_status) && runs == want_runs,
                "{name}: settled {settled:?} after {runs} runs, expected {want_status} after {want_runs}"
            );
            ensure!(count(&store, doc! {}).await? == 1, "{name}: one delivery");
            Ok(())
        })
        .await?;
    }
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_silent_store_during_a_handler_loses_the_lease_and_records_nothing() -> Result<()> {
    with_store(|store| async move {
        let Some(address) = support::mongo_address()? else {
            return Ok(());
        };
        let proxy = Proxy::start(address).await?;
        let Some(through) = support::store_through(&proxy, store.database().name()).await? else {
            return Ok(());
        };
        journal(
            &store,
            Arc::new(SystemClock),
            "fault",
            &[("renewal", "block")],
        )
        .await?;
        let behaviour = Arc::new(Behaviour::default());
        let engine = engine(&through, Arc::new(SystemClock), FAST).await?;
        let consumer = consumer_of(&FAULT, &behaviour);
        let pass = tokio::spawn(async move { engine.drain(&consumer, &Shutdown::new()).await });
        tokio::time::timeout(Duration::from_secs(10), behaviour.entered.notified()).await?;
        proxy.blackhole();
        // The heartbeat's renewal cannot complete; the lease is given up before it expires.
        let result = tokio::time::timeout(Duration::from_secs(10), pass).await??;
        proxy.restore();
        ensure!(
            matches!(
                result,
                Err(ConsumerError::Stopped {
                    reason: StopReason::LeaseLost,
                    ..
                })
            ),
            "{result:?}"
        );
        ensure!(
            behaviour.running.load(Ordering::SeqCst) == 0,
            "aborted and joined"
        );
        let stored = delivery(&store, "fault-v1", &key("fault", "renewal")).await?;
        ensure!(
            status(&stored) == "processing" && attempts(&stored) == 1,
            "{stored}"
        );
        Ok(())
    })
    .await
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_poison_event_dies_after_its_attempts_and_blocks_nothing() -> Result<()> {
    with_store(|store| async move {
        let clock = ManualClock::new(1_794_392_430_456);
        journal(
            &store,
            Arc::new(clock.clone()),
            "fault",
            &[("poison", "fail"), ("a", "ok"), ("b", "ok"), ("c", "ok")],
        )
        .await?;
        let behaviour = Arc::new(Behaviour::default());
        let consumer = consumer_of(&FAULT, &behaviour);
        let three = ConsumerConfig {
            max_attempts: 3,
            ..FAST
        };
        let engine = engine(&store, Arc::new(clock.clone()), three).await?;
        let shutdown = Shutdown::new();
        let first = engine.drain(&consumer, &shutdown).await?;
        ensure!(
            first.succeeded == 3 && first.retried == 1,
            "the others are not blocked: {first:?}"
        );
        for id in ["a", "b", "c"] {
            ensure!(status(&delivery(&store, "fault-v1", &key("fault", id)).await?) == "succeeded");
        }
        clock.advance(5_000);
        ensure!(engine.drain(&consumer, &shutdown).await?.retried == 1);
        clock.advance(30_000);
        let last = engine.drain(&consumer, &shutdown).await?;
        ensure!(last.dead == 1, "{last:?}");
        let dead = delivery(&store, "fault-v1", &key("fault", "poison")).await?;
        ensure!(status(&dead) == "dead" && attempts(&dead) == 3);
        ensure!(
            dead.get_str("lastErrorCode")? == "handler_failed"
                && dead.get_str("lastDeadLetterError")? == "boom\n"
        );
        ensure!(behaviour.calls(&key("fault", "poison")) == 3);
        clock.advance(24 * 3_600_000);
        let after = engine.drain(&consumer, &shutdown).await?;
        ensure!(
            after == DrainResult::default(),
            "nothing runs again: {after:?}"
        );
        Ok(())
    })
    .await
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_slow_consumer_does_not_starve_the_others() -> Result<()> {
    with_store(|store| async move {
        journal(
            &store,
            Arc::new(SystemClock),
            "fault",
            &[("s1", "slow"), ("s2", "slow"), ("s3", "slow")],
        )
        .await?;
        let fast: Vec<(String, &str)> = (0..5).map(|i| (format!("f{i}"), "ok")).collect();
        let fast: Vec<(&str, &str)> = fast.iter().map(|(id, s)| (id.as_str(), *s)).collect();
        journal(&store, Arc::new(SystemClock), "fault-other", &fast).await?;
        let behaviour = Arc::new(Behaviour::default());
        let shutdown = Shutdown::new();
        let started = tokio::time::Instant::now();
        let running = spawn(
            runtime(
                &store,
                FAST,
                vec![
                    consumer_of(&FAULT, &behaviour),
                    consumer_of(&OTHER, &behaviour),
                ],
                &BOTH,
            )
            .await?,
            &shutdown,
        );
        until(
            "the fast consumer is done",
            Duration::from_secs(10),
            || async {
                Ok(count(
                    &store,
                    doc! { "consumer": "fault-other-v1", "status": "succeeded" },
                )
                .await?
                    == 5)
            },
        )
        .await?;
        let fast_done = started.elapsed();
        let slow_done = count(
            &store,
            doc! { "consumer": "fault-v1", "status": "succeeded" },
        )
        .await?;
        ensure!(
            fast_done < Duration::from_millis(1_900) && slow_done == 0,
            "the fast consumer finished in {fast_done:?} while the slow one had {slow_done} done"
        );
        shutdown.trigger();
        running.await??;
        Ok(())
    })
    .await
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn shutdown_gives_a_handler_its_grace_then_leaves_its_lease() -> Result<()> {
    with_store(|store| async move {
        // Finishes within the grace: its outcome is recorded.
        journal(
            &store,
            Arc::new(SystemClock),
            "fault",
            &[("graceful", "sleep-300")],
        )
        .await?;
        let behaviour = Arc::new(Behaviour::default());
        let shutdown = Shutdown::new();
        let running = spawn(
            runtime(&store, FAST, vec![consumer_of(&FAULT, &behaviour)], &ONE).await?,
            &shutdown,
        );
        tokio::time::timeout(Duration::from_secs(10), behaviour.entered.notified()).await?;
        shutdown.trigger();
        running.await??;
        ensure!(
            status(&delivery(&store, "fault-v1", &key("fault", "graceful")).await?) == "succeeded"
        );

        // Does not finish: aborted at the end of the grace, nothing recorded, the lease kept.
        journal(
            &store,
            Arc::new(SystemClock),
            "fault",
            &[("stuck", "block-once")],
        )
        .await?;
        let shutdown = Shutdown::new();
        let running = spawn(
            runtime(&store, FAST, vec![consumer_of(&FAULT, &behaviour)], &ONE).await?,
            &shutdown,
        );
        tokio::time::timeout(Duration::from_secs(10), behaviour.entered.notified()).await?;
        let stopping = tokio::time::Instant::now();
        shutdown.trigger();
        running.await??;
        let took = stopping.elapsed();
        ensure!(
            took >= Duration::from_millis(450) && took < Duration::from_millis(2_500),
            "stopped after the grace, within the deadline: {took:?}"
        );
        ensure!(behaviour.running.load(Ordering::SeqCst) == 0);
        let key = key("fault", "stuck");
        let held = delivery(&store, "fault-v1", &key).await?;
        ensure!(
            status(&held) == "processing" && attempts(&held) == 1,
            "never marked done: {held}"
        );
        // The next process completes it after the lease.
        let shutdown = Shutdown::new();
        let running = spawn(
            runtime(&store, FAST, vec![consumer_of(&FAULT, &behaviour)], &ONE).await?,
            &shutdown,
        );
        until(
            "completed after the lease",
            Duration::from_secs(15),
            || async { Ok(status(&delivery(&store, "fault-v1", &key).await?) == "succeeded") },
        )
        .await?;
        shutdown.trigger();
        running.await??;
        Ok(())
    })
    .await
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_handler_past_its_execution_limit_is_stopped_and_retried_later() -> Result<()> {
    with_store(|store| async move {
        let clock = ManualClock::new(1_794_392_430_456);
        journal(
            &store,
            Arc::new(clock.clone()),
            "fault",
            &[("limit", "block-once")],
        )
        .await?;
        let behaviour = Arc::new(Behaviour::default());
        let consumer = consumer_of(&FAULT, &behaviour);
        let limited = ConsumerConfig {
            execution_timeout_ms: 1_000,
            ..FAST
        };
        let engine = engine(&store, Arc::new(clock.clone()), limited).await?;
        let shutdown = Shutdown::new();
        let started = tokio::time::Instant::now();
        let result = engine.drain(&consumer, &shutdown).await;
        ensure!(
            matches!(
                result,
                Err(ConsumerError::Stopped {
                    reason: StopReason::ExecutionLimit,
                    ..
                })
            ),
            "{result:?}"
        );
        ensure!(
            started.elapsed() >= Duration::from_millis(1_000)
                && started.elapsed() < Duration::from_secs(3)
        );
        ensure!(behaviour.running.load(Ordering::SeqCst) == 0);
        let key = key("fault", "limit");
        ensure!(status(&delivery(&store, "fault-v1", &key).await?) == "processing");
        // Not before the lease expires; after it, the next attempt runs.
        ensure!(engine.drain(&consumer, &shutdown).await?.succeeded == 0);
        clock.advance(FAST.lease_ms);
        ensure!(engine.drain(&consumer, &shutdown).await?.succeeded == 1);
        ensure!(attempts(&delivery(&store, "fault-v1", &key).await?) == 2);
        Ok(())
    })
    .await
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_handler_that_cannot_be_stopped_makes_the_runtime_fail() -> Result<()> {
    with_store(|store| async move {
        journal(
            &store,
            Arc::new(SystemClock),
            "fault",
            &[("unstoppable", "sync-block")],
        )
        .await?;
        let behaviour = Arc::new(Behaviour::default());
        let config = ConsumerConfig {
            execution_timeout_ms: 1_000,
            abort_grace_ms: 200,
            ..FAST
        };
        let started = tokio::time::Instant::now();
        let ran = runtime(&store, config, vec![consumer_of(&FAULT, &behaviour)], &ONE)
            .await?
            .run(&Shutdown::new())
            .await;
        ensure!(
            matches!(ran, Err(ConsumerError::Unstoppable { .. })),
            "{ran:?}"
        );
        ensure!(
            started.elapsed() < Duration::from_millis(2_400),
            "it does not wait for the stuck handler"
        );
        // Let the stuck thread finish before the database is dropped.
        until(
            "the blocked handler ends",
            Duration::from_secs(5),
            || async { Ok(behaviour.running.load(Ordering::SeqCst) == 0) },
        )
        .await?;
        let held = delivery(&store, "fault-v1", &key("fault", "unstoppable")).await?;
        ensure!(status(&held) == "processing", "nothing recorded: {held}");
        Ok(())
    })
    .await
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn batches_and_the_overall_limit_are_bounded() -> Result<()> {
    with_store(|store| async move {
        let clock = ManualClock::new(1_794_392_430_456);
        let items: Vec<(String, &str)> = (0..7).map(|i| (format!("b{i}"), "ok")).collect();
        let items: Vec<(&str, &str)> = items.iter().map(|(id, s)| (id.as_str(), *s)).collect();
        journal(&store, Arc::new(clock.clone()), "fault", &items).await?;
        let report = support::indexes(&store, &domain_event_deliveries::INFO).await?;
        Dispatcher::new(
            store.clone(),
            Arc::new(clock.clone()),
            &events_config(),
            &ONE,
            &report,
        )?
        .dispatch(100)
        .await?;
        let behaviour = Arc::new(Behaviour::default());
        let small = ConsumerConfig {
            batch_size: 3,
            ..FAST
        };
        let engine = engine(&store, Arc::new(clock.clone()), small).await?;
        let consumer = consumer_of(&FAULT, &behaviour);
        let shutdown = Shutdown::new();
        let first = engine.drain(&consumer, &shutdown).await?;
        ensure!(
            first.ready == 3 && first.scanned == 3 && first.succeeded == 3,
            "{first:?}"
        );
        let mut passes = 1;
        while count(&store, doc! { "status": "succeeded" }).await? < 7 {
            let pass = engine.drain(&consumer, &shutdown).await?;
            ensure!(pass.ready <= 3 && pass.scanned <= 3, "{pass:?}");
            passes += 1;
            ensure!(passes < 10, "bounded passes make progress");
        }
        ensure!(behaviour.total() == 7);

        // The overall limit: two consumers, one handler at a time.
        journal(
            &store,
            Arc::new(SystemClock),
            "fault",
            &[("l1", "sleep-300"), ("l2", "sleep-300")],
        )
        .await?;
        journal(
            &store,
            Arc::new(SystemClock),
            "fault-other",
            &[("l3", "sleep-300"), ("l4", "sleep-300")],
        )
        .await?;
        let limited = Arc::new(Behaviour::default());
        let shutdown = Shutdown::new();
        let running = spawn(
            runtime(
                &store,
                FAST,
                vec![consumer_of(&FAULT, &limited), consumer_of(&OTHER, &limited)],
                &BOTH,
            )
            .await?
            .with_max_in_flight(1),
            &shutdown,
        );
        until("all four handled", Duration::from_secs(15), || async {
            Ok(limited.total() == 4)
        })
        .await?;
        shutdown.trigger();
        running.await??;
        ensure!(
            limited.peak.load(Ordering::SeqCst) == 1,
            "peak {}",
            limited.peak.load(Ordering::SeqCst)
        );
        Ok(())
    })
    .await
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn deliveries_left_by_the_typescript_runtime_are_taken_over() -> Result<()> {
    with_store(|store| async move {
        let now = 1_794_392_430_456;
        let clock = ManualClock::new(now);
        let items = [("pending", "ok"), ("due", "ok"), ("waiting", "ok"), ("leased", "ok"), ("exhausted", "ok"), ("dead", "ok"), ("done", "ok")];
        journal(&store, Arc::new(clock.clone()), "fault", &items).await?;
        let report = support::indexes(&store, &domain_event_deliveries::INFO).await?;
        Dispatcher::new(store.clone(), Arc::new(clock.clone()), &events_config(), &ONE, &report)?
            .dispatch(100)
            .await?;
        let at = |ms: i64| bson::DateTime::from_millis(ms);
        let set = |id: &str, fields: Document| {
            let store = store.clone();
            let key = key("fault", id);
            async move {
                store
                    .documents(domain_event_deliveries::COLLECTION)
                    .update_one(doc! { "eventKey": key }, doc! { "$set": fields })
                    .await
            }
        };
        // As the TypeScript runtime leaves them when it stops.
        set("due", doc! { "status": "retry", "attempts": 1, "nextAttemptAt": at(now - 1_000), "lastError": "boom\nError: boom\n    at handler", "lastErrorCode": "handler_failed", "firstAttemptAt": at(now - 6_000) }).await?;
        set("waiting", doc! { "status": "retry", "attempts": 2, "nextAttemptAt": at(now + 30_000) }).await?;
        set("leased", doc! { "status": "processing", "attempts": 1, "leaseToken": "3f0e9a52-1c1d-4c1e-9a2b-typescript", "lockedUntil": at(now + 40_000), "firstAttemptAt": at(now - 20_000) }).await?;
        set("exhausted", doc! { "status": "processing", "attempts": 5, "leaseToken": "8a1b-typescript", "lockedUntil": at(now - 1) }).await?;
        set("dead", doc! { "status": "dead", "attempts": 5, "lastErrorCode": "handler_failed", "deadLetteredAt": at(now - 60_000), "completedAt": at(now - 60_000) }).await?;
        set("done", doc! { "status": "succeeded", "attempts": 1, "completedAt": at(now - 60_000) }).await?;

        let behaviour = Arc::new(Behaviour::default());
        let engine = engine(&store, Arc::new(clock.clone()), FAST).await?;
        let consumer = consumer_of(&FAULT, &behaviour);
        let shutdown = Shutdown::new();
        engine.drain(&consumer, &shutdown).await?;
        let state = |id: &'static str| {
            let store = store.clone();
            async move { delivery(&store, "fault-v1", &key("fault", id)).await }
        };
        ensure!(status(&state("pending").await?) == "succeeded");
        let due = state("due").await?;
        ensure!(status(&due) == "succeeded" && attempts(&due) == 2 && due.get_str("lastError")?.is_empty());
        ensure!(date_ms(&due, "firstAttemptAt") == Some(now - 6_000), "the first attempt is kept");
        ensure!(status(&state("waiting").await?) == "retry", "a retry waits for its time");
        let leased = state("leased").await?;
        ensure!(status(&leased) == "processing" && leased.get_str("leaseToken")?.ends_with("typescript"), "a live lease is respected");
        let exhausted = state("exhausted").await?;
        ensure!(status(&exhausted) == "dead" && exhausted.get_str("lastErrorCode")? == "interrupted");
        ensure!(behaviour.calls(&key("fault", "exhausted")) == 0, "an interrupted final attempt never runs again");
        ensure!(status(&state("dead").await?) == "dead" && status(&state("done").await?) == "succeeded");
        ensure!(behaviour.calls(&key("fault", "dead")) == 0 && behaviour.calls(&key("fault", "done")) == 0);

        // After the TypeScript lease and the retry time.
        clock.advance(40_000);
        engine.drain(&consumer, &shutdown).await?;
        let leased = state("leased").await?;
        ensure!(status(&leased) == "succeeded" && attempts(&leased) == 2);
        let waiting = state("waiting").await?;
        ensure!(status(&waiting) == "succeeded" && attempts(&waiting) == 3);
        Ok(())
    })
    .await
}
