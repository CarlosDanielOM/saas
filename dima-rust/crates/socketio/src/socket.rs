//! One client socket in one namespace (`socket` in the reference's handlers).

use std::collections::HashMap;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex, OnceLock, PoisonError};
use std::time::Duration;

use serde_json::Value;
use tokio::sync::{mpsc, oneshot};
use tokio_util::sync::CancellationToken;

use crate::codec;
use crate::config::{QueueLimits, Recovery};
use crate::connection::Connection;
use crate::error::{AckError, DisconnectReason, SendError};
use crate::handshake::Handshake;
use crate::namespace::DefOps;
use crate::outbox::{Delivery, NotSent, Outgoing};

/// An event from the client, as a reference listener receives it: the name, the arguments and,
/// when the client called `emit` with a callback (or `emitWithAck`), the acknowledgement.
#[derive(Debug)]
pub struct Event {
    /// The event name.
    pub name: String,
    /// The arguments after the name.
    pub args: Vec<Value>,
    ack: Option<Ack>,
}

impl Event {
    pub(crate) fn new(name: String, args: Vec<Value>, ack: Option<Ack>) -> Self {
        Self { name, args, ack }
    }

    /// Whether the client waits for an acknowledgement.
    pub fn wants_ack(&self) -> bool {
        self.ack.is_some()
    }

    /// Takes the acknowledgement (the reference's last-argument callback). Dropping it without
    /// sending leaves the client waiting, as a callback that is never called does.
    pub fn take_ack(&mut self) -> Option<Ack> {
        self.ack.take()
    }
}

/// The answer to one client event. Sending consumes it, so it is sent at most once (the
/// reference ignores a second call).
pub struct Ack {
    id: u64,
    socket: Arc<dyn AckSink>,
}

impl std::fmt::Debug for Ack {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Ack").field("id", &self.id).finish()
    }
}

impl Ack {
    pub(crate) fn new(id: u64, socket: Arc<dyn AckSink>) -> Self {
        Self { id, socket }
    }

    /// `ack(...args)`.
    pub fn send(self, args: &[Value]) -> Result<(), SendError> {
        self.socket.send_ack(self.id, args)
    }
}

/// What an [`Ack`] needs from its socket.
pub(crate) trait AckSink: Send + Sync {
    fn send_ack(&self, id: u64, args: &[Value]) -> Result<(), SendError>;
}

/// The socket as the connection sees it, whatever its data type.
pub(crate) trait ErasedSocket: Send + Sync {
    /// Queues a client event for the handler; `false` when the inbound queue is full.
    fn deliver(&self, name: String, args: Vec<Value>, ack: Option<u64>) -> bool;
    /// An ACK from the client.
    fn resolve_ack(&self, id: u64, args: Vec<Value>);
    /// The socket leaves its namespace (`_onclose(reason)`): idempotent.
    fn leave(&self, reason: DisconnectReason);
    /// A server namespace disconnect: DISCONNECT packet, then leave.
    fn disconnect(&self);
    /// Its key in the connection's send accounting and its queue limits.
    fn queue(&self) -> (u64, QueueLimits);
}

pub(crate) struct SocketState {
    pub connected: bool,
    next_ack: u64,
    acks: HashMap<u64, oneshot::Sender<Result<Vec<Value>, AckError>>>,
}

/// The shared part of a socket.
pub(crate) struct Core<D> {
    pub key: u64,
    pub id: String,
    pub pid: String,
    pub nsp: String,
    pub recovered: bool,
    pub handshake: Handshake,
    pub data: Arc<D>,
    pub conn: Arc<Connection>,
    pub def: Arc<dyn DefOps<D>>,
    pub state: Mutex<SocketState>,
    /// Fires when the socket has left its namespace.
    pub closed: CancellationToken,
    pub reason: OnceLock<DisconnectReason>,
    /// Set once the socket is registered and its CONNECT packet went out.
    pub joined: AtomicBool,
    pub inbound: mpsc::Sender<Event>,
    pub me: OnceLock<std::sync::Weak<Core<D>>>,
}

