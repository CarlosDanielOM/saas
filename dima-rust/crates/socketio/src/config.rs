//! Every timing and limit, with the reference's value where it has one.
//!
//! The Engine.IO and Socket.IO values are the effective configuration of the reference
//! (`server/websocket.ts:47`: `new Server(httpServer, { connectionStateRecovery: {}, adapter,
//! destroyUpgrade: false })`, everything else the defaults of `engine.io` 6.6.9 and `socket.io`
//! 4.8.3). The bounds below them have no counterpart in the reference, which has none; their
//! defaults are the starting values of `ledger/socketio.md`, section 3.
//!
//! # What the defaults bound
//!
//! Every limit is a reservation taken before the memory is kept or the work starts, given back
//! on every way out. Computed for `Options::default()` on a 64-bit target (MiB = 2^20 bytes):
//!
//! | | Per socket | Whole server |
//! |---|---|---|
//! | Inbound, parsed client data (events until their handler returns, acknowledgement answers until their waiter has them) | 16 MiB (`max_inbound_bytes`) | 256 MiB (`max_inbound_total`), CONNECT data included |
//! | Inbound, CONNECT data kept as `handshake.auth` | 16 MiB per connection | (in the 256 MiB) |
//! | Outbound, charged until written (in the transport, or waiting in replaceable slots) | 2 MiB in the transport + 2 MiB in slots; a single larger packet (≤ 16 MiB, `max_outbound_message`) is allowed alone in each, so 32 MiB at most | 128 MiB (`max_outbound_total`) |
//! | Recovery | a session ≤ 16 KiB | packets 64 MiB, sessions 32 MiB |
//!
//! So what this crate holds for clients is at most 256 + 128 + 64 + 32 = 480 MiB, plus small
//! bookkeeping: the namespace table (33,024 members × a few hundred bytes ≈ 13 MB), 16,384
//! acknowledgement slots and 4,096 connections × 8 sockets of fixed per-socket state (a few kB
//! each: ≈ 100 MB if every connection joined 8 namespaces). Outside these budgets, and bounded
//! by the transport rather than by this crate: a message being received is buffered whole
//! before it is handed over (at most `max_http_buffer_size`, 1 MB, per connection: ≈ 3.8 GiB if
//! all 4,096 connections sent a maximal message at the same instant), and a message being
//! written can exist twice for a moment (Engine.IO's encoded copy, and the compressed copy of a
//! polling answer of at most 1 MB). The reference bounds none of this.

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

    /// Engine.IO connections open at once (4096), each reserved before its handshake reaches
    /// Engine.IO. Beyond, a new handshake is answered `503 Service Unavailable`. Every WebSocket
    /// also takes one of `dima-web`'s stream slots (reserved first, `503` when the quota is
    /// full), so the builder refuses a value above the `ServeOptions::max_streams` it is given.
    pub max_connections: usize,
    /// Concrete namespaces in existence at once, family members included (33,024: room for
    /// `max_connections` × `max_namespaces_per_connection` members plus 256 static names). A
    /// member exists only while some connection has joined it or is joining it, and is released
    /// when the last one leaves (the reference never releases them); the builder refuses a value
    /// below the static names plus `max_connections` × `max_namespaces_per_connection`, so the
    /// table can never be full before the connection cap is: an unauthenticated connection can
    /// claim at most its own 8 entries, whatever the checks answer. (Of the two possible rules,
    /// charging per connection was chosen over admitting a member only after its check passed
    /// because several families accept any channel name in their check, as the reference does,
    /// so a passed check proves nothing about the client.) A connect beyond it would answer
    /// `Invalid namespace`. Each member costs a few hundred bytes (about 13 MB at the limit).
    pub max_namespaces: usize,
    /// Sockets joined or joining one concrete namespace at once (4096, the connection cap, so
    /// by default it never refuses before the connection cap does). Beyond, `Invalid namespace`.
    pub max_sockets_per_namespace: usize,
    /// Namespaces one connection may join or be joining at once (8). Beyond, `Invalid namespace`.
    pub max_namespaces_per_connection: usize,
    /// The longest namespace name considered (256 bytes). A longer name is refused with
    /// `Invalid namespace` before any pattern is tried. The reference has no limit.
    pub max_namespace_name: usize,
    /// Events from one client socket waiting for their handler (256). A client that sends more
    /// while its handlers are busy has its connection closed (reason `inbound overflow`).
    pub max_inbound_queue: usize,
    /// Memory one client socket's received data may hold at once (16 MiB): its events from the
    /// moment they are received until their handler has returned, and the answers to its
    /// acknowledgements until their waiter has them; for a connection, the `auth` data of its
    /// CONNECT packets for as long as their sockets live. Reserved before the data is parsed,
    /// from an upper bound of its parsed size (`codec::parsed_size_bound`: about twice the text
    /// for strings, up to 80 times it for dense arrays of small values). A packet that does not
    /// fit closes the connection (reason `inbound overflow`, not recoverable), like an event
    /// beyond `max_inbound_queue`. The reference has no such bound.
    pub max_inbound_bytes: usize,
    /// The same, for all clients together (256 MiB).
    pub max_inbound_total: usize,
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
    /// How long each kind of handler may run (a namespace may set its own).
    pub handler_deadlines: HandlerDeadlines,
    /// The whole shutdown (5 s, inside `dima-web`'s 10 s drain): queued output may reach the
    /// clients for the first three quarters, then connections close; handlers still running are
    /// dropped at three quarters, tasks still running aborted at seven eighths, and
    /// [`crate::SocketIo::shutdown`] returns by the deadline with its report.
    pub shutdown_drain: Duration,
    /// How long a closing connection may take to hand its last packets and the close packet to
    /// the client, and then to end, before its socket is aborted (30 s: `engine.io`'s polling
    /// `closeTimeout` and `ws`'s close timeout). Also how long a restore's missed events may
    /// wait for room in a full send queue while the client takes nothing: past it, the
    /// connection is closed as a slow consumer.
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
            max_namespaces: 4096 * 8 + 256,
            max_sockets_per_namespace: 4096,
            max_namespaces_per_connection: 8,
            max_namespace_name: 256,
            max_inbound_queue: 256,
            max_inbound_bytes: 16 << 20,
            max_inbound_total: 256 << 20,
            max_pending_acks: 32,
            max_pending_acks_total: 16_384,
            max_outbound_message: 16 << 20,
            max_outbound_total: 128 << 20,
            queue: QueueLimits::default(),
            recovery: RecoveryLimits::default(),
            handler_deadlines: HandlerDeadlines::default(),
            shutdown_drain: Duration::from_secs(5),
            close_timeout: Duration::from_secs(30),
        }
    }
}

