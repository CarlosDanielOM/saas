//! The desktop app's raw WebSocket (`/v1/desktop/ws`), taken from `dima-web` as an upgrade. Package
//! **P4-RT-SOCKETS** fills this module; it is empty until then.
//!
//! TypeScript it ports (baseline `0c71108e`), with the exports other packages call, which are the
//! public entry points the plan promises:
//!
//! - `server/oauth/desktop-websocket.ts` (79 lines)
