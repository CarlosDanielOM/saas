//! Local Dragonfly DB 9, unique prefixes, cleanup even after a failed assertion.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
use anyhow::{Context, Result, bail};
use dima_core::{Clock, ManualClock, Random, SeededRandom};
use dima_features::widget_feed::{
    FeedConfig, FeedError, FeedMessage, FeedPublisher, PublishResult,
    badges::Badges,
    model::BadgeLookup,
    subscriptions::{FeedSubscriptions, WidgetSubscription},
};
use dima_http::guard::BoxFuture;
use dima_store::dragonfly::{Dragonfly, DragonflyConfig, Event, Hooks};
use futures_util::FutureExt;
use serde_json::{Value, json};
use std::{future::Future, panic::AssertUnwindSafe, sync::Arc, time::Duration};
#[derive(Default)]
struct EmptyBadges;
impl Badges for EmptyBadges {
    fn lookup<'a>(&'a self, _: &'a str) -> BoxFuture<'a, Result<BadgeLookup, FeedError>> {
        Box::pin(async { Ok(BadgeLookup::new()) })
    }
}
fn config() -> Result<Option<DragonflyConfig>> {
    let Ok(address) = std::env::var("DIMA_TEST_DRAGONFLY") else {
        if std::env::var("DIMA_TEST_REQUIRE_STORES").is_ok_and(|v| v == "1") {
            bail!("DIMA_TEST_DRAGONFLY required");
        }
        eprintln!("skipped: Dragonfly unset");
        return Ok(None);
    };
    let (host, port) = address.rsplit_once(':').context("address")?;
    let mut c = DragonflyConfig::from_env_values(
        Some(host),
        Some(&format!("{port}/9")),
        "widget-feed-test",
    );
    c.subscription_buffer = 128;
    Ok(Some(c))
}
async fn with_store<F, Fut>(body: F) -> Result<()>
where
    F: FnOnce(Dragonfly, String) -> Fut,
    Fut: Future<Output = Result<()>>,
{
    let Some(c) = config()? else {
        return Ok(());
    };
    let store = Dragonfly::connect(c, Hooks::default()).await?;
    let prefix = format!(
        "dima_test_features_feed_{}:",
        dima_core::SystemRandom.uuid_v4()?
    );
    let result = AssertUnwindSafe(body(store.clone(), prefix.clone()))
        .catch_unwind()
        .await;
    let mut scan = store.scan(&format!("{prefix}*"), Some(100));
    while let Some(keys) = scan.next_page().await? {
        let strings: Vec<String> = keys
            .iter()
            .map(|k| String::from_utf8_lossy(k).into_owned())
            .collect();
        let refs: Vec<&str> = strings.iter().map(String::as_str).collect();
        if !refs.is_empty() {
            store.del(&refs).await?;
        }
    }
    match result {
        Ok(r) => r,
        Err(p) => std::panic::resume_unwind(p),
    }
}
fn publisher(store: &Dragonfly, prefix: &str, clock: Arc<dyn Clock>) -> FeedPublisher {
    FeedPublisher::new(
        store.clone(),
        clock,
        Arc::new(SeededRandom::new(1)),
        Arc::new(EmptyBadges),
        FeedConfig {
            key_prefix: prefix.into(),
            ..FeedConfig::default()
        },
    )
}
fn message(channel: &str, id: &str) -> FeedMessage {
    FeedMessage {
        channel: channel.into(),
        kind: "chat.delete".into(),
        data: json!({"messageId":id,"userId":null}),
    }
}
async fn next_for(s: &mut dima_store::dragonfly::Subscription, channel: &str) -> Result<Value> {
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            match s.recv().await.context("stream ended")? {
                Event::Message(m) => {
                    let v: Value = serde_json::from_slice(&m.payload)?;
                    if v["channel"] == channel {
                        return Ok(v);
                    }
                }
                Event::Gap(g) => bail!("unexpected gap {g:?}"),
            }
        }
    })
    .await?
}
#[tokio::test]
async fn widget_feed_leases_limits_expiry_and_channel_isolation() -> Result<()> {
    with_store(|store, prefix| async move {
        let clock = ManualClock::new(1000);
        let leases = FeedSubscriptions::new(
            store.clone(),
            Arc::new(clock.clone()),
            prefix.clone(),
            Duration::from_secs(2),
        );
        let p = publisher(&store, &prefix, Arc::new(clock.clone()));
        let spec = WidgetSubscription {
            widget: "widget".into(),
            session: "session".into(),
            uses: vec!["chat".into(), "signals".into()],
        };
        leases.register("1001", &spec).await?;
        assert_eq!(leases.active("1001").await?.len(), 1);
        assert_eq!(
            store
                .exists(&[&p.key("widget-feed:demand", "1001")])
                .await?,
            1
        );
        assert_eq!(
            store
                .exists(&[&p.key("widget-feed:demand", "1002")])
                .await?,
            0
        );
        leases.register("1001", &spec).await?;
        assert_eq!(leases.active("1001").await?.len(), 1);
        leases.remove("1001", "widget", "session").await?;
        assert_eq!(
            store
                .exists(&[&p.key("widget-feed:demand", "1001")])
                .await?,
            0
        );
        for i in 0..16 {
            leases
                .register(
                    "1001",
                    &WidgetSubscription {
                        session: format!("s{i}"),
                        ..spec.clone()
                    },
                )
                .await?;
        }
        assert_eq!(
            leases
                .register(
                    "1001",
                    &WidgetSubscription {
                        session: "overflow".into(),
                        ..spec.clone()
                    }
                )
                .await
                .unwrap_err()
                .0,
            "widget_subscription_limit"
        );
        for i in 1..8 {
            for n in 0..16 {
                leases
                    .register(
                        "1001",
                        &WidgetSubscription {
                            widget: format!("w{i}"),
                            session: format!("s{n}"),
                            ..spec.clone()
                        },
                    )
                    .await?;
            }
        }
        assert_eq!(leases.active("1001").await?.len(), 128);
        assert!(
            leases
                .register(
                    "1001",
                    &WidgetSubscription {
                        widget: "overflow".into(),
                        ..spec.clone()
                    }
                )
                .await
                .is_err()
        );
        clock.set(61000);
        assert!(leases.active("1001").await?.is_empty());
        assert_eq!(
            store
                .exists(&[&p.key("widget-feed:demand", "1001")])
                .await?,
            0
        );
        leases.register("1001", &spec).await?;
        assert_eq!(leases.active("1001").await?.len(), 1);
        Ok(())
    })
    .await
}
#[tokio::test]
async fn widget_feed_shared_signal_quota_and_recorded_payloads() -> Result<()> {
    with_store(|store, prefix| async move {
        let cases: Vec<Value> = include_str!("widget_feed_reference.jsonl")
            .lines()
            .map(serde_json::from_str)
            .collect::<std::result::Result<_, _>>()?;
        let now = cases[0]["now"].as_i64().context("now")?;
        let case = cases
            .iter()
            .find(|c| c["op"] == "signal_publish")
            .context("case")?;
        let first = publisher(&store, &prefix, Arc::new(ManualClock::new(now)));
        let second = publisher(&store, &prefix, Arc::new(ManualClock::new(now)));
        let reader = store.subscriber();
        let mut sub = first.subscribe(&reader).await?;
        // Drain concurrently: these are quota/order tests, not overflow tests.
        let channel = format!("c{}", dima_core::SystemRandom.uuid_v4()?);
        let receive_channel = channel.clone();
        let task = tokio::spawn(async move {
            let mut rows = Vec::new();
            for _ in 0..30 {
                rows.push(next_for(&mut sub, &receive_channel).await?);
            }
            Ok::<_, anyhow::Error>(rows)
        });
        let mut statuses = Vec::new();
        for i in 0..31 {
            let p = if i % 2 == 0 { &first } else { &second };
            let result = p
                .publish(
                    FeedMessage {
                        channel: channel.clone(),
                        kind: "signal".into(),
                        data: case["input"]["signal"].clone(),
                    },
                    Some(&format!("action-{i}")),
                )
                .await;
            statuses.push(match result {
                PublishResult::Sent => "sent",
                PublishResult::Limited => "limited",
                other => bail!("unexpected {other:?}"),
            });
        }
        let duplicate = second
            .publish(
                FeedMessage {
                    channel: channel.clone(),
                    kind: "signal".into(),
                    data: case["input"]["signal"].clone(),
                },
                Some("action-0"),
            )
            .await;
        assert_eq!(duplicate, PublishResult::Duplicate);
        statuses.push("duplicate");
        assert_eq!(
            json!(statuses),
            Value::Array(case["result"]["statuses"].as_array().context("statuses")?[..32].to_vec())
        );
        let rows = task.await??;
        for (row, expected) in rows
            .iter()
            .zip(case["result"]["messages"].as_array().context("messages")?)
        {
            let mut expected = expected["message"].clone();
            expected["channel"] = channel.clone().into();
            assert_eq!(dima_text::to_js_json(row), dima_text::to_js_json(&expected));
        }
        assert_eq!(first.skipped_signals(&channel).await, 1);
        assert_eq!(
            case["result"]["seenLimited"], "1",
            "record the Node key-amplification bug before refusing it intentionally"
        );
        assert!(
            store
                .get_text(&first.key("widget-signal:seen", "action-30"))
                .await?
                .is_none(),
            "limited signals must not allocate dedupe keys"
        );
        assert!(!first.admit_signal(&channel).await?);
        first.count_skipped(&channel).await;
        assert_eq!(first.skipped_signals(&channel).await, 3);
        reader.shutdown().await;
        Ok(())
    })
    .await
}
struct SlowBadges {
    entered: tokio::sync::Notify,
    release: tokio::sync::Notify,
}
impl Badges for SlowBadges {
    fn lookup<'a>(&'a self, _: &'a str) -> BoxFuture<'a, Result<BadgeLookup, FeedError>> {
        Box::pin(async move {
            self.entered.notify_one();
            self.release.notified().await;
            Ok(BadgeLookup::new())
        })
    }
}
#[tokio::test]
async fn widget_feed_cold_badges_preserve_order_and_deadline_releases_tail() -> Result<()> {
    with_store(|store, prefix| async move {
        let clock = Arc::new(ManualClock::new(1794355200000));
        let slow = Arc::new(SlowBadges {
            entered: tokio::sync::Notify::new(),
            release: tokio::sync::Notify::new(),
        });
        let p = FeedPublisher::new(
            store.clone(),
            clock.clone(),
            Arc::new(SeededRandom::new(1)),
            slow.clone(),
            FeedConfig {
                key_prefix: prefix.clone(),
                deadline: Duration::from_millis(300),
                ..FeedConfig::default()
            },
        );
        let leases =
            FeedSubscriptions::new(store.clone(), clock, prefix.clone(), Duration::from_secs(2));
        let channel = format!("c{}", dima_core::SystemRandom.uuid_v4()?);
        leases
            .register(
                &channel,
                &WidgetSubscription {
                    widget: "w".into(),
                    session: "s".into(),
                    uses: vec!["chat".into()],
                },
            )
            .await?;
        let cases: Vec<Value> = include_str!("widget_feed_reference.jsonl")
            .lines()
            .map(serde_json::from_str)
            .collect::<std::result::Result<_, _>>()?;
        let event =
            cases.iter().find(|c| c["op"] == "chat").context("chat")?["input"]["event"].clone();
        let reader = store.subscriber();
        let mut sub = p.subscribe(&reader).await?;
        let a = p.clone();
        let c = channel.clone();
        let e = event.clone();
        let first = tokio::spawn(async move { a.chat(&c, "chat", &e).await });
        slow.entered.notified().await;
        let a = publisher(&store, &prefix, Arc::new(ManualClock::new(1794355200000)));
        let c = channel.clone();
        let next = tokio::spawn(async move {
            a.chat(&c, "chat.delete", &json!({"message_id":"message"}))
                .await
        });
        tokio::time::sleep(Duration::from_millis(30)).await;
        assert!(
            !next.is_finished(),
            "another process must wait for the globally reserved chat position"
        );
        slow.release.notify_one();
        assert_eq!(first.await?, PublishResult::Sent);
        assert_eq!(next.await?, PublishResult::Sent);
        assert_eq!(next_for(&mut sub, &channel).await?["type"], "chat");
        assert_eq!(next_for(&mut sub, &channel).await?["type"], "chat.delete");
        let result = p.chat(&channel, "chat", &event).await;
        assert_eq!(
            result,
            PublishResult::Failed(FeedError("widget_feed_deadline"))
        );
        assert_eq!(
            p.chat(&channel, "chat.clear", &json!({})).await,
            PublishResult::Sent
        );
        assert_eq!(next_for(&mut sub, &channel).await?["type"], "chat.clear");
        reader.shutdown().await;
        Ok(())
    })
    .await
}
#[tokio::test]
async fn widget_feed_overflow_and_resubscription_are_explicit_gaps() -> Result<()> {
    with_store(|store, prefix| async move {
        let p = publisher(&store, &prefix, Arc::new(ManualClock::new(1)));
        let mut small_config = store.config().clone();
        small_config.subscription_buffer = 2;
        let small = Dragonfly::connect(small_config, Hooks::default()).await?;
        let reader = small.subscriber();
        let mut sub = p.subscribe(&reader).await?;
        let channel = format!("c{}", dima_core::SystemRandom.uuid_v4()?);
        for n in 0..10 {
            assert_eq!(
                p.publish(message(&channel, &n.to_string()), None).await,
                PublishResult::Sent
            );
        }
        tokio::time::sleep(Duration::from_millis(30)).await;
        let mut gap = false;
        for _ in 0..4 {
            let Some(event) = tokio::time::timeout(Duration::from_secs(2), sub.recv()).await?
            else {
                break;
            };
            if let Event::Gap(g) = event {
                assert!(g.overflowed > 0);
                gap = true;
                break;
            }
        }
        assert!(gap, "overflow must produce a marker");
        // Kill only this task-owned subscriber connection; no container/configuration changes.
        let id = reader.connection_id();
        assert!(id > 0);
        let _: i64 = store
            .query(redis::cmd("CLIENT").arg("KILL").arg("ID").arg(id))
            .await?;
        let resubscribed = tokio::time::timeout(Duration::from_secs(5), async {
            while let Some(event) = sub.recv().await {
                if let Event::Gap(g) = event
                    && g.resubscribed
                {
                    return true;
                }
            }
            false
        })
        .await?;
        assert!(resubscribed);
        reader.shutdown().await;
        Ok(())
    })
    .await
}
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn widget_feed_two_processes_keep_each_source_order() -> Result<()> {
    with_store(|store, prefix| async move {
        let p = publisher(&store, &prefix, Arc::new(ManualClock::new(1)));
        let reader = store.subscriber();
        let mut sub = p.subscribe(&reader).await?;
        let channel = format!("c{}", dima_core::SystemRandom.uuid_v4()?);
        let c = channel.clone();
        let receive = tokio::spawn(async move {
            let mut rows = Vec::new();
            for _ in 0..20 {
                rows.push(next_for(&mut sub, &c).await?);
            }
            Ok::<_, anyhow::Error>(rows)
        });
        let mut children = Vec::new();
        for source in 0..2 {
            children.push(
                tokio::process::Command::new(std::env::current_exe()?)
                    .args(["--exact", "widget_feed_child_publish", "--nocapture"])
                    .env("DIMA_FEED_CHILD", &prefix)
                    .env("DIMA_FEED_CHANNEL", &channel)
                    .env("DIMA_FEED_SOURCE", source.to_string())
                    .kill_on_drop(true)
                    .spawn()?,
            );
        }
        for child in &mut children {
            assert!(
                tokio::time::timeout(Duration::from_secs(15), child.wait())
                    .await??
                    .success()
            );
        }
        let rows = receive.await??;
        let mut last = [0, 0];
        for r in rows {
            let id = r["data"]["messageId"].as_str().context("id")?;
            let (source, n) = id.split_once('-').context("source-index")?;
            let source: usize = source.parse()?;
            let n: usize = n.parse()?;
            assert_eq!(last[source], n);
            last[source] += 1;
        }
        assert_eq!(last, [10, 10]);
        reader.shutdown().await;
        Ok(())
    })
    .await
}
#[tokio::test]
async fn widget_feed_child_publish() -> Result<()> {
    let Ok(prefix) = std::env::var("DIMA_FEED_CHILD") else {
        return Ok(());
    };
    assert!(prefix.starts_with("dima_test_features_feed_"));
    let store = Dragonfly::connect(config()?.context("store")?, Hooks::default()).await?;
    let p = publisher(&store, &prefix, Arc::new(ManualClock::new(1)));
    let channel = std::env::var("DIMA_FEED_CHANNEL")?;
    let source = std::env::var("DIMA_FEED_SOURCE")?;
    for n in 0..10 {
        assert_eq!(
            p.publish(message(&channel, &format!("{source}-{n}")), None)
                .await,
            PublishResult::Sent
        );
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    Ok(())
}

#[tokio::test]
async fn widget_feed_failed_publish_is_a_value_and_cannot_fail_chat() -> Result<()> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let address = listener.local_addr()?;
    // A task-owned RESP peer completes startup, then rejects the actual EVALSHA publish.
    let reserve_hash = dima_store::dragonfly::Script::new(
        "TEST_RESERVE",
        include_str!("../src/widget_feed/lua/reserve.lua"),
    )
    .sha1()
    .to_owned();
    let server = tokio_util::task::AbortOnDropHandle::new(tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await?;
        let mut pending = Vec::new();
        fn line(bytes: &[u8], offset: usize) -> Option<(usize, usize)> {
            let end = bytes.get(offset..)?.windows(2).position(|w| w == b"\r\n")? + offset;
            let n = std::str::from_utf8(bytes.get(offset..end)?)
                .ok()?
                .parse()
                .ok()?;
            Some((n, end + 2))
        }
        fn frame(bytes: &[u8]) -> Option<usize> {
            if bytes.first() != Some(&b'*') {
                return None;
            }
            let (count, mut pos) = line(bytes, 1)?;
            if count > 128 {
                return None;
            }
            for _ in 0..count {
                if bytes.get(pos) != Some(&b'$') {
                    return None;
                }
                let (n, start) = line(bytes, pos + 1)?;
                if n > 65536 || bytes.len() < start + n + 2 {
                    return None;
                }
                pos = start + n + 2;
            }
            Some(pos)
        }
        for _ in 0..20 {
            let mut buf = [0u8; 4096];
            let n = tokio::time::timeout(Duration::from_secs(2), stream.read(&mut buf)).await??;
            if n == 0 {
                break;
            }
            pending.extend_from_slice(&buf[..n]);
            if pending.len() > 131072 {
                bail!("RESP request too large");
            }
            while let Some(n) = frame(&pending) {
                let bytes: Vec<u8> = pending.drain(..n).collect();
                let reserve = bytes
                    .windows(reserve_hash.len())
                    .any(|b| b == reserve_hash.as_bytes());
                let publish = !reserve && bytes.windows(7).any(|b| b == b"EVALSHA");
                let ping = bytes.windows(4).any(|b| b == b"PING");
                stream
                    .write_all(if reserve {
                        b"*2\r\n:1\r\n:0\r\n"
                    } else if publish {
                        b"-ERR injected publish failure\r\n"
                    } else if ping {
                        b"+PONG\r\n"
                    } else {
                        b"+OK\r\n"
                    })
                    .await?;
                if publish {
                    return Ok::<_, anyhow::Error>(());
                }
            }
        }
        bail!("publisher never reached RESP peer")
    }));
    let mut config = DragonflyConfig::from_env_values(
        Some("127.0.0.1"),
        Some(&address.port().to_string()),
        "widget-feed-failure-test",
    );
    config.connect_timeout = Duration::from_secs(1);
    config.response_timeout = Duration::from_millis(100);
    config.reconnect_retries = 0;
    let store = Dragonfly::connect(config, Hooks::default()).await?;
    let p = publisher(&store, "isolated-failure:", Arc::new(ManualClock::new(1)));
    let outcome = p.publish(message("1001", "test"), None).await;
    assert_eq!(
        outcome,
        PublishResult::Failed(FeedError("widget_feed_store_failed"))
    );
    // The host handles a result value and can continue its normal message path.
    tokio::time::timeout(Duration::from_secs(3), server).await???;
    Ok(())
}

