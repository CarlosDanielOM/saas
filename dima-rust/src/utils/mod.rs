//! Small shared utilities.
//!
//! Keep this module limited to narrow, reusable pieces rather than a generic
//! framework or a parallel data-access layer.

#[cfg(feature = "mongo")]
pub mod mongo;
#[cfg(feature = "redis")]
pub mod redis;
