//! The subscriber task: one `select!` loop that owns the connection.
//!
//! Nothing is awaited outside the loop. Each turn waits on, at the same time: a control request
//! (subscribe, unsubscribe, shutdown), bytes from the socket (`read_buf`, cancel safe), room in
//! the socket for queued commands (`write`, cancel safe), and the earliest deadline. A command is
//! written and its confirmation is matched later, in order, when it arrives, so a confirmation
//! that never comes delays neither delivery, nor other subscriptions, nor shutdown; its deadline
//! ([`super::super::DragonflyConfig::response_timeout`]) discards the connection, and the
//! subscriber reconnects and subscribes again.
//!
//! # Per-topic state
//!
//! On a connection every topic the server knows about has a [`Link`]: the server's state as of
//! the last confirmation (subscribed or not) and the one command sent for it whose confirmation
//! has not arrived, if any. At most one command per topic is in flight; when a subscription is
//! added, replaced or dropped meanwhile, nothing is sent until that confirmation arrives, and
//! then the next command, if one is still needed, is sent ([`Connection::reconcile`]). So a
//! confirmation always belongs to the latest command for its topic, and:
//!
//! - a subscription is **live** only when its topic's link is settled (nothing in flight) and
//!   subscribed: the server is then sending its messages;
//! - messages are delivered only to a live subscription (anything before is from the time
//!   before it was subscribed), so an unsubscribe in between can never open a silent hole;
//! - a link without a subscription is unsubscribed, then forgotten.
//!
//! A reconnect starts with no links: every subscription is sent again and is owed a gap marker
//! (`Gap` subscriptions) until it is live again.
//!
//! Bytes go from the socket into one buffer, are cut into frames ([`super::resp::Framer`], which
//! keeps its progress through an incomplete frame between reads, so a frame arriving in many
//! reads is not parsed again each time; every bulk string bounded by
//! `subscription_max_message_bytes`, the whole frame by that plus a small overhead) and handed
//! to the subscriptions at once, which never wait ([`super::Inbox`]). So the stage between the
//! socket and the subscriptions holds at most one frame being received plus one read; the socket
//! is read only as fast as frames are dispatched, and a frame over the limit discards the
//! connection instead of growing the buffer.
//!
//! A connection that stays silent for the ping interval is sent `PING`, under the same deadline,
//! so a peer that stops answering is noticed even without control traffic.

use super::resp::{self, Frame};
use super::{Ack, Control, Entry, Message, Push, State, Topic};
use crate::dragonfly::DragonflyError;
use crate::dragonfly::client::Shared;
use redis::ConnectionAddr;
use std::collections::{HashMap, VecDeque};
use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::tcp::{OwnedReadHalf, OwnedWriteHalf};
use tokio::sync::{mpsc, oneshot};
use tokio::time::Instant;

/// Bytes asked from the socket per read.
const READ_CHUNK: usize = 16 * 1024;

/// The settings the loop runs with, from [`crate::dragonfly::DragonflyConfig`].
#[derive(Clone, Copy, Debug)]
struct Limits {
    control_timeout: Duration,
    ping_interval: Duration,
    max_message_bytes: usize,
    max_subscriptions: usize,
    max_topic_bytes: usize,
}

/// Room in a frame for its headers and the kind (`pmessage`, `punsubscribe`...).
const FRAME_HEADERS: usize = 128;

/// The most bytes one command takes besides its topic (`*2`, `$12`, `PUNSUBSCRIBE`, CRLFs).
const COMMAND_OVERHEAD: usize = 64;

impl Limits {
    /// The limits of one received frame: every bulk string within the message limit; the whole
    /// frame within one message, two names (the pattern and channel of a `pmessage`) and the
    /// headers.
    fn frame(self) -> resp::Limits {
        resp::Limits {
            max_bulk: self.max_message_bytes,
            max_frame: self
                .max_message_bytes
                .saturating_add(self.max_topic_bytes.saturating_mul(2))
                .saturating_add(FRAME_HEADERS),
        }
    }

    /// The most bytes the commands waiting to be written can take: one per topic (see the
    /// module docs) plus a `PING`.
    fn max_output(self) -> usize {
        self.max_subscriptions
            .saturating_add(1)
            .saturating_mul(self.max_topic_bytes.saturating_add(COMMAND_OVERHEAD))
    }

