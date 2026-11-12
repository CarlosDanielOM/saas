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
use std::sync::{Arc, Mutex};
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

/// One `AUTH` command the mock received, and whether it accepted it.
type Auth = (Vec<String>, bool);

/// A lock that a panicking test thread may have poisoned still holds valid data.
fn locked<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

struct Mock {
    port: u16,
    peers: mpsc::UnboundedReceiver<Peer>,
    /// The password every connection must send with `AUTH` first (`None`: no authentication).
    password: Arc<Mutex<Option<String>>>,
    /// Every `AUTH` command received, in order, with whether it was accepted.
    auths: Arc<Mutex<Vec<Auth>>>,
}

impl Mock {
    async fn start() -> Result<Self> {
        Self::start_with_password(None).await
    }

    /// A mock that refuses every command before a successful `AUTH <password>` (or
    /// `AUTH <user> <password>`), as a server with `requirepass` does.
    async fn start_with_password(password: Option<&str>) -> Result<Self> {
        let listener = TcpListener::bind("127.0.0.1:0").await?;
        let port = listener.local_addr()?.port();
        let (peers_tx, peers) = mpsc::unbounded_channel();
        let password = Arc::new(Mutex::new(password.map(str::to_owned)));
        let auths = Arc::new(Mutex::new(Vec::new()));
        let (required, log) = (password.clone(), auths.clone());
        tokio::spawn(async move {
            let mut next_id = 100_i64;
            while let Ok((socket, _)) = listener.accept().await {
                next_id += 1;
                let id = next_id;
                let peers_tx = peers_tx.clone();
                let (required, log) = (required.clone(), log.clone());
                tokio::spawn(async move {
                    let (reader, mut writer) = socket.into_split();
                    let mut reader = BufReader::new(reader);
                    let Ok(Some(mut first)) = read_command(&mut reader).await else {
                        return;
                    };
                    // Authentication first, when the mock requires it.
                    loop {
                        let expected = locked(&required).clone();
                        let Some(expected) = expected else { break };
                        let is_auth = first
                            .first()
                            .is_some_and(|name| name.eq_ignore_ascii_case("AUTH"));
                        let accepted = is_auth && first.last() == Some(&expected);
                        if is_auth {
                            locked(&log).push((first.clone(), accepted));
                        }
                        let reply: &[u8] = if accepted {
                            b"+OK\r\n"
                        } else if is_auth {
                            b"-WRONGPASS invalid username-password pair or user is disabled.\r\n"
                        } else {
                            b"-NOAUTH Authentication required.\r\n"
                        };
                        if writer.write_all(reply).await.is_err() {
                            return;
                        }
                        let Ok(Some(next)) = read_command(&mut reader).await else {
                            return;
                        };
                        first = next;
                        if accepted {
                            break;
                        }
                    }
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
                            let name = current
                                .iter()
                                .map(|p| p.to_ascii_uppercase())
                                .collect::<Vec<_>>();
                            let reply: Vec<u8> = match name
                                .iter()
                                .map(String::as_str)
                                .collect::<Vec<_>>()
                                .as_slice()
                            {
                                ["PING", ..] => b"+PONG\r\n".to_vec(),
                                ["CLIENT", "ID"] => format!(":{id}\r\n").into_bytes(),
                                ["BLPOP", ..] => b"*-1\r\n".to_vec(),
                                _ => b"+OK\r\n".to_vec(),
                            };
                            if writer.write_all(&reply).await.is_err() {
                                return;
                            }
                            command = read_command(&mut reader).await.ok().flatten();
                        }
                    }
                });
            }
        });
        Ok(Self {
            port,
            peers,
            password,
            auths,
        })
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
    // Dropping "b" frees a place once the server confirms the unsubscribe: until then "b"
    // still holds state on the server.
    drop(b);
    ensure!(peer.command().await? == ["UNSUBSCRIBE", "b"]);
    let early = subscriber
        .subscribe(Topic::Channel("c".into()), Overflow::Gap)
        .await;
    ensure!(
        matches!(early, Err(DragonflyError::TooManySubscriptions { .. })),
        "{early:?}"
    );
    peer.send(&confirmation("unsubscribe", "b", 1)).await?;
    tokio::time::sleep(Duration::from_millis(50)).await;
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

