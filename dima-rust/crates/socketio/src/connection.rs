//! One Engine.IO connection and the namespaces it joined (`Client` in `socket.io` 4.8.3).

use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard, OnceLock, PoisonError};
use std::time::Duration;

use dima_web::UpgradeGuard;
use engineioxide::Str;
use serde_json::{Map, Value};
use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;

use crate::budget::Charge;
use crate::codec::{self, Kind};
use crate::error::DisconnectReason;
use crate::handshake::Origin;
use crate::outbox::{Delivery, NotSent, Outbox, Outgoing, Transport, TransportFull};
use crate::server::{Registry, Shared};
use crate::socket::ErasedSocket;
use crate::telemetry::Refusal;

/// The data `engineioxide` keeps on each of its sockets: our connection, until it closes.
#[derive(Default)]
pub(crate) struct EngineData(Mutex<Option<Arc<Connection>>>);

impl EngineData {
    pub fn set(&self, conn: Arc<Connection>) {
        *self.0.lock().unwrap_or_else(PoisonError::into_inner) = Some(conn);
    }

    pub fn get(&self) -> Option<Arc<Connection>> {
        self.0
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }

    pub fn take(&self) -> Option<Arc<Connection>> {
        self.0.lock().unwrap_or_else(PoisonError::into_inner).take()
    }
}

pub(crate) type EngineSocket = engineioxide::Socket<EngineData>;

impl Transport for EngineSocket {
    fn send(&self, message: Str) -> Result<(), TransportFull> {
        self.emit(message).map_err(|error| match error {
            tokio::sync::mpsc::error::TrySendError::Full(_) => TransportFull::Full,
            tokio::sync::mpsc::error::TrySendError::Closed(_) => TransportFull::Closed,
        })
    }

    fn done(&self) -> u64 {
        self.messages_done()
    }
}

/// A namespace this connection is joining or has joined.
enum Entry {
    /// The check or the restore is running; the ticket identifies that attempt.
    Pending(Ticket),
    Joined(Arc<dyn ErasedSocket>),
}

/// One admission attempt.
#[derive(Clone)]
pub(crate) struct Ticket {
    pub id: u64,
    pub cancel: CancellationToken,
}

struct State {
    entries: HashMap<String, Entry>,
    /// A socket has joined: the connect timeout no longer applies.
    joined: bool,
    guard: Option<UpgradeGuard>,
}

/// How often a restore waiting for room in a full queue tries again, besides being woken.
const TICK: Duration = Duration::from_millis(100);

pub(crate) struct Connection {
    pub shared: Arc<Shared>,
    registry: Arc<Registry>,
    /// Released when the session ends, so a `Socket` handle kept by feature code does not keep
    /// `engineioxide`'s socket and its buffers alive.
    engine: Mutex<Option<Arc<EngineSocket>>>,
    pub first: Arc<Origin>,
    state: Mutex<State>,
    outbox: Mutex<Outbox>,
    /// Fires when the connection starts closing (sockets leave, inbound is ignored).
    closed: CancellationToken,
    /// Fires when the Engine.IO session is gone.
    gone: CancellationToken,
    reason: OnceLock<DisconnectReason>,
    /// A close requested from a send path, where locks may be held: the task carries it out.
    close_requested: OnceLock<DisconnectReason>,
    drained: Notify,
    poke: Notify,
    /// Polling requests waiting for data.
    polls: std::sync::atomic::AtomicUsize,
    /// A polling POST is being read (overlapping ones end the session, as in `engine.io`).
    posting: std::sync::atomic::AtomicBool,
    /// `engineioxide` was told to close the session.
    engine_closing: std::sync::atomic::AtomicBool,
    /// Inbound bytes held for this connection's CONNECT data (the handshakes' `auth`).
    inbound: Arc<std::sync::atomic::AtomicUsize>,
    /// This connection's slot of `max_connections`, given back when the session ends.
    slot: Mutex<Option<tokio::sync::OwnedSemaphorePermit>>,
}

/// One polling request in Engine.IO, a poll or a POST. Dropped before [`PollGuard::finish`]
/// (the client went away mid-request), it closes the connection, as `engine.io` does
/// (`poll connection closed prematurely`, `data request connection closed prematurely`).
pub(crate) struct PollGuard {
    conn: Arc<Connection>,
    post: bool,
    finished: bool,
}