#[tokio::test]
async fn widget_feed_outbox_is_bounded_ordered_flushable_and_owned() -> Result<()> {
    with_store(|store, prefix| async move {
        use dima_features::widget_feed::FeedOutbox;
        let clock = Arc::new(ManualClock::new(1));
        let p = publisher(&store, &prefix, clock.clone());
        let channel = format!("c{}", dima_core::SystemRandom.uuid_v4()?);
        let reader = store.subscriber();
        let mut sub = p.subscribe(&reader).await?;
        let (outbox, worker) = FeedOutbox::new(p.clone(), clock.clone());
        let mut receipts = Vec::new();
        for n in 0..64 {
            receipts.push(outbox.submit(message(&channel, &n.to_string()))?);
        }
        assert!(outbox.submit(message(&channel, "overflow")).is_err());
        assert_eq!(outbox.dropped(), 1);
        drop(worker);
        for r in receipts {
            assert_eq!(
                r.wait().await,
                PublishResult::Failed(FeedError("widget_feed_stopped"))
            );
        }
        let (outbox, worker) = FeedOutbox::new(p, clock);
        let stop = dima_core::Shutdown::new();
        let owned =
            tokio_util::task::AbortOnDropHandle::new(tokio::spawn(worker.run(stop.clone())));
        let first = outbox.submit(message(&channel, "first"))?;
        let second = outbox.submit(message(&channel, "second"))?;
        assert_eq!(first.wait().await, PublishResult::Sent);
        assert_eq!(second.wait().await, PublishResult::Sent);
        assert!(outbox.flush().await);
        assert_eq!(
            next_for(&mut sub, &channel).await?["data"]["messageId"],
            "first"
        );
        assert_eq!(
            next_for(&mut sub, &channel).await?["data"]["messageId"],
            "second"
        );
        stop.trigger();
        tokio::time::timeout(Duration::from_secs(2), owned).await??;
        assert!(outbox.submit(message(&channel, "closed")).is_err());
        reader.shutdown().await;
        Ok(())
    })
    .await
}