/// Counts the connection errors reported, by code.
#[derive(Default)]
struct CountingErrors {
    messages: Mutex<Vec<String>>,
}

impl dima_store::dragonfly::ErrorHook for CountingErrors {
    fn connection_error(&self, error: &dima_store::dragonfly::hooks::ConnectionError<'_>) {
        locked(&self.messages).push(error.error.to_string());
    }
}

fn with_credentials(mock: &Mock, userinfo: &str) -> DragonflyConfig {
    let mut config = DragonflyConfig::from_env_values(
        Some(&format!("{userinfo}@127.0.0.1")),
        Some(&mock.port.to_string()),
        "mock",
    );
    config.response_timeout = Duration::from_secs(5);
    config
}

#[tokio::test]
async fn credentials_in_the_address_authenticate_every_connection() -> Result<()> {
    let mut mock = Mock::start_with_password(Some("s3cret")).await?;
    let config = with_credentials(&mock, "dima:s3cret");
    let shown = format!("{config:?}");
    ensure!(!shown.contains("s3cret"), "{shown}");
    ensure!(shown.contains("127.0.0.1"), "{shown}");
    let df = Dragonfly::connect(config, Hooks::default()).await?;
    let pong: String = df.query(&redis::cmd("PING")).await?;
    ensure!(pong == "PONG");
    ensure!(!format!("{df:?}").contains("s3cret"));

    // The blocking connection authenticates too.
    let mut blocking = df.blocking();
    ensure!(
        blocking
            .blpop(&["k"], Duration::from_secs(1))
            .await?
            .is_none()
    );

    // So does the subscriber: AUTH, then CLIENT ID, then its subscriptions; no SELECT.
    let subscriber = df.subscriber();
    let mut peer = mock.peer().await?;
    let _subscription = subscribed(&subscriber, &mut peer, "a").await?;
    let auths = locked(&mock.auths).clone();
    ensure!(auths.len() >= 3, "{auths:?}");
    ensure!(
        auths
            .iter()
            .all(|(command, accepted)| *accepted && command == &["AUTH", "dima", "s3cret"]),
        "{auths:?}"
    );

    // A password alone (`:password@host`) is sent as `AUTH password`.
    let mut solo = Mock::start_with_password(Some("only")).await?;
    let df = Dragonfly::connect(with_credentials(&solo, ":only"), Hooks::default()).await?;
    let subscriber = df.subscriber();
    let mut peer = solo.peer().await?;
    let _subscription = subscribed(&subscriber, &mut peer, "b").await?;
    let auths = locked(&solo.auths).clone();
    ensure!(
        auths
            .iter()
            .all(|(command, accepted)| *accepted && command == &["AUTH", "only"]),
        "{auths:?}"
    );
    Ok(())
}

#[tokio::test]
async fn a_wrong_password_is_refused_without_showing_it() -> Result<()> {
    let mock = Mock::start_with_password(Some("right")).await?;
    let started = Instant::now();
    let error = Dragonfly::connect(with_credentials(&mock, "dima:wrong-pass"), Hooks::default())
        .await
        .map(|_| ())
        .err()
        .context("a wrong password connected")?;
    // A configuration error at once, not the connect deadline after retries.
    ensure!(matches!(error, DragonflyError::Config(_)), "{error:?}");
    ensure!(
        started.elapsed() < Duration::from_secs(2),
        "{:?}",
        started.elapsed()
    );
    for shown in [error.to_string(), format!("{error:?}")] {
        ensure!(!shown.contains("wrong-pass"), "{shown}");
    }
    Ok(())
}