impl PollGuard {
    pub fn finish(mut self) {
        self.finished = true;
    }
}

impl Drop for PollGuard {
    fn drop(&mut self) {
        if self.post {
            self.conn
                .posting
                .store(false, std::sync::atomic::Ordering::Release);
        } else {
            self.conn
                .polls
                .fetch_sub(1, std::sync::atomic::Ordering::AcqRel);
        }
        if !self.finished {
            self.conn.close(DisconnectReason::TransportError);
        }
    }
}

fn engine_reason(reason: &engineioxide::DisconnectReason) -> DisconnectReason {
    use engineioxide::DisconnectReason as E;
    match reason {
        E::TransportClose => DisconnectReason::TransportClose,
        E::TransportError | E::MultipleHttpPollingError => DisconnectReason::TransportError,
        E::PacketParsingError => DisconnectReason::ParseError,
        E::HeartbeatTimeout => DisconnectReason::PingTimeout,
        E::ClosingServer => DisconnectReason::ServerShuttingDown,
    }
}

impl Connection {
    pub fn new(
        shared: Arc<Shared>,
        registry: Arc<Registry>,
        engine: Arc<EngineSocket>,
        first: Arc<Origin>,
        guard: Option<UpgradeGuard>,
        slot: tokio::sync::OwnedSemaphorePermit,
        capacity: usize,
    ) -> Arc<Self> {
        Arc::new(Self {
            shared,
            registry,
            engine: Mutex::new(Some(engine)),
            first,
            state: Mutex::new(State {
                entries: HashMap::new(),
                joined: false,
                guard,
            }),
            outbox: Mutex::new(Outbox::new(capacity)),
            closed: CancellationToken::new(),
            gone: CancellationToken::new(),
            reason: OnceLock::new(),
            close_requested: OnceLock::new(),
            drained: Notify::new(),
            poke: Notify::new(),
            polls: std::sync::atomic::AtomicUsize::new(0),
            posting: std::sync::atomic::AtomicBool::new(false),
            engine_closing: std::sync::atomic::AtomicBool::new(false),
            slot: Mutex::new(Some(slot)),
            inbound: Arc::default(),
        })
    }

    fn state(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn outbox(&self) -> MutexGuard<'_, Outbox> {
        self.outbox.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn engine(&self) -> Option<Arc<EngineSocket>> {
        self.engine
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }

    pub fn is_closed(&self) -> bool {
        self.closed.is_cancelled()
    }

    /// The Engine.IO transport in use (`polling` or `websocket`).
    pub fn transport(&self) -> &'static str {
        match self.engine().map(|engine| engine.transport_type()) {
            Some(engineioxide::TransportType::Websocket) => "websocket",
            _ => "polling",
        }
    }

    /// A polling request is about to wait in Engine.IO.
    pub fn poll_started(self: &Arc<Self>) -> PollGuard {
        self.polls.fetch_add(1, std::sync::atomic::Ordering::AcqRel);
        PollGuard {
            conn: Arc::clone(self),
            post: false,
            finished: false,
        }
    }

    /// A polling POST starts; `None` when one is already being read (`data request overlap`).
    pub fn post_started(self: &Arc<Self>) -> Option<PollGuard> {
        (!self.posting.swap(true, std::sync::atomic::Ordering::AcqRel)).then(|| PollGuard {
            conn: Arc::clone(self),
            post: true,
            finished: false,
        })
    }

    /// Keeps the upgrade guard of a WebSocket upgrade until the connection closes.
    pub fn attach_guard(&self, guard: UpgradeGuard) {
        if !self.is_closed() {
            self.state().guard = Some(guard);
        }
    }

    // ----- inbound -------------------------------------------------------------------------