struct RecordedBadges {
    value: BadgeLookup,
    fail: bool,
}
impl Badges for RecordedBadges {
    fn lookup<'a>(&'a self, _: &'a str) -> BoxFuture<'a, Result<BadgeLookup, FeedError>> {
        Box::pin(async move {
            if self.fail {
                Err(FeedError("injected"))
            } else {
                Ok(self.value.clone())
            }
        })
    }
}
#[tokio::test]
async fn widget_feed_publisher_recorded_success_and_failed_tail() -> Result<()> {
    with_store(|store, prefix| async move {
        let cases: Vec<Value> = include_str!("widget_feed_reference.jsonl")
            .lines()
            .map(serde_json::from_str)
            .collect::<std::result::Result<_, _>>()?;
        let now = cases[0]["now"].as_i64().context("now")?;
        for case in cases.iter().filter(|c| c["op"] == "publisher") {
            let channel = format!("c{}", dima_core::SystemRandom.uuid_v4()?);
            let badges = Arc::new(RecordedBadges {
                value: serde_json::from_value(case["input"]["badges"].clone())?,
                fail: case["input"]["fail"].as_bool().context("fail")?,
            });
            let clock = Arc::new(ManualClock::new(now));
            let p = FeedPublisher::new(
                store.clone(),
                clock.clone(),
                Arc::new(SeededRandom::new(1)),
                badges,
                FeedConfig {
                    key_prefix: prefix.clone(),
                    ..FeedConfig::default()
                },
            );
            let reader = store.subscriber();
            let mut sub = p.subscribe(&reader).await?;
            assert_eq!(
                p.chat(&channel, "chat", &case["input"]["event"]).await,
                PublishResult::NoDemand
            );
            FeedSubscriptions::new(store.clone(), clock, prefix.clone(), Duration::from_secs(2))
                .register(
                    &channel,
                    &WidgetSubscription {
                        widget: "widget".into(),
                        session: "session".into(),
                        uses: vec!["chat".into()],
                    },
                )
                .await?;
            let delete = json!({"message_id":"message"});
            let clear = json!({});
            let (a, b, c) = tokio::join!(
                p.chat(&channel, "chat", &case["input"]["event"]),
                p.chat(&channel, "chat.delete", &delete),
                p.chat(&channel, "chat.clear", &clear)
            );
            assert_eq!(b, PublishResult::Sent);
            assert_eq!(c, PublishResult::Sent);
            assert_eq!(
                matches!(a, PublishResult::Failed(_)),
                case["input"]["fail"] == true
            );
            for expected in case["result"].as_array().context("expected messages")? {
                let mut expected = expected["message"].clone();
                expected["channel"] = channel.clone().into();
                let actual = next_for(&mut sub, &channel).await?;
                assert_eq!(
                    dima_text::to_js_json(&actual),
                    dima_text::to_js_json(&expected)
                );
            }
            reader.shutdown().await;
        }
        Ok(())
    })
    .await
}