#[tokio::test]
async fn a_refused_subscriber_auth_is_reported_once_and_retried_with_backoff() -> Result<()> {
    let mut mock = Mock::start_with_password(Some("old")).await?;
    let errors = Arc::new(CountingErrors::default());
    let hooks = Hooks {
        command: None,
        errors: Some(errors.clone()),
    };
    let df = Dragonfly::connect(with_credentials(&mock, "dima:old"), hooks).await?;
    // The password is rotated on the server before the subscriber connects.
    *locked(&mock.password) = Some("new".to_owned());
    // A blocking connection opened now is refused with a configuration error.
    let refused = df.blocking().connect().await;
    ensure!(
        matches!(refused, Err(DragonflyError::Config(_))),
        "{refused:?}"
    );
    locked(&mock.auths).clear();
    let subscriber = df.subscriber();
    let (subscription, ()) = tokio::join!(
        subscriber.subscribe(Topic::Channel("a".into()), Overflow::Gap),
        tokio::time::sleep(Duration::from_millis(800))
    );
    let subscription = subscription?;
    ensure!(!subscription.confirmed());
    let refused = locked(&mock.auths).len();
    // Back-off 50, 100, 200, 400 ms: about five attempts in 800 ms, not a busy loop.
    ensure!((2..=6).contains(&refused), "{refused} AUTH attempts");
    let messages = locked(&errors.messages).clone();
    ensure!(messages.len() == 1, "reported {messages:?}");
    ensure!(
        messages[0].contains("refused the subscriber's AUTH"),
        "{messages:?}"
    );
    ensure!(!messages[0].contains("old"), "{messages:?}");
    // Once the credentials work again the subscriber comes back.
    *locked(&mock.password) = Some("old".to_owned());
    let mut peer = mock.peer().await?;
    ensure!(peer.command().await? == ["SUBSCRIBE", "a"]);
    Ok(())
}

#[tokio::test]
async fn a_nested_array_replaces_the_connection() -> Result<()> {
    let mut mock = Mock::start().await?;
    let subscriber = setup(mock.config(Duration::from_secs(10))).await?;
    let mut peer = mock.peer().await?;
    let mut subscription = subscribed(&subscriber, &mut peer, "a").await?;
    // Four levels of sixteen children each used to be accepted; a subscriber never gets one.
    peer.send(b"*3\r\n$7\r\nmessage\r\n*16\r\n").await?;
    peer.closed(Duration::from_secs(1)).await?;
    let mut fresh = mock.peer().await?;
    ensure!(fresh.command().await? == ["SUBSCRIBE", "a"]);
    fresh.send(&confirmation("subscribe", "a", 1)).await?;
    ensure!(next(&mut subscription).await? == RESUBSCRIBED);
    Ok(())
}

#[tokio::test]
async fn a_subscription_replaced_while_resubscribing_still_reports_the_gap() -> Result<()> {
    let mut mock = Mock::start().await?;
    let subscriber = setup(mock.config(Duration::from_secs(10))).await?;
    let mut peer = mock.peer().await?;
    let mut old = subscribed(&subscriber, &mut peer, "a").await?;
    // The connection drops: whatever is published until "a" is subscribed again is lost.
    drop(peer);
    let mut fresh = mock.peer().await?;
    ensure!(fresh.command().await? == ["SUBSCRIBE", "a"]);
    // Replaced before the resubscription is confirmed: the new subscription is owed the gap.
    let confirm = async {
        tokio::time::sleep(Duration::from_millis(100)).await;
        fresh.send(&confirmation("subscribe", "a", 1)).await
    };
    let (new, confirmed) = tokio::join!(
        subscriber.subscribe(Topic::Channel("a".into()), Overflow::Gap),
        confirm
    );
    confirmed?;
    let mut new = new?;
    ensure!(new.confirmed());
    ensure!(next(&mut new).await? == RESUBSCRIBED);
    ensure!(old.recv().await.is_none(), "the replaced stream ends");
    // Nothing was sent for the replacement.
    fresh.silent(Duration::from_millis(200)).await
}

#[tokio::test]
async fn a_subscription_replaced_while_reconnecting_still_reports_the_gap() -> Result<()> {
    let mut mock = Mock::start().await?;
    let mut config = mock.config(Duration::from_secs(10));
    config.connect_timeout = Duration::from_secs(10);
    let subscriber = setup(config).await?;
    let mut peer = mock.peer().await?;
    let _old = subscribed(&subscriber, &mut peer, "a").await?;
    drop(peer);
    let mut fresh = mock.peer().await?;
    let (new, script) = tokio::join!(
        subscriber.subscribe(Topic::Channel("a".into()), Overflow::Gap),
        async {
            ensure!(fresh.command().await? == ["SUBSCRIBE", "a"]);
            fresh.send(&confirmation("subscribe", "a", 1)).await
        }
    );
    script?;
    let mut new = new?;
    ensure!(next(&mut new).await? == RESUBSCRIBED);
    Ok(())
}