    /// One Engine.IO message (`Client.ondata` / `ondecoded`).
    ///
    /// The memory its data will take once parsed is reserved first, from its text
    /// ([`codec::parsed_size_bound`]): on the socket's inbound budget for an event or an
    /// acknowledgement, on the connection's for a CONNECT (its data stays as the handshake's
    /// `auth`), and on the server-wide one. A packet that does not fit closes the connection
    /// as an inbound overflow, as an event beyond the inbound queue does, without being parsed.
    pub fn on_message(self: &Arc<Self>, text: &str) {
        if self.is_closed() {
            return;
        }
        let Ok(head) = codec::decode_head(text) else {
            self.shared.telemetry.protocol_error();
            self.close(DisconnectReason::ForcedClose);
            return;
        };
        let socket = match head.kind {
            0 | 4 => None,
            _ => match self.state().entries.get(head.nsp) {
                Some(Entry::Joined(socket)) => Some(Arc::clone(socket)),
                _ => None,
            },
        };
        // A packet for a namespace this connection has not joined: `invalid state` (checked
        // before its data is parsed).
        if head.kind != 0 && head.kind != 4 && socket.is_none() {
            self.shared.telemetry.protocol_error();
            self.close(DisconnectReason::ForcedServerClose);
            return;
        }
        let amount = head.data.map_or(0, codec::parsed_size_bound);
        let options = &self.shared.options;
        let own = match &socket {
            Some(socket) => socket.inbound_budget(),
            None => Arc::clone(&self.inbound),
        };
        let Some(charge) = Charge::take(
            amount,
            &self.shared.inbound_bytes,
            options.max_inbound_total,
            Some((&own, options.max_inbound_bytes)),
        ) else {
            self.shared.telemetry.inbound_overflow();
            self.close(DisconnectReason::InboundOverflow);
            return;
        };
        let packet = head
            .data
            .map(codec::parse_json)
            .transpose()
            .and_then(|data| codec::decode_body(head, data));
        let Ok(codec::Packet { nsp, kind }) = packet else {
            self.shared.telemetry.protocol_error();
            self.close(DisconnectReason::ForcedClose);
            return;
        };
        let socket = match (kind, socket) {
            (Kind::Connect(auth), _) => return self.on_connect_packet(nsp, auth, charge),
            (Kind::ConnectError, _) | (_, None) => {
                // `invalid state`: a client does not send CONNECT_ERROR.
                self.shared.telemetry.protocol_error();
                self.close(DisconnectReason::ForcedServerClose);
                return;
            }
            (kind, Some(socket)) => (kind, socket),
        };
        match socket {
            (Kind::Event { name, args, ack }, socket) => {
                if !socket.deliver(name, args, ack, charge) {
                    self.close(DisconnectReason::InboundOverflow);
                }
            }
            (Kind::Ack { id, args }, socket) => socket.resolve_ack(id, args, charge),
            (Kind::Disconnect, socket) => {
                socket.leave(DisconnectReason::ClientNamespaceDisconnect);
            }
            (Kind::Ignored | Kind::Connect(_) | Kind::ConnectError, _) => {}
        }
    }

    /// A binary Engine.IO message: refused.
    pub fn on_binary(&self) {
        self.shared.telemetry.protocol_error();
        self.close(DisconnectReason::ForcedClose);
    }

    /// CONNECT (`Client.connect`): admission, then the namespace's own flow.
    fn on_connect_packet(self: &Arc<Self>, nsp: String, auth: Map<String, Value>, charge: Charge) {
        if self.shared.stopping() {
            return;
        }
        let options = &self.shared.options;
        let refusal = {
            let state = self.state();
            if state.entries.contains_key(&nsp) {
                drop(state);
                // A second CONNECT while the first is joined or still checking.
                self.shared.telemetry.protocol_error();
                self.close(DisconnectReason::ForcedServerClose);
                return;
            }
            if state.entries.len() >= options.max_namespaces_per_connection {
                Some(Refusal::TooManyOnConnection)
            } else if nsp.len() > options.max_namespace_name {
                Some(Refusal::NameTooLong)
            } else {
                None
            }
        };
        if let Some(refusal) = refusal {
            return self.refuse(&nsp, refusal);
        }
        let Some(def) = self.registry.lookup(&nsp) else {
            return self.refuse(&nsp, Refusal::InvalidNamespace);
        };
        let ticket = Ticket {
            id: self.shared.next_key(),
            cancel: CancellationToken::new(),
        };
        {
            let mut state = self.state();
            if self.is_closed() || state.entries.contains_key(&nsp) {
                return;
            }
            state
                .entries
                .insert(nsp.clone(), Entry::Pending(ticket.clone()));
        }
        if let Err(refusal) = def.admit(self, &nsp, auth, charge, ticket.clone()) {
            self.remove_pending(&nsp, &ticket);
            self.refuse(&nsp, refusal);
        }
    }