#[tokio::test]
async fn widget_feed_dead_predecessor_expires_and_stale_owner_cannot_publish() -> Result<()> {
    with_store(|store, prefix| async move {
        static RESERVE: dima_store::dragonfly::Script = dima_store::dragonfly::Script::new(
            "TEST_RESERVE",
            include_str!("../src/widget_feed/lua/reserve.lua"),
        );
        static COMMIT: dima_store::dragonfly::Script = dima_store::dragonfly::Script::new(
            "TEST_COMMIT",
            include_str!("../src/widget_feed/lua/publish.lua"),
        );
        let p = publisher(&store, &prefix, Arc::new(ManualClock::new(1)));
        let channel = format!("c{}", dima_core::SystemRandom.uuid_v4()?);
        let order = p.key("widget-feed:order", &channel);
        let demand = p.key("widget-feed:demand", &channel);
        let reserved: Vec<i64> = RESERVE
            .run(&store, &[&order, &demand], &["dead-owner", "30", "0"])
            .await?;
        assert_eq!(reserved, [1, 0]);
        assert_eq!(
            p.publish(message(&channel, "successor"), None).await,
            PublishResult::Sent
        );
        let keys = [
            p.key("widget-feed:rate", &channel),
            p.key("widget-signal:rate", &channel),
            p.key("widget-signal:skipped", &channel),
            p.key("widget-signal:seen", "unused"),
            demand,
            order,
        ];
        let args = ["{}", "rust:widget-feed", "0", "0", "0", "0", "dead-owner"];
        let result: i64 = COMMIT.run(&store, &keys, &args).await?;
        assert_eq!(
            result, 5,
            "stale owner is fenced before quota or publication"
        );
        assert_eq!(store.get_text(&keys[0]).await?.as_deref(), Some("1"));
        let full_channel = format!("c{}", dima_core::SystemRandom.uuid_v4()?);
        let order = p.key("widget-feed:order", &full_channel);
        let demand = p.key("widget-feed:demand", &full_channel);
        for i in 0..64 {
            let r: Vec<i64> = RESERVE
                .run(
                    &store,
                    &[&order, &demand],
                    &[format!("owner-{i}"), "2000".into(), "0".into()],
                )
                .await?;
            assert_eq!(r[0], 1);
        }
        let r: Vec<i64> = RESERVE
            .run(&store, &[&order, &demand], &["overflow", "2000", "0"])
            .await?;
        assert_eq!(r[0], 3);
        Ok(())
    })
    .await
}

