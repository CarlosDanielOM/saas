//! What a kill, an outage or a duplicate delivery leaves, against the real local MongoDB and
//! Dragonfly. A "kill" stops the ingress at a step (the test-only fault hook never returns, the
//! server task is aborted, so the client sees its connection end without an answer, as Twitch
//! would) and a fresh ingress over the same stores receives Twitch's redelivery.

mod support;

use anyhow::{Context, Result, ensure};
use dima_chat::ingress::{FaultHook, FaultPoint};
use dima_events::config::EventsConfig;
use dima_events::contracts::policy::CONSUMERS;
use dima_events::dispatch::Dispatcher;
use futures_util::future::{BoxFuture, join_all};
use serde_json::json;
use std::sync::Arc;
use std::time::Duration;
use support::{RawRequest, RecordingHandler, Stores};
use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
use tokio::sync::Notify;

const NOW: i64 = 1_794_475_800_123; // 2026-11-12T09:30:00.123Z

fn follow_body(id: &str) -> Vec<u8> {
    json!({
        "subscription": {"id": format!("sub-{id}"), "status": "enabled", "type": "channel.follow",
            "version": "2", "condition": {"broadcaster_user_id": "1001", "moderator_user_id": "698614112"},
            "transport": {"method": "webhook", "callback": "https://subscriptions.domdimabot.com/eventsub"},
            "created_at": "2026-11-01T08:00:00Z", "cost": 0},
        "event": {"user_id": "5002", "user_login": "follower", "user_name": "Follower",
            "broadcaster_user_id": "1001", "broadcaster_user_login": "first",
            "broadcaster_user_name": "First", "followed_at": "2026-11-12T09:29:58Z"}
    })
    .to_string()
    .into_bytes()
}

fn chat_body(id: &str) -> Vec<u8> {
    json!({
        "subscription": {"id": "sub-chat", "status": "enabled", "type": "channel.chat.message",
            "version": "1", "condition": {"broadcaster_user_id": "1001", "user_id": "698614112"},
            "transport": {"method": "webhook", "callback": "https://subscriptions.domdimabot.com/eventsub"},
            "created_at": "2026-11-01T08:00:00Z", "cost": 0},
        "event": {"broadcaster_user_id": "1001", "broadcaster_user_login": "first",
            "broadcaster_user_name": "First", "chatter_user_id": "5001", "chatter_user_login": "viewer",
            "chatter_user_name": "Viewer", "message_id": format!("chat-{id}"),
            "message": {"text": "!hola 👋🏽", "fragments": []}, "badges": [], "color": ""}
    })
    .to_string()
    .into_bytes()
}

fn delivery(id: &str, body: &[u8]) -> RawRequest {
    support::signed(
        "notification",
        id,
        &support::twitch_time(NOW - 2_000),
        "0",
        body,
    )
}

async fn journaled(stores: &Stores) -> Result<Vec<bson::Document>> {
    support::documents(&stores.mongo, "domain_events").await
}

/// A hook that stops at `point` for good and tells the test it got there.
fn stop_at(point: FaultPoint) -> (FaultHook, Arc<Notify>) {
    let reached = Arc::new(Notify::new());
    let signal = reached.clone();
    let hook: FaultHook = Arc::new(move |at, _id| -> BoxFuture<'static, ()> {
        let signal = signal.clone();
        Box::pin(async move {
            if at == point {
                signal.notify_one();
                std::future::pending::<()>().await;
            }
        })
    });
    (hook, reached)
}