impl<D> Core<D> {
    pub fn lock(&self) -> std::sync::MutexGuard<'_, SocketState> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    pub fn new_state() -> Mutex<SocketState> {
        Mutex::new(SocketState {
            connected: true,
            next_ack: 0,
            acks: HashMap::new(),
        })
    }

    pub fn is_connected(&self) -> bool {
        self.lock().connected
    }

    /// Sends one packet of this socket through the connection, applying the slow-consumer
    /// policy.
    pub fn push(&self, packet: String, delivery: &Delivery) -> Result<(), SendError> {
        if !self.is_connected() {
            return Err(SendError::Disconnected);
        }
        let outcome = self.conn.push(Outgoing {
            socket: Some((self.key, self.def.queue())),
            packet,
            delivery,
        });
        match outcome {
            Ok(()) => Ok(()),
            Err(not_sent) => {
                if let Some(outcome) = not_sent.outcome() {
                    self.def.shared().telemetry.send(&self.nsp, outcome);
                }
                match not_sent {
                    NotSent::SlowConsumer => {
                        // Locks of the store or the namespace may be held here.
                        self.conn.close_soon(DisconnectReason::SlowConsumer);
                        Err(SendError::SlowConsumer)
                    }
                    NotSent::Dropped => Err(SendError::Dropped),
                    NotSent::Deferred { .. } => Ok(()),
                    NotSent::TooManyKeys => Err(SendError::TooManyKeys),
                    NotSent::Closed => Err(SendError::Disconnected),
                }
            }
        }
    }

    /// Fails every awaited acknowledgement.
    pub fn fail_acks(&self) {
        let acks: Vec<_> = self.lock().acks.drain().map(|(_, tx)| tx).collect();
        for tx in acks {
            let _ = tx.send(Err(AckError::Disconnected));
        }
    }
}

impl<D: Send + Sync + 'static> AckSink for Core<D> {
    fn send_ack(&self, id: u64, args: &[Value]) -> Result<(), SendError> {
        let packet = codec::encode_ack(&self.nsp, id, args);
        if packet.len() > self.def.shared().options.max_outbound_message {
            self.def
                .shared()
                .telemetry
                .send(&self.nsp, crate::telemetry::SendOutcome::TooLarge);
            return Err(SendError::TooLarge);
        }
        self.push(packet, &Delivery::Reliable)
    }
}

impl<D: Send + Sync + 'static> ErasedSocket for Core<D> {
    fn deliver(&self, name: String, args: Vec<Value>, ack: Option<u64>) -> bool {
        let ack = ack.and_then(|id| {
            let me = self.me.get()?.upgrade()?;
            Some(Ack::new(id, me))
        });
        match self.inbound.try_send(Event::new(name, args, ack)) {
            Ok(()) => true,
            // Closed: the socket's task is gone; the reference ignores packets after
            // disconnection too.
            Err(mpsc::error::TrySendError::Closed(_)) => true,
            Err(mpsc::error::TrySendError::Full(_)) => false,
        }
    }

    fn resolve_ack(&self, id: u64, args: Vec<Value>) {
        let waiting = self.lock().acks.remove(&id);
        if let Some(tx) = waiting {
            let _ = tx.send(Ok(args));
        }
    }

    fn leave(&self, reason: DisconnectReason) {
        {
            let mut state = self.lock();
            if !state.connected {
                return;
            }
            state.connected = false;
        }
        let _ = self.reason.set(reason);
        self.def.leave(self, reason);
        self.fail_acks();
        self.conn.remove_joined(&self.nsp, self.key);
        self.conn.forget_socket(self.key);
        self.closed.cancel();
    }

    fn disconnect(&self) {
        // A DISCONNECT that does not fit closes the connection as a slow consumer instead.
        if self
            .push(codec::encode_disconnect(&self.nsp), &Delivery::Reliable)
            .is_ok()
        {
            self.leave(DisconnectReason::ServerNamespaceDisconnect);
        }
    }

    fn queue(&self) -> (u64, QueueLimits) {
        (self.key, self.def.queue())
    }
}

/// A client socket in a namespace. Clones share the socket.
pub struct Socket<D> {
    pub(crate) core: Arc<Core<D>>,
}

impl<D> Clone for Socket<D> {
    fn clone(&self) -> Self {
        Self {
            core: Arc::clone(&self.core),
        }
    }
}

impl<D> std::fmt::Debug for Socket<D> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Socket")
            .field("id", &self.core.id)
            .field("nsp", &self.core.nsp)
            .field("recovered", &self.core.recovered)
            .finish_non_exhaustive()
    }
}

