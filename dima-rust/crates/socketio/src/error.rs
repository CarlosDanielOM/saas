//! Errors and disconnect reasons.

use serde_json::Value;

/// Refusal of a connect, sent as the CONNECT_ERROR the JavaScript client turns into
/// `err.message` and `err.data` (`next(err)` with `err.data` in a reference middleware).
#[derive(Debug, Clone, PartialEq)]
pub struct ConnectError {
    /// `err.message`.
    pub message: String,
    /// `err.data`; absent when `None`, as `undefined` is dropped by `JSON.stringify`.
    pub data: Option<Value>,
}

impl ConnectError {
    /// A refusal with a message only.
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            data: None,
        }
    }

    /// Adds `err.data`.
    #[must_use]
    pub fn with_data(mut self, data: Value) -> Self {
        self.data = Some(data);
        self
    }
}

/// Why an emit did not reach the client.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum SendError {
    /// The event name is reserved (`connect`, `connect_error`, `disconnect`, `disconnecting`,
    /// `newListener`, `removeListener`): the reference throws.
    #[error("reserved event name")]
    Reserved,
    /// The socket is not connected. With full recovery the event was still stored for a client
    /// that comes back.
    #[error("socket is disconnected")]
    Disconnected,
    /// The encoded packet is larger than `max_outbound_message`.
    #[error("packet too large")]
    TooLarge,
    /// The socket's queue was full: the connection was closed as a slow consumer.
    #[error("slow consumer disconnected")]
    SlowConsumer,
    /// A lossy event was dropped because the socket's queue was full.
    #[error("dropped")]
    Dropped,
    /// Too many distinct replaceable keys are waiting on this socket.
    #[error("too many pending replaceable keys")]
    TooManyKeys,
    /// The name is not covered by the namespace declaration it was sent through.
    #[error("namespace not covered by this declaration")]
    UnknownNamespace,
}

/// Why `emit_with_ack` did not produce an answer.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum AckError {
    /// No answer before the deadline (`operation has timed out` in the reference).
    #[error("operation has timed out")]
    Timeout,
    /// The socket disconnected first.
    #[error("socket disconnected")]
    Disconnected,
    /// `max_pending_acks` answers are already awaited on this socket.
    #[error("too many pending acknowledgements")]
    TooMany,
    /// The event could not be sent.
    #[error("send failed: {0}")]
    Send(SendError),
}

/// Why a socket left its namespace: the reference's reason strings, plus two for this crate's
/// own bounds.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum DisconnectReason {
    /// `transport close`: the client closed the connection.
    TransportClose,
    /// `transport error`: the connection failed (also two overlapping polls, a WebSocket message
    /// beyond the size limit).
    TransportError,
    /// `ping timeout`: no answer to a heartbeat.
    PingTimeout,
    /// `parse error`: an Engine.IO packet could not be decoded.
    ParseError,
    /// `forced close`: the server closed the connection after a packet it could not decode.
    ForcedClose,
    /// `forced server close`: the server closed the connection (no namespace joined in time, a
    /// packet in the wrong state, `disconnect(true)` on another socket of the connection).
    ForcedServerClose,
    /// `server shutting down`.
    ServerShuttingDown,
    /// `client namespace disconnect`: the client left the namespace (`socket.disconnect()`).
    ClientNamespaceDisconnect,
    /// `server namespace disconnect`: the server removed the socket ([`crate::Socket::disconnect`]).
    ServerNamespaceDisconnect,
    /// `slow consumer`: a reliable packet did not fit the socket's send queue (this crate's
    /// bound; recoverable, so the client gets what it missed when it comes back).
    SlowConsumer,
    /// `inbound overflow`: the client sent more events than its handlers could take (this
    /// crate's bound; not recoverable).
    InboundOverflow,
}

impl DisconnectReason {
    /// The reason as the reference names it.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::TransportClose => "transport close",
            Self::TransportError => "transport error",
            Self::PingTimeout => "ping timeout",
            Self::ParseError => "parse error",
            Self::ForcedClose => "forced close",
            Self::ForcedServerClose => "forced server close",
            Self::ServerShuttingDown => "server shutting down",
            Self::ClientNamespaceDisconnect => "client namespace disconnect",
            Self::ServerNamespaceDisconnect => "server namespace disconnect",
            Self::SlowConsumer => "slow consumer",
            Self::InboundOverflow => "inbound overflow",
        }
    }

    /// Whether the session is kept for recovery (`RECOVERABLE_DISCONNECT_REASONS` of
    /// `socket.io` 4.8.3, plus a slow consumer).
    pub fn recoverable(self) -> bool {
        matches!(
            self,
            Self::TransportError
                | Self::TransportClose
                | Self::ForcedClose
                | Self::PingTimeout
                | Self::ServerShuttingDown
                | Self::ForcedServerClose
                | Self::SlowConsumer
        )
    }
}

impl std::fmt::Display for DisconnectReason {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// A namespace declaration the builder refused.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum BuildError {
    /// The static name is already declared.
    #[error("namespace {0:?} declared twice")]
    Duplicate(String),
    /// A static name must start with `/`.
    #[error("namespace {0:?} does not start with /")]
    BadName(String),
    /// The family pattern is not supported.
    #[error(transparent)]
    Pattern(#[from] crate::PatternError),
}