    /// `Invalid namespace` (every admission refusal reads the same to the client).
    fn refuse(&self, nsp: &str, refusal: Refusal) {
        self.shared.telemetry.connect_refused(nsp, refusal);
        self.push_control(codec::encode_connect_error(nsp, "Invalid namespace", None));
    }

    // ----- membership ----------------------------------------------------------------------

    /// Turns a pending entry into a joined one; `false` when the attempt was cancelled or the
    /// connection closed meanwhile.
    pub fn join(&self, nsp: &str, ticket: &Ticket, socket: Arc<dyn ErasedSocket>) -> bool {
        let mut state = self.state();
        if self.is_closed() {
            return false;
        }
        match state.entries.get(nsp) {
            Some(Entry::Pending(current)) if current.id == ticket.id => {
                state.entries.insert(nsp.to_owned(), Entry::Joined(socket));
                true
            }
            _ => false,
        }
    }

    pub fn remove_pending(&self, nsp: &str, ticket: &Ticket) {
        let mut state = self.state();
        if matches!(state.entries.get(nsp), Some(Entry::Pending(current)) if current.id == ticket.id)
        {
            state.entries.remove(nsp);
        }
    }

    /// Removes a joined entry, if it is still this socket.
    pub fn remove_joined(&self, nsp: &str, key: u64) {
        let mut state = self.state();
        if matches!(state.entries.get(nsp), Some(Entry::Joined(socket)) if socket.queue().0 == key)
        {
            state.entries.remove(nsp);
        }
    }

    /// The first socket joined: the connect timeout is over.
    pub fn mark_joined(&self) {
        self.state().joined = true;
    }

    fn joined(&self) -> bool {
        self.state().joined
    }

    // ----- outbound ------------------------------------------------------------------------

    /// Hands a packet to the transport under the queue bounds.
    pub fn push(&self, outgoing: Outgoing<'_>) -> Result<(), NotSent> {
        if self.is_closed() {
            return Err(NotSent::Closed);
        }
        let Some(engine) = self.engine() else {
            return Err(NotSent::Closed);
        };
        self.outbox().push(
            engine.as_ref(),
            outgoing,
            &self.shared.outbound_bytes,
            self.shared.options.max_outbound_total,
        )
    }

    /// A packet that belongs to no socket (CONNECT_ERROR). A client that never reads them is a
    /// slow consumer.
    pub fn push_control(&self, packet: String) {
        let pushed = self.push(Outgoing {
            socket: None,
            packet,
            delivery: &Delivery::Reliable,
        });
        if pushed == Err(NotSent::SlowConsumer) {
            self.close_soon(DisconnectReason::SlowConsumer);
        }
    }

    /// Sends a packet that must not be lost and may wait for room (missed events of a restore).
    /// `false` when the connection closed or the attempt was cancelled first.
    pub async fn push_waiting(
        &self,
        key: u64,
        limits: crate::config::QueueLimits,
        packet: String,
        ticket: &Ticket,
    ) -> bool {
        loop {
            let pushed = self.push(Outgoing {
                socket: Some((key, limits)),
                packet: packet.clone(),
                delivery: &Delivery::Reliable,
            });
            match pushed {
                Ok(()) => return true,
                Err(NotSent::SlowConsumer) => {
                    let drained = self.drained.notified();
                    tokio::select! {
                        () = self.closed.cancelled() => return false,
                        () = ticket.cancel.cancelled() => return false,
                        () = drained => {}
                        () = tokio::time::sleep(TICK) => {}
                    }
                }
                Err(_) => return false,
            }
        }
    }

    /// A socket of this connection is created: its packets may be sent from now on.
    pub fn open_socket(&self, key: u64) {
        self.outbox().open_socket(key);
    }