impl<D: Send + Sync + 'static> Socket<D> {
    /// `socket.id`: kept across a recovery.
    pub fn id(&self) -> &str {
        &self.core.id
    }

    /// `socket.nsp.name`: the concrete namespace (`/clip/123`).
    pub fn namespace(&self) -> &str {
        &self.core.nsp
    }

    /// `socket.handshake`.
    pub fn handshake(&self) -> &Handshake {
        &self.core.handshake
    }

    /// `socket.data`: what the namespace check returned, or what the recovered session kept.
    pub fn data(&self) -> &Arc<D> {
        &self.core.data
    }

    /// `socket.recovered`.
    pub fn recovered(&self) -> bool {
        self.core.recovered
    }

    /// `socket.connected`.
    pub fn connected(&self) -> bool {
        self.core.is_connected()
    }

    /// Why the socket left, once it has.
    pub fn disconnect_reason(&self) -> Option<DisconnectReason> {
        self.core.reason.get().copied()
    }

    /// Resolves when the socket has left its namespace.
    pub async fn closed(&self) {
        self.core.closed.cancelled().await;
    }

    /// `socket.emit(event, ...args)`, reliable.
    pub fn emit(&self, event: &str, args: &[Value]) -> Result<(), SendError> {
        self.emit_with(&Delivery::Reliable, event, args)
    }

    /// `socket.emit(event, ...args)` with a delivery policy for a full send queue.
    ///
    /// In a namespace with full recovery the event gets an offset and is stored, also when the
    /// socket has already disconnected: a client that recovers this socket receives it (as in
    /// the reference, where `socket.emit` goes through the adapter). The result is then
    /// [`SendError::Disconnected`], though the event is kept.
    pub fn emit_with(
        &self,
        delivery: &Delivery,
        event: &str,
        args: &[Value],
    ) -> Result<(), SendError> {
        if codec::RESERVED_EVENTS.contains(&event) {
            return Err(SendError::Reserved);
        }
        let core = &self.core;
        let shared = core.def.shared();
        let recovery = core.def.recovery();
        let offset =
            (recovery != Recovery::Off).then(|| shared.offsets.next(shared.clock.as_ref()));
        let json = codec::array_json(Some(event), args, offset.as_deref());
        let packet = codec::encode_event(&core.nsp, None, &json);
        if packet.len() > shared.options.max_outbound_message {
            shared
                .telemetry
                .send(&core.nsp, crate::telemetry::SendOutcome::TooLarge);
            return Err(SendError::TooLarge);
        }
        match (recovery, offset) {
            (Recovery::Full, Some(offset)) => core.def.store_and_send(
                &core.nsp,
                Some(&core.id),
                &offset,
                Arc::from(json.as_str()),
                &mut || core.push(packet.clone(), delivery),
            ),
            _ => core.push(packet, delivery),
        }
    }

    /// `socket.timeout(timeout).emitWithAck(event, ...args)`: the client's answer, or why there
    /// is none. Never stored for recovery and never given an offset (the reference skips events
    /// with an acknowledgement id).
    pub async fn emit_with_ack(
        &self,
        event: &str,
        args: &[Value],
        timeout: Duration,
    ) -> Result<Vec<Value>, AckError> {
        if codec::RESERVED_EVENTS.contains(&event) {
            return Err(AckError::Send(SendError::Reserved));
        }
        let core = &self.core;
        let max = core.def.shared().options.max_pending_acks;
        let (tx, rx) = oneshot::channel();
        let id = {
            let mut state = core.lock();
            if !state.connected {
                return Err(AckError::Disconnected);
            }
            if state.acks.len() >= max {
                return Err(AckError::TooMany);
            }
            let id = state.next_ack;
            state.next_ack += 1;
            state.acks.insert(id, tx);
            id
        };
        let packet = codec::encode_event(
            &core.nsp,
            Some(id),
            &codec::array_json(Some(event), args, None),
        );
        let sent = if packet.len() > core.def.shared().options.max_outbound_message {
            Err(SendError::TooLarge)
        } else {
            core.push(packet, &Delivery::Reliable)
        };
        if let Err(error) = sent {
            core.lock().acks.remove(&id);
            return Err(AckError::Send(error));
        }
        match tokio::time::timeout(timeout, rx).await {
            Ok(Ok(answer)) => answer,
            Ok(Err(_)) => Err(AckError::Disconnected),
            Err(_) => {
                core.lock().acks.remove(&id);
                Err(AckError::Timeout)
            }
        }
    }

    /// `socket.disconnect()`: sends DISCONNECT (the client sees `io server disconnect` and does
    /// not reconnect) and leaves with `server namespace disconnect`. No session is kept.
    pub fn disconnect(&self) {
        ErasedSocket::disconnect(self.core.as_ref());
    }

    /// `socket.disconnect(true)`: every socket of this connection is disconnected as above, then
    /// the connection is closed.
    pub fn disconnect_connection(&self) {
        self.core.conn.disconnect_all();
    }
}