async fn reach(reached: &Notify) -> Result<()> {
    tokio::time::timeout(Duration::from_secs(30), reached.notified())
        .await
        .context("the fault point was not reached")
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn simultaneous_deliveries_of_a_journaled_notification_are_processed_once() -> Result<()> {
    support::with_stores("concurrent_journaled", |stores| async move {
        let handler = RecordingHandler::default();
        let harness = support::harness(
            &stores,
            &stores.mongo,
            support::config(&stores.prefix),
            NOW,
            handler.clone(),
            None,
        )
        .await?;
        let server = support::serve(&harness.ingress).await?;
        let request = delivery("concurrent-follow", &follow_body("concurrent-follow"));
        let answers =
            join_all((0..8).map(|_| support::send(server.address, &request, false))).await;
        for answer in answers {
            ensure!(answer?.status == 204);
        }
        support::settle(&harness.ingress).await?;
        ensure!(journaled(&stores).await?.len() == 1, "one event");
        ensure!(
            handler.notifications().len() == 1,
            "the inline handler ran once"
        );
        ensure!(
            harness.ingress.stats().duplicates == 7,
            "{:?}",
            harness.ingress.stats()
        );
        Ok(())
    })
    .await
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn simultaneous_deliveries_of_a_chat_message_are_processed_once() -> Result<()> {
    support::with_stores("concurrent_chat", |stores| async move {
        let handler = RecordingHandler::default();
        let harness = support::harness(
            &stores,
            &stores.mongo,
            support::config(&stores.prefix),
            NOW,
            handler.clone(),
            None,
        )
        .await?;
        let server = support::serve(&harness.ingress).await?;
        let request = delivery("concurrent-chat", &chat_body("concurrent-chat"));
        let answers =
            join_all((0..8).map(|_| support::send(server.address, &request, false))).await;
        for answer in answers {
            ensure!(answer?.status == 204);
        }
        support::settle(&harness.ingress).await?;
        ensure!(
            handler.notifications().len() == 1,
            "the handler ran {} times",
            handler.notifications().len()
        );
        ensure!(
            harness.ingress.stats().claimed_before == 7,
            "{:?}",
            harness.ingress.stats()
        );
        ensure!(
            journaled(&stores).await?.is_empty(),
            "chat messages are not journaled"
        );
        Ok(())
    })
    .await
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_kill_after_the_journal_write_leaves_the_event_for_the_consumers_once() -> Result<()> {
    support::with_stores("kill_after_journal", |stores| async move {
        let (hook, reached) = stop_at(FaultPoint::AfterJournal);
        let first = RecordingHandler::default();
        let dead = support::harness(
            &stores,
            &stores.mongo,
            support::config(&stores.prefix),
            NOW,
            first.clone(),
            Some(hook),
        )
        .await?;
        let server = support::serve(&dead.ingress).await?;
        let request = delivery("kill-journal", &follow_body("kill-journal"));
        let client = tokio::spawn({
            let request = request.clone();
            async move { support::send(server.address, &request, false).await }
        });
        reach(&reached).await?;
        // Killed: no answer reaches Twitch.
        server.task.abort();
        let answer = client.await?;
        ensure!(answer.is_err(), "no answer after the kill: {answer:?}");
        let events = journaled(&stores).await?;
        ensure!(events.len() == 1, "the event is journaled");
        ensure!(
            events[0].get_bool("dispatchPending").ok() == Some(true),
            "and marked for dispatch"
        );
        ensure!(first.notifications().is_empty());

        // Twitch redelivers to a new process: answered, nothing journaled twice, the inline
        // handler does not run (the reference's choice for a duplicate).
        let second = RecordingHandler::default();
        let alive = support::harness(
            &stores,
            &stores.mongo,
            support::config(&stores.prefix),
            NOW,
            second.clone(),
            None,
        )
        .await?;
        let server = support::serve(&alive.ingress).await?;
        ensure!(support::send(server.address, &request, false).await?.status == 204);
        support::settle(&alive.ingress).await?;
        ensure!(journaled(&stores).await?.len() == 1);
        ensure!(second.notifications().is_empty());

        // The consumers get it exactly once: one delivery per consumer, however often the
        // dispatcher runs.
        let info = &dima_model::domain_event_deliveries::INFO;
        let policy = dima_model::startup_policy(info).context("deliveries policy")?;
        let report =
            dima_model::ensure_indexes(&stores.mongo, info, policy, Duration::from_secs(30)).await;
        let dispatcher = Dispatcher::new(
            stores.mongo.clone(),
            Arc::new(dima_core::ManualClock::new(NOW)),
            &EventsConfig::default(),
            &CONSUMERS,
            &report,
        )?;
        let once = dispatcher.dispatch(500).await?;
        let again = dispatcher.dispatch(500).await?;
        ensure!(once.events == 1 && again.events == 0, "{once:?} {again:?}");
        let deliveries = support::documents(&stores.mongo, "domain_event_deliveries").await?;
        ensure!(
            !deliveries.is_empty() && deliveries.len() == once.deliveries,
            "{} deliveries",
            deliveries.len()
        );
        let mut consumers: Vec<&str> = deliveries
            .iter()
            .filter_map(|d| d.get_str("consumer").ok())
            .collect();
        let count = consumers.len();
        consumers.dedup();
        ensure!(consumers.len() == count, "one delivery per consumer");
        Ok(())
    })
    .await
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_kill_before_the_answer_of_a_chat_message_leaves_no_claim() -> Result<()> {
    support::with_stores("kill_before_answer", |stores| async move {
        // The claim of a non-journaled type comes after the answer, so a process that dies
        // before answering cannot make Twitch's redelivery look like a duplicate. Shown with a
        // kill in the middle of the body (the earliest point a delivery can die).
        let first = RecordingHandler::default();
        let dead = support::harness(&stores, &stores.mongo, support::config(&stores.prefix), NOW, first.clone(), None).await?;
        let server = support::serve(&dead.ingress).await?;
        let request = delivery("kill-body", &chat_body("kill-body"));
        let mut stream = tokio::net::TcpStream::connect(server.address).await?;
        let head = format!(
            "POST /eventsub HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\n{}Content-Length: {}\r\n\r\n",
            request.headers.iter().skip(1).map(|(n, v)| format!("{n}: {}\r\n", String::from_utf8_lossy(v))).collect::<String>(),
            request.body.len()
        );
        stream.write_all(head.as_bytes()).await?;
        stream.write_all(request.body.get(..20).unwrap_or_default()).await?;
        drop(stream);
        for _ in 0..1000 {
            if dead.ingress.stats().bad_bodies == 1 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        ensure!(dead.ingress.stats().bad_bodies == 1, "{:?}", dead.ingress.stats());
        server.task.abort();
        let claims = support::keys(&stores.dragonfly, &format!("{}twitch:eventsub:message:", stores.prefix)).await?;
        ensure!(claims.is_empty(), "no claim: {claims:?}");

        let second = RecordingHandler::default();
        let alive = support::harness(&stores, &stores.mongo, support::config(&stores.prefix), NOW, second.clone(), None).await?;
        let server = support::serve(&alive.ingress).await?;
        ensure!(support::send(server.address, &request, false).await?.status == 204);
        support::settle(&alive.ingress).await?;
        ensure!(second.notifications().len() == 1, "the redelivery is processed");
        Ok(())
    })
    .await
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_kill_after_the_answer_is_at_most_once() -> Result<()> {
    support::with_stores("kill_after_answer", |stores| async move {
        // Killed after the answer, before the claim: Twitch has its 204 and does not redeliver;
        // the message is lost, as in the reference. Should Twitch redeliver anyway, it is
        // processed (no claim was left).
        let (hook, reached) = stop_at(FaultPoint::AfterAnswer);
        let dead = support::harness(
            &stores,
            &stores.mongo,
            support::config(&stores.prefix),
            NOW,
            RecordingHandler::default(),
            Some(hook),
        )
        .await?;
        let server = support::serve(&dead.ingress).await?;
        let request = delivery("kill-answered", &chat_body("kill-answered"));
        ensure!(support::send(server.address, &request, false).await?.status == 204);
        reach(&reached).await?;
        server.task.abort();
        let prefix = format!("{}twitch:eventsub:message:", stores.prefix);
        ensure!(support::keys(&stores.dragonfly, &prefix).await?.is_empty());

        // Killed after the claim, before the handler: a redelivery is acknowledged only.
        let (hook, reached) = stop_at(FaultPoint::BeforeHandler);
        let dead = support::harness(
            &stores,
            &stores.mongo,
            support::config(&stores.prefix),
            NOW,
            RecordingHandler::default(),
            Some(hook),
        )
        .await?;
        let server = support::serve(&dead.ingress).await?;
        ensure!(support::send(server.address, &request, false).await?.status == 204);
        reach(&reached).await?;
        server.task.abort();
        ensure!(
            support::keys(&stores.dragonfly, &prefix).await?.len() == 1,
            "claimed"
        );

        let third = RecordingHandler::default();
        let alive = support::harness(
            &stores,
            &stores.mongo,
            support::config(&stores.prefix),
            NOW,
            third.clone(),
            None,
        )
        .await?;
        let server = support::serve(&alive.ingress).await?;
        ensure!(support::send(server.address, &request, false).await?.status == 204);
        support::settle(&alive.ingress).await?;
        ensure!(
            third.notifications().is_empty(),
            "seen: not processed again"
        );
        ensure!(alive.ingress.stats().claimed_before == 1);
        Ok(())
    })
    .await
}

/// A TCP proxy in front of MongoDB that forwards until [`Proxy::hang`], then drops what it
/// forwards and holds every new connection without answering (a MongoDB that hangs).
struct Proxy {
    address: String,
    silent: Arc<std::sync::atomic::AtomicBool>,
    forwarding: Arc<std::sync::Mutex<Vec<tokio::task::JoinHandle<()>>>>,
    accept: tokio::task::JoinHandle<()>,
}

impl Proxy {
    async fn start(upstream: String) -> Result<Self> {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
        let address = listener.local_addr()?.to_string();
        let silent = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let forwarding: Arc<std::sync::Mutex<Vec<tokio::task::JoinHandle<()>>>> = Arc::default();
        let accept = tokio::spawn({
            let silent = silent.clone();
            let forwarding = forwarding.clone();
            async move {
                let mut held = Vec::new();
                while let Ok((mut client, _)) = listener.accept().await {
                    if silent.load(std::sync::atomic::Ordering::SeqCst) {
                        held.push(client);
                        continue;
                    }
                    let upstream = upstream.clone();
                    let task = tokio::spawn(async move {
                        if let Ok(mut server) = tokio::net::TcpStream::connect(upstream).await {
                            let _ = tokio::io::copy_bidirectional(&mut client, &mut server).await;
                        }
                    });
                    if let Ok(mut tasks) = forwarding.lock() {
                        tasks.push(task);
                    }
                }
            }
        });
        Ok(Self {
            address,
            silent,
            forwarding,
            accept,
        })
    }

    fn hang(&self) {
        self.silent.store(true, std::sync::atomic::Ordering::SeqCst);
        if let Ok(mut tasks) = self.forwarding.lock() {
            for task in tasks.drain(..) {
                task.abort();
            }
        }
    }
}

impl Drop for Proxy {
    fn drop(&mut self) {
        self.hang();
        self.accept.abort();
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_journal_that_cannot_be_written_answers_503_and_the_redelivery_is_recorded_once()
-> Result<()> {
    support::with_stores("journal_down", |stores| async move {
        let upstream = "127.0.0.1:27017";
        ensure!(
            stores.uri.contains(upstream),
            "the local MongoDB is expected on {upstream}"
        );
        let proxy = Proxy::start(upstream.to_owned()).await?;
        let hung = support::connect(
            &stores.uri.replace(upstream, &proxy.address),
            &stores.database,
        )
        .await?;
        hung.ping().await?;
        proxy.hang();
        let mut config = support::config(&stores.prefix);
        config.durable_deadline = Duration::from_secs(2);
        let first = RecordingHandler::default();
        let down = support::harness(&stores, &hung, config, NOW, first.clone(), None).await?;
        let server = support::serve(&down.ingress).await?;
        let request = delivery("journal-down", &follow_body("journal-down"));
        let started = std::time::Instant::now();
        let answer = support::send(server.address, &request, false).await?;
        ensure!(answer.status == 503, "{}", answer.status);
        ensure!(
            started.elapsed() < Duration::from_secs(10),
            "answered within the deadline"
        );
        ensure!(journaled(&stores).await?.is_empty());
        ensure!(
            first.notifications().is_empty(),
            "nothing processed for an unrecorded event"
        );

        // Refusals need no store: a wrong signature is answered at once although MongoDB hangs.
        let mut forged = request.clone();
        forged
            .headers
            .retain(|(name, _)| name != "Twitch-Eventsub-Message-Signature");
        forged.headers.push((
            "Twitch-Eventsub-Message-Signature".to_owned(),
            format!("sha256={}", "0".repeat(64)).into_bytes(),
        ));
        let started = std::time::Instant::now();
        ensure!(support::send(server.address, &forged, false).await?.status == 403);
        ensure!(
            started.elapsed() < Duration::from_millis(1500),
            "no store call before verification"
        );
        server.task.abort();
        drop(proxy);

        let second = RecordingHandler::default();
        let up = support::harness(
            &stores,
            &stores.mongo,
            support::config(&stores.prefix),
            NOW,
            second.clone(),
            None,
        )
        .await?;
        let server = support::serve(&up.ingress).await?;
        ensure!(support::send(server.address, &request, false).await?.status == 204);
        ensure!(support::send(server.address, &request, false).await?.status == 204);
        support::settle(&up.ingress).await?;
        ensure!(journaled(&stores).await?.len() == 1);
        ensure!(second.notifications().len() == 1);
        Ok(())
    })
    .await
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn requests_beyond_the_limit_in_flight_are_refused_503() -> Result<()> {
    support::with_stores("overload", |stores| async move {
        let (hook, reached) = stop_at(FaultPoint::AfterJournal);
        let mut config = support::config(&stores.prefix);
        config.max_in_flight = 1;
        config.admission_wait = Duration::from_millis(200);
        let harness = support::harness(
            &stores,
            &stores.mongo,
            config,
            NOW,
            RecordingHandler::default(),
            Some(hook),
        )
        .await?;
        let server = support::serve(&harness.ingress).await?;
        let held = delivery("held", &follow_body("held"));
        let _client =
            tokio::spawn(async move { support::send(server.address, &held, false).await });
        reach(&reached).await?;
        let other = delivery("other", &follow_body("other"));
        ensure!(support::send(server.address, &other, false).await?.status == 503);
        ensure!(harness.ingress.stats().overloaded == 1);
        Ok(())
    })
    .await
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn drain_waits_for_the_handlers_started_after_answers() -> Result<()> {
    support::with_stores("drain", |stores| async move {
        let handler = RecordingHandler {
            delay: Some(Duration::from_millis(300)),
            ..RecordingHandler::default()
        };
        let harness = support::harness(
            &stores,
            &stores.mongo,
            support::config(&stores.prefix),
            NOW,
            handler.clone(),
            None,
        )
        .await?;
        let server = support::serve(&harness.ingress).await?;
        ensure!(
            support::send(
                server.address,
                &delivery("drain", &chat_body("drain")),
                false
            )
            .await?
            .status
                == 204
        );
        server.shutdown.trigger();
        let _ = server.task.await;
        ensure!(
            harness.ingress.drain(Duration::from_secs(10)).await,
            "drained"
        );
        ensure!(handler.notifications().len() == 1);
        ensure!(harness.metrics.inflight_eventsub_handlers() == 0);
        Ok(())
    })
    .await
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn refusals_cost_nothing_and_add_no_series() -> Result<()> {
    support::with_stores("refusals", |stores| async move {
        let harness = support::harness(&stores, &stores.mongo, support::config(&stores.prefix), NOW, RecordingHandler::default(), None).await?;
        let server = support::serve(&harness.ingress).await?;
        let body = chat_body("refused");
        // Varying header values and event types: refused, nothing stored, no key made.
        for index in 0..50 {
            let mut request = delivery(&format!("refused-{index}"), &body);
            request.headers.retain(|(name, _)| name != "Twitch-Eventsub-Message-Signature");
            request.headers.push(("Twitch-Eventsub-Message-Signature".to_owned(), format!("sha256={index:064x}").into_bytes()));
            ensure!(support::send(server.address, &request, false).await?.status == 403);
        }
        // An oversized body is refused from its declared length, before it is read.
        let mut large = delivery("large", &body);
        large.body = vec![b'x'; 5 * 1024 * 1024];
        ensure!(support::send(server.address, &large, true).await?.status == 413);
        let stats = harness.ingress.stats();
        ensure!(stats.bad_signatures == 50 && stats.bad_bodies == 1, "{stats:?}");
        ensure!(support::keys(&stores.dragonfly, &stores.prefix).await?.is_empty(), "no key written");
        ensure!(journaled(&stores).await?.is_empty());
        // A slow sender holds its connection only until the body deadline.
        let mut stream = tokio::net::TcpStream::connect(server.address).await?;
        stream
            .write_all(b"POST /eventsub HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: 100\r\n")
            .await?;
        let mut answer = Vec::new();
        let read = tokio::time::timeout(Duration::from_secs(30), stream.read_to_end(&mut answer)).await;
        ensure!(read.is_ok(), "the server closed a request head that never ended");
        Ok(())
    })
    .await
}