#[tokio::test]
async fn widget_feed_all_message_bound_and_signal_ttl_repair() -> Result<()> {
    with_store(|store, prefix| async move {
        let p = publisher(&store, &prefix, Arc::new(ManualClock::new(1)));
        let channel = format!("c{}", dima_core::SystemRandom.uuid_v4()?);
        store
            .set(
                &p.key("widget-feed:rate", &channel),
                b"100",
                dima_store::dragonfly::SetOptions::ex(1),
            )
            .await?;
        assert_eq!(
            p.publish(message(&channel, "over-quota"), None).await,
            PublishResult::Limited
        );
        assert_eq!(p.skipped_signals(&channel).await, 0);
        let key = p.key("widget-signal:rate", &channel);
        store
            .set(&key, b"0", dima_store::dragonfly::SetOptions::default())
            .await?;
        assert!(p.admit_signal(&channel).await?);
        assert!(matches!(
            store.ttl(&key).await?,
            dima_store::dragonfly::Ttl::Seconds(0..=10)
        ));
        Ok(())
    })
    .await
}
#[tokio::test]
async fn widget_feed_outbox_receipt_has_deadline_even_without_worker() -> Result<()> {
    with_store(|store, prefix| async move {
        let clock = Arc::new(ManualClock::new(1));
        let p = publisher(&store, &prefix, clock.clone());
        let (outbox, worker) = dima_features::widget_feed::FeedOutbox::new(p, clock);
        let receipt = outbox.submit(message("1001", "never-started"))?;
        let result = tokio::time::timeout(Duration::from_secs(3), receipt.wait()).await?;
        assert_eq!(
            result,
            PublishResult::Failed(FeedError("widget_feed_deadline"))
        );
        drop(worker);
        Ok(())
    })
    .await
}