    fn of(shared: &Shared) -> Self {
        Self {
            control_timeout: shared.config.response_timeout.max(Duration::from_millis(1)),
            ping_interval: shared
                .config
                .subscriber_ping_interval
                .max(Duration::from_millis(1)),
            max_message_bytes: shared.config.subscription_max_message_bytes.max(1),
            max_subscriptions: shared.config.max_subscriptions,
            max_topic_bytes: shared.config.effective_max_topic_bytes(),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Kind {
    Subscribe,
    Unsubscribe,
    Ping,
}

impl Kind {
    fn waiting_for(self) -> &'static str {
        match self {
            Self::Subscribe => "Dragonfly subscriber got no confirmation of SUBSCRIBE in time",
            Self::Unsubscribe => "Dragonfly subscriber got no confirmation of UNSUBSCRIBE in time",
            Self::Ping => "Dragonfly subscriber got no reply to PING in time",
        }
    }
}

/// A command written (or queued) whose confirmation has not arrived.
struct Pending {
    kind: Kind,
    topic: Option<Topic>,
    deadline: Instant,
}

/// What the server has been asked about one topic on this connection (see the module docs).
#[derive(Debug, Default)]
struct Link {
    /// The server's state as of the last confirmation.
    subscribed: bool,
    /// The command sent for the topic whose confirmation has not arrived (at most one).
    in_flight: Option<Kind>,
}

struct Connection {
    id: i64,
    reader: OwnedReadHalf,
    writer: OwnedWriteHalf,
    input: Vec<u8>,
    /// Progress through the incomplete frame at the start of `input`.
    framer: resp::Framer,
    output: Vec<u8>,
    pending: VecDeque<Pending>,
    /// Every topic the server knows about on this connection; a superset of the subscriptions.
    links: HashMap<Topic, Link>,
    /// Links with a command in flight; the connection is ready the first time it is 0.
    unsettled: usize,
    ping_pending: bool,
    last_heard: Instant,
    ready: bool,
}

/// Why a connection was given up.
enum Lost {
    Closed,
    Io(std::io::Error),
    Timeout(&'static str),
    Protocol(&'static str),
}

impl Lost {
    fn into_error(self) -> redis::RedisError {
        let io = match self {
            Self::Closed => std::io::Error::new(
                std::io::ErrorKind::ConnectionReset,
                "Dragonfly subscriber connection closed",
            ),
            Self::Io(error) => error,
            Self::Timeout(what) => std::io::Error::new(std::io::ErrorKind::TimedOut, what),
            Self::Protocol(what) => std::io::Error::new(std::io::ErrorKind::InvalidData, what),
        };
        redis::RedisError::from(io)
    }
}

/// How a phase of the loop ended.
enum Flow {
    Continue,
    /// Shutdown was requested (with its acknowledgement) or every handle is gone.
    Stop(Option<oneshot::Sender<()>>),
}

pub(super) async fn run(
    shared: Arc<Shared>,
    mut control: mpsc::Receiver<Control>,
    state: Arc<State>,
) {
    let limits = Limits::of(&shared);
    let mut entries: HashMap<Topic, Entry> = HashMap::new();
    let mut attempt = 0_u32;
    let mut first = true;
    // A refused AUTH is reported once, until a connection works again.
    let mut auth_reported = false;
    loop {
        if !first {
            let sleep = tokio::time::sleep(backoff(attempt));
            attempt = attempt.saturating_add(1);
            tokio::pin!(sleep);
            loop {
                tokio::select! {
                    () = &mut sleep => break,
                    request = control.recv() => {
                        if let Flow::Stop(ack) = offline(request, &mut entries, false, limits) {
                            return stop(entries, ack);
                        }
                    }
                }
            }
        }
        first = false;

        let connecting = connect(&shared);
        tokio::pin!(connecting);
        let connected = loop {
            tokio::select! {
                result = &mut connecting => break result,
                request = control.recv() => {
                    if let Flow::Stop(ack) = offline(request, &mut entries, true, limits) {
                        return stop(entries, ack);
                    }
                }
            }
        };
        let mut connection = match connected {
            Ok(connection) => connection,
            Err(error) => {
                for entry in entries.values_mut() {
                    entry.went_offline();
                }
                let refused = matches!(error, ConnectError::AuthRefused);
                if !(refused && auth_reported) {
                    shared
                        .hooks
                        .report(&shared.config.caller, &error.into_error());
                }
                auth_reported |= refused;
                continue;
            }
        };
        connection.open(&mut entries, &state, limits);

        let lost = serve(&mut connection, &mut control, &mut entries, &state, limits).await;
        if connection.ready {
            attempt = 0;
            auth_reported = false;
        }
        drop(connection);
        state.connection_id.store(0, Ordering::Relaxed);
        for entry in entries.values_mut() {
            entry.went_offline();
        }
        match lost {
            Ok(ack) => return stop(entries, ack),
            Err(lost) => shared
                .hooks
                .report(&shared.config.caller, &lost.into_error()),
        }
    }
}

/// Ends the task: every subscription's stream ends, then shutdown is acknowledged.
fn stop(entries: HashMap<Topic, Entry>, ack: Option<oneshot::Sender<()>>) {
    drop(entries);
    if let Some(ack) = ack {
        let _ = ack.send(());
    }
}

/// A control request while there is no connection. While a connection is being opened
/// (`connecting`), a new subscription waits for it (it is sent with the others once open, and
/// answered when confirmed, or unconfirmed if the attempt fails); between attempts it is
/// answered unconfirmed at once and made on reconnect, and a `Gap` subscription is then told
/// with a marker once it is live.
fn offline(
    request: Option<Control>,
    entries: &mut HashMap<Topic, Entry>,
    connecting: bool,
    limits: Limits,
) -> Flow {
    match request {
        None => Flow::Stop(None),
        Some(Control::Shutdown { ack }) => Flow::Stop(Some(ack)),
        Some(Control::Subscribe {
            topic,
            mut entry,
            ack,
        }) => {
            let Some(ack) = admit(entries.len(), entries.contains_key(&topic), ack, limits) else {
                return Flow::Continue;
            };
            // A replacement takes over a gap its predecessor was owed.
            if let Some(mut old) = entries.remove(&topic) {
                old.release_waiters(false);
                entry.owe_gap = old.owe_gap;
            }
            if connecting {
                entry.waiters.push(ack);
            } else {
                entry.owe_gap = true;
                let _ = ack.send(Ok(false));
            }
            entries.insert(topic, entry);
            Flow::Continue
        }
        Some(Control::Unsubscribe { topic, id }) => {
            if entries.get(&topic).is_some_and(|entry| entry.id == id) {
                entries.remove(&topic);
            }
            Flow::Continue
        }
    }
}

/// Refuses a new topic beyond the cap (the request's entry is dropped, its stream ends);
/// otherwise hands the acknowledgement back. `held` counts the topics that occupy a place
/// (on a connection, also those still being unsubscribed); `known` says whether this topic is
/// one of them.
fn admit(held: usize, known: bool, ack: Ack, limits: Limits) -> Option<Ack> {
    if !known && held >= limits.max_subscriptions {
        let _ = ack.send(Err(DragonflyError::TooManySubscriptions {
            limit: limits.max_subscriptions,
        }));
        return None;
    }
    Some(ack)
}

/// Serves a connection until it is lost (`Err`) or the task must stop (`Ok`).
async fn serve(
    connection: &mut Connection,
    control: &mut mpsc::Receiver<Control>,
    entries: &mut HashMap<Topic, Entry>,
    state: &State,
    limits: Limits,
) -> Result<Option<oneshot::Sender<()>>, Lost> {
    loop {
        if connection.input.capacity() - connection.input.len() < READ_CHUNK {
            connection.input.reserve(READ_CHUNK);
        }
        if connection.output.len() > limits.max_output()
            || connection.pending.len() > limits.max_subscriptions.saturating_add(1)
        {
            // Not reachable while one command per topic is in flight; replace rather than grow.
            return Err(Lost::Protocol("subscriber commands exceed their bound"));
        }
        let deadline = connection.next_deadline(limits);
        let writing = !connection.output.is_empty();
        tokio::select! {
            request = control.recv() => match request {
                None => return Ok(None),
                Some(Control::Shutdown { ack }) => return Ok(Some(ack)),
                Some(Control::Subscribe { topic, entry, ack }) => {
                    connection.subscribe_request(topic, entry, ack, entries, state, limits);
                }
                Some(Control::Unsubscribe { topic, id }) => {
                    connection.unsubscribe_request(&topic, id, entries, limits);
                }
            },
            read = connection.reader.read_buf(&mut connection.input) => match read {
                Ok(0) => return Err(Lost::Closed),
                Ok(_) => {
                    connection.last_heard = Instant::now();
                    connection.drain_frames(entries, state, limits)?;
                }
                Err(error) => return Err(Lost::Io(error)),
            },
            written = connection.writer.write(&connection.output), if writing => match written {
                Ok(0) => return Err(Lost::Closed),
                Ok(count) => {
                    connection.output.drain(..count.min(connection.output.len()));
                }
                Err(error) => return Err(Lost::Io(error)),
            },
            () = tokio::time::sleep_until(deadline) => {
                let now = Instant::now();
                if let Some(front) = connection.pending.front()
                    && front.deadline <= now
                {
                    return Err(Lost::Timeout(front.kind.waiting_for()));
                }
                if !connection.ping_pending
                    && connection.last_heard + limits.ping_interval <= now
                {
                    connection.ping_pending = true;
                    connection.send(Kind::Ping, None, limits);
                }
            }
        }
    }
}

impl Connection {
    /// The earliest deadline: the oldest unconfirmed command's, or when a ping is due.
    fn next_deadline(&self, limits: Limits) -> Instant {
        let ping = (!self.ping_pending).then(|| self.last_heard + limits.ping_interval);
        let confirmation = self.pending.front().map(|pending| pending.deadline);
        match (confirmation, ping) {
            (Some(a), Some(b)) => a.min(b),
            (Some(a), None) | (None, Some(a)) => a,
            // A ping is pending, so a confirmation is too; this is never reached.
            (None, None) => Instant::now() + limits.control_timeout,
        }
    }

    /// Writes the command and records the confirmation it waits for.
    fn send(&mut self, kind: Kind, topic: Option<&Topic>, limits: Limits) {
        let (name, bytes): (&[u8], &[u8]) = match (kind, topic) {
            (Kind::Subscribe, Some(Topic::Channel(name))) => (b"SUBSCRIBE", name.as_bytes()),
            (Kind::Subscribe, Some(Topic::Pattern(name))) => (b"PSUBSCRIBE", name.as_bytes()),
            (Kind::Unsubscribe, Some(Topic::Channel(name))) => (b"UNSUBSCRIBE", name.as_bytes()),
            (Kind::Unsubscribe, Some(Topic::Pattern(name))) => (b"PUNSUBSCRIBE", name.as_bytes()),
            (Kind::Ping, _) => (b"PING", b""),
            // Subscribe and unsubscribe always name a topic.
            (_, None) => return,
        };
        if kind == Kind::Ping {
            resp::command(&mut self.output, &[name]);
        } else {
            resp::command(&mut self.output, &[name, bytes]);
        }
        self.pending.push_back(Pending {
            kind,
            topic: topic.cloned(),
            deadline: Instant::now() + limits.control_timeout,
        });
    }

    /// The connection opened: every registered subscription is sent.
    fn open(&mut self, entries: &mut HashMap<Topic, Entry>, state: &State, limits: Limits) {
        let topics: Vec<Topic> = entries.keys().cloned().collect();
        for topic in &topics {
            self.reconcile(topic, entries, limits);
        }
        self.check_ready(state);
    }

    /// Brings the server's state for `topic` towards what is wanted (subscribed while it has a
    /// subscription), one command at a time, and makes the subscription live once the server
    /// is subscribed with nothing in flight.
    fn reconcile(&mut self, topic: &Topic, entries: &mut HashMap<Topic, Entry>, limits: Limits) {
        loop {
            let wanted = entries.contains_key(topic);
            let link = match self.links.get_mut(topic) {
                Some(link) => link,
                None if wanted => self.links.entry(topic.clone()).or_default(),
                None => return,
            };
            if link.in_flight.is_some() {
                return;
            }
            if link.subscribed != wanted {
                let kind = if wanted {
                    Kind::Subscribe
                } else {
                    Kind::Unsubscribe
                };
                link.in_flight = Some(kind);
                self.unsettled += 1;
                self.send(kind, Some(topic), limits);
                return;
            }
            if !wanted {
                self.links.remove(topic);
                return;
            }
            // Settled and subscribed: the subscription is live.
            match entries.get_mut(topic) {
                Some(entry) if !entry.live => {
                    if !entry.go_live() {
                        // Its receiver is gone: unsubscribe.
                        entries.remove(topic);
                        continue;
                    }
                }
                _ => {}
            }
            return;
        }
    }

    fn check_ready(&mut self, state: &State) {
        if !self.ready && self.unsettled == 0 {
            self.ready = true;
            state.connection_id.store(self.id, Ordering::Relaxed);
            state.connections.fetch_add(1, Ordering::Relaxed);
        }
    }

    fn subscribe_request(
        &mut self,
        topic: Topic,
        mut entry: Entry,
        ack: Ack,
        entries: &mut HashMap<Topic, Entry>,
        state: &State,
        limits: Limits,
    ) {
        let known = entries.contains_key(&topic) || self.links.contains_key(&topic);
        let Some(ack) = admit(self.links.len(), known, ack, limits) else {
            return;
        };
        match entries.remove(&topic) {
            // A replacement keeps the server's subscription: it is live when that one is (the
            // old stream ends), and takes over a gap the old one was owed.
            Some(mut old) => {
                old.release_waiters(false);
                entry.live = old.live;
                entry.owe_gap = old.owe_gap;
                if entry.live {
                    let _ = ack.send(Ok(true));
                } else {
                    entry.waiters.push(ack);
                }
            }
            None => entry.waiters.push(ack),
        }
        entries.insert(topic.clone(), entry);
        self.reconcile(&topic, entries, limits);
        self.check_ready(state);
    }

    /// A subscription was dropped: unsubscribe unless it was replaced meanwhile.
    fn unsubscribe_request(
        &mut self,
        topic: &Topic,
        id: u64,
        entries: &mut HashMap<Topic, Entry>,
        limits: Limits,
    ) {
        if entries.get(topic).is_some_and(|entry| entry.id == id) {
            entries.remove(topic);
            self.reconcile(topic, entries, limits);
        }
    }

    /// Parses and dispatches every complete frame in the input buffer.
    fn drain_frames(
        &mut self,
        entries: &mut HashMap<Topic, Entry>,
        state: &State,
        limits: Limits,
    ) -> Result<(), Lost> {
        let mut consumed = 0;
        loop {
            let rest = self.input.get(consumed..).unwrap_or_default();
            match self.framer.next(rest, limits.frame()) {
                Ok(Some((frame, used))) => {
                    consumed += used;
                    self.handle(frame, entries, state, limits)?;
                }
                Ok(None) => break,
                Err(error) => return Err(Lost::Protocol(error.describe())),
            }
        }
        self.input.drain(..consumed.min(self.input.len()));
        Ok(())
    }

    fn handle(
        &mut self,
        frame: Frame,
        entries: &mut HashMap<Topic, Entry>,
        state: &State,
        limits: Limits,
    ) -> Result<(), Lost> {
        let items = match frame {
            Frame::Array(Some(items)) => items,
            Frame::Simple(text) if text.eq_ignore_ascii_case(b"PONG") => {
                return self.confirm(Kind::Ping, None, entries, state, limits);
            }
            Frame::Error(_) => {
                return Err(Lost::Protocol("the server refused a subscriber command"));
            }
            // Nothing else is sent to a connection in subscribe mode; ignore it.
            _ => return Ok(()),
        };
        let mut items = items.into_iter().map(|item| match item {
            Frame::Bulk(Some(bytes)) | Frame::Simple(bytes) => Some(bytes),
            _ => None,
        });
        let Some(Some(kind)) = items.next() else {
            return Ok(());
        };
        let kind = kind.to_ascii_lowercase();
        let mut next = || items.next().flatten();
        match kind.as_slice() {
            b"message" => {
                if let (Some(channel), Some(payload)) = (next(), next()) {
                    self.deliver(channel, None, payload, entries, limits);
                }
                Ok(())
            }
            b"pmessage" => {
                if let (Some(pattern), Some(channel), Some(payload)) = (next(), next(), next()) {
                    self.deliver(channel, Some(pattern), payload, entries, limits);
                }
                Ok(())
            }
            b"subscribe" => {
                let topic = next().and_then(|name| channel_topic(name, false));
                self.confirm(Kind::Subscribe, topic, entries, state, limits)
            }
            b"psubscribe" => {
                let topic = next().and_then(|name| channel_topic(name, true));
                self.confirm(Kind::Subscribe, topic, entries, state, limits)
            }
            b"unsubscribe" => {
                let topic = next().and_then(|name| channel_topic(name, false));
                self.confirm(Kind::Unsubscribe, topic, entries, state, limits)
            }
            b"punsubscribe" => {
                let topic = next().and_then(|name| channel_topic(name, true));
                self.confirm(Kind::Unsubscribe, topic, entries, state, limits)
            }
            b"pong" => self.confirm(Kind::Ping, None, entries, state, limits),
            _ => Ok(()),
        }
    }

    /// Matches a confirmation with the oldest command that waits for one; it must be that
    /// command's, and (for a topic) the one command in flight for the topic.
    fn confirm(
        &mut self,
        kind: Kind,
        topic: Option<Topic>,
        entries: &mut HashMap<Topic, Entry>,
        state: &State,
        limits: Limits,
    ) -> Result<(), Lost> {
        let Some(front) = self.pending.pop_front() else {
            return Err(Lost::Protocol(
                "a subscriber confirmation arrived that nothing waits for",
            ));
        };
        if front.kind != kind || front.topic != topic {
            return Err(Lost::Protocol(
                "subscriber confirmations arrived out of order",
            ));
        }
        let Some(topic) = topic else {
            self.ping_pending = false;
            return Ok(());
        };
        let Some(link) = self
            .links
            .get_mut(&topic)
            .filter(|link| link.in_flight == Some(kind))
        else {
            return Err(Lost::Protocol(
                "a subscriber confirmation names a topic with no command in flight",
            ));
        };
        link.in_flight = None;
        link.subscribed = kind == Kind::Subscribe;
        self.unsettled = self.unsettled.saturating_sub(1);
        self.reconcile(&topic, entries, limits);
        self.check_ready(state);
        Ok(())
    }

    /// Hands one message to its subscription if it is live; one whose receiver is gone is
    /// unsubscribed.
    fn deliver(
        &mut self,
        channel: Vec<u8>,
        pattern: Option<Vec<u8>>,
        payload: Vec<u8>,
        entries: &mut HashMap<Topic, Entry>,
        limits: Limits,
    ) {
        // Topics are text: a name that is not UTF-8 matches no subscription.
        let (topic, pattern) = match pattern {
            Some(pattern) => match String::from_utf8(pattern) {
                Ok(pattern) => (Topic::Pattern(pattern.clone()), Some(pattern)),
                Err(_) => return,
            },
            None => match std::str::from_utf8(&channel) {
                Ok(name) => (Topic::Channel(name.to_owned()), None),
                Err(_) => return,
            },
        };
        // A subscription that is not live yet was requested after the server last subscribed
        // the topic: what arrives now predates it.
        let Some(entry) = entries.get(&topic).filter(|entry| entry.live) else {
            return;
        };
        let message = Message {
            channel,
            pattern,
            payload,
        };
        if entry.inbox.push_message(message) == Push::Closed {
            entries.remove(&topic);
            self.reconcile(&topic, entries, limits);
        }
    }
}

/// The topic a confirmation names.
fn channel_topic(name: Vec<u8>, pattern: bool) -> Option<Topic> {
    let name = String::from_utf8(name).ok()?;
    Some(if pattern {
        Topic::Pattern(name)
    } else {
        Topic::Channel(name)
    })
}

pub(super) fn backoff(attempt: u32) -> Duration {
    Duration::from_millis(50u64.saturating_mul(1u64 << attempt.min(16)).min(2000))
}

/// Why a connection attempt failed.
enum ConnectError {
    /// The server refused the credentials: a configuration error, reported once.
    AuthRefused,
    Other(redis::RedisError),
}

impl ConnectError {
    fn into_error(self) -> redis::RedisError {
        match self {
            Self::AuthRefused => redis::RedisError::from(std::io::Error::new(
                std::io::ErrorKind::PermissionDenied,
                "Dragonfly refused the subscriber's AUTH: check the credentials in the address",
            )),
            Self::Other(error) => error,
        }
    }
}

/// Opens the subscriber connection: `AUTH` when the address carries credentials, then learns its
/// `CLIENT ID` (for diagnostics and tests) before it switches to subscribe mode, all within the
/// connect timeout. Pub/sub is not scoped to a logical database, so no `SELECT` is sent.
async fn connect(shared: &Shared) -> Result<Connection, ConnectError> {
    let info = shared.client.get_connection_info();
    let ConnectionAddr::Tcp(host, port) = info.addr() else {
        return Err(ConnectError::Other(redis::RedisError::from((
            redis::ErrorKind::InvalidClientConfig,
            "subscriber needs a TCP address",
        ))));
    };
    let settings = info.redis_settings();
    let open = async {
        let mut stream = tokio::net::TcpStream::connect((host.as_str(), *port)).await?;
        stream.set_nodelay(true)?;
        if let Some(password) = settings.password() {
            let mut auth = Vec::new();
            match settings.username() {
                Some(user) => {
                    resp::command(&mut auth, &[b"AUTH", user.as_bytes(), password.as_bytes()])
                }
                None => resp::command(&mut auth, &[b"AUTH", password.as_bytes()]),
            }
            stream.write_all(&auth).await?;
            let reply = reply_line(&mut stream).await?;
            if reply.first() == Some(&b'-') {
                return Ok(Err(ConnectError::AuthRefused));
            }
            if reply != b"+OK" {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "unexpected AUTH reply",
                ));
            }
        }
        stream
            .write_all(b"*2\r\n$6\r\nCLIENT\r\n$2\r\nID\r\n")
            .await?;
        let id = reply_line(&mut stream)
            .await?
            .strip_prefix(b":")
            .and_then(|digits| std::str::from_utf8(digits).ok())
            .and_then(|digits| digits.parse::<i64>().ok())
            .ok_or_else(|| {
                std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "unexpected CLIENT ID reply",
                )
            })?;
        Ok::<_, std::io::Error>(Ok((stream, id)))
    };
    match tokio::time::timeout(shared.config.connect_timeout, open).await {
        Ok(Ok(Ok((stream, id)))) => {
            let (reader, writer) = stream.into_split();
            Ok(Connection {
                id,
                reader,
                writer,
                input: Vec::with_capacity(READ_CHUNK),
                framer: resp::Framer::default(),
                output: Vec::new(),
                pending: VecDeque::new(),
                links: HashMap::new(),
                unsettled: 0,
                ping_pending: false,
                last_heard: Instant::now(),
                ready: false,
            })
        }
        Ok(Ok(Err(refused))) => Err(refused),
        Ok(Err(error)) => Err(ConnectError::Other(redis::RedisError::from(error))),
        Err(_) => Err(ConnectError::Other(redis::RedisError::from(
            std::io::Error::new(
                std::io::ErrorKind::TimedOut,
                "Dragonfly subscriber connection did not open within the connect timeout",
            ),
        ))),
    }
}

/// The longest reply line read while connecting (`+OK`, an integer, or an error message).
const MAX_CONNECT_REPLY: usize = 512;

/// One reply line (without its CRLF), read byte by byte so nothing after it is consumed.
async fn reply_line(stream: &mut tokio::net::TcpStream) -> std::io::Result<Vec<u8>> {
    let mut line = Vec::with_capacity(24);
    loop {
        let byte = stream.read_u8().await?;
        line.push(byte);
        if line.ends_with(b"\r\n") {
            line.truncate(line.len() - 2);
            return Ok(line);
        }
        if line.len() > MAX_CONNECT_REPLY {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "Dragonfly reply line too long while connecting",
            ));
        }
    }
}