    /// The socket has left: its slots are dropped, its entry goes with its last packet.
    pub fn forget_socket(&self, key: u64) {
        self.outbox()
            .forget_socket(key, &self.shared.outbound_bytes);
        self.drained.notify_waiters();
    }

    /// How many messages the transport has finished (everything, once the session is gone).
    fn done(&self) -> u64 {
        self.engine()
            .map_or(u64::MAX, |engine| engine.messages_done())
    }

    /// Whether packets still wait for the client.
    pub fn has_queued(&self) -> bool {
        let done = self.done();
        let mut outbox = self.outbox();
        outbox.sweep(done, &self.shared.outbound_bytes);
        outbox.busy()
    }

    fn sweep_and_flush(&self) {
        let done = self.done();
        let released = {
            let mut outbox = self.outbox();
            let released = outbox.sweep(done, &self.shared.outbound_bytes);
            if outbox.has_waiting()
                && let Some(engine) = self.engine()
            {
                outbox.flush_waiting(engine.as_ref(), &self.shared.outbound_bytes);
            }
            released
        };
        if released > 0 {
            self.drained.notify_waiters();
        }
    }

    // ----- closing -------------------------------------------------------------------------

    /// Every joined socket leaves with `reason`; pending attempts are cancelled. The connection
    /// stays open.
    pub fn leave_all(&self, reason: DisconnectReason) {
        let entries: Vec<Entry> = self
            .state()
            .entries
            .drain()
            .map(|(_, entry)| entry)
            .collect();
        for entry in entries {
            match entry {
                Entry::Pending(ticket) => ticket.cancel.cancel(),
                Entry::Joined(socket) => socket.leave(reason),
            }
        }
    }

    /// `socket.disconnect(true)`: DISCONNECT to every joined namespace, then close.
    pub fn disconnect_all(&self) {
        let joined: Vec<Arc<dyn ErasedSocket>> = self
            .state()
            .entries
            .values()
            .filter_map(|entry| match entry {
                Entry::Joined(socket) => Some(Arc::clone(socket)),
                Entry::Pending(_) => None,
            })
            .collect();
        for socket in joined {
            socket.disconnect();
        }
        // Called from a handler, which may hold its data's lock: a socket still joined (its
        // DISCONNECT did not fit) is measured for its session when it leaves, which takes that
        // lock, so the close runs on the connection's task.
        self.close_soon(DisconnectReason::ForcedServerClose);
    }

    /// Closes the connection (`Client.close`): every socket leaves with `reason` and inbound
    /// packets are ignored from now on. As in `engine.io`, what is queued still reaches the
    /// client, then the close packet (on the next poll for a polling client), within
    /// `close_timeout`; a transport error, a slow consumer and a shutdown close at once. A
    /// session that has not ended `close_timeout` after that has its socket aborted. The first
    /// reason wins.
    pub fn close(&self, reason: DisconnectReason) {
        if self.reason.set(reason).is_err() {
            return;
        }
        self.closed.cancel();
        self.leave_all(reason);
        // A transport error ends the session at once in `engine.io` (`onError`); so do a slow
        // consumer and a shutdown here.
        if matches!(
            reason,
            DisconnectReason::SlowConsumer
                | DisconnectReason::ServerShuttingDown
                | DisconnectReason::TransportError
        ) {
            self.close_engine();
        }
        // Otherwise the connection's task drains, then closes.
    }

    fn close_engine(&self) {
        self.engine_closing
            .store(true, std::sync::atomic::Ordering::Release);
        if let Some(engine) = self.engine() {
            engine.close(engineioxide::DisconnectReason::TransportClose);
        }
    }

    /// Fails the upgraded socket's I/O (`UpgradeGuard::abort`): the WebSocket writer of
    /// `engineioxide` does not notice a closed session while a write to a peer that stopped
    /// reading is pending, and holds the session until that write fails.
    fn abort_transport(&self) {
        if let Some(guard) = self.state().guard.take() {
            guard.abort();
        }
    }