/// Plays a server for one channel: confirms the commands read so far plus any that follow, one
/// every `gap`, and records after each confirmation whether the server is then subscribed with
/// nothing outstanding (the only state in which a subscription may be reported live).
async fn confirm_like_a_server(
    peer: &mut Peer,
    mut queue: std::collections::VecDeque<Vec<String>>,
    gap: Duration,
    settled: &std::sync::atomic::AtomicBool,
) -> Result<bool> {
    use std::sync::atomic::Ordering;
    let mut subscribed = false;
    loop {
        if queue.is_empty() {
            match tokio::time::timeout(gap * 3, peer.commands.recv()).await {
                Ok(Some(command)) => queue.push_back(command),
                Ok(None) => bail!("the connection closed"),
                Err(_) => return Ok(subscribed),
            }
        }
        let Some(command) = queue.pop_front() else {
            continue;
        };
        tokio::time::sleep(gap).await;
        // Commands that arrived meanwhile are outstanding when this confirmation goes out.
        while let Ok(more) = peer.commands.try_recv() {
            queue.push_back(more);
        }
        let name = command.get(1).cloned().unwrap_or_default();
        match command.first().map(String::as_str) {
            Some("SUBSCRIBE") => {
                subscribed = true;
                settled.store(queue.is_empty(), Ordering::SeqCst);
                peer.send(&confirmation("subscribe", &name, 1)).await?;
            }
            Some("UNSUBSCRIBE") => {
                subscribed = false;
                settled.store(false, Ordering::SeqCst);
                peer.send(&confirmation("unsubscribe", &name, 0)).await?;
            }
            other => bail!("unexpected {other:?}"),
        }
    }
}

#[tokio::test]
async fn a_late_confirmation_does_not_make_a_newer_subscription_live() -> Result<()> {
    use std::sync::atomic::{AtomicBool, Ordering};
    let mut mock = Mock::start().await?;
    let subscriber = setup(mock.config(Duration::from_secs(10))).await?;
    let mut peer = mock.peer().await?;
    let old = subscribed(&subscriber, &mut peer, "a").await?;
    // Reconnect: the subscriber sends SUBSCRIBE a again, unconfirmed for now.
    drop(peer);
    let mut fresh = mock.peer().await?;
    ensure!(fresh.command().await? == ["SUBSCRIBE", "a"]);
    // The old subscription goes, and a new one on the same channel is requested before the
    // server answers anything.
    drop(old);
    tokio::time::sleep(Duration::from_millis(100)).await;
    let settled = AtomicBool::new(false);
    let mut queue = std::collections::VecDeque::from([vec!["SUBSCRIBE".into(), "a".into()]]);
    let server = async {
        tokio::time::sleep(Duration::from_millis(100)).await;
        while let Ok(more) = fresh.commands.try_recv() {
            queue.push_back(more);
        }
        confirm_like_a_server(&mut fresh, queue, Duration::from_millis(100), &settled).await
    };
    let new = async {
        let subscription = subscriber
            .subscribe(Topic::Channel("a".into()), Overflow::Gap)
            .await?;
        // Live only once the server is subscribed with nothing outstanding for the channel.
        let settled_now = settled.load(Ordering::SeqCst);
        Ok::<_, anyhow::Error>((subscription, settled_now))
    };
    let (new, server) = tokio::join!(new, server);
    let (mut new, settled_when_live) = new?;
    ensure!(
        server?,
        "the server ends unsubscribed while a subscription exists"
    );
    ensure!(new.confirmed());
    ensure!(
        settled_when_live,
        "reported live while the server still had a command to process for the channel"
    );
    fresh.send(&message("a", "after")).await?;
    match next(&mut new).await? {
        Event::Message(message) => ensure!(message.payload == b"after"),
        other => bail!("{other:?}"),
    }
    Ok(())
}

