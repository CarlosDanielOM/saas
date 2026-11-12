//! The Socket.IO server's wiring: every namespace's registration through `crate::registry`,
//! handshakes and token checks, the 30 s stale-connection sweep and the dashboard status timer.
//! Package **P4-RT-SOCKETS** fills this module; it is empty until then.
//!
//! TypeScript it ports (baseline `0c71108e`), with the exports other packages call, which are the
//! public entry points the plan promises:
//!
//! - `server/websocket.ts` (369 lines): `getIO`, `websocket`
//! - `pets/socket_adapter.ts` (11 lines)
//!
//! Namespace owners for recovery quotas come from `dima_socketio::Namespace::owner`. Socket.IO has
//! no limit per address of its own: the reverse proxy limits per address (phase 7).
