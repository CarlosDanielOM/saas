//! The telemetry seam: what the protocol layer reports. The API binary connects it to
//! `dima-telemetry`; this crate does not depend on it.
//!
//! Every method has an empty default and is called synchronously on the path that observed the
//! event, often with locks held: an implementation must only bump counters or push into a
//! bounded queue, never block or call back into the server.

use crate::DisconnectReason;

/// Why a connect to a namespace was refused.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Refusal {
    /// No static namespace or family has this name (`Invalid namespace`).
    InvalidNamespace,
    /// The name is longer than `max_namespace_name`.
    NameTooLong,
    /// The connection already uses `max_namespaces_per_connection` namespaces.
    TooManyOnConnection,
    /// `max_namespaces` concrete namespaces exist.
    TooManyNamespaces,
    /// The namespace has `max_sockets_per_namespace` sockets joined or joining.
    NamespaceFull,
    /// The namespace's check refused it (a CONNECT_ERROR with the check's message).
    Check,
    /// The check panicked (a CONNECT_ERROR `Internal server error`).
    CheckPanicked,
}

/// What happened to an emit that did not go out normally.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum SendOutcome {
    /// A lossy event dropped on a full queue.
    Dropped,
    /// A replaceable event waiting for room.
    Deferred,
    /// A waiting replaceable event replaced by a newer one.
    Replaced,
    /// A reliable event on a full queue: the connection was closed.
    SlowConsumer,
    /// Refused: larger than `max_outbound_message`.
    TooLarge,
}

/// The result of a recovery attempt (a client sending its private id and last offset).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum RecoveryOutcome {
    /// Session and offset found: socket restored.
    Recovered,
    /// No session for that private id (never kept, expired and swept, evicted, or already
    /// claimed).
    UnknownSession,
    /// The session is older than `recovery_max_disconnection`.
    Expired,
    /// The offset is no longer (or never was) stored.
    UnknownOffset,
    /// Packets were evicted while the missed ones were being sent: the connection was closed.
    Gap,
    /// An event after the client's offset could not be stored (too large): the replay would
    /// miss it, so the client connects fresh.
    Discontinuity,
}

/// Something the stores had to drop to stay within their bounds.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Eviction {
    /// A stored packet, to make room.
    Packet,
    /// A kept session, to make room.
    Session,
    /// A session larger than `session_bytes`, not kept.
    SessionTooLarge,
    /// An event too large to store: delivered live, and earlier offsets of its namespace can
    /// no longer be recovered.
    NotStored,
}

/// A kind of handler.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Handler {
    /// `on_connect`.
    Connect,
    /// `on_event`.
    Event,
    /// `on_disconnect`.
    Disconnect,
}

/// The seam. All methods default to doing nothing.
pub trait Telemetry: Send + Sync + 'static {
    /// An Engine.IO connection opened.
    fn connection_opened(&self) {}
    /// An Engine.IO connection closed.
    fn connection_closed(&self, _reason: DisconnectReason) {}
    /// A handshake was refused because `max_connections` connections are open.
    fn connection_refused(&self) {}
    /// A socket joined a namespace (`namespace` is the concrete name).
    fn socket_connected(&self, _namespace: &str, _recovered: bool) {}
    /// A socket left its namespace.
    fn socket_disconnected(&self, _namespace: &str, _reason: DisconnectReason) {}
    /// A connect was refused.
    fn connect_refused(&self, _namespace: &str, _refusal: Refusal) {}
    /// An emit did not go out normally.
    fn send(&self, _namespace: &str, _outcome: SendOutcome) {}
    /// A recovery attempt finished.
    fn recovery(&self, _namespace: &str, _outcome: RecoveryOutcome) {}
    /// A recovery store dropped something.
    fn recovery_evicted(&self, _namespace: &str, _what: Eviction) {}
    /// A client sent a packet that closed its connection (malformed, binary, wrong state).
    fn protocol_error(&self) {}
    /// A client packet did not fit the inbound budgets: its connection was closed.
    fn inbound_overflow(&self) {}
    /// A handler (check, connect, event, disconnect) panicked; the panic was contained.
    fn handler_panicked(&self, _namespace: &str) {}
    /// A handler ran past its deadline and was dropped.
    fn handler_timed_out(&self, _namespace: &str, _handler: Handler) {}
}

/// Reports nothing.
#[derive(Debug, Clone, Copy, Default)]
pub struct NoTelemetry;

impl Telemetry for NoTelemetry {}
