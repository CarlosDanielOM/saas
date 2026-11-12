//! The subscriber against a scripted server, for what a real Dragonfly will not do on demand:
//! leave a confirmation unanswered, stay silent, refuse a subscription. Needs no store, except
//! the last test, which checks the keep-alive against the local Dragonfly (any database; this
//! binary never runs beside `dragonfly_live`'s deliberately slow script).
//!
//! The mock answers the command connection by itself (`PING` → `PONG`, anything else `OK`) and
//! hands every subscriber connection (the one that starts with `CLIENT ID`) to the test, which
//! reads its commands and writes the replies it chooses.

mod dragonfly_support;

use anyhow::{Context, Result, bail, ensure};
use dima_store::dragonfly::{
    Dragonfly, DragonflyConfig, DragonflyError, Event, Gap, Hooks, Overflow, Subscriber,
    Subscription, Topic,
};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpListener;
use tokio::net::tcp::{OwnedReadHalf, OwnedWriteHalf};
use tokio::sync::mpsc;
use tokio::time::Instant;

/// One subscriber connection as the mock sees it.
struct Peer {
    commands: mpsc::UnboundedReceiver<Vec<String>>,
    writer: OwnedWriteHalf,
}

impl Peer {
    /// The next command the subscriber sent.
    async fn command(&mut self) -> Result<Vec<String>> {
        tokio::time::timeout(Duration::from_secs(3), self.commands.recv())
            .await
            .context("no command from the subscriber")?
            .context("the subscriber closed the connection")
    }

    /// Waits until the subscriber closes this connection.
    async fn closed(&mut self, within: Duration) -> Result<()> {
        let deadline = Instant::now() + within;
        loop {
            match tokio::time::timeout_at(deadline, self.commands.recv()).await {
                Err(_) => bail!("the connection is still open"),
                Ok(None) => return Ok(()),
                Ok(Some(_)) => {}
            }
        }
    }

    /// Nothing arrives for `quiet`.
    async fn silent(&mut self, quiet: Duration) -> Result<()> {
        match tokio::time::timeout(quiet, self.commands.recv()).await {
            Err(_) => Ok(()),
            Ok(other) => bail!("unexpected {other:?}"),
        }
    }

    async fn send(&mut self, bytes: &[u8]) -> Result<()> {
        self.writer.write_all(bytes).await?;
        Ok(())
    }
}

fn array(parts: &[&[u8]]) -> Vec<u8> {
    let mut out = format!("*{}\r\n", parts.len()).into_bytes();
    for part in parts {
        out.extend_from_slice(format!("${}\r\n", part.len()).as_bytes());
        out.extend_from_slice(part);
        out.extend_from_slice(b"\r\n");
    }
    out
}

fn confirmation(kind: &str, name: &str, count: i64) -> Vec<u8> {
    let mut out = format!(
        "*3\r\n${}\r\n{kind}\r\n${}\r\n{name}\r\n",
        kind.len(),
        name.len()
    )
    .into_bytes();
    out.extend_from_slice(format!(":{count}\r\n").as_bytes());
    out
}

fn message(channel: &str, payload: &str) -> Vec<u8> {
    array(&[b"message", channel.as_bytes(), payload.as_bytes()])
}

/// Reads one command (an array of bulk strings) from the client.
async fn read_command(reader: &mut BufReader<OwnedReadHalf>) -> Result<Option<Vec<String>>> {
    let mut line = String::new();
    if reader.read_line(&mut line).await? == 0 {
        return Ok(None);
    }
    let count: usize = line
        .trim_end()
        .strip_prefix('*')
        .context("not an array")?
        .parse()?;
    let mut parts = Vec::with_capacity(count);
    for _ in 0..count {
        line.clear();
        reader.read_line(&mut line).await?;
        let length: usize = line
            .trim_end()
            .strip_prefix('$')
            .context("not a bulk string")?
            .parse()?;
        let mut bytes = vec![0; length + 2];
        reader.read_exact(&mut bytes).await?;
        bytes.truncate(length);
        parts.push(String::from_utf8(bytes)?);
    }
    Ok(Some(parts))
}

struct Mock {
    port: u16,
    peers: mpsc::UnboundedReceiver<Peer>,
}

