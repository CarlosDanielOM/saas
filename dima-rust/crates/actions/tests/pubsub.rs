//! The pub/sub manager against the local Dragonfly: the envelope, the Rust channel names, one
//! handler per channel, unsubscribe, a payload that is not JSON. Channels are server-wide, so
//! each test uses names with a random part.

use anyhow::{Context, Result, anyhow, bail, ensure};
use dima_actions::pubsub::{ClipRequest, PubSub, channel_name};
use dima_core::ManualClock;
use dima_store::dragonfly::{Dragonfly, DragonflyConfig, Event, Overflow, Topic};
use serde_json::{Value, json};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::mpsc;

async fn dragonfly() -> Result<Option<Dragonfly>> {
    let Ok(address) = std::env::var("DIMA_TEST_DRAGONFLY") else {
        if std::env::var("DIMA_TEST_REQUIRE_STORES").is_ok_and(|v| v == "1") {
            bail!("DIMA_TEST_DRAGONFLY is not set (DIMA_TEST_REQUIRE_STORES=1)");
        }
        eprintln!("skipped: DIMA_TEST_DRAGONFLY is not set");
        return Ok(None);
    };
    let (host, port) = address
        .rsplit_once(':')
        .ok_or_else(|| anyhow!("DIMA_TEST_DRAGONFLY is host:port"))?;
    let config = DragonflyConfig::from_env_values(
        Some(host),
        Some(&format!("{port}/11")),
        "dima-actions-tests",
    );
    Ok(Some(Dragonfly::connect(config, Default::default()).await?))
}

fn unique(name: &str) -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or_default();
    format!("dima-test-actions:{name}:{nanos:x}")
}

async fn next<T>(receiver: &mut mpsc::UnboundedReceiver<T>) -> Result<T> {
    tokio::time::timeout(Duration::from_secs(10), receiver.recv())
        .await
        .context("nothing received within 10 s")?
        .context("closed")
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn messages_travel_on_the_rust_channel_with_the_envelope() -> Result<()> {
    let Some(client) = dragonfly().await? else {
        return Ok(());
    };
    let pubsub = PubSub::new(
        client.clone(),
        Arc::new(ManualClock::new(1_794_475_800_123)),
        None,
    );
    let channel = unique("envelope");

    // A raw listener on the Rust name, and one on the reference's name that must stay silent.
    let raw = client.subscriber();
    let mut rust_side = raw
        .subscribe(Topic::Channel(channel_name(&channel)), Overflow::Gap)
        .await?;
    let mut typescript_side = raw
        .subscribe(Topic::Channel(channel.clone()), Overflow::Gap)
        .await?;

    let (sender, mut received) = mpsc::unbounded_channel();
    pubsub
        .subscribe::<Value, _>(&channel, Overflow::Gap, move |event| {
            let _ = sender.send(event);
        })
        .await?;
    ensure!(
        pubsub
            .publish(&channel, &json!({"channelID": "1001", "session": "s1"}))
            .await?
            >= 2
    );
    match next(&mut received).await? {
        Event::Message(value) => ensure!(
            value
                == json!({"channelID": "1001", "session": "s1", "timestamp": 1_794_475_800_123_i64}),
            "{value}"
        ),
        Event::Gap(gap) => bail!("unexpected gap {gap:?}"),
    }
    let bytes = match tokio::time::timeout(Duration::from_secs(10), rust_side.recv()).await? {
        Some(Event::Message(message)) => message.payload,
        other => bail!("{other:?}"),
    };
    ensure!(
        bytes == br#"{"channelID":"1001","session":"s1","timestamp":1794475800123}"#,
        "{}",
        String::from_utf8_lossy(&bytes)
    );
    ensure!(
        tokio::time::timeout(Duration::from_millis(300), typescript_side.recv())
            .await
            .is_err(),
        "nothing on the TypeScript name"
    );

    // A payload that is not JSON is skipped; the next message still arrives.
    client.publish(&channel_name(&channel), b"not json").await?;
    pubsub.publish(&channel, &json!({"n": 2})).await?;
    match next(&mut received).await? {
        Event::Message(value) => ensure!(value["n"] == 2, "{value}"),
        Event::Gap(gap) => bail!("unexpected gap {gap:?}"),
    }

    // One handler per channel: a second subscription replaces the first.
    let (second_sender, mut second) = mpsc::unbounded_channel();
    pubsub
        .subscribe::<Value, _>(&channel, Overflow::Gap, move |event| {
            let _ = second_sender.send(event);
        })
        .await?;
    pubsub.publish(&channel, &json!({"n": 3})).await?;
    ensure!(matches!(next(&mut second).await?, Event::Message(value) if value["n"] == 3));
    ensure!(
        tokio::time::timeout(Duration::from_millis(300), received.recv())
            .await
            .map_or(true, |event| event.is_none()),
        "the replaced handler received nothing more"
    );

    // Unsubscribed: nothing more arrives.
    pubsub.unsubscribe(&channel);
    ensure!(pubsub.channels().is_empty());
    pubsub.publish(&channel, &json!({"n": 4})).await?;
    ensure!(
        tokio::time::timeout(Duration::from_millis(300), second.recv())
            .await
            .map_or(true, |event| event.is_none()),
        "unsubscribed"
    );
    pubsub.shutdown().await;
    raw.shutdown().await;
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn clip_requests_round_trip() -> Result<()> {
    let Some(client) = dragonfly().await? else {
        return Ok(());
    };
    let pubsub = PubSub::new(client, Arc::new(ManualClock::new(5_000)), None);
    let channel = unique("clips");
    let (sender, mut received) = mpsc::unbounded_channel();
    pubsub
        .subscribe_to_clip_requests(&channel, move |event| {
            let _ = sender.send(event);
        })
        .await?;
    let clip = ClipRequest {
        clip_id: "AwkwardHelplessSalamanderSwiftRage".into(),
        streamer_login: "first".into(),
        duration: 29.5,
        title: "¡Qué jugada! 👏🏽".into(),
        timestamp: 1.0,
        ..ClipRequest::default()
    };
    pubsub.publish_clip_request(&channel, &clip).await?;
    match next(&mut received).await? {
        Event::Message(got) => {
            ensure!(got.title == clip.title && got.duration == 29.5);
            ensure!(
                got.timestamp == 5_000.0,
                "the envelope's time replaces the clip's"
            );
        }
        Event::Gap(gap) => bail!("unexpected gap {gap:?}"),
    }
    pubsub.shutdown().await;
    Ok(())
}
