//! Stream pet pure model (P4-FEAT-PETS part 1).
//!
//! Settings and wire projections follow the frozen TypeScript. These functions do
//! no I/O, read no environment and never charge credits. Command host and realtime
//! use the validated settings; routes use the same validation before model writes.
//! Admission, durable transitions, capabilities and readiness are subsequent parts.
pub mod model;
pub mod moods;
pub mod speech;
pub use model::{
    PetError, default_settings, normalize_saved_settings, require_plan, validate_settings,
};

/// Waiting requests, excluding the active slot (`pets/queue_limits.ts`).
pub const DEFAULT_QUEUE_SIZE: u64 = 5;
/// Largest independent queue (`pets/queue_limits.ts`).
pub const MAX_QUEUE_SIZE: u64 = 10;
/// Time allowed to start a queued request, milliseconds.
pub const QUEUE_WAIT_MS: i64 = 600_000;
/// Playback lease duration, milliseconds (`pets/state.ts`).
pub const LEASE_TTL_MS: i64 = 15_000;