#[tokio::test]
async fn churn_on_one_channel_never_reports_live_early() -> Result<()> {
    use std::sync::atomic::{AtomicBool, Ordering};
    let mut mock = Mock::start().await?;
    let subscriber = setup(mock.config(Duration::from_secs(10))).await?;
    let mut peer = mock.peer().await?;
    let first = subscribed(&subscriber, &mut peer, "a").await?;
    // Unsubscribe in flight, then a new subscription on the same channel.
    drop(first);
    ensure!(peer.command().await? == ["UNSUBSCRIBE", "a"]);
    let settled = AtomicBool::new(false);
    let queue = std::collections::VecDeque::from([vec!["UNSUBSCRIBE".into(), "a".into()]]);
    let server = confirm_like_a_server(&mut peer, queue, Duration::from_millis(100), &settled);
    let new = async {
        let subscription = subscriber
            .subscribe(Topic::Channel("a".into()), Overflow::Gap)
            .await?;
        Ok::<_, anyhow::Error>((subscription, settled.load(Ordering::SeqCst)))
    };
    let (new, server) = tokio::join!(new, server);
    let (new, settled_when_live) = new?;
    ensure!(server?);
    ensure!(new.confirmed() && settled_when_live);
    Ok(())
}

#[tokio::test]
async fn a_topic_longer_than_the_limit_is_refused_locally() -> Result<()> {
    let mut mock = Mock::start().await?;
    let mut config = mock.config(Duration::from_secs(10));
    config.subscription_max_message_bytes = 4096;
    config.subscription_max_topic_bytes = 64;
    let subscriber = setup(config).await?;
    let mut peer = mock.peer().await?;
    for topic in [
        Topic::Channel("c".repeat(65)),
        Topic::Pattern("p".repeat(65)),
    ] {
        let refused = subscriber.subscribe(topic, Overflow::Gap).await;
        ensure!(
            matches!(refused, Err(DragonflyError::TopicTooLong { limit: 64 })),
            "{refused:?}"
        );
    }
    // Nothing was sent; a topic at the limit works.
    let longest = "c".repeat(64);
    let _ok = subscribed(&subscriber, &mut peer, &longest).await?;
    // The receive limit caps the topic limit: a topic the confirmation of which would be
    // refused is refused here instead.
    let mut mock = Mock::start().await?;
    let mut config = mock.config(Duration::from_secs(10));
    config.subscription_max_message_bytes = 32;
    let subscriber = setup(config).await?;
    let _peer = mock.peer().await?;
    let refused = subscriber
        .subscribe(Topic::Channel("c".repeat(33)), Overflow::Gap)
        .await;
    ensure!(
        matches!(refused, Err(DragonflyError::TopicTooLong { limit: 32 })),
        "{refused:?}"
    );
    Ok(())
}

#[tokio::test]
async fn churn_keeps_one_command_per_topic_in_flight() -> Result<()> {
    let mut mock = Mock::start().await?;
    let mut config = mock.config(Duration::from_secs(10));
    config.max_subscriptions = 4;
    let subscriber = setup(config).await?;
    let mut peer = mock.peer().await?;
    // The server answers nothing. Subscribing and dropping one channel many times sends one
    // command; distinct channels stop at the cap.
    for _ in 0..1000 {
        let pending = tokio::time::timeout(
            Duration::from_millis(1),
            subscriber.subscribe(Topic::Channel("same".into()), Overflow::Gap),
        )
        .await;
        drop(pending);
    }
    let mut refused = 0;
    for n in 0..1000 {
        match tokio::time::timeout(
            Duration::from_millis(1),
            subscriber.subscribe(Topic::Channel(format!("t{n}")), Overflow::Gap),
        )
        .await
        {
            Ok(Err(DragonflyError::TooManySubscriptions { .. })) => refused += 1,
            Ok(other) => bail!("{other:?}"),
            Err(_) => {}
        }
    }
    ensure!(refused >= 996, "{refused} refused");
    let mut commands = Vec::new();
    while let Ok(Some(command)) =
        tokio::time::timeout(Duration::from_millis(200), peer.commands.recv()).await
    {
        commands.push(command);
    }
    ensure!(
        commands.len() <= 4,
        "{} commands in flight: {commands:?}",
        commands.len()
    );
    ensure!(commands.first() == Some(&vec!["SUBSCRIBE".to_owned(), "same".to_owned()]));
    Ok(())
}