impl Mock {
    async fn start() -> Result<Self> {
        let listener = TcpListener::bind("127.0.0.1:0").await?;
        let port = listener.local_addr()?.port();
        let (peers_tx, peers) = mpsc::unbounded_channel();
        tokio::spawn(async move {
            let mut next_id = 100_i64;
            while let Ok((socket, _)) = listener.accept().await {
                next_id += 1;
                let id = next_id;
                let peers_tx = peers_tx.clone();
                tokio::spawn(async move {
                    let (reader, mut writer) = socket.into_split();
                    let mut reader = BufReader::new(reader);
                    let Ok(Some(first)) = read_command(&mut reader).await else {
                        return;
                    };
                    if first
                        .iter()
                        .map(|p| p.to_ascii_uppercase())
                        .collect::<Vec<_>>()
                        == ["CLIENT", "ID"]
                    {
                        if writer
                            .write_all(format!(":{id}\r\n").as_bytes())
                            .await
                            .is_err()
                        {
                            return;
                        }
                        let (commands_tx, commands) = mpsc::unbounded_channel();
                        let _ = peers_tx.send(Peer { commands, writer });
                        while let Ok(Some(command)) = read_command(&mut reader).await {
                            if commands_tx.send(command).is_err() {
                                break;
                            }
                        }
                        // Dropping the sender tells the test the connection closed.
                    } else {
                        let mut command = Some(first);
                        while let Some(current) = command {
                            let reply: &[u8] = if current
                                .first()
                                .is_some_and(|name| name.eq_ignore_ascii_case("PING"))
                            {
                                b"+PONG\r\n"
                            } else {
                                b"+OK\r\n"
                            };
                            if writer.write_all(reply).await.is_err() {
                                return;
                            }
                            command = read_command(&mut reader).await.ok().flatten();
                        }
                    }
                });
            }
        });
        Ok(Self { port, peers })
    }

    fn config(&self, response_timeout: Duration) -> DragonflyConfig {
        let mut config = DragonflyConfig::from_env_values(
            Some("127.0.0.1"),
            Some(&self.port.to_string()),
            "mock",
        );
        config.response_timeout = response_timeout;
        config
    }

    /// The next subscriber connection.
    async fn peer(&mut self) -> Result<Peer> {
        tokio::time::timeout(Duration::from_secs(5), self.peers.recv())
            .await
            .context("the subscriber did not connect")?
            .context("mock stopped")
    }

    /// No new subscriber connection within `quiet`.
    async fn no_peer(&mut self, quiet: Duration) -> Result<()> {
        match tokio::time::timeout(quiet, self.peers.recv()).await {
            Err(_) => Ok(()),
            Ok(_) => bail!("the subscriber reconnected"),
        }
    }
}

async fn setup(config: DragonflyConfig) -> Result<Subscriber> {
    let dragonfly = Dragonfly::connect(config, Hooks::default()).await?;
    Ok(dragonfly.subscriber())
}

/// Subscribes while the peer answers the SUBSCRIBE with a confirmation.
async fn subscribed(subscriber: &Subscriber, peer: &mut Peer, name: &str) -> Result<Subscription> {
    let topic = Topic::Channel(name.to_owned());
    let answer = async {
        ensure!(peer.command().await? == ["SUBSCRIBE", name]);
        peer.send(&confirmation("subscribe", name, 1)).await
    };
    let (subscription, answered) = tokio::join!(subscriber.subscribe(topic, Overflow::Gap), answer);
    answered?;
    let subscription = subscription?;
    ensure!(subscription.confirmed());
    Ok(subscription)
}

async fn next(subscription: &mut Subscription) -> Result<Event> {
    tokio::time::timeout(Duration::from_secs(2), subscription.recv())
        .await
        .context("no event")?
        .context("the stream ended")
}

const RESUBSCRIBED: Event = Event::Gap(Gap {
    overflowed: 0,
    resubscribed: true,
});

#[tokio::test]
async fn an_unanswered_subscribe_times_out_reconnects_and_reports_a_gap() -> Result<()> {
    let mut mock = Mock::start().await?;
    let subscriber = setup(mock.config(Duration::from_millis(300))).await?;
    let mut stalled = mock.peer().await?;

    // The server never confirms: subscribe returns at the deadline, unconfirmed.
    let started = Instant::now();
    let (subscription, command) = tokio::join!(
        tokio::time::timeout(
            Duration::from_secs(3),
            subscriber.subscribe(Topic::Channel("a".into()), Overflow::Gap)
        ),
        stalled.command()
    );
    let mut subscription = subscription.context("subscribe waited past its deadline")??;
    ensure!(command? == ["SUBSCRIBE", "a"]);
    ensure!(!subscription.confirmed());
    ensure!(
        started.elapsed() < Duration::from_secs(2),
        "{:?}",
        started.elapsed()
    );

    // The silent connection is discarded; the new one subscribes again.
    stalled.closed(Duration::from_secs(2)).await?;
    let mut fresh = mock.peer().await?;
    ensure!(fresh.command().await? == ["SUBSCRIBE", "a"]);
    fresh.send(&confirmation("subscribe", "a", 1)).await?;
    fresh.send(&message("a", "hello")).await?;
    // Whatever was published meanwhile is reported, then delivery goes on.
    ensure!(next(&mut subscription).await? == RESUBSCRIBED);
    match next(&mut subscription).await? {
        Event::Message(message) => ensure!(message.payload == b"hello"),
        other => bail!("{other:?}"),
    }
    Ok(())
}

