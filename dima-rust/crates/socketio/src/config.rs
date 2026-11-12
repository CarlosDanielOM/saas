//! Every timing and limit, with the reference's value where it has one.
//!
//! The Engine.IO and Socket.IO values are the effective configuration of the reference
//! (`server/websocket.ts:47`: `new Server(httpServer, { connectionStateRecovery: {}, adapter,
//! destroyUpgrade: false })`, everything else the defaults of `engine.io` 6.6.9 and `socket.io`
//! 4.8.3). The bounds below them have no counterpart in the reference, which has none; their
//! defaults are the starting values of `ledger/socketio.md`, section 3.

use std::time::Duration;

/// Server-wide settings. `Options::default()` is the reference configuration.
#[derive(Debug, Clone)]
pub struct Options {
    /// Engine.IO `pingInterval`: 25 s.
    pub ping_interval: Duration,
    /// Engine.IO `pingTimeout`: 20 s.
    pub ping_timeout: Duration,
    /// Engine.IO `upgradeTimeout`: 10 s for a polling session to finish its WebSocket upgrade.
    pub upgrade_timeout: Duration,
    /// Engine.IO `maxHttpBufferSize`: 1,000,000 bytes, the largest polling request body and the
    /// largest WebSocket message a client may send (bytes on the wire, as Node counts them with
    /// `Buffer.byteLength` and `ws`'s `maxPayload`).
    pub max_http_buffer_size: u64,
    /// Engine.IO `httpCompression.threshold`: polling responses of at least 1024 bytes are
    /// compressed with gzip or deflate when the client accepts it.
    pub http_compression_threshold: usize,
    /// Socket.IO `connectTimeout`: 45 s for a new connection to join its first namespace before
    /// it is closed.
    pub connect_timeout: Duration,
    /// `connectionStateRecovery.maxDisconnectionDuration`: 2 minutes.
    pub recovery_max_disconnection: Duration,
    /// How often the reference's recovery adapter drops expired sessions and packets: every 60 s
    /// from the namespace's creation (a timer in `SessionAwareAdapter`). Expiry here follows the
    /// same schedule, so a packet stays retrievable until the first sweep after it expired.
    pub recovery_sweep_interval: Duration,

    /// Engine.IO connections open at once (4096). Beyond, a new handshake is answered
    /// `503 Service Unavailable`.
    pub max_connections: usize,
    /// Concrete namespaces in existence at once, family members included (4096). A connect to a
    /// family member that would exceed it is refused with `Invalid namespace`. Members are
    /// released when their last socket leaves (the reference never releases them).
    pub max_namespaces: usize,
    /// Namespaces one connection may join or be joining at once (8). Beyond, `Invalid namespace`.
    pub max_namespaces_per_connection: usize,
    /// The longest namespace name considered (256 bytes). A longer name is refused with
    /// `Invalid namespace` before any pattern is tried. The reference has no limit.
    pub max_namespace_name: usize,
    /// Events from one client socket waiting for their handler (256). A client that sends more
    /// while its handlers are busy has its connection closed (reason `inbound overflow`).
    pub max_inbound_queue: usize,
    /// Server-to-client events waiting for their acknowledgement, per socket (32). Beyond,
    /// `emit_with_ack` fails at once.
    pub max_pending_acks: usize,
    /// Server-to-client events waiting for their acknowledgement in the whole server (16,384).
    /// Beyond, `emit_with_ack` fails at once with [`crate::AckError::TooMany`]. A wait that is
    /// cancelled (its future dropped) gives its slot back at once.
    pub max_pending_acks_total: usize,
    /// The largest packet the server sends (16 MiB). A larger emit is refused.
    pub max_outbound_message: usize,
    /// Bytes waiting to be written to all clients together (128 MiB). An emit that would exceed
    /// it is treated like an emit to a full socket queue.
    pub max_outbound_total: usize,
    /// The default send queue of a socket (see [`QueueLimits`]); a namespace may set its own.
    pub queue: QueueLimits,
    /// Bounds of connection state recovery.
    pub recovery: RecoveryLimits,
    /// At shutdown, how long queued output may take to reach the clients before every
    /// connection is closed (5 s); handlers still running are dropped at the same deadline.
    pub shutdown_drain: Duration,
    /// How long a closing connection may take to hand its last packets and the close packet to
    /// the client, and then to end, before its socket is aborted (30 s: `engine.io`'s polling
    /// `closeTimeout` and `ws`'s close timeout).
    pub close_timeout: Duration,
}

