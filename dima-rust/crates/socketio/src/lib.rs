//! Socket.IO server: protocol revision 5 over Engine.IO revision 4, text packets only, with
//! connection state recovery, as `socket.io` 4.8.3 serves the JavaScript clients 4.7.5 and 4.8.3.
//!
//! Rules for everything in this workspace are in `dima-rust/MIGRATION.md`; the evidence and the
//! design are in `ledger/socketio.md`. Engine.IO (polling, WebSocket, upgrade, heartbeat) comes
//! from `engineioxide`; packets, namespaces, acknowledgements, recovery and every bound are this
//! crate's. `tests/differential.rs` runs the real JavaScript clients against this server and
//! against the reference and compares what they observe.
//!
//! # Declaring namespaces
//!
//! A feature package implements [`Namespace`] for each namespace or family it owns and declares
//! it on the [`Builder`]; the binary builds the server once and mounts it in front of the app:
//!
//! ```
//! use std::time::Duration;
//! use dima_socketio::{
//!     ConnectError, Event, Handshake, Namespace, NamespaceOptions, Options, Runtime, Socket,
//!     SocketIo,
//! };
//! use serde_json::json;
//!
//! /// `io.of(/^\/overlays\/triggers\/\w+$/)`: one namespace per channel.
//! struct Triggers;
//!
//! /// `socket.data` of a trigger overlay.
//! struct Overlay {
//!     channel: String,
//! }
//!
//! impl Namespace for Triggers {
//!     type Data = Overlay;
//!
//!     // The middleware: admit with typed data, or refuse with `err.message` / `err.data`.
//!     async fn check(&self, handshake: &Handshake, namespace: &str) -> Result<Overlay, ConnectError> {
//!         if handshake.query().get("token") == Some("revoked") {
//!             return Err(ConnectError::new("Invalid overlay token").with_data(json!({"code": "revoked"})));
//!         }
//!         let channel = namespace.rsplit('/').next().unwrap_or_default().to_owned();
//!         Ok(Overlay { channel })
//!     }
//!
//!     // `nsp.on('connection', socket => …)`.
//!     async fn on_connect(&self, socket: Socket<Overlay>) {
//!         let _ = socket.emit("ready", &[json!(socket.data().channel)]);
//!     }
//!
//!     // `socket.on(name, (...args, ack) => …)`.
//!     async fn on_event(&self, _socket: Socket<Overlay>, mut event: Event) {
//!         if event.name == "ping" {
//!             if let Some(ack) = event.take_ack() {
//!                 let _ = ack.send(&[json!("pong")]);
//!             }
//!         }
//!     }
//! }
//!
//! # fn main() -> Result<(), Box<dyn std::error::Error>> {
//! # let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build()?;
//! # runtime.block_on(async {
//! let shutdown = dima_core::Shutdown::new();
//! let mut builder = SocketIo::builder(Options::default(), Runtime::default(), shutdown.clone());
//! let triggers = builder.family(r"^\/overlays\/triggers\/\w+$", NamespaceOptions::default(), Triggers)?;
//! let io = builder.build(&dima_web::ServeOptions::default())?;
//! // Later, from an HTTP route: `io.of('/overlays/triggers/123').emit('trigger', payload)`.
//! let sent = triggers.emit("/overlays/triggers/123", "trigger", &[json!({"name": "wave"})])?;
//! assert_eq!(sent, 0); // nobody connected (with recovery the event is still kept)
//! # let _ = io;
//! # Ok::<(), Box<dyn std::error::Error>>(())
//! # })
//! # }
//! ```
//!
//! Serving, in the binary: `dima_web::serve(listener, io.layer(app), shutdown.cancellation_token(),
//! options)` next to `io.closed().await`, with the same `options` given to [`Builder::build`]
//! (which refuses a connection cap larger than the web server's stream quota) and the same
//! [`dima_core::Shutdown`] given to the builder, so the Socket.IO drain (5 s) finishes inside the web server's (10 s). `/socket.io/`
//! requests (Engine.IO sessions and the browser client files) are answered here; every other path
//! and upgrade, `/v1/desktop/ws` included, reaches the app.
//!
//! [`NamespaceOptions`] chooses the namespace's recovery mode ([`Recovery`]), its send queue
//! ([`QueueLimits`]) and how events reach the handler ([`Dispatch`]). Every limit of the server is
//! in [`Options`], with its default and where it comes from.
//!
//! # Porting notes
//!
//! For whoever converts `io.of(...)` code from `dimabot/src`:
//!
//! | Reference | Here |
//! |---|---|
//! | `io.of('/desktop')` / `io.of(/^\/clip\/\w+$/)` | [`Builder::namespace`] / [`Builder::family`] (the regex source without slashes, ASCII subset, see [`Pattern`]) |
//! | `nsp.use((socket, next) => next(err))`, `err.data = {…}` | [`Namespace::check`] returning `Err(ConnectError::new(msg).with_data(…))` |
//! | `.on('connection')`, `socket.on(ev)`, `socket.on('disconnect')` | [`Namespace::on_connect`], [`Namespace::on_event`] (match on `event.name`), [`Namespace::on_disconnect`] |
//! | the last-argument `ack` callback | [`Event::take_ack`], then [`Ack::send`] (consumed: a second call cannot happen) |
//! | `socket.emit(ev, ...args)` | [`Socket::emit`] (`&[Value]`); [`Socket::emit_with`] with a [`Delivery`] for state snapshots and samples |
//! | `socket.timeout(ms).emitWithAck(ev, ...)` | [`Socket::emit_with_ack`]: all answer arguments (the reference resolves with the first) |
//! | `io.of(name).emit(ev, ...)` | [`NamespaceRef::emit`] (the [`NamespaceRef`] the builder returned) |
//! | `nsp.fetchSockets()`, `nsp.sockets`, `io._nsps` | [`NamespaceRef::sockets`] (connected, in join order), [`NamespaceRef::socket`], [`NamespaceRef::names`] |
//! | `socket.data.x`, `socket.handshake.{auth,query,headers,address}`, `socket.recovered` | [`Socket::data`] (typed; interior mutability where handlers change it), [`Socket::handshake`], [`Socket::recovered`] |
//! | `socket.disconnect()` / `socket.disconnect(true)` | [`Socket::disconnect`] / [`Socket::disconnect_connection`] |
//! | the plain `Adapter` / `persistSession = () => {}` | [`Recovery::Off`] / [`Recovery::OffsetsOnly`] ([`Recovery::Full`] is the default) |
//!
//! What behaves differently on purpose, and what a port must keep in mind:
//!
//! - **Events wait for `on_connect`.** In the reference a listener registered after an `await`
//!   in the connection handler misses events that arrive first; here they wait in the socket's
//!   inbound queue until `on_connect` returns, and `on_disconnect` is called exactly once even
//!   when the socket left during `on_connect` (the reference then never ran a `disconnect`
//!   listener registered late, and leaked its intervals). [`Dispatch::Sequential`] (the default)
//!   handles one event at a time; use [`Dispatch::Concurrent`] where a slow handler (speech
//!   preview) must not hold up the next event, and lock in the data where order matters.
//! - **Disconnected sockets.** An emit on a socket that has left is never written to the
//!   connection; with [`Recovery::Full`] it is still stored and reaches a client that recovers
//!   the socket, as in the reference. `emit_with_ack` on it fails at once with
//!   [`AckError::Disconnected`] where the reference waits for the timeout.
//! - **Offsets.** Events without an acknowledgement in a namespace with recovery carry the offset
//!   as an extra last argument, exactly as today; the clients ignore it.
//! - **Payload key order.** `serde_json::json!` keeps the written order and the event is
//!   serialised in that order; a JavaScript object lists integer-like keys first. Values parsed
//!   from client JSON are already in JavaScript order; for values built in Rust with such keys,
//!   call `dima_text::js_key_order` first.
//! - **Numeric event names** arrive as their JavaScript text (`[1]` is event `"1"`).
//! - **No deadline on checks.** A check runs until it returns or its connection closes; give its
//!   own network calls their timeouts, as everywhere else.
//! - **`/overlays/furry/<id>`** exists in the reference only after the first POST emitted to it;
//!   declare it as a family whose check answers `ConnectError::new("Invalid namespace")` for ids
//!   not created yet, which the client sees exactly as the reference's refusal.
//! - **Admission refusals** (unknown name, name over 256 bytes, more than 8 namespaces on one
//!   connection, 4096 namespaces in the server) all answer `Invalid namespace`.
//!
//! # Differences from the reference
//!
//! Besides the bounds (see [`Options`], all new: the reference has none):
//!
//! - Malformed client packets are refused more strictly (see the codec's rules: packet type,
//!   acknowledgement id, JSON depth 128); binary packets close the connection. A second CONNECT
//!   to a namespace whose check is still running closes the connection (the reference would
//!   create a second socket).
//! - A recovery claims its session: two reconnects with the same private id cannot both get the
//!   socket back. A session whose restore fails half-way (the connection closed during the replay)
//!   is not kept.
//! - Family members are released with their last socket (the reference keeps them for ever);
//!   their recovery state is kept apart and outlives them.
//! - From `engineioxide`: the first heartbeat ping goes out when the session opens instead of
//!   after 25 s; a polling response carries at most 1 MB (the rest follows in the next poll);
//!   session ids are 16 characters instead of 20; a WebSocket upgrade that fails after the
//!   WebSocket handshake (wrong probe, upgrade timeout) ends the whole session where `engine.io`
//!   keeps the client on polling; a client closing its WebSocket right after the upgrade can make
//!   `engineioxide`'s writer task panic on a lock it expects free (`transport/ws.rs:259`; the
//!   panic stays in that task, the session was ending anyway).
//! - The browser client files are compressed with `flate2` for gzip and deflate (other bytes,
//!   same content) and served from the vendored Brotli form for `br`.
#![forbid(unsafe_code)]
#![warn(missing_docs)]

mod budget;
mod client_files;
mod codec;
pub mod config;
mod connection;
mod error;
mod handshake;
mod ids;
mod namespace;
mod negotiate;
mod outbox;
mod pattern;
mod recovery;
mod server;
mod service;
mod socket;
pub mod telemetry;

pub use client_files::CLIENT_VERSION;
pub use config::{Dispatch, HandlerDeadlines, Options, QueueLimits, Recovery, RecoveryLimits};
pub use error::{AckError, BuildError, ConnectError, DisconnectReason, SendError};
pub use handshake::{Handshake, Query};
pub use namespace::{Namespace, NamespaceOptions, NamespaceRef};
pub use outbox::{Delivery, MAX_PENDING_KEYS};
pub use pattern::{Pattern, PatternError};
pub use server::{Builder, Runtime, SocketIo, Stats};
pub use service::SocketIoService;
pub use socket::{Ack, Event, Socket};
pub use telemetry::{NoTelemetry, Telemetry};