#[tokio::test]
async fn delivery_continues_while_a_confirmation_is_outstanding() -> Result<()> {
    let mut mock = Mock::start().await?;
    let subscriber = setup(mock.config(Duration::from_secs(10))).await?;
    let mut peer = mock.peer().await?;
    let mut first = subscribed(&subscriber, &mut peer, "a").await?;

    let second = subscriber.subscribe(Topic::Channel("b".into()), Overflow::DropNewest);
    let script = async {
        ensure!(peer.command().await? == ["SUBSCRIBE", "b"]);
        // "b" is not confirmed yet; a message for "a" must still arrive.
        peer.send(&message("a", "while-waiting")).await?;
        let got = next(&mut first).await?;
        peer.send(&confirmation("subscribe", "b", 2)).await?;
        Ok::<_, anyhow::Error>(got)
    };
    let (second, got) = tokio::join!(second, script);
    match got? {
        Event::Message(message) => ensure!(message.payload == b"while-waiting"),
        other => bail!("{other:?}"),
    }
    ensure!(second?.confirmed());
    Ok(())
}

#[tokio::test]
async fn shutdown_is_prompt_while_a_confirmation_is_outstanding() -> Result<()> {
    let mut mock = Mock::start().await?;
    let subscriber = setup(mock.config(Duration::from_secs(30))).await?;
    let mut peer = mock.peer().await?;
    // The caller gives up waiting; the subscribe stays outstanding in the subscriber.
    let waited = tokio::time::timeout(
        Duration::from_millis(300),
        subscriber.subscribe(Topic::Channel("a".into()), Overflow::Gap),
    )
    .await;
    ensure!(
        waited.is_err(),
        "the server never confirmed, yet subscribe returned"
    );
    ensure!(peer.command().await? == ["SUBSCRIBE", "a"]);
    tokio::time::timeout(Duration::from_secs(1), subscriber.shutdown())
        .await
        .context("shutdown waited for the confirmation")?;
    peer.closed(Duration::from_secs(1)).await
}

#[tokio::test]
async fn an_unanswered_unsubscribe_times_out_and_is_not_resubscribed() -> Result<()> {
    let mut mock = Mock::start().await?;
    let subscriber = setup(mock.config(Duration::from_millis(300))).await?;
    let mut peer = mock.peer().await?;
    let subscription = subscribed(&subscriber, &mut peer, "a").await?;
    drop(subscription);
    ensure!(peer.command().await? == ["UNSUBSCRIBE", "a"]);
    peer.closed(Duration::from_secs(2)).await?;
    // The new connection has nothing to subscribe to.
    let mut fresh = mock.peer().await?;
    fresh.silent(Duration::from_millis(500)).await
}

#[tokio::test]
async fn a_silent_connection_is_pinged_and_replaced() -> Result<()> {
    let mut mock = Mock::start().await?;
    let mut config = mock.config(Duration::from_millis(300));
    config.subscriber_ping_interval = Duration::from_millis(200);
    let subscriber = setup(config).await?;
    let mut peer = mock.peer().await?;
    let mut subscription = subscribed(&subscriber, &mut peer, "a").await?;

    // Silence: a PING follows; it goes unanswered, so the connection is replaced.
    ensure!(peer.command().await? == ["PING"]);
    peer.closed(Duration::from_secs(2)).await?;
    let mut fresh = mock.peer().await?;
    ensure!(fresh.command().await? == ["SUBSCRIBE", "a"]);
    fresh.send(&confirmation("subscribe", "a", 1)).await?;
    ensure!(next(&mut subscription).await? == RESUBSCRIBED);

    // Answered pings keep the connection.
    for _ in 0..3 {
        ensure!(fresh.command().await? == ["PING"]);
        fresh.send(&array(&[b"pong", b""])).await?;
    }
    mock.no_peer(Duration::from_millis(100)).await?;
    ensure!(subscriber.connections() == 2);
    Ok(())
}