/// How long a handler of a socket may run before it is dropped (cancelled at its next await),
/// counted from its start. Generous on purpose: they bound work that never ends, not work that
/// is slow.
///
/// Besides its deadline, every `on_connect` and `on_event` of a socket is cancelled when the
/// socket leaves its namespace; `on_disconnect` then runs once, under its own deadline only.
/// A recovered socket starts only once every handler of the socket it replaces has ended, so
/// no work of the old socket can run beside the new one on the data they share.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct HandlerDeadlines {
    /// [`crate::Namespace::on_connect`] (60 s).
    pub connect: Duration,
    /// Each [`crate::Namespace::on_event`] (120 s: the speech preview's client waits 90 s for
    /// its acknowledgement).
    pub event: Duration,
    /// [`crate::Namespace::on_disconnect`] (10 s). A client recovering the socket waits for it.
    pub disconnect: Duration,
}

impl Default for HandlerDeadlines {
    fn default() -> Self {
        Self {
            connect: Duration::from_secs(60),
            event: Duration::from_secs(120),
            disconnect: Duration::from_secs(10),
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

/// Hard bounds on what connection state recovery keeps. A client whose offset or session was
/// dropped connects fresh (`recovered` false), never with a partial replay.
///
/// **Packets** (emitted by the server, so no client chooses how many): at a namespace's own
/// bound its oldest are dropped; at a server-wide bound, the oldest of the namespace storing
/// the most bytes.
///
/// **Sessions** belong to the owner the namespace's check verified ([`crate::Owner`],
/// [`crate::Namespace::owner`]), because namespace names are no proof of anything (several
/// families accept any channel name, so a client can spread sessions over names it makes up):
///
/// - Sessions with a verified owner share the owned pool: `sessions_total` and
///   `session_bytes_total` minus the anonymous pool (3584 sessions, 28 MiB). An owner holds at
///   most `sessions_per_owner`; when the pool is full, the owner holding the most (sessions, or
///   bytes when bytes are what is full) gives up its oldest, the newcomer's own owner included.
/// - Sessions without an owner share the anonymous pool (`anonymous_sessions`,
///   `anonymous_session_bytes`): when it is full its oldest goes. It never takes room from the
///   owned pool, so anonymous clients can only push out each other.
/// - A namespace holds at most `sessions_per_namespace`: at that bound it gives up its oldest
///   anonymous session, or, for a newcomer with an owner, the oldest of the owner holding the
///   most there. An anonymous newcomer finding only owned sessions there is not kept.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RecoveryLimits {
    /// Stored packets per namespace (4096).
    pub packets_per_namespace: usize,
    /// Stored bytes per namespace (8 MiB).
    pub bytes_per_namespace: usize,
    /// Stored packets in all namespaces (32,768).
    pub packets_total: usize,
    /// Stored bytes in all namespaces (64 MiB). A stored packet is charged until its last
    /// owner, the store or a restore sending it, lets go.
    pub bytes_total: usize,
    /// Sessions kept per namespace (256).
    pub sessions_per_namespace: usize,
    /// Sessions kept per verified owner, in all namespaces (256).
    pub sessions_per_owner: usize,
    /// Sessions kept in all namespaces, both pools (4096).
    pub sessions_total: usize,
    /// Of `sessions_total`, the sessions without an owner (512; at most `sessions_total`).
    pub anonymous_sessions: usize,
    /// The largest session kept (16 KiB: its ids, its owner key, `size_of` the socket data and
    /// what the data keeps on the heap, [`crate::RetainedSize`]); a larger one is not kept.
    pub session_bytes: usize,
    /// Bytes of all kept sessions together, both pools (32 MiB).
    pub session_bytes_total: usize,
    /// Of `session_bytes_total`, the bytes of sessions without an owner (4 MiB; at most
    /// `session_bytes_total`).
    pub anonymous_session_bytes: usize,
}

impl Default for RecoveryLimits {
    fn default() -> Self {
        Self {
            packets_per_namespace: 4096,
            bytes_per_namespace: 8 << 20,
            packets_total: 32_768,
            bytes_total: 64 << 20,
            sessions_per_namespace: 256,
            sessions_per_owner: 256,
            sessions_total: 4096,
            anonymous_sessions: 512,
            session_bytes: 16 << 10,
            session_bytes_total: 32 << 20,
            anonymous_session_bytes: 4 << 20,
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