    /// `engineioxide` reports the session closed (by the client, the transport, the heartbeat,
    /// or after [`Connection::close`]).
    pub fn on_engine_closed(&self, reason: &engineioxide::DisconnectReason) {
        self.gone.cancel();
        let reason = match self.reason.set(engine_reason(reason)) {
            Ok(()) => {
                self.closed.cancel();
                let reason = engine_reason(reason);
                self.leave_all(reason);
                reason
            }
            Err(_) => self
                .reason
                .get()
                .copied()
                .unwrap_or(DisconnectReason::TransportClose),
        };
        self.outbox().clear(&self.shared.outbound_bytes);
        // The upgrade guard stays until the connection's task has seen the transport's tasks
        // end: it is what aborts a writer stuck on a peer that stopped reading.
        self.slot
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .take();
        self.engine
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .take();
        self.drained.notify_waiters();
        self.shared.telemetry.connection_closed(reason);
    }

    /// [`Connection::close`] from a path that may hold store or member locks (closing makes
    /// sockets leave, which takes them): the connection's task closes it right after.
    pub fn close_soon(&self, reason: DisconnectReason) {
        if self.close_requested.set(reason).is_ok() {
            self.poke.notify_one();
        }
    }

    /// The deferred part of [`Connection::close`].
    async fn drain_then_close(&self) {
        let deadline = tokio::time::sleep(self.shared.options.close_timeout);
        tokio::pin!(deadline);
        loop {
            self.sweep_and_flush();
            let drained = self.outbox().queued() == 0;
            let deliverable = self.transport() == "websocket"
                || self.polls.load(std::sync::atomic::Ordering::Acquire) > 0;
            if drained && deliverable {
                break;
            }
            tokio::select! {
                () = self.gone.cancelled() => return,
                () = self.shared.hard_stop.cancelled() => break,
                () = &mut deadline => break,
                () = tokio::time::sleep(Duration::from_millis(10)) => {}
            }
        }
        self.close_engine();
    }

    /// The connection's own task: the connect timeout, and releasing output as the transport
    /// finishes it (woken by its count of finished messages).
    pub async fn run(self: Arc<Self>) {
        let timeout = tokio::time::sleep(self.shared.options.connect_timeout);
        tokio::pin!(timeout);
        let mut waiting_for_join = true;
        // Kept until the session's transport tasks have ended (see the end).
        let engine = self.engine();
        let mut finished = engine.as_ref().map(|engine| engine.watch_messages_done());
        loop {
            let progress = async {
                match finished.as_mut() {
                    Some(finished) => finished.changed().await.is_ok(),
                    None => std::future::pending().await,
                }
            };
            tokio::select! {
                biased;
                () = self.closed.cancelled() => break,
                () = &mut timeout, if waiting_for_join => {
                    waiting_for_join = false;
                    if !self.joined() {
                        self.close(DisconnectReason::ForcedServerClose);
                    }
                }
                () = self.poke.notified() => {
                    if let Some(reason) = self.close_requested.get() {
                        self.close(*reason);
                    }
                }
                alive = progress => {
                    if alive {
                        self.sweep_and_flush();
                    } else {
                        finished = None;
                    }
                }
            }
        }
        if !self.gone.is_cancelled() {
            if !self
                .engine_closing
                .load(std::sync::atomic::Ordering::Acquire)
            {
                self.drain_then_close().await;
            }
            // The session must end within the close timeout.
            tokio::select! {
                () = self.gone.cancelled() => {}
                () = tokio::time::sleep(self.shared.options.close_timeout) => self.abort_transport(),
                () = self.shared.hard_stop.cancelled() => self.abort_transport(),
            }
        }
        // The session has ended; its transport tasks (a writer flushing to a peer that stopped
        // reading, the close task) end with it, within the close timeout, or at once when a
        // shutdown's hard stop aborts the upgraded socket. This task, which the shutdown waits
        // for, ends only after them.
        if let Some(engine) = engine {
            let ended = engine.tasks_ended();
            tokio::pin!(ended);
            tokio::select! {
                biased;
                () = &mut ended => {}
                () = tokio::time::sleep(self.shared.options.close_timeout) => {
                    self.abort_transport();
                    (&mut ended).await;
                }
                () = self.shared.hard_stop.cancelled() => {
                    self.abort_transport();
                    (&mut ended).await;
                }
            }
        }
        self.state().guard = None;
    }
}
