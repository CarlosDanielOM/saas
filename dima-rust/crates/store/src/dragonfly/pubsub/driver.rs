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
//! Bytes go from the socket into one buffer, are parsed into frames ([`super::resp`], every
//! bulk string bounded by [`MAX_MESSAGE_BYTES`]) and handed to the subscriptions at once, which
//! never wait ([`super::Inbox`]). So the stage between the socket and the subscriptions holds at
//! most one frame being received plus one read; the socket is read only as fast as frames are
//! dispatched, and a frame over the limit discards the connection instead of growing the buffer.
//!
//! A connection that stays silent for the ping interval is sent `PING`, under the same deadline,
//! so a peer that stops answering is noticed even without control traffic.

use super::resp::{self, Frame};
use super::{Control, Entry, Message, Push, State, Topic};
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

/// The largest message (payload, channel or pattern) a subscriber accepts.
pub(super) const MAX_MESSAGE_BYTES: usize = 8 * 1024 * 1024;

/// The settings the loop runs with, from [`crate::dragonfly::DragonflyConfig`].
#[derive(Clone, Copy, Debug)]
struct Limits {
    control_timeout: Duration,
    ping_interval: Duration,
    max_message_bytes: usize,
}

impl Limits {
    fn of(shared: &Shared) -> Self {
        Self {
            control_timeout: shared.config.response_timeout.max(Duration::from_millis(1)),
            ping_interval: shared
                .config
                .subscriber_ping_interval
                .max(Duration::from_millis(1)),
            max_message_bytes: MAX_MESSAGE_BYTES,
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
    /// One of the subscriptions sent when the connection opened.
    initial: bool,
}

struct Connection {
    id: i64,
    reader: OwnedReadHalf,
    writer: OwnedWriteHalf,
    input: Vec<u8>,
    output: Vec<u8>,
    pending: VecDeque<Pending>,
    ping_pending: bool,
    last_heard: Instant,
    /// Initial subscriptions still unconfirmed; the connection is ready at 0.
    initial: usize,
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
    loop {
        if !first {
            let sleep = tokio::time::sleep(backoff(attempt));
            attempt = attempt.saturating_add(1);
            tokio::pin!(sleep);
            loop {
                tokio::select! {
                    () = &mut sleep => break,
                    request = control.recv() => {
                        if let Flow::Stop(ack) = offline(request, &mut entries, false) {
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
                    if let Flow::Stop(ack) = offline(request, &mut entries, true) {
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
                shared.hooks.report(&shared.config.caller, &error);
                continue;
            }
        };
        connection.resubscribe(&entries, limits);
        if connection.initial == 0 {
            connection.become_ready(&state);
        }

        let lost = serve(&mut connection, &mut control, &mut entries, &state, limits).await;
        if connection.ready {
            attempt = 0;
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
) -> Flow {
    match request {
        None => Flow::Stop(None),
        Some(Control::Shutdown { ack }) => Flow::Stop(Some(ack)),
        Some(Control::Subscribe {
            topic,
            mut entry,
            ack,
        }) => {
            if let Some(mut old) = entries.remove(&topic) {
                old.release_waiters(false);
            }
            if connecting {
                entry.owe_gap = false;
                entry.waiters.push(ack);
            } else {
                entry.owe_gap = true;
                let _ = ack.send(false);
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
        let deadline = connection.next_deadline(limits);
        let writing = !connection.output.is_empty();
        tokio::select! {
            request = control.recv() => match request {
                None => return Ok(None),
                Some(Control::Shutdown { ack }) => return Ok(Some(ack)),
                Some(Control::Subscribe { topic, entry, ack }) => {
                    connection.subscribe_request(topic, entry, ack, entries, limits);
                }
                Some(Control::Unsubscribe { topic, id }) => {
                    if entries.get(&topic).is_some_and(|entry| entry.id == id) {
                        entries.remove(&topic);
                        connection.queue(Kind::Unsubscribe, Some(topic), limits);
                    }
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
                    connection.queue(Kind::Ping, None, limits);
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
    fn queue(&mut self, kind: Kind, topic: Option<Topic>, limits: Limits) {
        self.queue_marked(kind, topic, limits, false);
    }

    fn queue_marked(&mut self, kind: Kind, topic: Option<Topic>, limits: Limits, initial: bool) {
        match (&kind, &topic) {
            (Kind::Subscribe, Some(Topic::Channel(name))) => {
                resp::command(&mut self.output, &[b"SUBSCRIBE", name.as_bytes()]);
            }
            (Kind::Subscribe, Some(Topic::Pattern(name))) => {
                resp::command(&mut self.output, &[b"PSUBSCRIBE", name.as_bytes()]);
            }
            (Kind::Unsubscribe, Some(Topic::Channel(name))) => {
                resp::command(&mut self.output, &[b"UNSUBSCRIBE", name.as_bytes()]);
            }
            (Kind::Unsubscribe, Some(Topic::Pattern(name))) => {
                resp::command(&mut self.output, &[b"PUNSUBSCRIBE", name.as_bytes()]);
            }
            (Kind::Ping, _) => {
                resp::command(&mut self.output, &[b"PING"]);
                self.ping_pending = true;
            }
            // Subscribe and unsubscribe always name a topic.
            (_, None) => return,
        }
        self.pending.push_back(Pending {
            kind,
            topic,
            deadline: Instant::now() + limits.control_timeout,
            initial,
        });
    }

    /// Subscribes to everything registered, as the connection opens.
    fn resubscribe(&mut self, entries: &HashMap<Topic, Entry>, limits: Limits) {
        for topic in entries.keys() {
            self.queue_marked(Kind::Subscribe, Some(topic.clone()), limits, true);
        }
        self.initial = entries.len();
    }

    fn become_ready(&mut self, state: &State) {
        self.ready = true;
        state.connection_id.store(self.id, Ordering::Relaxed);
        state.connections.fetch_add(1, Ordering::Relaxed);
    }

    fn subscribe_request(
        &mut self,
        topic: Topic,
        mut entry: Entry,
        ack: oneshot::Sender<bool>,
        entries: &mut HashMap<Topic, Entry>,
        limits: Limits,
    ) {
        match entries.remove(&topic) {
            // Replacing a topic keeps its server subscription: the new subscription is live as
            // soon as that one is (the old stream ends).
            Some(mut old) => {
                old.release_waiters(false);
                entry.live = old.live;
                if entry.live {
                    let _ = ack.send(true);
                } else {
                    entry.waiters.push(ack);
                }
            }
            None => {
                entry.waiters.push(ack);
                self.queue(Kind::Subscribe, Some(topic.clone()), limits);
            }
        }
        entries.insert(topic, entry);
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
            match resp::parse(rest, limits.max_message_bytes) {
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
                let topic = next().map(|name| channel_topic(name, false));
                self.confirm(Kind::Subscribe, topic, entries, state, limits)
            }
            b"psubscribe" => {
                let topic = next().map(|name| channel_topic(name, true));
                self.confirm(Kind::Subscribe, topic, entries, state, limits)
            }
            b"unsubscribe" => {
                let topic = next().map(|name| channel_topic(name, false));
                self.confirm(Kind::Unsubscribe, topic, entries, state, limits)
            }
            b"punsubscribe" => {
                let topic = next().map(|name| channel_topic(name, true));
                self.confirm(Kind::Unsubscribe, topic, entries, state, limits)
            }
            b"pong" => self.confirm(Kind::Ping, None, entries, state, limits),
            _ => Ok(()),
        }
    }

    /// Matches a confirmation with the oldest command that waits for one.
    fn confirm(
        &mut self,
        kind: Kind,
        topic: Option<Option<Topic>>,
        entries: &mut HashMap<Topic, Entry>,
        state: &State,
        limits: Limits,
    ) -> Result<(), Lost> {
        let Some(front) = self.pending.pop_front() else {
            return Err(Lost::Protocol(
                "a subscriber confirmation arrived that nothing waits for",
            ));
        };
        let topic = topic.flatten();
        if front.kind != kind || (kind != Kind::Ping && front.topic != topic) {
            return Err(Lost::Protocol(
                "subscriber confirmations arrived out of order",
            ));
        }
        match kind {
            Kind::Ping => self.ping_pending = false,
            Kind::Unsubscribe => {}
            Kind::Subscribe => {
                if let Some(topic) = &topic
                    && let Some(entry) = entries.get_mut(topic)
                    && !entry.live
                    && !entry.go_live()
                {
                    entries.remove(topic);
                    self.queue(Kind::Unsubscribe, Some(topic.clone()), limits);
                }
                if front.initial {
                    self.initial = self.initial.saturating_sub(1);
                    if self.initial == 0 && !self.ready {
                        self.become_ready(state);
                    }
                }
            }
        }
        Ok(())
    }

    /// Hands one message to its subscription; one whose receiver is gone is unsubscribed.
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
        let Some(entry) = entries.get(&topic) else {
            return;
        };
        let message = Message {
            channel,
            pattern,
            payload,
        };
        if entry.inbox.push_message(message) == Push::Closed {
            entries.remove(&topic);
            self.queue(Kind::Unsubscribe, Some(topic), limits);
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

/// Opens the subscriber connection and learns its `CLIENT ID` (for diagnostics and tests)
/// before it switches to subscribe mode, all within the connect timeout. Pub/sub is not
/// scoped to a logical database, so no `SELECT` is sent.
async fn connect(shared: &Shared) -> redis::RedisResult<Connection> {
    let info = shared.client.get_connection_info();
    let ConnectionAddr::Tcp(host, port) = info.addr() else {
        return Err(redis::RedisError::from((
            redis::ErrorKind::InvalidClientConfig,
            "subscriber needs a TCP address",
        )));
    };
    let open = async {
        let mut stream = tokio::net::TcpStream::connect((host.as_str(), *port)).await?;
        stream.set_nodelay(true)?;
        let id = client_id(&mut stream).await?;
        Ok::<_, std::io::Error>((stream, id))
    };
    match tokio::time::timeout(shared.config.connect_timeout, open).await {
        Ok(Ok((stream, id))) => {
            let (reader, writer) = stream.into_split();
            Ok(Connection {
                id,
                reader,
                writer,
                input: Vec::with_capacity(READ_CHUNK),
                output: Vec::new(),
                pending: VecDeque::new(),
                ping_pending: false,
                last_heard: Instant::now(),
                initial: 0,
                ready: false,
            })
        }
        Ok(Err(error)) => Err(redis::RedisError::from(error)),
        Err(_) => Err(redis::RedisError::from(std::io::Error::new(
            std::io::ErrorKind::TimedOut,
            "Dragonfly subscriber connection did not open within the connect timeout",
        ))),
    }
}

/// `CLIENT ID` over the raw socket: the request, then one `:<integer>\r\n` reply.
async fn client_id(stream: &mut tokio::net::TcpStream) -> std::io::Result<i64> {
    stream
        .write_all(b"*2\r\n$6\r\nCLIENT\r\n$2\r\nID\r\n")
        .await?;
    let mut line = Vec::with_capacity(24);
    loop {
        let byte = stream.read_u8().await?;
        line.push(byte);
        if line.ends_with(b"\r\n") {
            break;
        }
        if line.len() > 32 {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "CLIENT ID reply too long",
            ));
        }
    }
    let digits = line
        .strip_prefix(b":")
        .and_then(|rest| rest.strip_suffix(b"\r\n"))
        .and_then(|digits| std::str::from_utf8(digits).ok())
        .and_then(|digits| digits.parse::<i64>().ok());
    digits.ok_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "unexpected CLIENT ID reply",
        )
    })
}
