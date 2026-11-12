//! Socket.IO server: protocol revision 5 over Engine.IO revision 4, text packets only, with
//! connection state recovery, as `socket.io` 4.8.3 serves the JavaScript clients 4.7.5 and 4.8.3.
//!
//! Rules for everything in this workspace are in `dima-rust/MIGRATION.md`; the evidence and the
//! design are in `ledger/socketio.md`.
#![forbid(unsafe_code)]
#![warn(missing_docs)]

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
pub use config::{Dispatch, Options, QueueLimits, Recovery, RecoveryLimits};
pub use error::{AckError, BuildError, ConnectError, DisconnectReason, SendError};
pub use handshake::{Handshake, Query};
pub use namespace::{Namespace, NamespaceOptions, NamespaceRef};
pub use outbox::{Delivery, MAX_PENDING_KEYS};
pub use pattern::{Pattern, PatternError};
pub use server::{Builder, Runtime, SocketIo, Stats};
pub use service::SocketIoService;
pub use socket::{Ack, Event, Socket};
pub use telemetry::{NoTelemetry, Telemetry};