impl Default for Options {
    fn default() -> Self {
        Self {
            ping_interval: Duration::from_secs(25),
            ping_timeout: Duration::from_secs(20),
            upgrade_timeout: Duration::from_secs(10),
            max_http_buffer_size: 1_000_000,
            http_compression_threshold: 1024,
            connect_timeout: Duration::from_secs(45),
            recovery_max_disconnection: Duration::from_secs(120),
            recovery_sweep_interval: Duration::from_secs(60),
            max_connections: 4096,
            max_namespaces: 4096,
            max_namespaces_per_connection: 8,
            max_namespace_name: 256,
            max_inbound_queue: 256,
            max_pending_acks: 32,
            max_pending_acks_total: 16_384,
            max_outbound_message: 16 << 20,
            max_outbound_total: 128 << 20,
            queue: QueueLimits::default(),
            recovery: RecoveryLimits::default(),
            shutdown_drain: Duration::from_secs(5),
            close_timeout: Duration::from_secs(30),
        }
    }
}

/// The send queue of one socket: packets handed to the transport but not yet written to the
/// client (in the polling buffer, or waiting for the WebSocket to accept them).
///
/// When a packet does not fit, what happens depends on how it was sent ([`crate::Delivery`]):
/// a reliable packet closes the connection as a slow consumer (the session is kept for recovery
/// where the namespace has it), a replaceable one waits in a slot that a newer one with the same
/// key replaces, and a lossy one is dropped and counted.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct QueueLimits {
    /// Packets queued (1024). A polling client takes everything queued with each request, but
    /// one burst (a replay of pending events, a loop of emits) arrives before the next request
    /// can: this bound is generous, the byte bound is the memory guard.
    pub packets: usize,
    /// Bytes queued (2 MiB). A single packet larger than this is still sent when the queue is
    /// empty.
    pub bytes: usize,
}

impl Default for QueueLimits {
    fn default() -> Self {
        Self {
            packets: 1024,
            bytes: 2 << 20,
        }
    }
}

/// Hard bounds on what connection state recovery keeps. When one is reached the oldest entries
/// of the namespace being written are dropped; a client whose offset or session was dropped
/// connects fresh (`recovered` false), never with a partial replay.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RecoveryLimits {
    /// Stored packets per namespace (4096).
    pub packets_per_namespace: usize,
    /// Stored bytes per namespace (8 MiB).
    pub bytes_per_namespace: usize,
    /// Stored packets in all namespaces (32,768).
    pub packets_total: usize,
    /// Stored bytes in all namespaces (64 MiB).
    pub bytes_total: usize,
    /// Sessions kept per namespace (256).
    pub sessions_per_namespace: usize,
    /// Sessions kept in all namespaces (4096).
    pub sessions_total: usize,
    /// The largest session kept (16 KiB, estimated from its ids and the size of the socket data
    /// type); a larger one is not kept.
    pub session_bytes: usize,
}

impl Default for RecoveryLimits {
    fn default() -> Self {
        Self {
            packets_per_namespace: 4096,
            bytes_per_namespace: 8 << 20,
            packets_total: 32_768,
            bytes_total: 64 << 20,
            sessions_per_namespace: 256,
            sessions_total: 4096,
            session_bytes: 16 << 10,
        }
    }
}

/// What connection state recovery does in a namespace. The reference configures recovery for
/// the whole server, then narrows it per namespace with its adapter factory
/// (`pets/socket_adapter.ts`) and `persistSession` overrides.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Recovery {
    /// `SessionAwareAdapter`: eligible events carry an offset and are stored, sessions are kept
    /// on a recoverable disconnect, and a client that comes back in time with its private id and
    /// last offset gets its socket id, data and missed events back (clip, triggers, speech,
    /// dashboard, analytics, speech preview, furry, `/`).
    #[default]
    Full,
    /// `SessionAwareAdapter` with `persistSession` disabled: eligible events still carry an
    /// offset (the clients see it as a last argument), but no session is ever kept, so nothing
    /// is stored (roulette, widgets, duel, DimaFX, Overlay Studio).
    OffsetsOnly,
    /// The plain `Adapter`: no offsets, no sessions (`/desktop`, `/desktop-ai`, `/pet`). The
    /// CONNECT answer still carries a private id, since recovery is on for the server.
    Off,
}

/// How a socket's events reach its handler.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Dispatch {
    /// One at a time, in arrival order: the next event waits until the handler of the previous
    /// one has returned. Acknowledgements from the client are processed meanwhile, so a handler
    /// may await `emit_with_ack`.
    #[default]
    Sequential,
    /// Each event in its own task, at most this many at once per socket (at least 1); further
    /// events wait in the inbound queue. Handlers start in arrival order but may finish in any
    /// order, like `async` listeners in the reference.
    Concurrent(usize),
}