#[tokio::test]
async fn a_refused_subscribe_replaces_the_connection() -> Result<()> {
    let mut mock = Mock::start().await?;
    let subscriber = setup(mock.config(Duration::from_secs(10))).await?;
    let mut peer = mock.peer().await?;
    let answer = async {
        ensure!(peer.command().await? == ["SUBSCRIBE", "a"]);
        peer.send(b"-ERR refused\r\n").await
    };
    let (subscription, answered) = tokio::join!(
        subscriber.subscribe(Topic::Channel("a".into()), Overflow::Gap),
        answer
    );
    answered?;
    let subscription = subscription?;
    ensure!(!subscription.confirmed());
    peer.closed(Duration::from_secs(1)).await?;
    let mut fresh = mock.peer().await?;
    ensure!(fresh.command().await? == ["SUBSCRIBE", "a"]);
    Ok(())
}

#[tokio::test]
async fn subscriptions_beyond_the_cap_are_refused() -> Result<()> {
    let mut mock = Mock::start().await?;
    let mut config = mock.config(Duration::from_secs(10));
    config.max_subscriptions = 2;
    let subscriber = setup(config).await?;
    let mut peer = mock.peer().await?;
    let a = subscribed(&subscriber, &mut peer, "a").await?;
    let b = subscribed(&subscriber, &mut peer, "b").await?;
    let refused = subscriber
        .subscribe(Topic::Channel("c".into()), Overflow::Gap)
        .await;
    ensure!(
        matches!(
            refused,
            Err(DragonflyError::TooManySubscriptions { limit: 2 })
        ),
        "{refused:?}"
    );
    ensure!(
        refused
            .err()
            .is_some_and(|e| e.to_string().contains("2 subscriptions"))
    );
    // Replacing a held topic is not a new one: allowed, live at once, nothing sent.
    let replaced = subscriber
        .subscribe(Topic::Channel("a".into()), Overflow::DropNewest)
        .await?;
    ensure!(replaced.confirmed());
    drop(a);
    // Dropping "b" frees a place.
    drop(b);
    ensure!(peer.command().await? == ["UNSUBSCRIBE", "b"]);
    peer.send(&confirmation("unsubscribe", "b", 1)).await?;
    let c = subscribed(&subscriber, &mut peer, "c").await?;
    ensure!(c.confirmed());
    drop(replaced);
    Ok(())
}

#[tokio::test]
async fn an_oversized_message_replaces_the_connection_before_it_is_buffered() -> Result<()> {
    let mut mock = Mock::start().await?;
    let mut config = mock.config(Duration::from_secs(10));
    config.subscription_max_message_bytes = 1024;
    let subscriber = setup(config).await?;
    let mut peer = mock.peer().await?;
    let mut subscription = subscribed(&subscriber, &mut peer, "a").await?;
    // At the limit: delivered.
    let largest = "x".repeat(1024);
    peer.send(&message("a", &largest)).await?;
    match next(&mut subscription).await? {
        Event::Message(message) => ensure!(message.payload.len() == 1024),
        other => bail!("{other:?}"),
    }
    // Over it: only the length header is sent, the connection goes at once.
    peer.send(b"*3\r\n$7\r\nmessage\r\n$1\r\na\r\n$1025\r\n")
        .await?;
    peer.closed(Duration::from_secs(1)).await?;
    let mut fresh = mock.peer().await?;
    ensure!(fresh.command().await? == ["SUBSCRIBE", "a"]);
    fresh.send(&confirmation("subscribe", "a", 1)).await?;
    ensure!(next(&mut subscription).await? == RESUBSCRIBED);
    Ok(())
}

/// Dragonfly's answer to `PING` in subscribe mode is understood: a subscriber pinged many times
/// keeps its one connection and keeps receiving.
#[tokio::test]
async fn keep_alive_pings_are_answered_by_dragonfly() -> Result<()> {
    let Some(mut config) = dragonfly_support::config(11) else {
        return Ok(());
    };
    config.subscriber_ping_interval = Duration::from_millis(50);
    // An unanswered ping would replace the connection well within the wait below.
    config.response_timeout = Duration::from_secs(1);
    let df = Dragonfly::connect(config, Hooks::default()).await?;
    let channel = dragonfly_support::prefix("pubsub-ping");
    let subscriber = df.subscriber();
    let mut subscription = subscriber
        .subscribe(Topic::Channel(channel.clone()), Overflow::Gap)
        .await?;
    ensure!(subscription.confirmed());
    tokio::time::sleep(Duration::from_millis(1500)).await;
    ensure!(
        subscriber.connections() == 1,
        "reconnected {} times",
        subscriber.connections() - 1
    );
    df.publish(&channel, b"still here").await?;
    match next(&mut subscription).await? {
        Event::Message(message) => ensure!(message.payload == b"still here"),
        other => bail!("{other:?}"),
    }
    Ok(())
}
